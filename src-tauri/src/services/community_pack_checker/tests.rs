use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ::image::{ImageBuffer, Rgba};

use super::*;
use crate::support::audio_norm::{edges_from_envelope, parse_rms_envelope, EdgeMeasure};
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};

#[test]
fn report_counts_automatic_and_optional_corrections_separately() {
    let mut report = empty_report("silences", "/tmp/silences.zip");
    let mut long = models::issue(
        models::PackValidationSeverity::Info,
        "audio",
        "Audio",
        "Silence long",
    );
    long.auto_fix_available = true;
    long.fix_disposition = models::FixDisposition::Optional;
    let mut short = models::issue(
        models::PackValidationSeverity::Error,
        "audio",
        "Audio",
        "Silence court",
    );
    short.auto_fix_available = true;
    short.fix_disposition = models::FixDisposition::Automatic;
    report.issues = vec![long, short];

    let report = finalize_report(report, false);
    assert_eq!(report.summary.infos, 1);
    assert_eq!(report.summary.errors, 1);
    assert_eq!(report.corrections_available, 1);
    assert_eq!(report.optional_corrections_available, 1);
    assert_eq!(report.verdict, models::PackValidationVerdict::NeedsFix);
}

#[test]
fn optional_silence_suggestion_alone_keeps_pack_valid() {
    let mut report = empty_report("silences", "/tmp/silences.zip");
    let mut long = models::issue(
        models::PackValidationSeverity::Info,
        "audio",
        "Audio",
        "Silence long",
    );
    long.auto_fix_available = true;
    long.fix_disposition = models::FixDisposition::Optional;
    report.issues.push(long);

    let report = finalize_report(report, false);
    assert_eq!(report.verdict, models::PackValidationVerdict::Valid);
    assert_eq!(report.corrections_available, 0);
    assert_eq!(report.optional_corrections_available, 1);
}

#[test]
fn optional_audio_silence_selection_is_validated_and_deduplicated() {
    let mut report = empty_report("silences", "/tmp/silences.zip");
    report.audio_items.push(test_audio_item("assets/test.mp3"));
    let mut suggestion = models::issue(
        models::PackValidationSeverity::Info,
        "audio",
        "Audio",
        "Silence de fin long",
    );
    suggestion.file_path = Some("assets/test.mp3".to_string());
    suggestion.code = Some("audioTrailingSilenceLong".to_string());
    suggestion.fix_disposition = models::FixDisposition::Optional;
    suggestion.auto_fix_available = true;
    report.issues.push(suggestion);

    let selected = models::OptionalAudioSilenceSelection {
        file_path: "assets/test.mp3".to_string(),
        edge: models::AudioSilenceEdge::Trailing,
    };
    let plans = build_audio_fix_plans(
        &report,
        models::PackCorrectionSelection {
            optional_audio_silences: vec![selected.clone(), selected],
        },
    )
    .expect("valid selection");
    assert_eq!(plans.len(), 1);
    assert!(!plans[0].plan.rebuild_leading_silence);
    assert!(plans[0].plan.rebuild_trailing_silence);

    let invalid = build_audio_fix_plans(
        &report,
        models::PackCorrectionSelection {
            optional_audio_silences: vec![models::OptionalAudioSilenceSelection {
                file_path: "assets/test.mp3".to_string(),
                edge: models::AudioSilenceEdge::Leading,
            }],
        },
    );
    assert!(invalid
        .expect_err("stale selection must fail")
        .contains("inconnue ou obsolète"));

    let excessive = build_audio_fix_plans(
        &report,
        models::PackCorrectionSelection {
            optional_audio_silences: vec![
                models::OptionalAudioSilenceSelection {
                    file_path: "assets/test.mp3".to_string(),
                    edge: models::AudioSilenceEdge::Trailing,
                };
                3
            ],
        },
    );
    assert!(excessive
        .expect_err("selection count must be bounded")
        .contains("Trop de suggestions audio sélectionnées"));
}

