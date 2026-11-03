use crate::support::user_message;
use crate::support::user_message::codes;
use std::path::Path;

pub(crate) use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

pub(crate) const MAX_STORY_JSON_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const MAX_TOTAL_ASSET_BYTES: u64 = 5 * 1024 * 1024 * 1024;

pub(crate) fn ensure_zip_entry_count(len: usize, zip_path: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err({
            let _msg_len = (len).to_string();
            let _msg_zip_path = (zip_path.display()).to_string();
            let _msg_archive_max_entries = (ARCHIVE_MAX_ENTRIES).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_ARCHIVE_ENTRY_LIMIT,
            )
                .param("count", user_message::transport_param(_msg_len.clone()))
                .param("zipPath", user_message::transport_param(_msg_zip_path.clone()))
                .param(
                    "maxEntries",
                    user_message::transport_param(_msg_archive_max_entries.clone()),
                )
                .with_detail(format!(
                    "Archive trop volumineuse : {_msg_len} entrees dans {_msg_zip_path} (maximum {_msg_archive_max_entries}).",
                    _msg_archive_max_entries = user_message::transport_detail(&_msg_archive_max_entries),
                    _msg_len = user_message::transport_detail(&_msg_len),
                    _msg_zip_path = user_message::transport_detail(&_msg_zip_path),
                ))
                .into_transport()
        });
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
        return Err({
            let _msg_kind = (kind).to_string();
            let _msg_name = (name).to_string();
            let _msg_size_1024_1024 = (size / 1024 / 1024).to_string();
            let _msg_max_1024_1024 = (max / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_ARCHIVE_FILE_SIZE_LIMIT,
            )
                .param("kind", user_message::transport_param(_msg_kind.clone()))
                .param("name", user_message::transport_param(_msg_name.clone()))
                .param("sizeMb", user_message::transport_param(_msg_size_1024_1024.clone()))
                .param("maxMb", user_message::transport_param(_msg_max_1024_1024.clone()))
                .with_detail(format!(
                    "{_msg_kind} trop volumineux : {_msg_name} fait {_msg_size_1024_1024} Mo (maximum {_msg_max_1024_1024} Mo).",
                    _msg_kind = user_message::transport_detail(&_msg_kind),
                    _msg_max_1024_1024 = user_message::transport_detail(&_msg_max_1024_1024),
                    _msg_name = user_message::transport_detail(&_msg_name),
                    _msg_size_1024_1024 = user_message::transport_detail(&_msg_size_1024_1024),
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub(crate) fn validate_pack_asset_name(asset_name: &str) -> Result<String, String> {
    let trimmed = asset_name.trim();
    if trimmed.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::IMPORT_EMPTY_ASSET_NAME)
                .with_detail("Nom d'asset vide.".to_string())
                .into_transport(),
        );
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') {
        return Err({
            let _msg_asset_name = (asset_name).to_string();
            user_message::UserMessage::new(codes::IMPORT_INVALID_ASSET_NAME)
                .param(
                    "assetName",
                    user_message::transport_param(_msg_asset_name.clone()),
                )
                .with_detail(format!(
                    "Nom d'asset invalide : {_msg_asset_name}",
                    _msg_asset_name = user_message::transport_detail(&_msg_asset_name)
                ))
                .into_transport()
        });
    }
    if !trimmed.starts_with("assets/") {
        return Err({
            let _msg_asset_name = (asset_name).to_string();
            user_message::UserMessage::new(codes::IMPORT_ASSET_FOLDER_OUTSIDE)
                .param(
                    "assetName",
                    user_message::transport_param(_msg_asset_name.clone()),
                )
                .with_detail(format!(
                    "Nom d'asset hors dossier assets/ : {_msg_asset_name}",
                    _msg_asset_name = user_message::transport_detail(&_msg_asset_name)
                ))
                .into_transport()
        });
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err({
            let _msg_asset_name = (asset_name).to_string();
            user_message::UserMessage::new(codes::IMPORT_INVALID_ASSET_NAME)
                .param(
                    "assetName",
                    user_message::transport_param(_msg_asset_name.clone()),
                )
                .with_detail(format!(
                    "Nom d'asset invalide : {_msg_asset_name}",
                    _msg_asset_name = user_message::transport_detail(&_msg_asset_name)
                ))
                .into_transport()
        });
    }
    Ok(trimmed.to_string())
}

pub(crate) fn ensure_total_asset_size(total_asset_bytes: u64) -> Result<(), String> {
    if total_asset_bytes > MAX_TOTAL_ASSET_BYTES {
        return Err({
            let asset_size_mb = (total_asset_bytes / 1024 / 1024).to_string();
            let asset_size_limit_mb = (MAX_TOTAL_ASSET_BYTES / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_ASSET_EXTRACTED_SIZE_LIMIT,
            )
                .param(
                    "totalAssetMb",
                    user_message::transport_param(asset_size_mb.clone()),
                )
                .param(
                    "maxAssetMb",
                    user_message::transport_param(asset_size_limit_mb.clone()),
                )
                .with_detail(format!(
                    "Assets ZIP trop volumineux : {asset_size_mb} Mo extraits (maximum {asset_size_limit_mb} Mo).",
                    asset_size_limit_mb = user_message::transport_detail(&asset_size_limit_mb),
                    asset_size_mb = user_message::transport_detail(&asset_size_mb),
                ))
                .into_transport()
        });
    }
    Ok(())
}
