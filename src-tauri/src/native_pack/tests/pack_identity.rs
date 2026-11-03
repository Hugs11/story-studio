//! L'identité du pack Libre, telle qu'un appareil la lit.
//!
//! STUdio et Lunii.QT dérivent l'identité du pack de l'Écran d'entrée, pas du
//! `uuid` de tête, et la réduisent à ses huit derniers caractères
//! hexadécimaux. Tant que l'Écran d'entrée recevait un UUID aléatoire, deux
//! exports du même projet arrivaient comme deux packs distincts. Ces tests
//! tiennent que l'Écran d'entrée porte l'identité choisie par l'auteur, à
//! l'identique, export après export.

use super::*;
use crate::native_pack::builder::core::release_entry_identity;
use crate::native_pack::observed_gates::{observe_document_gates, GatePolicy, ObservedGate};
use crate::native_pack::writer::libre_pack_identity;

const IDENTITY: &str = "11111111-2222-4333-8444-555566667777";

fn story_project() -> CanonicalProject {
    CanonicalProject {
        name: "Identité".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        options: CanonicalOptions {
            silence_mode: crate::domain::project::SilenceMode::Off,
            harmonize_loudness: true,
            auto_next: false,
            night_mode: false,
            end_message_autoplay: true,
        },
        entries: vec![CanonicalEntry::Story(CanonicalStory {
            name: "Histoire Alpha".to_string(),
            audio: Some("story.mp3".to_string()),
            item_audio: Some("item.mp3".to_string()),
            item_image: Some("item.png".to_string()),
            ..Default::default()
        })],
        shared_entries: Vec::new(),
    }
}

fn story_assets() -> Vec<PreparedAsset> {
    vec![
        prepared_asset("rootAudio", "root.mp3"),
        prepared_asset("rootImage", "cover.png"),
        prepared_asset("root/Histoire Alpha/itemAudio", "item.mp3"),
        prepared_asset("root/Histoire Alpha/itemImage", "item.png"),
        prepared_asset("root/Histoire Alpha/storyAudio", "story.mp3"),
    ]
}

fn story_report(identity: &str) -> NativeAssetPreparationReport {
    let mut report = report_for(story_project(), story_assets(), Vec::new());
    report.pack_uuid = identity.to_string();
    report
}

fn entry_stage(document: &StoryDocument) -> &StageNode {
    let entries = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.is_square_one())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1, "un seul Écran d'entrée");
    assert_eq!(
        document.stage_nodes[0].uuid, entries[0].uuid,
        "l'Écran d'entrée ouvre le tableau"
    );
    entries[0]
}

fn written_story(identity: &str) -> serde_json::Value {
    let document = build_story_document(&story_report(identity)).expect("document construit");
    let raw = serialize_story_with_pack_uuid(&document, identity).expect("story.json écrit");
    serde_json::from_str(&raw).expect("story.json valide")
}

fn written_entry_uuid(story: &serde_json::Value) -> String {
    story["stageNodes"]
        .as_array()
        .expect("stageNodes")
        .iter()
        .find(|stage| stage["squareOne"] == serde_json::json!(true))
        .and_then(|stage| stage["uuid"].as_str())
        .expect("Écran d'entrée écrit")
        .to_string()
}

/// Le défaut reproduit : deux exports du même projet, deux packs distincts.
#[test]
fn two_exports_of_the_same_project_carry_the_identity_on_the_entry_stage() {
    let first = written_story(IDENTITY);
    let second = written_story(IDENTITY);

    for story in [&first, &second] {
        assert_eq!(written_entry_uuid(story), IDENTITY);
        assert_eq!(story["uuid"], serde_json::json!(IDENTITY));
    }
}

/// La graphie de l'auteur n'est pas normalisée : une graphie sans tirets, lue
/// de la même façon par les deux passerelles, est écrite telle quelle.
#[test]
fn a_hyphenless_identity_is_written_as_typed() {
    let hyphenless = "0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D";
    let story = written_story(hyphenless);
    assert_eq!(written_entry_uuid(&story), hyphenless);
    assert_eq!(story["uuid"], serde_json::json!(hyphenless));
}

/// Sans identité (écoute, juge de fidélité), le document se construit encore :
/// aucun pack n'en sort, et l'écriture refuse toujours.
#[test]
fn without_identity_the_document_builds_but_is_never_written() {
    let document = build_story_document(&story_report("")).expect("document d'écoute");
    assert!(classify_stage_id(&entry_stage(&document).uuid).bridge_compatible);
    let error = serialize_story_with_pack_uuid(&document, "").expect_err("identité absente");
    assert!(
        crate::support::user_message::contains_code(&error, "EXPORT_PACK_IDENTITY_REQUIRED"),
        "{error}"
    );
}

