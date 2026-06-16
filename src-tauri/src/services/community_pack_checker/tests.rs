use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ::image::{ImageBuffer, Rgba};

use super::*;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};

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

fn measured(measure: audio::EdgeMeasure) -> (f64, f64) {
    match measure {
        audio::EdgeMeasure::Measured { leading, trailing } => {
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
    let env = audio::parse_rms_envelope(stderr);
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
    let (leading, trailing) = measured(audio::edges_from_envelope(&env));
    assert!((leading - 26.0 * WIN).abs() < WIN, "début {}", leading);
    assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
}

#[test]
fn edges_measure_trailing_without_relying_on_declared_duration() {
    // Pur silence numérique en fin : doit être mesuré via l'horodatage interne.
    let env = build_env(&[(-12.0, 40), (f64::NEG_INFINITY, 30)]);
    let (leading, trailing) = measured(audio::edges_from_envelope(&env));
    assert_eq!(leading, 0.0);
    assert!((trailing - 30.0 * WIN).abs() < WIN, "fin {}", trailing);
}

#[test]
fn edges_ignore_isolated_leading_click() {
    // Un clic isolé d'une fenêtre à t=0 ne doit pas écraser le silence de début.
    let env = build_env(&[(-10.0, 1), (f64::NEG_INFINITY, 20), (-20.0, 30)]);
    let (leading, _) = measured(audio::edges_from_envelope(&env));
    assert!(leading > 10.0 * WIN, "le clic n'a pas été ignoré : {}", leading);
}

#[test]
fn edges_do_not_trim_soft_intro() {
    // Intro douce à -34 dB sur un plancher -43 dB : le contenu doit rester
    // contenu (pas classé silence), donc début ≈ 0.
    let env = build_env(&[(-34.0, 40), (-20.0, 40)]);
    let (leading, trailing) = measured(audio::edges_from_envelope(&env));
    assert_eq!(leading, 0.0, "intro douce rognée à tort");
    assert_eq!(trailing, 0.0);
}

#[test]
fn edges_all_silence_for_pure_digital_silence() {
    let env = build_env(&[(f64::NEG_INFINITY, 50)]);
    assert_eq!(audio::edges_from_envelope(&env), audio::EdgeMeasure::AllSilence);
}

#[test]
fn edges_unreadable_for_empty_envelope() {
    assert_eq!(audio::edges_from_envelope(&[]), audio::EdgeMeasure::Unreadable);
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
