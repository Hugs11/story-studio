//! Commandes Tauri du funnel YouTube. Miroir de `commands::podcast`,
//! avec en plus la mise à jour du binaire yt-dlp. Les téléchargements lourds
//! tournent sur `spawn_blocking` et émettent leur progression via `youtube-log`.

use crate::services::youtube::{self, YoutubeAudioLanguages, YoutubeList};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Dossier app-data inscriptible où yt-dlp est provisionné (jamais dans le repo
/// ni dans Program Files en lecture seule).
fn youtube_home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir inaccessible : {}", e))?;
    Ok(dir.join("yt-dlp"))
}

fn youtube_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::support::temp::app_cache_subdir(app, crate::support::temp::YOUTUBE_MEDIA_DIR)
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub async fn fetch_youtube_list(
    app: AppHandle,
    url: String,
    ytdlp_path: Option<String>,
    page: Option<usize>,
) -> Result<YoutubeList, String> {
    let home = youtube_home(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", msg.to_string());
        };
        youtube::fetch_list(&home, custom.as_deref(), &url, page.unwrap_or(1), &emit)
            .inspect_err(|err| log::error!(target: "youtube", "fetch_youtube_list failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_youtube_audio(
    app: AppHandle,
    video_url: String,
    file_name: String,
    ytdlp_path: Option<String>,
    audio_language: Option<String>,
) -> Result<String, String> {
    let home = youtube_home(&app)?;
    let output_dir = youtube_output_dir(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", msg.to_string());
        };
        youtube::download_audio(
            &home,
            &output_dir,
            custom.as_deref(),
            &video_url,
            &file_name,
            empty_to_none(audio_language).as_deref(),
            &emit,
        )
        .inspect_err(|err| log::error!(target: "youtube", "download_youtube_audio failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fetch_youtube_audio_languages(
    app: AppHandle,
    video_urls: Vec<String>,
    ytdlp_path: Option<String>,
) -> Result<Vec<YoutubeAudioLanguages>, String> {
    let home = youtube_home(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", msg.to_string());
        };
        youtube::fetch_audio_languages(&home, custom.as_deref(), &video_urls, &emit).inspect_err(
            |err| log::error!(target: "youtube", "fetch_youtube_audio_languages failed: {}", err),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Force le téléchargement de la dernière version de yt-dlp (action manuelle).
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<(), String> {
    let home = youtube_home(&app)?;
    let emit_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", msg.to_string());
        };
        youtube::update_ytdlp_binary(&home, &emit)
            .map(|_| ())
            .inspect_err(|err| log::error!(target: "youtube", "update_ytdlp failed: {}", err))
    })
    .await
    .map_err(|e| e.to_string())?
}
