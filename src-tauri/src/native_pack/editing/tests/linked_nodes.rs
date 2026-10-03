use super::*;

#[test]
fn stage_drop_creates_one_action_connects_it_and_keeps_view_position() {
    let result = applied(
        &payload(),
        bindings(),
        json!({
            "gesture": "create-linked-node",
            "linked": {
                "direction": "stage-to-action",
                "stageUuid": ENTRY,
                "slot": "home",
                "action": {
                    "id": null,
                    "name": "Retour",
                    "options": [{"target": "null"}]
                },
                "optionIndex": 0,
                "position": {"x": 320.5, "y": -90}
            }
        }),
    );
    let after = saved_and_reopened(&result.payload);
    let created = result.report.created.as_ref().unwrap();
    let action_id = created.action_id.as_ref().unwrap();
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|action| action.id == *action_id)
        .unwrap();
    assert_eq!(action.options, vec![None]);
    let entry = after
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == ENTRY)
        .unwrap();
    let transition = entry.home_transition.value().unwrap();
    assert_eq!(transition.action_node, *action_id);
    assert_eq!(transition.selection.to_dialect_index(), 0);
    // Le point du lâcher devient la position d'auteur de l'Action : un nœud n'a
    // qu'une position, celle du graphe à plat.
    assert_eq!(result.report.positions.authored.len(), 1);
    let placed = action.position.value().expect("position d'auteur posée");
    assert_eq!(placed.x.as_f64(), Some(320.5));
    assert_eq!(placed.y.as_f64(), Some(-90.0));
    assert!(!after
        .context
        .editor_positions
        .iter()
        .any(|entry| entry.path.contains(action_id.as_str())));
    assert!(result.report.construction.unwrap().connected);
}

#[test]
fn action_drop_inserts_a_distinct_occurrence_at_the_requested_rank() {
    let result = applied(
        &payload(),
        bindings(),
        json!({
            "gesture": "create-linked-node",
            "linked": {
                "direction": "action-to-stage",
                "actionId": "action-1",
                "index": 0,
                "stage": {
                    "name": "Nouvelle scène",
                    "controls": controls(false, false, false, false, false)
                },
                "position": {"x": 75, "y": 125}
            }
        }),
    );
    let after = saved_and_reopened(&result.payload);
    let created = result.report.created.as_ref().unwrap();
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|action| action.id == "action-1")
        .unwrap();
    assert_eq!(action.options.len(), 2);
    assert_eq!(action.options[0], Some(created.stage_uuid.clone()));
    assert_eq!(action.options[1], Some(TARGET.to_owned()));
    assert_eq!(result.report.positions.authored.len(), 1);
    assert!(result.report.construction.unwrap().connected);
}

#[test]
fn action_drop_can_create_a_stage_in_a_missing_destination_without_adding_a_rank() {
    let mut source = source_document();
    source["actionNodes"][0]["options"] = json!([null]);
    let result = applied(
        &payload_from(&source),
        bindings(),
        json!({"gesture":"create-linked-node","linked":{
            "direction":"action-to-stage","actionId":"action-1","index":0,
            "replaceMissing":true,
            "stage":{"name":"Nouvelle scène","controls":controls(false,false,false,false,false)},
            "position":{"x":75,"y":125}
        }}),
    );
    let after = saved_and_reopened(&result.payload);
    assert_eq!(
        after.document.action_nodes[0].options,
        vec![Some(result.report.created.unwrap().stage_uuid)]
    );
    assert!(after.document.stage_nodes[0].ok_transition.is_value());
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn action_drop_refuses_to_replace_a_destination_that_is_no_longer_missing() {
    let error = refused(
        &payload(),
        bindings(),
        json!({"gesture":"create-linked-node","linked":{
            "direction":"action-to-stage","actionId":"action-1","index":0,
            "replaceMissing":true,
            "stage":{"name":"Ne doit pas survivre","controls":controls(false,false,false,false,false)},
            "position":{"x":75,"y":125}
        }}),
    );
    assert_eq!(error.code, "INVALID_CONSTRUCTION");
}

#[test]
fn a_late_connection_refusal_never_publishes_the_created_node() {
    let before = payload();
    let error = refused(
        &before,
        bindings(),
        json!({
            "gesture": "create-linked-node",
            "linked": {
                "direction": "action-to-stage",
                "actionId": "action-1",
                "index": 99,
                "stage": {
                    "name": "Ne doit pas survivre",
                    "controls": controls(false, false, false, false, false)
                },
                "position": {"x": 1, "y": 2}
            }
        }),
    );
    assert_eq!(error.code, "OPTION_ORDINAL_OUT_OF_RANGE");
    assert_eq!(saved_and_reopened(&before).document.stage_nodes.len(), 2);
}

#[test]
fn a_stage_drop_from_the_ok_port_turns_ok_on_with_the_created_action() {
    let result = applied(
        &payload(),
        bindings(),
        json!({
            "gesture": "create-linked-node",
            "linked": {
                "direction": "stage-to-action",
                "stageUuid": TARGET,
                "slot": "ok",
                "action": {
                    "id": null,
                    "name": "Suite",
                    "options": [{"target": "null"}]
                },
                "optionIndex": 0,
                "activateControl": true,
                "position": {"x": 0, "y": 0}
            }
        }),
    );
    let after = saved_and_reopened(&result.payload);
    let stage = after
        .document
        .stage_nodes
        .iter()
        .find(|stage| stage.uuid == TARGET)
        .unwrap();
    let controls = &stage.control_settings;
    assert!(controls.ok());
    assert!(!controls.autoplay());
    assert!(!controls.home());
    assert!(stage.ok_transition.value().is_some());
}
