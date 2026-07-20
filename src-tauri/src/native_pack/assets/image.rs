use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::super::{AssetRequest, AssetSourceKind, PreparedAsset};
use super::audio::hashed_asset_name;
use crate::services::project_files::validate_existing_file_path;
use crate::support::ffmpeg::file_ext;

pub(crate) fn ensure_image_320x240(bytes: &[u8], role: &str) -> Result<Option<Vec<u8>>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Image illisible pour '{}' : {}", role, e))?;
    if img.width() == 320 && img.height() == 240 {
        return Ok(None);
    }
    let resized = img.resize_exact(320, 240, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Encodage 320x240 pour '{}' : {}", role, e))?;
    Ok(Some(out))
}

pub(crate) fn stage_binary_asset(
    role: &str,
    source_path: &str,
    source_kind: &str,
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
    transformed: bool,
) -> Result<PreparedAsset, String> {
    let source = validate_existing_file_path(source_path, role)?;
    let bytes =
        fs::read(&source).map_err(|e| format!("Lecture impossible pour {} : {}", role, e))?;
    let extension = file_ext(source.to_string_lossy().as_ref()).to_ascii_lowercase();
    let asset_name = hashed_asset_name(&bytes, &extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, &bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset prepare {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: source.to_string_lossy().to_string(),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed,
        deduplicated,
    })
}

pub(crate) fn stage_binary_asset_bytes(
    role: &str,
    original_name: &str,
    bytes: &[u8],
    assets_dir: &Path,
    seen_assets: &mut HashMap<String, PathBuf>,
) -> Result<PreparedAsset, String> {
    let extension = file_ext(original_name).to_ascii_lowercase();
    if extension.is_empty() {
        return Err(format!(
            "Extension introuvable pour l'asset importe {}",
            original_name
        ));
    }
    let asset_name = hashed_asset_name(bytes, &extension);
    let staged_path = assets_dir.join(&asset_name);
    let deduplicated = seen_assets.contains_key(&asset_name);
    if !deduplicated {
        fs::write(&staged_path, bytes).map_err(|e| {
            format!(
                "Impossible d'ecrire l'asset importe {} : {}",
                staged_path.display(),
                e
            )
        })?;
        seen_assets.insert(asset_name.clone(), staged_path.clone());
    }

    let source_kind = if matches!(
        extension.as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "webm" | "flac"
    ) {
        "audio"
    } else {
        "image"
    };

    Ok(PreparedAsset {
        role: role.to_string(),
        source_path: format!("zip://{}", original_name),
        source_kind: source_kind.to_string(),
        staged_asset_name: asset_name,
        staged_asset_path: staged_path.to_string_lossy().to_string(),
        transformed: false,
        deduplicated,
    })
}

pub(crate) fn image_request(role: &str, source_path: &str) -> AssetRequest {
    AssetRequest {
        role: role.to_string(),
        source_path: source_path.to_string(),
        source_kind: AssetSourceKind::Image,
        leading_silence_sec: 0.0,
        trailing_silence_sec: 0.0,
    }
}
