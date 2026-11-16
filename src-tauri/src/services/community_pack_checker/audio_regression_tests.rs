//! Regression tests for the community pack checker.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::archive_regression_tests::{dir, png, story, zip};
use super::*;
use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path};

/// Fabrique un son : `inputs` = sources lavfi, `graph` = filter_complex (sortie [out]).
fn audio(ffmpeg: &Path, output: &Path, inputs: &[&str], graph: &str, tail: &[&str]) {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y");
    for input in inputs {
        cmd.args(["-f", "lavfi", "-i", input]);
    }
    cmd.args(["-filter_complex", graph, "-map", "[out]"]);
    cmd.args(tail);
    cmd.arg(output).stdout(Stdio::null()).stderr(Stdio::piped());
    let out = cmd.output().expect("run ffmpeg");
    assert!(
        out.status.success(),
        "fixture audio : {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

const MP3: [&str; 8] = [
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "5",
];

fn audio_story(names: &[&str]) -> serde_json::Value {
    let mut stages = vec![serde_json::json!({
        "uuid": "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
        "name": "Racine",
        "squareOne": true,
        "image": "cover.png",
        "audio": names[0],
        "controlSettings": {"wheel": true, "ok": true, "home": true, "pause": true, "autoplay": false},
        "okTransition": {"actionNode": "action-1", "optionIndex": 0}
    })];
    let mut options = Vec::new();
    for (index, name) in names.iter().enumerate().skip(1) {
        let id = format!("stage-{index}");
        options.push(serde_json::Value::String(id.clone()));
        stages.push(serde_json::json!({
            "uuid": id,
            "name": format!("Histoire {index}"),
            "audio": name,
            "controlSettings": {"wheel": true, "ok": true, "home": true, "pause": true, "autoplay": true}
        }));
    }
    serde_json::json!({
        "format": "v1", "version": 1, "title": "Pack audio",
        "stageNodes": stages,
        "actionNodes": [{"id": "action-1", "options": options}]
    })
}

fn audio_pack(dir: &Path, zip_name: &str, files: &[(&str, PathBuf)]) -> PathBuf {
    let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        (
            "story.json".to_string(),
            serde_json::to_vec_pretty(&audio_story(&names)).unwrap(),
        ),
        ("assets/cover.png".to_string(), png(320, 240)),
    ];
    for (name, path) in files {
        entries.push((
            format!("assets/{name}"),
            fs::read(path).expect("read audio"),
        ));
    }
    let zip_path = dir.join(zip_name);
    let borrowed: Vec<(&str, Vec<u8>)> = entries
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.clone()))
        .collect();
    zip(&zip_path, &borrowed);
    zip_path
}

fn describe(report: &ReportModel) -> String {
    let mut lines = vec![format!(
        "verdict={:?} auto={} optional={}",
        report.verdict, report.corrections_available, report.optional_corrections_available
    )];
    for item in &report.audio_items {
        lines.push(format!(
            "  {} status={} dur={:?} codec={:?} sr={:?} ch={:?} lead={:?} trail={:?} lufs={:?} peak={:?}",
            item.file_path, item.status, item.duration_secs, item.codec, item.sample_rate,
            item.channels, item.leading_silence_secs, item.trailing_silence_secs,
            item.integrated_lufs, item.true_peak_db
        ));
    }
    for issue in &report.issues {
        if issue.category == "audio" || issue.severity == PackValidationSeverity::Error {
            lines.push(format!(
                "    [{:?}/{:?}] {:?} {:?}",
                issue.severity, issue.fix_disposition, issue.file_path, issue.code
            ));
        }
    }
    lines.join("\n")
}

fn automatic_audio_issues(report: &ReportModel) -> Vec<(String, String)> {
    report
        .issues
        .iter()
        .filter(|issue| issue.category == "audio")
        .filter(|issue| {
            issue.fix_disposition == FixDisposition::Automatic
                || issue.severity == PackValidationSeverity::Error
        })
        .map(|issue| {
            (
                issue.file_path.clone().unwrap_or_default(),
                issue.code.clone().unwrap_or_default(),
            )
        })
        .collect()
}

pub(super) fn zip_entries(path: &Path) -> Vec<String> {
    let archive = ::zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    // Windows tools may store `\`; the corrected archive writes the `/` of the ZIP
    // spec and, like before, carries files only, not directory entries.
    let mut names: Vec<_> = archive
        .file_names()
        .map(|name| name.replace('\\', "/"))
        .filter(|name| !name.ends_with('/'))
        .collect();
    names.sort();
    names
}

