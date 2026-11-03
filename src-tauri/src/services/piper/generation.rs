//! Génération de voix Piper : provisionne (idempotent) puis exécute Piper
//! avec le texte sur **stdin** (jamais d'interpolation shell), produit un WAV
//! puis le convertit en MP3 conforme via ffmpeg embarqué. Sortie bornée à
//! `voix-generees/` du projet/workspace.

use super::output::{generated_dir, output_filename};
use super::provision::{ensure_piper, voice_paths};
use super::runtime::{resolve_piper_runtime, PiperRuntime};
use super::{PiperGenerateRequest, PiperSettings, PiperStatus, PiperVoiceInfo};
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path};
use crate::support::paths::path_for_frontend;
use crate::support::user_message;
use crate::support::user_message::codes;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const MAX_TEXT_CHARS: usize = 5000;

/// Liste les voix du catalogue avec leur état d'installation local. Aucun réseau :
/// le modal peut afficher les voix par défaut avant tout téléchargement.
pub fn list_voices_sync(home: &Path) -> Result<PiperStatus, String> {
    resolve_piper_runtime()?;
    let voices = super::catalog::VOICES
        .iter()
        .map(|voice| PiperVoiceInfo {
            id: voice.id.to_string(),
            label: voice.label.to_string(),
            language: voice.language.to_string(),
            quality: voice.quality.to_string(),
            is_default: voice.is_default,
            installed: super::provision::is_voice_installed(home, voice.id),
        })
        .collect();
    Ok(PiperStatus {
        default_language: super::catalog::DEFAULT_LANGUAGE.to_string(),
        default_voice: super::catalog::DEFAULT_VOICE.to_string(),
        binary_installed: true,
        voices,
    })
}

/// Valide le runtime embarqué puis provisionne la voix demandée (idempotent).
/// Exposé pour le feedback « Préparation de la voix… » côté modal.
pub fn ensure_sync(home: &Path, voice_id: &str, emit: &dyn Fn(&str)) -> Result<(), String> {
    ensure_piper(home, voice_id, emit).map(|_| ())
}

/// Convertit une vitesse utilisateur (0.5–2.0) en `length_scale` Piper. Piper
/// allonge l'audio quand `length_scale` augmente ; on inverse donc la vitesse.
pub(super) fn length_scale_for_speed(speed: f32) -> f32 {
    let clamped = speed.clamp(0.5, 2.0);
    (1.0 / clamped).clamp(0.5, 2.0)
}

