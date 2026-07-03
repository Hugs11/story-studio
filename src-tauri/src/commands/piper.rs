use crate::services::piper::{PiperGenerateRequest, PiperSettings, PiperStatus};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Dossier app-data inscriptible où le binaire et les voix sont provisionnés.
fn piper_home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir inaccessible : {}", e))?;
    Ok(dir.join("piper"))
}

#[tauri::command]
pub async fn piper_list_voices(app: AppHandle) -> Result<PiperStatus, String> {
    let home = piper_home(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::services::piper::list_voices_sync(&home))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn piper_ensure_voice(app: AppHandle, voice: String) -> Result<(), String> {
    let home = piper_home(&app)?;
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("piper-log", msg.to_string());
        };
        crate::services::piper::ensure_sync(&home, &voice, &emit)
            .inspect_err(|err| log::error!(target: "piper", "piper_ensure_voice failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn piper_generate_audio(
    app: AppHandle,
    settings: PiperSettings,
    request: PiperGenerateRequest,
) -> Result<String, String> {
    log::info!(target: "piper",
        "piper_generate_audio: voice={:?} text_len={}",
        request.voice.as_deref(), request.text.len());
    let home = piper_home(&app)?;
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("piper-log", msg.to_string());
        };
        crate::services::piper::generate_audio_sync(&home, settings, request, &emit)
            .inspect_err(|err| log::error!(target: "piper", "piper_generate_audio failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}
