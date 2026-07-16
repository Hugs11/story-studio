use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::super::{project_dir_from_save_path, validate_existing_file_path, MANAGED_PROJECT_DIRS};
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;
// ── Audio trim ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, Default)]
pub(crate) struct AudioEditSidecar {
    pub(crate) original_path: String,
    pub(crate) mode: String,
    pub(crate) start_sec: f64,
    pub(crate) end_sec: f64,
    pub(crate) fade_in_sec: f64,
    pub(crate) fade_out_sec: f64,
    pub(crate) cut_fade_sec: f64,
}

#[derive(serde::Serialize)]
pub struct TrimAudioResult {
    pub output_path: String,
    pub path_changed: bool,
    pub original_path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AudioEditInfo {
    pub original_available: bool,
    pub original_path: Option<String>,
    pub source_path: String,
    pub mode: Option<String>,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
    pub cut_fade_sec: f64,
}

#[derive(Clone, Copy)]
pub struct AudioEditParams<'a> {
    pub mode: &'a str,
    pub start_sec: f64,
    pub end_sec: f64,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
    pub cut_fade_sec: f64,
}

pub struct AudioEditRequest<'a> {
    pub input_path: &'a str,
    pub save_path: Option<&'a str>,
    pub workspace_dir: Option<&'a str>,
    pub params: AudioEditParams<'a>,
}

pub(crate) struct FfmpegAudioEditRequest<'a> {
    pub(crate) ffmpeg: &'a Path,
    pub(crate) input: &'a str,
    pub(crate) output: &'a str,
    pub(crate) params: AudioEditParams<'a>,
    pub(crate) ext: &'a str,
}

/// Dossiers gérés où un trim peut écraser le fichier en place.
/// (différent de MANAGED_PROJECT_DIRS qui exclut zips-extraits)
pub(crate) const TRIM_IN_PLACE_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "fichiers-importes",
    "zips-extraits",
];

pub(crate) const AUDIO_EDIT_DIR: &str = ".story-studio-audio-edits";

pub(crate) fn audio_edit_dir_for(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Impossible de déterminer le dossier audio.".to_string())?;
    Ok(parent.join(AUDIO_EDIT_DIR))
}

pub(crate) fn audio_edit_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|value| value.to_string())
        .ok_or_else(|| "Nom de fichier audio invalide.".to_string())
}

pub(crate) fn audio_edit_sidecar_path(path: &Path) -> Result<PathBuf, String> {
    Ok(audio_edit_dir_for(path)?.join(format!("{}.edit.json", audio_edit_file_name(path)?)))
}

/// Chemin de sauvegarde de l'original, en sibling visible du fichier édité.
///
/// Convention : `{stem}.original.{ext}` à côté du fichier édité, ignoré par la
/// médiathèque et les flux d'import/scan (cf. `isOriginalBackup` côté JS et
/// `is_original_backup` côté Rust).
///
/// En cas de collision (le fichier existe déjà — autre édité du même stem, ou fichier
/// utilisateur légitime), on bascule sur `{stem}.original-2.{ext}`, puis `-3`, etc.
pub(crate) fn audio_edit_original_path(path: &Path, source_ext: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Impossible de déterminer le dossier audio.".to_string())?;
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom de fichier audio invalide.".to_string())?;
    let ext = source_ext.trim().trim_start_matches('.');

    let build = |suffix: &str| -> PathBuf {
        let name = if ext.is_empty() {
            format!("{}.original{}", stem, suffix)
        } else {
            format!("{}.original{}.{}", stem, suffix, ext)
        };
        parent.join(name)
    };

    let preferred = build("");
    if !preferred.exists() {
        return Ok(preferred);
    }
    for n in 2..=999 {
        let candidate = build(&format!("-{}", n));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Trop de variantes d'originaux existent déjà pour ce fichier audio.".to_string())
}

pub(crate) fn is_in_managed_media_dir(
    path: &Path,
    workspace_dir: Option<&str>,
    save_path: Option<&str>,
) -> bool {
    let Ok(target) = fs::canonicalize(path) else {
        return false;
    };

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(ws) = workspace_dir.filter(|s| !s.trim().is_empty()) {
        bases.push(PathBuf::from(ws));
    }
    if let Some(sp) = save_path.filter(|s| !s.trim().is_empty()) {
        if let Ok(dir) = project_dir_from_save_path(sp) {
            bases.push(dir);
        }
    }

    for base in bases {
        for dir_name in MANAGED_PROJECT_DIRS {
            let dir = base.join(dir_name);
            if !dir.exists() {
                continue;
            }
            if let Ok(canonical) = fs::canonicalize(&dir) {
                if target.starts_with(&canonical) {
                    return true;
                }
            }
        }
    }
    false
}

pub(crate) fn audio_edit_original_for_final(
    final_path: &Path,
    source_path: &Path,
    source_ext: &str,
    path_changed: bool,
    workspace_dir: Option<&str>,
    save_path: Option<&str>,
) -> Result<PathBuf, String> {
    if path_changed && is_in_managed_media_dir(source_path, workspace_dir, save_path) {
        return Ok(source_path.to_path_buf());
    }

    let original_path = audio_edit_original_path(final_path, source_ext)?;
    if let Some(parent) = original_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Impossible de créer le dossier original audio : {}", e))?;
    }
    fs::copy(source_path, &original_path)
        .map_err(|e| format!("Impossible de sauvegarder l'audio original : {}", e))?;
    Ok(original_path)
}

