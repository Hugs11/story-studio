use crate::services::podcast::{self, PodcastFeed};
use crate::support::user_message::UserMessage;
use tauri::AppHandle;

#[tauri::command]
pub async fn fetch_podcast_feed(
    url: String,
    proposed_episode_name: Option<String>,
) -> Result<PodcastFeed, UserMessage> {
    let result: Result<_, String> = async {
        tauri::async_runtime::spawn_blocking(move || match proposed_episode_name.as_deref() {
            Some(name) => podcast::fetch_feed_named(&url, Some(name)),
            None => podcast::fetch_feed(&url),
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}

#[tauri::command]
pub async fn download_podcast_media(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, UserMessage> {
    let result: Result<_, String> = async {
        let output_dir =
            crate::support::temp::app_cache_subdir(&app, crate::support::temp::PODCAST_MEDIA_DIR)?;
        tauri::async_runtime::spawn_blocking(move || {
            podcast::download_media(&output_dir, &url, &file_name)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    .await;
    result.map_err(UserMessage::from)
}
