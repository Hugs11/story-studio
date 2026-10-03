//! Geste 3 — créer un Stage avec son Action et ses médias, et les retraits qui
//! rendent la création réversible.

use serde_json::json;

use super::*;
use crate::native_pack::authoring::{diagnose_enriched_metadata, AuthoringDiagnosticLevel};
use crate::native_pack::classify_stage_id;

fn create(stage: Value) -> Value {
    json!({"gesture": "create-stage", "stage": stage})
}

fn minimal_stage() -> Value {
    json!({"controls": controls(false, true, false, false, false)})
}

fn has_diagnostic(payload: &DecodedStoryDocument, code: &str) -> bool {
    diagnose_enriched_metadata(payload)
        .iter()
        .any(|diagnostic| {
            diagnostic.code == code && diagnostic.level == AuthoringDiagnosticLevel::ActionRequired
        })
}

#[test]
fn a_creation_lands_where_the_author_pointed_as_its_authored_position() {
    // Le clic droit sur le canvas désigne un point : la création et son
    // placement partent ensemble, donc en **un seul** pas d'annulation. Le
    // point devient la position d'auteur du nœud — sa seule position.
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "create-stage",
            "stage": minimal_stage(),
            "position": {"x": -120.5, "y": 340},
        }),
    );
    let created = outcome.report.created.clone().expect("nœuds créés");
    let path = format!("/stageNodes/@uuid={}#0", created.stage_uuid);
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        outcome.report.positions.authored,
        vec![format!("{path}/position")]
    );
    assert!(outcome.report.positions.editor.is_empty());
    assert!(!after
        .context
        .editor_positions
        .iter()
        .any(|entry| entry.path == format!("{path}/position")));
    let placed = after
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == created.stage_uuid)
        .and_then(|stage| stage.position.value())
        .expect("la position demandée est posée");
    // Aucun arrondi : une position fractionnaire est une valeur valide, et le
    // canvas en produit à chaque zoom intermédiaire.
    assert_eq!(placed.x.as_f64(), Some(-120.5));
    assert_eq!(placed.y.as_f64(), Some(340.0));
}

#[test]
fn a_creation_without_a_point_lets_the_layout_place_it() {
    // La barre d'outils ne désigne aucun point : le nœud né ne reçoit alors
    // aucune position, et celles que le document portait déjà sont intactes.
    let payload = payload();
    let before = saved_and_reopened(&payload).context.editor_positions.len();
    let outcome = applied(&payload, bindings(), create(minimal_stage()));
    let created = outcome.report.created.clone().expect("nœuds créés");
    let path = format!("/stageNodes/@uuid={}#0", created.stage_uuid);
    let after = saved_and_reopened(&outcome.payload);

    assert!(outcome.report.positions.editor.is_empty());
    assert_eq!(after.context.editor_positions.len(), before);
    assert!(
        !after
            .context
            .editor_positions
            .iter()
            .any(|entry| entry.path.starts_with(&path)),
        "le nœud créé sans point n'est pas placé"
    );
}

#[test]
fn a_created_stage_receives_a_unique_canonical_uuid_and_is_never_the_entry() {
    let payload = payload();
    let outcome = applied(&payload, bindings(), create(minimal_stage()));
    let created = outcome.report.created.clone().expect("nœuds créés");
    let after = saved_and_reopened(&outcome.payload);

    // UUID canonique et unique dès la création.
    assert!(Uuid::parse_str(&created.stage_uuid).is_ok());
    assert!(classify_stage_id(&created.stage_uuid).bridge_compatible);
    assert_eq!(
        after
            .document
            .stage_nodes
            .iter()
            .filter(|stage| stage.uuid == created.stage_uuid)
            .count(),
        1
    );

    let stage = after
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == created.stage_uuid)
        .expect("Stage créé présent");
    // Le nouveau Stage n'est jamais l'entrée par accident.
    assert!(!stage.is_square_one());
    assert_eq!(stage.square_one, Presence::Value(false));
    assert_eq!(
        after
            .document
            .stage_nodes
            .iter()
            .filter(|s| s.is_square_one())
            .count(),
        1
    );
    // Les cinq contrôles sont explicitement renseignés.
    assert!(stage.control_settings.is_complete());
    // Aucune transition n'est inventée par une création.
    assert_eq!(stage.ok_transition, Presence::Absent);
    assert_eq!(stage.home_transition, Presence::Absent);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    assert_eq!(created.action_id, None);
}