/// Détecte si un nom de fichier correspond à la convention de backup `{stem}.original{-N}.{ext}`.
///
/// Utilisé pour exclure ces fichiers des scans et imports.
pub fn is_original_backup(file_name: &str) -> bool {
    // On cherche un segment ".original" ou ".original-<chiffres>" juste avant l'extension finale.
    let trimmed = file_name;
    let dot = match trimmed.rfind('.') {
        Some(pos) => pos,
        None => return false,
    };
    let stem = &trimmed[..dot];
    let last_dot = match stem.rfind('.') {
        Some(pos) => pos,
        None => return false,
    };
    let candidate = &stem[last_dot + 1..];
    if candidate == "original" {
        return true;
    }
    if let Some(rest) = candidate.strip_prefix("original-") {
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

pub(crate) fn read_audio_edit_sidecar(path: &Path) -> Option<AudioEditSidecar> {
    let sidecar_path = audio_edit_sidecar_path(path).ok()?;
    let data = fs::read_to_string(sidecar_path).ok()?;
    serde_json::from_str(&data).ok()
}

pub(crate) fn write_audio_edit_sidecar(
    path: &Path,
    sidecar: &AudioEditSidecar,
) -> Result<(), String> {
    let dir = audio_edit_dir_for(path)?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Impossible de créer le dossier d'édition audio : {}", e))?;
    let sidecar_path = audio_edit_sidecar_path(path)?;
    let json = serde_json::to_string_pretty(sidecar)
        .map_err(|e| format!("Impossible de sérialiser l'édition audio : {}", e))?;
    fs::write(&sidecar_path, json)
        .map_err(|e| format!("Impossible d'écrire l'édition audio : {}", e))
}

pub(crate) fn audio_edit_source_for(input: &Path) -> PathBuf {
    input.to_path_buf()
}

pub(crate) fn is_expected_audio_original_path(input: &Path, original: &Path) -> bool {
    let Some(input_parent) = input.parent() else {
        return false;
    };
    let Some(input_file_name) = input.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let Some(input_stem) = input.file_stem().and_then(OsStr::to_str) else {
        return false;
    };

    let Ok(input_parent_canonical) = fs::canonicalize(input_parent) else {
        return false;
    };
    let Ok(original_canonical) = fs::canonicalize(original) else {
        return false;
    };

    if original_canonical.parent() == Some(input_parent_canonical.as_path()) {
        let Some(original_name) = original_canonical.file_name().and_then(OsStr::to_str) else {
            return false;
        };
        if !is_original_backup(original_name) {
            return false;
        }
        let Some(original_stem) = original_canonical.file_stem().and_then(OsStr::to_str) else {
            return false;
        };
        let original_base = original_stem
            .rsplit_once('.')
            .map(|(base, _)| base)
            .unwrap_or(original_stem);
        return original_base == input_stem;
    }

    let legacy_dir = input_parent_canonical.join(AUDIO_EDIT_DIR);
    if original_canonical.parent() == Some(legacy_dir.as_path()) {
        let Some(original_name) = original_canonical.file_name().and_then(OsStr::to_str) else {
            return false;
        };
        return original_name.starts_with(&format!("{}.original", input_file_name));
    }

    false
}

pub(crate) fn clamp_fade(value: f64, max_duration: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else {
        value.min(max_duration.max(0.0)).min(10.0)
    }
}

pub(crate) fn filter_number(value: f64) -> String {
    format!("{:.3}", value.max(0.0))
}

mod ffmpeg;
mod operations;
mod preview;

pub(crate) use ffmpeg::*;
pub use operations::*;
pub use preview::{cleanup_old_audio_previews, discard_audio_preview};
pub(crate) use preview::{
    discard_audio_preview_in, validate_managed_audio_preview_in, AUDIO_PREVIEW_PREFIX,
};
#[cfg(test)]
pub(crate) use preview::cleanup_old_audio_previews_in;
