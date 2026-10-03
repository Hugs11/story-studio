//! Garantie 2 — corpus, matrice de distances et calibration.
//!
//! Rien de ce fichier ne s'exécute pendant un export : l'empreinte est un
//! contrôle de conformance sur fixtures, pas un prouveur perceptuel. Les seuils
//! mesurés ici sont **ceux des sondes**, et ne deviennent pas des seuils
//! produit — il n'y a pas de seuil produit.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::*;
use crate::domain::project::SilenceMode;
use crate::native_pack::assets::advanced::conformance::{
    audio_fingerprint, distance_matrix, image_fingerprint, rooted_destination_addresses,
    Fingerprint, MatchVerdict, DISTINCT_MINIMUM, MATCH_TOLERANCE,
};
use crate::native_pack::assets::advanced::plan::{plan_audio, ConversionPlan};

const DEADLINE: Duration = Duration::from_secs(120);

/// Le corpus audio : des événements **placés dans le temps**, seule propriété
/// qu'une empreinte d'énergie sait distinguer.
fn audio_corpus(scratch: &Scratch) -> Vec<(&'static str, PathBuf)> {
    vec![
        (
            "debut",
            scratch.write_source("corpus", "debut.wav", &wav_bytes(&burst_at(0.05, 1.5))),
        ),
        (
            "milieu",
            scratch.write_source("corpus", "milieu.wav", &wav_bytes(&burst_at(0.60, 1.5))),
        ),
        (
            "fin",
            scratch.write_source("corpus", "fin.wav", &wav_bytes(&burst_at(1.15, 1.5))),
        ),
        (
            "continu",
            scratch.write_source("corpus", "continu.wav", &wav_bytes(&tone(440.0, 1.5, 0.6))),
        ),
    ]
}

/// Produit une référence **par un chemin indépendant de l'exécuteur** : le banc
/// invoque l'outil lui-même, avec la chaîne de filtres que le plan déclare.
fn reference_from_plan(ffmpeg: &Path, source: &Path, filters: &str, output: &Path) {
    let status = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-v",
            "error",
            "-y",
            "-i",
            &source.to_string_lossy(),
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "5",
            "-map_metadata",
            "-1",
            "-id3v2_version",
            "0",
            "-map",
            "0:a",
            "-af",
            filters,
            "-f",
            "mp3",
            &output.to_string_lossy(),
        ])
        .status()
        .expect("lancer FFmpeg pour la référence");
    assert!(status.success(), "la référence doit être produite");
}

#[test]
fn the_corpus_carries_its_distance_matrix_and_the_thresholds_are_separated() {
    let Some(ffmpeg) = ffmpeg_or_skip("distance_matrix") else {
        return;
    };
    let scratch = Scratch::new("matrice");
    let mut corpus = BTreeMap::new();
    for (name, path) in audio_corpus(&scratch) {
        corpus.insert(
            name.to_string(),
            audio_fingerprint(&ffmpeg, &path).expect("empreinte"),
        );
    }

    let matrix = distance_matrix(&corpus);
    eprintln!("[préparation] matrice de distances audio (calibration) :");
    let mut minimum = f64::INFINITY;
    for ((left, right), distance) in &matrix.distances {
        eprintln!("  {left:8} ↔ {right:8} : {distance:.4}");
        minimum = minimum.min(*distance);
    }
    eprintln!("[préparation] distance inter-médias minimale : {minimum:.4}");

    assert!(
        matrix.indistinguishable.is_empty(),
        "le corpus de conformance ne porte que des médias prouvés distinguables : {:?}",
        matrix.indistinguishable
    );
    assert!(
        minimum >= DISTINCT_MINIMUM,
        "distance minimale {minimum:.4} sous le seuil {DISTINCT_MINIMUM}"
    );
    assert!(
        minimum > MATCH_TOLERANCE * 4.0,
        "la séparation mesurée du corpus ({minimum:.4}) doit rester loin au-dessus de la tolérance d'appariement ({MATCH_TOLERANCE})"
    );

    // Le positif vaut exactement zéro : la référence est produite avec
    // le même outil et le même plan, donc les octets sont les mêmes. Cela
    // n'éprouve pas la tolérance. Ce qui l'éprouve, c'est une **perte de
    // génération** — le ré-encodage qu'une passerelle tierce fera subir au
    // média. On la mesure ici pour que le seuil repose sur un
    // nombre observé plutôt que sur une intuition.
    let mut worst_generation_loss: f64 = 0.0;
    for (name, path) in audio_corpus(&scratch) {
        let transcoded = scratch.root.join(format!("{name}-transcode.mp3"));
        reference_from_plan(&ffmpeg, &path, "aformat=channel_layouts=mono", &transcoded);
        let twice = scratch.root.join(format!("{name}-transcode-2.mp3"));
        reference_from_plan(&ffmpeg, &transcoded, "aformat=channel_layouts=mono", &twice);
        let loss = audio_fingerprint(&ffmpeg, &transcoded)
            .expect("empreinte")
            .distance(&audio_fingerprint(&ffmpeg, &twice).expect("empreinte"));
        eprintln!("[préparation] perte de génération « {name} » : {loss:.6}");
        worst_generation_loss = worst_generation_loss.max(loss);
    }
    eprintln!("[préparation] perte de génération maximale : {worst_generation_loss:.6}");
    assert!(
        worst_generation_loss <= MATCH_TOLERANCE,
        "un ré-encodage honnête doit rester apparié ({worst_generation_loss:.6} > {MATCH_TOLERANCE})"
    );
    assert!(
        worst_generation_loss * 4.0 < DISTINCT_MINIMUM,
        "et rester très loin de la séparation du corpus"
    );
}

