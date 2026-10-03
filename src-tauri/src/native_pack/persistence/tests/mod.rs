mod acquisition;

use super::*;
use crate::native_pack::{
    authoring::{
        diagnose_enriched_metadata, set_opaque_export_disposition, set_position_export_disposition,
    },
    decode_story_document,
    readiness::{assess_graph_document_export_readiness, DimensionQualification},
    EditorPosition, OpaqueExportDisposition, Position, PositionExportDisposition, Presence,
    ValueOrigin,
};
use serde_json::{json, Number};

const ENTRY: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND: &str = "123e4567-e89b-12d3-a456-426614174000";

fn nominal() -> DecodedStoryDocument {
    decode_story_document(&json!({
        "format":"v1", "version":1,
        "stageNodes":[
            {"uuid":ENTRY, "squareOne":true, "audio":null, "image":null,
             "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false},
             "okTransition":{"actionNode":"menu","optionIndex":0}, "homeTransition":null},
            {"uuid":SECOND, "squareOne":false, "audio":null, "image":null,
             "controlSettings":{"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false},
             "okTransition":null, "homeTransition":null}
        ],
        "actionNodes":[{"id":"menu","options":[SECOND]}]
    }).to_string()).unwrap()
}

fn twice(payload: &DecodedStoryDocument) -> DecodedStoryDocument {
    let mut current = payload.clone();
    for _ in 0..2 {
        let encoded = encode_authoring_payload(&current).unwrap();
        assert!(!encoded.contains("sourceValue"));
        let reopened = decode_authoring_payload(&encoded).unwrap();
        assert_eq!(payload.document, reopened.document, "document indépendant");
        assert_eq!(payload.context, reopened.context, "contexte indépendant");
        assert_eq!(reopened.source_value, Value::Null);
        validate_authoring_payload(&encoded).unwrap();
        current = reopened;
    }
    current
}

fn enriched() -> DecodedStoryDocument {
    // Import initial uniquement : doublons capturés avant leur réduction last-wins.
    decode_story_document(r#"{
        "title":"écarté","title":null,"factoryDisabled":false,
        "rootExtension":9007199254740993,"rootExtension":12345678901234567890,
        "stageNodes":[{"uuid":"stage-a","name":null,"type":"enriched-stage","groupId":"group",
            "squareOne":true,"stageExtension":-0.0,
            "controlSettings":{"wheel":false,"ok":true,"home":null,"pause":false,"controlExtension":[9007199254740993,0.1]},
            "okTransition":{"actionNode":"action-a","optionIndex":-1,"transitionExtension":{"deep":12345678901234567890}},
            "position":{"x":120.5,"y":-32769.5,"positionExtension":0.12345678901234568}},
            {"uuid":"stage-b","controlSettings":null}],
        "actionNodes":[{"id":"action-a","uuid":"action-a","name":null,"groupId":"group",
            "type":"enriched-action","options":["stage-a",null],"actionExtension":null}]
    }"#).unwrap()
}

#[test]
fn six_scopes_duplicates_enriched_fields_and_numbers_survive_two_cycles() {
    let mut payload = enriched();
    assert_eq!(
        payload
            .context
            .opaque_members
            .iter()
            .map(|m| format!("{:?}", m.scope))
            .collect::<std::collections::HashSet<_>>()
            .len(),
        6
    );
    let action = payload
        .context
        .opaque_members
        .iter()
        .find(|m| m.key == "actionExtension")
        .unwrap()
        .clone();
    set_opaque_export_disposition(
        &mut payload,
        &action.path,
        &action.key,
        0,
        OpaqueExportDisposition::PreserveUntested,
    )
    .unwrap();
    let position_path = "/stageNodes/@uuid=stage-a#0/position";
    set_position_export_disposition(
        &mut payload,
        position_path,
        PositionExportDisposition::PreserveRawAcceptDantsuLoss,
    )
    .unwrap();
    payload.document.stage_nodes.swap(0, 1);
    let reopened = twice(&payload);
    let controls = reopened.document.stage_nodes[1]
        .control_settings
        .value()
        .unwrap();
    assert_eq!(controls.home, Presence::Null);
    assert_eq!(controls.autoplay, Presence::Absent);
    assert_eq!(controls.pause, Presence::Value(false));
    assert_eq!(reopened.document.title, Presence::Null);
    assert_eq!(reopened.document.version, Presence::Absent);
    assert_eq!(
        reopened
            .context
            .diagnostics
            .iter()
            .find(|d| d.path == "/title")
            .unwrap()
            .retained,
        Presence::Null
    );
    let position = reopened.document.stage_nodes[1].position.value().unwrap();
    assert_eq!(position.x.as_f64().unwrap().to_bits(), 120.5_f64.to_bits());
    assert_eq!(
        position.y.as_f64().unwrap().to_bits(),
        (-32769.5_f64).to_bits()
    );
    let roots: Vec<_> = reopened
        .context
        .opaque_members
        .iter()
        .filter(|m| m.key == "rootExtension")
        .collect();
    assert_eq!(roots[0].value.as_u64(), Some(9007199254740993));
    assert_eq!(roots[1].value.as_u64(), Some(12345678901234567890));
    assert_eq!(
        (roots[0].source_occurrence, roots[1].source_occurrence),
        (0, 1)
    );
    assert!(diagnose_enriched_metadata(&reopened)
        .iter()
        .any(|d| d.code == "OPAQUE_EXTENSION_PRESERVED_UNTESTED"));
}

#[test]
fn all_context_presence_states_and_real_disposition_consumers() {
    for snapshot in [
        Presence::Absent,
        Presence::Null,
        Presence::from_json(json!(9007199254740993_u64)),
    ] {
        for retained in [
            Presence::Absent,
            Presence::Null,
            Presence::from_json(json!(false)),
        ] {
            let mut payload = enriched();
            let member = payload
                .context
                .opaque_members
                .iter_mut()
                .find(|m| m.key == "actionExtension")
                .unwrap();
            member.export_disposition = Some(OpaqueExportDisposition::PreserveUntested);
            member.export_disposition_origin = Some(member.origin);
            member.export_disposition_value = snapshot.clone();
            payload.context.diagnostics[0].retained = retained.clone();
            let reopened = twice(&payload);
            let diagnostics = diagnose_enriched_metadata(&reopened);
            assert_eq!(
                diagnostics
                    .iter()
                    .any(|d| d.code == "OPAQUE_EXTENSION_DISPOSITION_STALE"
                        && d.path.ends_with("/actionExtension")),
                snapshot != Presence::Null
            );
        }
    }
    // Le producteur de disposition construit bien Null, pas Value(Null).
    let mut payload = enriched();
    let member = payload
        .context
        .opaque_members
        .iter()
        .find(|m| m.key == "actionExtension")
        .unwrap()
        .clone();
    set_opaque_export_disposition(
        &mut payload,
        &member.path,
        &member.key,
        0,
        OpaqueExportDisposition::PreserveUntested,
    )
    .unwrap();
    let member = payload
        .context
        .opaque_members
        .iter()
        .find(|m| m.key == "actionExtension")
        .unwrap();
    assert_eq!(member.export_disposition_value, Presence::Null);
}

#[test]
fn current_and_stale_position_decisions_never_create_position_diagnostics() {
    let mut payload = enriched();
    set_position_export_disposition(
        &mut payload,
        "/stageNodes/@uuid=stage-a#0/position",
        PositionExportDisposition::OmitExplicitly,
    )
    .unwrap();
    assert!(!diagnose_enriched_metadata(&twice(&payload))
        .iter()
        .any(|d| d.code.starts_with("POSITION_")));
    payload.document.stage_nodes[0]
        .position
        .value_mut()
        .unwrap()
        .x = 130.into();
    assert!(!diagnose_enriched_metadata(&twice(&payload))
        .iter()
        .any(|d| d.code.starts_with("POSITION_")));
}

#[test]
fn fs_layout_version_qualification_and_identity_are_not_reimported() {
    let mut payload = nominal();
    payload.document.version = Presence::Value(256);
    payload.context = StoryDocumentContext::imported_fs(&payload.document, ENTRY);
    let identity = payload.context.pack_identity.clone();
    payload.document.stage_nodes[0].square_one = Presence::Value(false);
    payload.document.stage_nodes[1].square_one = Presence::Value(true);
    let reopened = twice(&payload);
    assert_eq!(reopened.context.pack_identity, identity);
    assert!(!reopened.context.editor_positions.is_empty());
    assert!(reopened
        .document
        .stage_nodes
        .iter()
        .all(|s| s.position.is_absent()));
    assert!(reopened
        .context
        .export_qualifications
        .iter()
        .any(|q| q.dimension == "studio-export-version"));
    assert_eq!(reopened.document.version, Presence::Value(256));
}

#[test]
fn valid_persistence_is_independent_of_export_readiness() {
    for authored in [false, true] {
        let mut payload = nominal();
        payload.document.action_nodes.push(
            serde_json::from_value(if authored {
                json!({"id":"orphan","name":"Chapitre coupé","options":[SECOND]})
            } else {
                json!({"id":"orphan","options":[]})
            })
            .unwrap(),
        );
        let readiness = assess_graph_document_export_readiness(Ok(&twice(&payload)));
        assert_eq!(readiness.blocked, authored);
        assert_eq!(
            readiness.interoperability,
            DimensionQualification::Supported
        );
        assert!(serde_json::to_string(&readiness)
            .unwrap()
            .contains(if authored {
                "ORPHAN_ACTION_AUTHORED_CONTENT"
            } else {
                "ORPHAN_ACTION_EMPTY_SCAFFOLD"
            }));
    }
    let mut payload = nominal();
    payload.document.action_nodes[0].options[0] = Some("missing".into());
    let reopened = twice(&payload);
    assert!(assess_graph_document_export_readiness(Ok(&reopened)).blocked);
    let reopened = twice(&enriched());
    assert!(assess_graph_document_export_readiness(Ok(&reopened)).blocked);
}

#[test]
fn payload_compatibility_gate_reports_errors_before_any_import() {
    let base: Value = serde_json::from_str(&encode_authoring_payload(&nominal()).unwrap()).unwrap();
    for (input, code) in [
        ("{", "INVALID_PAYLOAD_JSON"),
        ("[]", "INVALID_PAYLOAD_SHAPE"),
        ("null", "INVALID_PAYLOAD_SHAPE"),
    ] {
        assert_eq!(decode_authoring_payload(input).unwrap_err().code, code);
    }
    for (value, code) in [
        (json!(0), "PAYLOAD_MIGRATION_REQUIRED"),
        (json!(2), "UNSUPPORTED_PAYLOAD_VERSION"),
        (json!(null), "INVALID_PAYLOAD_VERSION"),
        (json!("1"), "INVALID_PAYLOAD_VERSION"),
        (json!(1.5), "INVALID_PAYLOAD_VERSION"),
        (json!(-1), "PAYLOAD_MIGRATION_REQUIRED"),
    ] {
        let mut raw = base.clone();
        raw["payloadVersion"] = value;
        assert_eq!(
            decode_authoring_payload(&raw.to_string()).unwrap_err().code,
            code
        );
    }
    for path in [
        "/payloadVersion",
        "/context",
        "/context/documentOrigin",
        "/context/defaultValueOrigin",
        "/document",
        "/document/stageNodes",
        "/document/actionNodes",
    ] {
        let mut raw = base.clone();
        let (parent, key) = path.rsplit_once('/').unwrap();
        raw.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(
            decode_authoring_payload(&raw.to_string()).is_err(),
            "{path}"
        );
    }
    for path in [
        "/context/documentOrigin",
        "/context/defaultValueOrigin",
        "/context/packIdentity/origin",
    ] {
        let mut raw = base.clone();
        *raw.pointer_mut(path).unwrap() = json!("future");
        assert!(
            decode_authoring_payload(&raw.to_string()).is_err(),
            "{path}"
        );
    }
    for value in [json!(42), json!("false"), json!([]), json!({"wheel":1})] {
        let mut raw = base.clone();
        raw["document"]["stageNodes"][0]["controlSettings"] = value;
        assert_eq!(
            decode_authoring_payload(&raw.to_string()).unwrap_err().code,
            "INVALID_CONTROL_SETTINGS"
        );
    }
    let mut raw = base.clone();
    raw["context"]
        .as_object_mut()
        .unwrap()
        .remove("packIdentity");
    for field in [
        "valueProvenance",
        "editorPositions",
        "positionExportDecisions",
        "exportQualifications",
        "opaqueMembers",
        "diagnostics",
    ] {
        raw["context"].as_object_mut().unwrap().remove(field);
    }
    let summary = validate_authoring_payload(&raw.to_string()).unwrap();
    assert_eq!(summary.identity_status, IdentityStatus::RequiresGeneration);
    for (path, key) in [
        ("", "sourceValue"),
        ("/document", "nodes"),
        ("/context", "stageIdMap"),
    ] {
        let mut raw = base.clone();
        raw.pointer_mut(path).unwrap()[key] = json!([]);
        assert!(decode_authoring_payload(&raw.to_string()).is_err());
    }
}

#[test]
#[ignore = "requires STORY_STUDIO_B2_CORPUS_DIR with private A051/A135"]
fn private_a051_a135_persistence_two_cycles() {
    let root = std::path::PathBuf::from(std::env::var("STORY_STUDIO_B2_CORPUS_DIR").unwrap());
    for name in ["216.json", "368.json"] {
        let raw = std::fs::read_to_string(root.join(name)).unwrap();
        twice(&decode_story_document(&raw).unwrap());
    }
}

#[test]
fn production_js_codec_and_tauri_handler_preserve_the_string_across_two_cycles() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::commands::project_codec::validate_advanced_payload
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let payload = enriched();
    let encoded = encode_authoring_payload(&payload).unwrap();
    let mut child = Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/projectCodecTransport.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({"payload":encoded})).unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut invocations = 0;
    let mut completed = false;
    for line in output.lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if message["kind"] == "done" {
            let returned = message["payload"].as_str().unwrap();
            assert_eq!(returned, encoded);
            let reopened = decode_authoring_payload(returned).unwrap();
            assert_eq!(payload.document, reopened.document);
            assert_eq!(payload.context, reopened.context);
            completed = true;
            break;
        }
        assert_eq!(message["kind"], "invoke");
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: message["cmd"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(message["args"].clone()),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let response = match response {
            Ok(body) => json!({"result":body.deserialize::<Value>().unwrap()}),
            Err(error) => json!({"error":error}),
        };
        writeln!(input, "{response}").unwrap();
        invocations += 1;
    }
    assert!(child.wait().unwrap().success());
    assert!(completed);
    assert_eq!(invocations, 3);
}

