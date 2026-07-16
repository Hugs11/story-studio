use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const AUDIO_PREVIEW_PREFIX: &str = "story_studio_audio_preview_";
const AUDIO_PREVIEW_EXTENSION: &str = "wav";

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct AudioPreviewCleanupReport {
    pub(crate) removed: usize,
    pub(crate) errors: usize,
}

fn validate_preview_name(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom d'aperçu audio invalide.".to_string())?;
    if !name.starts_with(AUDIO_PREVIEW_PREFIX) {
        return Err("Le fichier n'est pas un aperçu audio Story Studio.".to_string());
    }
    if path.extension().and_then(OsStr::to_str) != Some(AUDIO_PREVIEW_EXTENSION) {
        return Err("L'aperçu audio doit être un fichier WAV géré.".to_string());
    }
    Ok(())
}

fn canonical_temp_root(temp_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(temp_root)
        .map_err(|error| format!("Dossier temporaire inaccessible : {}", error))?;
    fs::canonicalize(temp_root)
        .map_err(|error| format!("Dossier temporaire inaccessible : {}", error))
}

/// Valide un aperçu audio Story Studio dans un dossier temporaire injecté.
///
/// `Ok(Some(path))` désigne un fichier géré existant, `Ok(None)` un chemin
/// géré déjà absent. Toute autre forme de chemin est refusée.
pub(crate) fn validate_managed_audio_preview_in(
    preview_path: &Path,
    temp_root: &Path,
) -> Result<Option<PathBuf>, String> {
    validate_preview_name(preview_path)?;
    let canonical_root = canonical_temp_root(temp_root)?;
    let parent = preview_path
        .parent()
        .ok_or_else(|| "Dossier d'aperçu audio invalide.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Dossier d'aperçu audio inaccessible : {}", error))?;
    if canonical_parent != canonical_root {
        return Err("Refus d'accéder à un aperçu audio hors du dossier temporaire.".to_string());
    }

    let metadata = match fs::symlink_metadata(preview_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("Aperçu audio inaccessible : {}", error));
        }
    };
    if metadata.file_type().is_symlink() {
        return Err("Refus d'accéder à un aperçu audio via un lien symbolique.".to_string());
    }
    if !metadata.is_file() {
        return Err("L'aperçu audio géré doit être un fichier régulier.".to_string());
    }

    let canonical_preview = fs::canonicalize(preview_path)
        .map_err(|error| format!("Aperçu audio inaccessible : {}", error))?;
    if canonical_preview.parent() != Some(canonical_root.as_path()) {
        return Err("Refus d'accéder à un aperçu audio hors du dossier temporaire.".to_string());
    }
    Ok(Some(canonical_preview))
}

pub(crate) fn discard_audio_preview_in(
    preview_path: &Path,
    temp_root: &Path,
) -> Result<(), String> {
    let Some(canonical_preview) = validate_managed_audio_preview_in(preview_path, temp_root)?
    else {
        return Ok(());
    };
    fs::remove_file(&canonical_preview)
        .map_err(|error| format!("Impossible de supprimer l'aperçu audio : {}", error))
}

pub fn discard_audio_preview(preview_path: &str) -> Result<(), String> {
    discard_audio_preview_in(Path::new(preview_path), &std::env::temp_dir())
}

pub(crate) fn cleanup_old_audio_previews_in(
    temp_root: &Path,
    max_age: Duration,
    now: SystemTime,
) -> Result<AudioPreviewCleanupReport, String> {
    let canonical_root = canonical_temp_root(temp_root)?;
    let cutoff = now.checked_sub(max_age).unwrap_or(UNIX_EPOCH);
    let entries = fs::read_dir(&canonical_root).map_err(|error| {
        format!(
            "Impossible de lire les aperçus audio temporaires : {}",
            error
        )
    })?;
    let mut report = AudioPreviewCleanupReport::default();

    for entry in entries {
        let Ok(entry) = entry else {
            report.errors += 1;
            continue;
        };
        let path = entry.path();
        if validate_preview_name(&path).is_err() {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            report.errors += 1;
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            report.errors += 1;
            continue;
        };
        if modified >= cutoff {
            continue;
        }
        match discard_audio_preview_in(&path, &canonical_root) {
            Ok(()) => report.removed += 1,
            Err(_) => report.errors += 1,
        }
    }

    Ok(report)
}

pub fn cleanup_old_audio_previews(max_age: Duration) {
    match cleanup_old_audio_previews_in(&std::env::temp_dir(), max_age, SystemTime::now()) {
        Ok(report) if report.errors > 0 => {
            log::warn!(
                target: "audio_preview",
                "cleanup completed with errors: removed={} errors={}",
                report.removed,
                report.errors
            );
        }
        Ok(report) if report.removed > 0 => {
            log::info!(
                target: "audio_preview",
                "cleanup removed {} stale preview(s)",
                report.removed
            );
        }
        Ok(_) => {}
        Err(error) => {
            log::warn!(target: "audio_preview", "cleanup failed: {}", error);
        }
    }
}
