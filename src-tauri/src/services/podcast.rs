//! Import de podcast : récupération d'un flux RSS et téléchargement des médias.
//!
//! Premier accès HTTP **externe** assumé du projet (les podcasts vivent sur le web,
//! contrairement à ComfyUI/XTTS qui restent locaux). On valide donc explicitement le
//! schéma (`http`/`https`) et on plafonne la taille des téléchargements.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::support::network::http_client;

const TEMP_PODCAST_DIR: &str = "story_studio_podcast";
const MAX_FEED_BYTES: u64 = 10 * 1024 * 1024; // 10 Mo
const MAX_MEDIA_BYTES: u64 = 300 * 1024 * 1024; // 300 Mo
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_TIMEOUT: Duration = Duration::from_secs(300);
const USER_AGENT: &str = "StoryStudio/0.9 (podcast import)";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisode {
    pub id: String,
    pub title: String,
    pub audio_url: String,
    pub mime_type: Option<String>,
    pub pub_date: Option<String>,
    pub duration: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastFeed {
    pub title: String,
    pub image_url: Option<String>,
    pub episodes: Vec<PodcastEpisode>,
}

fn validate_remote_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL invalide : {}", e))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!(
            "Schéma d'URL non autorisé : {} (seuls http et https le sont).",
            other
        )),
    }
}

/// Lit un `Read` en imposant une taille maximale.
fn read_limited<R: Read>(mut reader: R, max: u64) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    reader
        .by_ref()
        .take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Lecture du contenu impossible : {}", e))?;
    if buf.len() as u64 > max {
        return Err(format!("Contenu trop volumineux (> {} octets).", max));
    }
    Ok(buf)
}

pub fn fetch_feed(url: &str) -> Result<PodcastFeed, String> {
    let parsed = validate_remote_url(url)?;
    let client = http_client(FEED_TIMEOUT)?;
    let response = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .map_err(|e| format!("Impossible de récupérer le flux : {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Le flux a répondu HTTP {}.", response.status()));
    }
    let bytes = read_limited(response, MAX_FEED_BYTES)?;
    let text = String::from_utf8_lossy(&bytes);
    // Certains flux exposent un BOM UTF-8 ou des espaces avant <?xml> : roxmltree les refuse.
    let cleaned = text.trim_start_matches('\u{feff}').trim_start();
    parse_feed(cleaned)
}

pub fn download_media(url: &str, file_name: &str) -> Result<String, String> {
    let parsed = validate_remote_url(url)?;
    let client = http_client(MEDIA_TIMEOUT)?;
    let response = client
        .get(parsed.clone())
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .map_err(|e| format!("Téléchargement impossible : {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Le serveur a répondu HTTP {}.", response.status()));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_ascii_lowercase());
    let ext = extension_for(content_type.as_deref(), &parsed);
    let stem = sanitize_stem(file_name);

    let dir = std::env::temp_dir().join(TEMP_PODCAST_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Création du dossier temporaire impossible : {}", e))?;
    let dest = unique_path(&dir, &stem, &ext);

    let bytes = read_limited(response, MAX_MEDIA_BYTES)?;
    if bytes.is_empty() {
        return Err("Fichier téléchargé vide.".to_string());
    }
    fs::write(&dest, &bytes).map_err(|e| format!("Écriture du fichier impossible : {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

fn parse_feed(xml: &str) -> Result<PodcastFeed, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("Flux RSS illisible : {}", e))?;
    let channel = doc
        .root_element()
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "channel")
        .ok_or_else(|| "Flux invalide : aucun <channel> RSS trouvé.".to_string())?;

    let title = child_text(&channel, "title").unwrap_or_else(|| "Podcast".to_string());
    let feed_image = node_image(&channel);

    let mut episodes = Vec::new();
    for (index, item) in channel
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "item")
        .enumerate()
    {
        if let Some(episode) = parse_item(&item, index, feed_image.as_deref()) {
            episodes.push(episode);
        }
    }

    if episodes.is_empty() {
        return Err("Aucun épisode audio trouvé dans ce flux.".to_string());
    }

    Ok(PodcastFeed {
        title,
        image_url: feed_image,
        episodes,
    })
}

fn parse_item(
    item: &roxmltree::Node,
    index: usize,
    feed_image: Option<&str>,
) -> Option<PodcastEpisode> {
    let enclosure = child_by_local(item, "enclosure")?;
    let audio_url = enclosure.attribute("url").map(str::trim).unwrap_or("");
    if audio_url.is_empty() {
        return None;
    }
    let mime_type = enclosure
        .attribute("type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let size_bytes = enclosure
        .attribute("length")
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0);

    let title = child_text(item, "title").unwrap_or_else(|| format!("Épisode {}", index + 1));
    let pub_date = child_text(item, "pubDate");
    let duration = child_text(item, "duration"); // itunes:duration (nom local)
    let description = child_text(item, "description").or_else(|| child_text(item, "summary"));
    let image_url = node_image(item).or_else(|| feed_image.map(str::to_string));
    let id = format!("{:x}", simple_hash(audio_url));

    Some(PodcastEpisode {
        id,
        title,
        audio_url: audio_url.to_string(),
        mime_type,
        pub_date,
        duration,
        description,
        image_url,
        size_bytes,
    })
}

/// Premier enfant élément portant ce nom local (namespace ignoré, pour gérer iTunes).
fn child_by_local<'a, 'input>(
    parent: &roxmltree::Node<'a, 'input>,
    local: &str,
) -> Option<roxmltree::Node<'a, 'input>> {
    parent
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == local)
}

