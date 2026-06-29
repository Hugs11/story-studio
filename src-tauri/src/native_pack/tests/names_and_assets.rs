use super::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use std::io::{Cursor, Read};

#[test]
fn sanitizes_project_name_for_export_zip() {
    assert_eq!(
        sanitized_project_name("Nom de l'histoire !"),
        "Nom_de_l_histoire"
    );
    assert_eq!(
        sanitized_project_name("3+]RTL-mon_histoire(8_chapitres)[by_hugs_V1"),
        "3+]RTL-mon_histoire(8_chapitres)[by_hugs_V1"
    );
    assert_eq!(sanitized_project_name("///"), "story-studio");
}

#[test]
fn scoped_label_id_keeps_duplicate_names_distinct_when_ids_differ() {
    let mut labels = std::collections::HashSet::new();
    for index in 0..50 {
        let id = format!("story{index:03}-id");
        let label = scoped_label_id("root", &id, "Histoire");
        assert!(label.ends_with(&format!("#{id}")));
        assert!(labels.insert(label));
    }

    for (id, name) in [
        ("empty-id", ""),
        ("unicode-id", "Été nuit"),
        ("spaces-id", "  Nom avec espaces  "),
        ("special-id", "Nom / spécial ?"),
    ] {
        let label = scoped_label_id("root", id, name);
        assert!(
            labels.insert(label),
            "label should be unique for id/name pair {id:?}/{name:?}"
        );
    }
}

#[test]
fn scoped_label_id_keeps_ids_unique_beyond_first_eight_chars() {
    assert_ne!(
        scoped_label_id("root", "story-id-alpha", "Histoire"),
        scoped_label_id("root", "story-id-beta", "Histoire")
    );
}

#[test]
fn scoped_label_id_documents_empty_id_fallback() {
    assert_eq!(scoped_label_id("root", "", "  "), "root/(sans nom)");
    assert_eq!(scoped_label_id("root", "", "Histoire"), "root/Histoire");
}

#[test]
fn export_zip_path_adds_numeric_suffix_on_collision() {
    let base = std::env::temp_dir().join(format!("story_studio_export_name_test_{}", now_millis()));
    fs::create_dir_all(&base).expect("create test dir");

    let first = export_zip_path(&base, "Nom de l'histoire");
    assert_eq!(
        first.file_name().and_then(|value| value.to_str()),
        Some("Nom_de_l_histoire.zip")
    );

    fs::write(&first, b"test").expect("seed first zip");

    let second = export_zip_path(&base, "Nom de l'histoire");
    assert_eq!(
        second.file_name().and_then(|value| value.to_str()),
        Some("Nom_de_l_histoire-2.zip")
    );

    let _ = fs::remove_dir_all(base);
}

#[test]
fn writes_catalog_thumbnail_as_png_even_when_source_is_jpeg() {
    let base =
        std::env::temp_dir().join(format!("story_studio_thumbnail_png_test_{}", now_millis()));
    fs::create_dir_all(&base).expect("create test dir");

    let thumbnail_source = base.join("source-thumbnail.jpg");
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 4, Rgb([12, 34, 56])));
    let mut jpeg_bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut jpeg_bytes), ImageFormat::Jpeg)
        .expect("encode jpeg thumbnail");
    fs::write(&thumbnail_source, jpeg_bytes).expect("write thumbnail source");

    let report = report_for(
        CanonicalProject {
            name: "Thumbnail Test".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: None,
            root_image: None,
            thumbnail_image: Some(thumbnail_source.to_string_lossy().to_string()),
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: false,
            },
            entries: Vec::new(),

            shared_entries: Vec::new(),
        },
        Vec::new(),
        Vec::new(),
    );
    let document = StoryDocument {
        title: "Thumbnail Test".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: Vec::new(),
        stage_nodes: Vec::new(),
    };

    let zip_path = write_native_pack_zip(&report, &document, &base.join("out")).expect("write zip");
    let file = fs::File::open(&zip_path).expect("open generated zip");
    let mut archive = zip::ZipArchive::new(file).expect("read generated zip");
    assert!(archive.by_name("thumbnail.jpg").is_err());
    let mut thumbnail = archive.by_name("thumbnail.png").expect("thumbnail.png");
    let mut png_bytes = Vec::new();
    thumbnail
        .read_to_end(&mut png_bytes)
        .expect("read thumbnail.png");
    assert!(png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));

    let _ = fs::remove_dir_all(base);
}

#[test]
fn processed_audio_output_name_stays_short_for_deep_roles() {
    let role = "root/Deep Path Pack#packid01/Level 01 Branch#branch01/Level 02 Branch#branch02/Level 03 Branch#branch03/Level 04 Branch#branch04/deep-audio-item#asset001/storyAudio";
    let output_name = processed_audio_output_name(role);

    assert!(output_name.ends_with(".mp3"));
    assert!(output_name.len() < 120);
    assert!(!output_name.contains('/'));
    assert!(!output_name.contains('\\'));
}

#[test]
fn detects_native_compatible_mp3_header() {
    let compatible = [0xff, 0xfb, 0x90, 0xc0];
    let stereo = [0xff, 0xfb, 0x90, 0x00];
    let forty_eight_khz = [0xff, 0xfb, 0x94, 0xc0];

    assert!(mp3_header_is_native_compatible(&compatible));
    assert!(!mp3_header_is_native_compatible(&stereo));
    assert!(!mp3_header_is_native_compatible(&forty_eight_khz));
}

#[test]
fn detects_mp3_frame_after_id3_header() {
    let mut bytes = b"ID3\x04\0\0\0\0\0\x05abcde".to_vec();
    bytes.extend_from_slice(&[0xff, 0xfb, 0x90, 0xc0]);

    assert!(mp3_header_is_native_compatible(&bytes));
}

#[test]
fn builds_audio_filters_with_shared_normalizer() {
    let no_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Off,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: false,
    };
    let with_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Add,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: false,
    };

    assert_eq!(audio_filters(&no_silence), "aformat=channel_layouts=mono");
    assert_eq!(
        audio_filters(&with_silence),
        "aformat=channel_layouts=mono,adelay=500,apad=pad_dur=0.5"
    );
}

#[test]
fn builds_audio_filters_with_gain_limiter_before_silence() {
    let with_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Add,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: false,
    };

    assert_eq!(
        audio_filters_with_action(
            &with_silence,
            0.5,
            &crate::support::audio_norm::LoudnessAction::GainLimit {
                gain_db: 4.0,
                expected_limiting_db: 2.0,
            },
        ),
        "aformat=channel_layouts=mono,volume=4dB,alimiter=limit=0.794328:level=disabled,adelay=500,apad=pad_dur=0.5"
    );
}

#[test]
fn builds_audio_filters_with_configured_silence_duration() {
    let with_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Add,
        harmonize_loudness: true,
        auto_next: false,
        night_mode: false,
    };

    assert_eq!(
        audio_filters_with_duration(&with_silence, 1.0),
        "aformat=channel_layouts=mono,adelay=1000,apad=pad_dur=1"
    );
}
