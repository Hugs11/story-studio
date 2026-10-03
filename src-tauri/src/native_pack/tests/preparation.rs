use super::super::authoring::{set_opaque_export_disposition, set_position_export_disposition};
use super::super::preparation::*;
use super::*;

const PACK_ID: &str = "11111111-2222-4333-8444-555566667777";
const ENTRY_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CANONICAL_ID: &str = "123e4567-e89b-12d3-a456-426614174000";
const SIMPLE_ID: &str = "123E4567E89B12D3A456426614174001";

fn controls() -> serde_json::Value {
    serde_json::json!({
        "wheel": false,
        "ok": false,
        "home": true,
        "pause": false,
        "autoplay": false
    })
}

fn stage(id: &str, square_one: Option<bool>) -> serde_json::Value {
    let mut stage = serde_json::json!({
        "uuid": id,
        "audio": null,
        "image": null,
        "controlSettings": controls(),
        "okTransition": null,
        "homeTransition": null
    });
    if let Some(square_one) = square_one {
        stage["squareOne"] = serde_json::Value::Bool(square_one);
    }
    stage
}

/// L'entrée n'est jamais un choix, et son Accueil est désactivé : ce sont les
/// règles de navigation de STUdio (`port_rules`), bloquantes à la préparation.
fn document(stages: Vec<serde_json::Value>, options: Vec<&str>) -> serde_json::Value {
    let mut stages = stages;
    let entry = stages
        .iter_mut()
        .find(|stage| stage["squareOne"] == serde_json::Value::Bool(true))
        .expect("entry");
    assert!(
        !options.contains(&entry["uuid"].as_str().expect("uuid d'entrée")),
        "l'Écran d'entrée ne peut pas être un choix de menu"
    );
    entry["controlSettings"]["home"] = serde_json::Value::Bool(false);
    entry["controlSettings"]["ok"] = serde_json::Value::Bool(true);
    entry["okTransition"] = serde_json::json!({"actionNode": "menu", "optionIndex": 0});
    serde_json::json!({
        "format": "v1",
        "version": 1,
        "stageNodes": stages,
        "actionNodes": [{
            "id": "menu",
            "options": options
        }]
    })
}

fn decode(value: serde_json::Value) -> DecodedStoryDocument {
    decode_story_document(&value.to_string()).expect("payload décodable")
}

#[test]
fn prep_003_005_and_009_build_an_injective_stable_table_on_a_copy() {
    let source = document(
        vec![
            stage(SIMPLE_ID, None),
            stage("stage-textuel", Some(false)),
            stage(ENTRY_ID, Some(true)),
            stage(CANONICAL_ID, None),
            stage("{123e4567-e89b-12d3-a456-426614174002}", None),
        ],
        vec![SIMPLE_ID, "stage-textuel", CANONICAL_ID],
    );
    let mut payload = decode(source);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    payload.context.pack_identity.short_identity = Some("66667777".to_string());
    let author_before = payload.clone();

    let first = prepare_graph_document_for_export(&payload).expect("préparation");
    let second = prepare_graph_document_for_export(&payload).expect("préparation stable");

    assert_eq!(payload.document, author_before.document, "auteur immuable");
    assert_eq!(
        payload.context, author_before.context,
        "contexte en lecture seule"
    );
    assert_eq!(first, second, "même auteur, même préparation");
    assert_eq!(first.document.stage_nodes[0].uuid, PACK_ID);
    assert!(first.document.stage_nodes[0].is_square_one());
    assert_eq!(first.stage_id_map[SIMPLE_ID], SIMPLE_ID, "simple bit-à-bit");
    assert_eq!(
        first.stage_id_map[CANONICAL_ID], CANONICAL_ID,
        "canonique bit-à-bit"
    );
    for author_id in [
        ENTRY_ID,
        "stage-textuel",
        "{123e4567-e89b-12d3-a456-426614174002}",
    ] {
        assert!(classify_stage_id(&first.stage_id_map[author_id]).bridge_compatible);
        assert_ne!(first.stage_id_map[author_id], author_id);
    }
    let ids = first
        .document
        .stage_nodes
        .iter()
        .map(|stage| stage.uuid.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        ids.len(),
        first.document.stage_nodes.len(),
        "table injective"
    );
    assert_eq!(
        first
            .document
            .stage_nodes
            .iter()
            .skip(1)
            .map(|stage| stage.uuid.as_str())
            .collect::<Vec<_>>(),
        vec![
            SIMPLE_ID,
            first.stage_id_map["stage-textuel"].as_str(),
            CANONICAL_ID,
            first.stage_id_map["{123e4567-e89b-12d3-a456-426614174002}"].as_str(),
        ],
        "ordre relatif des autres Stages"
    );
    assert_eq!(
        first.document.action_nodes[0].id, "menu",
        "ActionNodes non réordonnés"
    );
    assert_eq!(
        first.document.action_nodes[0].options,
        vec![
            Some(SIMPLE_ID.to_string()),
            Some(first.stage_id_map["stage-textuel"].clone()),
            Some(CANONICAL_ID.to_string())
        ]
    );
}

