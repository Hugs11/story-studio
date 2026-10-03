//! Cache des analyses complètes de vidéos.
//!
//! Chaque analyse (`--dump-json`) interroge l'API de lecture de YouTube, et ce
//! sont ces requêtes répétées qui déclenchent la vérification anti-robot. Une
//! vidéo déjà analysée (vidéo seule, ou pistes audio d'une sélection) garde son
//! JSON quelques heures : le téléchargement le rejoue avec `--load-info-json`
//! au lieu de refaire l'analyse. Si les liens ont expiré, yt-dlp refait
//! lui-même l'analyse depuis `webpage_url`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use super::metadata::validate_youtube_url;

/// Les liens de flux YouTube expirent au bout d'environ six heures.
const INFO_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const MAX_INFO_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn info_dir(output_dir: &Path) -> PathBuf {
    output_dir.join("info")
}

fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

/// Identifiant de vidéo porté par une URL YouTube (`watch?v=`, `youtu.be/`,
/// `shorts/`, `live/`, `embed/`).
pub(super) fn video_id_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    let id = if host == "youtu.be" {
        segments.first().map(|id| id.to_string())
    } else if segments.first() == Some(&"watch") {
        parsed
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.into_owned())
    } else {
        match segments.as_slice() {
            ["shorts" | "live" | "embed", id, ..] => Some(id.to_string()),
            _ => None,
        }
    }?;
    is_video_id(&id).then_some(id)
}

fn info_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.info.json"))
}

/// Enregistre l'analyse d'une vidéo. Seul un JSON de vidéo complète, identifié
/// et pointant vers YouTube, est conservé ; un échec d'écriture reste silencieux
/// car le cache n'est qu'une optimisation.
pub(super) fn store(dir: &Path, json: &[u8]) {
    if json.len() > MAX_INFO_BYTES {
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(json) else {
        return;
    };
    let Some(id) = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_video_id(id))
    else {
        return;
    };
    let has_formats = value
        .get("formats")
        .and_then(Value::as_array)
        .is_some_and(|formats| !formats.is_empty());
    let webpage_ok = value
        .get("webpage_url")
        .and_then(Value::as_str)
        .is_some_and(|url| validate_youtube_url(url).is_ok());
    if !has_formats || !webpage_ok {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    purge_expired(dir);
    let dest = info_path(dir, id);
    let tmp = dir.join(format!(".{id}.{}.part", uuid::Uuid::new_v4()));
    if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn is_fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < INFO_TTL)
}

/// Analyse encore exploitable pour cette vidéo, le cas échéant.
pub(super) fn fresh(dir: &Path, id: &str) -> Option<PathBuf> {
    if !is_video_id(id) {
        return None;
    }
    let path = info_path(dir, id);
    is_fresh(&path).then_some(path)
}

pub(super) fn remove(dir: &Path, id: &str) {
    if is_video_id(id) {
        let _ = std::fs::remove_file(info_path(dir, id));
    }
}

fn purge_expired(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !is_fresh(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("story_studio_yt_info_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn video_json(id: &str, webpage_url: &str) -> Vec<u8> {
        serde_json::json!({
            "id": id,
            "webpage_url": webpage_url,
            "formats": [{ "format_id": "251", "url": "https://rr1.googlevideo.com/x" }],
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn extracts_video_ids_from_supported_urls() {
        let id = "dQw4w9WgXcQ";
        for url in [
            format!("https://www.youtube.com/watch?v={id}&list=PL1"),
            format!("https://youtu.be/{id}?t=3"),
            format!("https://m.youtube.com/shorts/{id}"),
            format!("https://www.youtube.com/live/{id}"),
            format!("https://www.youtube-nocookie.com/embed/{id}"),
        ] {
            assert_eq!(video_id_from_url(&url).as_deref(), Some(id), "{url}");
        }
        assert_eq!(
            video_id_from_url("https://www.youtube.com/@chaine/videos"),
            None
        );
        assert_eq!(
            video_id_from_url("https://www.youtube.com/watch?v=../../etc"),
            None
        );
    }

    #[test]
    fn stores_and_returns_only_valid_video_analyses() {
        let dir = temp_dir();
        let id = "dQw4w9WgXcQ";
        store(
            &dir,
            &video_json(id, &format!("https://www.youtube.com/watch?v={id}")),
        );
        assert_eq!(fresh(&dir, id), Some(info_path(&dir, id)));

        store(
            &dir,
            &video_json("aaaaaaaaaaa", "https://example.com/watch?v=aaaaaaaaaaa"),
        );
        assert_eq!(fresh(&dir, "aaaaaaaaaaa"), None);
        store(
            &dir,
            br#"{"id":"bbbbbbbbbbb","webpage_url":"https://youtu.be/bbbbbbbbbbb"}"#,
        );
        assert_eq!(fresh(&dir, "bbbbbbbbbbb"), None);
        store(&dir, b"not json");

        remove(&dir, id);
        assert_eq!(fresh(&dir, id), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expired_analyses_are_ignored_and_purged() {
        let dir = temp_dir();
        let id = "dQw4w9WgXcQ";
        let path = info_path(&dir, id);
        std::fs::write(&path, b"{}").unwrap();
        let old = SystemTime::now() - INFO_TTL - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(fresh(&dir, id), None);
        purge_expired(&dir);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