/// Cycle disque réel du mode Avancé.
///
/// Le document est **édité** par les API déjà disponibles avant d'être
/// enregistré : une transition et la disposition d'un membre opaque. Le script
/// Node exerce ensuite `saveProject`, `loadProjectFromPath`, `saveProjectAs`,
/// le déplacement du dossier, le backup, une panne de remplacement injectée et
/// trois refus de payload — sur de vrais fichiers. Seuls la WebView, les
/// dialogues et le transport IPC sont doublés : la validation d'ouverture passe
/// par ce handler, et le payload rendu est recomparé ici, hors de JavaScript.
#[test]
fn production_disk_cycle_reopens_the_edited_advanced_project_without_touching_it() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::commands::project_codec::validate_advanced_payload
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let mut edited = enriched();
    edited.document = crate::native_pack::authoring::with_action_option_target(
        &edited.document,
        "action-a",
        0,
        Some("stage-b".to_string()),
    )
    .unwrap();
    // Conserver deux occurrences distinctes vers la même cible.
    edited.document.action_nodes[0]
        .options
        .push(Some("stage-b".into()));
    let member = edited
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "actionExtension")
        .unwrap()
        .clone();
    set_opaque_export_disposition(
        &mut edited,
        &member.path,
        &member.key,
        0,
        OpaqueExportDisposition::PreserveUntested,
    )
    .unwrap();
    let mut draws = 0_u128;
    let encoded =
        crate::native_pack::persistence::initialize_advanced_document(edited, &mut || {
            draws += 1;
            uuid::Uuid::from_u128(0x9e37_79b9_7f4a_7c15_0000_0000_0000_0000 | draws)
        })
        .unwrap();
    assert_eq!(draws, 1, "identité générée une seule fois, avant le disque");
    let acquired = decode_authoring_payload(&encoded).unwrap();

    let mut child = Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/projectDiskTransport.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({ "payload": encoded })).unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut openings = 0;
    let mut checks = 0;
    for line in output.lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if message["kind"] == "done" {
            let returned = message["payload"].as_str().unwrap();
            assert_eq!(
                returned, encoded,
                "la chaîne écrite est celle qui a été validée"
            );
            let reopened = decode_authoring_payload(returned).unwrap();
            assert_eq!(acquired.document, reopened.document, "document indépendant");
            assert_eq!(acquired.context, reopened.context, "contexte indépendant");
            assert_eq!(
                acquired.context.pack_identity, reopened.context.pack_identity,
                "identité stable après enregistrement, Save As et réouverture"
            );
            assert_eq!(reopened.source_value, Value::Null);
            assert_reopened_graph_view_matches_document(returned, &reopened);
            checks = message["checks"].as_u64().unwrap();
            break;
        }
        assert_eq!(message["cmd"], "validate_advanced_payload");
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: message["cmd"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(message["args"].clone()),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let response = match response {
            Ok(body) => json!({ "result": body.deserialize::<Value>().unwrap() }),
            Err(error) => json!({ "error": error }),
        };
        writeln!(input, "{response}").unwrap();
        openings += 1;
    }
    assert!(child.wait().unwrap().success());
    assert_eq!(openings, 9, "chaque ouverture consulte Rust une fois");
    assert_eq!(checks, 36, "contrôles disque exécutés côté production JS");
}