/// Entry names without extension: a corrected medium may change format
/// (`.wav` -> `.mp3`, `.bmp` -> `.png`), but no entry may be added or removed.
pub(super) fn zip_entry_stems(path: &Path) -> Vec<String> {
    let mut stems: Vec<_> = zip_entries(path)
        .into_iter()
        .map(|name| match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.ends_with('/') && !ext.contains('/') => stem.to_string(),
            _ => name,
        })
        .collect();
    stems.sort();
    stems
}

fn fix_and_reanalyse(dir: &Path, zip: &Path) -> (ReportModel, ReportModel) {
    let before = analyze_pack(zip);
    eprintln!("Audio AVANT\n{}", describe(&before));
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let fixed = create_fixed_pack_with_log(zip, Some(&out), None, None, &|_| {})
        .expect("create fixed pack");
    let after = analyze_pack(Path::new(&fixed.fixed_zip_path));
    eprintln!("Audio APRES\n{}", describe(&after));
    (before, after)
}

/// Public reproduction: the shared budget-capped plan leaves this transient
/// music below the window. Announce it before correction and allow another fix.
#[test]
fn real_transient_music_announces_the_shared_plans_limit() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg required");
    let dir = dir("transient_music");
    let clip = dir.join("music.wav");
    audio(
        &ffmpeg,
        &clip,
        &["aevalsrc=(0.085+0.9*lt(mod(t\\,0.5)\\,0.001))*sin(2*PI*1000*t):s=44100:d=10"],
        "[0:a]adelay=400:all=1,apad=pad_dur=0.4[out]",
        &["-c:a", "pcm_f32le"],
    );
    let pack = audio_pack(&dir, "music.zip", &[("music.wav", clip.clone())]);
    let (before, after) = fix_and_reanalyse(&dir, &pack);
    let source = &before.audio_items[0];
    assert!(
        (-23.6..=-23.0).contains(&source.integrated_lufs.unwrap()),
        "{}",
        describe(&before)
    );
    assert!((-0.3..=0.1).contains(&source.true_peak_db.unwrap()));
    assert!(source.auto_fix_available);
    let announcement = before
        .issues
        .iter()
        .find(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME))
        .unwrap();
    assert!(announcement.auto_fix_available);
    assert!(!announcement
        .technical_details
        .as_deref()
        .unwrap()
        .contains(codes::CHECKER_VOLUME_BEST_EFFORT));
    assert_eq!(
        announcement
            .auto_fix_description
            .as_deref()
            .unwrap()
            .matches(codes::CHECKER_VOLUME_BEST_EFFORT)
            .count(),
        1
    );
    let mut filters = vec!["aformat=channel_layouts=mono".to_string()];
    let action = crate::support::audio_norm::plan_loudness_fix(
        source.integrated_lufs.unwrap(),
        source.true_peak_db.unwrap(),
    );
    assert!(
        matches!(action, crate::support::audio_norm::LoudnessAction::GainLimit { gain_db, .. } if (gain_db - 4.1).abs() < 0.01)
    );
    filters.extend(crate::support::audio_norm::build_loudness_filters(&action));
    let preview =
        crate::support::audio_norm::measure_loudness_ebur128(&ffmpeg, &clip, &filters).unwrap();
    let result = &after.audio_items[0];
    assert!((preview.integrated_lufs - result.integrated_lufs.unwrap()).abs() <= 0.2);
    assert!(
        (-20.4..=-20.1).contains(&result.integrated_lufs.unwrap()),
        "{}",
        describe(&after)
    );
    assert_eq!(after.corrections_available, 1, "{}", describe(&after));
    assert!(after
        .issues
        .iter()
        .any(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME)));
    let fixed_path = fs::read_dir(dir.join("out"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let bytes = zip_doc::read_zip_entry_bytes(&fixed_path, &result.file_path).unwrap();
    let standalone = dir.join("music.mp3");
    fs::write(&standalone, &bytes).unwrap();
    let (_, standalone_issues) =
        audio::analyze_audio_file(&ffmpeg, &standalone, "music.mp3", "Music", "story");
    // No receipt or repeated-correction guard, including outside the ZIP.
    assert!(standalone_issues
        .iter()
        .any(|issue| issue.auto_fix_available));
    assert_eq!(
        zip_entries(&fixed_path),
        vec!["assets/cover.png", "assets/music.mp3", "story.json",]
    );
    // A metadata rewrite does not hide the remaining volume correction.
    let metadata_copy = dir.join("metadata.zip");
    write_metadata_zip(
        &fixed_path,
        fs::File::create(&metadata_copy).unwrap(),
        None,
        None,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(analyze_pack(&metadata_copy).corrections_available, 1);
    fs::remove_dir_all(dir).unwrap();
}

/// P4. Convergence sur des sons variés : un pack corrigé, réanalysé, ne doit
/// plus rien avoir à corriger automatiquement ni d'erreur audio.
#[test]
fn explore_fixed_pack_has_nothing_left_to_fix() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg requis");
    eprintln!("Real FFmpeg : {}", ffmpeg.display());
    let dir = dir("converge");
    let mk = |name: &str, inputs: &[&str], graph: &str, tail: &[&str]| {
        let path = dir.join(name);
        audio(&ffmpeg, &path, inputs, graph, tail);
        path
    };
    // a) voix faible, bords nuls, stéréo 48 kHz WAV, nom exotique.
    let a = mk(
        "a.wav",
        &["sine=frequency=220:duration=6"],
        "[0:a]volume='if(lt(mod(t,1.5),1),0.2,0.0002)':eval=frame[out]",
        &["-ar", "48000", "-ac", "2"],
    );
    // b) très fort, sans bords.
    let b = mk(
        "b.mp3",
        &["sine=frequency=330:duration=4"],
        "[0:a]volume=24dB[out]",
        &MP3,
    );
    // e) témoin conforme : 0,5 s de silence numérique de chaque côté.
    let e = mk(
        "e.mp3",
        &[
            "anullsrc=r=44100:cl=mono:d=0.5",
            "sine=frequency=440:duration=3",
            "anullsrc=r=44100:cl=mono:d=0.5",
        ],
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=6dB[out]",
        &MP3,
    );
    let zip = audio_pack(
        &dir,
        "pack.zip",
        &[("e.mp3", e), ("Été 1 – début (v2).wav", a), ("b.mp3", b)],
    );
    let (_before, after) = fix_and_reanalyse(&dir, &zip);
    assert_eq!(
        automatic_audio_issues(&after),
        Vec::<(String, String)>::new(),
        "le pack corrigé ne doit plus avoir d'erreur ni de correction audio"
    );
    let _ = fs::remove_dir_all(dir);
}

/// P4. Clip court (5 s) enregistré avec un souffle à environ -50 dBFS : le
/// contenu démarre à 0,2 s (début trop court, corrigé), la fin est 0,8 s de
/// souffle seul (acceptée avant correction). Après correction du seul début,
/// la fin ne doit pas devenir une erreur.
#[test]
fn fixing_one_edge_of_a_short_noisy_clip_does_not_break_the_other_edge() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg requis");
    eprintln!("Real FFmpeg : {}", ffmpeg.display());
    let dir = dir("hiss");
    let clip = dir.join("d.mp3");
    audio(
        &ffmpeg,
        &clip,
        &[
            "anoisesrc=d=5:c=white:a=0.003",
            "sine=frequency=440:duration=4",
        ],
        "[1:a]volume=6dB,adelay=200[s];[0:a][s]amix=inputs=2:normalize=0:duration=first[out]",
        &MP3,
    );
    let zip = audio_pack(&dir, "pack.zip", &[("d.mp3", clip)]);
    let (before, after) = fix_and_reanalyse(&dir, &zip);
    let codes_of = |report: &ReportModel| -> Vec<String> {
        automatic_audio_issues(report)
            .into_iter()
            .map(|(_, code)| code)
            .collect()
    };
    assert_eq!(
        codes_of(&before),
        vec!["audioLeadingSilenceTooShort".to_string()],
        "fixture : seul le début est trop court avant correction"
    );
    assert_eq!(
        codes_of(&after),
        Vec::<String>::new(),
        "après correction, aucun bord ne doit être en erreur"
    );
    let _ = fs::remove_dir_all(dir);
}

