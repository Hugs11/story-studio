use crate::services::comfyui::{
    delete_custom_workflow_sync, download_output_sync, ensure_comfyui_sync, import_workflow_sync,
    list_workflows_sync, poll_job_sync, resolve_paths, submit_job_sync, watch_progress_sync,
    ComfyProgressEvent, ComfyUiSettings, SdGenerateRequest, SdPollResult, WorkflowManifest,
};
use tauri::Emitter;

#[tauri::command]
pub async fn comfyui_check(settings: ComfyUiSettings) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_comfyui_sync(&settings)
            .map(|_| true)
            .inspect_err(|err| log::warn!(target: "comfyui", "comfyui_check failed: {}", err))
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_list_workflows(
    app: tauri::AppHandle,
) -> Result<Vec<WorkflowManifest>, String> {
    let (resource_dir, app_data_dir) = resolve_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_workflows_sync(resource_dir, app_data_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_import_workflow(
    app: tauri::AppHandle,
    api_json_path: String,
    config_json_path: String,
) -> Result<WorkflowManifest, String> {
    let (_, app_data_dir) = resolve_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        import_workflow_sync(app_data_dir, api_json_path, config_json_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_delete_workflow(
    app: tauri::AppHandle,
    workflow_id: String,
) -> Result<(), String> {
    let (_, app_data_dir) = resolve_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_custom_workflow_sync(app_data_dir, workflow_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_submit_job(
    app: tauri::AppHandle,
    settings: ComfyUiSettings,
    request: SdGenerateRequest,
) -> Result<String, String> {
    let (resource_dir, app_data_dir) = resolve_paths(&app)?;
    log::info!(target: "comfyui", "comfyui_submit_job: workflow='{}'", request.workflow_id);
    tauri::async_runtime::spawn_blocking(move || {
        submit_job_sync(resource_dir, app_data_dir, settings, request)
            .inspect_err(|err| log::error!(target: "comfyui", "comfyui_submit_job failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_watch_progress(
    app: tauri::AppHandle,
    settings: ComfyUiSettings,
    client_id: String,
    job_id: String,
) -> Result<(), String> {
    std::thread::spawn(move || {
        let emit = |event: ComfyProgressEvent| {
            let _ = app.emit("comfyui-progress", event);
        };
        if let Err(error) = watch_progress_sync(settings, client_id, job_id.clone(), &emit) {
            let _ = app.emit(
                "comfyui-progress",
                ComfyProgressEvent {
                    job_id,
                    progress: None,
                    progress_label: None,
                    error: Some(error),
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn comfyui_poll_job(
    settings: ComfyUiSettings,
    prompt_id: String,
) -> Result<SdPollResult, String> {
    tauri::async_runtime::spawn_blocking(move || poll_job_sync(settings, prompt_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comfyui_download_output(
    settings: ComfyUiSettings,
    filename: String,
    subfolder: String,
    prompt_id: String,
    workspace_dir: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_output_sync(settings, filename, subfolder, prompt_id, workspace_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}