#[test]
fn null_disposition_survives_into_the_real_preparation_serializer() {
    let mut source = serde_json::to_value(&nominal().document).unwrap();
    source["actionNodes"][0]["actionExtension"] = Value::Null;
    let mut payload = decode_story_document(&source.to_string()).unwrap();
    let member = payload.context.opaque_members[0].clone();
    set_opaque_export_disposition(
        &mut payload,
        &member.path,
        &member.key,
        0,
        OpaqueExportDisposition::PreserveUntested,
    )
    .unwrap();
    let reopened = twice(&payload);
    let prepared =
        crate::native_pack::preparation::prepare_graph_document_for_export(&reopened).unwrap();
    assert_eq!(
        prepared.standard_value()["actionNodes"][0].get("actionExtension"),
        Some(&Value::Null)
    );
}

#[test]
fn incomplete_controls_and_nested_presence_are_not_filled_in() {
    for controls in [
        None,
        Some(Value::Null),
        Some(json!({})),
        Some(json!({"ok":false,"home":null})),
    ] {
        let mut source = serde_json::to_value(&nominal().document).unwrap();
        let stage = source["stageNodes"][0].as_object_mut().unwrap();
        stage.remove("controlSettings");
        if let Some(value) = &controls {
            stage.insert("controlSettings".into(), value.clone());
        }
        let payload = decode_story_document(&source.to_string()).unwrap();
        let reopened = twice(&payload);
        let actual = serde_json::to_value(&reopened.document).unwrap();
        assert_eq!(
            actual["stageNodes"][0].get("controlSettings"),
            controls.as_ref()
        );
    }
}

