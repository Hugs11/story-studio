//! Résolution sécurisée des noms et dossiers de sortie pour Piper. Même
//! discipline que `services/xtts/output.rs` : on borne strictement la sortie à
//! `voix-generees/` et on rejette tout segment de chemin dans le hint
//! utilisateur. Piper produit un MP3 final (WAV intermédiaire converti).

use super::PiperGenerateRequest;
use crate::support::ffmpeg::now_millis;
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
        return Err(format!("Nom de sortie Piper invalide : {}", filename));
    }
    let file_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Nom de sortie Piper invalide : {}", filename))?;
    if file_name != filename {
        return Err(format!("Nom de sortie Piper invalide : {}", filename));
    }
    Ok(file_name.to_string())
}

fn reject_unsafe_hint(raw_hint: &str) -> Result<(), String> {
    if raw_hint.contains('/')
        || raw_hint.contains('\\')
        || raw_hint.contains("..")
        || raw_hint.chars().any(char::is_control)
    {
        return Err(format!("Nom de sortie Piper invalide : {}", raw_hint));
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
    if let Some(workspace_dir) = request
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(workspace_dir).join("voix-generees"));
    }

    let save_path = request
        .save_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Definissez un emplacement de travail ou sauvegardez le projet avant de generer une voix."
                .to_string()
        })?;
    let project_path = PathBuf::from(save_path);
    let parent = project_path.parent().ok_or_else(|| {
        format!(
            "Impossible de determiner le dossier du projet depuis {}",
            save_path
        )
    })?;
    Ok(parent.join("voix-generees"))
}
