//! Gestes de position.
//!
//! La fixture porte une position source hors `short` sur l'entrée, assortie de
//! la disposition `preserve-raw-accept-dantsu-loss` que `garnish_context` a
//! posée, et une position d'éditeur `projection-derived` sur `action-1`. Les
//! trois rangs de position sont donc réellement peuplés.

use serde_json::json;

use super::*;
use crate::native_pack::authoring::value_origin;

fn stage_node(uuid: &str) -> Value {
    json!({"kind": "stage", "id": uuid})
}

fn action_node(id: &str) -> Value {
    json!({"kind": "action", "id": id})
}

fn position_of(payload: &DecodedStoryDocument, index: usize) -> Option<(f64, f64)> {
    payload.document.stage_nodes[index]
        .position
        .value()
        .map(|position| {
            (
                position.x.as_f64().expect("x fini"),
                position.y.as_f64().expect("y fini"),
            )
        })
}

#[test]
fn a_manual_move_becomes_authored_and_makes_its_old_disposition_stale() {
    let payload = payload();
    let entry = format!("/stageNodes/@uuid={ENTRY}#0/position");
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert_eq!(before.context.position_export_decisions.len(), 1);

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-position",
            "node": stage_node(ENTRY),
            "position": {"x": 18.25, "y": -40}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Aucune fraction n'est arrondie.
    assert_eq!(position_of(&after, 0), Some((18.25, -40.0)));
    // Règle 3 : la valeur devient authored.
    assert_eq!(value_origin(&after, &entry), ValueOrigin::Authored);
    assert_eq!(outcome.report.positions.authored, vec![entry.clone()]);
    // La décision reste stockée comme trace, mais ne décrit plus la valeur :
    // elle est périmée, et le rapport le dit au lieu de l'effacer en silence.
    assert_eq!(
        outcome.report.positions.stale_decisions,
        vec![entry.clone()]
    );
    assert_eq!(after.context.position_export_decisions.len(), 1);
    assert_ne!(
        after.context.position_export_decisions[0].position,
        after.document.stage_nodes[0]
            .position
            .value()
            .cloned()
            .expect("position déplacée")
    );

    // Les autres nœuds et le reste du contexte n'ont pas bougé.
    assert_eq!(
        before.document.stage_nodes[1],
        after.document.stage_nodes[1]
    );
    assert_eq!(before.context.opaque_members, after.context.opaque_members);
}

#[test]
fn an_unknown_node_is_refused_and_a_large_coordinate_keeps_its_graphie() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-position",
            "node": stage_node("aucun-stage"),
            "position": {"x": 1, "y": 2}
        }),
    );
    assert_eq!(error.code, "UNKNOWN_NODE");

    // Un entier reste un entier : le geste transporte le `Number` du dialecte
    // et n'impose pas la graphie décimale d'un `f64` à une valeur entière.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-position",
            "node": stage_node(TARGET),
            "position": {"x": 240, "y": -96}
        }),
    );
    assert!(outcome.payload.contains("\"x\":240"));
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(position_of(&after, 1), Some((240.0, -96.0)));
}

#[test]
fn a_group_move_is_one_transaction_and_is_refused_whole() {
    let payload = payload();
    let entry = format!("/stageNodes/@uuid={ENTRY}#0/position");
    let target = format!("/stageNodes/@uuid={TARGET}#0/position");

    // Un glisser de sélection : chaque nœud reçoit ce qu'un glisser seul lui
    // aurait donné, dans un seul geste.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-positions",
            "positions": [
                {"node": stage_node(ENTRY), "position": {"x": 10, "y": 20}},
                {"node": stage_node(TARGET), "position": {"x": 250.5, "y": -60}}
            ]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(position_of(&after, 0), Some((10.0, 20.0)));
    assert_eq!(position_of(&after, 1), Some((250.5, -60.0)));
    assert_eq!(value_origin(&after, &entry), ValueOrigin::Authored);
    assert_eq!(value_origin(&after, &target), ValueOrigin::Authored);
    assert_eq!(
        outcome.report.positions.authored,
        vec![entry.clone(), target.clone()]
    );
    // Comme un glisser seul, le déplacement périme la décision d'export.
    assert_eq!(outcome.report.positions.stale_decisions, vec![entry]);

    // Un nœud nommé deux fois, ou un nœud inconnu, refuse la demande entière :
    // le groupe n'est jamais à moitié déplacé.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-positions",
            "positions": [
                {"node": stage_node(TARGET), "position": {"x": 1, "y": 1}},
                {"node": stage_node(TARGET), "position": {"x": 2, "y": 2}}
            ]
        }),
    );
    assert_eq!(error.code, "DUPLICATE_LAYOUT_ENTRY");
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-authored-positions",
            "positions": [
                {"node": stage_node(TARGET), "position": {"x": 1, "y": 1}},
                {"node": stage_node("aucun-stage"), "position": {"x": 2, "y": 2}}
            ]
        }),
    );
    assert_eq!(error.code, "UNKNOWN_NODE");
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "set-authored-positions", "positions": []}),
    );
    assert_eq!(error.code, "EMPTY_LAYOUT");
}

