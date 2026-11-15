//! Régression : sur un son long, la chaîne avancée doit mesurer les silences
//! de bord comme l'éditeur par menus, au-delà des anciens 8 Mo de diagnostics.

use super::*;
use crate::domain::project::SilenceMode;
use crate::native_pack::assets::advanced::plan::{plan_audio, ConversionPlan};
use crate::native_pack::assets::audio::audio_filter_chain_for;
use crate::support::audio_norm::{
    build_edge_silence_filters_with_targets, measure_edge_silence, EdgeMeasure, LoudnessAction,
    EDGE_SILENCE_SEC,
};

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);

fn synthesize(ffmpeg: &Path, scratch: &Scratch, name: &str, args: &[&str]) -> PathBuf {
    let path = scratch.sources().join(name);
    let status = std::process::Command::new(ffmpeg)
        .args(["-v", "error", "-f", "lavfi"])
        .args(args)
        .args(["-ar", "44100", "-ac", "1", "-y"])
        .arg(&path)
        .status()
        .unwrap();
    assert!(status.success());
    path
}

/// Filtres attendus : ceux que donne la mesure non plafonnée de l'éditeur par menus.
fn compare(ffmpeg: &Path, source: &Path) -> (String, String, (f64, f64)) {
    let EdgeMeasure::Measured { leading, trailing } =
        measure_edge_silence(ffmpeg, source).expect("mesure par menus")
    else {
        panic!("fixture : bords mesurables attendus");
    };
    let expected = audio_filter_chain_for(
        SilenceMode::Normalize,
        EDGE_SILENCE_SEC,
        EDGE_SILENCE_SEC,
        &LoudnessAction::None,
        Some(&build_edge_silence_filters_with_targets(
            leading,
            trailing,
            EDGE_SILENCE_SEC,
            EDGE_SILENCE_SEC,
        )),
    );
    let options = AdvancedAudioOptions {
        silence_mode: SilenceMode::Normalize,
        harmonize_loudness: false,
        ..AdvancedAudioOptions::default()
    };
    let plan = plan_audio(ffmpeg, source, None, &options, DEADLINE).expect("plan avancé");
    let ConversionPlan::AudioEncode { filters, .. } = plan else {
        panic!("un FLAC est encodé");
    };
    (expected, filters, (leading, trailing))
}

/// 25 minutes de son continu, puis 3 s de silence : le silence final doit être
/// retiré puis reposé à sa durée cible, comme par l'éditeur par menus.
#[test]
fn long_audio_trailing_silence_is_measured_like_the_menus_editor() {
    let Some(ffmpeg) = ffmpeg_or_skip("long_audio_trailing_silence") else {
        return;
    };
    let scratch = Scratch::new("long-trailing");
    let source = synthesize(
        &ffmpeg,
        &scratch,
        "long.flac",
        &[
            "-i",
            "sine=frequency=440:duration=1500",
            "-af",
            "apad=pad_dur=3",
        ],
    );
    let (expected, actual, edges) = compare(&ffmpeg, &source);
    eprintln!(
        "[audio] bords (menus) : {edges:?}\n[audio] menus  : {expected}\n[audio] avancé : {actual}"
    );
    assert!(
        (edges.1 - 3.0).abs() < 0.1,
        "fixture : 3 s de silence final"
    );
    assert_eq!(actual, expected);
}

/// 25 minutes de parole simulée (0,4 s de son toutes les 1,5 s), sans silence
/// final : rien ne doit être retiré à la fin de l'histoire.
#[test]
fn long_speech_like_audio_keeps_its_real_ending() {
    let Some(ffmpeg) = ffmpeg_or_skip("long_speech_like_audio") else {
        return;
    };
    let scratch = Scratch::new("long-speech");
    let source = synthesize(
        &ffmpeg,
        &scratch,
        "speech.flac",
        &[
            "-i",
            r"aevalsrc=0.3*sin(2*PI*440*t)*lt(mod(t\,1.5)\,0.4):s=44100:d=1500.2",
        ],
    );
    let (expected, actual, edges) = compare(&ffmpeg, &source);
    eprintln!(
        "[audio] bords (menus) : {edges:?}\n[audio] menus  : {expected}\n[audio] avancé : {actual}"
    );
    assert!(edges.1 < 0.1, "fixture : le son finit sur du contenu");
    assert_eq!(actual, expected);
}

#[test]
fn long_audio_loudness_summary_survives_eight_megabytes_of_diagnostics() {
    use crate::native_pack::assets::advanced::probe::{run_measurement, InvocationOutcome};
    use crate::support::audio_norm::{
        ebur128_args, measure_loudness_ebur128, parse_summary, plan_loudness_fix,
    };

    let Some(ffmpeg) = ffmpeg_or_skip("long_loudness") else {
        return;
    };
    let scratch = Scratch::new("long-loudness");
    let source = synthesize(
        &ffmpeg,
        &scratch,
        "ninety-minutes.flac",
        &["-i", "sine=frequency=440:duration=5400"],
    );
    let filters = vec!["aformat=channel_layouts=mono".to_string()];
    let expected = measure_loudness_ebur128(&ffmpeg, &source, &filters).unwrap();
    let run = run_measurement(&ffmpeg, &ebur128_args(&source, &filters), DEADLINE);
    assert_eq!(run.outcome, InvocationOutcome::Succeeded);
    assert!(
        run.stderr.len() > 8 * 1024 * 1024,
        "fixture au-delà de l'ancien plafond"
    );
    let actual = parse_summary(&run.stderr, true).expect("résumé final conservé");
    assert_eq!(actual.integrated_lufs, expected.integrated_lufs);
    assert_eq!(actual.true_peak_db, expected.true_peak_db);
    assert!(!matches!(
        plan_loudness_fix(actual.integrated_lufs, actual.true_peak_db),
        LoudnessAction::None
    ));
}