/// Seule une graphie que les passerelles lisent de la même façon est livrée.
#[test]
fn only_an_identity_both_bridges_read_alike_is_accepted() {
    for accepted in [IDENTITY, "0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D"] {
        assert_eq!(libre_pack_identity(accepted), Ok(accepted), "{accepted}");
    }
    assert!(crate::support::user_message::contains_code(
        &libre_pack_identity("  ").expect_err("vide"),
        "EXPORT_PACK_IDENTITY_REQUIRED"
    ));
    for refused in [
        "mon pack",
        "{11111111-2222-4333-8444-555566667777}",
        "11111111-2222-4333-8444",
    ] {
        let error = libre_pack_identity(refused).expect_err(refused);
        assert!(error.contains("n'est pas lisible"), "{refused} : {error}");
        assert!(
            error.contains(refused),
            "le message cite la graphie : {error}"
        );
    }
}

/// Un ZIP embarqué dont un Écran porte déjà l'identité reprise : l'Écran
/// d'entrée reste seul à la porter.
#[test]
fn an_embedded_zip_stage_never_shares_the_entry_identity() {
    let mut embedded = story_project();
    embedded.entries = vec![CanonicalEntry::Zip(CanonicalZip {
        name: "Pack repris".to_string(),
        zip_path: Some("repris.zip".to_string()),
        ..Default::default()
    })];
    let imported = StoryDocument {
        title: Presence::Value("Repris".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Value(IDENTITY.to_string()),
        factory_disabled: Presence::Absent,
        action_nodes: vec![ActionNode {
            id: "import-root-action".to_string(),
            name: Presence::Value("Action node".to_string()),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
            options: named_option_targets(vec!["import-content".to_string()]),
            position: no_authored_position(),
        }],
        stage_nodes: vec![
            StageNode {
                uuid: IDENTITY.to_string(),
                name: Presence::Value("Imported cover".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                group_id: Presence::Absent,
                audio: Presence::Null,
                image: Presence::Null,
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
            },
            StageNode {
                uuid: "import-content".to_string(),
                name: Presence::Value("Imported content".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                group_id: Presence::Absent,
                audio: Presence::Null,
                image: Presence::Null,
                control_settings: Presence::Value(simple_story_controls()),
                home_transition: Presence::Null,
                ok_transition: Presence::Null,
                position: no_authored_position(),
            },
        ],
    };
    let report = report_for(
        embedded,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "cover.png"),
        ],
        vec![imported_zip_bundle(
            "root/Pack repris/zip",
            IDENTITY,
            "import-root-action",
            "import-content",
            IDENTITY,
            imported,
        )],
    );

    let document = build_story_document(&report).expect("document avec ZIP repris");
    assert_eq!(entry_stage(&document).uuid, IDENTITY);
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.uuid == IDENTITY)
            .count(),
        1,
        "aucun autre Écran ne porte l'identité : STUdio les fusionnerait"
    );
}

/// La garde de collision elle-même : l'autre Écran est renuméroté de façon
/// déterministe, et les options qui le visaient le suivent.
#[test]
fn a_colliding_stage_is_renumbered_deterministically_with_its_references() {
    let document = build_story_document(&story_report(IDENTITY)).expect("document construit");
    let target = document
        .action_nodes
        .iter()
        .flat_map(|action| action.options.iter().flatten())
        .find(|target| target.as_str() != IDENTITY)
        .expect("une option vise un Écran")
        .clone();

    // Simule un Écran secondaire qui porterait l'identité.
    let mut collided = document.clone();
    for stage in &mut collided.stage_nodes {
        if stage.uuid == target {
            stage.uuid = IDENTITY.to_string();
        }
    }
    for option in collided
        .action_nodes
        .iter_mut()
        .flat_map(|action| action.options.iter_mut().flatten())
    {
        if *option == target {
            *option = IDENTITY.to_string();
        }
    }

    let release = |mut document: StoryDocument| {
        release_entry_identity(
            &mut document.stage_nodes,
            &mut document.action_nodes,
            IDENTITY,
        );
        document
    };
    let first = release(collided.clone());
    let second = release(collided);
    assert_eq!(first, second, "renumérotation déterministe");

    assert_eq!(entry_stage(&first).uuid, IDENTITY);
    let renamed = first
        .stage_nodes
        .iter()
        .filter(|stage| stage.uuid != IDENTITY)
        .find(|stage| {
            !document
                .stage_nodes
                .iter()
                .any(|original| original.uuid == stage.uuid)
        })
        .expect("l'Écran secondaire a reçu un nouvel UUID")
        .uuid
        .clone();
    assert!(classify_stage_id(&renamed).bridge_compatible);
    let options = first
        .action_nodes
        .iter()
        .flat_map(|action| action.options.iter().flatten())
        .collect::<Vec<_>>();
    assert!(options.iter().all(|option| option.as_str() != IDENTITY));
    assert!(options.iter().any(|option| **option == renamed));
    validate_document_for_studio_compat(&first).expect("document cohérent");
}