#[test]
fn format_only_fix_plan_does_not_rebuild_measured_edges() {
    let mut item = test_audio_item("assets/test.wav");
    item.codec = Some("pcm_s16le".to_string());
    item.sample_rate = Some(48_000);
    item.channels = Some("stereo".to_string());
    let mut format_issue = models::issue(
        models::PackValidationSeverity::Error,
        "audio",
        "Audio",
        "Format incorrect",
    );
    format_issue.file_path = Some(item.file_path.clone());
    format_issue.auto_fix_available = true;
    format_issue.fix_disposition = models::FixDisposition::Automatic;

    let plan = audio::automatic_fix_plan(&item, &[format_issue]);
    assert!(plan.fix_format_or_channels);
    assert!(!plan.fix_loudness);
    assert!(!plan.rebuild_leading_silence);
    assert!(!plan.rebuild_trailing_silence);
}

fn test_audio_item(file_path: &str) -> models::AudioValidationItem {
    models::AudioValidationItem {
        file_path: file_path.to_string(),
        label: "Audio".to_string(),
        item_type: "story".to_string(),
        status: "info".to_string(),
        auto_fix_available: true,
        fix_summary: None,
        duration_secs: Some(2.8),
        codec: Some("mp3".to_string()),
        sample_rate: Some(44_100),
        channels: Some("mono".to_string()),
        leading_silence_secs: Some(0.4),
        trailing_silence_secs: Some(1.5),
        integrated_lufs: Some(-14.0),
        true_peak_db: Some(-2.0),
    }
}