pub(super) fn validate_text_for_generation(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::PIPER_GENERATION_TEXT_EMPTY)
                .with_detail("Le texte a generer est vide.".to_string())
                .into_transport(),
        );
    }
    let char_count = trimmed.chars().count();
    if char_count > MAX_TEXT_CHARS {
        return Err({
            let _msg_char_count = (char_count).to_string();
            let _msg_max_text_chars = (MAX_TEXT_CHARS).to_string();
            user_message::UserMessage::new(
                codes::PIPER_GENERATION_TEXT_LIMIT,
            )
                .param("charCount", user_message::transport_param(_msg_char_count.clone()))
                .param(
                    "maxTextLength",
                    user_message::transport_param(_msg_max_text_chars.clone()),
                )
                .with_detail(format!(
                    "Le texte est trop long pour une génération Piper en une fois ({_msg_char_count} caractères, maximum {_msg_max_text_chars}).",
                    _msg_char_count = user_message::transport_detail(&_msg_char_count),
                    _msg_max_text_chars = user_message::transport_detail(&_msg_max_text_chars),
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub fn generate_audio_sync(
    home: &Path,
    settings: PiperSettings,
    request: PiperGenerateRequest,
    emit: &dyn Fn(&str),
) -> Result<String, String> {
    validate_text_for_generation(&request.text)?;

    let voice_id = request
        .voice
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.voice.clone());
    if voice_id.trim().is_empty() {
        return Err(
            user_message::UserMessage::new(codes::PIPER_GENERATION_VOICE_UNSELECTED)
                .with_detail("Aucune voix Piper selectionnee.".to_string())
                .into_transport(),
        );
    }

    emit(codes::PIPER_GENERATION_REQUESTED_TRANSPORT);
    let runtime = ensure_piper(home, &voice_id, emit)?;

    let output_dir = generated_dir(&request)?;
    std::fs::create_dir_all(&output_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::PIPER_VOICES_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le dossier des voix generees : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let mp3_name = output_filename(request.filename_hint.as_deref(), "mp3")?;
    let wav_name = output_filename(request.filename_hint.as_deref(), "wav")?;
    let dest_mp3 = output_dir.join(&mp3_name);

    // WAV intermédiaire dans un dossier temp système (jamais dans le projet).
    let wav_tmp = std::env::temp_dir().join(format!("story_studio_piper_{}", wav_name));

    let speed = if request.speed > 0.0 {
        request.speed
    } else {
        settings.speed
    };
    let result = run_piper(
        &runtime,
        home,
        &voice_id,
        &request.text,
        &wav_tmp,
        speed,
        emit,
    )
    .and_then(|_| encode_mp3(&wav_tmp, &dest_mp3));
    let _ = std::fs::remove_file(&wav_tmp);
    result?;

    emit(&{
        let _msg_dest_mp3 = (dest_mp3.display()).to_string();
        user_message::UserMessage::new(codes::PIPER_AUDIO_GENERATED)
            .param(
                "destMp3",
                user_message::transport_param(_msg_dest_mp3.clone()),
            )
            .with_detail(format!(
                "Audio Piper genere : {_msg_dest_mp3}",
                _msg_dest_mp3 = user_message::transport_detail(&_msg_dest_mp3)
            ))
            .into_transport()
    });
    Ok(path_for_frontend(&dest_mp3))
}

fn run_piper(
    runtime: &PiperRuntime,
    home: &Path,
    voice_id: &str,
    text: &str,
    wav_out: &Path,
    speed: f32,
    emit: &dyn Fn(&str),
) -> Result<(), String> {
    let (model_path, config_path) = voice_paths(home, voice_id);
    let length_scale = length_scale_for_speed(speed);

    let mut cmd = Command::new(&runtime.executable);
    apply_no_window(&mut cmd);
    cmd.args(piper_arguments(
        &model_path,
        &config_path,
        wav_out,
        length_scale,
        &runtime.root.join("espeak-ng-data"),
    ));
    // current_dir = runtime en lecture seule : Piper y trouve ses DLL/bibliothèques.
    cmd.current_dir(&runtime.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    emit(codes::PIPER_SPEECH_SYNTHESIS_IN_PROGRESS_TRANSPORT);
    let mut child = cmd.spawn().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::PIPER_PROCESS_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer Piper : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    // Texte transmis sur stdin (aucune interpolation shell).
    child
        .stdin
        .take()
        .ok_or_else(|| {
            user_message::UserMessage::new(codes::PIPER_PROCESS_STDIN_UNAVAILABLE)
                .with_detail("Entrée standard Piper indisponible.".to_string())
                .into_transport()
        })?
        .write_all(text.as_bytes())
        .map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::PIPER_PROCESS_TEXT_WRITE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Écriture du texte vers Piper impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;

    let output = child.wait_with_output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::PIPER_PROCESS_STOPPED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Piper s'est interrompu : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err({
            let piper_stderr_message = (stderr
                .trim()
                .lines()
                .last()
                .unwrap_or(codes::PIPER_UNKNOWN_ERROR_TRANSPORT))
            .to_string();
            user_message::UserMessage::new(codes::PIPER_PROCESS_FAILED)
                .param(
                    "error",
                    user_message::transport_param(piper_stderr_message.clone()),
                )
                .with_detail(format!(
                    "Piper a échoué : {piper_stderr_message}",
                    piper_stderr_message = user_message::transport_detail(&piper_stderr_message)
                ))
                .into_transport()
        });
    }
    if !wav_out.is_file() {
        return Err(
            user_message::UserMessage::new(codes::PIPER_AUDIO_OUTPUT_MISSING)
                .with_detail("Piper n'a produit aucun fichier audio.".to_string())
                .into_transport(),
        );
    }
    Ok(())
}

fn piper_arguments(
    model_path: &Path,
    config_path: &Path,
    wav_out: &Path,
    length_scale: f32,
    espeak_data: &Path,
) -> Vec<OsString> {
    vec![
        OsString::from("--model"),
        model_path.as_os_str().to_os_string(),
        OsString::from("--config"),
        config_path.as_os_str().to_os_string(),
        OsString::from("--output_file"),
        wav_out.as_os_str().to_os_string(),
        OsString::from("--length_scale"),
        OsString::from(format!("{length_scale:.3}")),
        OsString::from("--espeak_data"),
        espeak_data.as_os_str().to_os_string(),
    ]
}

fn encode_mp3(wav: &Path, mp3: &Path) -> Result<(), String> {
    let ffmpeg = get_ffmpeg_path()?;
    let mut cmd = Command::new(&ffmpeg);
    apply_no_window(&mut cmd);
    cmd.args(["-y".as_ref(), "-i".as_ref(), wav.as_os_str()]);
    cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
    cmd.arg(mp3.as_os_str());

    let output = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::PIPER_MP3_FFMPEG_UNAVAILABLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Conversion MP3 impossible (ffmpeg) : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(mp3);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err({
            let _msg_stderr = (stderr.trim()).to_string();
            user_message::UserMessage::new(codes::PIPER_MP3_CONVERSION_FAILED)
                .param("stderr", user_message::transport_param(_msg_stderr.clone()))
                .with_detail(format!(
                    "Conversion MP3 échouée : {_msg_stderr}",
                    _msg_stderr = user_message::transport_detail(&_msg_stderr)
                ))
                .into_transport()
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::piper_arguments;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn command_arguments_keep_paths_and_values_separate() {
        let args = piper_arguments(
            Path::new("/tmp/voix été/modèle.onnx"),
            Path::new("/tmp/voix été/modèle.onnx.json"),
            Path::new("/tmp/sortie audio.wav"),
            1.25,
            Path::new("/tmp/runtime Piper/espeak-ng-data"),
        );
        assert_eq!(
            args,
            vec![
                OsString::from("--model"),
                OsString::from("/tmp/voix été/modèle.onnx"),
                OsString::from("--config"),
                OsString::from("/tmp/voix été/modèle.onnx.json"),
                OsString::from("--output_file"),
                OsString::from("/tmp/sortie audio.wav"),
                OsString::from("--length_scale"),
                OsString::from("1.250"),
                OsString::from("--espeak_data"),
                OsString::from("/tmp/runtime Piper/espeak-ng-data"),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "--sentence_silence"));
    }
}