fn child_text(parent: &roxmltree::Node, local: &str) -> Option<String> {
    child_by_local(parent, local)
        .and_then(|n| n.text())
        .map(|t| t.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Image d'un nœud channel/item : `itunes:image href` en priorité, sinon `<image><url>`.
fn node_image(node: &roxmltree::Node) -> Option<String> {
    if let Some(img) = node
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == "image" && c.has_attribute("href"))
    {
        if let Some(href) = img
            .attribute("href")
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(href.to_string());
        }
    }
    if let Some(img) = child_by_local(node, "image") {
        if let Some(url) = child_text(&img, "url") {
            return Some(url);
        }
    }
    None
}

fn extension_for(content_type: Option<&str>, url: &reqwest::Url) -> String {
    if let Some(ct) = content_type {
        let mapped = match ct {
            "audio/mpeg" | "audio/mp3" => Some("mp3"),
            "audio/mp4" | "audio/x-m4a" | "audio/m4a" => Some("m4a"),
            "audio/aac" => Some("aac"),
            "audio/ogg" | "application/ogg" => Some("ogg"),
            "audio/wav" | "audio/x-wav" | "audio/wave" => Some("wav"),
            "audio/flac" | "audio/x-flac" => Some("flac"),
            "audio/webm" | "video/webm" => Some("webm"),
            "image/jpeg" => Some("jpg"),
            "image/png" => Some("png"),
            "image/webp" => Some("webp"),
            "image/gif" => Some("gif"),
            "image/bmp" => Some("bmp"),
            _ => None,
        };
        if let Some(ext) = mapped {
            return ext.to_string();
        }
    }
    if let Some(last) = url.path_segments().and_then(|mut s| s.next_back()) {
        if let Some(dot) = last.rfind('.') {
            let clean: String = last[dot + 1..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if !clean.is_empty() && clean.len() <= 5 {
                return clean.to_ascii_lowercase();
            }
        }
    }
    "mp3".to_string()
}

fn sanitize_stem(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    out = out.trim().to_string();
    if out.chars().count() > 80 {
        out = out.chars().take(80).collect::<String>().trim().to_string();
    }
    if out.is_empty() {
        out = "episode".to_string();
    }
    out
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{}.{}", stem, ext));
    let mut counter = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{}-{}.{}", stem, counter, ext));
        counter += 1;
    }
    candidate
}

fn simple_hash(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Mon Podcast</title>
    <itunes:image href="https://example.com/cover.jpg"/>
    <item>
      <title>Episode 1</title>
      <pubDate>Mon, 01 Jan 2024 10:00:00 +0000</pubDate>
      <itunes:duration>00:12:34</itunes:duration>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="123456"/>
      <itunes:image href="https://example.com/ep1.jpg"/>
      <description>Premier episode</description>
    </item>
    <item>
      <title>Episode 2</title>
      <enclosure url="https://example.com/ep2.mp3" type="audio/mpeg"/>
    </item>
    <item>
      <title>Sans audio</title>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_channel_and_episodes() {
        let feed = parse_feed(SAMPLE).expect("parse");
        assert_eq!(feed.title, "Mon Podcast");
        assert_eq!(
            feed.image_url.as_deref(),
            Some("https://example.com/cover.jpg")
        );
        // L'item sans enclosure est ignoré.
        assert_eq!(feed.episodes.len(), 2);

        let ep1 = &feed.episodes[0];
        assert_eq!(ep1.title, "Episode 1");
        assert_eq!(ep1.audio_url, "https://example.com/ep1.mp3");
        assert_eq!(ep1.mime_type.as_deref(), Some("audio/mpeg"));
        assert_eq!(ep1.duration.as_deref(), Some("00:12:34"));
        assert_eq!(ep1.size_bytes, Some(123456));
        assert_eq!(
            ep1.image_url.as_deref(),
            Some("https://example.com/ep1.jpg")
        );
        assert_eq!(ep1.description.as_deref(), Some("Premier episode"));

        // ep2 hérite de l'image du flux.
        assert_eq!(
            feed.episodes[1].image_url.as_deref(),
            Some("https://example.com/cover.jpg")
        );
    }

    #[test]
    fn rejects_non_rss() {
        assert!(parse_feed("<html><body>nope</body></html>").is_err());
    }

    #[test]
    fn rejects_feed_without_audio() {
        let xml = r#"<rss version="2.0"><channel><title>x</title><item><title>a</title></item></channel></rss>"#;
        assert!(parse_feed(xml).is_err());
    }

    #[test]
    fn extension_from_content_type_then_url() {
        let url = reqwest::Url::parse("https://example.com/path/file.weird").unwrap();
        assert_eq!(extension_for(Some("audio/mpeg"), &url), "mp3");
        assert_eq!(extension_for(Some("image/jpeg"), &url), "jpg");
        // Type inconnu -> extension de l'URL.
        let url_mp3 = reqwest::Url::parse("https://example.com/a/b.mp3?x=1").unwrap();
        assert_eq!(
            extension_for(Some("application/octet-stream"), &url_mp3),
            "mp3"
        );
    }

    #[test]
    fn validate_remote_url_scheme() {
        assert!(validate_remote_url("file:///etc/passwd").is_err());
        assert!(validate_remote_url("ftp://example.com/x").is_err());
        assert!(validate_remote_url("https://example.com/feed.xml").is_ok());
    }

    #[test]
    fn sanitize_stem_handles_bad_chars_and_length() {
        assert_eq!(sanitize_stem("a/b\\c:d?"), "a_b_c_d_");
        assert_eq!(sanitize_stem("   "), "episode");
        assert!(sanitize_stem(&"x".repeat(200)).chars().count() <= 80);
    }
}
