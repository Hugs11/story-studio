use crate::services::{community_pack_checker, pack_reader};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn load_pack_zip(zip_path: String) -> Result<String, String> {
    log::info!(target: "pack", "load_pack_zip: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::load_pack_zip(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "load_pack_zip failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_pack_asset(zip_path: String, asset_name: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::get_pack_asset(&zip_path, &asset_name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unpack_zip_to_entries(
    zip_path: String,
    dest_dir: String,
    workspace_dir: String,
    allow_unsupported: Option<bool>,
) -> Result<serde_json::Value, String> {
    log::info!(target: "pack", "unpack_zip_to_entries: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(&dest_dir, &workspace_dir)?;
        let allow_unsupported = allow_unsupported.unwrap_or(false);
        if allow_unsupported {
            log::warn!(target: "pack", "unsafe editability bypass enabled for '{}'", zip_path_for_log);
        }
        let result = if allow_unsupported {
            pack_reader::unpack_zip_to_entries_with_policy(
                &zip_path,
                &safe_dest.to_string_lossy(),
                true,
            )
        } else {
            pack_reader::unpack_zip_to_entries(&zip_path, &safe_dest.to_string_lossy())
        };
        result
            .inspect_err(|err| log::error!(target: "pack", "unpack_zip_to_entries failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn convert_folder_pack_to_zip(folder_path: String) -> Result<String, String> {
    log::info!(target: "pack", "convert_folder_pack_to_zip: '{}'", folder_path);
    let folder_for_log = folder_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::support::imported_pack::ensure_studio_pack_zip_from_dir(&folder_path)
            .map(|path| path.to_string_lossy().to_string())
            .inspect_err(|err| log::error!(target: "pack", "convert_folder_pack_to_zip failed for '{}': {}", folder_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_pack_editability(zip_path: String) -> Result<bool, String> {
    log::info!(target: "pack", "check_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::check_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "check_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn classify_pack_editability(
    zip_path: String,
) -> Result<pack_reader::PackEditabilityReport, String> {
    log::info!(target: "pack", "classify_pack_editability: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pack_reader::classify_pack_editability(&zip_path)
            .inspect_err(|err| log::error!(target: "pack", "classify_pack_editability failed for '{}': {}", zip_path_for_log, err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn analyze_community_pack(
    app: AppHandle,
    zip_path: String,
) -> Result<community_pack_checker::PackValidationReport, String> {
    log::info!(target: "pack_checker", "analyze_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(source.to_string_lossy().as_ref())?;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        if analysis_zip != source {
            emit("Préparation temporaire de l'archive pour analyse...");
        }
        let mut report = community_pack_checker::analyze_pack_with_log(&analysis_zip, &emit);
        report.pack_name = pack_name_from_source(&source);
        report.zip_path = source.to_string_lossy().to_string();
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "analyze_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}

#[tauri::command]
pub async fn create_fixed_community_pack(
    app: AppHandle,
    zip_path: String,
    output_dir: Option<String>,
    metadata_patch: Option<community_pack_checker::PackMetadataPatch>,
) -> Result<community_pack_checker::FixedPackResult, String> {
    log::info!(target: "pack_checker", "create_fixed_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        let analysis_zip =
            crate::support::imported_pack::ensure_studio_pack_zip(source.to_string_lossy().as_ref())?;
        let safe_output_dir = output_dir
            .as_deref()
            .map(|path| crate::services::project_files::validate_existing_dir_path(path, "Dossier de sortie"))
            .transpose()?;
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        if analysis_zip != source {
            emit("Préparation temporaire de l'archive pour correction...");
            return community_pack_checker::create_fixed_pack_with_source_log(
                &analysis_zip,
                &source,
                safe_output_dir.as_deref(),
                metadata_patch,
                &emit,
            );
        }
        community_pack_checker::create_fixed_pack_with_log(
            &analysis_zip,
            safe_output_dir.as_deref(),
            metadata_patch,
            &emit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|err| {
        log::error!(target: "pack_checker", "create_fixed_community_pack failed for '{}': {}", zip_path_for_log, err)
    })
}

fn pack_name_from_source(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack")
        .to_string()
}