#[test]
fn remapping_reserves_compatible_ids_even_when_their_stages_come_later() {
    let mut source = document(
        vec![stage(ENTRY_ID, Some(true)), stage("text-stage", None)],
        vec!["text-stage"],
    );
    let mut payload = decode(source.clone());
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    let first = prepare_graph_document_for_export(&payload).unwrap();
    let collision = first.stage_id_map["text-stage"].clone();
    source["stageNodes"]
        .as_array_mut()
        .unwrap()
        .push(stage(&collision, None));
    source["actionNodes"][0]["options"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!(collision));
    let mut payload = decode(source);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    let author = payload.clone();
    let prepared = prepare_graph_document_for_export(&payload).unwrap();
    assert_eq!(prepared.stage_id_map[&collision], collision);
    assert_ne!(prepared.stage_id_map["text-stage"], collision);
    assert_eq!(
        prepared.document.action_nodes[0].options[1].as_deref(),
        Some(collision.as_str())
    );
    assert_eq!(payload.document, author.document);
    assert_eq!(payload.context, author.context);
}

#[test]
fn prep_006_fixed_omissions_cannot_be_overridden_by_an_extension_disposition() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["image"] = serde_json::json!("cover.png");
    value["official"] = serde_json::json!(true);
    value["stageNodes"][0]["id"] = serde_json::json!(ENTRY_ID);
    value["actionNodes"][0]["uuid"] = serde_json::json!("menu");
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    for member in payload.context.opaque_members.clone() {
        for disposition in [
            OpaqueExportDisposition::PreserveUntested,
            OpaqueExportDisposition::PromoteAfterProof,
        ] {
            assert!(set_opaque_export_disposition(
                &mut payload,
                &member.path,
                &member.key,
                member.source_occurrence,
                disposition
            )
            .is_err());
        }
    }
    // Un contexte désérialisé ou forgé ne doit pas contourner le serializer.
    for member in &mut payload.context.opaque_members {
        member.export_disposition = Some(OpaqueExportDisposition::PreserveUntested);
        member.export_disposition_value = Presence::from_json(member.value.clone());
        member.export_disposition_origin = Some(member.origin);
    }
    let author = payload.clone();
    let prepared = prepare_graph_document_for_export(&payload).unwrap();
    let output = prepared.standard_value();
    assert!(output.get("image").is_none());
    assert!(output.get("official").is_none());
    assert!(output["stageNodes"][0].get("id").is_none());
    assert!(output["actionNodes"][0].get("uuid").is_none());
    assert_eq!(payload.document, author.document);
    assert_eq!(payload.context, author.context);
}

