use crate::services::xtts::{XttsGenerateRequest, XttsSettings, XttsStatus};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn xtts_get_status(app: AppHandle, settings: XttsSettings) -> Result<XttsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = app.emit("xtts-log", msg.to_string());
        };
        crate::services::xtts::get_status_sync(settings, &emit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn xtts_generate_audio(
    app: AppHandle,
    settings: XttsSettings,
    request: XttsGenerateRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = app.emit("xtts-log", msg.to_string());
        };
        crate::services::xtts::generate_audio_sync(settings, request, &emit)
    })
    .await
    .map_err(|e| e.to_string())?
}
