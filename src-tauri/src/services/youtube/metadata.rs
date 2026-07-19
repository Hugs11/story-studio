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

/// Taille fixe d'une page. La borne protège chaque appel sans imposer de
/// plafond global : l'UI peut demander autant de pages que nécessaire.
pub(super) const LIST_PAGE_SIZE: usize = 400;
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
    page: usize,
    emit: &dyn Fn(&str),
) -> Result<YoutubeList, String> {
    let listing_url = normalize_listing_url(url)?;
    let (start, end_with_sentinel) = page_window(page, LIST_PAGE_SIZE)?;
    let exe = ensure_ytdlp(home, custom, emit)?;

    emit(&format!("Lecture des vidéos — page {}…", page));
    let mut cmd = Command::new(&exe);
    apply_no_window(&mut cmd);
    cmd.args([
        "-J",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-config",
        "--playlist-items",
        &format!("{}:{}", start, end_with_sentinel),
        &listing_url,
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
    let list = parse_list_json(value, page, LIST_PAGE_SIZE);
    if list.videos.is_empty() {
        return Err("Aucune vidéo exploitable trouvée pour cette URL.".to_string());
    }
    Ok(list)
}

/// Les URL racine de chaîne sont multi-playlists dans yt-dlp (vidéos, Shorts,
/// directs). Les convertir vers l'onglet Vidéos rend les indices de page
/// continus. Un onglet explicitement fourni par l'utilisateur reste inchangé.
pub(super) fn normalize_listing_url(url: &str) -> Result<String, String> {
    validate_youtube_url(url)?;
    let mut parsed =
        reqwest::Url::parse(url.trim()).map_err(|e| format!("URL invalide : {}", e))?;
    let segments: Vec<_> = parsed
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();

    // Les chaînes identifiées par UC ont une playlist d'uploads canonique UU.
    // Elle reste disponible pour les chaînes « Topic », qui n'ont pas toujours
    // d'onglet /videos, et fournit une liste plate adaptée à la pagination.
    let channel_id = match segments.as_slice() {
        ["channel", id] | ["channel", id, "featured"] if id.starts_with("UC") => {
            Some((*id).to_string())
        }
        _ => None,
    };
    if let Some(channel_id) = channel_id {
        let uploads_id = format!("UU{}", &channel_id[2..]);
        parsed.set_path("/playlist");
        parsed
            .query_pairs_mut()
            .clear()
            .append_pair("list", &uploads_id);
        parsed.set_fragment(None);
        return Ok(parsed.to_string());
    }

    let is_handle_root = matches!(segments.as_slice(), [handle] if handle.starts_with('@'));
    let is_legacy_root = matches!(
        segments.as_slice(),
        [kind, _] if matches!(*kind, "channel" | "c" | "user")
    );
    let is_featured_tab = matches!(
        segments.as_slice(),
        [handle, "featured"] if handle.starts_with('@')
    ) || matches!(
        segments.as_slice(),
        [kind, _, "featured"] if matches!(*kind, "channel" | "c" | "user")
    );

    if is_handle_root || is_legacy_root || is_featured_tab {
        let base_segments = if is_featured_tab {
            &segments[..segments.len() - 1]
        } else {
            &segments[..]
        };
        parsed.set_path(&format!("/{}/videos", base_segments.join("/")));
        parsed.set_query(None);
        parsed.set_fragment(None);
    }

    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

/// Renvoie la plage inclusive comprise par yt-dlp. La borne haute inclut une
/// entrée sentinelle, retirée du résultat, afin de calculer `has_next` sans
/// connaître la taille totale de la source.
pub(super) fn page_window(page: usize, page_size: usize) -> Result<(usize, usize), String> {
    if page == 0 || page_size == 0 {
        return Err("La page YouTube demandée est invalide.".to_string());
    }
    let start = page
        .checked_sub(1)
        .and_then(|index| index.checked_mul(page_size))
        .and_then(|offset| offset.checked_add(1))
        .ok_or_else(|| "La page YouTube demandée est trop éloignée.".to_string())?;
    let end_with_sentinel = start
        .checked_add(page_size)
        .ok_or_else(|| "La page YouTube demandée est trop éloignée.".to_string())?;
    Ok((start, end_with_sentinel))
}

/// Convertit la sortie JSON yt-dlp en `YoutubeList` (pur, sans réseau). Gère la
/// vidéo seule, la playlist et la chaîne (playlists imbriquées aplaties).
pub(super) fn parse_list_json(value: Value, page: usize, page_size: usize) -> YoutubeList {
    let title = channel_tab_title(&value).or_else(|| {
        value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let image_url = pick_image(&value, value.get("id").and_then(Value::as_str));

    let mut videos = Vec::new();
    let collect_limit = page_size.saturating_add(1);
    if value.get("entries").is_some() {
        collect_entries(&value, collect_limit, &mut videos);
    } else if let Some(video) = build_video(&value) {
        videos.push(video);
    }

    let has_next = videos.len() > page_size;
    if has_next {
        videos.truncate(page_size);
    }
    let first_source_index = page
        .saturating_sub(1)
        .saturating_mul(page_size)
        .saturating_add(1);
    assign_selection_keys(&mut videos, first_source_index);
    let title = title
        .or_else(|| videos.first().map(|v| v.title.clone()))
        .unwrap_or_else(|| "YouTube".to_string());

    YoutubeList {
        title,
        image_url,
        videos,
        page,
        page_size,
        has_next,
    }
}

fn channel_tab_title(value: &Value) -> Option<String> {
    let webpage_url = value.get("webpage_url").and_then(Value::as_str)?;
    let path = reqwest::Url::parse(webpage_url).ok()?.path().to_string();
    let is_media_tab = ["/videos", "/shorts", "/streams"]
        .iter()
        .any(|suffix| path.ends_with(suffix));
    is_media_tab
        .then(|| value.get("channel").and_then(Value::as_str))
        .flatten()
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

/// Parcourt `entries`, aplatit les playlists imbriquées et s'arrête à la borne
/// de la page courante (sentinelle comprise).
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
        source_index: 0,
        title,
        audio_url,
        duration: format_duration(entry.get("duration").and_then(Value::as_f64)),
        image_url: pick_image(entry, id),
    })
}

fn assign_selection_keys(videos: &mut [YoutubeVideo], first_source_index: usize) {
    for (index, video) in videos.iter_mut().enumerate() {
        let source_index = first_source_index.saturating_add(index);
        video.source_index = source_index;
        video.selection_key = if video.id.is_empty() {
            format!("video-{}", source_index)
        } else {
            format!("{}#{}", video.id, source_index)
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
