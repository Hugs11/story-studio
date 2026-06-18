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

fn build_log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Target, TargetKind};

    let mut targets = vec![Target::new(TargetKind::LogDir {
        file_name: Some("story-studio".to_string()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }

    tauri_plugin_log::Builder::new()
        .targets(targets)
        .max_file_size(5_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .level(log::LevelFilter::Trace)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::thread::spawn(cleanup_temp_images);

    // Niveau d'execution par defaut = Warn (info desactive). Le frontend appelle
    // set_log_level("info") au boot s'il a stocke la preference verbose.
    log::set_max_level(log::LevelFilter::Warn);

    tauri::Builder::default()
        .manage(std::sync::Arc::new(
            commands::generation::GenerationCancelState::default(),
        ))
        .plugin(build_log_plugin())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(dir) = app.path().app_log_dir() {
                commands::diagnostics::prune_old_log_files(&dir, 3);
            }
            log::warn!(target: "boot",
                "Story Studio {} started (os = {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::generation::generate_pack,
            commands::generation::cancel_generate_pack,
            commands::files::save_recording,
            commands::files::delete_file,
            commands::files::delete_workspace_media_file,
            commands::files::concat_audio_files,
            commands::files::split_audio_segments,
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
            commands::pack::analyze_community_pack,
            commands::pack::create_fixed_community_pack,
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
            commands::media_probe::probe_media_files,
            commands::podcast::fetch_podcast_feed,
            commands::podcast::download_podcast_media,
            commands::diagnostics::set_log_level,
            commands::diagnostics::get_current_log_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
