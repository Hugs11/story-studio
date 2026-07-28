use crate::services::podcast::{self, PodcastFeed};
use tauri::AppHandle;

#[tauri::command]
pub async fn fetch_podcast_feed(url: String) -> Result<PodcastFeed, String> {
    tauri::async_runtime::spawn_blocking(move || podcast::fetch_feed(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_podcast_media(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    let output_dir =
        crate::support::temp::app_cache_subdir(&app, crate::support::temp::PODCAST_MEDIA_DIR)?;
    tauri::async_runtime::spawn_blocking(move || {
        podcast::download_media(&output_dir, &url, &file_name)
    })
    .await
    .map_err(|e| e.to_string())?
}
