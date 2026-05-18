mod commands;
mod domain;
mod native_pack;
mod services;
mod support;

fn cleanup_temp_image_dir(dir_name: &str) {
    let dir = std::env::temp_dir().join(dir_name);
    if !dir.is_dir() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(24 * 3600))
        .unwrap_or(std::time::UNIX_EPOCH);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified < cutoff {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

fn cleanup_temp_images() {
    for dir_name in [
        support::temp::TEMP_IMAGES_DIR,
        support::temp::LEGACY_TEMP_IMAGES_DIR,
    ] {
        cleanup_temp_image_dir(dir_name);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::thread::spawn(cleanup_temp_images);
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::generation::generate_pack,
            commands::generation::generate_pack_native_dry_run,
            commands::generation::generate_pack_native_v1,
            commands::files::save_recording,
            commands::files::delete_file,
            commands::files::delete_workspace_media_file,
            commands::files::concat_audio_files,
            commands::files::extract_audio_embedded_image,
            commands::files::trim_audio,
            commands::files::cut_audio,
            commands::files::audio_edit_info,
            commands::files::preview_audio_edit,
            commands::files::apply_audio_edit,
            commands::files::commit_audio_preview,
            commands::files::restore_audio_original,
            commands::files::validate_lunii_zip_cmd,
            commands::files::scan_unused_project_files,
            commands::files::delete_unused_project_files,
            commands::files::scan_import_folder,
            commands::files::list_folder_media_files,
            commands::pack::load_pack_zip,
            commands::pack::get_pack_asset,
            commands::pack::unpack_zip_to_entries,
            commands::xtts::xtts_get_status,
            commands::xtts::xtts_generate_audio,
            commands::comfyui::comfyui_check,
            commands::comfyui::comfyui_list_workflows,
            commands::comfyui::comfyui_import_workflow,
            commands::comfyui::comfyui_delete_workflow,
            commands::comfyui::comfyui_watch_progress,
            commands::comfyui::comfyui_submit_job,
            commands::comfyui::comfyui_poll_job,
            commands::comfyui::comfyui_download_output,
            commands::media_probe::probe_media_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