#[test]
fn ce10_the_two_squares_are_reported_inconclusive_and_excluded_from_the_corpus() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce10") else {
        return;
    };
    let scratch = Scratch::new("carres");
    // 441 Hz et 220,5 Hz, même amplitude : **même valeur absolue à chaque
    // échantillon**. Leurs énergies sont égales quelle que soit la
    // segmentation. C'est la mesure qui démolit la prétention d'une garantie
    // exacte fondée sur une empreinte.
    let high = scratch.write_source("carres", "441.wav", &wav_bytes(&square(441.0, 1.0, 0.6)));
    let low = scratch.write_source("carres", "220.wav", &wav_bytes(&square(220.5, 1.0, 0.6)));

    let mut corpus = BTreeMap::new();
    corpus.insert(
        "carre-441".to_string(),
        audio_fingerprint(&ffmpeg, &high).expect("empreinte"),
    );
    corpus.insert(
        "carre-220".to_string(),
        audio_fingerprint(&ffmpeg, &low).expect("empreinte"),
    );

    let matrix = distance_matrix(&corpus);
    let distance = matrix
        .distances
        .values()
        .next()
        .copied()
        .expect("une paire");
    eprintln!("[préparation] distance 441 Hz ↔ 220,5 Hz : {distance:.6}");

    assert!(
        distance < DISTINCT_MINIMUM,
        "ce couple doit être reconnu indistinguable, pas séparé par un seuil"
    );
    assert_eq!(
        matrix.indistinguishable.len(),
        1,
        "le couple est **exclu** du corpus de conformance, jamais résolu"
    );

    // Et l'appariement le dit : non concluant. Jamais un succès.
    let verdict =
        corpus["carre-441"].match_against(&corpus["carre-441"], &[corpus["carre-220"].clone()]);
    assert_eq!(
        verdict,
        MatchVerdict::Inconclusive,
        "une ambiguïté n'est jamais tranchée en choisissant l'appariement qui rend les médias égaux"
    );
}

