use crate::support::user_message;
use crate::support::user_message::codes;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::super::{media_output_dir, validate_existing_file_path};
use super::WORKING_AUDIO_EXTENSION;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;
pub(crate) const AUDIO_ASSEMBLY_EXTENSIONS: &[&str] =
    &["mp3", "ogg", "wav", "m4a", "webm", "flac", "aac"];

pub(crate) fn validate_audio_assembly_filename(output_file_name: &str) -> Result<String, String> {
    let trimmed = output_file_name.trim();
    let path = Path::new(trimmed);
    let file_name = path.file_name().and_then(OsStr::to_str).ok_or_else(|| {
        user_message::UserMessage::new(codes::FILES_INVALID_FINAL_FILE_NAME)
            .with_detail("Nom du fichier final invalide.".to_string())
            .into_transport()
    })?;
    if file_name != trimmed || file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_FINAL_FILE_NAME)
                .with_detail("Nom du fichier final invalide.".to_string())
                .into_transport(),
        );
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(
            user_message::UserMessage::new(codes::FILES_FINAL_NAME_CHARS_INVALID)
                .with_detail("Nom du fichier final contient des caractères interdits.".to_string())
                .into_transport(),
        );
    }

    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            user_message::UserMessage::new(codes::FILES_INVALID_FINAL_FILE_NAME)
                .with_detail("Nom du fichier final invalide.".to_string())
                .into_transport()
        })?;
    Ok(format!("{}.{}", stem, WORKING_AUDIO_EXTENSION))
}

pub(crate) fn unique_audio_assembly_path(
    target_dir: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("audio_assemble");
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(WORKING_AUDIO_EXTENSION);

    let first = target_dir.join(file_name);
    if !first.exists() {
        return Ok(first);
    }

    let stamp = now_millis();
    for index in 0..1000 {
        let suffix = if index == 0 {
            format!("--{}", stamp)
        } else {
            format!("--{}-{}", stamp, index)
        };
        let candidate = target_dir.join(format!("{}{}.{}", stem, suffix, ext));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(
        user_message::UserMessage::new(codes::FILES_AVAILABLE_NAME_EXHAUSTED)
            .with_detail("Impossible de trouver un nom de fichier disponible.".to_string())
            .into_transport(),
    )
}

pub(crate) fn validate_audio_assembly_input(path: &str) -> Result<PathBuf, String> {
    let input = validate_existing_file_path(path, codes::AUDIO_FILE_LABEL_TRANSPORT)?;
    let ext = input
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !AUDIO_ASSEMBLY_EXTENSIONS.contains(&ext.as_str()) {
        return Err({
            let _msg_input = (input.display()).to_string();
            user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_FORMAT_UNSUPPORTED)
                .param("input", user_message::transport_param(_msg_input.clone()))
                .with_detail(format!(
                    "Format audio non pris en charge pour l'assemblage : {_msg_input}",
                    _msg_input = user_message::transport_detail(&_msg_input)
                ))
                .into_transport()
        });
    }
    Ok(input)
}

pub(crate) fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return user_message::UserMessage::new(codes::FILES_UNKNOWN_FFMPEG_ERROR)
            .with_detail("Erreur FFmpeg inconnue.".to_string())
            .into_transport();
    }
    let start = lines.len().saturating_sub(10);
    lines[start..].join("\n")
}

