//! Gestes d'options : insertion, retargeting, réordonnancement et retrait.
//!
//! La fixture porte délibérément **deux occurrences visant le même Stage** et
//! une Action partagée par deux Écrans : ce sont les deux formes qu'une
//! implémentation naïve détruit, l'une par déduplication, l'autre en ne
//! maintenant que la transition que l'auteur regardait.

use serde_json::json;

use super::*;

pub(super) const THIRD: &str = "3c8d9e0f-1122-4334-8556-778899aabbcc";
pub(super) const FOURTH: &str = "4d9e0f11-2233-4445-8667-8899aabbccdd";

fn extra_stage(uuid: &str, name: &str) -> Value {
    json!({
        "uuid": uuid,
        "name": name,
        "squareOne": false,
        "controlSettings": controls(false, false, false, false, false)
    })
}

/// Une roue de quatre occurrences dont deux visent `TARGET`, une Action
/// partagée par les deux Écrans, un `Random` sur HOME et un `Fixed` sur OK.
pub(super) fn wheel_document() -> Value {
    let mut document = source_document();
    let stages = document["stageNodes"].as_array_mut().expect("stageNodes");
    stages.push(extra_stage(THIRD, "Clairière"));
    stages.push(extra_stage(FOURTH, "Rivière"));
    document["actionNodes"][0]["options"] = json!([TARGET, THIRD, TARGET, FOURTH]);
    // HOME porte une transition alors que le contrôle est à `false`. Le motif
    // est mesuré dans le corpus et doit rester livrable.
    document["stageNodes"][0]["okTransition"] = json!({"actionNode": "action-1", "optionIndex": 1});
    document["stageNodes"][0]["homeTransition"] =
        json!({"actionNode": "action-1", "optionIndex": -1});
    document["stageNodes"][1]["okTransition"] = json!({"actionNode": "action-1", "optionIndex": 3});
    document
}

pub(super) fn wheel_payload() -> String {
    payload_from(&wheel_document())
}

fn targets(payload: &DecodedStoryDocument) -> Vec<Option<String>> {
    payload.document.action_nodes[0].options.clone()
}

fn selection(payload: &DecodedStoryDocument, stage: usize, home: bool) -> Option<i64> {
    let node = &payload.document.stage_nodes[stage];
    let transition = if home {
        &node.home_transition
    } else {
        &node.ok_transition
    };
    transition
        .value()
        .map(|transition| transition.selection.to_dialect_index())
}

#[test]
fn an_insertion_shifts_every_fixed_selection_at_or_after_it_and_leaves_random_alone() {
    let payload = wheel_payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "insert-action-option",
            "actionId": "action-1",
            "index": 1,
            "target": {"target": "stage", "uuid": FOURTH}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        targets(&after),
        vec![
            Some(TARGET.to_string()),
            Some(FOURTH.to_string()),
            Some(THIRD.to_string()),
            Some(TARGET.to_string()),
            Some(FOURTH.to_string()),
        ]
    );
    // `Fixed(1)` visait `THIRD`, il le vise encore en `2` ; `Fixed(3)` visait
    // `FOURTH`, il le vise encore en `4` ; `Random` reste `-1` et son ensemble
    // de candidats s'élargit — c'est l'effet attendu.
    assert_eq!(selection(&after, 0, false), Some(2));
    assert_eq!(selection(&after, 0, true), Some(-1));
    assert_eq!(selection(&after, 1, false), Some(4));
    assert_eq!(
        outcome
            .report
            .references
            .selections
            .iter()
            .map(|effect| (
                effect.path.as_str(),
                effect.before,
                effect.after,
                effect.decided
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                format!("/stageNodes/@uuid={ENTRY}#0/okTransition").as_str(),
                1,
                Some(2),
                false
            ),
            (
                format!("/stageNodes/@uuid={TARGET}#0/okTransition").as_str(),
                3,
                Some(4),
                false
            ),
        ]
    );
}

