//! Harmonisation du volume : le graphe décide comme l'éditeur par menus.
//!
//! Le volume servant à décider du gain se mesure **sans les silences de bord**,
//! quel que soit le mode de silences ; ce mode ne règle que ce qu'on fait des
//! bords en sortie. Sur un son court, les bords pèsent dans l'intégré : mesuré
//! brut, il peut tomber dans la bande morte alors que le son lui-même en sort.
//! Les deux éditeurs doivent alors appliquer le même gain et livrer le même
//! fichier.

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::domain::project::SilenceMode;
use crate::native_pack::assets::advanced::plan::{plan_audio, ConversionPlan};
use crate::native_pack::assets::audio::{prepare_audio_asset, AudioPreparation};
use crate::native_pack::CanonicalOptions;
use crate::support::audio_norm::{measure_loudness_ebur128, EDGE_SILENCE_SEC};

static CALLS: AtomicUsize = AtomicUsize::new(0);

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

/// Bornes de la bande morte de `plan_loudness_fix` (cible −14 LUFS ± 1,5 LU).
const DEAD_BAND_LOW: f64 = -15.5;
const DEAD_BAND_HIGH: f64 = -12.5;

/// Un titre court entouré de silences : brut, son intégré est dans la bande
/// morte ; sans ses bords, il en sort par le haut.
fn short_title_with_edges() -> Vec<i16> {
    let mut samples = silence(0.5);
    samples.extend(tone(440.0, 1.2, 0.39));
    samples.extend(silence(0.5));
    samples
}

struct EditorOutputs {
    menus: Vec<u8>,
    graph: Vec<u8>,
    graph_filters: String,
}

/// Prépare la même source par les deux chaînes, avec les mêmes réglages.
fn both_editors(
    ffmpeg: &Path,
    source: &Path,
    silence_mode: SilenceMode,
    harmonize_loudness: bool,
) -> EditorOutputs {
    // Un dossier par appel : les tests tournent en parallèle dans le même
    // processus, et deux `Scratch` homonymes de la même milliseconde se
    // confondraient.
    let label = CALLS.fetch_add(1, Ordering::Relaxed);
    let menus_dir = Scratch::new(&format!("menus-{label}"));
    let processed = menus_dir.root.join("processed");
    fs::create_dir_all(&processed).unwrap();
    let prepared = prepare_audio_asset(
        &source.to_string_lossy(),
        ffmpeg,
        &processed,
        &CanonicalOptions {
            silence_mode,
            harmonize_loudness,
            ..CanonicalOptions::default()
        },
        EDGE_SILENCE_SEC,
        EDGE_SILENCE_SEC,
        "titre",
    )
    .expect("préparation par menus");
    let menus_path = match prepared.preparation {
        AudioPreparation::Encoded { output } => output,
        AudioPreparation::Verbatim { source } => source,
    };

    let options = AdvancedAudioOptions {
        silence_mode,
        harmonize_loudness,
        ..AdvancedAudioOptions::default()
    };
    let graph_dir = Scratch::new(&format!("graphe-{label}"));
    let document = document_with(&stage(ENTRY, true, Some("titre.wav"), None), "");
    let preparation = prepare_advanced_assets(
        &document,
        &[binding("titre.wav", source)],
        &graph_dir.workspace(),
        ffmpeg,
        &options,
    )
    .expect("préparation graphe");
    let graph = fs::read(&preparation.archive_entries[0].output_path).unwrap();

    let plan = plan_audio(ffmpeg, source, None, &options, DEADLINE).expect("plan graphe");
    let graph_filters = match plan {
        ConversionPlan::AudioEncode { filters, .. } => filters,
        other => panic!("un WAV est encodé, obtenu {other:?}"),
    };

    EditorOutputs {
        menus: fs::read(&menus_path).unwrap(),
        graph,
        graph_filters,
    }
}

fn short_title_source(scratch: &Scratch, ffmpeg: &Path) -> PathBuf {
    let source = scratch.write_source("src", "titre.wav", &wav_bytes(&short_title_with_edges()));
    // Le piège que ces tests visent : mesuré brut, le titre est dans la bande
    // morte et ne recevrait aucun gain.
    let raw = measure_loudness_ebur128(
        ffmpeg,
        &source,
        &["aformat=channel_layouts=mono".to_string()],
    )
    .expect("mesure brute");
    eprintln!(
        "[préparation] intégré brut du titre court : {:.1} LUFS",
        raw.integrated_lufs
    );
    assert!(
        (DEAD_BAND_LOW..=DEAD_BAND_HIGH).contains(&raw.integrated_lufs),
        "fixture : l'intégré brut doit être en bande morte, obtenu {:.1}",
        raw.integrated_lufs
    );
    source
}

#[test]
fn edge_silences_never_decide_the_gain_in_add_or_off_mode() {
    let Some(ffmpeg) = ffmpeg_or_skip("loudness_parity_add_off") else {
        return;
    };
    let scratch = Scratch::new("parite-volume");
    let source = short_title_source(&scratch, &ffmpeg);

    for mode in [SilenceMode::Add, SilenceMode::Off] {
        let outputs = both_editors(&ffmpeg, &source, mode, true);
        assert!(
            outputs.graph_filters.contains("volume="),
            "{mode:?} : mesuré sans ses bords, le titre sort de la bande morte et reçoit un gain ; filtres du graphe : {}",
            outputs.graph_filters
        );
        assert!(
            outputs.menus == outputs.graph,
            "{mode:?} : les deux éditeurs livrent le même fichier ({} octets par menus, {} par le graphe)",
            outputs.menus.len(),
            outputs.graph.len()
        );
    }
}

#[test]
fn normalized_edges_keep_both_editors_identical() {
    let Some(ffmpeg) = ffmpeg_or_skip("loudness_parity_normalize") else {
        return;
    };
    let scratch = Scratch::new("parite-volume-normalize");
    let source = short_title_source(&scratch, &ffmpeg);

    let outputs = both_editors(&ffmpeg, &source, SilenceMode::Normalize, true);
    assert!(outputs.graph_filters.contains("volume="));
    assert!(outputs.menus == outputs.graph);
}

#[test]
fn without_harmonization_no_gain_filter_is_applied() {
    let Some(ffmpeg) = ffmpeg_or_skip("loudness_parity_no_harmonization") else {
        return;
    };
    let scratch = Scratch::new("parite-volume-sans");
    let source = short_title_source(&scratch, &ffmpeg);

    for mode in [SilenceMode::Add, SilenceMode::Normalize, SilenceMode::Off] {
        let outputs = both_editors(&ffmpeg, &source, mode, false);
        assert!(
            !outputs.graph_filters.contains("volume=")
                && !outputs.graph_filters.contains("alimiter="),
            "{mode:?} : harmonisation désactivée, aucun filtre de gain ; filtres : {}",
            outputs.graph_filters
        );
        assert!(outputs.menus == outputs.graph, "{mode:?}");
    }
}
