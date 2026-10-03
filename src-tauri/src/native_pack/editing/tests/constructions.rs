use super::*;

fn request(kind: &str) -> Value {
    json!({"gesture":"create-construction", "construction": {
        "kind":kind, "name":"L’île", "items":[],
        "controls":controls(false,false,false,true,true),
        "optionControls":controls(true,true,false,false,false),
        "question":false, "destination":null, "source":null
    }})
}
fn source() -> Value {
    json!({"stageUuid":ENTRY,"slot":"ok","controls":{"form":"members","members":{"autoplay":{"form":"set","value":true}}}})
}

#[test]
fn scene_creation_preserves_context_and_only_builds_standard_nodes() {
    let before = payload();
    let mut req = request("scene");
    req["construction"]["destination"] = json!(TARGET);
    let result = applied(&before, bindings(), req);
    let after = saved_and_reopened(&result.payload);
    let original = decode_authoring_payload(&before).unwrap();
    assert_eq!(original.context, after.context);
    assert_eq!(result.media_bindings, bindings());
    assert_eq!(
        &after.document.stage_nodes[..2],
        original.document.stage_nodes.as_slice()
    );
    assert_eq!(after.document.stage_nodes.len(), 3);
    assert_eq!(after.document.action_nodes.len(), 2);
    let scene = &after.document.stage_nodes[2];
    assert_eq!(scene.square_one, Presence::Value(false));
    assert!(scene.control_settings.is_complete());
    assert_eq!(scene.home_transition, Presence::Absent);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
    let report = result.report.construction.unwrap();
    assert_eq!(report.stages, vec![scene.uuid.clone()]);
    assert_eq!(report.transitions.len(), 1);
    assert!(!report.connected);
}

#[test]
fn choice_keeps_order_distinct_options_and_shared_destinations() {
    let mut req = request("choice");
    req["construction"]["items"] =
        json!([{"name":"Forêt","target":TARGET},{"name":"Plage","target":TARGET}]);
    req["construction"]["question"] = json!(true);
    req["construction"]["source"] = source();
    let result = applied(&payload(), bindings(), req);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.unwrap();
    assert_eq!(report.stages.len(), 3);
    let choices: Vec<_> = report.stages[..2]
        .iter()
        .map(|id| {
            after
                .document
                .stage_nodes
                .iter()
                .find(|n| n.uuid == *id)
                .unwrap()
        })
        .collect();
    assert_eq!(choices[0].name, Presence::Value("Forêt".into()));
    assert_eq!(choices[1].name, Presence::Value("Plage".into()));
    for choice in &choices {
        let transition = choice.ok_transition.value().unwrap();
        let action = after
            .document
            .action_nodes
            .iter()
            .find(|a| a.id == transition.action_node)
            .unwrap();
        assert_eq!(action.options, vec![Some(TARGET.to_owned())]);
        assert_eq!(
            choice.control_settings.value().unwrap().wheel,
            Presence::Value(true)
        );
        assert_eq!(choice.home_transition, Presence::Absent);
    }
    let action_id = result.report.created.unwrap().action_id.unwrap();
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|a| a.id == action_id)
        .unwrap();
    assert_eq!(
        action.options,
        report.stages[..2]
            .iter()
            .cloned()
            .map(Some)
            .collect::<Vec<_>>()
    );
    let entry = &after.document.stage_nodes[0];
    assert_eq!(
        entry.control_settings.value().unwrap().autoplay,
        Presence::Value(true)
    );
    assert_eq!(
        entry.control_settings.value().unwrap().ok,
        Presence::Value(true)
    );
    assert!(report.connected);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn sequence_links_in_order_and_can_end_unfinished() {
    let mut req = request("sequence");
    req["construction"]["items"] = json!([{"name":"Un","target":null},{"name":"Deux","target":null},{"name":"Trois","target":null}]);
    let result = applied(&payload(), bindings(), req);
    let after = saved_and_reopened(&result.payload);
    let report = result.report.construction.unwrap();
    assert_eq!(report.stages.len(), 3);
    assert_eq!(report.actions.len(), 2);
    for pair in report.stages.windows(2) {
        let stage = after
            .document
            .stage_nodes
            .iter()
            .find(|n| n.uuid == pair[0])
            .unwrap();
        let tr = stage.ok_transition.value().unwrap();
        let action = after
            .document
            .action_nodes
            .iter()
            .find(|a| a.id == tr.action_node)
            .unwrap();
        assert_eq!(action.options, vec![Some(pair[1].clone())]);
    }
    let last = after
        .document
        .stage_nodes
        .iter()
        .find(|n| n.uuid == report.stages[2])
        .unwrap();
    assert_eq!(last.ok_transition, Presence::Absent);
}

#[test]
fn random_is_an_incoming_selection_and_reuses_existing_stages_verbatim() {
    let before = payload();
    let mut req = request("random");
    req["construction"]["source"] = source();
    req["construction"]["items"] = json!([{"name":"","target":TARGET},{"name":"Hibou","target":null},{"name":"","target":TARGET}]);
    // L'Écran d'entrée n'est jamais une destination : la construction qui y
    // mènerait est refusée entière.
    let mut toward_entry = req.clone();
    toward_entry["construction"]["destination"] = json!(ENTRY);
    assert_eq!(
        refused(&before, bindings(), toward_entry).code,
        "ENTRY_STAGE_AS_OPTION"
    );
    req["construction"]["destination"] = json!(TARGET);
    let result = applied(&before, bindings(), req);
    let after = saved_and_reopened(&result.payload);
    assert_eq!(
        after.document.stage_nodes[1],
        decode_authoring_payload(&before)
            .unwrap()
            .document
            .stage_nodes[1]
    );
    let transition = after.document.stage_nodes[0].ok_transition.value().unwrap();
    assert_eq!(transition.selection.to_dialect_index(), -1);
    let action = after
        .document
        .action_nodes
        .iter()
        .find(|a| a.id == transition.action_node)
        .unwrap();
    assert_eq!(action.options[0], Some(TARGET.into()));
    assert_eq!(action.options[2], Some(TARGET.into()));
    assert_eq!(result.report.construction.unwrap().stages.len(), 1);
    assert!(validate_graph_document_integrity(&after.document).is_ok());
}