#[test]
fn an_insertion_at_the_end_moves_nothing_and_a_rank_beyond_the_end_is_refused() {
    let payload = wheel_payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "insert-action-option",
            "actionId": "action-1",
            "index": 4,
            "target": {"target": "null"}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(after.document.action_nodes[0].options.len(), 5);
    assert_eq!(after.document.action_nodes[0].options[4], None);
    assert_eq!(selection(&after, 0, false), Some(1));
    assert_eq!(selection(&after, 1, false), Some(3));
    assert!(outcome.report.references.selections.is_empty());

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "insert-action-option",
            "actionId": "action-1",
            "index": 5,
            "target": {"target": "null"}
        }),
    );
    assert_eq!(error.code, "OPTION_ORDINAL_OUT_OF_RANGE");
}

#[test]
fn a_reorder_keeps_every_selected_destination_and_never_merges_two_occurrences() {
    let payload = wheel_payload();
    // La roue [TARGET, THIRD, TARGET, FOURTH] devient [FOURTH, TARGET, THIRD, TARGET].
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "reorder-action-options",
            "actionId": "action-1",
            "newPositionOfOld": [1, 2, 3, 0]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        targets(&after),
        vec![
            Some(FOURTH.to_string()),
            Some(TARGET.to_string()),
            Some(THIRD.to_string()),
            Some(TARGET.to_string()),
        ]
    );
    // La destination sélectionnée est conservée, pas l'indice.
    assert_eq!(selection(&after, 0, false), Some(2));
    assert_eq!(selection(&after, 1, false), Some(0));
    assert_eq!(selection(&after, 0, true), Some(-1));
    // Les deux occurrences de `TARGET` restent deux rangs distincts.
    assert_eq!(
        after.document.action_nodes[0]
            .options
            .iter()
            .filter(|option| option.as_deref() == Some(TARGET))
            .count(),
        2
    );
    assert_eq!(outcome.report.references.options.len(), 4);
}

#[test]
fn a_permutation_that_is_not_one_is_refused_without_touching_the_wheel() {
    let payload = wheel_payload();
    for wrong in [json!([0, 1, 2]), json!([0, 0, 2, 3]), json!([0, 1, 2, 4])] {
        let error = refused(
            &payload,
            bindings(),
            json!({
                "gesture": "reorder-action-options",
                "actionId": "action-1",
                "newPositionOfOld": wrong
            }),
        );
        assert_eq!(error.code, "INVALID_OPTION_PERMUTATION");
    }
    // Le payload de départ n'a pas bougé : un refus ne rend aucun payload.
    assert_eq!(
        decode_authoring_payload(&payload)
            .expect("payload intact")
            .document,
        decoded(&wheel_document()).document
    );
}

#[test]
fn a_removal_moves_the_ranks_after_it_and_leaves_the_ranks_before_it_alone() {
    let payload = wheel_payload();
    // Rang retiré : 1 (`THIRD`). `Fixed(3)` doit devenir `Fixed(2)`.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 1,
            "selections": [{
                "stageUuid": ENTRY,
                "slot": "ok",
                "resolution": {"form": "select", "optionIndex": 0}
            }]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        targets(&after),
        vec![
            Some(TARGET.to_string()),
            Some(TARGET.to_string()),
            Some(FOURTH.to_string()),
        ]
    );
    // `Fixed(3)` → `Fixed(2)` : même destination `FOURTH`, maintenue sans
    // décision. `Random` reste `Random`, il reste des candidats.
    assert_eq!(selection(&after, 1, false), Some(2));
    assert_eq!(selection(&after, 0, true), Some(-1));
    // `Fixed(1)` visait exactement le rang retiré : l'auteur a tranché.
    assert_eq!(selection(&after, 0, false), Some(0));
    let decided: Vec<bool> = outcome
        .report
        .references
        .selections
        .iter()
        .map(|effect| effect.decided)
        .collect();
    assert_eq!(decided, vec![false, true]);
}

#[test]
fn the_selection_of_the_removed_rank_never_slides_onto_its_neighbour() {
    let payload = wheel_payload();
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 1
        }),
    );
    assert_eq!(error.code, "OPTION_SELECTION_DECISION_REQUIRED");
    assert_eq!(
        error.references,
        vec![format!("/stageNodes/@uuid={ENTRY}#0/okTransition")]
    );

    // Une décision qui ne tranche rien est refusée : l'accepter laisserait
    // croire à l'auteur qu'il a décidé de quelque chose.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 0,
            "selections": [{
                "stageUuid": TARGET,
                "slot": "ok",
                "resolution": {"form": "null"}
            }]
        }),
    );
    assert_eq!(error.code, "UNEXPECTED_SELECTION_DECISION");

    // Une décision hors bornes est refusée **avant** que la roue soit amputée.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 1,
            "selections": [{
                "stageUuid": ENTRY,
                "slot": "ok",
                "resolution": {"form": "select", "optionIndex": 3}
            }]
        }),
    );
    assert_eq!(error.code, "OPTION_SELECTION_OUT_OF_BOUNDS");
}

