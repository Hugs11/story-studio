//! Parity through the actual generation facades, without reaching into or
//! modifying native_pack's private preparation modules.
use super::*;
use crate::domain::project::{Project, SilenceMode};
use crate::native_pack::advanced_export::{export_advanced_pack_with_cancel, AdvancedAudioOptions};
use crate::native_pack::generate_native_pack_v1_with_cancel;
use crate::native_pack::graph_copy::graph_copy_of_project;
use serde_json::json;
use std::fs;

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn wav(samples: &[i16]) -> Vec<u8> {
    let size = (samples.len() * 2) as u32;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + size).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(44100u32.to_le_bytes());
    bytes.extend(88200u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(size.to_le_bytes());
    for sample in samples {
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}
fn tone(seconds: f64, amplitude: f64) -> Vec<i16> {
    (0..(44100.0 * seconds) as usize)
        .map(|i| {
            ((i as f64 * 440.0 * std::f64::consts::TAU / 44100.0).sin() * amplitude * 32767.0)
                as i16
        })
        .collect()
}

fn assert_silent_archive(
    ffmpeg: &Path,
    zip_path: &str,
    decoded: &Path,
    mode: SilenceMode,
    fixture: &str,
) -> Vec<Vec<u8>> {
    use std::io::Read;
    let validation = crate::support::lunii_zip_validator::validate_lunii_zip(zip_path);
    assert!(validation.valid, "{zip_path}: {:?}", validation.issues);
    let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
    let mut audio_count = 0;
    let mut encoded = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if !entry.name().ends_with(".mp3") {
            continue;
        }
        audio_count += 1;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        fs::write(decoded, &bytes).unwrap();
        encoded.push(bytes);
        let mut command = std::process::Command::new(ffmpeg);
        command.args(["-v", "info", "-i"]).arg(decoded).args([
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ]);
        crate::support::ffmpeg::apply_no_window(&mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("44100 Hz, mono"), "{stderr}");
        let seconds = output.stdout.len() as f64 / 88200.0;
        let target = if matches!(mode, SilenceMode::Off) {
            2.0
        } else {
            2.8
        };
        assert!(
            (seconds - target).abs() < 0.08,
            "duration {seconds} vs {target}"
        );
        assert_eq!(fixture, "silent");
        assert!(output.stdout.iter().all(|byte| *byte == 0));
    }
    assert!(audio_count > 0);
    encoded.sort();
    encoded.dedup();
    encoded
}

