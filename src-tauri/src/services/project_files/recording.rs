use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use super::audio::unique_audio_assembly_path;
use super::media_output_root;
use crate::support::paths::path_for_frontend;

pub(super) const MAX_RECORDING_BYTES: usize = 100 * 1024 * 1024;
const MAX_RECORDING_FILENAME_CHARS: usize = 180;
const RECORDING_NAME_ATTEMPTS: usize = 8;

pub(super) fn validate_recording_filename(filename: &str) -> Result<&str, String> {
    let path = Path::new(filename);
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom d'enregistrement invalide.".to_string())?;
    if file_name != filename || file_name.trim().is_empty() {
        return Err("Nom d'enregistrement invalide.".to_string());
    }
    if file_name.chars().count() > MAX_RECORDING_FILENAME_CHARS {
        return Err(format!(
            "Nom d'enregistrement trop long (maximum {} caracteres).",
            MAX_RECORDING_FILENAME_CHARS
        ));
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("Nom d'enregistrement contient des caracteres interdits.".to_string());
    }
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("webm" | "wav")) {
        return Err("Extension d'enregistrement non prise en charge.".to_string());
    }
    Ok(file_name)
}

pub(crate) fn save_recording(
    workspace_dir: Option<&str>,
    filename: &str,
    data: &[u8],
) -> Result<String, String> {
    if data.is_empty() {
        return Err("Enregistrement vide.".to_string());
    }
    if data.len() > MAX_RECORDING_BYTES {
        return Err(format!(
            "Enregistrement trop volumineux (maximum {} Mo).",
            MAX_RECORDING_BYTES / 1024 / 1024
        ));
    }

    let file_name = validate_recording_filename(filename)?;
    let project_dir = media_output_root(
        workspace_dir,
        "Aucun emplacement de travail : impossible d'enregistrer un audio.",
    )?;
    let recordings_dir = project_dir.join("enregistrements");
    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Impossible de creer le dossier d'enregistrements : {}", e))?;
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
                return Err(format!(
                    "Impossible de sauvegarder l'enregistrement : {}",
                    error
                ))
            }
        };
        if let Err(error) = file.write_all(data).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&file_path);
            return Err(format!(
                "Impossible de sauvegarder l'enregistrement : {}",
                error
            ));
        }
        return Ok(path_for_frontend(&file_path));
    }
    Err(format!(
        "Impossible de trouver un nom libre pour l'enregistrement : {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_default()
    ))
}