#[test]
fn emptying_a_wheel_forces_the_random_transitions_to_be_decided_too() {
    let mut source = wheel_document();
    source["actionNodes"][0]["options"] = json!([TARGET]);
    source["stageNodes"][0]["okTransition"] = json!({"actionNode": "action-1", "optionIndex": -1});
    source["stageNodes"][0]["homeTransition"] =
        json!({"actionNode": "action-1", "optionIndex": -1});
    source["stageNodes"][1]["okTransition"] = Value::Null;
    let payload = payload_from(&source);

    // `Random` reste `Random` **tant qu'une option subsiste**.
    // Le retrait de la dernière n'en laisse aucune : les deux transitions
    // aléatoires deviennent des décisions.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 0
        }),
    );
    assert_eq!(error.code, "OPTION_SELECTION_DECISION_REQUIRED");
    assert_eq!(
        error.references,
        vec![
            format!("/stageNodes/@uuid={ENTRY}#0/okTransition"),
            format!("/stageNodes/@uuid={ENTRY}#0/homeTransition"),
        ]
    );

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 0,
            "selections": [
                {"stageUuid": ENTRY, "slot": "ok", "resolution": {"form": "null"}},
                {"stageUuid": ENTRY, "slot": "home", "resolution": {"form": "absent"}}
            ]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(after.document.action_nodes[0].options.is_empty());
    // Le retrait porte sa forme, il ne choisit pas entre les deux.
    assert_eq!(after.document.stage_nodes[0].ok_transition, Presence::Null);
    assert_eq!(
        after.document.stage_nodes[0].home_transition,
        Presence::Absent
    );
    // L'Action vidée survit comme état d'auteur intermédiaire.
    assert_eq!(after.document.action_nodes.len(), 1);
}

#[test]
fn retargeting_one_occurrence_leaves_its_twin_and_every_selection_untouched() {
    let payload = wheel_payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-action-option-target",
            "actionId": "action-1",
            "ordinal": 2,
            "target": {"target": "stage", "uuid": FOURTH}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        targets(&after),
        vec![
            Some(TARGET.to_string()),
            Some(THIRD.to_string()),
            Some(FOURTH.to_string()),
            Some(FOURTH.to_string()),
        ]
    );
    // Le rang ne bouge pas : aucune sélection n'a à être maintenue.
    assert_eq!(selection(&after, 0, false), Some(1));
    assert_eq!(selection(&after, 1, false), Some(3));
    assert_eq!(selection(&after, 0, true), Some(-1));
    assert!(outcome.report.references.selections.is_empty());
    assert_eq!(
        outcome.report.references.options[0].before.as_deref(),
        Some(TARGET)
    );

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-action-option-target",
            "actionId": "action-1",
            "ordinal": 2,
            "target": {"target": "stage", "uuid": "aucun-stage"}
        }),
    );
    assert_eq!(error.code, "UNKNOWN_STAGE");

    // `created-stage` n'a aucun sens hors d'une création : il est refusé plutôt
    // qu'interprété.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-action-option-target",
            "actionId": "action-1",
            "ordinal": 2,
            "target": {"target": "created-stage"}
        }),
    );
    assert_eq!(error.code, "NO_CREATED_STAGE");
}