#[test]
fn audio_loudness_parity_with_both_editor_generations() {
    let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().expect("FFmpeg required for parity");
    let scratch =
        Scratch(std::env::temp_dir().join(format!("audio-level-parity-{}", std::process::id())));
    fs::create_dir_all(&scratch.0).unwrap();
    let image = scratch.0.join("cover.png");
    image::RgbImage::from_pixel(320, 240, image::Rgb([80, 120, 160]))
        .save(&image)
        .unwrap();
    let mut dynamic = tone(3.0, 0.025);
    // A brief loud transient gives a quiet, dynamic source a high true peak.
    dynamic[44100..44541].copy_from_slice(&tone(0.01, 0.95));
    let mut edged = vec![0; 22050];
    edged.extend(tone(1.2, 0.39));
    edged.extend(vec![0; 22050]);
    // Pauses give the shared RMS detector a floor below the quiet content.
    let mut near_mute = vec![0; 22050];
    near_mute.extend(tone(2.0, 0.004));
    near_mute.extend(vec![0; 22050]);
    let cases = [
        ("normal", tone(2.0, 0.28), None),
        ("dynamic", dynamic, Some("AUDIO_STRONG_LIMITING")),
        ("near-mute", near_mute, Some("AUDIO_NEAR_MUTE_BOOST")),
        ("silent", vec![0; 88200], None),
        (
            "below-floor",
            tone(2.0, 0.0001),
            Some("AUDIO_NEAR_MUTE_BOOST"),
        ),
        (
            "minus-57-dbfs",
            tone(2.0, 0.002),
            Some("AUDIO_NEAR_MUTE_BOOST"),
        ),
        ("edges", edged, None),
    ];
    for (name, samples, expected) in cases {
        let source = scratch.0.join(format!("{name}.wav"));
        fs::write(&source, wav(&samples)).unwrap();
        let report = measure_audio_level(&ffmpeg, &source).unwrap();
        assert_eq!(report.notice, expected, "fixture {name}");
        let silent = name == "silent";
        assert_eq!(report.silent, silent, "fixture {name}");
        assert_eq!(serde_json::to_value(&report).unwrap()["silent"], silent);
        if name == "silent" {
            assert_eq!(report.true_peak_db, None);
        }
        if name == "below-floor" {
            assert!(
                report.true_peak_db.is_some(),
                "weak measurable content has a finite peak"
            );
        }
        if matches!(name, "below-floor" | "minus-57-dbfs") {
            assert!(!report.silent);
            assert!(report.integrated_lufs.is_some());
            assert!(matches!(
                super::super::measure_edge_silence(&ffmpeg, &source).unwrap(),
                EdgeMeasure::AllSilence
            ));
        }
        // Exercise modes and nonzero output targets: these must never change
        // the level measured without edges.
        for harmonize in if silent {
            &[true, false][..]
        } else {
            &[true][..]
        } {
            for (mode, mode_name) in [
                (SilenceMode::Off, "off"),
                (SilenceMode::Add, "add"),
                (SilenceMode::Normalize, "normalize"),
            ] {
                let output = scratch.0.join(format!("{name}-{mode_name}-{harmonize}"));
                fs::create_dir_all(&output).unwrap();
                let project: Project = serde_json::from_value(json!({
                "name": "Parity", "projectType": "pack",
                "packUuid": "3f2b9c1e-8a47-4d2e-9b61-0c5d7e8f9a10", "packVersion": 1,
                "rootAudio": source, "rootImage": image,
                "rootEntries": [{"id":"story", "type":"story", "name":"Story", "audio":source, "itemAudio":source, "itemImage":image, "afterPlaybackSequence":[{"id":"step","name":"Étape","audio":source,"image":image}]}],
                "globalOptions": {"harmonizeLoudness":harmonize,"silenceMode":mode_name,"autoNext":false,"nightMode":false}
            })).unwrap();
                let menus = generate_native_pack_v1_with_cancel(
                    &project,
                    output.to_str().unwrap(),
                    &|_| {},
                    &|| false,
                );
                let copy = graph_copy_of_project(&project).unwrap();
                let graph = export_advanced_pack_with_cancel(
                    &copy.payload,
                    &copy.media_bindings,
                    &output,
                    &AdvancedAudioOptions {
                        silence_mode: mode,
                        harmonize_loudness: *harmonize,
                        leading_silence_sec: 0.4,
                        trailing_silence_sec: 0.4,
                    },
                    Some("Graph"),
                    None,
                    Some("Parity"),
                    None,
                    &|_| {},
                    &|| false,
                )
                .unwrap_or_else(|error| panic!("{name}/{mode_name}: graph {error:?}"));
                let menus =
                    menus.unwrap_or_else(|error| panic!("{name}/{mode_name}: menus {error}"));
                if silent {
                    let menu_audio = assert_silent_archive(
                        &ffmpeg,
                        &menus.zip_path,
                        &output.join("menus.mp3"),
                        mode,
                        name,
                    );
                    let graph_audio = assert_silent_archive(
                        &ffmpeg,
                        &graph.zip_path,
                        &output.join("graph.mp3"),
                        mode,
                        name,
                    );
                    assert_eq!(menu_audio, graph_audio, "{name}/{mode_name}/{harmonize}");
                }
                for (editor, warnings) in
                    [("menus", menus.warnings), ("graph", graph.audio_warnings)]
                {
                    let expected_code = if report.silent {
                        harmonize.then_some("AUDIO_SILENT_KEPT")
                    } else {
                        report.notice
                    };
                    assert_eq!(
                        warnings.is_empty(),
                        expected_code.is_none(),
                        "{name}/{mode_name}/{editor}"
                    );
                    if silent && *harmonize && editor == "menus" {
                        assert!(warnings
                            .iter()
                            .any(|warning| warning.label == "Story — Étape"));
                    }
                    for warning in warnings {
                        assert_eq!(
                            Some(warning.code.as_str()),
                            expected_code,
                            "{name}/{mode_name}/{editor}"
                        );
                        if silent {
                            assert!(!warning.label.contains("rootAudio"));
                            assert!(
                                !warning.label.is_empty() && !warning.label.contains("/audio"),
                                "{}",
                                warning.label
                            );
                            let message: serde_json::Value =
                                serde_json::from_str(&warning.message).unwrap();
                            assert_eq!(message["code"], "AUDIO_SILENT_KEPT");
                            assert!(message["params"].get("label").is_some());
                            assert_eq!(warning.gain_db, 0.0);
                            assert_eq!(warning.expected_limiting_db, 0.0);
                        } else {
                            assert_eq!(warning.initial_integrated_lufs, report.integrated_lufs);
                            if expected == Some("AUDIO_NEAR_MUTE_BOOST") {
                                assert!(
                                    warning.gain_db > 0.0,
                                    "measurable weak content must receive gain"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn audio_loudness_strict_rejects_digital_silence_but_level_variant_accepts_it() {
    let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().expect("FFmpeg required");
    let scratch =
        Scratch(std::env::temp_dir().join(format!("audio-level-silence-{}", std::process::id())));
    fs::create_dir_all(&scratch.0).unwrap();
    let source = scratch.0.join("silent.wav");
    fs::write(&source, wav(&vec![0; 88200])).unwrap();
    let error = super::super::measure_loudness_ebur128(&ffmpeg, &source, &[]).unwrap_err();
    assert!(error.contains("AUDIO_EBUR128_MEASURE_INCOMPLETE"));
    let measure = super::super::loudness::measure_loudness_for_level(
        &ffmpeg,
        &source,
        &[],
        std::time::Instant::now() + std::time::Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(measure.integrated_lufs, -70.0);
    assert_eq!(measure.true_peak_db, f64::NEG_INFINITY);
}

// The current test executable is a portable fake tool: the child runs only this
// test and never exits unless the process owner kills and reaps it.
#[test]
fn audio_level_hanging_tool_fixture() {
    if std::env::var_os("STORY_STUDIO_AUDIO_HANG_FIXTURE").is_some() {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
}

#[test]
fn audio_level_deadline_kills_and_reaps_a_hanging_tool() {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "support::audio_norm::level::tests::audio_level_hanging_tool_fixture",
        ])
        .env("STORY_STUDIO_AUDIO_HANG_FIXTURE", "1");
    let started = std::time::Instant::now();
    let error =
        run_level_command(command, started + std::time::Duration::from_millis(150)).unwrap_err();
    assert!(error.contains("FILES_TASK_ABANDONED"));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    // Return proves the pipe reader saw EOF and joined after kill + wait.
}
