//! La chaîne de conversion, et ce que le rapport en dit.
//!
//! Ces tests exigent un transcodage **réel** : c'est le codec qu'ils prétendent
//! éprouver, et un double ne l'éprouverait pas.

use std::fs;

use super::*;
use crate::domain::project::SilenceMode;
use crate::native_pack::assets::advanced::plan::{plan_audio, ConversionPlan, PlanStep};
use crate::native_pack::assets::advanced::report::Transformation;

fn record<'a>(
    preparation: &'a AdvancedAssetPreparation,
    asset_ref: &str,
) -> &'a crate::native_pack::assets::advanced::report::AssetConversionRecord {
    preparation
        .assets
        .iter()
        .find(|record| record.asset_ref == asset_ref)
        .unwrap_or_else(|| panic!("le rapport porte {asset_ref}"))
}

#[test]
fn a_wav_an_offformat_png_and_a_conforming_mp3_cross_the_chain_as_expected() {
    let Some(ffmpeg) = ffmpeg_or_skip("wav_png_mp3_chain") else {
        return;
    };
    let scratch = Scratch::new("chaine");
    let wav = scratch.write_source("src", "voix.wav", &wav_bytes(&tone(440.0, 0.6, 0.5)));
    let png = scratch.write_source("src", "grande.png", &png_bytes(640, 480, 1));
    let mp3_bytes = encode_conforming_mp3(&ffmpeg, &scratch, &tone(330.0, 0.6, 0.5));
    let mp3 = scratch.write_source("src", "deja.mp3", &mp3_bytes);

    let document = document_with(
        &[
            stage(ENTRY, true, Some("voix.wav"), Some("grande.png")),
            stage(SECOND, false, Some("deja.mp3"), None),
        ]
        .join(","),
        "",
    );
    let bindings = vec![
        binding("voix.wav", &wav),
        binding("grande.png", &png),
        binding("deja.mp3", &mp3),
    ];

    let preparation = prepare(&document, &bindings, &scratch, &ffmpeg).expect("préparation");

    let wav_record = record(&preparation, "voix.wav");
    assert_eq!(wav_record.transformation, Transformation::Reencoded);
    assert_eq!(wav_record.output_format, "mp3");
    assert!(wav_record.detected_source_format.starts_with("wav"));
    assert!(wav_record.archive_name.ends_with(".mp3"));
    assert_eq!(
        wav_record.applied_plan,
        vec!["mono-downmix", "mp3-encode"],
        "sans option demandée, un WAV n'est mis en conformité que par le mixage et l'encodage"
    );

    let png_record = record(&preparation, "grande.png");
    assert_eq!(png_record.transformation, Transformation::Resized);
    assert_eq!(png_record.output_format, "png");
    assert_eq!(png_record.detected_source_format, "png-640x480");
    assert_eq!(
        png_record.applied_plan,
        vec!["resize-320x240", "png-encode"]
    );

    // Le fichier déjà conforme n'est pas réencodé : ses octets sortent
    // **identiques**, et le rapport ne prétend aucune transformation.
    let mp3_record = record(&preparation, "deja.mp3");
    assert_eq!(mp3_record.transformation, Transformation::Verbatim);
    assert!(mp3_record.applied_plan.is_empty());
    assert_eq!(
        mp3_record.source_bytes, mp3_record.output_bytes,
        "octet pour octet"
    );
    let written = preparation
        .archive_entries
        .iter()
        .find(|entry| entry.archive_name == mp3_record.archive_name)
        .expect("le fichier conforme est dans l'archive");
    assert_eq!(
        fs::read(&written.output_path).expect("relire la sortie"),
        mp3_bytes,
        "un média déjà conforme sort octet pour octet identique"
    );
}