#[test]
fn silent_title_stage_is_not_treated_as_missing_audio() {
    let dir = temp_dir("silent_title_stage");
    fs::create_dir_all(&dir).expect("create temp dir");
    let zip_path = dir.join("silent-title.zip");
    write_studio_zip(
        &zip_path,
        serde_json::json!({
            "format": "v1",
            "version": 1,
            "title": "Titre silencieux",
            "stageNodes": [
                {
                    "uuid": "title-silent",
                    "name": "Titre silencieux",
                    "audio": null,
                    "image": "cover.png",
                    "controlSettings": {
                        "wheel": true, "ok": true, "home": true,
                        "pause": false, "autoplay": false
                    },
                    "okTransition": { "actionNode": "play-action", "optionIndex": 0 }
                },
                {
                    "uuid": "story-play",
                    "name": "Lecture",
                    "audio": "story.mp3",
                    "controlSettings": {
                        "wheel": false, "ok": false, "home": true,
                        "pause": true, "autoplay": true
                    }
                }
            ],
            "actionNodes": [{ "id": "play-action", "options": ["story-play"] }]
        }),
        &[
            ("cover.png", png_bytes(320, 240)),
            ("story.mp3", vec![1, 2, 3]),
        ],
    );

    let doc = zip_doc::read_pack_doc(&zip_path).expect("load pack document");
    assert_eq!(doc.audio_refs.len(), 1);
    assert_eq!(doc.audio_refs[0].stage_id, "story-play");
    assert!(doc
        .audio_refs
        .iter()
        .all(|asset| asset.stage_id != "title-silent"));

    let mut report = empty_report("silent-title", &zip_path.to_string_lossy());
    validate_asset_presence(&doc, &mut report);
    assert!(report.issues.iter().all(|issue| {
        issue
            .technical_details
            .as_deref()
            .is_none_or(|details| !details.contains("title-silent"))
    }));

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn image_fix_creates_new_zip_without_overwriting_source() {
    let dir = temp_dir("image_fix");
    fs::create_dir_all(&dir).expect("create temp dir");
    let zip_path = dir.join("pack-image.zip");
    let cover = png_bytes(512, 512);
    write_studio_zip(
        &zip_path,
        story_with_image_only("cover.png"),
        &[("cover.png", cover)],
    );

    let report = analyze_pack(&zip_path);
    assert_eq!(report.image_summary.total, 1);
    assert_eq!(report.image_summary.warnings, 1);
    assert!(report.corrections_available > 0);

    let fixed = create_fixed_pack(&zip_path, None).expect("create fixed pack");
    assert_ne!(fixed.source_zip_path, fixed.fixed_zip_path);
    assert!(zip_path.is_file());
    assert!(PathBuf::from(&fixed.fixed_zip_path).is_file());

    let original =
        zip_doc::read_zip_entry_bytes(&zip_path, "assets/cover.png").expect("read original image");
    let fixed_bytes =
        zip_doc::read_zip_entry_bytes(Path::new(&fixed.fixed_zip_path), "assets/cover.png")
            .expect("read fixed image");
    let original_img = ::image::load_from_memory(&original).expect("decode original");
    let fixed_img = ::image::load_from_memory(&fixed_bytes).expect("decode fixed");
    assert_eq!((original_img.width(), original_img.height()), (512, 512));
    assert_eq!((fixed_img.width(), fixed_img.height()), (320, 240));

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn fixed_zip_uses_source_archive_name_after_temporary_conversion() {
    let dir = temp_dir("source_archive_name");
    let output_dir = dir.join("out");
    fs::create_dir_all(&output_dir).expect("create output dir");
    let analysis_zip = dir.join("cache.zip");
    let source_path = dir.join("3+]Suzanne et Gaston.7z");
    fs::write(&source_path, b"archive source").expect("write source placeholder");
    write_studio_zip(
        &analysis_zip,
        story_with_image_only("cover.png"),
        &[("cover.png", png_bytes(512, 512))],
    );

    let fixed = create_fixed_pack_with_source_log(
        &analysis_zip,
        &source_path,
        Some(&output_dir),
        None,
        None,
        &|_| {},
    )
    .expect("create fixed pack");

    assert_eq!(
        fixed.source_zip_path,
        source_path.to_string_lossy().to_string()
    );
    assert_eq!(
        PathBuf::from(&fixed.fixed_zip_path)
            .file_name()
            .and_then(|value| value.to_str()),
        Some("3+]Suzanne et Gaston - corrigé.zip")
    );

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn audio_silence_is_evaluated_per_file_when_ffmpeg_is_available() {
    let Ok(ffmpeg) = get_ffmpeg_path() else {
        return;
    };
    let dir = temp_dir("audio_silence");
    fs::create_dir_all(&dir).expect("create temp dir");
    let ok_audio = dir.join("ok.mp3");
    let short_audio = dir.join("short.mp3");
    make_audio_with_edge_silence(&ffmpeg, &ok_audio, 0.6).expect("create ok audio");
    make_audio_with_edge_silence(&ffmpeg, &short_audio, 0.3).expect("create short audio");

    let zip_path = dir.join("pack-audio.zip");
    write_studio_zip(
        &zip_path,
        story_with_two_audios("ok.mp3", "short.mp3"),
        &[
            ("ok.mp3", fs::read(&ok_audio).expect("read ok audio")),
            (
                "short.mp3",
                fs::read(&short_audio).expect("read short audio"),
            ),
            ("cover.png", png_bytes(320, 240)),
        ],
    );

    let report = analyze_pack(&zip_path);
    let short_silence_warnings = report
        .issues
        .iter()
        .filter(|issue| issue.file_path.as_deref() == Some("assets/short.mp3"))
        .filter(|issue| issue.message.contains("silence"))
        .count();
    let ok_silence_warnings = report
        .issues
        .iter()
        .filter(|issue| issue.file_path.as_deref() == Some("assets/ok.mp3"))
        .filter(|issue| issue.message.contains("silence"))
        .count();
    assert!(short_silence_warnings >= 1);
    assert_eq!(ok_silence_warnings, 0);

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn selective_silence_fix_preserves_or_rebuilds_trailing_edge_as_requested() {
    let Ok(ffmpeg) = get_ffmpeg_path() else {
        return;
    };
    let dir = temp_dir("selective_silence_fix");
    fs::create_dir_all(&dir).expect("create temp dir");
    let input = dir.join("input.mp3");
    let automatic_output = dir.join("automatic.mp3");
    let selected_output = dir.join("selected.mp3");
    make_asymmetric_audio(&ffmpeg, &input, TestAudioSpec::mp3(0.30, 1.50, "8dB"))
        .expect("create asymmetric audio");

    let (item, issues) = audio::analyze_audio_file(&ffmpeg, &input, "input.mp3", "Audio", "story");
    assert!(issues.iter().any(|issue| {
        issue.code.as_deref() == Some("audioLeadingSilenceTooShort")
            && issue.fix_disposition == models::FixDisposition::Automatic
    }));
    assert!(issues.iter().any(|issue| {
        issue.code.as_deref() == Some("audioTrailingSilenceLong")
            && issue.fix_disposition == models::FixDisposition::Optional
    }));

    let automatic_plan = audio::automatic_fix_plan(&item, &issues);
    assert!(automatic_plan.rebuild_leading_silence);
    assert!(!automatic_plan.rebuild_trailing_silence);
    audio::fix_audio_file(&ffmpeg, &input, &automatic_output, &item, automatic_plan)
        .expect("apply automatic fix");
    let (leading, trailing) = measured_edges(&ffmpeg, &automatic_output);
    assert!((leading - 0.4).abs() < 0.14, "début corrigé : {leading}");
    assert!((trailing - 1.5).abs() < 0.16, "fin préservée : {trailing}");

    let selected_plan = audio::AudioFixPlan {
        rebuild_trailing_silence: true,
        ..automatic_plan
    };
    audio::fix_audio_file(&ffmpeg, &input, &selected_output, &item, selected_plan)
        .expect("apply selected fix");
    let (leading, trailing) = measured_edges(&ffmpeg, &selected_output);
    assert!((leading - 0.4).abs() < 0.14, "début corrigé : {leading}");
    assert!((trailing - 0.4).abs() < 0.14, "fin corrigée : {trailing}");

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn format_and_loudness_fixes_preserve_unselected_long_edges() {
    let Ok(ffmpeg) = get_ffmpeg_path() else {
        return;
    };
    let dir = temp_dir("preserve_long_edges");
    fs::create_dir_all(&dir).expect("create temp dir");

    let format_input = dir.join("format.wav");
    let format_output = dir.join("format-fixed.mp3");
    make_asymmetric_audio(
        &ffmpeg,
        &format_input,
        TestAudioSpec {
            leading_silence_sec: 1.50,
            trailing_silence_sec: 1.50,
            sample_rate: 48_000,
            channels: 2,
            codec: "pcm_s16le",
            volume: "8dB",
        },
    )
    .expect("create nonconforming format");
    let (format_item, format_issues) =
        audio::analyze_audio_file(&ffmpeg, &format_input, "format.wav", "Audio", "story");
    let format_plan = audio::automatic_fix_plan(&format_item, &format_issues);
    assert!(format_plan.fix_format_or_channels);
    assert!(!format_plan.rebuild_leading_silence);
    assert!(!format_plan.rebuild_trailing_silence);
    audio::fix_audio_file(
        &ffmpeg,
        &format_input,
        &format_output,
        &format_item,
        format_plan,
    )
    .expect("fix format");
    let (leading, trailing) = measured_edges(&ffmpeg, &format_output);
    assert!(leading > 1.30, "début format préservé : {leading}");
    assert!(trailing > 1.30, "fin format préservée : {trailing}");

    let loudness_input = dir.join("quiet.mp3");
    let loudness_output = dir.join("quiet-fixed.mp3");
    make_asymmetric_audio(
        &ffmpeg,
        &loudness_input,
        TestAudioSpec::mp3(1.50, 1.50, "-18dB"),
    )
    .expect("create quiet audio");
    let (loudness_item, loudness_issues) =
        audio::analyze_audio_file(&ffmpeg, &loudness_input, "quiet.mp3", "Audio", "story");
    let loudness_plan = audio::automatic_fix_plan(&loudness_item, &loudness_issues);
    assert!(loudness_plan.fix_loudness);
    assert!(!loudness_plan.rebuild_leading_silence);
    assert!(!loudness_plan.rebuild_trailing_silence);
    audio::fix_audio_file(
        &ffmpeg,
        &loudness_input,
        &loudness_output,
        &loudness_item,
        loudness_plan,
    )
    .expect("fix loudness");
    let (leading, trailing) = measured_edges(&ffmpeg, &loudness_output);
    assert!(leading > 1.30, "début loudness préservé : {leading}");
    assert!(trailing > 1.30, "fin loudness préservée : {trailing}");

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn fixed_zip_reanalysis_reflects_optional_silence_selection() {
    let Ok(ffmpeg) = get_ffmpeg_path() else {
        return;
    };
    let dir = temp_dir("fixed_zip_optional_selection");
    fs::create_dir_all(&dir).expect("create temp dir");
    let audio_path = dir.join("input.mp3");
    make_asymmetric_audio(&ffmpeg, &audio_path, TestAudioSpec::mp3(0.30, 1.50, "8dB"))
        .expect("create audio");
    let zip_path = dir.join("pack.zip");
    write_studio_zip(
        &zip_path,
        story_with_single_audio("input.mp3"),
        &[
            ("input.mp3", fs::read(&audio_path).expect("read audio")),
            ("cover.png", png_bytes(320, 240)),
        ],
    );
    let source_before = fs::read(&zip_path).expect("read source before");
    let initial = analyze_pack(&zip_path);
    assert_eq!(initial.corrections_available, 1);
    assert_eq!(initial.optional_corrections_available, 1);

    let automatic = create_fixed_pack(&zip_path, None).expect("create automatic fixed pack");
    let automatic_report = analyze_pack(Path::new(&automatic.fixed_zip_path));
    assert!(!automatic_report
        .issues
        .iter()
        .any(|issue| { issue.code.as_deref() == Some("audioLeadingSilenceTooShort") }));
    assert!(automatic_report
        .issues
        .iter()
        .any(|issue| { issue.code.as_deref() == Some("audioTrailingSilenceLong") }));

    let selected = create_fixed_pack_with_log(
        &zip_path,
        None,
        None,
        Some(models::PackCorrectionSelection {
            optional_audio_silences: vec![models::OptionalAudioSilenceSelection {
                file_path: "assets/input.mp3".to_string(),
                edge: models::AudioSilenceEdge::Trailing,
            }],
        }),
        &|_| {},
    )
    .expect("create selected fixed pack");
    let selected_report = analyze_pack(Path::new(&selected.fixed_zip_path));
    assert!(!selected_report.issues.iter().any(|issue| {
        matches!(
            issue.code.as_deref(),
            Some("audioLeadingSilenceTooShort" | "audioTrailingSilenceLong")
        )
    }));
    assert_eq!(
        fs::read(&zip_path).expect("read source after"),
        source_before
    );

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

const WIN: f64 = 1024.0 / 44_100.0; // ≈ 0.02322 s, comme la passe enveloppe

/// Construit une enveloppe `(temps, RMS)` à partir de segments `(niveau_dB, nb_fenêtres)`.
fn build_env(segments: &[(f64, usize)]) -> Vec<(f64, f64)> {
    let mut env = Vec::new();
    let mut time = 0.0;
    for (level, count) in segments {
        for _ in 0..*count {
            env.push((time, *level));
            time += WIN;
        }
    }
    env
}

fn measured(measure: EdgeMeasure) -> (f64, f64) {
    match measure {
        EdgeMeasure::Measured { leading, trailing } => {
            (models::round_secs(leading), models::round_secs(trailing))
        }
        other => panic!("attendu Measured, obtenu {:?}", other),
    }
}

#[test]
fn rms_envelope_parser_reads_pairs_and_handles_inf() {
    let stderr = "\
[Parsed_ametadata_1 @ x] frame:0 pts:0 pts_time:0
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-43.2
[Parsed_ametadata_1 @ x] frame:1 pts:1024 pts_time:0.0232
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-inf
[Parsed_ametadata_1 @ x] frame:2 pts:2048 pts_time:0.0464
[Parsed_ametadata_1 @ x] lavfi.astats.Overall.RMS_level=-12.0
";
    let env = parse_rms_envelope(stderr);
    assert_eq!(env.len(), 3);
    assert_eq!(env[0].0, 0.0);
    assert_eq!(env[0].1, -43.2);
    assert!(!env[1].1.is_finite()); // -inf
    assert_eq!(env[2].1, -12.0);
}

#[test]
fn edges_measure_leading_and_trailing_on_studio_like_floor() {
    // Plancher de bruit haut (-43 dB), contenu à -27 dB : silencedetect -50 dB
    // raterait tout ; l'enveloppe RMS sépare proprement.
    let env = build_env(&[(-43.0, 26), (-27.0, 43), (-43.0, 30)]);
    let (leading, trailing) = measured(edges_from_envelope(&env));
    assert!((leading - 26.0 * WIN).abs() < WIN, "début {}", leading);
    assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
}

#[test]
fn edges_measure_trailing_without_relying_on_declared_duration() {
    // Pur silence numérique en fin : doit être mesuré via l'horodatage interne.
    let env = build_env(&[(-12.0, 40), (f64::NEG_INFINITY, 30)]);
    let (leading, trailing) = measured(edges_from_envelope(&env));
    assert_eq!(leading, 0.0);
    assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
}

#[test]
fn edges_ignore_isolated_leading_click() {
    // Un clic isolé d'une fenêtre à t=0 ne doit pas écraser le silence de début.
    let env = build_env(&[(-10.0, 1), (f64::NEG_INFINITY, 20), (-20.0, 30)]);
    let (leading, _) = measured(edges_from_envelope(&env));
    assert!(
        leading > 10.0 * WIN,
        "le clic n'a pas été ignoré : {}",
        leading
    );
}

#[test]
fn edges_do_not_trim_soft_intro() {
    // Intro douce à -34 dB sur un plancher -43 dB : le contenu doit rester
    // contenu (pas classé silence), donc début ≈ 0.
    let env = build_env(&[(-34.0, 40), (-20.0, 40)]);
    let (leading, trailing) = measured(edges_from_envelope(&env));
    assert_eq!(leading, 0.0, "intro douce rognée à tort");
    assert_eq!(trailing, 0.0);
}

#[test]
fn edges_all_silence_for_pure_digital_silence() {
    let env = build_env(&[(f64::NEG_INFINITY, 50)]);
    assert_eq!(edges_from_envelope(&env), EdgeMeasure::AllSilence);
}

#[test]
fn edges_unreadable_for_empty_envelope() {
    assert_eq!(edges_from_envelope(&[]), EdgeMeasure::Unreadable);
}

#[test]
fn long_title_is_allowed_when_zip_name_matches_community_convention() {
    let dir = temp_dir("community_name");
    fs::create_dir_all(&dir).expect("create temp dir");
    let zip_path = dir.join("2+]Radio_France_-_Les_Histoires_good_Pack_communautaire.zip");
    write_studio_zip(
        &zip_path,
        story_with_long_title("Un titre assez long pour dépasser quarante caractères"),
        &[("cover.png", png_bytes(320, 240))],
    );

    let report = analyze_pack(&zip_path);
    assert!(report.issues.iter().any(|issue| {
        issue.category == "title"
            && issue.severity == models::PackValidationSeverity::Ok
            && issue.message.contains("convention communautaire")
    }));
    assert!(!report
        .issues
        .iter()
        .any(|issue| { issue.category == "title" && issue.message.contains("long") }));

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn metadata_fix_uses_convention_name_for_output_zip() {
    let dir = temp_dir("metadata_name");
    fs::create_dir_all(&dir).expect("create temp dir");
    let zip_path = dir.join("4+]Azuro.zip");
    write_studio_zip(
        &zip_path,
        story_with_long_title("Azuro"),
        &[("cover.png", png_bytes(320, 240))],
    );

    let fixed = create_fixed_pack(
        &zip_path,
        Some(models::PackMetadataPatch {
            title: Some("Azuro".to_string()),
            description: Some("Version corrigée".to_string()),
            version: Some(2),
            min_age: Some("4".to_string()),
            author: None,
            producer: None,
            bonus: None,
            uuid: Some("11111111-2222-4333-8444-555555555555".to_string()),
            naming_mode: Some("convention".to_string()),
        }),
    )
    .expect("create fixed pack");

    let fixed_path = PathBuf::from(&fixed.fixed_zip_path);
    assert_eq!(
        fixed_path.file_name().and_then(|value| value.to_str()),
        Some("4+]Azuro_V2.zip")
    );
    let fixed_json = zip_doc::read_pack_doc(&fixed_path)
        .expect("read fixed story")
        .story;
    assert_eq!(fixed_json["title"], "Azuro");
    assert_eq!(fixed_json["version"], 2);
    assert_eq!(fixed_json["uuid"], "11111111-2222-4333-8444-555555555555");

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn unsupported_image_format_is_flagged_and_converted_to_png() {
    let gif = gif_bytes(320, 240);
    let (item, issues) = image::analyze_image_bytes(&gif, "cover.gif", "Cover");
    assert_eq!(item.status, "warning");
    assert!(item.auto_fix_available);
    assert_eq!(item.format.as_deref(), Some("GIF"));
    assert!(issues
        .iter()
        .any(|entry| entry.message.contains("format non pris en charge")));

    let fixed = image::fix_image_bytes(&gif).expect("convert gif to png");
    assert_eq!(
        ::image::guess_format(&fixed).ok(),
        Some(::image::ImageFormat::Png)
    );
    let png = ::image::load_from_memory(&fixed).expect("decode png");
    assert_eq!((png.width(), png.height()), (320, 240));
}

#[test]
fn play_stage_audio_uses_visible_title_label_in_report_refs() {
    let dir = temp_dir("visible_title_label");
    fs::create_dir_all(&dir).expect("create temp dir");
    let zip_path = dir.join("pack-label.zip");
    write_studio_zip(&zip_path, story_with_title_stage_play_audio(), &[]);

    let doc = zip_doc::read_pack_doc(&zip_path).expect("read pack doc");
    assert_eq!(doc.audio_refs.len(), 1);
    assert_eq!(doc.audio_refs[0].stage_id, "play");
    assert_eq!(doc.audio_refs[0].stage_name, "Stage visible");

    fs::remove_dir_all(dir).expect("cleanup temp dir");
}

fn temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "story_studio_checker_test_{}_{}",
        label,
        now_millis()
    ))
}

fn write_studio_zip(path: &Path, story: serde_json::Value, assets: &[(&str, Vec<u8>)]) {
    let file = fs::File::create(path).expect("create zip");
    let mut writer = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file("story.json", opts).expect("start story");
    writer
        .write_all(
            serde_json::to_string_pretty(&story)
                .expect("serialize story")
                .as_bytes(),
        )
        .expect("write story");
    for (name, bytes) in assets {
        writer
            .start_file(format!("assets/{}", name), opts)
            .expect("start asset");
        writer.write_all(bytes).expect("write asset");
    }
    writer.finish().expect("finish zip");
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(width, height, Rgba([32, 80, 140, 255]));
    let mut bytes = Vec::new();
    ::image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            ::image::ImageFormat::Png,
        )
        .expect("encode png");
    bytes
}

fn gif_bytes(width: u32, height: u32) -> Vec<u8> {
    let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(width, height, Rgba([20, 120, 90, 255]));
    let mut bytes = Vec::new();
    ::image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            ::image::ImageFormat::Gif,
        )
        .expect("encode gif");
    bytes
}

fn story_with_title_stage_play_audio() -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": "Pack label",
        "stageNodes": [
            {
                "uuid": "root",
                "name": "Racine",
                "squareOne": true,
                "controlSettings": {
                    "wheel": true,
                    "ok": true,
                    "home": true,
                    "pause": true,
                    "autoplay": false
                },
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 }
            },
            {
                "uuid": "title",
                "name": "Stage visible",
                "controlSettings": {
                    "wheel": true,
                    "ok": true,
                    "home": true,
                    "pause": false,
                    "autoplay": false
                },
                "okTransition": { "actionNode": "play-action", "optionIndex": 0 }
            },
            {
                "uuid": "play",
                "name": "Stage caché",
                "audio": "story.mp3",
                "controlSettings": {
                    "wheel": false,
                    "ok": false,
                    "home": true,
                    "pause": true,
                    "autoplay": true
                }
            }
        ],
        "actionNodes": [
            { "id": "root-action", "options": ["title"] },
            { "id": "play-action", "options": ["play"] }
        ]
    })
}

