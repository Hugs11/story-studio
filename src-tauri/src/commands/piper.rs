use crate::services::piper::{PiperGenerateRequest, PiperSettings, PiperStatus};
use crate::support::user_message;
use crate::support::user_message::codes;
use crate::support::user_message::UserMessage;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Dossier app-data inscriptible réservé aux voix téléchargées et à la
/// migration de l'ancien cache. Le runtime est lu depuis les ressources.
fn piper_home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| {
        let _msg_error = (e).to_string();
        UserMessage::new(codes::PIPER_APPDATA_INACCESSIBLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "app_data_dir inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    Ok(dir.join("piper"))
}

#[tauri::command]
pub async fn piper_list_voices(app: AppHandle) -> Result<PiperStatus, UserMessage> {
    let result: Result<_, String> = async {
        let home = piper_home(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            crate::services::piper::list_voices_sync(&home)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn piper_ensure_voice(app: AppHandle, voice: String) -> Result<(), UserMessage> {
    let result: Result<_, String> = async {
        let home = piper_home(&app)?;
        let emit_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let emit = |msg: &str| {
                let _ = emit_app.emit("piper-log", UserMessage::from(msg.to_string()));
            };
            crate::services::piper::ensure_sync(&home, &voice, &emit).inspect_err(
                |err| log::error!(target: "piper", "piper_ensure_voice failed: {}", err),
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn piper_generate_audio(
    app: AppHandle,
    settings: PiperSettings,
    request: PiperGenerateRequest,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
        log::info!(target: "piper",
        "piper_generate_audio: voice={:?} text_len={}",
        request.voice.as_deref(), request.text.len());
        let home = piper_home(&app)?;
        let emit_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let emit = |msg: &str| {
                let _ = emit_app.emit("piper-log", UserMessage::from(msg.to_string()));
            };
            crate::services::piper::generate_audio_sync(&home, settings, request, &emit)
                .inspect_err(
                    |err| log::error!(target: "piper", "piper_generate_audio failed: {}", err),
                )
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}
