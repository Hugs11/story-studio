use crate::services::project_files;
use crate::support::lunii_zip_validator::{validate_lunii_zip, LuniiZipValidationReport};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

const AUDIO_ASSET_EXTENSIONS: &[&str] = &["mp3", "ogg", "wav", "flac", "m4a", "webm"];

fn validate_audio_asset_path(path: &Path) -> Result<std::fs::Metadata, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Le fichier audio doit avoir une extension prise en charge.".to_string())?;
    if !AUDIO_ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Extension audio non prise en charge pour la lecture locale : .{extension}"
        ));
    }

    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Fichier audio local inaccessible : {error}"))?;
    if !metadata.is_file() {
        return Err("Le média local doit être un fichier régulier.".to_string());
    }
    Ok(metadata)
}

#[tauri::command]
pub fn allow_audio_asset(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let asset_path = PathBuf::from(path);
    let metadata = validate_audio_asset_path(&asset_path)?;
    app.asset_protocol_scope()
        .allow_file(&asset_path)
        .map_err(|error| format!("Impossible d’autoriser la lecture du média local : {error}"))?;

    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    Ok(format!("{}:{modified_nanos}", metadata.len()))
}

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
pub fn delete_workspace_media_file(
    path: String,
    workspace_dir: String,
    preserve_paths: Option<Vec<String>>,
) -> Result<(), String> {
    log::info!(target: "files", "delete_workspace_media_file: '{}'", path);
    project_files::delete_workspace_media_file(
        &path,
        &workspace_dir,
        preserve_paths.as_deref().unwrap_or(&[]),
    )
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
pub async fn discard_audio_preview(preview_path: String) -> Result<(), String> {
    let preview_for_log = preview_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        project_files::discard_audio_preview(&preview_path).inspect_err(|error| {
            log::warn!(
                target: "audio_preview",
                "discard rejected for '{}': {}",
                preview_for_log,
                error
            );
        })
    })
    .await
    .map_err(|error| format!("Tâche abandonnée : {}", error))?
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

#[cfg(test)]
mod local_audio_asset_tests {
    use super::validate_audio_asset_path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "story-studio-audio-asset-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn accepts_regular_audio_files_with_spaces_accents_and_case() {
        let dir = test_dir();
        std::fs::create_dir_all(&dir).expect("test directory should be created");
        let path = dir.join("Été Sonore.FLAC");
        std::fs::write(&path, b"fLaC").expect("test audio should be created");

        let metadata = validate_audio_asset_path(&path).expect("FLAC path should be accepted");

        assert_eq!(metadata.len(), 4);
        std::fs::remove_dir_all(dir).expect("test directory should be removed");
    }

    #[test]
    fn rejects_non_audio_files_and_directories() {
        let dir = test_dir();
        std::fs::create_dir_all(&dir).expect("test directory should be created");
        let image_path = dir.join("cover.png");
        std::fs::write(&image_path, b"png").expect("test image should be created");

        assert!(validate_audio_asset_path(&image_path)
            .expect_err("image path should be rejected")
            .contains("Extension audio non prise en charge"));
        assert!(validate_audio_asset_path(&dir)
            .expect_err("directory should be rejected")
            .contains("extension prise en charge"));

        std::fs::remove_dir_all(dir).expect("test directory should be removed");
    }
}
