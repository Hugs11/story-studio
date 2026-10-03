//! Agrégation de packs qui portent des groupes enrichis : chaque ZIP inclus
//! garde la cohérence de ses propres groupes, et deux packs distincts qui
//! emploient le même identifiant de groupe ne fusionnent pas en un groupe
//! incohérent (`ENRICHED_GROUP_INCOHERENT`).

use super::*;
use crate::native_pack::authoring::collect_groups;

/// Pack source minimal : couverture, liste, puis un groupe Story connu
/// (un Stage `story` et une Action `story.storyaction` qui le vise).
fn pack_with_story_group(group_id: &str) -> StoryDocument {
    StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec!["import-menu".to_string()]),
                position: no_authored_position(),
            },
            ActionNode {
                id: "import-story-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                action_type: Presence::Value("story.storyaction".to_string()),
                group_id: Presence::Value(group_id.to_string()),
                options: named_option_targets(vec!["import-story".to_string()]),
                position: no_authored_position(),
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Debut".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                group_id: Presence::Absent,
                audio: Presence::Value("import-cover.mp3".to_string()),
                image: Presence::Value("import-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
            },
            StageNode {
                uuid: "import-menu".to_string(),
                name: Presence::Value("Liste".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                group_id: Presence::Absent,
                audio: Presence::Value("import-menu.mp3".to_string()),
                image: Presence::Value("import-menu.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, true, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-story-action", 0)),
                position: no_authored_position(),
            },
            StageNode {
                uuid: "import-story".to_string(),
                name: Presence::Value("Histoire".to_string()),
                stage_type: Presence::Value("story".to_string()),
                square_one: Presence::Value(false),
                group_id: Presence::Value(group_id.to_string()),
                audio: Presence::Value("import-story.mp3".to_string()),
                image: Presence::Null,
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, true, true, true,
                )),
                home_transition: Presence::Value(transition("import-root-action", 0)),
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
            },
        ],
    }
}

fn aggregate(packs: Vec<(&str, StoryDocument)>) -> (NativeAssetPreparationReport, StoryDocument) {
    let mut assets = vec![
        prepared_asset("rootAudio", "cover.mp3"),
        prepared_asset("rootImage", "cover.png"),
    ];
    let mut entries = Vec::new();
    let mut bundles = Vec::new();
    for (name, document) in packs {
        for file in [
            "import-cover.mp3",
            "import-cover.png",
            "import-menu.mp3",
            "import-menu.png",
            "import-story.mp3",
        ] {
            assets.push(prepared_asset(
                &format!("root/{name} / imported {file}"),
                file,
            ));
        }
        entries.push(CanonicalEntry::Zip(CanonicalZip {
            name: name.to_string(),
            zip_path: Some(format!("{name}.zip")),
            ..Default::default()
        }));
        bundles.push(imported_zip_bundle(
            &format!("root/{name}/zip"),
            "import-cover",
            "import-root-action",
            "import-menu",
            "import-cover",
            document,
        ));
    }
    let report = report_for(
        CanonicalProject {
            name: "Agrégat".to_string(),
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
            entries,
            shared_entries: Vec::new(),
        },
        assets,
        bundles,
    );
    let document = build_story_document(&report).expect("agrégat");
    (report, document)
}

/// Chaque groupe du document agrégé : un Stage et une Action, l'Action visant
/// le Stage du même groupe.
fn assert_story_groups_are_coherent(document: &StoryDocument, expected: usize) {
    let groups = collect_groups(document);
    assert_eq!(groups.len(), expected, "groupes : {:?}", groups.keys());
    for (group_id, members) in groups {
        assert_eq!(members.stage_indices.len(), 1, "groupe {group_id}");
        assert_eq!(members.action_indices.len(), 1, "groupe {group_id}");
        let stage = &document.stage_nodes[members.stage_indices[0]];
        let action = &document.action_nodes[members.action_indices[0]];
        assert_eq!(action.options, vec![Some(stage.uuid.clone())]);
    }
}

#[test]
fn two_packs_sharing_a_group_id_keep_two_coherent_groups() {
    let (report, document) = aggregate(vec![
        ("Pack A", pack_with_story_group("g")),
        ("Pack B", pack_with_story_group("g")),
    ]);
    assert_free_document_passes_gates(&report, &document);
    assert_story_groups_are_coherent(&document, 2);
}

#[test]
fn two_packs_with_distinct_group_ids_keep_their_ids() {
    let (report, document) = aggregate(vec![
        ("Pack A", pack_with_story_group("g1")),
        ("Pack B", pack_with_story_group("g2")),
    ]);
    assert_free_document_passes_gates(&report, &document);
    assert_story_groups_are_coherent(&document, 2);
    let ids: Vec<String> = collect_groups(&document).into_keys().collect();
    assert_eq!(ids, vec!["g1".to_string(), "g2".to_string()]);
}

#[test]
fn a_single_pack_keeps_its_group_id() {
    let (report, document) = aggregate(vec![("Pack A", pack_with_story_group("g"))]);
    assert_free_document_passes_gates(&report, &document);
    assert_story_groups_are_coherent(&document, 1);
    assert!(collect_groups(&document).contains_key("g"));
}