#[test]
fn ce7_a_media_converted_with_options_matches_the_reference_transformed_by_the_same_plan() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce7") else {
        return;
    };
    for (label, options) in [
        (
            "silences ajoutés",
            AdvancedAudioOptions {
                silence_mode: SilenceMode::Add,
                ..AdvancedAudioOptions::default()
            },
        ),
        (
            "harmonisation",
            AdvancedAudioOptions {
                harmonize_loudness: true,
                ..AdvancedAudioOptions::default()
            },
        ),
        (
            "harmonisation et bords normalisés",
            AdvancedAudioOptions {
                silence_mode: SilenceMode::Normalize,
                harmonize_loudness: true,
                ..AdvancedAudioOptions::default()
            },
        ),
    ] {
        let scratch = Scratch::new("ce7");
        let source = scratch.write_source("src", "voix.wav", &wav_bytes(&burst_at(0.30, 1.5)));
        let document = document_with(&stage(ENTRY, true, Some("voix.wav"), None), "");

        let preparation = prepare_advanced_assets(
            &document,
            &[binding("voix.wav", &source)],
            &scratch.workspace(),
            &ffmpeg,
            &options,
        )
        .unwrap_or_else(|error| panic!("{label} : {error:?}"));
        let produced = &preparation.archive_entries[0].output_path;

        // La référence est refaite par le banc, depuis le plan **déclaré**,
        // sans passer par l'exécuteur qu'elle contrôle.
        let snapshot_dir = Scratch::new("ce7-ref");
        let snapshot = snapshot_dir.write_source("s", "voix.wav", &fs::read(&source).unwrap());
        let plan = plan_audio(&ffmpeg, &snapshot, None, &options, DEADLINE).expect("plan");
        let ConversionPlan::AudioEncode { filters, .. } = &plan else {
            panic!("{label} : un WAV avec options est encodé");
        };
        let reference = snapshot_dir.root.join("reference.mp3");
        reference_from_plan(&ffmpeg, &snapshot, filters, &reference);

        let produced_print = audio_fingerprint(&ffmpeg, produced).expect("empreinte produite");
        let reference_print = audio_fingerprint(&ffmpeg, &reference).expect("empreinte référence");
        let distance = produced_print.distance(&reference_print);
        eprintln!("[préparation] « {label} » : distance au plan déclaré = {distance:.6}");

        assert!(
            distance <= MATCH_TOLERANCE,
            "{label} : la sortie doit correspondre à sa référence transformée par le même plan ({distance:.6} > {MATCH_TOLERANCE})"
        );
    }
}

#[test]
fn ce7_an_entirely_silent_media_gets_the_distinguished_silent_fingerprint() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce7_silent") else {
        return;
    };
    let scratch = Scratch::new("silence-empreinte");
    let source = scratch.write_source("src", "silence.wav", &wav_bytes(&silence(1.0)));

    let print = audio_fingerprint(&ffmpeg, &source).expect("empreinte");

    // Gain normalisé et rognage total ne donnent pas une empreinte ordinaire :
    // il n'y a ni gain de référence, ni contenu après rognage. Aucune division
    // n'est effectuée.
    assert_eq!(print, Fingerprint::Silent);
    assert_eq!(print.distance(&Fingerprint::Silent), 0.0);
    let sound = audio_fingerprint(
        &ffmpeg,
        &scratch.write_source("src", "son.wav", &wav_bytes(&tone(440.0, 1.0, 0.5))),
    )
    .expect("empreinte");
    assert!(
        print.distance(&sound) > DISTINCT_MINIMUM,
        "`silent` contre non-`silent` est un échec, pas un appariement"
    );
}

