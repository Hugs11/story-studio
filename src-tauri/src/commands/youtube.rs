//! Commandes Tauri du funnel YouTube. Miroir de `commands::podcast`,
//! avec en plus la mise à jour du binaire yt-dlp. Les téléchargements lourds
//! tournent sur `spawn_blocking` et émettent leur progression via `youtube-log`.

use crate::services::youtube::{self, ToolMode, YoutubeAudioLanguages, YoutubeError, YoutubeList};
use crate::support::user_message;
use crate::support::user_message::codes;
use crate::support::user_message::UserMessage;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Dossier app-data inscriptible où yt-dlp est provisionné (jamais dans le repo
/// ni dans Program Files en lecture seule).
fn youtube_home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| {
        let _msg_error = (e).to_string();
        UserMessage::new(codes::YOUTUBE_APPDATA_INACCESSIBLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "app_data_dir inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    Ok(dir.join("yt-dlp"))
}

fn youtube_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::support::temp::app_cache_subdir(app, crate::support::temp::YOUTUBE_MEDIA_DIR)
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

/// Les erreurs typées (`{ code, message }`) permettent au funnel de reconnaître
/// un blocage de YouTube et d'arrêter le lot.
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, YoutubeError> + Send + 'static,
) -> Result<T, YoutubeError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| YoutubeError::from(e.to_string()))?
}

/// `installed_tools_only` (vérification de fond des suivis) n'utilise que les
/// outils déjà présents, ne télécharge jamais et joint leur état au résultat.
/// Absent ou faux : comportement des imports manuels, inchangé.
#[tauri::command]
pub async fn fetch_youtube_list(
    app: AppHandle,
    url: String,
    ytdlp_path: Option<String>,
    page: Option<usize>,
    installed_tools_only: Option<bool>,
    proposed_video_name: Option<String>,
) -> Result<YoutubeList, YoutubeError> {
    let mode = ToolMode::from_installed_only(installed_tools_only);
    let home = youtube_home(&app)?;
    let output_dir = youtube_output_dir(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    run_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", UserMessage::from(msg.to_string()));
        };
        let result = match proposed_video_name.as_deref() {
            Some(name) => youtube::fetch_list_named(
                &home,
                &output_dir,
                custom.as_deref(),
                &url,
                page.unwrap_or(1),
                mode,
                &emit,
                Some(name),
            ),
            None => youtube::fetch_list(
                &home,
                &output_dir,
                custom.as_deref(),
                &url,
                page.unwrap_or(1),
                mode,
                &emit,
            ),
        };
        result
            .inspect_err(|err| log::error!(target: "youtube", "fetch_youtube_list failed: {}", err))
    })
    .await
}

#[tauri::command]
pub async fn download_youtube_audio(
    app: AppHandle,
    video_url: String,
    file_name: String,
    ytdlp_path: Option<String>,
    audio_language: Option<String>,
) -> Result<String, YoutubeError> {
    let home = youtube_home(&app)?;
    let output_dir = youtube_output_dir(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    run_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", UserMessage::from(msg.to_string()));
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
}

#[tauri::command]
pub async fn fetch_youtube_audio_languages(
    app: AppHandle,
    video_urls: Vec<String>,
    ytdlp_path: Option<String>,
) -> Result<Vec<YoutubeAudioLanguages>, YoutubeError> {
    let home = youtube_home(&app)?;
    let output_dir = youtube_output_dir(&app)?;
    let custom = empty_to_none(ytdlp_path);
    let emit_app = app.clone();
    run_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", UserMessage::from(msg.to_string()));
        };
        youtube::fetch_audio_languages(&home, &output_dir, custom.as_deref(), &video_urls, &emit)
            .inspect_err(|err| {
                log::error!(target: "youtube", "fetch_youtube_audio_languages failed: {}", err)
            })
    })
    .await
}

/// Force la dernière version de yt-dlp et prépare le moteur JavaScript
/// (action manuelle).
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<(), YoutubeError> {
    let home = youtube_home(&app)?;
    let emit_app = app.clone();
    run_blocking(move || {
        let emit = |msg: &str| {
            let _ = emit_app.emit("youtube-log", UserMessage::from(msg.to_string()));
        };
        youtube::update_tools(&home, &emit)
            .inspect_err(|err| log::error!(target: "youtube", "update_ytdlp failed: {}", err))
    })
    .await
}
