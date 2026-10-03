//! Résolution et refus : ce que l'inventaire établit avant toute conversion.

use std::fs;

use super::*;
use crate::native_pack::assets::advanced::format::{
    detect_audio_container, parse_mpeg_frame_header, AudioContainer,
};
use crate::native_pack::assets::advanced::inventory::media_destinations;
use crate::native_pack::assets::advanced::probe::{classify, InvocationOutcome, ToolOperation};

#[test]
fn every_stage_field_that_carries_a_reference_becomes_a_destination() {
    let document = document_with(
        &[
            stage(ENTRY, true, Some("a.wav"), Some("i.png")),
            stage(SECOND, false, Some("a.wav"), None),
            stage(THIRD, false, None, None),
        ]
        .join(","),
        "",
    );

    let destinations = media_destinations(&document);

    assert_eq!(destinations.len(), 3, "{destinations:?}");
    assert_eq!(destinations[0].stage_uuid, ENTRY);
    assert_eq!(destinations[0].kind, MediaKind::Audio);
    assert_eq!(destinations[1].kind, MediaKind::Image);
    assert_eq!(destinations[2].stage_uuid, SECOND);
    // La référence partagée produit **deux** destinations : une place n'est pas
    // un fichier, et c'est toute la difficulté que le lot doit tenir.
    assert_eq!(destinations[2].asset_ref, "a.wav");
}

#[test]
fn a_blank_reference_is_not_a_media_and_is_never_resolved() {
    let document = document_with(&stage(ENTRY, true, Some("   "), None), "");
    assert!(
        media_destinations(&document).is_empty(),
        "une chaîne vide n'est pas une référence : inventer un fichier derrière elle serait une résolution silencieuse"
    );
}

#[test]
fn an_opaque_member_that_mentions_a_file_name_is_never_aspirated_as_a_media() {
    // Une extension opaque peut mentionner un ancien nom d'asset. Elle est
    // conservée, jamais parcourue comme un média.
    let source = format!(
        r#"{{"format":"v1","version":1,"stageNodes":[{{"uuid":"{ENTRY}","squareOne":true,"vendorArt":"souvenir.png","vendorList":["autre.mp3"]}}],"actionNodes":[]}}"#
    );
    let document = crate::native_pack::decode_story_document(&source)
        .expect("document décodable")
        .document;

    assert!(
        media_destinations(&document).is_empty(),
        "un membre opaque n'est pas une place média"
    );
}

#[test]
fn three_distinct_refusals_for_a_missing_an_unreadable_and_an_empty_media() {
    let Some(ffmpeg) = ffmpeg_or_skip("three_distinct_refusals") else {
        return;
    };
    let scratch = Scratch::new("refusals");

    let absent = scratch.sources().join("jamais-ecrit.wav");
    let empty = scratch.write_source("vide", "vide.wav", b"");
    let directory = scratch.sources().join("un-dossier");
    fs::create_dir_all(&directory).expect("créer le dossier leurre");

    let document = document_with(
        &[
            stage(ENTRY, true, Some("absent.wav"), None),
            stage(SECOND, false, Some("vide.wav"), None),
            stage(THIRD, false, Some("dossier.wav"), None),
        ]
        .join(","),
        "",
    );
    let bindings = vec![
        missing_at("absent.wav", &absent),
        binding("vide.wav", &empty),
        binding("dossier.wav", &directory),
    ];

    let error = prepare(&document, &bindings, &scratch, &ffmpeg).expect_err("refus attendu");

    assert_eq!(
        causes(&error),
        vec![
            MediaCause::NotFound,
            MediaCause::Empty,
            MediaCause::NotRegular
        ],
        "trois causes distinctes et lisibles, dans l'ordre du document"
    );
    let AssetPreparationError::MediaUnavailable(entries) = &error else {
        unreachable!()
    };
    // Le refus dit **où** le média manque : sans les Stages, l'auteur ne sait
    // pas quel écran réparer.
    assert_eq!(entries[0].stage_ids, vec![ENTRY.to_string()]);
    assert_eq!(entries[1].stage_ids, vec![SECOND.to_string()]);
    assert_eq!(entries[0].last_known_path.as_deref(), absent.to_str());
    assert!(
        !scratch.workspace().join("outputs").exists()
            || fs::read_dir(scratch.workspace().join("outputs"))
                .expect("lire outputs")
                .next()
                .is_none(),
        "aucune conversion ne commence tant que l'inventaire n'est pas complet"
    );
}

