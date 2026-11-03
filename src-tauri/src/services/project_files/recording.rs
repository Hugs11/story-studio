use crate::support::user_message;
use crate::support::user_message::codes;
use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use super::audio::unique_audio_assembly_path;
use super::media_output_dir;
use crate::support::paths::path_for_frontend;

pub(super) const MAX_RECORDING_BYTES: usize = 100 * 1024 * 1024;
const MAX_RECORDING_FILENAME_CHARS: usize = 180;
const RECORDING_NAME_ATTEMPTS: usize = 8;

pub(super) fn validate_recording_filename(filename: &str) -> Result<&str, String> {
    let path = Path::new(filename);
    let file_name = path.file_name().and_then(OsStr::to_str).ok_or_else(|| {
        user_message::UserMessage::new(codes::FILES_INVALID_RECORDING_NAME)
            .with_detail("Nom d'enregistrement invalide.".to_string())
            .into_transport()
    })?;
    if file_name != filename || file_name.trim().is_empty() {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_RECORDING_NAME)
                .with_detail("Nom d'enregistrement invalide.".to_string())
                .into_transport(),
        );
    }
    if file_name.chars().count() > MAX_RECORDING_FILENAME_CHARS {
        return Err({
            let recording_name_limit = (MAX_RECORDING_FILENAME_CHARS).to_string();
            user_message::UserMessage::new(codes::AUDIO_RECORDING_NAME_LENGTH_LIMIT)
                .param(
                    "maxFilenameLength",
                    user_message::transport_param(recording_name_limit.clone()),
                )
                .with_detail(format!(
                    "Nom d'enregistrement trop long (maximum {recording_name_limit} caracteres).",
                    recording_name_limit = user_message::transport_detail(&recording_name_limit),
                ))
                .into_transport()
        });
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(
            user_message::UserMessage::new(codes::AUDIO_RECORDING_NAME_CHARS_INVALID)
                .with_detail("Nom d'enregistrement contient des caracteres interdits.".to_string())
                .into_transport(),
        );
    }
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("webm" | "wav")) {
        return Err(
            user_message::UserMessage::new(codes::FILES_RECORDING_EXTENSION_NOT_SUPPORTED)
                .with_detail("Extension d'enregistrement non prise en charge.".to_string())
                .into_transport(),
        );
    }
    Ok(file_name)
}

pub(crate) fn save_recording(
    workspace_dir: Option<&str>,
    filename: &str,
    data: &[u8],
    project_destination: Option<&crate::services::project_files::ProjectMediaDestination>,
) -> Result<String, String> {
    if data.is_empty() {
        return Err(user_message::UserMessage::new(codes::FILES_EMPTY_RECORDING)
            .with_detail("Enregistrement vide.".to_string())
            .into_transport());
    }
    if data.len() > MAX_RECORDING_BYTES {
        return Err({
            let _msg_max_recording_bytes_1024_1024 =
                (MAX_RECORDING_BYTES / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::AUDIO_RECORDING_SIZE_LIMIT,
            )
                .param(
                    "maxRecordingMb",
                    user_message::transport_param(
                        _msg_max_recording_bytes_1024_1024.clone(),
                    ),
                )
                .with_detail(format!(
                    "Enregistrement trop volumineux (maximum {_msg_max_recording_bytes_1024_1024} Mo).",
                    _msg_max_recording_bytes_1024_1024 = user_message::transport_detail(
                        &_msg_max_recording_bytes_1024_1024
                    )
                ))
                .into_transport()
        });
    }

    let file_name = validate_recording_filename(filename)?;
    let recordings_dir = media_output_dir(
        workspace_dir,
        "enregistrements",
        project_destination,
        codes::AUDIO_RECORDING_WORKSPACE_REQUIRED_TRANSPORT,
    )?;
    fs::create_dir_all(&recordings_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::AUDIO_RECORDING_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le dossier d'enregistrements : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    // Une prise existante n'est jamais remplacée : le nom libre vient de la
    // même réservation que les outils d'assemblage, et la création exclusive
    // (`create_new`) garantit qu'aucun fichier apparu entre-temps n'est écrasé.
    let mut last_error = None;
    for _ in 0..RECORDING_NAME_ATTEMPTS {
        let file_path = unique_audio_assembly_path(&recordings_dir, file_name)?;
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                last_error = Some(error);
                continue;
            }
            Err(error) => {
                return Err({
                    let _msg_error = (error).to_string();
                    user_message::UserMessage::new(codes::AUDIO_RECORDING_SAVE_FAILED)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Impossible de sauvegarder l'enregistrement : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error)
                        ))
                        .into_transport()
                })
            }
        };
        if let Err(error) = file.write_all(data).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&file_path);
            return Err({
                let _msg_error = (error).to_string();
                user_message::UserMessage::new(codes::AUDIO_RECORDING_SAVE_FAILED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Impossible de sauvegarder l'enregistrement : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            });
        }
        return Ok(path_for_frontend(&file_path));
    }
    Err({
        let recording_name_error = (last_error
            .map(|error| error.to_string())
            .unwrap_or_default())
        .to_string();
        user_message::UserMessage::new(codes::AUDIO_RECORDING_NAME_EXHAUSTED)
            .param(
                "directory",
                user_message::transport_param(recording_name_error.clone()),
            )
            .with_detail(format!(
                "Impossible de trouver un nom libre pour l'enregistrement : {recording_name_error}",
                recording_name_error = user_message::transport_detail(&recording_name_error)
            ))
            .into_transport()
    })
}
