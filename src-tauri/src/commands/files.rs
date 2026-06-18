use crate::services::project_files;
use crate::support::lunii_zip_validator::{validate_lunii_zip, LuniiZipValidationReport};

#[tauri::command]
pub fn save_recording(
    save_path: Option<String>,
    workspace_dir: Option<String>,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    log::info!(target: "files",
        "save_recording: name='{}' size={} bytes", filename, data.len());
    project_files::save_recording(
        save_path.as_deref(),
        workspace_dir.as_deref(),
        &filename,
        &data,
    )
    .inspect_err(|err| log::error!(target: "files", "save_recording failed: {}", err))
}

#[tauri::command]
pub fn delete_file(path: String, save_path: Option<String>) -> Result<(), String> {
    log::info!(target: "files", "delete_file: '{}'", path);
    project_files::delete_file(&path, save_path.as_deref()).inspect_err(
        |err| log::error!(target: "files", "delete_file failed for '{}': {}", path, err),
    )
}

#[tauri::command]
pub fn delete_workspace_media_file(path: String, workspace_dir: String) -> Result<(), String> {
    log::info!(target: "files", "delete_workspace_media_file: '{}'", path);
    project_files::delete_workspace_media_file(&path, &workspace_dir)
        .inspect_err(|err| log::error!(target: "files", "delete_workspace_media_file failed for '{}': {}", path, err))
}