#[test]
fn a_non_uuid_action_identifier_is_kept_verbatim() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        create(json!({
            "controls": controls(false, true, false, false, false),
            "action": {"id": "action-7", "name": "Bifurcation", "options": [{"target": "created-stage"}]}
        })),
    );
    let created = outcome.report.created.clone().expect("nœuds créés");
    assert_eq!(created.action_id.as_deref(), Some("action-7"));

    let after = saved_and_reopened(&outcome.payload);
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|action| action.id == "action-7")
        .expect("ActionNode créé");
    // Une graphie `action-N` n'est pas normalisée en UUID.
    assert_eq!(action.id, "action-7");
    assert_eq!(action.options, vec![Some(created.stage_uuid.clone())]);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn a_created_action_targets_the_created_stage_or_an_existing_one() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        create(json!({
            "name": "Clairière",
            "controls": controls(true, true, true, false, false),
            "action": {"options": [{"target": "created-stage"}, {"target": "stage", "uuid": TARGET}]}
        })),
    );
    let created = outcome.report.created.clone().expect("nœuds créés");
    let after = saved_and_reopened(&outcome.payload);
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|action| Some(&action.id) == created.action_id.as_ref())
        .expect("ActionNode créé");
    assert_eq!(
        action.options,
        vec![Some(created.stage_uuid.clone()), Some(TARGET.to_string())]
    );
    // L'identifiant tiré pour l'Action est distinct de celui du Stage.
    assert_ne!(
        created.action_id.as_deref(),
        Some(created.stage_uuid.as_str())
    );
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn an_unknown_target_an_empty_or_taken_identifier_are_refused() {
    let payload = payload();

    let error = refused(
        &payload,
        bindings(),
        create(json!({
            "controls": controls(false, true, false, false, false),
            "action": {"options": [{"target": "stage", "uuid": "stage-inconnu"}]}
        })),
    );
    assert_eq!(error.code, "UNKNOWN_STAGE");

    let error = refused(
        &payload,
        bindings(),
        create(json!({
            "controls": controls(false, true, false, false, false),
            "action": {"id": "  "}
        })),
    );
    assert_eq!(error.code, "INVALID_ACTION_ID");

    // L'espace des identifiants d'Action reste injectif.
    let error = refused(
        &payload,
        bindings(),
        create(json!({
            "controls": controls(false, true, false, false, false),
            "action": {"id": "action-1"}
        })),
    );
    assert_eq!(error.code, "IDENTIFIER_COLLISION");
}

#[test]
fn a_constant_identifier_source_fails_instead_of_producing_a_duplicate() {
    let payload = payload();
    let constant = Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0001u128);
    let first = apply_advanced_gesture_with(
        &payload,
        bindings(),
        &gesture(create(minimal_stage())),
        &mut || constant,
    )
    .expect("première création");
    let error = apply_advanced_gesture_with(
        &first.payload,
        first.media_bindings.clone(),
        &gesture(create(minimal_stage())),
        &mut || constant,
    )
    .expect_err("seconde création refusée");
    assert_eq!(error.code, "IDENTIFIER_COLLISION");
}

#[test]
fn creating_then_deleting_leaves_an_intact_graph_and_a_diagnosed_orphan_action() {
    let payload = payload();
    let created = applied(
        &payload,
        bindings(),
        create(json!({
            "name": "Clairière",
            "controls": controls(false, true, false, false, false),
            "action": {"name": "Vers la forêt", "options": [{"target": "stage", "uuid": TARGET}]}
        })),
    );
    let nodes = created.report.created.clone().expect("nœuds créés");
    let action_id = nodes.action_id.clone().expect("ActionNode créé");

    let deleted = applied(
        &created.payload,
        created.media_bindings.clone(),
        json!({"gesture": "delete-stage", "stageUuid": nodes.stage_uuid}),
    );
    let after = saved_and_reopened(&deleted.payload);

    // Le graphe reste intègre : aucune référence pendante n'est laissée.
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    assert!(!after
        .document
        .stage_nodes
        .iter()
        .any(|stage| stage.uuid == nodes.stage_uuid));

    // L'Action devenue orpheline **survit** et se retrouve en
    // diagnostic. Rien n'est supprimé en silence.
    let orphan = after
        .document
        .action_nodes
        .iter()
        .find(|action| action.id == action_id)
        .expect("ActionNode orphelin conservé");
    assert_eq!(orphan.options, vec![Some(TARGET.to_string())]);
    assert!(has_diagnostic(&after, "ORPHAN_ACTION_AUTHORED_CONTENT"));

    // Et elle se retire par son propre geste, sans toucher au reste.
    let cleaned = applied(
        &deleted.payload,
        deleted.media_bindings.clone(),
        json!({"gesture": "delete-action", "actionId": action_id}),
    );
    let after = saved_and_reopened(&cleaned.payload);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    assert!(!has_diagnostic(&after, "ORPHAN_ACTION_AUTHORED_CONTENT"));
    assert_eq!(after.document.stage_nodes.len(), 2);
    assert_eq!(after.document.action_nodes.len(), 1);
}