#[test]
fn prep_006_omits_fs_projected_labels_until_they_are_authored() {
    let mut source = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    source["title"] = serde_json::json!("FS projection");
    source["description"] = serde_json::json!("Generated description");
    source["stageNodes"][0]["name"] = serde_json::json!("Stage 1");
    source["stageNodes"][0]["type"] = serde_json::json!("stage");
    source["actionNodes"][0]["name"] = serde_json::json!("Action 1");
    let mut payload = decode(source);
    payload.context = StoryDocumentContext::imported_fs(&payload.document, ENTRY_ID);
    let author = payload.clone();
    let prepared = prepare_graph_document_for_export(&payload).unwrap();
    let output = prepared.standard_value();
    assert!(output.get("title").is_none());
    assert!(output.get("description").is_none());
    assert!(output["stageNodes"][0].get("name").is_none());
    assert!(output["stageNodes"][0].get("type").is_none());
    assert!(output["actionNodes"][0].get("name").is_none());
    assert_eq!(output["actionNodes"][0]["options"][0], CANONICAL_ID);
    assert_eq!(payload.document, author.document);
    assert_eq!(payload.context, author.context);
    // La même valeur devient exportable après un acte auteur explicite.
    for entry in &mut payload.context.value_provenance {
        if entry.path == "/title" || entry.path.ends_with("/name") {
            entry.origin = ValueOrigin::Authored;
        }
    }
    let authored = prepare_graph_document_for_export(&payload).unwrap();
    assert_eq!(authored.standard_value()["title"], "FS projection");
    assert_eq!(
        authored.standard_value()["stageNodes"][0]["name"],
        "Stage 1"
    );
    assert_eq!(
        authored.standard_value()["actionNodes"][0]["name"],
        "Action 1"
    );
}

#[test]
fn b41_collision_remaps_the_old_identity_without_changing_pack_identity() {
    let source = document(
        vec![
            stage(PACK_ID, Some(false)),
            stage(ENTRY_ID, Some(true)),
            stage(CANONICAL_ID, None),
        ],
        vec![PACK_ID, CANONICAL_ID],
    );
    let mut payload = decode(source);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());

    let prepared = prepare_graph_document_for_export(&payload).expect("préparation");
    assert_eq!(prepared.document.stage_nodes[0].uuid, PACK_ID);
    assert_ne!(prepared.stage_id_map[PACK_ID], PACK_ID);
    assert_eq!(
        prepared.document.action_nodes[0].options[0].as_deref(),
        Some(prepared.stage_id_map[PACK_ID].as_str())
    );
}

#[test]
fn prep_002_refuses_gvi_and_every_unresolved_action_required_family() {
    let mut invalid = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec!["missing-stage"],
    );
    invalid["stageNodes"][0]["okTransition"] =
        serde_json::json!({"actionNode": "menu", "optionIndex": 0});
    assert!(matches!(
        prepare_graph_document_for_export(&decode(invalid)),
        Err(ExportPreparationError::GraphIntegrity { .. })
    ));

    let cases = [
        {
            let mut value = document(
                vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
                vec![CANONICAL_ID],
            );
            value["stageNodes"][0]["controlSettings"] = serde_json::json!({"wheel": false});
            value
        },
        {
            let mut value = document(
                vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
                vec![CANONICAL_ID],
            );
            value["stageNodes"][0]["duration"] = serde_json::json!(1234);
            value
        },
        {
            let mut value = document(
                vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
                vec![CANONICAL_ID, CANONICAL_ID],
            );
            value["stageNodes"][0]["type"] = serde_json::json!("story");
            value["stageNodes"][0]["groupId"] = serde_json::json!("known-story");
            value["actionNodes"][0]["type"] = serde_json::json!("story.storyaction");
            value["actionNodes"][0]["groupId"] = serde_json::json!("known-story");
            value
        },
        {
            let mut value = document(
                vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
                vec![CANONICAL_ID],
            );
            value["actionNodes"][0]["uuid"] = serde_json::json!("divergent-alias");
            value
        },
    ];
    for value in cases {
        assert!(matches!(
            prepare_graph_document_for_export(&decode(value)),
            Err(ExportPreparationError::AuthoringActionRequired { .. })
        ));
    }
}

#[test]
fn warning_info_and_untested_alone_do_not_block_preparation() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["stageNodes"][0]["type"] = serde_json::json!("future.stage");
    value["actionNodes"]
        .as_array_mut()
        .expect("actions")
        .push(serde_json::json!({
            "id": "empty-scaffold",
            "options": []
        }));
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    payload
        .context
        .export_qualifications
        .push(ExportQualification {
            dimension: "future-dimension".to_string(),
            path: "/".to_string(),
            status: InteroperabilityStatus::Untested,
            reason: "non mesuré".to_string(),
        });
    prepare_graph_document_for_export(&payload).expect("WARNING/INFO/UNTESTED non bloquants");
}