/// P2. Son long (25 min) : mesures lues jusqu'au bout (cousin de #32).
#[test]
fn explore_long_audio_is_measured_to_its_end() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg requis");
    eprintln!("Real FFmpeg : {}", ffmpeg.display());
    let dir = dir("long");
    let path = dir.join("long.mp3");
    audio(
        &ffmpeg,
        &path,
        &[
            "anullsrc=r=44100:cl=mono:d=0.5",
            "sine=frequency=440:duration=1500",
            "anullsrc=r=44100:cl=mono:d=0.5",
        ],
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=6dB[out]",
        &MP3,
    );
    let started = std::time::Instant::now();
    let (item, issues) = audio::analyze_audio_file(&ffmpeg, &path, "long.mp3", "Long", "Histoire");
    eprintln!(
        "Audio LONG {:?} lead={:?} trail={:?} lufs={:?} dur={:?} en {:?} ; {:?}",
        item.status,
        item.leading_silence_secs,
        item.trailing_silence_secs,
        item.integrated_lufs,
        item.duration_secs,
        started.elapsed(),
        issues
            .iter()
            .map(|issue| issue.code.clone())
            .collect::<Vec<_>>()
    );
    assert!((item.leading_silence_secs.unwrap() - 0.5).abs() < 0.1);
    assert!((item.trailing_silence_secs.unwrap() - 0.5).abs() < 0.15);
    assert!(item.integrated_lufs.is_some());
    let _ = fs::remove_dir_all(dir);
}

