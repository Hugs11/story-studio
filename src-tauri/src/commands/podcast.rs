use crate::services::podcast::{self, PodcastFeed};

#[tauri::command]
pub async fn fetch_podcast_feed(url: String) -> Result<PodcastFeed, String> {
    tauri::async_runtime::spawn_blocking(move || podcast::fetch_feed(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_podcast_media(url: String, file_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || podcast::download_media(&url, &file_name))
        .await
        .map_err(|e| e.to_string())?
}