#[test]
fn a_binding_that_is_absent_and_a_binding_without_path_are_two_causes() {
    let Some(ffmpeg) = ffmpeg_or_skip("binding_absent_and_path_null") else {
        return;
    };
    let scratch = Scratch::new("bindings");
    let document = document_with(
        &[
            stage(ENTRY, true, Some("sans-liaison.wav"), None),
            stage(SECOND, false, Some("sans-chemin.wav"), None),
        ]
        .join(","),
        "",
    );
    let bindings = vec![unbound("sans-chemin.wav")];

    let error = prepare(&document, &bindings, &scratch, &ffmpeg).expect_err("refus attendu");

    assert_eq!(
        causes(&error),
        vec![MediaCause::BindingAbsent, MediaCause::PathNull],
        "une liaison manquante et une liaison sans fichier ne se résolvent pas de la même façon"
    );
}

#[test]
fn the_whole_inventory_is_listed_without_priority_between_families() {
    let Some(ffmpeg) = ffmpeg_or_skip("whole_inventory_listed") else {
        return;
    };
    let scratch = Scratch::new("aggregate");
    let empty = scratch.write_source("a", "vide.wav", b"");
    let document = document_with(
        &[
            stage(ENTRY, true, Some("sans-liaison.wav"), None),
            stage(SECOND, false, Some("vide.wav"), None),
            stage(THIRD, false, Some("absent.wav"), None),
        ]
        .join(","),
        "",
    );
    let bindings = vec![
        binding("vide.wav", &empty),
        missing_at("absent.wav", &scratch.sources().join("nulle-part.wav")),
    ];

    let error = prepare(&document, &bindings, &scratch, &ffmpeg).expect_err("refus attendu");

    assert_eq!(
        causes(&error).len(),
        3,
        "un inventaire mixte est listé entièrement : l'auteur répare une fois, pas trois"
    );
}

