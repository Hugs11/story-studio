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
    log::info!(target: "xtts",
        "xtts_generate_audio: voice={:?} lang={:?} text_len={}",
        request.voice.as_deref(), request.language.as_deref(), request.text.len());
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = app.emit("xtts-log", msg.to_string());
        };
        crate::services::xtts::generate_audio_sync(settings, request, &emit)
            .inspect_err(|err| log::error!(target: "xtts", "xtts_generate_audio failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}
