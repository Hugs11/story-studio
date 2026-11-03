use crate::services::project_files;
use crate::support::lunii_zip_validator::{validate_lunii_zip, LuniiZipValidationReport};
use crate::support::user_message;
use crate::support::user_message::codes;
use crate::support::user_message::UserMessage;

#[tauri::command]
pub fn save_recording(
    workspace_dir: Option<String>,
    filename: String,
    data: Vec<u8>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<String, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files",
        "save_recording: name='{}' size={} bytes", filename, data.len());
        project_files::save_recording(
            workspace_dir.as_deref(),
            &filename,
            &data,
            project_destination.as_ref(),
        )
        .inspect_err(|err| log::error!(target: "files", "save_recording failed: {}", err))
    })
}

#[tauri::command]
pub fn delete_file(path: String, save_path: Option<String>) -> Result<(), UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files", "delete_file: '{}'", path);
        project_files::delete_file(&path, save_path.as_deref()).inspect_err(
            |err| log::error!(target: "files", "delete_file failed for '{}': {}", path, err),
        )
    })
}

#[tauri::command]
pub fn delete_workspace_media_file(
    path: String,
    workspace_dir: String,
    preserve_paths: Option<Vec<String>>,
    cascade: Option<bool>,
) -> Result<(), UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files", "delete_workspace_media_file: '{}'", path);
        // La médiathèque conserve sa cascade historique ; un producteur qui
        // abandonne sa propre sortie ne possède que ce fichier précis.
        let result = if cascade == Some(false) {
            project_files::delete_workspace_media_file_only(&path, &workspace_dir)
        } else {
            project_files::delete_workspace_media_file(
                &path,
                &workspace_dir,
                preserve_paths.as_deref().unwrap_or(&[]),
            )
        };
        result
        .inspect_err(|err| log::error!(target: "files", "delete_workspace_media_file failed for '{}': {}", path, err))
    })
}

#[tauri::command]
pub async fn concat_audio_files(
    input_paths: Vec<String>,
    output_file_name: String,
    silence_between_sec: f64,
    workspace_dir: Option<String>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "files",
        "concat_audio_files: inputs={} output='{}' silence={}s",
        input_paths.len(), output_file_name, silence_between_sec);
        tauri::async_runtime::spawn_blocking(move || {
            project_files::concat_audio_files(
                &input_paths,
                &output_file_name,
                silence_between_sec,
                workspace_dir.as_deref(),
                project_destination.as_ref(),
            )
            .inspect_err(|err| log::error!(target: "files", "concat_audio_files failed: {}", err))
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn split_audio_segments(
    input_path: String,
    segments: Vec<project_files::AudioSplitSegment>,
    workspace_dir: Option<String>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<project_files::AudioSplitResult, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "files",
        "split_audio_segments: input='{}' segments={}",
        input_path, segments.len());
        let input_for_log = input_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            project_files::split_audio_segments(
                &input_path,
                &segments,
                workspace_dir.as_deref(),
                project_destination.as_ref(),
            )
            .inspect_err(|err| {
                log::error!(target: "files",
                "split_audio_segments failed for '{}': {}", input_for_log, err)
            })
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub fn extract_audio_embedded_image(
    app: tauri::AppHandle,
    audio_path: String,
) -> Result<Option<String>, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let output_dir =
            crate::support::temp::app_cache_subdir(&app, crate::support::temp::TEMP_IMAGES_DIR)?;
        project_files::extract_audio_embedded_image(&audio_path, &output_dir)
    })
}

#[tauri::command]
pub fn scan_unused_project_files(
    save_path: String,
    used_paths: Vec<String>,
) -> Result<project_files::CleanupScanResult, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files",
        "scan_unused_project_files: savePath='{}' usedCount={}", save_path, used_paths.len());
        project_files::scan_unused_files(&save_path, &used_paths).inspect_err(
            |err| log::error!(target: "files", "scan_unused_project_files failed: {}", err),
        )
    })
}