#[test]
fn prep_006_emits_the_closed_standard_shape_and_only_confirmed_extensions() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["title"] = serde_json::Value::Null;
    value["factoryDisabled"] = serde_json::json!({"opaque": true});
    value["image"] = serde_json::json!("https://invalid.example/cover.png");
    value["official"] = serde_json::json!(true);
    value["storyStudioMetadata"] = serde_json::json!({"owner": "third-party"});
    value["stageNodes"][0]["id"] = serde_json::json!(ENTRY_ID);
    value["stageNodes"][0]["duration"] = serde_json::json!(1234.5);
    value["stageNodes"][0]["position"] = serde_json::json!({"x": 1.25, "y": -2.5});
    value["stageNodes"][0]["position"]["unit"] = serde_json::json!("px");
    value["stageNodes"][0]["okTransition"]["trace"] = serde_json::json!("opaque-id-like");
    value["stageNodes"][0]["controlSettings"]["vendor"] = serde_json::json!(7);
    value["actionNodes"][0]["uuid"] = serde_json::json!("menu");
    value["actionNodes"][0]["position"] = serde_json::json!({"x": 3.5, "y": 4.75});
    value["actionNodes"][0]["vendor"] = serde_json::json!(false);
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    let members = payload.context.opaque_members.clone();
    for member in members {
        if member.kind == OpaqueMemberKind::UnknownExtension {
            set_opaque_export_disposition(
                &mut payload,
                &member.path,
                &member.key,
                member.source_occurrence,
                OpaqueExportDisposition::PreserveUntested,
            )
            .expect("disposition extension");
        }
    }

    let prepared = prepare_graph_document_for_export(&payload).expect("préparation");
    let json = prepared.standard_value();
    assert_eq!(json["format"], "v1");
    assert_eq!(json["version"], 1);
    assert!(json["title"].is_null(), "null présence-sensible conservé");
    assert!(json.get("description").is_none(), "absence conservée");
    assert_eq!(json["factoryDisabled"], serde_json::json!({"opaque": true}));
    assert!(
        json.get("uuid").is_none(),
        "racine importée absente conservée"
    );
    assert!(json.get("image").is_none());
    assert!(json.get("official").is_none());
    assert_eq!(json["storyStudioMetadata"]["owner"], "third-party");
    let stage = &json["stageNodes"][0];
    for key in [
        "uuid",
        "audio",
        "image",
        "controlSettings",
        "okTransition",
        "homeTransition",
        "squareOne",
    ] {
        assert!(stage.get(key).is_some(), "Stage.{key}");
    }
    for key in ["wheel", "ok", "home", "pause", "autoplay", "vendor"] {
        assert!(
            stage["controlSettings"].get(key).is_some(),
            "controlSettings.{key}"
        );
    }
    assert_eq!(
        stage["position"],
        serde_json::json!({"x": 1.25, "y": -2.5, "unit": "px"})
    );
    assert_eq!(stage["duration"], 1234.5);
    assert_eq!(stage["okTransition"]["trace"], "opaque-id-like");
    assert!(stage.get("id").is_none(), "alias redondant jamais émis");
    let action = &json["actionNodes"][0];
    assert!(action.get("uuid").is_none(), "alias redondant jamais émis");
    assert_eq!(action["position"], serde_json::json!({"x": 3.5, "y": 4.75}));
    assert_eq!(action["vendor"], false);
    let serialized = serialize_prepared_graph_document(&prepared).expect("serializer standard");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
        *json
    );
}

#[test]
fn explicit_position_decisions_transform_only_the_copy() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["stageNodes"][0]["position"] = serde_json::json!({"x": 40000.5, "y": -20000.25});
    value["stageNodes"][1]["position"] = serde_json::json!({"x": -50000.0, "y": 10.5});
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    let paths = stable_node_paths(
        &payload.document.stage_nodes,
        "stageNodes",
        "uuid",
        |stage| stage.uuid.as_str(),
    );
    set_position_export_disposition(
        &mut payload,
        &format!("{}/position", paths[0]),
        PositionExportDisposition::ScaleToShortRange,
    )
    .expect("scale");
    set_position_export_disposition(
        &mut payload,
        &format!("{}/position", paths[1]),
        PositionExportDisposition::OmitExplicitly,
    )
    .expect("omit");
    let author = payload.document.clone();

    let prepared = prepare_graph_document_for_export(&payload).expect("positions résolues");
    let scaled = prepared.document.stage_nodes[0]
        .position
        .value()
        .expect("scaled");
    assert_eq!(scaled.x.as_f64(), Some(32767.0));
    assert!(scaled.y.as_f64().unwrap().fract() != 0.0, "aucun arrondi");
    assert!(prepared.document.stage_nodes[1].position.is_absent());
    assert_eq!(payload.document, author, "positions auteur inchangées");
}