#[test]
fn a_kept_view_layout_stays_out_of_the_document_and_belongs_to_the_context() {
    let payload = payload();
    let action = "/actionNodes/@id=action-1#0/position".to_string();
    let target = format!("/stageNodes/@uuid={TARGET}#0/position");
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "apply-view-layout",
            "positions": [
                {"node": stage_node(TARGET), "position": {"x": 240, "y": 96}},
                {"node": action_node("action-1"), "position": {"x": 120, "y": 0}}
            ]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // La disposition reste état d'éditeur.
    assert!(after.document.stage_nodes[1].position.is_absent());
    assert_eq!(
        outcome.report.positions.editor,
        vec![target.clone(), action.clone()]
    );
    assert!(outcome.report.positions.authored.is_empty());
    let kept: Vec<(&str, ValueOrigin)> = after
        .context
        .editor_positions
        .iter()
        .map(|entry| (entry.path.as_str(), entry.origin))
        .collect();
    assert_eq!(
        kept,
        vec![
            (target.as_str(), ValueOrigin::ProjectionDerived),
            (action.as_str(), ValueOrigin::ProjectionDerived),
        ],
        "chaque chemin n'a qu'une entrée : l'ancienne est remplacée, pas doublée"
    );

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "apply-view-layout", "positions": []}),
    );
    assert_eq!(error.code, "EMPTY_LAYOUT");

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "apply-view-layout",
            "positions": [
                {"node": stage_node(TARGET), "position": {"x": 1, "y": 1}},
                {"node": stage_node(TARGET), "position": {"x": 2, "y": 2}}
            ]
        }),
    );
    assert_eq!(error.code, "DUPLICATE_LAYOUT_ENTRY");
}

#[test]
fn promoting_a_layout_needs_the_editor_entry_and_the_single_authoring_door() {
    let payload = payload();
    let action = "/actionNodes/@id=action-1#0/position".to_string();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "apply-layout-to-authoring",
            "nodes": [action_node("action-1")],
            "outOfRange": "refuse"
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // La position quitte le contexte et devient une donnée d'auteur.
    assert!(after.context.editor_positions.is_empty());
    assert_eq!(
        after.document.action_nodes[0]
            .position
            .value()
            .map(|position| position.x.as_f64().expect("x fini")),
        Some(4.0)
    );
    assert_eq!(value_origin(&after, &action), ValueOrigin::Authored);
    assert_eq!(outcome.report.positions.authored, vec![action]);

    // Un nœud sans position d'éditeur n'a rien à promouvoir.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "apply-layout-to-authoring",
            "nodes": [stage_node(TARGET)],
            "outOfRange": "refuse"
        }),
    );
    assert_eq!(error.code, "NO_EDITOR_POSITION");
}

#[test]
fn a_layout_that_would_leave_the_short_range_is_scaled_omitted_or_refused() {
    let payload = payload();
    let kept = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "apply-view-layout",
            "positions": [
                {"node": stage_node(TARGET), "position": {"x": 65536, "y": 100}},
                {"node": action_node("action-1"), "position": {"x": 100, "y": 50}}
            ]
        }),
    );
    let target = format!("/stageNodes/@uuid={TARGET}#0/position");

    // Refus : l'inventaire nomme les nœuds hors borne, rien n'est promu.
    let error = refused(
        &kept.payload,
        bindings(),
        json!({"gesture": "apply-layout-to-authoring", "outOfRange": "refuse"}),
    );
    assert_eq!(error.code, "POSITION_OUT_OF_SHORT_RANGE");
    assert_eq!(error.references, vec![target.clone()]);

    // Omission : les nœuds hors borne restent locaux, les autres sont promus.
    let omitted = applied(
        &kept.payload,
        bindings(),
        json!({"gesture": "apply-layout-to-authoring", "outOfRange": "omit"}),
    );
    let after = saved_and_reopened(&omitted.payload);
    assert_eq!(omitted.report.positions.omitted, vec![target.clone()]);
    assert!(after.document.stage_nodes[1].position.is_absent());
    assert!(after.document.action_nodes[0].position.is_value());
    assert_eq!(
        after
            .context
            .editor_positions
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec![target.as_str()]
    );

    // Mise à l'échelle : un facteur unique pour tout l'ensemble, donc la
    // disposition relative est conservée et plus rien ne sort de la borne.
    let scaled = applied(
        &kept.payload,
        bindings(),
        json!({"gesture": "apply-layout-to-authoring", "outOfRange": "scale"}),
    );
    let after = saved_and_reopened(&scaled.payload);
    assert_eq!(scaled.report.positions.scaled.len(), 2);
    let stage_x = after.document.stage_nodes[1]
        .position
        .value()
        .expect("position promue")
        .x
        .as_f64()
        .expect("x fini");
    let action_x = after.document.action_nodes[0]
        .position
        .value()
        .expect("position promue")
        .x
        .as_f64()
        .expect("x fini");
    assert!((stage_x - 32767.0).abs() < 1e-6);
    assert!((action_x - 32767.0 * 100.0 / 65536.0).abs() < 1e-6);
    assert!(after.context.editor_positions.is_empty());
}
