//! Geste 1 — poser, remplacer et retirer une transition OK ou HOME.

use serde_json::json;

use super::*;
use crate::native_pack::{OptionSelection, Presence};

fn set(stage: &str, slot: &str, action: &str, index: i64) -> Value {
    json!({
        "gesture": "set-stage-transition",
        "stageUuid": stage,
        "slot": slot,
        "update": {"form": "set", "actionNode": action, "optionIndex": index}
    })
}

fn clear(stage: &str, slot: &str, form: &str) -> Value {
    json!({
        "gesture": "set-stage-transition",
        "stageUuid": stage,
        "slot": slot,
        "update": {"form": form}
    })
}

#[test]
fn an_ok_transition_is_posted_replaced_and_removed_without_touching_its_control() {
    let payload = payload();
    let controls_before = decode_authoring_payload(&payload)
        .expect("payload de départ")
        .document
        .stage_nodes[1]
        .control_settings;

    // Le Stage cible porte `ok: false`. Poser sa transition OK
    // est légitime et ne doit pas rendre le contrôle vrai.
    let posted = applied(&payload, bindings(), set(TARGET, "ok", "action-1", 0));
    let after = saved_and_reopened(&posted.payload);
    assert_eq!(
        after.document.stage_nodes[1].ok_transition,
        Presence::Value(crate::native_pack::Transition::fixed("action-1", 0))
    );
    assert_eq!(
        after.document.stage_nodes[1].control_settings,
        controls_before
    );
    assert!(!after.document.stage_nodes[1].control_settings.ok());

    // Remplacement par la même arête en `Random`.
    let replaced = applied(
        &posted.payload,
        bindings(),
        set(TARGET, "ok", "action-1", -1),
    );
    let after = saved_and_reopened(&replaced.payload);
    assert_eq!(
        after.document.stage_nodes[1]
            .ok_transition
            .value()
            .map(|transition| transition.selection),
        Some(OptionSelection::Random)
    );
    assert_eq!(
        after.document.stage_nodes[1].control_settings,
        controls_before
    );

    // Le retrait est une commande distincte, et la seule à effacer une arête.
    let removed = applied(&replaced.payload, bindings(), clear(TARGET, "ok", "absent"));
    let after = saved_and_reopened(&removed.payload);
    assert_eq!(
        after.document.stage_nodes[1].ok_transition,
        Presence::Absent
    );
    assert_eq!(
        after.document.stage_nodes[1].control_settings,
        controls_before
    );
}

#[test]
fn random_survives_the_save_round_trip_on_ok_and_on_home() {
    let payload = payload();
    let ok = applied(&payload, bindings(), set(ENTRY, "ok", "action-1", -1));
    let both = applied(&ok.payload, bindings(), set(ENTRY, "home", "action-1", -1));
    let after = saved_and_reopened(&both.payload);

    for transition in [
        after.document.stage_nodes[0].ok_transition.value(),
        after.document.stage_nodes[0].home_transition.value(),
    ] {
        assert_eq!(
            transition.map(|transition| transition.selection),
            Some(OptionSelection::Random)
        );
    }
    // `Random` se réécrit exactement `-1`, jamais rabattu vers 0.
    let emitted: Value = serde_json::from_str(&both.payload).expect("payload JSON");
    assert_eq!(
        emitted["document"]["stageNodes"][0]["okTransition"]["optionIndex"],
        json!(-1)
    );
    assert_eq!(
        emitted["document"]["stageNodes"][0]["homeTransition"]["optionIndex"],
        json!(-1)
    );
}

#[test]
fn removing_a_transition_keeps_absent_and_null_distinct() {
    let payload = payload();
    let nulled = applied(&payload, bindings(), clear(ENTRY, "ok", "null"));
    let after = saved_and_reopened(&nulled.payload);
    assert_eq!(after.document.stage_nodes[0].ok_transition, Presence::Null);
    let emitted: Value = serde_json::from_str(&nulled.payload).expect("payload JSON");
    assert!(emitted["document"]["stageNodes"][0]
        .as_object()
        .expect("Stage objet")
        .contains_key("okTransition"));

    let absent = applied(&payload, bindings(), clear(ENTRY, "ok", "absent"));
    let after = saved_and_reopened(&absent.payload);
    assert_eq!(
        after.document.stage_nodes[0].ok_transition,
        Presence::Absent
    );
    let emitted: Value = serde_json::from_str(&absent.payload).expect("payload JSON");
    assert!(!emitted["document"]["stageNodes"][0]
        .as_object()
        .expect("Stage objet")
        .contains_key("okTransition"));
}

#[test]
fn an_incomplete_transition_object_is_not_even_representable() {
    // Une transition est un objet complet ou rien. Le membre manquant n'est pas
    // complété par un défaut, il rend la demande illisible.
    for incomplete in [
        json!({"form": "set", "actionNode": "action-1"}),
        json!({"form": "set", "optionIndex": 0}),
    ] {
        let request = json!({
            "gesture": "set-stage-transition",
            "stageUuid": ENTRY,
            "slot": "ok",
            "update": incomplete
        });
        assert!(
            serde_json::from_value::<AdvancedGesture>(request).is_err(),
            "aucun défaut implicite ne complète une transition partielle"
        );
    }
}