#[tauri::command]
pub fn delete_unused_project_files(
    paths: Vec<String>,
    save_path: String,
) -> Result<usize, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files",
        "delete_unused_project_files: {} file(s) under '{}'", paths.len(), save_path);
        project_files::delete_unused_files(&paths, &save_path).inspect_err(
            |err| log::error!(target: "files", "delete_unused_project_files failed: {}", err),
        )
    })
}

#[tauri::command]
pub async fn trim_audio(
    input_path: String,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<project_files::TrimAudioResult, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "files",
        "trim_audio: input='{}' start={}s end={}s", input_path, start_sec, end_sec);
        tauri::async_runtime::spawn_blocking(move || {
            project_files::trim_audio(
            &input_path,
            start_sec,
            end_sec,
            save_path.as_deref(),
            workspace_dir.as_deref(),
            project_destination.as_ref(),
        )
        .inspect_err(
            |err| log::error!(target: "files", "trim_audio failed for '{}': {}", input_path, err),
        )
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn cut_audio(
    input_path: String,
    cut_start: f64,
    cut_end: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<project_files::TrimAudioResult, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "files",
        "cut_audio: input='{}' cut={}..{}s", input_path, cut_start, cut_end);
        tauri::async_runtime::spawn_blocking(move || {
            project_files::cut_audio(
            &input_path,
            cut_start,
            cut_end,
            save_path.as_deref(),
            workspace_dir.as_deref(),
            project_destination.as_ref(),
        )
        .inspect_err(
            |err| log::error!(target: "files", "cut_audio failed for '{}': {}", input_path, err),
        )
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn audio_edit_info(
    input_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::AudioEditInfo, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "files", "audio_edit_info: '{}'", input_path);
    let input_for_log = input_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::audio_edit_info(&input_path, save_path.as_deref(), workspace_dir.as_deref())
            .inspect_err(|err| log::error!(target: "files", "audio_edit_info failed for '{}': {}", input_for_log, err))
    })
    .await
    .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(
                codes::FILES_TASK_ABANDONED,
            )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
            })?
}.await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_audio_edit(
    app: tauri::AppHandle,
    input_path: String,
    mode: String,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
        let preview_root =
            crate::support::temp::app_cache_subdir(&app, crate::support::temp::AUDIO_PREVIEWS_DIR)?;
        log::info!(target: "files",
        "preview_audio_edit: mode={} input='{}' range={}..{}s fades={}/{}/{}",
        mode, input_path, start_sec, end_sec, fade_in_sec, fade_out_sec, cut_fade_sec);
        let input_for_log = input_path.clone();
        let mode_for_log = mode.clone();
        tauri::async_runtime::spawn_blocking(move || {
            project_files::preview_audio_edit(
                project_files::AudioEditRequest {
                    input_path: &input_path,
                    save_path: save_path.as_deref(),
                    workspace_dir: workspace_dir.as_deref(),
                    project_destination: project_destination.as_ref(),
                    params: project_files::AudioEditParams {
                        mode: &mode,
                        start_sec,
                        end_sec,
                        fade_in_sec,
                        fade_out_sec,
                        cut_fade_sec,
                    },
                },
                &preview_root,
            )
            .inspect_err(|err| {
                log::error!(target: "files",
            "preview_audio_edit failed (mode={}) for '{}': {}", mode_for_log, input_for_log, err)
            })
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_audio_edit(
    input_path: String,
    mode: String,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<project_files::TrimAudioResult, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "files",
        "apply_audio_edit: mode={} input='{}' range={}..{}s fades={}/{}/{}",
        mode, input_path, start_sec, end_sec, fade_in_sec, fade_out_sec, cut_fade_sec);
        let input_for_log = input_path.clone();
        let mode_for_log = mode.clone();
        tauri::async_runtime::spawn_blocking(move || {
            project_files::apply_audio_edit(project_files::AudioEditRequest {
                input_path: &input_path,
                save_path: save_path.as_deref(),
                workspace_dir: workspace_dir.as_deref(),
                project_destination: project_destination.as_ref(),
                params: project_files::AudioEditParams {
                    mode: &mode,
                    start_sec,
                    end_sec,
                    fade_in_sec,
                    fade_out_sec,
                    cut_fade_sec,
                },
            })
            .inspect_err(|err| {
                log::error!(target: "files",
            "apply_audio_edit failed (mode={}) for '{}': {}", mode_for_log, input_for_log, err)
            })
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn commit_audio_preview(
    app: tauri::AppHandle,
    input_path: String,
    preview_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    project_destination: Option<project_files::ProjectMediaDestination>,
) -> Result<project_files::TrimAudioResult, UserMessage> {
    let result: Result<_, String> = async {
        let preview_root =
            crate::support::temp::app_cache_subdir(&app, crate::support::temp::AUDIO_PREVIEWS_DIR)?;
        log::info!(target: "files",
        "commit_audio_preview: input='{}' preview='{}'", input_path, preview_path);
        let input_for_log = input_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            project_files::commit_audio_preview(
                &input_path,
                &preview_path,
                save_path.as_deref(),
                workspace_dir.as_deref(),
                &preview_root,
                project_destination.as_ref(),
            )
            .inspect_err(|err| {
                log::error!(target: "files",
                "commit_audio_preview failed for '{}': {}", input_for_log, err)
            })
        })
        .await
        .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn discard_audio_preview(
    app: tauri::AppHandle,
    preview_path: String,
) -> Result<(), UserMessage> {
    let result: Result<_, String> = async {
        let preview_root =
            crate::support::temp::app_cache_subdir(&app, crate::support::temp::AUDIO_PREVIEWS_DIR)?;
        let preview_for_log = preview_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            project_files::discard_audio_preview(&preview_path, &preview_root).inspect_err(
                |error| {
                    log::warn!(
                        target: "audio_preview",
                        "discard rejected for '{}': {}",
                        preview_for_log,
                        error
                    );
                },
            )
        })
        .await
        .map_err(|error| {
            let _msg_error = (error).to_string();
            UserMessage::new(codes::FILES_TASK_ABANDONED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn restore_audio_original(
    input_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::TrimAudioResult, UserMessage> {
    let result: Result<_, String> = async {
    log::info!(target: "files", "restore_audio_original: '{}'", input_path);
    tauri::async_runtime::spawn_blocking(move || {
        project_files::restore_audio_original(&input_path, save_path.as_deref(), workspace_dir.as_deref())
            .inspect_err(|err| log::error!(target: "files", "restore_audio_original failed for '{}': {}", input_path, err))
    })
    .await
    .map_err(|e| {
            let _msg_error = (e).to_string();
            UserMessage::new(
                codes::FILES_TASK_ABANDONED,
            )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Tâche abandonnée : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
            })?
}.await;
    result.map_err(UserMessage::from)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ScanEntry>,
}

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "ogg", "wav", "m4a", "webm", "flac"];
const ARCHIVE_EXTENSIONS: &[&str] = &["zip", "7z"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];

fn scan_dir_recursive(dir: &std::path::Path) -> Result<Vec<ScanEntry>, String> {
    let read_dir = std::fs::read_dir(dir).map_err(|e| {
        let _msg_dir = (dir.display()).to_string();
        let _msg_error = (e).to_string();
        UserMessage::new(codes::FILES_PATH_READ_FAILED)
            .param("dir", user_message::transport_param(_msg_dir.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lire {_msg_dir} : {_msg_error}",
                _msg_dir = user_message::transport_detail(&_msg_dir),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let mut raw: Vec<(String, std::path::PathBuf)> = read_dir
        .filter_map(|e| e.ok())
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect();
    raw.sort_by_key(|a| a.0.to_lowercase());

    let mut entries = Vec::new();
    for (name, path) in raw {
        if path.is_dir() {
            let children = scan_dir_recursive(&path)?;
            if !children.is_empty() {
                entries.push(ScanEntry {
                    entry_type: "folder",
                    name,
                    path: None,
                    children,
                });
            }
        } else {
            // Ignorer les backups visibles d'édition audio (`{stem}.original{-N}.{ext}`)
            if project_files::is_original_backup(&name) {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let entry_type = if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                "audio"
            } else if ARCHIVE_EXTENSIONS.contains(&ext.as_str()) {
                "zip"
            } else {
                continue;
            };
            entries.push(ScanEntry {
                entry_type,
                name,
                path: Some(crate::support::paths::path_for_frontend(&path)),
                children: Vec::new(),
            });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn scan_import_folder(
    folder_path: String,
    proposed_folder_name: Option<String>,
) -> Result<ScanEntry, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        log::info!(target: "files", "scan_import_folder: '{}'", folder_path);
        let root = std::path::PathBuf::from(&folder_path);
        if !root.is_dir() {
            log::warn!(target: "files", "scan_import_folder: missing path '{}'", folder_path);
            return Err({
                let _msg_folder_path = (folder_path).to_string();
                UserMessage::new(codes::FILES_FOLDER_NOT_FOUND)
                    .param(
                        "folderPath",
                        user_message::transport_param(_msg_folder_path.clone()),
                    )
                    .with_detail(format!(
                        "Dossier introuvable : {_msg_folder_path}",
                        _msg_folder_path = user_message::transport_detail(&_msg_folder_path)
                    ))
                    .into_transport()
            });
        }
        let name = proposed_import_folder_name(&root, proposed_folder_name.as_deref());
        let children = scan_dir_recursive(&root)
        .inspect_err(|err| log::error!(target: "files", "scan_import_folder failed for '{}': {}", folder_path, err))?;
        Ok(ScanEntry {
            entry_type: "folder",
            name,
            path: None,
            children,
        })
    })
}

fn collect_media_files_recursive(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<std::path::PathBuf> =
        read_dir.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    for path in entries {
        if path.is_dir() {
            collect_media_files_recursive(&path, out);
        } else {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Ignorer les backups visibles d'édition audio (`{stem}.original{-N}.{ext}`)
            if project_files::is_original_backup(&name) {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if AUDIO_EXTENSIONS.contains(&ext.as_str())
                || IMAGE_EXTENSIONS.contains(&ext.as_str())
                || ARCHIVE_EXTENSIONS.contains(&ext.as_str())
            {
                out.push(crate::support::paths::path_for_frontend(&path));
            }
        }
    }
}

#[tauri::command]
pub fn list_folder_media_files(folder_path: String) -> Result<Vec<String>, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        let root = std::path::PathBuf::from(&folder_path);
        if !root.is_dir() {
            return Err({
                let _msg_folder_path = (folder_path).to_string();
                UserMessage::new(codes::FILES_FOLDER_NOT_FOUND)
                    .param(
                        "folderPath",
                        user_message::transport_param(_msg_folder_path.clone()),
                    )
                    .with_detail(format!(
                        "Dossier introuvable : {_msg_folder_path}",
                        _msg_folder_path = user_message::transport_detail(&_msg_folder_path)
                    ))
                    .into_transport()
            });
        }
        let mut files = Vec::new();
        collect_media_files_recursive(&root, &mut files);
        Ok(files)
    })
}

#[tauri::command]
pub fn validate_lunii_zip_cmd(zip_path: String) -> LuniiZipValidationReport {
    log::info!(target: "lunii_validator", "validate_lunii_zip_cmd: '{}'", zip_path);
    match project_files::validate_existing_pack_path(&zip_path) {
        Ok(canonical) => validate_lunii_zip(&canonical.to_string_lossy()),
        Err(e) => {
            log::warn!(target: "lunii_validator", "validate path rejected '{}': {}", zip_path, e);
            LuniiZipValidationReport {
                zip_path,
                valid: false,
                issues: vec![crate::support::lunii_zip_validator::ValidationIssue {
                    severity: "error".to_string(),
                    code: "INVALID_PATH".to_string(),
                    message: e,
                }],
            }
        }
    }
}

#[tauri::command]
pub fn resolve_project_folder(
    root: String,
    folder: String,
    work_id: String,
    create: bool,
) -> Result<String, UserMessage> {
    let result: Result<_, String> =
        project_files::resolve_project_folder(&root, &folder, &work_id, create);
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub fn rename_project_folder(
    root: String,
    old: String,
    new: String,
    work_id: String,
) -> Result<Vec<project_files::ProjectFolderMove>, UserMessage> {
    let result: Result<_, String> =
        project_files::rename_project_folder(&root, &old, &new, &work_id);
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub fn copy_project_media(
    source_path: String,
    root: String,
    category: String,
    project_destination: Option<project_files::ProjectMediaDestination>,
    session_root: Option<String>,
) -> Result<project_files::ProjectMediaCopy, UserMessage> {
    crate::support::user_message::user_message_result(|| {
        project_files::copy_project_media(
            &source_path,
            &root,
            &category,
            project_destination.as_ref(),
            session_root.as_deref(),
        )
    })
}

/// Type réel de chaque chemin (suit les liens symboliques), pour trier un dépôt
/// par ce que le système de fichiers dit et non par l'extension : un dossier
/// nommé `x.mp3` reste un dossier. Un chemin illisible vaut « autre ».
#[tauri::command]
pub async fn path_kinds(paths: Vec<String>) -> Result<Vec<&'static str>, UserMessage> {
    // Un `stat` sur un montage réseau mort bloquerait le fil principal.
    tauri::async_runtime::spawn_blocking(move || kinds_of(&paths))
        .await
        .map_err(|e| UserMessage::from(e.to_string()))
}

fn kinds_of(paths: &[String]) -> Vec<&'static str> {
    paths
        .iter()
        .map(|path| path_kind(std::path::Path::new(path)))
        .collect()
}

fn path_kind(path: &std::path::Path) -> &'static str {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => "folder",
        Ok(meta) if meta.is_file() => "file",
        _ => "other",
    }
}

#[cfg(test)]
mod path_kind_tests {
    #[test]
    fn path_kind_follows_the_filesystem_not_the_extension() {
        let dir = std::env::temp_dir().join(format!("ss_path_kind_{}", std::process::id()));
        let folder = dir.join("Histoire.mp3");
        std::fs::create_dir_all(&folder).expect("create folder named like audio");
        let file = dir.join("Vrai.zip");
        std::fs::write(&file, b"x").expect("write file");
        let kinds = super::kinds_of(&[
            folder.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            dir.join("absent").to_string_lossy().into_owned(),
        ]);
        assert_eq!(kinds, vec!["folder", "file", "other"]);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}

// Nom proposé uniquement à la racine sans nom ; les noms des fichiers restent auteur.
fn proposed_import_folder_name(root: &std::path::Path, proposed: Option<&str>) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(proposed.unwrap_or("Dossier importé"))
        .to_string()
}

#[cfg(test)]
mod proposed_names_tests {
    #[test]
    fn proposed_folder_names_preserve_authored_names_and_default_french() {
        let unnamed = std::path::Path::new(std::path::MAIN_SEPARATOR_STR);
        assert_eq!(
            super::proposed_import_folder_name(unnamed, None),
            "Dossier importé"
        );
        assert_eq!(
            super::proposed_import_folder_name(unnamed, Some("Imported folder")),
            "Imported folder"
        );
        assert_eq!(
            super::proposed_import_folder_name(unnamed, Some("Cartella importata")),
            "Cartella importata"
        );
        assert_eq!(
            super::proposed_import_folder_name(
                std::path::Path::new("Auteur"),
                Some("Imported folder")
            ),
            "Auteur"
        );
    }
}