pub(crate) fn run_ffmpeg_normalize_audio(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-ar")
        .arg("44100")
        .arg("-ac")
        .arg("2")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_FFMPEG_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer FFmpeg : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err({
            let ffmpeg_error_message = (compact_ffmpeg_error(&out.stderr)).to_string();
            user_message::UserMessage::new(codes::FILES_AUDIO_PREPARATION_FAILED)
                .param(
                    "toolError",
                    user_message::transport_param(ffmpeg_error_message.clone()),
                )
                .with_detail(format!(
                    "Préparation audio échouée :\n{ffmpeg_error_message}",
                    ffmpeg_error_message = user_message::transport_detail(&ffmpeg_error_message)
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub(crate) fn run_ffmpeg_make_silence(
    ffmpeg: &Path,
    duration_sec: f64,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("anullsrc=r=44100:cl=stereo")
        .arg("-t")
        .arg(format!("{:.3}", duration_sec))
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_FFMPEG_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer FFmpeg : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err({
            let ffmpeg_error_message = (compact_ffmpeg_error(&out.stderr)).to_string();
            user_message::UserMessage::new(codes::FILES_SILENCE_CREATION_FAILED)
                .param(
                    "toolError",
                    user_message::transport_param(ffmpeg_error_message.clone()),
                )
                .with_detail(format!(
                    "Création du silence échouée :\n{ffmpeg_error_message}",
                    ffmpeg_error_message = user_message::transport_detail(&ffmpeg_error_message)
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub(crate) fn concat_list_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("file '{}'\n", escaped)
}

pub(crate) fn run_ffmpeg_concat_audio(
    ffmpeg: &Path,
    list_path: &Path,
    output: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(list_path)
        .arg("-vn")
        .arg("-c:a")
        .arg("flac")
        .arg(output);

    let out = cmd.output().map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_FFMPEG_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer FFmpeg : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err({
            let ffmpeg_error_message = (compact_ffmpeg_error(&out.stderr)).to_string();
            user_message::UserMessage::new(codes::FILES_AUDIO_ASSEMBLY_FAILED)
                .param(
                    "toolError",
                    user_message::transport_param(ffmpeg_error_message.clone()),
                )
                .with_detail(format!(
                    "Assemblage audio échoué :\n{ffmpeg_error_message}",
                    ffmpeg_error_message = user_message::transport_detail(&ffmpeg_error_message)
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub fn concat_audio_files(
    input_paths: &[String],
    output_file_name: &str,
    silence_between_sec: f64,
    workspace_dir: Option<&str>,
    project_destination: Option<&crate::services::project_files::ProjectMediaDestination>,
) -> Result<String, String> {
    if input_paths.len() < 2 {
        return Err(
            user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_INPUTS_REQUIRED)
                .with_detail("Sélectionnez au moins deux audios à assembler.".to_string())
                .into_transport(),
        );
    }
    if !silence_between_sec.is_finite() || !(0.0..=30.0).contains(&silence_between_sec) {
        return Err(
            user_message::UserMessage::new(codes::AUDIO_SILENCE_DURATION_INVALID)
                .with_detail(
                    "La durée du silence doit être comprise entre 0 et 30 secondes.".to_string(),
                )
                .into_transport(),
        );
    }

    let inputs: Vec<PathBuf> = input_paths
        .iter()
        .map(|path| validate_audio_assembly_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    let output_name = validate_audio_assembly_filename(output_file_name)?;
    let target_dir = media_output_dir(
        workspace_dir,
        "fichiers-importes",
        project_destination,
        codes::AUDIO_ASSEMBLY_WORKSPACE_REQUIRED_TRANSPORT,
    )?;
    fs::create_dir_all(&target_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_IMPORT_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer fichiers-importes : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let target_dir = fs::canonicalize(&target_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_IMPORT_FOLDER_INACCESSIBLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Dossier fichiers-importes inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let output_path = unique_audio_assembly_path(&target_dir, &output_name)?;

    let ffmpeg = get_ffmpeg_path()?;
    let temp_dir = std::env::temp_dir().join(format!(
        "story_studio_audio_assembly_{}_{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&temp_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_TEMP_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer le dossier temporaire audio : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let result = (|| {
        let silence_enabled = silence_between_sec > 0.001;
        let mut concat_entries: Vec<PathBuf> = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let wav_path = temp_dir.join(format!("part_{:03}.wav", index));
            run_ffmpeg_normalize_audio(&ffmpeg, input, &wav_path)?;
            concat_entries.push(wav_path);

            if silence_enabled && index + 1 < inputs.len() {
                let silence_path = temp_dir.join(format!("silence_{:03}.wav", index));
                run_ffmpeg_make_silence(&ffmpeg, silence_between_sec, &silence_path)?;
                concat_entries.push(silence_path);
            }
        }

        let list_path = temp_dir.join("concat.txt");
        let list_content: String = concat_entries
            .iter()
            .map(|path| concat_list_line(path))
            .collect();
        fs::write(&list_path, list_content).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::AUDIO_ASSEMBLY_LIST_PREPARE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de préparer la liste d'assemblage : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;

        run_ffmpeg_concat_audio(&ffmpeg, &list_path, &output_path)?;
        Ok(path_for_frontend(&output_path))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    if result.is_err() {
        let _ = fs::remove_file(&output_path);
    }
    result
}
