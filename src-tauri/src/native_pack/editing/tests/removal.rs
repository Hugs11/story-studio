//! Le retrait par lot, et la marque de rupture qu'il laisse.
//!
//! Deux propriétés sont éprouvées ici, et la seconde est celle qui a coûté le
//! plus cher à établir : **une marque ne naît que d'un retrait**. Une règle
//! tirée du document — « OK actif sans destination » — a été écrite et mesurée
//! avant celle-ci ; elle refusait de générer un projet neuf et les écrans de
//! fin des packs importés. Les deux derniers essais de ce fichier sont ce qui
//! interdit d'y revenir par inadvertance.
use super::*;
use crate::native_pack::authoring::diagnose_enriched_metadata;

fn codes(payload: &DecodedStoryDocument) -> Vec<String> {
    diagnose_enriched_metadata(payload)
        .into_iter()
        .map(|diagnostic| diagnostic.code)
        .collect()
}

/// Retirer l'Action du document de référence : la transition de l'entrée la
/// vise, elle survit au retrait, et son sort est donc une décision.
fn cut_the_action() -> Value {
    json!({"gesture":"delete-subgraph","subgraph":{
        "actions":["action-1"],
        "transitions":[{"stageUuid":ENTRY,"slot":"ok","update":{"form":"null"}}]
    }})
}

#[test]
fn a_batch_removal_takes_every_node_in_one_transaction() {
    // L'Écran et l'Action partent ensemble. L'occurrence d'option qui désigne
    // l'Écran est portée par l'Action retirée : elle ne survit pas, et n'a donc
    // aucune décision à recevoir. La transition de l'entrée, elle, survit.
    let result = applied(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{
            "stages":[TARGET],
            "actions":["action-1"],
            "transitions":[{"stageUuid":ENTRY,"slot":"ok","update":{"form":"null"}}]
        }}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(after.document.stage_nodes.len(), 1);
    assert!(after.document.action_nodes.is_empty());
    assert_eq!(after.document.stage_nodes[0].uuid, ENTRY);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn a_surviving_reference_without_a_decision_is_refused_before_anything_moves() {
    let error = refused(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{"actions":["action-1"]}}),
    );
    assert_eq!(error.code, "TRANSITION_DECISION_REQUIRED");
    // L'inventaire accompagne le refus : l'interface le relit au lieu de
    // découper la phrase française.
    assert!(!error.references.is_empty());

    let stage = refused(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{"stages":[TARGET]}}),
    );
    assert_eq!(stage.code, "OPTION_DECISION_REQUIRED");
}

#[test]
fn a_decision_on_something_the_removal_does_not_touch_is_refused() {
    // La transition de l'entrée vise `action-1`, qui n'est pas retirée ici.
    let error = refused(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{
            "stages":[TARGET],
            "options":[{"actionId":"action-1","ordinal":0,"resolution":{"form":"null"}}],
            "transitions":[{"stageUuid":ENTRY,"slot":"ok","update":{"form":"null"}}]
        }}),
    );
    assert_eq!(error.code, "UNEXPECTED_TRANSITION_DECISION");
}

#[test]
fn removing_an_occurrence_rank_is_not_offered_on_a_batch() {
    // Retirer un rang décale les suivants : sur un lot, les ordinaux d'un plan
    // glisseraient d'un retrait à l'autre. `delete-stage` reste le chemin.
    let error = refused(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{
            "stages":[TARGET],
            "options":[{"actionId":"action-1","ordinal":0,"resolution":{"form":"remove"}}]
        }}),
    );
    assert_eq!(error.code, "UNSUPPORTED_REMOVAL_RESOLUTION");
}

#[test]
fn the_entry_stage_is_never_part_of_a_batch_removal() {
    let error = refused(
        &payload(),
        bindings(),
        json!({"gesture":"delete-subgraph","subgraph":{"stages":[ENTRY]}}),
    );
    assert_eq!(error.code, "SQUARE_ONE_REMOVAL");
}

#[test]
fn an_empty_or_repeated_batch_is_refused() {
    assert_eq!(
        refused(
            &payload(),
            bindings(),
            json!({"gesture":"delete-subgraph","subgraph":{}})
        )
        .code,
        "INVALID_REMOVAL"
    );
    assert_eq!(
        refused(
            &payload(),
            bindings(),
            json!({"gesture":"delete-subgraph","subgraph":{"stages":[TARGET,TARGET]}})
        )
        .code,
        "INVALID_REMOVAL"
    );
}

#[test]
fn cutting_an_action_marks_the_transition_it_severed_and_the_diagnostic_follows() {
    let before = decode_authoring_payload(&payload()).expect("payload de départ");
    assert!(before.context.severed_transitions.is_empty());
    assert!(!codes(&before).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()));

    let result = applied(&payload(), bindings(), cut_the_action());
    let after = saved_and_reopened(&result.payload);

    // La marque ancre la **transition**, pas l'Écran : deux emplacements d'un
    // même Écran sont deux ruptures distinctes.
    assert_eq!(
        after
            .context
            .severed_transitions
            .iter()
            .map(|severed| severed.path.as_str())
            .collect::<Vec<_>>(),
        vec![format!("/stageNodes/@uuid={ENTRY}#0/okTransition").as_str()]
    );
    assert!(codes(&after).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()));
    // Elle vit dans le contexte du `.mbah` : elle survit donc à l'enregistrement
    // et à la réouverture, ce que `saved_and_reopened` vient de faire subir.
}