#[test]
fn four_bytes_that_satisfy_the_header_preselection_are_refused_as_undecodable() {
    let Some(ffmpeg) = ffmpeg_or_skip("four_bytes_undecodable") else {
        return;
    };
    let scratch = Scratch::new("four-bytes");

    // Le prédicat historique accepte ces quatre octets : sync MPEG, MPEG-1,
    // 44,1 kHz, mono. C'est exactement le trou que la validation de
    // décodabilité referme.
    let bytes = [0xFF_u8, 0xFB, 0x90, 0xC0];
    assert!(
        crate::native_pack::assets::audio::mp3_header_is_native_compatible(&bytes),
        "la présélection accepte ces quatre octets : c'est la prémisse du test"
    );
    let source = scratch.write_source("court", "court.mp3", &bytes);

    let document = document_with(&stage(ENTRY, true, Some("court.mp3"), None), "");
    let error = prepare(
        &document,
        &[binding("court.mp3", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect_err("refus attendu");

    assert_eq!(
        causes(&error),
        vec![MediaCause::Undecodable],
        "un décodage sans la moindre donnée n'établit rien"
    );
}

#[test]
fn a_layer_two_header_is_not_conform_even_though_the_preselection_accepts_it() {
    // `FF FD 90 C0` : MPEG-1, **Layer II**, 44,1 kHz, mono. Le prédicat
    // historique ne regarde jamais les bits de couche.
    let bytes = [0xFF_u8, 0xFD, 0x90, 0xC0];
    assert!(
        crate::native_pack::assets::audio::mp3_header_is_native_compatible(&bytes),
        "la présélection l'accepte"
    );

    let header = parse_mpeg_frame_header(&bytes).expect("un en-tête MPEG est lisible");

    assert_eq!(header.layer, 2, "Layer II");
    assert_eq!(header.sample_rate_hz, Some(44_100));
    assert_eq!(header.channel_mode, 3, "mono");
    assert!(
        !header.is_studio_conform(),
        "la conformité de format lit la couche : un Layer II n'est pas un MP3 des passerelles"
    );
}

#[test]
fn containers_are_recognised_from_their_own_bytes_and_never_from_a_name() {
    assert_eq!(
        detect_audio_container(&wav_bytes(&silence(0.01))),
        AudioContainer::Wav
    );
    assert_eq!(detect_audio_container(b"OggS\0\0\0\0"), AudioContainer::Ogg);
    assert_eq!(
        detect_audio_container(b"fLaC\0\0\0\0"),
        AudioContainer::Flac
    );
    assert_eq!(
        detect_audio_container(b"FORM\0\0\0\0AIFF"),
        AudioContainer::Aiff
    );
    assert_eq!(
        detect_audio_container(&[0xFF, 0xFB, 0x90, 0xC0]),
        AudioContainer::Mpeg
    );
    assert_eq!(
        detect_audio_container(b"pas un media"),
        AudioContainer::Unknown
    );
}

#[test]
fn an_image_that_does_not_decode_is_refused_and_never_resized_approximately() {
    let Some(ffmpeg) = ffmpeg_or_skip("image_undecodable") else {
        return;
    };
    let scratch = Scratch::new("image-cassee");
    let mut broken = png_bytes(320, 240, 0);
    // On casse le corps, pas la signature : le fichier se présente comme un PNG.
    for byte in broken.iter_mut().skip(40) {
        *byte = 0x00;
    }
    let source = scratch.write_source("img", "cassee.png", &broken);

    let document = document_with(&stage(ENTRY, true, None, Some("cassee.png")), "");
    let error = prepare(
        &document,
        &[binding("cassee.png", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect_err("refus attendu");

    assert_eq!(causes(&error), vec![MediaCause::Undecodable]);
}

#[test]
fn the_operation_table_is_total_and_never_blames_the_media_for_a_conversion_failure() {
    // La table de classement des issues, éprouvée sur ses huit cases. Elle est
    // pure : la classer ne demande ni outil ni fichier, et c'est ce qui la rend
    // vérifiable.
    let cases = [
        (
            ToolOperation::Validation,
            InvocationOutcome::NotLaunched,
            false,
            MediaCause::ToolUnavailable,
        ),
        (
            ToolOperation::Validation,
            InvocationOutcome::Interrupted,
            true,
            MediaCause::ToolInterrupted,
        ),
        (
            ToolOperation::Validation,
            InvocationOutcome::Failed,
            false,
            MediaCause::Undecodable,
        ),
        (
            ToolOperation::Validation,
            InvocationOutcome::Failed,
            true,
            MediaCause::ValidationFailed,
        ),
        (
            ToolOperation::Conversion,
            InvocationOutcome::NotLaunched,
            false,
            MediaCause::ToolUnavailable,
        ),
        (
            ToolOperation::Conversion,
            InvocationOutcome::Interrupted,
            false,
            MediaCause::ToolInterrupted,
        ),
        (
            ToolOperation::Conversion,
            InvocationOutcome::Failed,
            false,
            MediaCause::ProcessingFailed,
        ),
        (
            ToolOperation::Conversion,
            InvocationOutcome::Failed,
            true,
            MediaCause::ProcessingFailed,
        ),
    ];
    for (operation, outcome, produced, expected) in cases {
        assert_eq!(
            classify(operation, &outcome, produced),
            Some(expected),
            "{operation:?} / {outcome:?} / données={produced}"
        );
    }

    // Un décodage achevé **sans** données n'a rien établi ; avec données, il a
    // réussi. Une conversion qui réussit ne refuse jamais.
    assert_eq!(
        classify(
            ToolOperation::Validation,
            &InvocationOutcome::Succeeded,
            false
        ),
        Some(MediaCause::Undecodable)
    );
    assert_eq!(
        classify(
            ToolOperation::Validation,
            &InvocationOutcome::Succeeded,
            true
        ),
        None
    );
    assert_eq!(
        classify(
            ToolOperation::Conversion,
            &InvocationOutcome::Succeeded,
            false
        ),
        None
    );
    // Le cœur de la règle : une conversion ne peut plus conclure
    // qu'un média est indécodable, quelle que soit son issue.
    for outcome in [
        InvocationOutcome::NotLaunched,
        InvocationOutcome::Interrupted,
        InvocationOutcome::Failed,
        InvocationOutcome::Succeeded,
    ] {
        for produced in [false, true] {
            assert_ne!(
                classify(ToolOperation::Conversion, &outcome, produced),
                Some(MediaCause::Undecodable),
                "une conversion n'accuse jamais le média d'être indécodable"
            );
        }
    }
}

#[test]
fn a_reference_used_as_both_audio_and_image_is_a_disagreement_not_a_guess() {
    let Some(ffmpeg) = ffmpeg_or_skip("kind_disagreement") else {
        return;
    };
    let scratch = Scratch::new("desaccord");
    let source = scratch.write_source("mix", "ambigu.bin", &png_bytes(320, 240, 0));
    let document = document_with(
        &[
            stage(ENTRY, true, Some("ambigu.bin"), None),
            stage(SECOND, false, None, Some("ambigu.bin")),
        ]
        .join(","),
        "",
    );

    let error = prepare(
        &document,
        &[binding("ambigu.bin", &source)],
        &scratch,
        &ffmpeg,
    )
    .expect_err("refus attendu");

    // Choisir laquelle des deux places l'auteur visait serait une décision
    // d'auteur prise à sa place ; le nom d'archive, lui, ne peut pas être
    // simultanément celui d'un son et celui d'une image.
    let AssetPreparationError::MediaOracle(disagreements) = &error else {
        panic!("désaccord de destinations attendu, obtenu {error:?}");
    };
    assert_eq!(disagreements.len(), 2);
    assert!(disagreements
        .iter()
        .any(|entry| entry.kind == Some(MediaKind::Audio)));
    assert!(disagreements
        .iter()
        .any(|entry| entry.kind == Some(MediaKind::Image)));
}

/// Le délai est notre propre mesure, sur les trois plateformes.
///
/// L'outil est ici volontairement **remplacé** : ce test n'éprouve pas un
/// codec — il éprouve que l'invocation rende la main quand le processus ne la
/// rend pas. Un vrai FFmpeg qui boucle ne serait pas une fixture reproductible.
#[cfg(unix)]
#[test]
fn a_tool_that_never_returns_is_interrupted_and_never_blames_the_media() {
    use std::time::Duration;

    use crate::native_pack::assets::advanced::probe::{
        run_tool, InvocationOutcome, StdoutHandling,
    };

    let sleep = std::path::Path::new("/bin/sleep");
    if !sleep.is_file() {
        eprintln!("[préparation] délai d'outil non exécuté : /bin/sleep absent");
        return;
    }

    let started = std::time::Instant::now();
    let run = run_tool(
        sleep,
        &["30".to_string()],
        Duration::from_millis(200),
        StdoutHandling::Discard,
    );

    assert_eq!(run.outcome, InvocationOutcome::Interrupted);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "le délai doit reprendre la main, pas attendre la fin du processus"
    );
    // Et le classement qui en découle n'accuse jamais le média.
    for operation in [ToolOperation::Validation, ToolOperation::Conversion] {
        assert_eq!(
            classify(operation, &run.outcome, run.produced_data()),
            Some(MediaCause::ToolInterrupted)
        );
    }
}