#[test]
fn ce9_swapping_two_media_is_transported_faithfully_and_caught_by_the_bounded_control() {
    let Some(ffmpeg) = ffmpeg_or_skip("ce9") else {
        return;
    };
    let scratch = Scratch::new("echange");
    let early = scratch.write_source("src", "debut.wav", &wav_bytes(&burst_at(0.05, 1.5)));
    let late = scratch.write_source("src", "fin.wav", &wav_bytes(&burst_at(1.15, 1.5)));
    let document = document_with(
        &[
            stage(ENTRY, true, Some("ref-debut"), None),
            stage(SECOND, false, Some("ref-fin"), None),
        ]
        .join(","),
        "",
    );

    let honest = prepare(
        &document,
        &[binding("ref-debut", &early), binding("ref-fin", &late)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation honnête");

    // On échange les **liaisons** : chaque référence pointe désormais vers le
    // fichier de l'autre.
    let swapped_scratch = Scratch::new("echange-2");
    let swapped = prepare(
        &document,
        &[binding("ref-debut", &late), binding("ref-fin", &early)],
        &swapped_scratch,
        &ffmpeg,
    )
    .expect("l'échange est transporté fidèlement : la garantie 1 ne juge pas la liaison");

    // La garantie 1 passe des deux côtés — elle le dit : elle ne dit rien de la
    // justesse de la liaison, seulement du transport.
    let expected = audio_fingerprint(&ffmpeg, &honest.archive_entries[0].output_path)
        .expect("empreinte attendue");
    let observed = audio_fingerprint(
        &ffmpeg,
        &swapped
            .archive_entries
            .iter()
            .find(|entry| entry.archive_name == swapped.destinations[0].archive_name)
            .expect("fichier de la première destination")
            .output_path,
    )
    .expect("empreinte observée");

    let others = [
        audio_fingerprint(&ffmpeg, &honest.archive_entries[1].output_path)
            .expect("empreinte de l'autre média"),
    ];
    assert_eq!(
        observed.match_against(&expected, &others),
        MatchVerdict::Mismatched,
        "sur des fixtures distinguables, l'échange de deux médias est vu"
    );
    // Et le contrôle passe sur la préparation honnête.
    assert_eq!(
        audio_fingerprint(&ffmpeg, &honest.archive_entries[0].output_path)
            .expect("empreinte")
            .match_against(&expected, &others),
        MatchVerdict::Matched
    );
}

#[test]
fn a_media_attached_to_the_wrong_option_is_caught_by_the_rooted_addressing() {
    let Some(ffmpeg) = ffmpeg_or_skip("wrong_option") else {
        return;
    };
    let scratch = Scratch::new("mauvaise-option");
    let early = scratch.write_source("src", "debut.wav", &wav_bytes(&burst_at(0.05, 1.5)));
    let late = scratch.write_source("src", "fin.wav", &wav_bytes(&burst_at(1.15, 1.5)));

    // Une entrée, une Action à deux options : l'option 0 mène au Stage qui porte
    // `ref-debut`, l'option 1 à celui qui porte `ref-fin`.
    let stages = [
        format!(
            r#"{{"uuid":"{ENTRY}","squareOne":true,"okTransition":{{"actionNode":"action-1","optionIndex":-1}}}}"#
        ),
        stage(SECOND, false, Some("ref-debut"), None),
        stage(THIRD, false, Some("ref-fin"), None),
    ]
    .join(",");
    let actions = format!(r#"{{"id":"action-1","options":["{SECOND}","{THIRD}"]}}"#);
    let document = document_with(&stages, &actions);

    let addresses = rooted_destination_addresses(&document);
    // L'ancrage est un **parcours enraciné** : ni un UUID relu, que le lecteur
    // FS régénère, ni le média lui-même, ce qui serait circulaire.
    assert_eq!(
        addresses.get("ok/opt:0#audio").map(String::as_str),
        Some("ref-debut")
    );
    assert_eq!(
        addresses.get("ok/opt:1#audio").map(String::as_str),
        Some("ref-fin")
    );

    let preparation = prepare(
        &document,
        &[binding("ref-debut", &early), binding("ref-fin", &late)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    let name_of = |asset_ref: &str| {
        preparation
            .destinations
            .iter()
            .find(|destination| destination.asset_ref == asset_ref)
            .map(|destination| destination.archive_name.clone())
            .expect("destination")
    };
    let output_of = |name: &str| {
        preparation
            .archive_entries
            .iter()
            .find(|entry| entry.archive_name == name)
            .map(|entry| entry.output_path.clone())
            .expect("fichier")
    };

    let at_option_zero =
        audio_fingerprint(&ffmpeg, &output_of(&name_of("ref-debut"))).expect("empreinte option 0");
    let at_option_one =
        audio_fingerprint(&ffmpeg, &output_of(&name_of("ref-fin"))).expect("empreinte option 1");

    // Rattacher le média de l'option 1 à l'adresse de l'option 0 est vu.
    assert!(
        at_option_zero.distance(&at_option_one) > DISTINCT_MINIMUM,
        "les deux options portent des médias distinguables : c'est la précondition"
    );
    assert_eq!(
        at_option_one.match_against(&at_option_zero, &[]),
        MatchVerdict::Mismatched,
        "le média de l'option 1 posé à l'adresse de l'option 0 est un échec d'appariement"
    );
    assert_eq!(
        at_option_zero.match_against(&at_option_zero, std::slice::from_ref(&at_option_one)),
        MatchVerdict::Matched,
        "et l'ancrage honnête passe"
    );
}

#[test]
fn images_are_fingerprinted_on_a_grid_that_respects_the_target_ratio() {
    let flat = image_fingerprint(&png_bytes(320, 240, 0)).expect("empreinte");
    let other = image_fingerprint(&png_bytes(320, 240, 1)).expect("empreinte");

    assert!(
        flat.distance(&other) > 0.0,
        "deux répartitions de luminance distinctes ne peuvent pas partager une empreinte"
    );
    assert_eq!(
        flat.distance(&flat),
        0.0,
        "une image est identique à elle-même"
    );
    let Fingerprint::Shape(values) = &flat else {
        panic!("une image porteuse d'énergie a une forme");
    };
    assert_eq!(values.len(), 16 * 12, "grille 4:3, comme l'écran cible");
    let total: f64 = values.iter().sum();
    assert!((total - 1.0).abs() < 1e-9, "l'empreinte est normalisée");
}

/// Une image de test à contraste réglable, encodée en PNG.
///
/// `floor` et `ceiling` sont les deux niveaux réellement écrits : ils
/// permettent de rejouer exactement la requantification de palette observée
/// chez une passerelle, sans dépendre d'elle.
fn banded_png(floor: u8, ceiling: u8, lit_band: u32) -> Vec<u8> {
    let image = image::RgbImage::from_fn(320, 240, |x, _| {
        let level = if x / 40 == lit_band { ceiling } else { floor };
        image::Rgb([level, level, level])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("encoder la fixture image");
    out
}

/// Une requantification de palette qui **déplace les niveaux sans
/// changer l'image** doit rester appariée, y compris sur le contenu le plus
/// défavorable à l'empreinte.
///
/// Le cas est celui mesuré sur de vraies archives passées aux deux
/// passerelles : fond sombre occupant les sept huitièmes de l'image, une bande
/// claire, puis noirs ramenés à `0` et blancs abaissés de sept niveaux. C'est
/// la forme de contenu qui amplifie le plus un décalage de niveau, donc celle
/// qui doit garder la propriété.
#[test]
fn a_palette_level_shift_keeps_a_low_key_image_matched() {
    let source = image_fingerprint(&banded_png(8, 246, 2)).expect("empreinte source");
    let requantised = image_fingerprint(&banded_png(0, 239, 2)).expect("empreinte requantifiée");
    let distance = source.distance(&requantised);

    assert!(
        distance <= MATCH_TOLERANCE,
        "un décalage de niveaux ne change pas l'image : {distance:.6} > {MATCH_TOLERANCE}"
    );

    // La robustesse ne doit pas coûter la séparation : la même image décalée
    // reste très loin d'une image dont la bande claire est ailleurs.
    let elsewhere = image_fingerprint(&banded_png(0, 239, 5)).expect("empreinte voisine");
    assert!(
        source.distance(&elsewhere) >= DISTINCT_MINIMUM,
        "deux bandes distinctes doivent rester distinguables ({:.6})",
        source.distance(&elsewhere)
    );
    assert_eq!(
        requantised.match_against(&source, std::slice::from_ref(&elsewhere)),
        MatchVerdict::Matched,
        "l'image requantifiée s'apparie à sa propre référence"
    );
    // L'alternative doit être une **autre place**, pas un ré-encodage de la
    // même : une référence confrontée à sa propre copie est à bon droit
    // `Inconclusive`, et ce n'est pas ce qu'on éprouve ici.
    let third = image_fingerprint(&banded_png(8, 246, 6)).expect("empreinte tierce");
    assert_eq!(
        elsewhere.match_against(&source, &[third]),
        MatchVerdict::Mismatched,
        "une autre image ne s'apparie pas, même après le même décalage"
    );
}

/// La contrepartie déclarée : sans contraste, il n'y a pas de forme, et
/// l'empreinte le dit au lieu d'amplifier du bruit de quantification.
#[test]
fn a_flat_image_has_no_shape_to_compare() {
    let flat = image_fingerprint(&banded_png(120, 120, 2)).expect("empreinte aplat");
    let Fingerprint::Shape(values) = &flat else {
        panic!("un aplat porteur d'énergie garde une forme uniforme");
    };
    let first = values[0];
    assert!(
        values.iter().all(|value| (value - first).abs() < 1e-9),
        "un aplat rend une grille uniforme, sans forme privilégiée"
    );
}
