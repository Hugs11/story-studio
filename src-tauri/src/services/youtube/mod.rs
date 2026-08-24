//! Service YouTube : transforme une URL (vidéo / playlist / chaîne) en
//! histoires audio via **yt-dlp**. Jumeau de `services/podcast`, mais la source
//! est YouTube et l'acquisition passe par le binaire yt-dlp (provisionné au 1er
//! usage, cf. `provision`) qui s'appuie sur le ffmpeg embarqué pour extraire le MP3.
//!
//! Sécurité (invariants `support/`) : arguments en tableau (jamais de shell),
//! `CREATE_NO_WINDOW`, URL bornées aux domaines YouTube, destination bornée au
//! cache privé de l'application, noms de fichiers assainis, plafonds sur la liste
//! et la taille.

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
    /// Langues des formats audio déjà résolus. Vide pour les entrées d'une
    /// playlist plate ; elles sont analysées à la demande après sélection.
    pub audio_languages: Vec<String>,
    pub audio_languages_resolved: bool,
}

/// Langues audio résolues pour une vidéo sélectionnée dans une playlist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeAudioLanguages {
    pub id: String,
    pub languages: Vec<String>,
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
pub use metadata::{fetch_audio_languages, fetch_list};
pub(crate) use provision::update_ytdlp as update_ytdlp_binary;

#[cfg(test)]
mod tests {
    use super::metadata::{
        format_duration, is_channel_source, normalize_listing_url, page_window,
        parse_audio_language_lines, parse_list_json, reorder_numbered_series, validate_youtube_url,
    };
    use super::{download_audio, fetch_list, update_ytdlp_binary};
    use std::path::Path;
    use uuid::Uuid;

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
        assert!(list.videos[0].audio_languages.is_empty());
        assert!(!list.videos[0].audio_languages_resolved);
        assert!(!list.has_next);
    }

    #[test]
    fn extracts_distinct_audio_languages_from_resolved_formats() {
        let json = serde_json::json!({
            "id": "multi123",
            "title": "Vidéo multilingue",
            "webpage_url": "https://www.youtube.com/watch?v=multi123",
            "formats": [
                { "format_id": "137", "vcodec": "avc1", "acodec": "none" },
                { "format_id": "139-0", "vcodec": "none", "acodec": "mp4a", "language": "fr" },
                { "format_id": "140-0", "vcodec": "none", "acodec": "mp4a", "language": "fr" },
                { "format_id": "251-1", "vcodec": "none", "acodec": "opus", "language": "en-US" },
                { "format_id": "18", "vcodec": "avc1", "acodec": "mp4a", "language": "en-US" },
                { "format_id": "broken", "vcodec": "none", "acodec": "opus" }
            ]
        });
        let list = parse_list_json(json, 1, 400);
        assert_eq!(list.videos[0].audio_languages, vec!["fr", "en-US"]);
        assert!(list.videos[0].audio_languages_resolved);
    }

    #[test]
    fn parses_audio_language_json_lines_and_skips_noise() {
        let output = br#"{"id":"one","formats":[{"vcodec":"none","acodec":"opus","language":"ja"}]}
not-json
{"id":"two","formats":[{"vcodec":"none","acodec":"opus","language":"en"},{"vcodec":"none","acodec":"opus","language":"fr"}]}
"#;
        let parsed = parse_audio_language_lines(output);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "one");
        assert_eq!(parsed[0].languages, vec!["ja"]);
        assert_eq!(parsed[1].languages, vec!["en", "fr"]);
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

    #[test]
    fn distinguishes_channel_uploads_from_explicit_playlist_order() {
        assert!(is_channel_source("https://www.youtube.com/channel/UC123").unwrap());
        assert!(is_channel_source("https://www.youtube.com/@example/videos").unwrap());
        assert!(!is_channel_source("https://www.youtube.com/playlist?list=PL123").unwrap());
        assert!(!is_channel_source("https://www.youtube.com/watch?v=abc&list=PL123").unwrap());
        assert!(!is_channel_source("https://youtu.be/abc").unwrap());
    }

    #[test]
    fn naturally_orders_numbered_series_without_moving_unrelated_videos() {
        let json = serde_json::json!({
            "title": "Uploads",
            "entries": [
                { "id": "p1", "title": "Le Jouet magique, Pt. 01" },
                { "id": "other", "title": "Une autre histoire" },
                { "id": "p3", "title": "Le Jouet magique, Pt. 03" },
                { "id": "p4", "title": "Le Jouet magique, Pt. 04" },
                { "id": "p5", "title": "Le Jouet magique, Pt. 05" },
                { "id": "p2", "title": "Le Jouet magique, Pt. 02" }
            ]
        });
        let mut list = parse_list_json(json, 1, 400);
        reorder_numbered_series(&mut list.videos);
        assert_eq!(
            list.videos
                .iter()
                .map(|video| video.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p1", "other", "p2", "p3", "p4", "p5"]
        );
    }

    #[test]
    #[ignore = "requires live GitHub and YouTube access plus the prepared native FFmpeg"]
    fn live_linux_updates_lists_and_downloads_with_native_tools() {
        assert!(
            std::env::consts::OS == "linux" && std::env::consts::ARCH == "x86_64",
            "this external suite must run on Linux x86_64"
        );

        let root =
            std::env::temp_dir().join(format!("story_studio_youtube_live_été_{}", Uuid::new_v4()));
        let home = root.join("données YouTube");
        std::fs::create_dir_all(&home).expect("create live YouTube home");
        let emit = |message: &str| eprintln!("{message}");
        let installed = update_ytdlp_binary(&home, &emit).expect("forced yt-dlp update");

        let custom_dir = root.join("outil avec espaces et accents été");
        std::fs::create_dir_all(&custom_dir).expect("create custom yt-dlp directory");
        let custom = custom_dir.join("yt-dlp");
        std::fs::copy(&installed, &custom).expect("copy custom yt-dlp");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&custom, std::fs::Permissions::from_mode(0o755))
                .expect("make custom yt-dlp executable");
        }

        let video_url = std::env::var("STORY_STUDIO_YOUTUBE_VIDEO_URL")
            .unwrap_or_else(|_| "https://www.youtube.com/watch?v=PIMtEh8qo4o".to_string());
        let video = fetch_list(
            &home,
            Some(custom.to_string_lossy().as_ref()),
            &video_url,
            1,
            &emit,
        )
        .expect("read public video metadata");
        assert_eq!(video.videos.len(), 1);

        let playlist_url =
            std::env::var("STORY_STUDIO_YOUTUBE_PLAYLIST_URL").unwrap_or_else(|_| {
                "https://www.youtube.com/playlist?list=PLxrLFHZQc8nqMzvzB0Ml0nGWgjnB9HO7f"
                    .to_string()
            });
        let playlist =
            fetch_list(&home, None, &playlist_url, 1, &emit).expect("read public playlist fixture");
        assert!(playlist.videos.len() > 1);
        assert_eq!(playlist.page, 1);

        let output = download_audio(
            &home,
            &root.join("downloads"),
            None,
            &video_url,
            "validation été avec espaces",
            None,
            &emit,
        )
        .expect("download public video audio");
        let output = Path::new(&output);
        assert!(output.is_file());
        assert!(std::fs::metadata(output).unwrap().len() > 0);
        std::fs::remove_file(output).expect("remove downloaded audio fixture");
        std::fs::remove_dir_all(root).expect("clean live YouTube fixture");
    }
}