#[test]
fn out_of_range_positions_are_scaled_silently_and_together_on_the_copy() {
    // Sans aucune décision d'auteur, une disposition qui sort de l'intervalle
    // short est réduite d'un seul facteur — les écarts relatifs restent ceux de
    // l'auteur — et arrondie à l'entier.
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["stageNodes"][0]["position"] = serde_json::json!({"x": 65534, "y": 100});
    value["stageNodes"][1]["position"] = serde_json::json!({"x": 32767, "y": -200});
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    let author = payload.document.clone();

    let prepared = prepare_graph_document_for_export(&payload).expect("préparation");
    let at = |index: usize| {
        let position = prepared.document.stage_nodes[index]
            .position
            .value()
            .expect("position exportée");
        (position.x.as_i64(), position.y.as_i64())
    };
    assert_eq!(at(0), (Some(32767), Some(50)));
    assert_eq!(at(1), (Some(16384), Some(-100)));
    assert_eq!(payload.document, author, "le document garde ses positions");
}

#[test]
fn positions_within_range_leave_the_copy_untouched() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["stageNodes"][0]["position"] = serde_json::json!({"x": 12.5, "y": -32768});
    let mut payload = decode(value);
    payload.context.pack_identity.value = Some(PACK_ID.to_string());

    let prepared = prepare_graph_document_for_export(&payload).expect("préparation");
    let position = prepared.document.stage_nodes[0].position.value().unwrap();
    assert_eq!(position.x.as_f64(), Some(12.5));
    assert_eq!(position.y.as_f64(), Some(-32768.0));
}

#[test]
fn a_created_document_mirrors_pack_identity_and_keeps_the_authored_version() {
    let mut payload = decode(document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    ));
    payload.context.document_origin = DocumentOrigin::Created;
    payload.context.default_value_origin = ValueOrigin::Authored;
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    payload.document.version = Presence::Value(8);
    payload.document.uuid = Presence::Absent;

    let prepared = prepare_graph_document_for_export(&payload).expect("projet neuf");
    // L'identité reste imposée : elle est acquise une seule fois et la racine
    // `uuid` d'un document créé en est le miroir.
    assert_eq!(prepared.standard_value()["uuid"], PACK_ID);
    // La version, elle, est celle de l'auteur. Elle était auparavant écrasée à
    // `1`, ce qui interdisait à un pack créé dans l'éditeur graphe de porter
    // une version 2 quoi que l'auteur saisisse.
    assert_eq!(prepared.standard_value()["version"], 8);
}

#[test]
fn a_created_document_without_a_version_still_gets_one() {
    // Une version est toujours émise. Sans valeur d'auteur, c'est `1` — le
    // défaut, pas une imposition.
    let mut payload = decode(document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    ));
    payload.context.document_origin = DocumentOrigin::Created;
    payload.context.default_value_origin = ValueOrigin::Authored;
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    payload.document.version = Presence::Absent;
    payload.document.uuid = Presence::Absent;

    let prepared = prepare_graph_document_for_export(&payload).expect("projet neuf sans version");
    assert_eq!(prepared.standard_value()["version"], 1);
}

#[test]
fn fs_native_values_keep_version_and_never_promote_editor_layout() {
    let mut value = document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    );
    value["version"] = serde_json::json!(256);
    value["uuid"] = serde_json::json!("root-is-not-authority");
    let mut payload = decode(value);
    payload.context.document_origin = DocumentOrigin::ImportedFs;
    payload.context.default_value_origin = ValueOrigin::SourceNativeDerived;
    payload.context.pack_identity.value = Some(PACK_ID.to_string());
    payload.context.editor_positions.push(EditorPosition {
        path: format!(
            "{}/position",
            stable_node_paths(
                &payload.document.stage_nodes,
                "stageNodes",
                "uuid",
                |stage| { stage.uuid.as_str() }
            )[0]
        ),
        origin: ValueOrigin::ProjectionDerived,
        position: Position {
            x: serde_json::Number::from(999_999),
            y: serde_json::Number::from(-999_999),
        },
    });

    let prepared = prepare_graph_document_for_export(&payload).expect("FS préparé");
    assert_eq!(prepared.standard_value()["version"], 256);
    assert_eq!(prepared.standard_value()["uuid"], "root-is-not-authority");
    assert!(prepared.standard_value()["stageNodes"][0]
        .get("position")
        .is_none());
}