#[test]
fn context_unknown_enums_missing_opaque_values_and_array_structs_are_rejected() {
    let base: Value =
        serde_json::from_str(&encode_authoring_payload(&enriched()).unwrap()).unwrap();
    for key in [
        "scope",
        "kind",
        "origin",
        "exportDisposition",
        "exportDispositionOrigin",
    ] {
        let mut raw = base.clone();
        raw["context"]["opaqueMembers"][0][key] = json!("future");
        assert!(decode_authoring_payload(&raw.to_string()).is_err(), "{key}");
    }
    let mut raw = base.clone();
    raw["context"]["opaqueMembers"][0]
        .as_object_mut()
        .unwrap()
        .remove("value");
    assert!(decode_authoring_payload(&raw.to_string()).is_err());
    let mut raw = base.clone();
    raw["context"]["diagnostics"][0]["discarded"] = json!([]);
    assert!(decode_authoring_payload(&raw.to_string()).is_ok());
    let mut raw = base;
    raw["document"]["stageNodes"][0]["position"] = json!([1, 2]);
    assert_eq!(
        decode_authoring_payload(&raw.to_string()).unwrap_err().code,
        "INVALID_PAYLOAD_SHAPE"
    );
}

#[test]
fn opaque_fraction_uses_the_correctly_rounded_f64_value() {
    let source = r#"{"stageNodes":[],"actionNodes":[],"fraction":-990.4606467901111}"#;
    let payload = decode_story_document(source).unwrap();
    let reopened = twice(&payload);
    assert_eq!(
        reopened.context.opaque_members[0]
            .value
            .as_f64()
            .unwrap()
            .to_bits(),
        "-990.4606467901111".parse::<f64>().unwrap().to_bits()
    );
}