/// P3. Un MP3 conforme dont un tag ID3 contient « Audio: » ne doit pas être
/// pris pour un autre format (le flux est lu dans la sortie texte de FFmpeg).
#[test]
fn id3_text_does_not_change_the_detected_format() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg requis");
    eprintln!("Real FFmpeg : {}", ffmpeg.display());
    let dir = dir("id3");
    let make = |name: &str, title: &str| {
        let path = dir.join(name);
        audio(
            &ffmpeg,
            &path,
            &[
                "anullsrc=r=44100:cl=mono:d=0.5",
                "sine=frequency=440:duration=3",
                "anullsrc=r=44100:cl=mono:d=0.5",
            ],
            "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=6dB[out]",
            &[
                "-ar",
                "44100",
                "-ac",
                "1",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "5",
                "-metadata",
                title,
            ],
        );
        path
    };
    let plain = make("plain.mp3", "title=Le petit prince");
    let tagged = make(
        "tagged.mp3",
        "title=Livre Audio: Le petit prince Duration: 99:00:00.00",
    );
    let (plain_item, plain_issues) =
        audio::analyze_audio_file(&ffmpeg, &plain, "plain.mp3", "Témoin", "Histoire");
    let (item, issues) =
        audio::analyze_audio_file(&ffmpeg, &tagged, "tagged.mp3", "Tag", "Histoire");
    assert_eq!(item.duration_secs, plain_item.duration_secs);
    eprintln!(
        "Audio ID3 témoin codec={:?} sr={:?} ch={:?} {:?} ; tag codec={:?} sr={:?} ch={:?} {:?}",
        plain_item.codec,
        plain_item.sample_rate,
        plain_item.channels,
        plain_issues
            .iter()
            .map(|issue| issue.code.clone())
            .collect::<Vec<_>>(),
        item.codec,
        item.sample_rate,
        item.channels,
        issues
            .iter()
            .map(|issue| issue.code.clone())
            .collect::<Vec<_>>()
    );
    assert!(plain_issues.is_empty(), "témoin conforme");
    assert_eq!(
        (item.codec, item.sample_rate, item.channels),
        (
            plain_item.codec,
            plain_item.sample_rate,
            plain_item.channels
        )
    );
    assert!(
        issues.is_empty(),
        "même son, mêmes mesures : aucun problème"
    );
    let _ = fs::remove_dir_all(dir);
}

/// P2. Archive tronquée : rapport « invalide », sans panique.
#[test]
fn explore_truncated_archive_yields_an_invalid_report() {
    let dir = dir("truncated");
    let zip_path = dir.join("pack.zip");
    zip(
        &zip_path,
        &[
            (
                "story.json",
                serde_json::to_vec_pretty(&story("Pack")).unwrap(),
            ),
            ("assets/cover.png", png(320, 240)),
        ],
    );
    let bytes = fs::read(&zip_path).unwrap();
    fs::write(&zip_path, &bytes[..bytes.len() / 2]).unwrap();
    let report = analyze_pack(&zip_path);
    assert_eq!(report.verdict, PackValidationVerdict::Invalid);
    let _ = fs::remove_dir_all(dir);
}

