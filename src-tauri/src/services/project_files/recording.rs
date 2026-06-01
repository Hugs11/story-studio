use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use super::project_dir_from_save_path;
use crate::support::paths::path_for_frontend;

pub(super) const MAX_RECORDING_BYTES: usize = 100 * 1024 * 1024;
const MAX_RECORDING_FILENAME_CHARS: usize = 180;

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
    save_path: Option<&str>,
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
    let project_dir = workspace_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            save_path
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| project_dir_from_save_path(value).ok())
        })
        .ok_or_else(|| {
            "Definissez un emplacement de travail ou sauvegardez le projet avant d'enregistrer un audio."
                .to_string()
        })?;
    let recordings_dir = project_dir.join("enregistrements");
    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Impossible de creer le dossier d'enregistrements : {}", e))?;
    let file_path = recordings_dir.join(file_name);

    fs::write(&file_path, data)
        .map_err(|e| format!("Impossible de sauvegarder l'enregistrement : {}", e))?;
    Ok(path_for_frontend(&file_path.to_string_lossy()))
}
