//! Service YouTube : transforme une URL (vidéo / playlist / chaîne) en
//! histoires audio via **yt-dlp**. Jumeau de `services/podcast`, mais la source
//! est YouTube et l'acquisition passe par le binaire yt-dlp (provisionné au 1er
//! usage, cf. `provision`) qui s'appuie sur le ffmpeg embarqué pour extraire le MP3.
//!
//! Sécurité (invariants `support/`) : arguments en tableau (jamais de shell),
//! `CREATE_NO_WINDOW`, URL bornées aux domaines YouTube, destination bornée au
//! dossier temp, noms de fichiers assainis, plafonds sur la liste et la taille.

use serde::Serialize;

mod download;
mod metadata;
mod process;
mod provision;

/// Une vidéo listée. Les noms de champs miroir `PodcastEpisode` (camelCase) pour
/// que le funnel et le gestionnaire d'import soient mutualisés côté JS : `audioUrl`
/// porte ici l'URL **de la vidéo** (consommée par `download_youtube_audio`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeVideo {
    pub id: String,
    pub selection_key: String,
    /// Position absolue dans la source, utilisée pour garder un ordre stable
    /// lorsque la sélection couvre plusieurs pages.
    pub source_index: usize,
    pub title: String,
    pub audio_url: String,
    pub duration: Option<String>,
    pub image_url: Option<String>,
}

/// Résultat d'une URL YouTube, miroir de `PodcastFeed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeList {
    pub title: String,
    pub image_url: Option<String>,
    pub videos: Vec<YoutubeVideo>,
    pub page: usize,
    pub page_size: usize,
    /// Déterminé en demandant une entrée sentinelle après la page courante.
    pub has_next: bool,
}

pub use download::download_audio;
pub use metadata::fetch_list;
pub(crate) use provision::update_ytdlp as update_ytdlp_binary;

#[cfg(test)]
mod tests {
    use super::metadata::{
        format_duration, normalize_listing_url, page_window, parse_list_json, validate_youtube_url,
    };