#[tauri::command]
pub async fn concat_audio_files(
    save_path: String,
    input_paths: Vec<String>,
    output_file_name: String,
    silence_between_sec: f64,
    workspace_dir: Option<String>,
) -> Result<String, String> {
    log::info!(target: "files",
        "concat_audio_files: inputs={} output='{}' silence={}s",
        input_paths.len(), output_file_name, silence_between_sec);
    tauri::async_runtime::spawn_blocking(move || {
        project_files::concat_audio_files(
            &save_path,
            &input_paths,
            &output_file_name,
            silence_between_sec,
            workspace_dir.as_deref(),
        )
        .inspect_err(|err| log::error!(target: "files", "concat_audio_files failed: {}", err))
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub async fn split_audio_segments(
    save_path: String,
    input_path: String,
    segments: Vec<project_files::AudioSplitSegment>,
    workspace_dir: Option<String>,
) -> Result<project_files::AudioSplitResult, String> {
    log::info!(target: "files",
        "split_audio_segments: input='{}' segments={}",
        input_path, segments.len());
    let input_for_log = input_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::split_audio_segments(
            &save_path,
            &input_path,
            &segments,
            workspace_dir.as_deref(),
        )
        .inspect_err(|err| {
            log::error!(target: "files",
                "split_audio_segments failed for '{}': {}", input_for_log, err)
        })
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub fn extract_audio_embedded_image(audio_path: String) -> Result<Option<String>, String> {
    project_files::extract_audio_embedded_image(&audio_path)
}

#[tauri::command]
pub fn scan_unused_project_files(
    save_path: String,
    used_paths: Vec<String>,
) -> Result<project_files::CleanupScanResult, String> {
    log::info!(target: "files",
        "scan_unused_project_files: savePath='{}' usedCount={}", save_path, used_paths.len());
    project_files::scan_unused_files(&save_path, &used_paths).inspect_err(
        |err| log::error!(target: "files", "scan_unused_project_files failed: {}", err),
    )
}

#[tauri::command]
pub fn delete_unused_project_files(paths: Vec<String>, save_path: String) -> Result<usize, String> {
    log::info!(target: "files",
        "delete_unused_project_files: {} file(s) under '{}'", paths.len(), save_path);
    project_files::delete_unused_files(&paths, &save_path).inspect_err(
        |err| log::error!(target: "files", "delete_unused_project_files failed: {}", err),
    )
}

#[tauri::command]
pub async fn trim_audio(
    input_path: String,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::TrimAudioResult, String> {
    log::info!(target: "files",
        "trim_audio: input='{}' start={}s end={}s", input_path, start_sec, end_sec);
    tauri::async_runtime::spawn_blocking(move || {
        project_files::trim_audio(
            &input_path,
            start_sec,
            end_sec,
            save_path.as_deref(),
            workspace_dir.as_deref(),
        )
        .inspect_err(
            |err| log::error!(target: "files", "trim_audio failed for '{}': {}", input_path, err),
        )
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub async fn cut_audio(
    input_path: String,
    cut_start: f64,
    cut_end: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::TrimAudioResult, String> {
    log::info!(target: "files",
        "cut_audio: input='{}' cut={}..{}s", input_path, cut_start, cut_end);
    tauri::async_runtime::spawn_blocking(move || {
        project_files::cut_audio(
            &input_path,
            cut_start,
            cut_end,
            save_path.as_deref(),
            workspace_dir.as_deref(),
        )
        .inspect_err(
            |err| log::error!(target: "files", "cut_audio failed for '{}': {}", input_path, err),
        )
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub async fn audio_edit_info(
    input_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::AudioEditInfo, String> {
    log::info!(target: "files", "audio_edit_info: '{}'", input_path);
    let input_for_log = input_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::audio_edit_info(&input_path, save_path.as_deref(), workspace_dir.as_deref())
            .inspect_err(|err| log::error!(target: "files", "audio_edit_info failed for '{}': {}", input_for_log, err))
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_audio_edit(
    input_path: String,
    mode: String,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<String>,
    workspace_dir: Option<String>,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
) -> Result<String, String> {
    log::info!(target: "files",
        "preview_audio_edit: mode={} input='{}' range={}..{}s fades={}/{}/{}",
        mode, input_path, start_sec, end_sec, fade_in_sec, fade_out_sec, cut_fade_sec);
    let input_for_log = input_path.clone();
    let mode_for_log = mode.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::preview_audio_edit(project_files::AudioEditRequest {
            input_path: &input_path,
            save_path: save_path.as_deref(),
            workspace_dir: workspace_dir.as_deref(),
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
            "preview_audio_edit failed (mode={}) for '{}': {}", mode_for_log, input_for_log, err)
        })
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
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
) -> Result<project_files::TrimAudioResult, String> {
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
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub async fn commit_audio_preview(
    input_path: String,
    preview_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::TrimAudioResult, String> {
    log::info!(target: "files",
        "commit_audio_preview: input='{}' preview='{}'", input_path, preview_path);
    let input_for_log = input_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::commit_audio_preview(
            &input_path,
            &preview_path,
            save_path.as_deref(),
            workspace_dir.as_deref(),
        )
        .inspect_err(|err| {
            log::error!(target: "files",
                "commit_audio_preview failed for '{}': {}", input_for_log, err)
        })
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
}

#[tauri::command]
pub async fn restore_audio_original(
    input_path: String,
    save_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<project_files::TrimAudioResult, String> {
    log::info!(target: "files", "restore_audio_original: '{}'", input_path);
    tauri::async_runtime::spawn_blocking(move || {
        project_files::restore_audio_original(&input_path, save_path.as_deref(), workspace_dir.as_deref())
            .inspect_err(|err| log::error!(target: "files", "restore_audio_original failed for '{}': {}", input_path, err))
    })
    .await
    .map_err(|e| format!("Tâche abandonnée : {}", e))?
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
    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| format!("Impossible de lire {} : {}", dir.display(), e))?;

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
                path: Some(path.to_string_lossy().to_string()),
                children: Vec::new(),
            });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn scan_import_folder(folder_path: String) -> Result<ScanEntry, String> {
    log::info!(target: "files", "scan_import_folder: '{}'", folder_path);
    let root = std::path::PathBuf::from(&folder_path);
    if !root.is_dir() {
        log::warn!(target: "files", "scan_import_folder: missing path '{}'", folder_path);
        return Err(format!("Dossier introuvable : {}", folder_path));
    }
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Dossier importé")
        .to_string();
    let children = scan_dir_recursive(&root)
        .inspect_err(|err| log::error!(target: "files", "scan_import_folder failed for '{}': {}", folder_path, err))?;
    Ok(ScanEntry {
        entry_type: "folder",
        name,
        path: None,
        children,
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
                out.push(path.to_string_lossy().to_string());
            }
        }
    }
}

#[tauri::command]
pub fn list_folder_media_files(folder_path: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&folder_path);
    if !root.is_dir() {
        return Err(format!("Dossier introuvable : {}", folder_path));
    }
    let mut files = Vec::new();
    collect_media_files_recursive(&root, &mut files);
    Ok(files)
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