#[test]
fn a_hundred_and_one_options_are_untested_but_never_refused() {
    // Aucune borne maximale n'est imposée. 100 est mesuré, 101 est `UNTESTED` —
    // donc livrable, et surtout pas rejeté.
    let mut source = wheel_document();
    source["actionNodes"][0]["options"] = Value::Array(vec![json!(TARGET); 100]);
    source["stageNodes"][0]["okTransition"] = json!({"actionNode": "action-1", "optionIndex": 99});
    source["stageNodes"][1]["okTransition"] = json!({"actionNode": "action-1", "optionIndex": 0});
    let payload = payload_from(&source);

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "insert-action-option",
            "actionId": "action-1",
            "index": 0,
            "target": {"target": "stage", "uuid": THIRD}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(after.document.action_nodes[0].options.len(), 101);
    assert_eq!(selection(&after, 0, false), Some(100));
    assert_eq!(selection(&after, 1, false), Some(1));

    // Et le retour à 100 conserve les mêmes destinations.
    let outcome = applied(
        &outcome.payload,
        bindings(),
        json!({
            "gesture": "remove-action-option",
            "actionId": "action-1",
            "ordinal": 0
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert_eq!(after.document.action_nodes[0].options.len(), 100);
    assert_eq!(selection(&after, 0, false), Some(99));
    assert_eq!(selection(&after, 1, false), Some(0));
}

#[test]
fn an_option_gesture_leaves_the_context_and_the_other_actions_intact() {
    let payload = wheel_payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "reorder-action-options",
            "actionId": "action-1",
            "newPositionOfOld": [3, 2, 1, 0]
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Les six familles d'ancrage traversent le geste sans être touchées : aucun
    // nœud n'est retiré, donc aucun ancrage ne se détache.
    assert_eq!(before.context, after.context);
    assert!(outcome.report.anchors.removed.is_empty());
    assert!(outcome.report.anchors.retargeted.is_empty());
    // Les extensions et les marqueurs de groupe hors du geste sont conservés.
    assert_eq!(before.context.opaque_members, after.context.opaque_members);
    assert_eq!(outcome.media_bindings, bindings());
}

// L'Écran d'entrée n'est jamais une destination : STUdio lui retire sa prise
// d'arrivée. Tous les gestes qui posent une cible passent par la même porte.
#[test]
fn the_entry_stage_is_refused_as_the_target_of_a_choice() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-action-option-target",
            "actionId": "action-1",
            "ordinal": 0,
            "target": {"target": "stage", "uuid": ENTRY}
        }),
    );
    assert_eq!(error.code, "ENTRY_STAGE_AS_OPTION");

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "insert-action-option",
            "actionId": "action-1",
            "index": 1,
            "target": {"target": "stage", "uuid": ENTRY}
        }),
    );
    assert_eq!(error.code, "ENTRY_STAGE_AS_OPTION");
}

// Un document importé qui porterait l'une des deux formes bloque la génération
// dans « À corriger », comme au générateur par menus (`port_rules`).
#[test]
fn an_imported_entry_as_choice_or_looping_home_asks_for_a_decision() {
    use crate::native_pack::authoring::{diagnose_enriched_metadata, AuthoringDiagnosticLevel};

    let codes = |document: &Value| {
        diagnose_enriched_metadata(&decoded(document))
            .into_iter()
            .filter(|diagnostic| {
                [
                    "ENTRY_STAGE_AS_OPTION",
                    "HOME_LOOPS_TO_SELF",
                    "OK_LOOPS_TO_SELF",
                ]
                .contains(&diagnostic.code.as_str())
            })
            .map(|diagnostic| (diagnostic.code, diagnostic.level))
            .collect::<Vec<_>>()
    };
    assert!(
        codes(&source_document()).is_empty(),
        "le document de référence respecte les deux règles"
    );

    let mut as_choice = source_document();
    as_choice["actionNodes"][0]["options"] = json!([TARGET, ENTRY]);
    assert_eq!(
        codes(&as_choice),
        vec![(
            "ENTRY_STAGE_AS_OPTION".to_string(),
            AuthoringDiagnosticLevel::ActionRequired
        )],
        "un choix vers l'entrée, importé, bloque"
    );

    let mut looping = source_document();
    looping["stageNodes"][0]["controlSettings"] = controls(false, true, true, false, false);
    assert_eq!(
        codes(&looping),
        vec![(
            "HOME_LOOPS_TO_SELF".to_string(),
            AuthoringDiagnosticLevel::ActionRequired
        )],
        "Accueil qui tourne en rond sur l'entrée bloque"
    );

    // Un Accueil explicite, sur l'entrée, qui mène ailleurs reste admis.
    looping["stageNodes"][0]["homeTransition"] =
        json!({"actionNode": "action-1", "optionIndex": 0});
    assert!(codes(&looping).is_empty());
}
