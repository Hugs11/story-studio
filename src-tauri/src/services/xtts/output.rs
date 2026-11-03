use super::{XttsGenerateRequest, XttsSettings};
use crate::services::project_files::media_output_dir;
use crate::support::ffmpeg::now_millis;
use crate::support::user_message;
use crate::support::user_message::codes;
use std::path::{Path, PathBuf};

// Remplace les caracteres typiquement problematiques pour un nom de fichier
// Windows par `_`. Pas un controle de securite : juste un nettoyage cosmetique
// du hint utilisateur. Le filtrage securite est fait par `safe_output_filename`.
fn slugify_filename_hint(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            c => c,
        })
        .collect()
}

// Valide qu'un nom est un fichier seul, sans separateur, sans `..`, sans
// caractere de controle. Aligne sur `safe_comfyui_output_filename`.
fn safe_output_filename(filename: &str) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err({
            let _msg_filename = (filename).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie XTTS invalide : {_msg_filename}",
                    _msg_filename = user_message::transport_detail(&_msg_filename)
                ))
                .into_transport()
        });
    }
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            let _msg_filename = (filename).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie XTTS invalide : {_msg_filename}",
                    _msg_filename = user_message::transport_detail(&_msg_filename)
                ))
                .into_transport()
        })?;
    if file_name != filename {
        return Err({
            let _msg_filename = (filename).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie XTTS invalide : {_msg_filename}",
                    _msg_filename = user_message::transport_detail(&_msg_filename)
                ))
                .into_transport()
        });
    }
    Ok(file_name.to_string())
}

pub(super) fn output_filename(filename_hint: Option<&str>) -> Result<String, String> {
    // Pre-validation du hint utilisateur AVANT slugify : on rejette les
    // segments de chemin et `..` ici, sinon `slugify_filename_hint` les
    // transformerait silencieusement (`../voice` → `__voice`) et le nom
    // final passerait `safe_output_filename`.
    if let Some(raw_hint) = filename_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        reject_unsafe_hint(raw_hint)?;
    }
    let base = filename_hint
        .map(slugify_filename_hint)
        .filter(|value| !value.trim_matches('_').is_empty())
        .unwrap_or_else(|| "tts".to_string());
    // safe_output_filename revalide le nom final assemble (base + timestamp + ext).
    safe_output_filename(&format!("{}--{}.wav", base.trim_matches('_'), now_millis()))
}

fn reject_unsafe_hint(raw_hint: &str) -> Result<(), String> {
    if raw_hint.contains('/')
        || raw_hint.contains('\\')
        || raw_hint.contains("..")
        || raw_hint.chars().any(char::is_control)
    {
        return Err({
            let _msg_raw_hint = (raw_hint).to_string();
            user_message::UserMessage::new(codes::XTTS_OUTPUT_NAME_CHECK_FAILED)
                .param(
                    "details",
                    user_message::transport_param(_msg_raw_hint.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie XTTS invalide : {_msg_raw_hint}",
                    _msg_raw_hint = user_message::transport_detail(&_msg_raw_hint)
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub(super) fn generated_dir(request: &XttsGenerateRequest) -> Result<PathBuf, String> {
    media_output_dir(
        request.workspace_dir.as_deref(),
        "voix-generees",
        request.project_destination.as_ref(),
        codes::XTTS_WORKSPACE_LOCATION_REQUIRED_TRANSPORT,
    )
}

pub(super) fn server_output_dir(settings: &XttsSettings) -> PathBuf {
    PathBuf::from(&settings.xtts_dir).join("output")
}

pub(super) fn reference_voice_exists(settings: &XttsSettings, voice: &str) -> bool {
    if voice.contains('/') || voice.contains('\\') || voice.trim().is_empty() {
        return false;
    }
    PathBuf::from(&settings.xtts_dir)
        .join("voices")
        .join(format!("{}.wav", voice))
        .is_file()
}