/// La porte d'identité compare l'Écran d'entrée à l'identité du projet : une
/// identité bien formée mais différente ne passe plus.
#[test]
fn the_identity_gate_refuses_an_entry_stage_that_is_not_the_project_identity() {
    let story = written_story(IDENTITY).to_string();

    let accepted = observe_document_gates(&story, Some(IDENTITY), GatePolicy::ENFORCED);
    let identity = accepted
        .iter()
        .find(|observation| observation.gate == ObservedGate::PackIdentity)
        .expect("porte d'identité");
    assert!(!identity.refuses(), "{identity:?}");

    let other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let refused = observe_document_gates(&story, Some(other), GatePolicy::ENFORCED);
    let identity = refused
        .iter()
        .find(|observation| observation.gate == ObservedGate::PackIdentity)
        .expect("porte d'identité");
    assert!(identity.refuses());
    assert_eq!(identity.reasons[0].code, "PACK_IDENTITY_MISMATCH");
    assert!(identity.reasons[0].message.contains(other));
}

/// La règle unique de la fiche, du geste du graphe et de l'export Libre.
#[test]
fn the_shared_rule_accepts_what_both_bridges_read_alike() {
    for accepted in [IDENTITY, "0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D"] {
        assert_eq!(pack_identity_refusal(accepted), None, "{accepted}");
    }
    assert_eq!(
        pack_identity_refusal("   ").as_deref(),
        Some("L'UUID du pack est vide.")
    );
    for refused in [
        "{11111111-2222-4333-8444-555566667777}",
        "mon pack",
        "11111111-2222-4333-8444",
    ] {
        let refusal = pack_identity_refusal(refused).expect(refused);
        assert!(refusal.contains("n'est pas lisible"), "{refusal}");
    }
}

#[test]
fn modified_official_libre_archive_retains_origin_and_emits_official() {
    use crate::domain::official_provenance::OfficialProvenance;
    use crate::native_pack::output_identity::{decide, ContentIdentity, OutputForm};
    let base = std::env::temp_dir().join(format!("official-libre-{}", uuid::Uuid::new_v4()));
    let mut report = story_report(IDENTITY);
    report.project.name = "Modified official fixture".into();
    report.project.root_image = None;
    std::fs::create_dir_all(&base).unwrap();
    for asset in &mut report.assets {
        let path = base.join(&asset.staged_asset_name);
        std::fs::write(&path, b"synthetic prepared asset").unwrap();
        asset.staged_asset_path = path.to_string_lossy().into_owned();
    }
    let document = build_story_document(&report).unwrap();
    let identity = decide(
        ContentIdentity {
            provenance: OfficialProvenance::Official,
            uuid: IDENTITY,
            origin_uuid: Some(IDENTITY),
        },
        OutputForm::Rewritten,
        &[],
        false,
        None::<&crate::services::catalogue::CatalogueState>,
    )
    .unwrap();
    let written = crate::native_pack::writer::write_native_pack_archive_authorized(
        &report, &document, &base, &identity,
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(written.zip_path).unwrap()).unwrap();
    let story: serde_json::Value =
        serde_json::from_reader(zip.by_name("story.json").unwrap()).unwrap();
    assert_eq!(story["uuid"], IDENTITY);
    assert_eq!(written_entry_uuid(&story), IDENTITY);
    assert_eq!(story["official"], true);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn official_libre_for_project_then_generate_with_identity_preserves_identity() {
    let base = std::env::temp_dir().join(format!("official-libre-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let image = base.join("cover.png");
    write_test_png(&image);
    // A real audible WAV exercises preparation, generation, archive review and publication.
    let audio = base.join("audio.wav");
    let samples: Vec<u8> = (0..44100)
        .flat_map(|i| {
            (((i as f64 * 440.0 * std::f64::consts::TAU / 44100.0).sin() * 8000.0) as i16)
                .to_le_bytes()
        })
        .collect();
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&44100_u32.to_le_bytes());
    wav.extend_from_slice(&88200_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(&samples);
    std::fs::write(&audio, wav).unwrap();
    let project: crate::domain::project::Project = serde_json::from_value(serde_json::json!({
        "name":"Modified official", "projectType":"pack", "packUuid":IDENTITY,
        "officialProvenance":"official", "officialOriginUuid":IDENTITY,
        "rootAudio":audio, "rootImage":image,
        "globalOptions":{"autoNext":false,"nightMode":false,"silenceMode":"off","harmonizeLoudness":false},
        "rootEntries":[{"id":"story","type":"story","name":"Modified story", "audio":audio,
            "officialProvenance":"official", "officialOriginUuid":IDENTITY}]
    })).unwrap();
    let identity = crate::native_pack::output_identity::for_project(&project, None).unwrap();
    let result = crate::native_pack::generate_with_identity(
        &project,
        base.join("out").to_str().unwrap(),
        &|_| {},
        &|| false,
        &identity,
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(result.zip_path).unwrap()).unwrap();
    let story: serde_json::Value =
        serde_json::from_reader(zip.by_name("story.json").unwrap()).unwrap();
    assert_eq!(story["uuid"], IDENTITY);
    assert_eq!(written_entry_uuid(&story), IDENTITY);
    assert_eq!(story["official"], true);
    assert!(result.gate_observations.iter().all(|gate| !gate.refuses()));
    std::fs::remove_dir_all(base).unwrap();
}