#[test]
fn removing_an_option_marks_the_lost_link_regardless_of_null_or_absent() {
    for form in ["null", "absent"] {
        let result = applied(
            &payload(),
            bindings(),
            json!({"gesture":"remove-action-option","actionId":"action-1","ordinal":0,
                "selections":[{"stageUuid":ENTRY,"slot":"ok","resolution":{"form":form}}]}),
        );
        let after = saved_and_reopened(&result.payload);
        assert_eq!(after.context.severed_transitions.len(), 1, "{form}");
        assert!(
            codes(&after).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()),
            "{form}"
        );
    }
}

#[test]
fn removing_an_action_marks_the_lost_link_regardless_of_null_or_absent() {
    for form in ["null", "absent"] {
        let result = applied(
            &payload(),
            bindings(),
            json!({"gesture":"delete-action","actionId":"action-1",
                "plan":{"transitions":[{"stageUuid":ENTRY,"slot":"ok","update":{"form":form}}]}}),
        );
        let after = saved_and_reopened(&result.payload);
        assert_eq!(after.context.severed_transitions.len(), 1, "{form}");
        assert!(
            codes(&after).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()),
            "{form}"
        );
    }
}

#[test]
fn removing_a_final_stage_preserves_the_incoming_link_and_leaves_a_destination_to_fill() {
    let result = applied(
        &payload(),
        bindings(),
        json!({"gesture":"delete-stage","stageUuid":TARGET,
            "plan":{"options":[{"actionId":"action-1","ordinal":0,
                "resolution":{"form":"null"}}]}}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(after.document.action_nodes.len(), 1);
    assert_eq!(after.document.action_nodes[0].options, vec![None]);
    assert!(after.document.stage_nodes[0].ok_transition.is_value());
    assert!(after.context.severed_transitions.is_empty());
    let readiness = assess_graph_document_export_readiness(Ok(&after));
    assert!(readiness.blocked);
    assert_eq!(
        readiness
            .integrity_errors()
            .map(|error| error.code.as_str())
            .collect::<Vec<_>>(),
        vec!["OPTION_TARGET_NULL"]
    );
}

#[test]
fn removing_a_nonfinal_stage_still_marks_the_lost_link() {
    let mut source = source_document();
    source["stageNodes"][1]["okTransition"] = json!({"actionNode":"action-1","optionIndex":0});
    let result = applied(
        &payload_from(&source),
        bindings(),
        json!({"gesture":"delete-stage","stageUuid":TARGET,
            "plan":{"options":[{"actionId":"action-1","ordinal":0,
                "resolution":{"form":"remove"}}],
                "selections":[{"stageUuid":ENTRY,"slot":"ok",
                    "resolution":{"form":"absent"}},
                    {"stageUuid":TARGET,"slot":"ok",
                    "resolution":{"form":"absent"}}]}}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(after.document.action_nodes.len(), 1);
    assert_eq!(after.context.severed_transitions.len(), 1);
}

#[test]
fn removing_a_shared_final_stage_preserves_all_three_links_to_the_action() {
    let mut source = source_document();
    let entry = source["stageNodes"][0].clone();
    for uuid in [super::options::THIRD, super::options::FOURTH] {
        let mut predecessor = entry.clone();
        predecessor["uuid"] = json!(uuid);
        predecessor["squareOne"] = json!(false);
        source["stageNodes"]
            .as_array_mut()
            .expect("Écrans")
            .push(predecessor);
    }
    let result = applied(
        &payload_from(&source),
        bindings(),
        json!({"gesture":"delete-stage","stageUuid":TARGET,
        "plan":{"options":[{"actionId":"action-1","ordinal":0,
            "resolution":{"form":"null"}}]}}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(after.document.stage_nodes.len(), 3);
    assert_eq!(after.document.action_nodes.len(), 1);
    assert_eq!(after.document.action_nodes[0].options, vec![None]);
    assert!(after
        .document
        .stage_nodes
        .iter()
        .all(|stage| stage.ok_transition.is_value()));
    assert!(after.context.severed_transitions.is_empty());
    let view = crate::native_pack::graph_view::read_advanced_graph_view(&result.payload)
        .expect("graphe lisible avec une destination à compléter");
    assert_eq!(
        view.edges
            .iter()
            .filter(|edge| {
                edge.kind == crate::native_pack::graph_view::dto::EdgeKind::StageOk
                    && edge.to.as_deref() == Some("/actionNodes/@id=action-1#0")
            })
            .count(),
        3
    );
    let readiness = assess_graph_document_export_readiness(Ok(&after));
    assert!(readiness.blocked);
    assert_eq!(readiness.integrity_errors().count(), 1);

    let repaired = applied(
        &result.payload,
        result.media_bindings,
        json!({"gesture":"set-action-option-target","actionId":"action-1",
            "ordinal":0,"target":{"target":"stage","uuid":super::options::THIRD}}),
    );
    let repaired_document = saved_and_reopened(&repaired.payload);
    assert!(validate_graph_document_integrity(&repaired_document.document).is_ok());
    assert!(repaired_document
        .document
        .stage_nodes
        .iter()
        .all(|stage| stage.ok_transition.is_value()));
}

#[test]
fn removing_a_stage_with_two_incoming_options_cuts_only_the_selected_link() {
    let mut source = super::options::wheel_document();
    source["stageNodes"][0]["okTransition"]["optionIndex"] = json!(2);
    let result = applied(
        &payload_from(&source),
        bindings(),
        json!({"gesture":"delete-stage","stageUuid":TARGET,
            "plan":{"options":[
                {"actionId":"action-1","ordinal":0,"resolution":{"form":"remove"}},
                {"actionId":"action-1","ordinal":2,"resolution":{"form":"remove"}}],
                "selections":[{"stageUuid":ENTRY,"slot":"ok",
                    "resolution":{"form":"absent"}}]}}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(after.document.action_nodes[0].options.len(), 2);
    assert!(after.document.stage_nodes[0].ok_transition.is_absent());
    assert!(after.document.stage_nodes[0].home_transition.is_value());
    assert_eq!(after.context.severed_transitions.len(), 1);
}

#[test]
fn the_mark_clears_itself_as_soon_as_the_author_rewires() {
    let cut = applied(&payload(), bindings(), cut_the_action());
    // Une Action neuve, puis la transition refaite vers elle.
    let rebuilt = applied(
        &cut.payload,
        cut.media_bindings.clone(),
        json!({"gesture":"create-action","action":{"options":[{"target":"stage","uuid":TARGET}]}}),
    );
    let action_id = rebuilt
        .report
        .created
        .as_ref()
        .and_then(|created| created.action_id.clone())
        .expect("Action créée");
    let rewired = applied(
        &rebuilt.payload,
        rebuilt.media_bindings.clone(),
        json!({"gesture":"set-stage-transition","stageUuid":ENTRY,"slot":"ok",
               "update":{"form":"set","actionNode":action_id,"optionIndex":0}}),
    );
    let after = saved_and_reopened(&rewired.payload);
    assert!(
        after.context.severed_transitions.is_empty(),
        "la marque s'efface dès que la transition retrouve une valeur"
    );
    assert!(!codes(&after).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()));
}

#[test]
fn the_mark_clears_when_the_author_explicitly_disables_the_broken_control() {
    let cut = applied(&payload(), bindings(), cut_the_action());
    let ended = applied(
        &cut.payload,
        cut.media_bindings.clone(),
        json!({"gesture":"set-stage-controls","stageUuid":ENTRY,
            "update":{"form":"members","members":{"ok":{"form":"set","value":false}}}}),
    );
    let after = saved_and_reopened(&ended.payload);
    assert!(after.context.severed_transitions.is_empty());
    assert!(!codes(&after).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()));
}

#[test]
fn a_terminal_screen_never_raises_the_diagnostic_on_its_own() {
    // **Le garde-fou de ce diagnostic.** Une règle tirée des contrôles — « OK actif
    // sans destination » — a été écrite avant celle-ci : elle refusait de
    // générer un projet neuf, et signalait tous les écrans de fin des packs
    // importés. Un écran terminal est légitime, et le document ne le distingue
    // pas d'un écran qu'une coupe vient de casser.
    let mut source = source_document();
    source["stageNodes"][1]["controlSettings"] = controls(false, true, false, false, true);
    source["stageNodes"][1]["okTransition"] = json!(null);
    let payload = payload_from(&source);
    let decoded = decode_authoring_payload(&payload).expect("payload relu");

    assert!(decoded.context.severed_transitions.is_empty());
    assert!(!codes(&decoded).contains(&"TRANSITION_SEVERED_BY_REMOVAL".to_string()));
    assert!(validate_graph_document_integrity(&decoded.document).is_ok());
}

#[test]
fn a_mark_left_on_a_stage_that_is_removed_later_does_not_orphan_its_anchor() {
    // La marque est une famille d'ancrage comme les autres : elle suit le
    // retrait du nœud qu'elle désigne, sans quoi le geste suivant refuserait
    // par `ORPHAN_CONTEXT_ANCHOR`.
    let cut = applied(&payload(), bindings(), cut_the_action());
    // L'entrée porte la marque ; on la déplace pour pouvoir la retirer.
    let moved = applied(
        &cut.payload,
        cut.media_bindings.clone(),
        json!({"gesture":"set-square-one","stageUuid":TARGET}),
    );
    let removed = applied(
        &moved.payload,
        moved.media_bindings.clone(),
        json!({"gesture":"delete-subgraph","subgraph":{"stages":[ENTRY]}}),
    );
    let after = saved_and_reopened(&removed.payload);
    assert!(after.context.severed_transitions.is_empty());
    assert!(removed.report.anchors.preexisting_orphans.is_empty());
}