/// Payload du cycle d'état de travail.
///
/// Deux Stages liés par une Action, un quadrillage **projeté** rangé dans le
/// contexte et non dans le document, et — au choix — l'Action orpheline à
/// contenu d'auteur. Les deux variantes ne diffèrent que par cette Action :
/// c'est ce qui rend la readiness comparable d'un état à l'autre.
fn work_state_payload(with_orphan: bool) -> String {
    let mut actions = vec![json!({"id":"menu","options":[SECOND]})];
    if with_orphan {
        actions.push(json!({"id":"orpheline","name":"Chapitre coupé","options":[SECOND]}));
    }
    let mut payload = decode_story_document(
        &json!({
            "format":"v1", "version":1,
            "stageNodes":[
                {"uuid":ENTRY, "squareOne":true, "audio":null, "image":null,
                 "controlSettings":{"wheel":false,"ok":true,"home":false,"pause":false,"autoplay":false},
                 "okTransition":{"actionNode":"menu","optionIndex":0}, "homeTransition":null},
                {"uuid":SECOND, "squareOne":false, "audio":null, "image":null,
                 "controlSettings":{"wheel":false,"ok":false,"home":true,"pause":false,"autoplay":false},
                 "okTransition":null, "homeTransition":null}
            ],
            "actionNodes": actions
        })
        .to_string(),
    )
    .unwrap();
    payload.context.editor_positions.push(EditorPosition {
        path: format!("/stageNodes/@uuid={ENTRY}#0/position"),
        origin: ValueOrigin::ProjectionDerived,
        position: Position {
            x: Number::from(376_960),
            y: Number::from(160),
        },
    });
    encode_authoring_payload(&payload).unwrap()
}

/// Cycle d'état de travail réel du mode Avancé.
///
/// Le script Node acquiert un document créé, installe l'Action orpheline, mute
/// son payload, annule, refait, écrit une disposition d'auto-layout, enregistre
/// puis rouvre — avec les fonctions de production. Trois commandes traversent ce
/// handler : l'acquisition, la validation d'ouverture et la readiness. Rust
/// compte les acquisitions, recompose la readiness du document créé avec son
/// propre codec, et vérifie que le quadrillage projeté n'a pas migré dans le
/// document.
#[test]
fn production_work_state_cycle_keeps_the_payload_and_recomputes_readiness() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::commands::project_codec::validate_advanced_payload,
            crate::commands::project_codec::create_advanced_document,
            crate::commands::project_codec::assess_advanced_payload_readiness
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let blocked = work_state_payload(true);
    let fixed = work_state_payload(false);
    let mut child = Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/projectWorkStateTransport.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(
        input,
        "{}",
        json!({ "payloadBlocked": blocked, "payloadFixed": fixed })
    )
    .unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut acquisitions = 0;
    let mut readiness_calls = 0;
    let mut checks = 0;
    let mut completed = false;
    for line in output.lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if message["kind"] == "done" {
            let returned = message["payload"].as_str().unwrap();
            assert_eq!(
                returned, fixed,
                "la chaîne relue est celle qui a été écrite"
            );
            let reopened = decode_authoring_payload(returned).unwrap();
            let source = decode_authoring_payload(&fixed).unwrap();
            assert_eq!(source.document, reopened.document, "document indépendant");
            assert_eq!(source.context, reopened.context, "contexte indépendant");
            assert_eq!(
                reopened.context.editor_positions.len(),
                1,
                "le quadrillage projeté reste dans le contexte"
            );
            assert!(
                reopened
                    .document
                    .stage_nodes
                    .iter()
                    .all(|stage| stage.position.is_absent()),
                "aucune position d'auteur n'a été promue par le cycle"
            );
            let created =
                decode_authoring_payload(message["createdPayload"].as_str().unwrap()).unwrap();
            assert_eq!(
                created.context.pack_identity.origin,
                PackIdentityOrigin::Generated,
                "le document créé porte une identité générée"
            );
            assert_eq!(created.document.stage_nodes.len(), 1);
            assert_eq!(
                message["createdBlocked"],
                json!(assess_graph_document_export_readiness(Ok(&created)).blocked),
                "la readiness rendue à JavaScript est celle que Rust recompose"
            );
            checks = message["checks"].as_u64().unwrap();
            completed = true;
            break;
        }
        assert_eq!(message["kind"], "invoke");
        match message["cmd"].as_str().unwrap() {
            "create_advanced_document" => acquisitions += 1,
            "assess_advanced_payload_readiness" => readiness_calls += 1,
            _ => {}
        }
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: message["cmd"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(message["args"].clone()),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let response = match response {
            Ok(body) => json!({ "result": body.deserialize::<Value>().unwrap() }),
            Err(error) => json!({ "error": error }),
        };
        writeln!(input, "{response}").unwrap();
    }
    assert!(child.wait().unwrap().success());
    assert!(completed);
    assert_eq!(
        acquisitions, 1,
        "une seule acquisition pour tout le cycle de vie"
    );
    assert_eq!(
        readiness_calls, 5,
        "la readiness est redemandée à chaque état, jamais relue"
    );
    assert_eq!(checks, 22, "contrôles exécutés côté production JavaScript");
}

