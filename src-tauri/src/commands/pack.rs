use crate::services::pack_reader;

#[tauri::command]
pub async fn load_pack_zip(zip_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pack_reader::load_pack_zip(&zip_path))
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
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = crate::services::project_files::validate_existing_pack_path(&zip_path)?
            .to_string_lossy()
            .to_string();
        let safe_dest =
            crate::services::project_files::validate_unpack_dest_dir(&dest_dir, &workspace_dir)?;
        pack_reader::unpack_zip_to_entries(&zip_path, &safe_dest.to_string_lossy())
    })
    .await
    .map_err(|e| e.to_string())?
}