#[test]
fn libre_writer_never_fabricates_a_new_root_identity() {
    let payload = decode(document(
        vec![stage(ENTRY_ID, Some(true)), stage(CANONICAL_ID, None)],
        vec![CANONICAL_ID],
    ));
    let error = serialize_story_with_pack_uuid(&payload.document, "")
        .expect_err("identité absente refusée");
    assert!(error.contains("Identité de pack absente"), "{error}");

    let mut imported = payload.document;
    imported.uuid = Presence::Value("root-imported".to_string());
    let first = serialize_story_with_pack_uuid(&imported, "").expect("racine importée");
    let second = serialize_story_with_pack_uuid(&imported, "").expect("racine stable");
    assert_eq!(first, second);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&first).unwrap()["uuid"],
        "root-imported"
    );
}

/// Adaptateur minimal pour des outils externes (Python) qui ne préparent jamais
/// eux-mêmes le document. Ils déposent les JSON auteur, puis ce test ignoré
/// exécute le décodeur, la préparation et la sérialisation standard Rust.
#[test]
#[ignore = "requires STORY_STUDIO_D1_B3_INPUT_DIR and STORY_STUDIO_D1_B3_OUTPUT_DIR"]
fn d1_b3_prepares_campaign_documents_through_the_rust_path() {
    use std::fs;
    use std::path::PathBuf;

    let input_dir =
        PathBuf::from(std::env::var("STORY_STUDIO_D1_B3_INPUT_DIR").expect("input directory"));
    let output_dir =
        PathBuf::from(std::env::var("STORY_STUDIO_D1_B3_OUTPUT_DIR").expect("output directory"));
    let identities: std::collections::BTreeMap<String, String> = serde_json::from_str(
        &fs::read_to_string(input_dir.join("pack-identities.json")).expect("identity manifest"),
    )
    .expect("identity map");
    fs::create_dir_all(&output_dir).expect("création du dossier de sortie");

    let mut names = identities.keys().cloned().collect::<Vec<_>>();
    names.sort();
    for name in names {
        let raw = fs::read_to_string(input_dir.join(format!("{name}.json")))
            .unwrap_or_else(|error| panic!("{name}: auteur absent: {error}"));
        let mut payload =
            decode_story_document(&raw).unwrap_or_else(|error| panic!("{name}: décodage: {error}"));
        payload.context.pack_identity.value = identities.get(&name).cloned();
        payload.context.pack_identity.short_identity = payload
            .context
            .pack_identity
            .value
            .as_deref()
            .and_then(|value| classify_stage_id(value).short_luniiqt);
        let author = payload.clone();
        let prepared = prepare_graph_document_for_export(&payload)
            .unwrap_or_else(|error| panic!("{name}: PREP Rust: {error}"));
        let repeated = prepare_graph_document_for_export(&payload)
            .unwrap_or_else(|error| panic!("{name}: seconde PREP Rust: {error}"));
        assert_eq!(prepared, repeated, "{name}: préparation déterministe");
        assert_eq!(payload.document, author.document, "{name}: auteur immuable");
        assert_eq!(payload.context, author.context, "{name}: contexte immuable");

        fs::write(
            output_dir.join(format!("{name}.json")),
            serialize_prepared_graph_document(&prepared).expect("sérialisation standard"),
        )
        .unwrap_or_else(|error| panic!("{name}: écriture sortie: {error}"));
        fs::write(
            output_dir.join(format!("{name}-id-map.json")),
            serde_json::to_string_pretty(&prepared.stage_id_map).expect("serialize id map"),
        )
        .unwrap_or_else(|error| panic!("{name}: écriture table: {error}"));
    }

    let refusals_path = input_dir.join("expected-refusals.json");
    if refusals_path.is_file() {
        let refusals: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&fs::read_to_string(refusals_path).expect("refusal manifest"))
                .expect("refusal map");
        for (name, pack_identity) in refusals {
            let raw = fs::read_to_string(input_dir.join(format!("{name}.json")))
                .unwrap_or_else(|error| panic!("{name}: auteur absent: {error}"));
            let mut payload = decode_story_document(&raw)
                .unwrap_or_else(|error| panic!("{name}: décodage: {error}"));
            payload.context.pack_identity.value = Some(pack_identity);
            let error = match prepare_graph_document_for_export(&payload) {
                Ok(_) => panic!("{name}: le refus de readiness était attendu"),
                Err(error) => error,
            };
            fs::write(
                output_dir.join(format!("{name}-refusal.json")),
                serde_json::to_string_pretty(&error).expect("serialize refusal"),
            )
            .unwrap_or_else(|write_error| panic!("{name}: écriture refus: {write_error}"));
        }
    }
}