#[test]
fn a_stage_still_targeted_and_the_entry_stage_are_not_deletable() {
    let payload = payload();

    // Retargeter ou supprimer l'option est une décision explicite, jamais un
    // effet de bord du retrait d'un Stage.
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": TARGET}),
    );
    assert_eq!(error.code, "STAGE_STILL_TARGETED");
    // L'inventaire est une liste, pas une phrase : l'interface bâtit son plan
    // avec les mêmes `optionId` que le DTO de lecture lui a donnés.
    assert_eq!(
        error.references,
        vec!["/actionNodes/@id=action-1#0/options#0".to_string()]
    );

    // Exactement un `squareOne`.
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": ENTRY}),
    );
    assert_eq!(error.code, "SQUARE_ONE_REMOVAL");
}

#[test]
fn an_action_still_referenced_by_a_transition_is_not_deletable() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    assert_eq!(error.code, "ACTION_STILL_TARGETED");
    assert_eq!(
        error.references,
        vec![format!("/stageNodes/@uuid={ENTRY}#0/okTransition")]
    );
}

#[test]
fn an_ambiguous_identifier_is_refused_rather_than_guessed() {
    // Le doublon est invalide sans le rendre indécodable : le
    // geste refuse de choisir lequel des homonymes l'auteur visait.
    let mut source = source_document();
    source["stageNodes"][1]["uuid"] = json!(ENTRY);
    source["actionNodes"][0]["options"] = json!([ENTRY]);
    let payload = payload_from(&source);

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": ENTRY}),
    );
    assert_eq!(error.code, "AMBIGUOUS_NODE");

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": ENTRY,
            "slot": "ok",
            "update": {"form": "absent"}
        }),
    );
    assert_eq!(error.code, "AMBIGUOUS_NODE");
}

#[test]
fn a_standalone_action_can_be_created_detached_and_wired_by_a_distinct_gesture() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "create-action",
            "action": {"name": "Nouveau choix", "options": [{"target": "stage", "uuid": TARGET}]}
        }),
    );
    let created = outcome.report.created.clone().expect("nœuds créés");
    let action_id = created.action_id.clone().expect("identifiant d'Action");
    let after = saved_and_reopened(&outcome.payload);

    // Aucun Stage n'est créé au passage : le rapport ne prétend pas le contraire.
    assert!(created.stage_uuid.is_empty());
    assert_eq!(after.document.stage_nodes.len(), 2);
    assert_eq!(after.document.action_nodes.len(), 2);
    assert!(Uuid::parse_str(&action_id).is_ok());

    // L'Action naît détachée, et elle survit — c'est un état d'auteur
    // intermédiaire, pas un défaut à réparer.
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    assert!(after.document.stage_nodes.iter().all(|stage| {
        [&stage.ok_transition, &stage.home_transition]
            .into_iter()
            .all(|transition| {
                transition
                    .value()
                    .is_none_or(|transition| transition.action_node != action_id)
            })
    }));

    // Le raccord est un second geste, explicite.
    let wired = applied(
        &outcome.payload,
        bindings(),
        json!({
            "gesture": "set-stage-transition",
            "stageUuid": TARGET,
            "slot": "ok",
            "update": {"form": "set", "actionNode": action_id, "optionIndex": 0}
        }),
    );
    let after = saved_and_reopened(&wired.payload);
    assert_eq!(
        after.document.stage_nodes[1]
            .ok_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(action_id.as_str())
    );
}

#[test]
fn a_standalone_action_keeps_a_provided_identifier_and_refuses_a_collision() {
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        json!({"gesture": "create-action", "action": {"id": "action-42", "options": []}}),
    );
    let after = saved_and_reopened(&outcome.payload);
    // `action-N` est référentiellement valide et n'est jamais
    // normalisé en UUID au seul motif de sa graphie.
    assert_eq!(after.document.action_nodes[1].id, "action-42");
    assert!(after.document.action_nodes[1].options.is_empty());

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "create-action", "action": {"id": "action-1", "options": []}}),
    );
    assert_eq!(error.code, "IDENTIFIER_COLLISION");

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "create-action", "action": {"id": "  ", "options": []}}),
    );
    assert_eq!(error.code, "INVALID_ACTION_ID");

    // `created-stage` n'a pas de sens ici : aucun Stage n'est créé par ce geste.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "create-action",
            "action": {"options": [{"target": "created-stage"}]}
        }),
    );
    assert_eq!(error.code, "NO_CREATED_STAGE");
}