/// P4. Musique ou ambiance avec fondus (2 s), trop faible (-26 LUFS) : ses bords
/// sont acceptes avant correction. La seule correction du volume ne doit pas
/// les transformer en erreurs dans le pack corrige.
#[test]
fn volume_correction_does_not_turn_accepted_edges_into_errors() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg requis");
    eprintln!("Real FFmpeg : {}", ffmpeg.display());
    let dir = dir("fades");
    let clip = dir.join("c.mp3");
    audio(
        &ffmpeg,
        &clip,
        &["anoisesrc=d=10:c=pink:a=0.3"],
        "[0:a]afade=t=in:d=2,afade=t=out:st=8:d=2[out]",
        &MP3,
    );
    let zip = audio_pack(&dir, "pack.zip", &[("c.mp3", clip.clone())]);
    let (before, after) = fix_and_reanalyse(&dir, &zip);
    let plan = audio::automatic_fix_plan(&before.audio_items[0], &before.issues);
    // Independent FFmpeg witness: compare the forecast with a gain-only encode.
    // Production still builds the selected edges in its single encode.
    let gained = dir.join("gain-only.mp3");
    audio::fix_audio_file(
        &ffmpeg,
        &clip,
        &gained,
        &before.audio_items[0],
        audio::AudioFixPlan {
            fix_loudness: true,
            ..Default::default()
        },
    )
    .unwrap();
    let (gained_item, _) =
        audio::analyze_audio_file(&ffmpeg, &gained, "gain-only.mp3", "Gain", "story");
    let predicted = before.audio_items[0].edges_after_gain.unwrap();
    eprintln!(
        "Prévision {predicted:?}; gain seul réel {:?}/{:?}",
        gained_item.leading_silence_secs, gained_item.trailing_silence_secs
    );
    assert!((predicted.0 - gained_item.leading_silence_secs.unwrap()).abs() <= 0.05);
    assert!((predicted.1 - gained_item.trailing_silence_secs.unwrap()).abs() <= 0.05);
    eprintln!(
        "Plan du fondu : {plan:?}; prévision {:?}",
        before.audio_items[0].edges_after_gain
    );
    assert!(plan.rebuild_leading_silence && plan.rebuild_trailing_silence);
    let description = before
        .issues
        .iter()
        .find(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME))
        .unwrap()
        .auto_fix_description
        .as_ref()
        .unwrap();
    assert!(description.contains(codes::CHECKER_SILENCE_PADDING_DESCRIPTION));
    assert!(description.contains(codes::LABEL_SILENCE_START));
    assert!(description.contains(codes::LABEL_SILENCE_END));
    assert!(before.audio_items[0]
        .fix_summary
        .as_ref()
        .unwrap()
        .contains(codes::CHECKER_SILENCE_ADJUSTMENT_TITLE));
    let codes_of = |report: &ReportModel| -> Vec<String> {
        automatic_audio_issues(report)
            .into_iter()
            .map(|(_, code)| code)
            .collect()
    };
    assert_eq!(
        codes_of(&before),
        vec!["CHECKER_AUDIO_VOLUME".to_string()],
        "fixture : seul le volume est a corriger"
    );
    assert_eq!(
        codes_of(&after),
        Vec::<String>::new(),
        "apres correction du volume, aucun bord ne doit etre en erreur"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn volume_description_only_adds_edges_that_become_short_after_gain() {
    let ffmpeg = get_ffmpeg_path().expect("FFmpeg réel requis");
    let dir = dir("volume_description");
    let clip = dir.join("mixed.mp3");
    audio(
        &ffmpeg,
        &clip,
        &["anoisesrc=d=10:c=pink:a=0.3"],
        "[0:a]afade=t=out:st=8:d=2[out]",
        &MP3,
    );
    let (item, issues) = audio::analyze_audio_file(&ffmpeg, &clip, "mixed.mp3", "Mixed", "story");
    assert!(issues
        .iter()
        .any(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_LEADING_SHORT)));
    assert!(!issues
        .iter()
        .any(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_TRAILING_SHORT)));
    let predicted = item.edges_after_gain.unwrap();
    assert!(predicted.0 < 0.35 && predicted.1 < 0.35, "{predicted:?}");
    let description = issues
        .iter()
        .find(|issue| issue.code.as_deref() == Some(codes::CHECKER_AUDIO_VOLUME))
        .unwrap()
        .auto_fix_description
        .as_ref()
        .unwrap();
    assert!(!description.contains(codes::LABEL_SILENCE_START));
    assert!(description.contains(codes::LABEL_SILENCE_END));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn boundary_gain_on_mp3_with_wrong_extension_announces_dependent_edges_once() {
    let ffmpeg = get_ffmpeg_path().expect("Real FFmpeg required");
    let dir = dir("boundary_wrong_extension");
    let clip = dir.join("boundary.mp3");
    audio(
        &ffmpeg,
        &clip,
        &["sine=frequency=440:duration=10"],
        "[0:a]volume=1.2,afade=t=in:d=4,afade=t=out:st=6:d=4[out]",
        &MP3,
    );
    let (source, _) =
        audio::analyze_audio_file(&ffmpeg, &clip, "boundary.mp3", "Boundary", "story");
    let gain = -19.8 - source.integrated_lufs.unwrap();
    let calibrated = dir.join("calibrated.mp3");
    let mut command = Command::new(&ffmpeg);
    apply_no_window(&mut command);
    assert!(command
        .arg("-y")
        .arg("-i")
        .arg(&clip)
        .arg("-af")
        .arg(format!("volume={gain}dB"))
        .args(MP3)
        .arg(&calibrated)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let disguised = dir.join("calibrated.wav");
    fs::copy(&calibrated, &disguised).unwrap();
    let (item, issues) =
        audio::analyze_audio_file(&ffmpeg, &disguised, "calibrated.wav", "Boundary", "story");
    assert!(
        (-20.0..=-19.5).contains(&item.integrated_lufs.unwrap()),
        "{item:?}"
    );
    assert!(item.leading_silence_secs.unwrap() >= 0.35, "{item:?}");
    assert!(item.trailing_silence_secs.unwrap() >= 0.35, "{item:?}");
    let plan = audio::automatic_fix_plan(&item, &issues);
    assert!(plan.fix_format_or_channels && plan.fix_loudness);
    assert!(
        plan.rebuild_leading_silence && plan.rebuild_trailing_silence,
        "{plan:?}"
    );
    let descriptions: Vec<_> = issues
        .iter()
        .filter_map(|issue| issue.auto_fix_description.as_deref())
        .collect();
    assert_eq!(
        descriptions
            .iter()
            .filter(|text| text.contains(codes::CHECKER_VOLUME_NORMALIZATION_DESCRIPTION))
            .count(),
        1
    );
    assert!(descriptions
        .iter()
        .any(|text| text.contains(codes::LABEL_SILENCE_START)
            && text.contains(codes::LABEL_SILENCE_END)));
    fs::remove_dir_all(dir).unwrap();
}

fn volume_correction_preserves_quiet_edges(volume: &str, boost: bool) {
    let ffmpeg = get_ffmpeg_path().expect("FFmpeg réel requis");
    eprintln!("FFmpeg réel : {}", ffmpeg.display());
    let dir = dir(if boost { "quiet_boost" } else { "quiet_cut" });
    let clip = dir.join("quiet.mp3");
    audio(
        &ffmpeg, &clip,
        &["sine=frequency=440:duration=0.5", "sine=frequency=440:duration=4", "sine=frequency=440:duration=0.5"],
        &format!("[0:a]volume=0.0001[a];[1:a]volume={volume}[b];[2:a]volume=0.0001[c];[a][b][c]concat=n=3:v=0:a=1[out]"),
        &MP3,
    );
    // The edge tone is below -100 dBFS before gain and stays below the
    // silence threshold after boosting this quiet content to -14 LUFS.
    let zip = audio_pack(&dir, "pack.zip", &[("quiet.mp3", clip)]);
    let (before, after) = fix_and_reanalyse(&dir, &zip);
    let item = &before.audio_items[0];
    if boost {
        assert!(item.integrated_lufs.unwrap() < -20.0);
    } else {
        assert!(item.integrated_lufs.unwrap() > -10.0);
    }
    let plan = audio::automatic_fix_plan(item, &before.issues);
    eprintln!("Plan bords silencieux : {plan:?}");
    assert!(plan.fix_loudness);
    assert!(!plan.rebuild_leading_silence && !plan.rebuild_trailing_silence);
    assert!(automatic_audio_issues(&after).is_empty());
    assert_eq!(after.corrections_available, 0);
    assert_eq!(after.optional_corrections_available, 0);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn quiet_audio_with_truly_silent_edges_needs_no_edge_reconstruction() {
    volume_correction_preserves_quiet_edges("0.2", true);
}

#[test]
fn loud_audio_needs_no_edge_reconstruction() {
    volume_correction_preserves_quiet_edges("6", false);
}