fn story_with_image_only(image: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": "Pack test",
        "stageNodes": [{
            "uuid": "root",
            "name": "Racine",
            "squareOne": true,
            "image": image,
            "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": true,
                "autoplay": false
            }
        }],
        "actionNodes": []
    })
}

fn story_with_long_title(title: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": title,
        "stageNodes": [{
            "uuid": "root",
            "name": "Racine",
            "squareOne": true,
            "image": "cover.png",
            "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": true,
                "autoplay": false
            }
        }],
        "actionNodes": []
    })
}

fn story_with_two_audios(root_audio: &str, story_audio: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": "Pack audio",
        "stageNodes": [
            {
                "uuid": "root",
                "name": "Racine",
                "squareOne": true,
                "audio": root_audio,
                "image": "cover.png",
                "controlSettings": {
                    "wheel": true,
                    "ok": true,
                    "home": true,
                    "pause": true,
                    "autoplay": false
                },
                "okTransition": { "actionNode": "action-1", "optionIndex": 0 }
            },
            {
                "uuid": "story",
                "name": "Histoire courte",
                "audio": story_audio,
                "controlSettings": {
                    "wheel": true,
                    "ok": true,
                    "home": true,
                    "pause": true,
                    "autoplay": true
                }
            }
        ],
        "actionNodes": [{
            "id": "action-1",
            "options": ["story"]
        }]
    })
}

