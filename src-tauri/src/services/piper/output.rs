//! Résolution sécurisée des noms et dossiers de sortie pour Piper. Même
//! discipline que `services/xtts/output.rs` : on borne strictement la sortie à
//! `voix-generees/` et on rejette tout segment de chemin dans le hint
//! utilisateur. Piper produit un MP3 final (WAV intermédiaire converti).

use super::PiperGenerateRequest;
use crate::services::project_files::media_output_dir;
use crate::support::ffmpeg::now_millis;
use crate::support::user_message;
use crate::support::user_message::codes;
use std::path::{Path, PathBuf};

// Nettoyage cosmétique du hint utilisateur (pas un contrôle de sécurité : c'est
// `safe_output_filename` qui valide le nom final).
fn slugify_filename_hint(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            c => c,
        })
        .collect()
}

fn safe_output_filename(filename: &str) -> Result<String, String> {
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err({
            let _msg_filename = (filename).to_string();
            user_message::UserMessage::new(codes::PIPER_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie Piper invalide : {_msg_filename}",
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
            user_message::UserMessage::new(codes::PIPER_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie Piper invalide : {_msg_filename}",
                    _msg_filename = user_message::transport_detail(&_msg_filename)
                ))
                .into_transport()
        })?;
    if file_name != filename {
        return Err({
            let _msg_filename = (filename).to_string();
            user_message::UserMessage::new(codes::PIPER_OUTPUT_NAME_INVALID)
                .param(
                    "filename",
                    user_message::transport_param(_msg_filename.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie Piper invalide : {_msg_filename}",
                    _msg_filename = user_message::transport_detail(&_msg_filename)
                ))
                .into_transport()
        });
    }
    Ok(file_name.to_string())
}

fn reject_unsafe_hint(raw_hint: &str) -> Result<(), String> {
    if raw_hint.contains('/')
        || raw_hint.contains('\\')
        || raw_hint.contains("..")
        || raw_hint.chars().any(char::is_control)
    {
        return Err({
            let _msg_raw_hint = (raw_hint).to_string();
            user_message::UserMessage::new(codes::PIPER_OUTPUT_NAME_CHECK_FAILED)
                .param(
                    "details",
                    user_message::transport_param(_msg_raw_hint.clone()),
                )
                .with_detail(format!(
                    "Nom de sortie Piper invalide : {_msg_raw_hint}",
                    _msg_raw_hint = user_message::transport_detail(&_msg_raw_hint)
                ))
                .into_transport()
        });
    }
    Ok(())
}

/// Nom de fichier MP3 final, dérivé du hint utilisateur + timestamp. `ext` permet
/// d'obtenir le nom du WAV intermédiaire avec la même base.
pub(super) fn output_filename(filename_hint: Option<&str>, ext: &str) -> Result<String, String> {
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
    safe_output_filename(&format!(
        "{}--{}.{}",
        base.trim_matches('_'),
        now_millis(),
        ext
    ))
}

pub(super) fn generated_dir(request: &PiperGenerateRequest) -> Result<PathBuf, String> {
    media_output_dir(
        request.workspace_dir.as_deref(),
        "voix-generees",
        request.project_destination.as_ref(),
        codes::PIPER_WORKSPACE_LOCATION_REQUIRED_TRANSPORT,
    )
}