#[test]
fn invalid_destination_and_ambiguous_source_never_publish_partial_constructions() {
    let before = payload();
    let mut req = request("scene");
    req["construction"]["destination"] = json!("missing");
    assert_eq!(refused(&before, bindings(), req).code, "UNKNOWN_NODE");
    let mut doc = source_document();
    let duplicate = doc["stageNodes"][0].clone();
    doc["stageNodes"].as_array_mut().unwrap().push(duplicate);
    let ambiguous = payload_from(&doc);
    let mut req = request("scene");
    req["construction"]["source"] = source();
    assert_eq!(refused(&ambiguous, bindings(), req).code, "AMBIGUOUS_NODE");
    assert_eq!(saved_and_reopened(&before).document.stage_nodes.len(), 2);
}

#[test]
fn late_source_control_refusal_returns_no_payload_and_original_remains_reusable() {
    let before = payload();
    let mut req = request("scene");
    req["construction"]["source"] = source();
    req["construction"]["source"]["controls"]["members"] = json!({});
    assert!(apply(&before, bindings(), req).is_err());
    let result = applied(&before, bindings(), request("scene"));
    assert_eq!(
        saved_and_reopened(&result.payload)
            .document
            .stage_nodes
            .len(),
        3
    );
}

#[test]
fn malformed_constructions_are_refused_before_creation() {
    for kind in ["choice", "sequence", "random"] {
        assert_eq!(
            refused(&payload(), bindings(), request(kind)).code,
            "INVALID_CONSTRUCTION"
        );
    }
    let mut req = request("scene");
    req["construction"]["controls"]
        .as_object_mut()
        .unwrap()
        .remove("home");
    assert!(serde_json::from_value::<AdvancedGesture>(req).is_err());
}

/// Les réglages par défaut de l'éditeur graphe (`constructions.js`).
fn narrative() -> Value {
    controls(false, false, true, true, true)
}
fn choice() -> Value {
    controls(true, true, true, false, false)
}

/// Un document neuf, puis la construction reliée par OK depuis son entrée :
/// ses Écrans sont donc tous atteignables.
fn built_on_a_new_document(
    kind: &str,
    items: Value,
    question: bool,
) -> (DecodedStoryDocument, Vec<String>) {
    let created =
        crate::native_pack::persistence::create_advanced_document("Projet neuf", &mut Uuid::new_v4)
            .expect("document neuf");
    let entry = saved_and_reopened(&created).document.stage_nodes[0]
        .uuid
        .clone();
    let request = json!({"gesture":"create-construction", "construction": {
        "kind": kind, "name": "L’île", "items": items,
        "controls": narrative(), "optionControls": choice(),
        "question": question, "destination": null,
        "source": {"stageUuid": entry, "slot": "ok",
                   "controls": {"form":"members","members":{"ok":{"form":"set","value":true}}}}
    }});
    let result = applied(&created, Vec::new(), request);
    let stages = result.report.construction.unwrap().stages;
    (saved_and_reopened(&result.payload), stages)
}

#[test]
fn every_construction_on_a_new_document_is_born_with_safe_endings() {
    let named = |names: &[&str]| -> Value {
        names
            .iter()
            .map(|name| json!({"name": name, "target": null}))
            .collect()
    };
    for (kind, items, question) in [
        ("scene", json!([]), false),
        ("sequence", named(&["Un", "Deux", "Trois"]), false),
        ("choice", named(&["Forêt", "Plage"]), false),
        ("choice", named(&["Forêt", "Plage"]), true),
        ("random", named(&["Hibou", "Chouette"]), false),
    ] {
        let (after, stages) = built_on_a_new_document(kind, items, question);
        let unsafe_endings: Vec<_> =
            crate::native_pack::authoring::diagnose_enriched_metadata(&after)
                .into_iter()
                .filter(|d| {
                    ["OK_WITHOUT_USABLE_DESTINATION", "NO_USABLE_EXIT"].contains(&d.code.as_str())
                })
                .map(|d| (d.code, d.path))
                .collect();
        assert!(
            unsafe_endings.is_empty(),
            "{kind} (question {question}) : {unsafe_endings:?}"
        );
        for uuid in &stages {
            let stage = after
                .document
                .stage_nodes
                .iter()
                .find(|n| n.uuid == *uuid)
                .unwrap();
            let controls = stage.control_settings.value().unwrap();
            if stage.ok_transition.value().is_some() {
                // Un Écran qui reçoit une destination garde les réglages demandés.
                let question_stage = question && stages.last() == Some(uuid);
                let requested = if kind == "choice" && !question_stage {
                    choice()
                } else {
                    narrative()
                };
                assert_eq!(serde_json::to_value(controls).unwrap(), requested, "{kind}");
            } else {
                assert_eq!(
                    (controls.ok(), controls.autoplay(), controls.home()),
                    (false, false, true),
                    "{kind} : {:?}",
                    stage.name
                );
            }
        }
    }
}
