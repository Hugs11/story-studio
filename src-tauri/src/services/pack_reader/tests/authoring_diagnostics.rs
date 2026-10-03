use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use serde_json::{json, Number, Value};

use crate::native_pack::authoring::{
    apply_editor_position_to_authoring, assess_authoring_export_guards, diagnose_enriched_metadata,
    flatten_known_group, set_authored_position, set_opaque_export_disposition,
    set_position_export_disposition, with_action_option_target, AuthoringDiagnosticLevel,
};
use crate::native_pack::{
    decode_story_document, validate_graph_document_integrity, DecodedStoryDocument, EditorPosition,
    OpaqueExportDisposition, Position, PositionExportDisposition, Presence, ValueOrigin,
};

fn base_document() -> Value {
    json!({
        "format": "v1",
        "version": 1,
        "stageNodes": [
            {
                "uuid": "entry",
                "squareOne": true,
                "controlSettings": complete_controls(),
                "okTransition": {"actionNode": "main", "optionIndex": 0},
                "homeTransition": null
            },
            {
                "uuid": "target",
                "squareOne": false,
                "controlSettings": {"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false},
                "okTransition": null,
                "homeTransition": null
            }
        ],
        "actionNodes": [
            {"id": "main", "options": ["target"]}
        ]
    })
}

fn complete_controls() -> Value {
    json!({"wheel": false, "ok": true, "home": false, "pause": false, "autoplay": false})
}

fn decode(value: &Value) -> DecodedStoryDocument {
    decode_story_document(&value.to_string()).expect("document de test décodable")
}

fn has_diagnostic(
    payload: &DecodedStoryDocument,
    code: &str,
    level: AuthoringDiagnosticLevel,
) -> bool {
    diagnose_enriched_metadata(payload)
        .iter()
        .any(|diagnostic| diagnostic.code == code && diagnostic.level == level)
}

fn number(value: f64) -> Number {
    Number::from_f64(value).expect("nombre JSON fini")
}

fn position(x: f64, y: f64) -> Position {
    Position {
        x: number(x),
        y: number(y),
    }
}

#[test]
fn an_unknown_type_is_preserved_warned_and_never_remapped() {
    let mut raw = base_document();
    raw["stageNodes"][0]["type"] = json!("vendor.unmapped-stage");
    let payload = decode(&raw);

    assert_eq!(
        payload.document.stage_nodes[0].stage_type.as_deref(),
        Some("vendor.unmapped-stage")
    );
    assert!(has_diagnostic(
        &payload,
        "ENRICHED_TYPE_UNKNOWN",
        AuthoringDiagnosticLevel::Warning
    ));
    let emitted = serde_json::to_value(&payload.document).expect("document sérialisable");
    assert_eq!(emitted["stageNodes"][0]["type"], "vendor.unmapped-stage");
}

#[test]
fn editing_an_internal_known_group_edge_keeps_markers_and_requires_action() {
    let mut raw = base_document();
    raw["stageNodes"][0]["type"] = json!("story");
    raw["stageNodes"][0]["groupId"] = json!("story-group");
    raw["actionNodes"][0]["type"] = json!("story.storyaction");
    raw["actionNodes"][0]["groupId"] = json!("story-group");
    raw["actionNodes"][0]["options"] = json!(["entry"]);
    let payload = decode(&raw);
    assert!(!has_diagnostic(
        &payload,
        "ENRICHED_GROUP_INCOHERENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));

    let coherent_edit =
        with_action_option_target(&payload.document, "main", 0, Some("entry".to_string()))
            .expect("édition qui conserve la forme");
    let mut coherent_payload = payload.clone();
    coherent_payload.document = coherent_edit;
    assert_eq!(
        coherent_payload.document.stage_nodes[0].group_id.as_deref(),
        Some("story-group")
    );
    assert!(!has_diagnostic(
        &coherent_payload,
        "ENRICHED_GROUP_INCOHERENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));

    let edited =
        with_action_option_target(&payload.document, "main", 0, Some("target".to_string()))
            .expect("édition pure");
    let mut edited_payload = payload.clone();
    edited_payload.document = edited;

    assert_eq!(
        edited_payload.document.stage_nodes[0].group_id.as_deref(),
        Some("story-group")
    );
    assert_eq!(
        edited_payload.document.action_nodes[0]
            .action_type
            .as_deref(),
        Some("story.storyaction")
    );
    assert!(validate_graph_document_integrity(&edited_payload.document).is_ok());
    assert!(has_diagnostic(
        &edited_payload,
        "ENRICHED_GROUP_INCOHERENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
}

#[test]
fn menu_group_accepts_any_in_bounds_initial_fixed_selection() {
    let mut raw = json!({
        "format":"v1","version":1,
        "stageNodes":[
            {"uuid":"cover","type":"cover","squareOne":true,
             "controlSettings":complete_controls(),
             "okTransition":{"actionNode":"question-action","optionIndex":0},"homeTransition":null},
            {"uuid":"question","type":"menu.questionstage","groupId":"menu-group","squareOne":false,
             "controlSettings":complete_controls(),
             "okTransition":{"actionNode":"options-action","optionIndex":1},"homeTransition":null},
            {"uuid":"option-a","type":"menu.optionstage","groupId":"menu-group","squareOne":false,
             "controlSettings":complete_controls(),"okTransition":null,"homeTransition":null},
            {"uuid":"option-b","type":"menu.optionstage","groupId":"menu-group","squareOne":false,
             "controlSettings":complete_controls(),"okTransition":null,"homeTransition":null}
        ],
        "actionNodes":[
            {"id":"question-action","type":"menu.questionaction","groupId":"menu-group","options":["question"]},
            {"id":"options-action","type":"menu.optionsaction","groupId":"menu-group","options":["option-a","option-b"]}
        ]
    });
    let payload = decode(&raw);
    assert!(!has_diagnostic(
        &payload,
        "ENRICHED_GROUP_INCOHERENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
    raw["stageNodes"].as_array_mut().unwrap().swap(2, 3);
    let reordered = decode(&raw);
    assert!(!has_diagnostic(
        &reordered,
        "ENRICHED_GROUP_INCOHERENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
    assert_eq!(
        reordered.document.action_nodes[1].options,
        payload.document.action_nodes[1].options
    );
    for options in [
        json!(["option-a"]),
        json!(["option-a", "option-a"]),
        json!(["option-a", "option-b", "option-b"]),
    ] {
        raw["actionNodes"][1]["options"] = options;
        assert!(has_diagnostic(
            &decode(&raw),
            "ENRICHED_GROUP_INCOHERENT",
            AuthoringDiagnosticLevel::ActionRequired
        ));
    }
}

#[test]
fn explicit_flatten_changes_only_known_markers_and_keeps_runtime_graph_and_gvi() {
    let mut raw = base_document();
    raw["stageNodes"][0]["type"] = json!("story");
    raw["stageNodes"][0]["groupId"] = json!("story-group");
    raw["actionNodes"][0]["type"] = json!("story.storyaction");
    raw["actionNodes"][0]["groupId"] = json!("story-group");
    raw["actionNodes"][0]["options"] = json!(["entry"]);
    let payload = decode(&raw);
    let before_diagnostic = payload.document.clone();
    let _ = diagnose_enriched_metadata(&payload);
    assert_eq!(payload.document, before_diagnostic);
    let flattened = flatten_known_group(&payload.document, "story-group")
        .expect("flatten explicit d'un groupe connu");

    assert_eq!(
        validate_graph_document_integrity(&payload.document),
        validate_graph_document_integrity(&flattened)
    );
    assert_eq!(
        payload.document.stage_nodes.len(),
        flattened.stage_nodes.len()
    );
    assert_eq!(
        payload.document.action_nodes.len(),
        flattened.action_nodes.len()
    );
    for (before, after) in payload
        .document
        .stage_nodes
        .iter()
        .zip(&flattened.stage_nodes)
    {
        assert_eq!(before.uuid, after.uuid);
        assert_eq!(before.name, after.name);
        assert_eq!(before.square_one, after.square_one);
        assert_eq!(before.audio, after.audio);
        assert_eq!(before.image, after.image);
        assert_eq!(before.control_settings, after.control_settings);
        assert_eq!(before.ok_transition, after.ok_transition);
        assert_eq!(before.home_transition, after.home_transition);
        assert_eq!(before.position, after.position);
    }
    for (before, after) in payload
        .document
        .action_nodes
        .iter()
        .zip(&flattened.action_nodes)
    {
        assert_eq!(before.id, after.id);
        assert_eq!(before.name, after.name);
        assert_eq!(before.options, after.options);
        assert_eq!(before.position, after.position);
    }
    assert_eq!(flattened.stage_nodes[0].group_id, Presence::Absent);
    assert_eq!(
        flattened.stage_nodes[0].stage_type.as_deref(),
        Some("stage")
    );
    assert_eq!(flattened.action_nodes[0].group_id, Presence::Absent);
    assert_eq!(flattened.action_nodes[0].action_type, Presence::Absent);
}

#[test]
fn an_unknown_group_shape_cannot_claim_a_semantic_flatten() {
    let mut raw = base_document();
    raw["stageNodes"][0]["type"] = json!("vendor.group-stage");
    raw["stageNodes"][0]["groupId"] = json!("vendor-group");
    let payload = decode(&raw);

    assert!(has_diagnostic(
        &payload,
        "ENRICHED_GROUP_UNKNOWN",
        AuthoringDiagnosticLevel::Warning
    ));
    assert!(flatten_known_group(&payload.document, "vendor-group").is_err());
}

#[test]
fn orphan_action_with_a_valid_option_is_action_required_but_gvi_valid() {
    let mut raw = base_document();
    raw["actionNodes"]
        .as_array_mut()
        .expect("actions")
        .push(json!({"id":"orphan","options":["target"]}));
    let payload = decode(&raw);

    assert!(validate_graph_document_integrity(&payload.document).is_ok());
    assert!(has_diagnostic(
        &payload,
        "ORPHAN_ACTION_AUTHORED_CONTENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
    assert!(assess_authoring_export_guards(&payload).blocked);
}

#[test]
fn orphan_empty_action_with_authored_name_is_action_required() {
    let mut raw = base_document();
    raw["actionNodes"]
        .as_array_mut()
        .expect("actions")
        .push(json!({"id":"orphan","name":"Information","options":[]}));
    let payload = decode(&raw);

    assert!(validate_graph_document_integrity(&payload.document).is_ok());
    assert!(has_diagnostic(
        &payload,
        "ORPHAN_ACTION_AUTHORED_CONTENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
}

#[test]
fn strictly_empty_orphan_action_is_information_only() {
    let mut raw = base_document();
    raw["actionNodes"]
        .as_array_mut()
        .expect("actions")
        .push(json!({"id":"orphan","options":[]}));
    let payload = decode(&raw);

    assert!(validate_graph_document_integrity(&payload.document).is_ok());
    assert!(has_diagnostic(
        &payload,
        "ORPHAN_ACTION_EMPTY_SCAFFOLD",
        AuthoringDiagnosticLevel::Info
    ));
    assert!(!assess_authoring_export_guards(&payload).blocked);
}

#[test]
fn redundant_identifier_alias_does_not_turn_an_empty_orphan_into_authored_content() {
    let mut raw = base_document();
    raw["actionNodes"]
        .as_array_mut()
        .expect("actions")
        .push(json!({"id":"orphan","uuid":"orphan","options":[]}));
    let payload = decode(&raw);

    assert!(has_diagnostic(
        &payload,
        "ORPHAN_ACTION_EMPTY_SCAFFOLD",
        AuthoringDiagnosticLevel::Info
    ));
    assert!(!has_diagnostic(
        &payload,
        "ORPHAN_ACTION_AUTHORED_CONTENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
}

#[test]
fn random_selection_towards_an_empty_action_stays_a_gvi_error() {
    let mut raw = base_document();
    raw["stageNodes"][0]["okTransition"] = json!({"actionNode":"empty-random","optionIndex":-1});
    raw["actionNodes"] = json!([{"id":"empty-random","options":[]}]);
    let payload = decode(&raw);
    let errors = validate_graph_document_integrity(&payload.document)
        .expect_err("Random sans candidat doit rester invalide");

    assert!(errors
        .iter()
        .any(|error| error.code.as_str() == "OPTION_SELECTION_INVALID"));
    assert!(!has_diagnostic(
        &payload,
        "ORPHAN_ACTION_AUTHORED_CONTENT",
        AuthoringDiagnosticLevel::ActionRequired
    ));
}

#[test]
fn source_fractional_position_keeps_its_f64_value_through_an_authoring_cycle() {
    let mut raw = base_document();
    raw["stageNodes"][0]["position"] = json!({"x":12.5,"y":-990.4606467901111});
    let payload = decode(&raw);
    let before = payload.document.stage_nodes[0]
        .position
        .value()
        .expect("position source");
    let saved = serde_json::to_value(&payload).expect("payload sérialisable");
    let reopened: DecodedStoryDocument = serde_json::from_value(saved).expect("payload réouvrable");
    let after = reopened.document.stage_nodes[0]
        .position
        .value()
        .expect("position réouverte");

    assert_eq!(
        before.x.as_f64().unwrap().to_bits(),
        after.x.as_f64().unwrap().to_bits()
    );
    assert_eq!(
        before.y.as_f64().unwrap().to_bits(),
        after.y.as_f64().unwrap().to_bits()
    );
    assert!(!reopened
        .context
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "POSITION_FRACTIONAL"));
}

#[test]
fn manual_move_becomes_authored_without_creating_a_position_diagnostic() {
    let mut raw = base_document();
    raw["stageNodes"][0]["position"] = json!({"x":40_000,"y":0});
    let mut payload = decode(&raw);
    let path = "/stageNodes/@uuid=entry#0/position";
    set_position_export_disposition(
        &mut payload,
        path,
        PositionExportDisposition::PreserveRawAcceptDantsuLoss,
    )
    .expect("choix autorisé pour la source");
    assert!(!assess_authoring_export_guards(&payload).blocked);

    set_authored_position(&mut payload, path, position(40_001.0, 0.0)).expect("déplacement manuel");
    assert!(!assess_authoring_export_guards(&payload).blocked);
    assert!(!assess_authoring_export_guards(&payload)
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.starts_with("POSITION_")));
}

#[test]
fn auto_layout_stays_editor_state_until_explicitly_applied() {
    let mut payload = decode(&base_document());
    let path = "/stageNodes/@uuid=entry#0/position";
    payload.context.editor_positions.push(EditorPosition {
        path: path.to_string(),
        origin: ValueOrigin::ProjectionDerived,
        position: position(321.5, 654.25),
    });

    assert!(payload.document.stage_nodes[0].position.is_absent());
    let before = serde_json::to_value(&payload.document).expect("document sérialisable");
    assert!(before["stageNodes"][0].get("position").is_none());

    apply_editor_position_to_authoring(&mut payload, path).expect("application explicite");
    assert!(payload.document.stage_nodes[0].position.is_value());
    assert!(payload.context.editor_positions.is_empty());
    assert!(payload
        .context
        .value_provenance
        .iter()
        .any(|entry| { entry.path == path && entry.origin == ValueOrigin::Authored }));
}

#[test]
fn studio_created_out_of_range_position_does_not_create_a_diagnostic() {
    let mut payload = decode(&base_document());
    let path = "/stageNodes/@uuid=entry#0/position";
    set_authored_position(&mut payload, path, position(40_000.0, 0.0)).expect("position authored");
    assert!(!assess_authoring_export_guards(&payload).blocked);
    assert!(!assess_authoring_export_guards(&payload)
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.starts_with("POSITION_")));
    assert!(set_position_export_disposition(
        &mut payload,
        path,
        PositionExportDisposition::PreserveRawAcceptDantsuLoss
    )
    .is_err());
    set_position_export_disposition(
        &mut payload,
        path,
        PositionExportDisposition::ScaleToShortRange,
    )
    .expect("mise à l'échelle explicite autorisée");
    assert!(!assess_authoring_export_guards(&payload).blocked);
}

#[test]
fn inherited_out_of_range_position_stays_silent_and_preserves_all_three_choices() {
    let mut raw = base_document();
    raw["stageNodes"][0]["position"] = json!({"x":40_000,"y":-40_000});
    let mut payload = decode(&raw);
    let path = "/stageNodes/@uuid=entry#0/position";
    let assessment = assess_authoring_export_guards(&payload);
    assert!(!assessment.blocked);
    assert!(!assessment
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.starts_with("POSITION_")));

    set_position_export_disposition(
        &mut payload,
        path,
        PositionExportDisposition::PreserveRawAcceptDantsuLoss,
    )
    .expect("préservation brute explicite");
    let assessment = assess_authoring_export_guards(&payload);
    assert!(!assessment.blocked);
    assert!(!assessment
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.starts_with("POSITION_")));
}

#[test]
fn opaque_extensions_at_four_scopes_survive_and_require_current_dispositions() {
    let raw = json!({
        "format":"v1","version":1,"storyStudioMetadata":{"owner":"third-party"},
        "stageNodes":[{
            "uuid":"entry","squareOne":true,"duration":1234,
            "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false,
                "vendorNested":{"fraction":-990.4606467901111}},
            "okTransition":{"actionNode":"main","optionIndex":0,"vendorTransition":{"nested":[0.1]}},
            "homeTransition":null
        },{
            "uuid":"suite","squareOne":false,
            "controlSettings":{"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false},
            "okTransition":null,"homeTransition":null
        }],
        "actionNodes":[{"id":"main","options":["suite"]}]
    });
    let mut payload = decode(&raw);
    let keys = [
        "storyStudioMetadata",
        "duration",
        "vendorTransition",
        "vendorNested",
    ];
    for key in keys {
        assert!(payload
            .context
            .opaque_members
            .iter()
            .any(|member| member.key == key));
    }
    assert_eq!(
        assess_authoring_export_guards(&payload)
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "OPAQUE_EXTENSION_DISPOSITION_REQUIRED")
            .count(),
        4
    );

    let identities = payload
        .context
        .opaque_members
        .iter()
        .filter(|member| keys.contains(&member.key.as_str()))
        .map(|member| {
            (
                member.path.clone(),
                member.key.clone(),
                member.source_occurrence,
            )
        })
        .collect::<Vec<_>>();
    for (path, key, occurrence) in identities {
        set_opaque_export_disposition(
            &mut payload,
            &path,
            &key,
            occurrence,
            OpaqueExportDisposition::PreserveUntested,
        )
        .expect("disposition opaque");
    }
    assert!(!assess_authoring_export_guards(&payload).blocked);

    let saved = serde_json::to_value(&payload).expect("payload sérialisable");
    let mut reopened: DecodedStoryDocument =
        serde_json::from_value(saved).expect("payload réouvrable");
    assert_eq!(reopened.context, payload.context);
    let standard = serde_json::to_value(&reopened.document).expect("document sérialisable");
    assert!(standard.get("storyStudioMetadata").is_none());
    assert!(standard["stageNodes"][0].get("duration").is_none());
    assert!(standard["stageNodes"][0]["okTransition"]
        .get("vendorTransition")
        .is_none());

    reopened
        .context
        .opaque_members
        .iter_mut()
        .find(|member| member.key == "duration")
        .expect("duration")
        .value = json!(2000);
    assert!(has_diagnostic(
        &reopened,
        "OPAQUE_EXTENSION_DISPOSITION_STALE",
        AuthoringDiagnosticLevel::ActionRequired
    ));
}

#[test]
fn incomplete_controls_become_a_blocking_authoring_decision_without_inference() {
    let mut raw = base_document();
    raw["stageNodes"][0]["controlSettings"]
        .as_object_mut()
        .expect("contrôles")
        .remove("autoplay");
    let payload = decode(&raw);

    assert!(payload.document.stage_nodes[0]
        .control_settings
        .value()
        .is_some_and(|controls| controls.autoplay.is_absent()));
    assert!(has_diagnostic(
        &payload,
        "CONTROL_SETTINGS_INCOMPLETE",
        AuthoringDiagnosticLevel::ActionRequired
    ));
    assert!(assess_authoring_export_guards(&payload).blocked);
}

/// Oracle local : les deux fichiers appartiennent au corpus privé ignoré par
/// Git. Le test ordinaire reste autonome ; cette campagne est déclenchée avec
/// `STORY_STUDIO_B2_CORPUS_DIR` sur une machine qui possède ces fichiers.
#[test]
#[ignore = "requires STORY_STUDIO_B2_CORPUS_DIR with the private corpus"]
fn a051_and_a135_keep_all_enriched_fields_through_an_authoring_cycle() {
    let corpus = PathBuf::from(
        std::env::var("STORY_STUDIO_B2_CORPUS_DIR").expect("STORY_STUDIO_B2_CORPUS_DIR requis"),
    );
    for (filename, expected_stage_groups, expected_action_groups) in
        [("216.json", 178, 126), ("368.json", 33, 2)]
    {
        let raw = std::fs::read_to_string(corpus.join(filename)).expect("preuve locale lisible");
        let decoded = decode_story_document(&raw).expect("document réel décodable");
        let saved = serde_json::to_value(&decoded).expect("payload auteur sérialisable");
        let reopened: DecodedStoryDocument =
            serde_json::from_value(saved).expect("payload auteur réouvrable");

        assert_eq!(decoded.document, reopened.document, "{filename}");
        assert_eq!(decoded.context, reopened.context, "{filename}");
        assert_eq!(
            reopened
                .document
                .stage_nodes
                .iter()
                .filter(|stage| stage.group_id.is_value())
                .count(),
            expected_stage_groups,
            "{filename}"
        );
        assert_eq!(
            reopened
                .document
                .action_nodes
                .iter()
                .filter(|action| action.group_id.is_value())
                .count(),
            expected_action_groups,
            "{filename}"
        );
        let diagnostics = diagnose_enriched_metadata(&reopened);
        assert!(
            diagnostics.iter().all(|diagnostic| {
                !matches!(
                    diagnostic.code.as_str(),
                    "ENRICHED_GROUP_INCOHERENT"
                        | "ENRICHED_GROUP_UNKNOWN"
                        | "ENRICHED_TYPE_UNKNOWN"
                )
            }),
            "{filename}: {diagnostics:#?}"
        );
    }
}

/// Mesure locale de non-régression : aucun document privé n'est versionné,
/// mais toutes les formes présentes peuvent être passées au nouveau garde.
#[test]
#[ignore = "requires STORY_STUDIO_B2_CORPUS_DIR with the private corpus"]
fn authoring_diagnostics_cover_the_private_studio_corpus_without_unknown_group_forms() {
    let corpus = PathBuf::from(
        std::env::var("STORY_STUDIO_B2_CORPUS_DIR").expect("STORY_STUDIO_B2_CORPUS_DIR requis"),
    );
    let library_index = corpus
        .parent()
        .expect("dossier de la bibliothèque")
        .join("bibliotheque-index.jsonl");
    let studio_files = std::fs::read_to_string(library_index)
        .expect("index de bibliothèque lisible")
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry["sourceFormat"] == "studioPack")
        .filter_map(|entry| {
            PathBuf::from(entry["storyJsonPath"].as_str()?)
                .file_name()
                .map(|name| name.to_owned())
        })
        .collect::<HashSet<_>>();
    let mut files = std::fs::read_dir(corpus)
        .expect("corpus lisible")
        .map(|entry| entry.expect("entrée lisible").path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|filename| studio_files.contains(filename))
        })
        .collect::<Vec<_>>();
    files.sort();

    let mut counts = BTreeMap::<String, usize>::new();
    for path in &files {
        let raw = std::fs::read_to_string(path).expect("story.json lisible");
        let payload = decode_story_document(&raw).unwrap_or_else(|error| {
            panic!("{} : {error}", path.display());
        });
        for diagnostic in diagnose_enriched_metadata(&payload) {
            *counts.entry(diagnostic.code).or_default() += 1;
        }
    }

    assert_eq!(files.len(), 193);
    assert_eq!(counts.get("ENRICHED_GROUP_INCOHERENT"), None);
    assert_eq!(counts.get("ENRICHED_GROUP_UNKNOWN"), None);
    assert_eq!(counts.get("ENRICHED_TYPE_UNKNOWN"), None);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "documents": files.len(),
            "diagnosticsByCode": counts,
        }))
        .expect("résultat sérialisable")
    );
}

#[test]
fn diagnostic_levels_follow_the_d1_wire_contract() {
    for (level, spelling) in [
        (AuthoringDiagnosticLevel::ActionRequired, "ACTION_REQUIRED"),
        (AuthoringDiagnosticLevel::Warning, "WARNING"),
        (AuthoringDiagnosticLevel::Info, "INFO"),
    ] {
        assert_eq!(serde_json::to_value(level).unwrap(), json!(spelling));
        assert_eq!(
            serde_json::from_value::<AuthoringDiagnosticLevel>(json!(spelling)).unwrap(),
            level
        );
    }
}