#[test]
fn an_option_index_below_minus_one_is_refused_as_out_of_dialect() {
    let payload = payload();
    let error = refused(&payload, bindings(), set(ENTRY, "ok", "action-1", -2));
    assert_eq!(error.code, "OPTION_INDEX_OUT_OF_DIALECT");
    assert!(error.path.ends_with("/okTransition/optionIndex"));
}

#[test]
fn an_unknown_target_and_an_out_of_bounds_selection_are_refused() {
    let payload = payload();

    let error = refused(&payload, bindings(), set(ENTRY, "ok", "action-inconnue", 0));
    assert_eq!(error.code, "UNKNOWN_ACTION");

    // L'ActionNode porte une seule option.
    let error = refused(&payload, bindings(), set(ENTRY, "ok", "action-1", 1));
    assert_eq!(error.code, "OPTION_SELECTION_OUT_OF_BOUNDS");

    let error = refused(
        &payload,
        bindings(),
        set("stage-inconnu", "ok", "action-1", 0),
    );
    assert_eq!(error.code, "UNKNOWN_NODE");
}

#[test]
fn random_on_an_action_without_option_is_refused_instead_of_being_posted() {
    // `Random` vers une Action sans option est `INVALID`. Le geste refuse
    // plutôt que de fabriquer une erreur bloquante d'intégrité.
    let mut source = source_document();
    source["actionNodes"] = json!([{"id": "action-1", "options": []}]);
    source["stageNodes"][0]["okTransition"] = Value::Null;
    let payload = payload_from(&source);
    let error = refused(&payload, bindings(), set(ENTRY, "ok", "action-1", -1));
    assert_eq!(error.code, "OPTION_SELECTION_OUT_OF_BOUNDS");
}

#[test]
fn an_empty_action_can_be_connected_from_a_stage_and_gets_a_pending_first_option() {
    let mut source = source_document();
    source["actionNodes"] = json!([{"id": "action-1", "options": []}]);
    source["stageNodes"][0]["okTransition"] = Value::Null;
    let payload = payload_from(&source);

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "connect-stage-to-empty-action",
            "stageUuid": ENTRY,
            "slot": "ok",
            "actionNode": "action-1"
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|action| action.id == "action-1")
        .expect("Action raccordée");
    assert_eq!(action.options, vec![None]);
    assert_eq!(
        after.document.stage_nodes[0]
            .ok_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some("action-1")
    );
    assert_eq!(
        after.document.stage_nodes[0]
            .ok_transition
            .value()
            .map(|transition| transition.selection),
        Some(OptionSelection::Fixed(0))
    );
}

/// Les cinq touches d'un Stage, dans l'ordre de `controls(...)`.
fn keys(stage: &crate::native_pack::StageNode) -> [bool; 5] {
    let controls = &stage.control_settings;
    [
        controls.wheel(),
        controls.ok(),
        controls.home(),
        controls.pause(),
        controls.autoplay(),
    ]
}

fn set_activating(stage: &str, slot: &str, action: &str) -> Value {
    let mut request = set(stage, slot, action, 0);
    request["activateControl"] = json!(true);
    request
}

#[test]
fn a_link_drawn_from_the_ok_port_turns_ok_on_and_nothing_else() {
    // Le Stage cible porte ses cinq touches éteintes : sans OK ni lecture
    // automatique, sa sortie OK ne se jouerait pas.
    let outcome = applied(
        &payload(),
        bindings(),
        set_activating(TARGET, "ok", "action-1"),
    );
    let after = saved_and_reopened(&outcome.payload);
    let stage = &after.document.stage_nodes[1];
    assert_eq!(keys(stage), [false, true, false, false, false]);
    assert_eq!(
        stage.ok_transition,
        Presence::Value(crate::native_pack::Transition::fixed("action-1", 0))
    );
}

#[test]
fn a_link_drawn_from_the_home_port_turns_home_on_and_nothing_else() {
    let outcome = applied(
        &payload(),
        bindings(),
        set_activating(TARGET, "home", "action-1"),
    );
    let after = saved_and_reopened(&outcome.payload);
    let stage = &after.document.stage_nodes[1];
    assert_eq!(keys(stage), [false, false, true, false, false]);
    assert_eq!(
        stage.home_transition,
        Presence::Value(crate::native_pack::Transition::fixed("action-1", 0))
    );
}

#[test]
fn a_link_to_an_empty_action_turns_on_the_key_of_its_port() {
    let mut source = source_document();
    source["actionNodes"] = json!([{"id": "action-1", "options": []}]);
    source["stageNodes"][0]["okTransition"] = Value::Null;
    let payload = payload_from(&source);

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "connect-stage-to-empty-action",
            "stageUuid": TARGET,
            "slot": "ok",
            "actionNode": "action-1",
            "activateControl": true
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(
        keys(&after.document.stage_nodes[1]),
        [false, true, false, false, false]
    );
}

#[test]
fn a_stage_without_a_controls_object_refuses_the_activation_and_publishes_nothing() {
    // Allumer une touche isolée sur un objet absent inventerait
    // les quatre autres. Le raccord est refusé en entier, lien compris.
    let mut source = source_document();
    source["stageNodes"][1]
        .as_object_mut()
        .expect("Stage cible")
        .remove("controlSettings");
    let payload = payload_from(&source);

    let error = refused(
        &payload,
        bindings(),
        set_activating(TARGET, "ok", "action-1"),
    );
    assert_eq!(error.code, "CONTROL_SETTINGS_ABSENT");
}
