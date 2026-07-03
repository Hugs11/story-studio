//! Listing d'une URL YouTube via `yt-dlp -J --flat-playlist` (rapide : ne résout
//! pas les formats). Le parsing JSON est isolé (`parse_list_json`, pur et testé) ;
//! l'exécution du binaire reste fine.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use super::process::run_command_with_timeout;
use super::provision::ensure_ytdlp;
use super::{YoutubeList, YoutubeVideo};
use crate::support::ffmpeg::apply_no_window;

/// Plafond de vidéos listées (D23 — garde-fou « chaîne énorme »). Au-delà, l'UI
/// avertit que la liste est tronquée.
const MAX_LIST_ENTRIES: usize = 400;
const LIST_TIMEOUT: Duration = Duration::from_secs(120);

/// Valide qu'une URL est bien une URL YouTube (HTTP/HTTPS sur un domaine YouTube).
/// Évite d'utiliser yt-dlp comme téléchargeur générique d'un site arbitraire.
pub(super) fn validate_youtube_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL invalide : {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Seules les URL http/https sont autorisées.".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let ok = host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com");
    if ok {
        Ok(())
    } else {
        Err("Cette adresse n'est pas une URL YouTube.".to_string())
    }
}

pub fn fetch_list(
    home: &Path,
    custom: Option<&str>,
    url: &str,
    emit: &dyn Fn(&str),
) -> Result<YoutubeList, String> {
    validate_youtube_url(url)?;
    let exe = ensure_ytdlp(home, custom, emit)?;

    emit("Lecture des vidéos…");
    let mut cmd = Command::new(&exe);
    apply_no_window(&mut cmd);
    cmd.args([
        "-J",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-config",
        "--playlist-end",
        &(MAX_LIST_ENTRIES + 1).to_string(),
        url,
    ]);

    let output = run_command_with_timeout(cmd, LIST_TIMEOUT, "Lecture YouTube")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp n'a pas pu lire cette URL : {}",
            stderr.trim().lines().last().unwrap_or("erreur inconnue")
        ));
    }

    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Réponse yt-dlp illisible (JSON invalide).".to_string())?;
    let list = parse_list_json(value, MAX_LIST_ENTRIES);
    if list.videos.is_empty() {
        return Err("Aucune vidéo exploitable trouvée pour cette URL.".to_string());
    }
    Ok(list)
}

/// Convertit la sortie JSON yt-dlp en `YoutubeList` (pur, sans réseau). Gère la
/// vidéo seule, la playlist et la chaîne (playlists imbriquées aplaties).
pub(super) fn parse_list_json(value: Value, limit: usize) -> YoutubeList {
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string);
    let image_url = pick_image(&value, value.get("id").and_then(Value::as_str));

    let mut videos = Vec::new();
    let collect_limit = limit.saturating_add(1);
    if value.get("entries").is_some() {
        collect_entries(&value, collect_limit, &mut videos);
    } else if let Some(video) = build_video(&value) {
        videos.push(video);
    }

    let truncated = videos.len() > limit;
    if truncated {
        videos.truncate(limit);
    }
    assign_selection_keys(&mut videos);
    let title = title
        .or_else(|| videos.first().map(|v| v.title.clone()))
        .unwrap_or_else(|| "YouTube".to_string());

    YoutubeList {
        title,
        image_url,
        videos,
        truncated,
    }
}

/// Parcourt `entries`, aplatit les playlists imbriquées (tabs de chaîne) et
/// s'arrête au plafond.
fn collect_entries(node: &Value, limit: usize, out: &mut Vec<YoutubeVideo>) {
    let Some(entries) = node.get("entries").and_then(Value::as_array) else {
        return;
    };
    for entry in entries {
        if out.len() >= limit {
            return;
        }
        if entry.get("entries").is_some() {
            collect_entries(entry, limit, out);
        } else if let Some(video) = build_video(entry) {
            out.push(video);
        }
    }
}

fn build_video(entry: &Value) -> Option<YoutubeVideo> {
    let id = entry.get("id").and_then(Value::as_str);
    let audio_url = watch_url(entry, id)?;
    let title = entry
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Vidéo".to_string());
    Some(YoutubeVideo {
        id: id.unwrap_or("").to_string(),
        selection_key: String::new(),
        title,
        audio_url,
        duration: format_duration(entry.get("duration").and_then(Value::as_f64)),
        image_url: pick_image(entry, id),
    })
}

fn assign_selection_keys(videos: &mut [YoutubeVideo]) {
    for (index, video) in videos.iter_mut().enumerate() {
        video.selection_key = if video.id.is_empty() {
            format!("video-{}", index + 1)
        } else {
            format!("{}#{}", video.id, index + 1)
        };
    }
}

/// URL de visionnage : `url`/`webpage_url` si déjà http(s), sinon reconstruite
/// depuis l'identifiant.
fn watch_url(entry: &Value, id: Option<&str>) -> Option<String> {
    for key in ["url", "webpage_url"] {
        if let Some(u) = entry.get(key).and_then(Value::as_str) {
            if u.starts_with("http://") || u.starts_with("https://") {
                return Some(u.to_string());
            }
        }
    }
    id.filter(|s| !s.is_empty())
        .map(|id| format!("https://www.youtube.com/watch?v={}", id))
}

/// Miniature : champ `thumbnail`, sinon dernière de `thumbnails`, sinon miniature
/// canonique reconstruite depuis l'identifiant.
fn pick_image(node: &Value, id: Option<&str>) -> Option<String> {
    if let Some(thumb) = node.get("thumbnail").and_then(Value::as_str) {
        if !thumb.is_empty() {
            return Some(thumb.to_string());
        }
    }
    if let Some(url) = node
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .rev()
                .find_map(|t| t.get("url").and_then(Value::as_str))
        })
    {
        return Some(url.to_string());
    }
    id.filter(|s| !s.is_empty())
        .map(|id| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id))
}

/// Secondes → `M:SS` (ou `H:MM:SS`). `None`/0 → `None`.
pub(super) fn format_duration(seconds: Option<f64>) -> Option<String> {
    let total = seconds.filter(|s| *s >= 1.0)? as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        Some(format!("{}:{:02}:{:02}", h, m, s))
    } else {
        Some(format!("{}:{:02}", m, s))
    }
}
