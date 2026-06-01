use std::path::Path;

pub(crate) use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

pub(crate) const MAX_STORY_JSON_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const MAX_TOTAL_ASSET_BYTES: u64 = 5 * 1024 * 1024 * 1024;

pub(crate) fn ensure_zip_entry_count(len: usize, zip_path: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err(format!(
            "Archive trop volumineuse : {} entrees dans {} (maximum {}).",
            len,
            zip_path.display(),
            ARCHIVE_MAX_ENTRIES
        ));
    }
    Ok(())
}

pub(crate) fn ensure_zip_entry_size(
    kind: &str,
    name: &str,
    size: u64,
    max: u64,
) -> Result<(), String> {
    if size > max {
        return Err(format!(
            "{} trop volumineux : {} fait {} Mo (maximum {} Mo).",
            kind,
            name,
            size / 1024 / 1024,
            max / 1024 / 1024
        ));
    }
    Ok(())
}

pub(crate) fn validate_pack_asset_name(asset_name: &str) -> Result<String, String> {
    let trimmed = asset_name.trim();
    if trimmed.is_empty() {
        return Err("Nom d'asset vide.".to_string());
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') {
        return Err(format!("Nom d'asset invalide : {}", asset_name));
    }
    if !trimmed.starts_with("assets/") {
        return Err(format!("Nom d'asset hors dossier assets/ : {}", asset_name));
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Nom d'asset invalide : {}", asset_name));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn ensure_total_asset_size(total_asset_bytes: u64) -> Result<(), String> {
    if total_asset_bytes > MAX_TOTAL_ASSET_BYTES {
        return Err(format!(
            "Assets ZIP trop volumineux : {} Mo extraits (maximum {} Mo).",
            total_asset_bytes / 1024 / 1024,
            MAX_TOTAL_ASSET_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}