#[test]
fn reassigning_the_entry_leaves_exactly_one_and_never_touches_the_pack_identity() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let outcome = applied(
        &payload,
        bindings(),
        json!({"gesture": "set-square-one", "stageUuid": TARGET}),
    );
    let after = saved_and_reopened(&outcome.payload);

    // Exactement une entrée après mutation.
    assert_eq!(
        after
            .document
            .stage_nodes
            .iter()
            .filter(|stage| stage.is_square_one())
            .count(),
        1
    );
    assert!(after.document.stage_nodes[1].is_square_one());
    assert_eq!(
        after.document.stage_nodes[0].square_one,
        Presence::Value(false)
    );
    assert_eq!(
        outcome.report.references.square_one,
        vec![
            format!("/stageNodes/@uuid={ENTRY}#0"),
            format!("/stageNodes/@uuid={TARGET}#0"),
        ]
    );

    // L'identité reste stable à travers la réassignation.
    assert_eq!(before.context.pack_identity, after.context.pack_identity);
    assert_eq!(
        after.context.pack_identity.value.as_deref(),
        Some(ENTRY),
        "l'identité acquise ne suit pas l'entrée courante"
    );
    // Aucune autre valeur du document ne bouge.
    assert_eq!(before.document.action_nodes, after.document.action_nodes);
    assert!(validate_graph_document_integrity(&after.document).is_ok());

    // Réassigner l'entrée sur elle-même ne change rien et ne rapporte rien.
    let idle = applied(
        &outcome.payload,
        bindings(),
        json!({"gesture": "set-square-one", "stageUuid": TARGET}),
    );
    assert_eq!(idle.payload, outcome.payload);
    assert!(idle.report.references.square_one.is_empty());
}

#[test]
fn a_document_with_two_entries_keeps_only_the_designated_one() {
    let mut source = source_document();
    source["stageNodes"][1]["squareOne"] = json!(true);
    let payload = payload_from(&source);
    let outcome = applied(
        &payload,
        bindings(),
        json!({"gesture": "set-square-one", "stageUuid": ENTRY}),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(after.document.stage_nodes[0].is_square_one());
    assert_eq!(
        after.document.stage_nodes[1].square_one,
        Presence::Value(false)
    );
    assert_eq!(outcome.report.references.square_one.len(), 1);
}

#[test]
fn removing_the_entry_still_demands_a_transfer_first() {
    let payload = payload();
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": ENTRY, "plan": {"options": []}}),
    );
    assert_eq!(error.code, "SQUARE_ONE_REMOVAL");

    // Transfert puis retrait : deux gestes, chacun atomique.
    let transferred = applied(
        &payload,
        bindings(),
        json!({"gesture": "set-square-one", "stageUuid": TARGET}),
    );
    let removed = applied(
        &transferred.payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": ENTRY}),
    );
    let after = saved_and_reopened(&removed.payload);
    assert_eq!(after.document.stage_nodes.len(), 1);
    assert!(after.document.stage_nodes[0].is_square_one());
    // L'identité acquise ne bouge pas, même quand son Stage source disparaît.
    assert_eq!(after.context.pack_identity.value.as_deref(), Some(ENTRY));
}

