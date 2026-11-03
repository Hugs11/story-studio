mod commands;
mod domain;
mod native_pack;
mod services;
mod support;

fn cleanup_old_files_in_dir(dir: &std::path::Path, max_age: std::time::Duration) {
    if !dir.is_dir() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(max_age)
        .unwrap_or(std::time::UNIX_EPOCH);
    if let Ok(entries) = std::fs::read_dir(dir) {
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

fn cleanup_application_cache(dir: &std::path::Path) {
    let max_age = std::time::Duration::from_secs(24 * 3600);
    support::temp::cleanup_orphan_session_workspaces(
        &dir.join(support::temp::SESSION_WORKSPACES_DIR),
        max_age,
    );
    services::project_files::cleanup_old_audio_previews(
        &dir.join(support::temp::AUDIO_PREVIEWS_DIR),
        max_age,
    );
    for cache_dir in [
        support::temp::TEMP_IMAGES_DIR,
        support::temp::PODCAST_MEDIA_DIR,
        support::temp::YOUTUBE_MEDIA_DIR,
        support::imported_pack::IMPORTED_PACK_CACHE_DIR,
    ] {
        cleanup_old_files_in_dir(&dir.join(cache_dir), max_age);
    }
}

fn cleanup_temp_images() {
    support::temp::cleanup_orphan_session_workspaces(
        &std::env::temp_dir().join("story_studio_catalogue"),
        std::time::Duration::from_secs(24 * 3600),
    );
    for dir_name in [
        support::temp::TEMP_IMAGES_DIR,
        support::temp::LEGACY_TEMP_IMAGES_DIR,
    ] {
        cleanup_old_files_in_dir(
            &std::env::temp_dir().join(dir_name),
            std::time::Duration::from_secs(24 * 3600),
        );
    }
}

const LOG_MAX_FILE_SIZE: u128 = 5_000_000;

fn log_plugin_builder(disk: Option<tauri_plugin_log::TargetKind>) -> tauri_plugin_log::Builder {
    use tauri_plugin_log::{Target, TargetKind};
    let mut targets = vec![Target::new(disk.unwrap_or(TargetKind::Stderr))];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    tauri_plugin_log::Builder::new()
        .targets(targets)
        .max_file_size(LOG_MAX_FILE_SIZE)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .level(log::LevelFilter::Trace)
}

fn prepare_logging<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    buffer: &support::startup_log::StartupLog,
    target: tauri_plugin_log::TargetKind,
) -> Result<(), Box<dyn std::error::Error>> {
    let (plugin, level, logger) = log_plugin_builder(Some(target)).split(app)?;
    app.plugin(plugin)?;
    buffer.attach(logger);
    log::set_max_level(level);
    Ok(())
}

fn initialize_resources<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    support::tool_resolver::initialize_resource_dir(app.path().resource_dir()?);
    Ok(())
}

trait StartupWriterWork {
    fn cleanup_temporary(&self);
    fn cleanup_cache(&self);
    fn start_watching(&self);
    fn clean_at_startup(&self);
}

struct NativeStartupWriter<'a>(&'a tauri::AppHandle);
impl StartupWriterWork for NativeStartupWriter<'_> {
    fn cleanup_temporary(&self) {
        std::thread::spawn(cleanup_temp_images);
    }
    fn cleanup_cache(&self) {
        use tauri::Manager;
        if let Ok(dir) = self.0.path().app_cache_dir() {
            std::thread::spawn(move || cleanup_application_cache(&dir));
        }
    }
    fn start_watching(&self) {
        services::catalogue::start_watching(self.0);
    }
    fn clean_at_startup(&self) {
        services::catalogue::open::clean_at_startup(self.0);
    }
}

fn writer_startup(work: &impl StartupWriterWork) {
    work.cleanup_temporary();
    work.cleanup_cache();
    work.start_watching();
    work.clean_at_startup();
}

