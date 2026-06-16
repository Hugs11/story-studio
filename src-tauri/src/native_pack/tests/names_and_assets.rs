use super::*;

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
        auto_next: false,
        select_next: false,
        night_mode: false,
    };
    let with_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Add,
        auto_next: false,
        select_next: false,
        night_mode: false,
    };

    assert_eq!(
        audio_filters(&no_silence, false),
        "aformat=channel_layouts=mono"
    );
    assert_eq!(
        audio_filters(&with_silence, false),
        "aformat=channel_layouts=mono,adelay=500,apad=pad_dur=0.5"
    );
    assert_eq!(
        audio_filters(&with_silence, true),
        "aformat=channel_layouts=mono"
    );
}

#[test]
fn builds_audio_filters_with_gain_limiter_before_silence() {
    let with_silence = CanonicalOptions {
        silence_mode: crate::domain::project::SilenceMode::Add,
        auto_next: false,
        select_next: false,
        night_mode: false,
    };

    assert_eq!(
        audio_filters_with_action(
            &with_silence,
            false,
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
        auto_next: false,
        select_next: false,
        night_mode: false,
    };

    assert_eq!(
        audio_filters_with_duration(&with_silence, false, 1.0),
        "aformat=channel_layouts=mono,adelay=1000,apad=pad_dur=1"
    );
}