    #[test]
    fn accepts_youtube_hosts_only() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=abc").is_ok());
        assert!(validate_youtube_url("https://youtu.be/abc").is_ok());
        assert!(validate_youtube_url("https://music.youtube.com/playlist?list=x").is_ok());
        assert!(validate_youtube_url("https://youtube.com/@handle").is_ok());
        assert!(validate_youtube_url("http://example.com/watch?v=abc").is_err());
        assert!(validate_youtube_url("https://vimeo.com/123").is_err());
        assert!(validate_youtube_url("ftp://youtube.com/x").is_err());
    }

    #[test]
    fn formats_duration_seconds() {
        assert_eq!(format_duration(Some(0.0)).as_deref(), None);
        assert_eq!(format_duration(Some(75.0)).as_deref(), Some("1:15"));
        assert_eq!(format_duration(Some(3661.0)).as_deref(), Some("1:01:01"));
        assert_eq!(format_duration(None), None);
    }

    #[test]
    fn parses_single_video_json() {
        let json = serde_json::json!({
            "id": "vid123",
            "title": "Une vidéo",
            "webpage_url": "https://www.youtube.com/watch?v=vid123",
            "duration": 90.0,
            "thumbnail": "https://i.ytimg.com/vi/vid123/hqdefault.jpg"
        });
        let list = parse_list_json(json, 1, 400);
        assert_eq!(list.title, "Une vidéo");
        assert_eq!(list.videos.len(), 1);
        assert_eq!(list.videos[0].id, "vid123");
        assert_eq!(list.videos[0].selection_key, "vid123#1");
        assert_eq!(list.videos[0].source_index, 1);
        assert_eq!(
            list.videos[0].audio_url,
            "https://www.youtube.com/watch?v=vid123"
        );
        assert_eq!(list.videos[0].duration.as_deref(), Some("1:30"));
        assert!(!list.has_next);
    }

    #[test]
    fn parses_playlist_json_with_entries_and_id_fallback() {
        let json = serde_json::json!({
            "_type": "playlist",
            "title": "Ma playlist",
            "entries": [
                { "id": "a1", "title": "Ep 1", "url": "https://www.youtube.com/watch?v=a1", "duration": 60.0 },
                // Pas d'URL : on reconstruit l'URL de visionnage depuis l'id.
                { "id": "b2", "title": "Ep 2", "duration": 120.0 },
                // Entrée sans id ni url : ignorée.
                { "title": "Cassée" }
            ]
        });
        let list = parse_list_json(json, 1, 400);
        assert_eq!(list.title, "Ma playlist");
        assert_eq!(list.videos.len(), 2);
        assert_eq!(
            list.videos[1].audio_url,
            "https://www.youtube.com/watch?v=b2"
        );
        assert_eq!(
            list.videos[0].image_url.as_deref(),
            Some("https://i.ytimg.com/vi/a1/hqdefault.jpg")
        );
    }

    #[test]
    fn reports_next_page_when_page_size_is_exceeded() {
        let entries: Vec<_> = (0..4)
            .map(|i| serde_json::json!({ "id": format!("id{i}"), "title": format!("v{i}") }))
            .collect();
        let json = serde_json::json!({ "title": "Grosse chaîne", "entries": entries });
        let list = parse_list_json(json, 1, 3);
        assert_eq!(list.videos.len(), 3);
        assert!(list.has_next);
    }

    #[test]
    fn exact_page_has_no_next_and_empty_ids_get_unique_keys() {
        let entries: Vec<_> = (0..3)
            .map(|i| {
                serde_json::json!({
                    "title": format!("v{i}"),
                    "url": format!("https://www.youtube.com/watch?v=url{i}")
                })
            })
            .collect();
        let json = serde_json::json!({ "title": "Pile", "entries": entries });
        let list = parse_list_json(json, 1, 3);
        assert_eq!(list.videos.len(), 3);
        assert!(!list.has_next);
        assert_eq!(list.videos[0].selection_key, "video-1");
        assert_eq!(list.videos[1].selection_key, "video-2");
    }

    #[test]
    fn second_page_uses_absolute_indices_for_selection_keys() {
        let entries: Vec<_> = (0..3)
            .map(|i| serde_json::json!({ "id": format!("id{i}"), "title": format!("v{i}") }))
            .collect();
        let json = serde_json::json!({ "title": "Page suivante", "entries": entries });
        let list = parse_list_json(json, 2, 400);
        assert_eq!(list.page, 2);
        assert_eq!(list.page_size, 400);
        assert_eq!(list.videos[0].source_index, 401);
        assert_eq!(list.videos[0].selection_key, "id0#401");
        assert_eq!(list.videos[2].selection_key, "id2#403");
    }

    #[test]
    fn channel_media_tab_uses_channel_name_as_list_title() {
        let json = serde_json::json!({
            "title": "Exemple - Videos",
            "channel": "Exemple",
            "webpage_url": "https://www.youtube.com/@example/videos",
            "entries": [{ "id": "id1", "title": "Vidéo" }]
        });
        let list = parse_list_json(json, 1, 400);
        assert_eq!(list.title, "Exemple");
    }

    #[test]
    fn computes_inclusive_ytdlp_page_window_with_sentinel() {
        assert_eq!(page_window(1, 400), Ok((1, 401)));
        assert_eq!(page_window(2, 400), Ok((401, 801)));
        assert!(page_window(0, 400).is_err());
        assert!(page_window(1, 0).is_err());
    }

    #[test]
    fn normalizes_bare_channel_urls_to_videos_tab() {
        assert_eq!(
            normalize_listing_url("https://www.youtube.com/@example").unwrap(),
            "https://www.youtube.com/@example/videos"
        );
        assert_eq!(
            normalize_listing_url("https://youtube.com/channel/UC123?si=share").unwrap(),
            "https://youtube.com/playlist?list=UU123"
        );
        assert_eq!(
            normalize_listing_url("https://youtube.com/@example/featured").unwrap(),
            "https://youtube.com/@example/videos"
        );
    }

    #[test]
    fn topic_channel_id_uses_its_uploads_playlist() {
        assert_eq!(
            normalize_listing_url("https://www.youtube.com/channel/UCSfN2aeHSOJAF7ijtDu9ndQ")
                .unwrap(),
            "https://www.youtube.com/playlist?list=UUSfN2aeHSOJAF7ijtDu9ndQ"
        );
    }

    #[test]
    fn preserves_explicit_tabs_playlists_and_video_urls() {
        for url in [
            "https://www.youtube.com/@example/videos",
            "https://www.youtube.com/@example/shorts",
            "https://www.youtube.com/@example/streams",
            "https://www.youtube.com/playlist?list=PL123",
            "https://youtu.be/abc123",
        ] {
            assert_eq!(normalize_listing_url(url).unwrap(), url);
        }
    }
}