fn setup_startup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    buffer: &support::startup_log::StartupLog,
    target: tauri_plugin_log::TargetKind,
    writer_work: &impl StartupWriterWork,
) -> Result<bool, Box<dyn std::error::Error>> {
    use tauri::Manager;
    let admitted = admit_startup(
        app,
        |_| prepare_logging(app, buffer, target),
        || writer_startup(writer_work),
    )?;
    if admitted {
        if let Ok(dir) = app.path().app_log_dir() {
            commands::diagnostics::prune_old_log_files(&dir, 3);
        }
    }
    Ok(admitted)
}

fn startup_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    single_instance: tauri::plugin::TauriPlugin<R>,
) -> tauri::Builder<R> {
    let builder = builder
        .plugin(single_instance)
        .manage(services::catalogue::CatalogueState::default())
        .manage(std::sync::Arc::new(
            commands::generation::GenerationCancelState::default(),
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Catalogue covers by stable address (`<img src>`), see the adapter.
    commands::catalogue_cover_protocol::register(builder)
}

/// Shared setup ordering: admission, resources/logging, then writer-only work.
/// Log pruning (`prune_old_log_files`) also runs in degraded mode, on purpose:
/// it only touches this process's own log directory.
/// A blocked process never installs a logger or touches shared startup state.
pub(crate) fn admit_startup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    prepare: impl FnOnce(bool) -> Result<(), Box<dyn std::error::Error>>,
    cleanup: impl FnOnce(),
) -> Result<bool, Box<dyn std::error::Error>> {
    admit_startup_with_resources(app, || initialize_resources(app), prepare, cleanup)
}

pub(crate) fn admit_startup_with_resources<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    resources: impl FnOnce() -> Result<(), Box<dyn std::error::Error>>,
    prepare: impl FnOnce(bool) -> Result<(), Box<dyn std::error::Error>>,
    cleanup: impl FnOnce(),
) -> Result<bool, Box<dyn std::error::Error>> {
    let owns_writer = match services::catalogue::initialize(app) {
        Ok(()) => true,
        Err(cause) if cause.code == support::user_message::codes::CATALOG_ALREADY_OPEN => {
            return Ok(false)
        }
        Err(_) => false,
    };
    // Automatic scans may need bundled 7-Zip immediately. Resolve tools before
    // installing logging or starting any writer-owned background work.
    resources()?;
    prepare(owns_writer)?;
    if owns_writer {
        cleanup();
    } else {
        log::warn!(target: "boot", "Catalogue unavailable: shared startup cleanup skipped");
    }
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Le tampon de demarrage ne garde que Warn et plus avant l'attache du journal
    // fichier. Le niveau maximal Trace est celui que tauri-plugin-log reglerait de
    // toute facon a l'installation; le frontend appelle set_log_level au boot
    // (preference verbose ou non) pour le ramener au niveau choisi.
    log::set_logger(&support::startup_log::LOGGER).expect("startup logger");
    log::set_max_level(log::LevelFilter::Trace);

    startup_builder(tauri::Builder::default(), tauri_plugin_single_instance::init(|app, _, _| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(commands::lunii_device::Registry::default())
        .register_asynchronous_uri_scheme_protocol("lunii-cover", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let bytes = commands::lunii_device::cover(&app, request.uri().path());
                let response = tauri::http::Response::builder()
                    .status(if bytes.is_ok() { 200 } else { 404 })
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes.unwrap_or_default())
                    .unwrap_or_default();
                responder.respond(response);
            });
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            use tauri::Manager;
            if !setup_startup(app.handle(), &support::startup_log::LOGGER,
                tauri_plugin_log::TargetKind::LogDir { file_name: Some("story-studio".into()) },
                &NativeStartupWriter(app.handle()))? {
                return Ok(());
            }
            commands::lunii_device::watch(app.handle().clone());
            #[cfg(target_os = "linux")]
            {
                let default_icon = app.default_window_icon().cloned();
                if let Some(window) = app.get_webview_window("main") {
                    if let Some(icon) = default_icon {
                        if let Err(error) = window.set_icon(icon) {
                            log::warn!(
                                target: "boot",
                                "Linux window icon could not be applied: {error}"
                            );
                        }
                    }
                    let pinch_window = window.clone();
                    if let Err(error) = window.with_webview(move |platform_webview| {
                        if let Err(error) = support::linux_webview_gestures::install_pinch_bridge(
                            pinch_window,
                            platform_webview,
                        ) {
                            log::warn!(
                                target: "viewport",
                                "Linux pinch bridge could not be installed: {error}"
                            );
                        }
                    }) {
                        log::warn!(
                            target: "viewport",
                            "Linux WebView is unavailable for pinch handling: {error}"
                        );
                    }
                    match window.url() {
                        Ok(trusted_url) => {
                            if let Err(error) = window.with_webview(move |platform_webview| {
                                support::linux_microphone_permission::install(
                                    platform_webview,
                                    trusted_url,
                                );
                            }) {
                                log::warn!(
                                    target: "recording",
                                    "Linux microphone permission handler could not be installed: {error}"
                                );
                            }
                        }
                        Err(error) => log::warn!(
                            target: "recording",
                            "Linux application URL is unavailable for microphone permission: {error}"
                        ),
                    }
                }
            }
            log::warn!(target: "boot",
                "Story Studio {} started (os = {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::catalogue::catalogue_start_scan,
            commands::catalogue::catalogue_cancel_operation,
            commands::catalogue::catalogue_get_operation,
            commands::catalogue::catalogue_list_operations,
            commands::catalogue::catalogue_explain_path,
            commands::catalogue::catalogue_reveal_exemplar,
            commands::catalogue::catalogue_reveal_path,
            commands::catalogue::catalogue_get_thumbnail,
            commands::catalogue_open::catalogue_open_consultation,
            commands::catalogue_open::catalogue_prepare_editor_entry,
            commands::catalogue_backup::catalogue_plan_export,
            commands::catalogue_backup::catalogue_start_export,
            commands::catalogue_backup::catalogue_preview_import,
            commands::catalogue_backup::catalogue_apply_import,
            commands::catalogue_backup::catalogue_get_import_preview,
            commands::catalogue_assembly::catalogue_prepare_assembly,
            commands::catalogue_assembly::catalogue_transfer_assembly,
            commands::catalogue_assembly::catalogue_release_assembly,
            commands::catalogue_assembly::catalogue_retain_assembly_task,
            commands::catalogue_assembly::catalogue_finish_assembly_task,
            commands::catalogue_open::catalogue_release_editor_extractions,
            commands::catalogue_open::catalogue_record_generation,
            commands::catalogue_open::catalogue_read_consultation_asset,
            commands::catalogue_open::catalogue_close_consultation,
            commands::catalogue_files::catalogue_plan_file_operation,
            commands::catalogue_files::catalogue_release_file_plan,
            commands::catalogue_files::catalogue_start_file_operation,
            commands::catalogue_files::catalogue_prepare_permanent_delete,
            commands::catalogue_files::catalogue_confirm_file_removal,
            commands::catalogue_files::catalogue_identical_copies,
            commands::catalogue_files::catalogue_cancel_identical_copies,
            commands::catalogue_files::catalogue_find_duplicates,
            commands::catalogue_files::catalogue_get_duplicate_results,
            commands::catalogue_files::catalogue_release_duplicate_results,
            commands::catalogue_files::catalogue_prepare_checker_entry,
            commands::catalogue_files::catalogue_release_checker_entry,
            commands::catalogue_files::catalogue_project_access,
            commands::catalogue_data::catalogue_get_card,
            commands::catalogue_lunii::catalogue_lunii_open,
            commands::catalogue_lunii::catalogue_lunii_permission,
            commands::catalogue_lunii::catalogue_lunii_set_permission,
            commands::catalogue_data::catalogue_list_tags,
            commands::catalogue_data::catalogue_list_unreferenced,
            commands::catalogue_data::catalogue_preview_forget,
            commands::catalogue_data::catalogue_preview_remove_cards,
            commands::catalogue_data::catalogue_remove_cards,
            commands::catalogue_data::catalogue_remove_missing_exemplar,
            commands::catalogue_data::catalogue_last_undo,
            commands::catalogue_data::catalogue_mutate,
            commands::catalogue_data::catalogue_stage_cover,
            commands::catalogue_data::catalogue_discard_covers,
            commands::catalogue::catalogue_list_entries,
            commands::catalogue::catalogue_resolve_identity_convergence,
            commands::lunii_device::lunii_device_list,
            commands::lunii_device::lunii_device_open,
            commands::lunii_device::lunii_device_inspect,
            commands::lunii_device::lunii_device_send,
            commands::lunii_device::lunii_device_cancel,
            commands::lunii_device::lunii_device_remove,
            commands::lunii_device::lunii_device_reorder,
            commands::lunii_device::lunii_device_hide,
            commands::lunii_device::lunii_device_repair,
            commands::lunii_device::lunii_device_restore,
            commands::lunii_device::lunii_device_orphan,
            commands::lunii_device::lunii_device_orphans_restore,
            commands::lunii_device::lunii_device_name_story,
            commands::lunii_device::lunii_device_rename,
            commands::lunii_device::lunii_device_repatriate,
            commands::lunii_device::lunii_device_eject,
            commands::catalogue::catalogue_list_sources,
            commands::catalogue::catalogue_add_source,
            commands::catalogue::catalogue_remove_source,
            commands::catalogue::catalogue_preview_remove_source,
            commands::catalogue::catalogue_get_source_exclusions,
            commands::catalogue::catalogue_begin_write,
            commands::catalogue::catalogue_finish_write,
            commands::catalogue::catalogue_get_watch_status,
            commands::generation::generate_pack,
            commands::generation::cancel_generate_pack,
            commands::generation::project_pack_for_simulation,
            commands::generation::copy_project_to_graph,
            commands::generation::verify_project_graph_copy,
            commands::files::save_recording,
            commands::files::path_kinds,
            commands::files::resolve_project_folder,
            commands::files::rename_project_folder,
            commands::files::copy_project_media,
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
            commands::files::discard_audio_preview,
            commands::files::restore_audio_original,
            commands::files::validate_lunii_zip_cmd,
            commands::pack::acquire_advanced_pack_document,
            commands::project_codec::validate_advanced_payload,
            commands::project_codec::ipc::read_advanced_graph_view,
            commands::advanced_view::read_advanced_view_state,
            commands::advanced_view::write_advanced_view_state,
            commands::advanced_view::rename_advanced_view_state,
            commands::project_codec::create_advanced_document,
            commands::project_codec::assess_advanced_payload_readiness,
            commands::project_codec::ipc::apply_advanced_gesture,
            commands::advanced_export::export_advanced_pack,
            commands::files::scan_unused_project_files,
            commands::files::delete_unused_project_files,
            commands::files::scan_import_folder,
            commands::files::list_folder_media_files,
            commands::pack::load_pack_zip,
            commands::pack::get_pack_asset,
            commands::pack::unpack_zip_to_entries,
            commands::pack::convert_folder_pack_to_zip,
            commands::pack::convert_folder_pack_to_named_zip,
            commands::pack::inspect_pack_archive,
            commands::pack::extract_pack_bundle_child,
            commands::pack::check_pack_editability,
            commands::pack::classify_pack_editability,
            commands::pack::check_pack_identity,
            commands::pack::read_pack_identity_lock,
            commands::pack::analyze_community_pack,
            commands::pack::create_fixed_community_pack,
            commands::xtts::xtts_get_status,
            commands::xtts::xtts_generate_audio,
            commands::piper::piper_list_voices,
            commands::piper::piper_ensure_voice,
            commands::piper::piper_generate_audio,
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
            commands::youtube::fetch_youtube_list,
            commands::youtube::fetch_youtube_audio_languages,
            commands::youtube::download_youtube_audio,
            commands::youtube::update_ytdlp,
            commands::session::create_session_workspace,
            commands::session::cleanup_session_workspace,
            commands::session::list_session_recoveries,
            commands::diagnostics::startup_blocked,
            commands::diagnostics::exit_secondary_instance,
            commands::diagnostics::set_log_level,
            commands::diagnostics::get_current_log_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