#[test]
#[ignore = "requires STORY_STUDIO_D1_B3_ENRICHED_DIR with private A051/A135 JSON"]
fn d1_b3_keeps_a051_and_a135_enriched_metadata_on_the_prepared_copy() {
    use std::fs;
    use std::path::PathBuf;

    let directory = PathBuf::from(
        std::env::var("STORY_STUDIO_D1_B3_ENRICHED_DIR").expect("enriched corpus directory"),
    );
    for (label, filename) in [("A051", "216.json"), ("A135", "368.json")] {
        let raw = fs::read_to_string(directory.join(filename))
            .unwrap_or_else(|error| panic!("{label}: source privée absente: {error}"));
        let source: serde_json::Value = serde_json::from_str(&raw).expect("source JSON");
        let mut payload = decode_story_document(&raw)
            .unwrap_or_else(|error| panic!("{label}: décodage: {error}"));
        let author = payload.clone();
        let members = payload.context.opaque_members.clone();
        for member in members {
            if member.kind == OpaqueMemberKind::UnknownExtension {
                set_opaque_export_disposition(
                    &mut payload,
                    &member.path,
                    &member.key,
                    member.source_occurrence,
                    OpaqueExportDisposition::PreserveUntested,
                )
                .unwrap_or_else(|error| panic!("{label}: disposition opaque: {error}"));
            }
        }
        let prepared = prepare_graph_document_for_export(&payload)
            .unwrap_or_else(|error| panic!("{label}: préparation: {error}"));
        assert_eq!(
            payload.document, author.document,
            "{label}: auteur immuable"
        );

        for source_stage in &author.document.stage_nodes {
            let export_id = &prepared.stage_id_map[&source_stage.uuid];
            let prepared_stage = prepared
                .document
                .stage_nodes
                .iter()
                .find(|stage| &stage.uuid == export_id)
                .expect("Stage préparé");
            assert_eq!(
                prepared_stage.group_id, source_stage.group_id,
                "{label}: Stage.groupId"
            );
            assert_eq!(
                prepared_stage.stage_type, source_stage.stage_type,
                "{label}: Stage.type"
            );
            assert_eq!(
                prepared_stage.position, source_stage.position,
                "{label}: Stage.position"
            );
        }
        for source_action in &author.document.action_nodes {
            let prepared_action = prepared
                .document
                .action_nodes
                .iter()
                .find(|action| action.id == source_action.id)
                .expect("Action préparée");
            assert_eq!(
                prepared_action.group_id, source_action.group_id,
                "{label}: Action.groupId"
            );
            assert_eq!(
                prepared_action.action_type, source_action.action_type,
                "{label}: Action.type"
            );
            assert_eq!(
                prepared_action.position, source_action.position,
                "{label}: Action.position"
            );
        }
        assert_eq!(
            count_key(&source, "duration"),
            count_key(prepared.standard_value(), "duration"),
            "{label}: extensions Stage duration"
        );
        assert_eq!(
            count_key(&source, "storyStudioMetadata"),
            count_key(prepared.standard_value(), "storyStudioMetadata"),
            "{label}: extension racine"
        );
    }
}

fn count_key(value: &serde_json::Value, searched: &str) -> usize {
    match value {
        serde_json::Value::Object(object) => {
            usize::from(object.contains_key(searched))
                + object
                    .values()
                    .map(|value| count_key(value, searched))
                    .sum::<usize>()
        }
        serde_json::Value::Array(values) => {
            values.iter().map(|value| count_key(value, searched)).sum()
        }
        _ => 0,
    }
}
