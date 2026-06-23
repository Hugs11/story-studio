use crate::services::{community_pack_checker, pack_reader};
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
) -> Result<serde_json::Value, String> {
    log::info!(target: "pack", "unpack_zip_to_entries: zip='{}' dest='{}'", zip_path, dest_dir);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(&dest_dir, &workspace_dir)?;
        pack_reader::unpack_zip_to_entries(&zip_path, &safe_dest.to_string_lossy())
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
pub async fn analyze_community_pack(
    app: AppHandle,
    zip_path: String,
) -> Result<community_pack_checker::PackValidationReport, String> {
    log::info!(target: "pack_checker", "analyze_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let safe_zip = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        if safe_zip
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("zip"))
            .unwrap_or(true)
        {
            return Err("Le vérificateur communautaire V1 accepte uniquement les fichiers ZIP.".to_string());
        }
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        Ok(community_pack_checker::analyze_pack_with_log(
            &safe_zip,
            &emit,
        ))
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
    metadata_patch: Option<community_pack_checker::PackMetadataPatch>,
) -> Result<community_pack_checker::FixedPackResult, String> {
    log::info!(target: "pack_checker", "create_fixed_community_pack: '{}'", zip_path);
    let zip_path_for_log = zip_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let safe_zip = crate::services::project_files::validate_existing_pack_path(&zip_path)?;
        if safe_zip
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("zip"))
            .unwrap_or(true)
        {
            return Err("La correction communautaire V1 accepte uniquement les fichiers ZIP.".to_string());
        }
        let emit = |msg: &str| {
            let _ = app.emit("community-pack-checker-log", msg.to_string());
        };
        community_pack_checker::create_fixed_pack_with_log(
            &safe_zip,
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