fn story_with_single_audio(audio: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "title": "Pack audio",
        "stageNodes": [{
            "uuid": "root",
            "name": "Racine",
            "squareOne": true,
            "audio": audio,
            "image": "cover.png",
            "controlSettings": {
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": true,
                "autoplay": false
            }
        }],
        "actionNodes": []
    })
}

fn make_audio_with_edge_silence(
    ffmpeg: &Path,
    output: &Path,
    silence_sec: f64,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!("anullsrc=r=44100:cl=mono:d={:.3}", silence_sec))
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("sine=frequency=440:duration=0.8")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!("anullsrc=r=44100:cl=mono:d={:.3}", silence_sec))
        .arg("-filter_complex")
        .arg("[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=8dB")
        .arg("-ar")
        .arg("44100")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-q:a")
        .arg("5")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

struct TestAudioSpec<'a> {
    leading_silence_sec: f64,
    trailing_silence_sec: f64,
    sample_rate: u32,
    channels: u32,
    codec: &'a str,
    volume: &'a str,
}

impl<'a> TestAudioSpec<'a> {
    fn mp3(leading_silence_sec: f64, trailing_silence_sec: f64, volume: &'a str) -> Self {
        Self {
            leading_silence_sec,
            trailing_silence_sec,
            sample_rate: 44_100,
            channels: 1,
            codec: "libmp3lame",
            volume,
        }
    }
}

fn make_asymmetric_audio(
    ffmpeg: &Path,
    output: &Path,
    spec: TestAudioSpec<'_>,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!(
            "anullsrc=r=44100:cl=mono:d={:.3}",
            spec.leading_silence_sec
        ))
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("sine=frequency=440:duration=0.8")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg(format!(
            "anullsrc=r=44100:cl=mono:d={:.3}",
            spec.trailing_silence_sec
        ))
        .arg("-filter_complex")
        .arg(format!(
            "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume={}",
            spec.volume
        ))
        .arg("-ar")
        .arg(spec.sample_rate.to_string())
        .arg("-ac")
        .arg(spec.channels.to_string())
        .arg("-c:a")
        .arg(spec.codec);
    if spec.codec == "libmp3lame" {
        cmd.arg("-q:a").arg("5");
    }
    cmd.arg(output).stdout(Stdio::null()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn measured_edges(ffmpeg: &Path, audio_path: &Path) -> (f64, f64) {
    match crate::support::audio_norm::measure_edge_silence(ffmpeg, audio_path)
        .expect("measure output edges")
    {
        EdgeMeasure::Measured { leading, trailing } => (leading, trailing),
        other => panic!("expected measured edges, got {other:?}"),
    }
}