#[test]
fn an_explicit_plan_retargets_and_removes_the_incoming_options_in_one_transaction() {
    let payload = options::wheel_payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert_eq!(before.document.action_nodes[0].options.len(), 4);

    // Le refus nomme les deux occurrences visant `TARGET`.
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-stage", "stageUuid": TARGET}),
    );
    assert_eq!(error.code, "STAGE_STILL_TARGETED");
    assert_eq!(
        error.references,
        vec![
            "/actionNodes/@id=action-1#0/options#0".to_string(),
            "/actionNodes/@id=action-1#0/options#2".to_string(),
        ]
    );

    // Un plan partiel reste un refus, et nomme ce qui manque.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-stage",
            "stageUuid": TARGET,
            "plan": {"options": [
                {"actionId": "action-1", "ordinal": 0, "resolution": {"form": "null"}}
            ]}
        }),
    );
    assert_eq!(error.code, "OPTION_DECISION_REQUIRED");
    assert_eq!(error.path, "/actionNodes/@id=action-1#0/options#2");

    // Le plan complet : une occurrence retargetée, l'autre retirée, avec la
    // décision de la transition que le retrait prive de destination.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-stage",
            "stageUuid": TARGET,
            "plan": {
                "options": [
                    {"actionId": "action-1", "ordinal": 0,
                     "resolution": {"form": "retarget", "uuid": options::THIRD}},
                    {"actionId": "action-1", "ordinal": 2, "resolution": {"form": "remove"}}
                ],
                "selections": []
            }
        }),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(
        after.document.action_nodes[0].options,
        vec![
            Some(options::THIRD.to_string()),
            Some(options::THIRD.to_string()),
            Some(options::FOURTH.to_string()),
        ]
    );
    assert!(after
        .document
        .stage_nodes
        .iter()
        .all(|stage| stage.uuid != TARGET));
    // `Fixed(3)` visait `FOURTH` : il le vise toujours, en `2`.
    assert_eq!(
        after.document.stage_nodes[0]
            .ok_transition
            .value()
            .map(|transition| transition.selection.to_dialect_index()),
        Some(1)
    );
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    // Les ancrages du Stage retiré sont rapportés, pas perdus en silence.
    assert!(outcome
        .report
        .anchors
        .removed
        .iter()
        .any(|path| path.contains(TARGET)));
}

#[test]
fn a_plan_that_addresses_something_else_is_refused_before_any_mutation() {
    let payload = options::wheel_payload();
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-stage",
            "stageUuid": TARGET,
            "plan": {"options": [
                {"actionId": "action-1", "ordinal": 0, "resolution": {"form": "null"}},
                {"actionId": "action-1", "ordinal": 1, "resolution": {"form": "null"}},
                {"actionId": "action-1", "ordinal": 2, "resolution": {"form": "null"}}
            ]}
        }),
    );
    assert_eq!(error.code, "UNEXPECTED_OPTION_DECISION");
    assert_eq!(error.path, "/actionNodes/@id=action-1#0/options#1");

    // Retargeter vers le Stage que le geste retire n'est pas une résolution.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-stage",
            "stageUuid": TARGET,
            "plan": {"options": [
                {"actionId": "action-1", "ordinal": 0,
                 "resolution": {"form": "retarget", "uuid": TARGET}},
                {"actionId": "action-1", "ordinal": 2, "resolution": {"form": "null"}}
            ]}
        }),
    );
    assert_eq!(error.code, "UNKNOWN_STAGE");
}

#[test]
fn an_action_plan_retargets_or_removes_every_incoming_transition_at_once() {
    let payload = options::wheel_payload();
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "delete-action", "actionId": "action-1"}),
    );
    assert_eq!(error.code, "ACTION_STILL_TARGETED");
    assert_eq!(error.references.len(), 3);

    // Une transition oubliée laisse le geste refusé, sans mutation.
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-action",
            "actionId": "action-1",
            "plan": {"transitions": [
                {"stageUuid": ENTRY, "slot": "ok", "update": {"form": "null"}}
            ]}
        }),
    );
    assert_eq!(error.code, "TRANSITION_DECISION_REQUIRED");

    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-action",
            "actionId": "action-1",
            "plan": {"transitions": [
                {"stageUuid": ENTRY, "slot": "ok", "update": {"form": "null"}},
                {"stageUuid": ENTRY, "slot": "home", "update": {"form": "absent"}},
                {"stageUuid": TARGET, "slot": "ok", "update": {"form": "absent"}}
            ]}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(after.document.action_nodes.is_empty());
    assert_eq!(after.document.stage_nodes[0].ok_transition, Presence::Null);
    assert_eq!(
        after.document.stage_nodes[0].home_transition,
        Presence::Absent
    );
    assert_eq!(outcome.report.references.selections.len(), 3);
    assert!(outcome
        .report
        .references
        .selections
        .iter()
        .all(|effect| effect.decided && effect.after.is_none()));
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn an_action_plan_that_points_back_at_the_removed_action_is_refused() {
    let payload = options::wheel_payload();
    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "delete-action",
            "actionId": "action-1",
            "plan": {"transitions": [
                {"stageUuid": ENTRY, "slot": "ok",
                 "update": {"form": "set", "actionNode": "action-1", "optionIndex": 0}},
                {"stageUuid": ENTRY, "slot": "home", "update": {"form": "absent"}},
                {"stageUuid": TARGET, "slot": "ok", "update": {"form": "absent"}}
            ]}
        }),
    );
    assert_eq!(error.code, "UNKNOWN_ACTION");
}
