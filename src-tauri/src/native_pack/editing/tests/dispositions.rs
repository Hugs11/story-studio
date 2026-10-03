//! Décisions d'export : extensions, positions hors borne et flatten.

use serde_json::json;

use super::*;
use crate::native_pack::authoring::{diagnose_enriched_metadata, AuthoringDiagnosticLevel};

fn opaque_member(path: &str, key: &str) -> Value {
    json!({"path": path, "key": key, "sourceOccurrence": 0})
}

fn action_required(payload: &DecodedStoryDocument, code: &str) -> bool {
    diagnose_enriched_metadata(payload)
        .iter()
        .any(|diagnostic| {
            diagnostic.code == code && diagnostic.level == AuthoringDiagnosticLevel::ActionRequired
        })
}

#[test]
fn a_position_disposition_is_attached_to_the_exact_value_it_resolves() {
    // La fixture porte déjà `preserve-raw-accept-dantsu-loss` sur l'entrée, dont
    // la position source `y = 40000` est hors `short`. Le geste la remplace.
    let payload = payload();
    let entry = format!("/stageNodes/@uuid={ENTRY}#0/position");
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-position-export-disposition",
            "node": {"kind": "stage", "id": ENTRY},
            "disposition": "scale-to-short-range"
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(after.context.position_export_decisions.len(), 1);
    let decision = &after.context.position_export_decisions[0];
    assert_eq!(decision.path, entry);
    assert_eq!(
        decision.disposition,
        PositionExportDisposition::ScaleToShortRange
    );
    assert_eq!(decision.origin, ValueOrigin::SourceStudio);

    // La perte d'affichage dans STUdio n'est pas offerte pour une valeur
    // que Story Studio vient de créer. Le déplacement rend la position authored,
    // et la disposition correspondante devient alors un refus.
    let moved = applied(
        &outcome.payload,
        bindings(),
        json!({
            "gesture": "set-authored-position",
            "node": {"kind": "stage", "id": ENTRY},
            "position": {"x": 10, "y": 40000}
        }),
    );
    let error = refused(
        &moved.payload,
        bindings(),
        json!({
            "gesture": "set-position-export-disposition",
            "node": {"kind": "stage", "id": ENTRY},
            "disposition": "preserve-raw-accept-dantsu-loss"
        }),
    );
    assert_eq!(error.code, "POSITION_DISPOSITION_REFUSED");

    // Une position dans la borne n'a aucune disposition à recevoir.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-position-export-disposition",
            "node": {"kind": "stage", "id": TARGET},
            "disposition": "omit-explicitly"
        }),
    );
    assert_eq!(error.code, "POSITION_DISPOSITION_REFUSED");
}

#[test]
fn an_extension_disposition_is_explicit_and_the_unknown_one_is_never_invented() {
    let mut source = source_document();
    source["stageNodes"][1]["duration"] = json!(42000);
    let payload = payload_from(&source);
    let target = format!("/stageNodes/@uuid={TARGET}#0");

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-opaque-export-disposition",
            "member": opaque_member(&target, "duration"),
            "disposition": "remove-explicitly"
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    let member = after
        .context
        .opaque_members
        .iter()
        .find(|member| member.key == "duration")
        .expect("extension conservée");
    assert_eq!(
        member.export_disposition,
        Some(OpaqueExportDisposition::RemoveExplicitly)
    );
    // La valeur et sa provenance sont figées avec la décision : une édition
    // ultérieure la rendra périmée sans qu'un appelant ait à y penser.
    assert!(member.export_disposition_value.matches_json(&json!(42000)));
    assert_eq!(member.export_disposition_origin, Some(member.origin));

    // La règle sur les clés connues jamais émises reste prioritaire : une telle
    // clé ne peut pas être promue en sortie standard.
    let mut root = source_document();
    root["image"] = json!("couverture.png");
    let error = refused(
        &payload_from(&root),
        bindings(),
        json!({
            "gesture": "set-opaque-export-disposition",
            "member": opaque_member("/", "image"),
            "disposition": "preserve-untested"
        }),
    );
    assert_eq!(error.code, "OPAQUE_DISPOSITION_REFUSED");

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-opaque-export-disposition",
            "member": opaque_member(&target, "absente"),
            "disposition": "preserve-untested"
        }),
    );
    assert_eq!(error.code, "OPAQUE_DISPOSITION_REFUSED");
}

#[test]
fn flattening_is_explicit_reserved_to_known_groups_and_never_a_side_effect() {
    // Un groupe « histoire » connu : un Stage typé et son Action, même `groupId`.
    let mut source = source_document();
    source["stageNodes"][1]["groupId"] = json!("g-1");
    source["stageNodes"][1]["type"] = json!("story");
    source["actionNodes"][0]["groupId"] = json!("g-1");
    source["actionNodes"][0]["type"] = json!("story.storyaction");
    let payload = payload_from(&source);
    let before = decode_authoring_payload(&payload).expect("payload de départ");

    // Un autre geste ne retire jamais les marqueurs.
    let untouched = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-controls",
            "stageUuid": TARGET,
            "update": {"form": "members", "members": {"ok": {"form": "set", "value": true}}}
        }),
    );
    let after = saved_and_reopened(&untouched.payload);
    assert_eq!(
        after.document.stage_nodes[1].group_id,
        before.document.stage_nodes[1].group_id
    );
    assert_eq!(
        after.document.action_nodes[0].action_type,
        before.document.action_nodes[0].action_type
    );

    // Le flatten explicite retire les marqueurs visés, conserve
    // les options, les transitions et les médias.
    let outcome = applied(
        &payload,
        bindings(),
        json!({"gesture": "flatten-known-group", "groupId": "g-1"}),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(after.document.stage_nodes[1].group_id.is_absent());
    assert_eq!(
        after.document.stage_nodes[1].stage_type,
        Presence::Value("stage".to_string())
    );
    assert!(after.document.action_nodes[0].group_id.is_absent());
    assert!(after.document.action_nodes[0].action_type.is_absent());
    assert_eq!(
        after.document.action_nodes[0].options,
        before.document.action_nodes[0].options
    );
    assert_eq!(
        after.document.stage_nodes[1].audio,
        before.document.stage_nodes[1].audio
    );
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    assert!(!action_required(&after, "ENRICHED_GROUP_INCOHERENT"));

    // Une forme inconnue n'est pas aplatie sur une sémantique
    // devinée ; elle est refusée, et ses marqueurs restent.
    let mut unknown = source_document();
    unknown["stageNodes"][1]["groupId"] = json!("g-2");
    unknown["stageNodes"][1]["type"] = json!("vendor-carousel");
    let unknown_payload = payload_from(&unknown);
    let error = refused(
        &unknown_payload,
        bindings(),
        json!({"gesture": "flatten-known-group", "groupId": "g-2"}),
    );
    assert_eq!(error.code, "GROUP_FLATTEN_REFUSED");

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "flatten-known-group", "groupId": "g-absent"}),
    );
    assert_eq!(error.code, "GROUP_FLATTEN_REFUSED");
}