/// Témoin du cycle de reprise.
///
/// Une Action orpheline à contenu d'auteur, donc export bloqué —
/// enrichie de tout ce qu'une reprise doit rendre intact **sans** que la
/// readiness ne l'exige : des contrôles incomplets mais décodables, un membre
/// opaque et sa disposition explicite, une décision de position d'auteur, et le
/// quadrillage projeté rangé dans le contexte. Sans ces valeurs, comparer les
/// contextes après reprise ne prouverait rien à leur sujet.
fn session_recovery_payload() -> String {
    let mut payload = decode_story_document(
        &json!({
            "format":"v1", "version":1,
            "stageNodes":[
                {"uuid":ENTRY, "squareOne":true, "audio":"a1b2c3.mp3", "image":null,
                 "controlSettings":{"wheel":false,"ok":true},
                 "okTransition":{"actionNode":"menu","optionIndex":0}, "homeTransition":null,
                 "cadence":42},
                {"uuid":SECOND, "squareOne":false, "audio":null, "image":null,
                 "controlSettings":{"wheel":false,"ok":true,"home":null,"pause":false,"autoplay":false},
                 "okTransition":null, "homeTransition":null,
                 "position":{"x":120.5,"y":-32769}}
            ],
            "actionNodes":[
                {"id":"menu","options":[SECOND]},
                {"id":"orpheline","name":"Chapitre coupé","options":[SECOND]}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let member = payload
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "cadence")
        .cloned()
        .expect("le membre opaque du témoin est capturé");
    set_opaque_export_disposition(
        &mut payload,
        &member.path,
        &member.key,
        member.source_occurrence,
        OpaqueExportDisposition::PreserveUntested,
    )
    .unwrap();
    set_position_export_disposition(
        &mut payload,
        &format!("/stageNodes/@uuid={SECOND}#0/position"),
        PositionExportDisposition::PreserveRawAcceptDantsuLoss,
    )
    .unwrap();
    payload.context.editor_positions.push(EditorPosition {
        path: format!("/stageNodes/@uuid={ENTRY}#0/position"),
        origin: ValueOrigin::ProjectionDerived,
        position: Position {
            x: Number::from(376_960),
            y: Number::from(160),
        },
    });
    encode_authoring_payload(&payload).unwrap()
}

/// Cycle réel d'autosave, d'interruption, de reprise et de promotion.
///
/// Le script Node acquiert un document créé, l'édite sans lui donner ni titre ni
/// média racine, écrit le snapshot anti-crash de sa session, **abandonne tout
/// état mémoire**, énumère la reprise, rouvre le fichier, installe l'Action
/// orpheline, rejoue l'interruption, puis promeut le projet — une fois avec un transfert en
/// échec, une fois avec un transfert réussi. Rust compte les invocations : une
/// seule acquisition pour tout le cycle, une validation de payload par ouverture
/// réelle et **aucune** pour l'énumération, et une readiness par demande. Il
/// recompose enfin les deux chaînes rendues avec son propre codec.
#[test]
fn production_session_recovery_restores_the_advanced_work_without_reacquiring_identity() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::commands::project_codec::validate_advanced_payload,
            crate::commands::project_codec::create_advanced_document,
            crate::commands::project_codec::assess_advanced_payload_readiness
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let blocked = session_recovery_payload();
    let mut child = Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/sessionRecoveryTransport.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({ "payloadBlocked": blocked })).unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut acquisitions = 0;
    let mut validations = 0;
    let mut readiness_calls = 0;
    let mut checks = 0;
    let mut completed = false;
    for line in output.lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if message["kind"] == "done" {
            let created = message["createdPayload"].as_str().unwrap();
            let recovered = message["recoveredPayload"].as_str().unwrap();
            assert_eq!(
                recovered, created,
                "la reprise rend la chaîne acquise, à l'octet"
            );
            let source = decode_authoring_payload(created).unwrap();
            let reopened = decode_authoring_payload(recovered).unwrap();
            assert_eq!(source.document, reopened.document, "document indépendant");
            assert_eq!(source.context, reopened.context, "contexte indépendant");
            assert_eq!(
                reopened.context.pack_identity.origin,
                PackIdentityOrigin::Generated,
                "l'identité générée survit à l'interruption"
            );
            assert_eq!(
                reopened.context.pack_identity.value, source.context.pack_identity.value,
                "et n'est pas retirée une seconde fois"
            );

            let promoted = message["promotedPayload"].as_str().unwrap();
            assert_eq!(promoted, blocked, "le projet promu porte le travail repris");
            let witness = decode_authoring_payload(&blocked).unwrap();
            let promoted = decode_authoring_payload(promoted).unwrap();
            assert_eq!(witness.document, promoted.document);
            assert_eq!(witness.context, promoted.context);
            assert_eq!(
                promoted.context.editor_positions.len(),
                1,
                "le quadrillage projeté reste dans le contexte après reprise et promotion"
            );
            let member = &promoted.context.opaque_members[0];
            assert_eq!(
                member.export_disposition,
                Some(OpaqueExportDisposition::PreserveUntested),
                "la disposition d'auteur d'un membre opaque survit à la reprise"
            );
            assert!(
                !member.export_disposition_value.is_absent(),
                "l'instantané auquel la disposition s'applique survit avec elle"
            );
            assert_eq!(
                promoted.context.position_export_decisions.len(),
                1,
                "la décision de position d'auteur survit à la reprise"
            );
            assert_eq!(
                promoted.document.stage_nodes[0]
                    .control_settings
                    .value()
                    .unwrap()
                    .home,
                Presence::Absent,
                "des contrôles incomplets restent incomplets, pas complétés par défaut"
            );
            assert_eq!(
                message["blockedAfterRecovery"],
                json!(assess_graph_document_export_readiness(Ok(&witness)).blocked),
                "le blocage rendu après reprise est celui que Rust recompose"
            );
            checks = message["checks"].as_u64().unwrap();
            completed = true;
            break;
        }
        assert_eq!(message["kind"], "invoke");
        match message["cmd"].as_str().unwrap() {
            "create_advanced_document" => acquisitions += 1,
            "validate_advanced_payload" => validations += 1,
            "assess_advanced_payload_readiness" => readiness_calls += 1,
            _ => {}
        }
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: message["cmd"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(message["args"].clone()),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let response = match response {
            Ok(body) => json!({ "result": body.deserialize::<Value>().unwrap() }),
            Err(error) => json!({ "error": error }),
        };
        writeln!(input, "{response}").unwrap();
    }
    assert!(child.wait().unwrap().success());
    assert!(completed);
    assert_eq!(
        acquisitions, 1,
        "ni la reprise ni la promotion ne réacquièrent une identité"
    );
    assert_eq!(
        validations, 3,
        "une validation par ouverture réelle, aucune pour l'énumération des reprises"
    );
    assert_eq!(
        readiness_calls, 3,
        "la readiness est redemandée à chaque état, jamais relue"
    );
    assert_eq!(checks, 29, "contrôles exécutés côté production JavaScript");
}

/// Raccord complet acquisition → liaisons médias → disque.
///
/// Les liaisons ne sont pas fournies par le test : un ZIP STUdio synthétique est
/// acquis par la **commande de production**, acheminée au vrai handler Tauri :
/// le payload et les liaisons sortent ensemble, dérivés du même document.
///
/// Le pack porte trois cas distincts — deux audios aux octets distincts, une
/// image partagée par deux Stages, une référence dont l'archive n'a pas le
/// fichier. Le script Node enchaîne ensuite snapshot de session,
/// interruption, reprise, promotion avec transfert partiel, nettoyage réel de la
/// session, copie sous, consolidation et déplacement du dossier, en confrontant
/// les octets de chaque média à chaque étape.
#[test]
fn production_pack_acquisition_carries_its_media_bindings_through_the_disk_cycle() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let entry = "1A9C2A411D3E4A8B9C772F5B6E10AB34";
    let second = "2B9C2A411D3E4A8B9C772F5B6E10AB34";
    let third = "3C9C2A411D3E4A8B9C772F5B6E10AB34";
    let story = json!({
        "format": "v1", "version": 1, "title": "Pack médias",
        "stageNodes": [
            {"uuid": entry, "squareOne": true,
             "audio": "voix-a.mp3", "image": "commune.png",
             "controlSettings": {"wheel": false, "ok": true, "home": false,
                 "pause": false, "autoplay": false},
             "okTransition": {"actionNode": "menu", "optionIndex": 0},
             "homeTransition": null},
            {"uuid": second,
             "audio": "voix-b.mp3", "image": "commune.png",
             "controlSettings": {"wheel": false, "ok": true, "home": false,
                 "pause": false, "autoplay": false},
             "okTransition": {"actionNode": "menu", "optionIndex": 1},
             "homeTransition": null},
            {"uuid": third,
             "audio": "absent.mp3",
             "controlSettings": {"wheel": false, "ok": true, "home": false,
                 "pause": false, "autoplay": false},
             "okTransition": {"actionNode": "menu", "optionIndex": 2},
             "homeTransition": null}
        ],
        "actionNodes": [{"id": "menu", "options": [entry, second, third]}]
    });

    let fixture = std::env::temp_dir().join(format!(
        "story_studio_advanced_media_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&fixture).unwrap();
    let pack_path = fixture.join("medias.zip");
    {
        let file = std::fs::File::create(&pack_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in [
            ("story.json", serde_json::to_vec(&story).unwrap()),
            ("assets/voix-a.mp3", b"octets de A".to_vec()),
            ("assets/voix-b.mp3", b"octets de B, differents".to_vec()),
            ("assets/commune.png", b"image partagee".to_vec()),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::commands::pack::acquire_advanced_pack_document,
            crate::commands::project_codec::validate_advanced_payload
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let mut child = Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../scripts/advancedAcquisitionTransport.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({ "packPath": pack_path })).unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut acquisitions = 0;
    let mut validations = 0;
    let mut checks = 0;
    let mut completed = false;
    for line in output.lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if message["kind"] == "done" {
            let acquired = message["acquiredPayload"].as_str().unwrap();
            let moved = message["movedPayload"].as_str().unwrap();
            assert_eq!(
                moved, acquired,
                "la chaîne acquise traverse reprise, promotion, copie et déplacement à l'octet"
            );
            let source = decode_authoring_payload(acquired).unwrap();
            assert_eq!(
                source
                    .document
                    .stage_nodes
                    .iter()
                    .filter_map(|stage| stage.audio.value().cloned())
                    .collect::<Vec<_>>(),
                vec!["voix-a.mp3", "voix-b.mp3", "absent.mp3"],
                "les références du dialecte ne sont jamais réécrites en chemins"
            );
            assert_eq!(
                source.context.document_origin,
                DocumentOrigin::ImportedStudio
            );
            checks = message["checks"].as_u64().unwrap();
            completed = true;
            break;
        }
        assert_eq!(message["kind"], "invoke");
        match message["cmd"].as_str().unwrap() {
            "acquire_advanced_pack_document" => acquisitions += 1,
            "validate_advanced_payload" => validations += 1,
            _ => {}
        }
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: message["cmd"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(message["args"].clone()),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        let response = match response {
            Ok(body) => json!({ "result": body.deserialize::<Value>().unwrap() }),
            Err(error) => json!({ "error": error }),
        };
        writeln!(input, "{response}").unwrap();
    }
    let status = child.wait().unwrap();
    std::fs::remove_dir_all(&fixture).ok();
    assert!(status.success());
    assert!(completed);
    assert_eq!(
        acquisitions, 1,
        "le pack n'est acquis qu'une fois pour tout le cycle"
    );
    assert_eq!(
        validations, 4,
        "une validation par ouverture réelle — reprise, projet promu, copie,          dossier déplacé — et aucune pour l'aperçu ni pour la consolidation"
    );
    assert_eq!(checks, 33, "contrôles exécutés côté production JavaScript");
}

/// Oracle indépendant : lecture directe du document décodé après le vrai cycle
/// `.mbah`. Aucun helper de projection, de résolution de chemin ou de présence
/// du module graph_view ne construit les valeurs attendues.
fn assert_reopened_graph_view_matches_document(payload: &str, reopened: &DecodedStoryDocument) {
    let dto = serde_json::to_value(
        crate::native_pack::graph_view::read_advanced_graph_view(payload).unwrap(),
    )
    .unwrap();
    let source = serde_json::to_value(&reopened.document).unwrap();
    let stages = source["stageNodes"].as_array().unwrap();
    let actions = source["actionNodes"].as_array().unwrap();
    assert_eq!(dto["stages"].as_array().unwrap().len(), stages.len());
    assert_eq!(dto["actions"].as_array().unwrap().len(), actions.len());
    let presence = |value: Option<&Value>| match value {
        None => "absent",
        Some(Value::Null) => "null",
        Some(_) => "value",
    };
    let mut expected_edges = Vec::new();
    for (nodes, projected, id_key) in [
        (stages, dto["stages"].as_array().unwrap(), "uuid"),
        (actions, dto["actions"].as_array().unwrap(), "id"),
    ] {
        for node in nodes {
            let actual = projected
                .iter()
                .find(|v| v[id_key] == node[id_key])
                .unwrap();
            assert_eq!(actual["name"]["presence"], presence(node.get("name")));
            assert_eq!(
                actual["name"]["value"],
                node.get("name").unwrap_or(&Value::Null).clone()
            );
            if let Some(position) = node.get("position").filter(|p| !p.is_null()) {
                assert_eq!(actual["layout"]["source"], "authored");
                for axis in ["x", "y"] {
                    assert_eq!(
                        actual["sourcePosition"][format!("{axis}Text")],
                        position[axis].to_string()
                    );
                    assert_eq!(actual["layout"][axis].as_f64(), position[axis].as_f64());
                }
            } else {
                assert!(actual["sourcePosition"].is_null());
            }
            if id_key == "uuid" {
                let controls = node.get("controlSettings");
                assert_eq!(actual["controls"]["presence"], presence(controls));
                for key in ["wheel", "ok", "home", "pause", "autoplay"] {
                    let field = controls.and_then(|c| c.get(key));
                    assert_eq!(actual["controls"][key]["presence"], presence(field));
                    assert_eq!(
                        actual["controls"][key]["value"],
                        field.unwrap_or(&Value::Null).clone()
                    );
                }
                for (field, kind) in [
                    ("okTransition", "stage-ok"),
                    ("homeTransition", "stage-home"),
                ] {
                    let transition = node.get(field);
                    assert_eq!(actual[field]["presence"], presence(transition));
                    if let Some(transition) = transition.filter(|v| !v.is_null()) {
                        assert_eq!(actual[field]["actionId"], transition["actionNode"]);
                        let selection = if transition["optionIndex"] == -1 {
                            json!({"kind":"random"})
                        } else {
                            json!({"kind":"fixed", "index":transition["optionIndex"]})
                        };
                        assert_eq!(actual[field]["selection"], selection);
                        let target = dto["actions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|a| a["id"] == transition["actionNode"])
                            .map(|a| a["path"].clone())
                            .unwrap_or(Value::Null);
                        expected_edges.push(json!([kind, actual["path"], target, Value::Null]));
                    }
                }
            } else {
                let options = node["options"].as_array().unwrap();
                assert_eq!(actual["options"].as_array().unwrap().len(), options.len());
                for (ordinal, target) in options.iter().enumerate() {
                    let option = &actual["options"][ordinal];
                    assert_eq!(option["ordinal"], ordinal);
                    assert_eq!(option["target"]["stageUuid"], *target);
                    assert_eq!(option["target"]["presence"], presence(Some(target)));
                    let target_path = dto["stages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|s| s["uuid"] == *target)
                        .map(|s| s["path"].clone())
                        .unwrap_or(Value::Null);
                    assert_eq!(option["target"]["stagePath"], target_path);
                    expected_edges.push(json!([
                        "action-option",
                        actual["path"],
                        target_path,
                        ordinal
                    ]));
                }
            }
        }
    }
    let mut actual_edges: Vec<_> = dto["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| json!([e["kind"], e["from"], e["to"], e["ordinal"]]))
        .collect();
    expected_edges.sort_by_key(Value::to_string);
    actual_edges.sort_by_key(Value::to_string);
    assert_eq!(
        actual_edges, expected_edges,
        "arêtes et occurrences sans déduplication"
    );
}