#[test]
fn a_conforming_mp3_named_wav_keeps_its_bytes_and_gains_the_right_extension() {
    let Some(ffmpeg) = ffmpeg_or_skip("renamed_verbatim") else {
        return;
    };
    let scratch = Scratch::new("renomme");
    let mp3_bytes = encode_conforming_mp3(&ffmpeg, &scratch, &tone(520.0, 0.5, 0.4));
    // Le nom d'auteur ment sur le format. Le laisser tel quel ferait transcoder
    // le média par Lunii.QT et décoder en WAV par STUdio.
    let source = scratch.write_source("src", "voix.wav", &mp3_bytes);

    let document = document_with(&stage(ENTRY, true, Some("voix.wav"), None), "");
    let preparation = prepare(
        &document,
        &[binding("voix.wav", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    let record = record(&preparation, "voix.wav");
    assert_eq!(record.transformation, Transformation::Renamed);
    assert!(record.archive_name.ends_with(".mp3"));
    assert_eq!(record.source_bytes, record.output_bytes, "octets conservés");
    assert_eq!(
        record.asset_ref, "voix.wav",
        "la référence du dialecte n'est jamais réécrite : seul le nom d'archive change"
    );
}

#[test]
fn a_320x240_image_in_a_format_studio_ignores_is_reencoded_not_kept() {
    let Some(ffmpeg) = ffmpeg_or_skip("offlist_format_reencoded") else {
        return;
    };
    let scratch = Scratch::new("hors-liste");
    // Le trou connu : `ensure_image_320x240` rend « conforme » dès que
    // l'image mesure 320×240, quelle que soit son extension. STUdio, lui, ne
    // pose alors ni image ni audio sur le Stage — le pack perd l'image **sans
    // message**. Le chemin avancé n'hérite pas de ce trou.
    let gif = scratch.write_source("src", "deja.gif", &gif_bytes(320, 240, 2));

    let document = document_with(&stage(ENTRY, true, None, Some("deja.gif")), "");
    let preparation =
        prepare(&document, &[binding("deja.gif", &gif)], &scratch, &ffmpeg).expect("préparation");

    let record = record(&preparation, "deja.gif");
    assert_eq!(
        record.transformation,
        Transformation::Reencoded,
        "les dimensions sont bonnes, le format ne l'est pas"
    );
    assert_eq!(record.output_format, "png");
    assert!(record.archive_name.ends_with(".png"));
    assert!(record.reason.contains("hors liste"), "{}", record.reason);
}

#[test]
fn a_bmp_at_the_right_size_is_kept_verbatim_because_studio_reads_it() {
    let Some(ffmpeg) = ffmpeg_or_skip("bmp_verbatim") else {
        return;
    };
    let scratch = Scratch::new("bmp");
    let bytes = bmp_bytes(320, 240, 0);
    let source = scratch.write_source("src", "fond.bmp", &bytes);

    let document = document_with(&stage(ENTRY, true, None, Some("fond.bmp")), "");
    let preparation = prepare(
        &document,
        &[binding("fond.bmp", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    let record = record(&preparation, "fond.bmp");
    assert_eq!(record.transformation, Transformation::Verbatim);
    assert_eq!(record.output_format, "bmp");
    assert_eq!(record.source_bytes, record.output_bytes);
}

#[test]
fn an_entirely_silent_media_is_prepared_and_never_refused() {
    let Some(ffmpeg) = ffmpeg_or_skip("silent_media") else {
        return;
    };
    let scratch = Scratch::new("silence");
    let source = scratch.write_source("src", "silence.wav", &wav_bytes(&silence(0.5)));
    let document = document_with(&stage(ENTRY, true, Some("silence.wav"), None), "");

    // Le mode Libre refuse ici : `edge_plan_for_generation` rejette
    // `EdgeMeasure::AllSilence` **avant** d'envisager la copie verbatim. Un
    // silence voulu par l'auteur n'est pas un média substitué, ce que la
    // préparation refuse.
    let preparation = prepare_advanced_assets(
        &document,
        &[binding("silence.wav", &source)],
        &scratch.workspace(),
        &ffmpeg,
        &AdvancedAudioOptions {
            silence_mode: SilenceMode::Normalize,
            harmonize_loudness: true,
            ..AdvancedAudioOptions::default()
        },
    )
    .expect("un média silencieux traverse la chaîne");

    let record = record(&preparation, "silence.wav");
    assert!(record.output_bytes > 0);
    assert!(record.applied_plan.contains(&"mp3-encode"));
    assert!(
        !record.applied_plan.contains(&"gain"),
        "un niveau inétablissable ne se corrige pas : inventer un gain changerait le son livré"
    );
}

#[test]
fn a_media_corrupted_mid_stream_is_a_damaged_file_not_an_undecodable_one() {
    let Some(ffmpeg) = ffmpeg_or_skip("corrupted_mid_stream") else {
        return;
    };
    let scratch = Scratch::new("corrompu");
    let mut bytes = encode_conforming_mp3(&ffmpeg, &scratch, &tone(440.0, 3.0, 0.5));
    assert!(
        bytes.len() > 4096,
        "la fixture doit porter plusieurs trames"
    );
    // On abîme le flux **en cours de route** : du son sort, puis le décodage
    // bute. C'est le cas que la révision 4 laissait sans case.
    let start = bytes.len() / 2;
    for byte in bytes.iter_mut().skip(start).take(1500) {
        *byte = 0xFF;
    }
    let source = scratch.write_source("src", "abime.mp3", &bytes);

    let document = document_with(&stage(ENTRY, true, Some("abime.mp3"), None), "");
    let outcome = prepare(
        &document,
        &[binding("abime.mp3", &source)],
        &scratch,
        &ffmpeg,
    );

    match outcome {
        Err(error) => {
            let observed = causes(&error);
            assert!(
                observed == vec![MediaCause::ValidationFailed]
                    || observed == vec![MediaCause::Undecodable],
                "un flux abîmé est refusé par la validation, jamais converti à l'aveugle : {observed:?}"
            );
        }
        // FFmpeg est tolérant sur les trames MPEG : s'il va au bout, le média
        // est décodable et la conversion est légitime. Ce qui compte est qu'il
        // n'y ait pas de troisième issue.
        Ok(preparation) => {
            assert_eq!(record(&preparation, "abime.mp3").output_format, "mp3");
        }
    }
}

#[test]
fn options_are_the_only_reason_a_conforming_media_gets_reencoded() {
    let Some(ffmpeg) = ffmpeg_or_skip("options_force_reencode") else {
        return;
    };
    let scratch = Scratch::new("options");
    let mp3 = encode_conforming_mp3(&ffmpeg, &scratch, &tone(440.0, 1.0, 0.5));
    let source = scratch.write_source("src", "conforme.mp3", &mp3);
    let document = document_with(&stage(ENTRY, true, Some("conforme.mp3"), None), "");
    let bindings = [binding("conforme.mp3", &source)];

    let neutral = prepare(&document, &bindings, &scratch, &ffmpeg).expect("sans option");
    assert_eq!(
        record(&neutral, "conforme.mp3").transformation,
        Transformation::Verbatim
    );

    let with_silence = Scratch::new("options-2");
    let asked = prepare_advanced_assets(
        &document,
        &bindings,
        &with_silence.workspace(),
        &ffmpeg,
        &AdvancedAudioOptions {
            silence_mode: SilenceMode::Add,
            ..AdvancedAudioOptions::default()
        },
    )
    .expect("avec silences demandés");
    let record = record(&asked, "conforme.mp3");
    assert_eq!(record.transformation, Transformation::Reencoded);
    assert!(
        record.applied_plan.contains(&"silence-pad"),
        "{:?}",
        record.applied_plan
    );
}

#[test]
fn the_plan_names_the_limiter_only_when_the_chain_really_carries_it() {
    let Some(ffmpeg) = ffmpeg_or_skip("limiter_in_plan") else {
        return;
    };
    let scratch = Scratch::new("limiteur");
    // Un signal très chaud : après gain vers −14 LUFS, la crête dépasse le
    // plafond, donc `plan_loudness_fix` demande le limiteur (T4).
    let source = scratch.write_source("src", "chaud.wav", &wav_bytes(&square(220.0, 1.0, 0.99)));
    let snapshot_dir = Scratch::new("limiteur-ws");
    let snapshot = snapshot_dir.write_source("s", "chaud.wav", &fs::read(&source).unwrap());

    let plan = plan_audio(
        &ffmpeg,
        &snapshot,
        None,
        &AdvancedAudioOptions {
            harmonize_loudness: true,
            ..AdvancedAudioOptions::default()
        },
        std::time::Duration::from_secs(120),
    )
    .expect("plan audio");

    let ConversionPlan::AudioEncode {
        filters, applied, ..
    } = &plan
    else {
        panic!("un WAV harmonisé est encodé, obtenu {plan:?}");
    };
    assert!(filters.contains("aformat=channel_layouts=mono"));
    assert_eq!(
        applied.contains(&PlanStep::Limiter),
        filters.contains("alimiter="),
        "le plan déclare le limiteur exactement quand la chaîne le porte"
    );
    assert_eq!(
        applied.contains(&PlanStep::Gain),
        filters.contains("volume="),
        "et le gain de la même façon"
    );
}

/// Parité avec l'éditeur par menus : un son presque muet, harmonisé, porte le
/// même avertissement — même code, même message, mêmes mesures — et le nom de
/// l'Écran qui le fait entendre.
#[test]
fn a_near_mute_sound_is_reported_like_the_menu_editor_does() {
    let Some(ffmpeg) = ffmpeg_or_skip("near_mute_notice") else {
        return;
    };
    let scratch = Scratch::new("presque-muet");
    let source = scratch.write_source("src", "souffle.wav", &wav_bytes(&tone(440.0, 1.0, 0.002)));
    let document = document_with(
        &format!(
            r#"{{"uuid":"{ENTRY}","squareOne":true,"name":"Écran du souffle","audio":"souffle.wav"}}"#
        ),
        "",
    );

    let preparation = prepare_advanced_assets(
        &document,
        &[binding("souffle.wav", &source)],
        &scratch.workspace(),
        &ffmpeg,
        &AdvancedAudioOptions {
            harmonize_loudness: true,
            ..AdvancedAudioOptions::default()
        },
    )
    .expect("un son presque muet ne bloque pas l'export");

    let [warning] = preparation.audio_warnings.as_slice() else {
        panic!(
            "un avertissement attendu : {:?}",
            preparation.audio_warnings
        );
    };
    assert_eq!(warning.code, "AUDIO_NEAR_MUTE_BOOST");
    assert_eq!(warning.label, "Écran du souffle");
    assert!(warning.message.contains("« Écran du souffle »"));
    assert!(warning.gain_db > 0.0);
    assert!(warning.final_integrated_lufs.is_some());
}

/// Sans harmonisation, rien n'est mesuré, donc rien n'est signalé.
#[test]
fn without_harmonization_nothing_is_reported() {
    let Some(ffmpeg) = ffmpeg_or_skip("no_notice_without_harmonization") else {
        return;
    };
    let scratch = Scratch::new("sans-harmonisation");
    let source = scratch.write_source("src", "souffle.wav", &wav_bytes(&tone(440.0, 1.0, 0.002)));
    let document = document_with(&stage(ENTRY, true, Some("souffle.wav"), None), "");

    let preparation = prepare(
        &document,
        &[binding("souffle.wav", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");
    assert!(preparation.audio_warnings.is_empty());
}

#[test]
fn two_screens_sharing_a_reference_produce_one_file_and_two_destinations() {
    let Some(ffmpeg) = ffmpeg_or_skip("shared_reference") else {
        return;
    };
    let scratch = Scratch::new("partage");
    let source = scratch.write_source("src", "commun.wav", &wav_bytes(&tone(440.0, 0.4, 0.5)));
    let document = document_with(
        &[
            stage(ENTRY, true, Some("commun.wav"), None),
            stage(SECOND, false, Some("commun.wav"), None),
        ]
        .join(","),
        "",
    );

    let preparation = prepare(
        &document,
        &[binding("commun.wav", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    assert_eq!(preparation.assets.len(), 1, "un seul média inventorié");
    assert_eq!(
        preparation.archive_entries.len(),
        1,
        "un seul fichier écrit"
    );
    assert_eq!(preparation.destinations.len(), 2, "deux places servies");
    assert_eq!(
        preparation.destinations[0].archive_name,
        preparation.destinations[1].archive_name
    );
    assert_eq!(preparation.destinations[0].stage_uuid, ENTRY);
    assert_eq!(preparation.destinations[1].stage_uuid, SECOND);
}

#[test]
fn two_homonyms_from_distinct_folders_never_merge() {
    let Some(ffmpeg) = ffmpeg_or_skip("homonyms") else {
        return;
    };
    let scratch = Scratch::new("homonymes");
    // Même nom de fichier, deux dossiers, deux contenus. Un nommage fondé sur
    // le nom d'auteur les confondrait ; un nommage adressé par contenu, non.
    let first = scratch.write_source("chapitre-1", "voix.wav", &wav_bytes(&tone(440.0, 0.4, 0.5)));
    let second = scratch.write_source("chapitre-2", "voix.wav", &wav_bytes(&tone(880.0, 0.4, 0.5)));
    let document = document_with(
        &[
            stage(ENTRY, true, Some("voix-1"), None),
            stage(SECOND, false, Some("voix-2"), None),
        ]
        .join(","),
        "",
    );

    let preparation = prepare(
        &document,
        &[binding("voix-1", &first), binding("voix-2", &second)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    assert_eq!(
        preparation.archive_entries.len(),
        2,
        "deux fichiers distincts"
    );
    assert_ne!(
        preparation.destinations[0].archive_name,
        preparation.destinations[1].archive_name
    );
    assert_ne!(
        preparation.destinations[0].output_sha256,
        preparation.destinations[1].output_sha256
    );
}

#[test]
fn deduplication_reports_the_reference_that_already_carries_the_content() {
    let Some(ffmpeg) = ffmpeg_or_skip("deduplication") else {
        return;
    };
    let scratch = Scratch::new("dedup");
    // Deux références distinctes du dialecte, deux fichiers distincts sur le
    // disque, mais **les mêmes octets** : un seul fichier doit partir.
    let bytes = wav_bytes(&tone(440.0, 0.4, 0.5));
    let first = scratch.write_source("a", "voix.wav", &bytes);
    let second = scratch.write_source("b", "copie.wav", &bytes);
    let document = document_with(
        &[
            stage(ENTRY, true, Some("ref-a"), None),
            stage(SECOND, false, Some("ref-b"), None),
        ]
        .join(","),
        "",
    );

    let preparation = prepare(
        &document,
        &[binding("ref-a", &first), binding("ref-b", &second)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    assert_eq!(preparation.archive_entries.len(), 1);
    assert_eq!(record(&preparation, "ref-a").deduplicated_with, None);
    assert_eq!(
        record(&preparation, "ref-b").deduplicated_with.as_deref(),
        Some("ref-a"),
        "le rapport dit avec quoi le média a été dédupliqué"
    );
    assert_eq!(
        record(&preparation, "ref-a").task_key,
        record(&preparation, "ref-b").task_key,
        "même instantané et même plan : une seule tâche, une seule exécution"
    );
}

#[test]
fn the_author_document_its_context_and_its_bindings_are_untouched() {
    let Some(ffmpeg) = ffmpeg_or_skip("author_untouched") else {
        return;
    };
    let scratch = Scratch::new("intact");
    let wav = scratch.write_source("src", "voix.wav", &wav_bytes(&tone(440.0, 0.4, 0.5)));
    let png = scratch.write_source("src", "image.png", &png_bytes(640, 480, 1));
    let document = document_with(&stage(ENTRY, true, Some("voix.wav"), Some("image.png")), "");
    let bindings = vec![binding("voix.wav", &wav), binding("image.png", &png)];

    let before_document = serde_json::to_string(&document).expect("sérialiser le document");
    let before_bindings = bindings.clone();
    let before_sources = (
        fs::read(&wav).expect("relire la source"),
        fs::read(&png).expect("relire la source"),
    );

    prepare(&document, &bindings, &scratch, &ffmpeg).expect("préparation");

    assert_eq!(
        serde_json::to_string(&document).expect("resérialiser"),
        before_document,
        "une préparation lit le document d'auteur, elle ne l'écrit pas"
    );
    assert_eq!(bindings, before_bindings, "les liaisons sont inchangées");
    assert_eq!(
        (
            fs::read(&wav).expect("relire"),
            fs::read(&png).expect("relire")
        ),
        before_sources,
        "les fichiers de l'auteur ne sont jamais réécrits : l'export travaille sur des instantanés"
    );
}

#[test]
fn nothing_is_written_outside_the_workspace() {
    let Some(ffmpeg) = ffmpeg_or_skip("workspace_only") else {
        return;
    };
    let scratch = Scratch::new("perimetre");
    let source = scratch.write_source("src", "voix.wav", &wav_bytes(&tone(440.0, 0.4, 0.5)));
    let document = document_with(&stage(ENTRY, true, Some("voix.wav"), None), "");

    let before: Vec<_> = fs::read_dir(scratch.sources().join("src"))
        .expect("lire les sources")
        .map(|entry| entry.expect("entrée").file_name())
        .collect();

    prepare(
        &document,
        &[binding("voix.wav", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect("préparation");

    let after: Vec<_> = fs::read_dir(scratch.sources().join("src"))
        .expect("lire les sources")
        .map(|entry| entry.expect("entrée").file_name())
        .collect();
    assert_eq!(before, after, "le dossier de l'auteur ne reçoit rien");
    assert!(
        scratch.workspace().join("snapshots").is_dir()
            && scratch.workspace().join("outputs").is_dir(),
        "tout ce que la préparation écrit vit sous son espace de travail"
    );
}
