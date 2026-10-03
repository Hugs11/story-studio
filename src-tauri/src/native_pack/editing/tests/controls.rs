//! Geste de contrôles.

use serde_json::json;

use super::*;

fn members(members: Value) -> Value {
    json!({
        "gesture": "set-stage-controls",
        "stageUuid": ENTRY,
        "update": {"form": "members", "members": members}
    })
}

fn stage_controls(payload: &DecodedStoryDocument, index: usize) -> &Presence<ControlSettings> {
    &payload.document.stage_nodes[index].control_settings
}

/// Les codes bloquants du document, et les réparations que chacun propose.
fn blocking(payload: &str) -> Vec<(String, Vec<String>)> {
    crate::native_pack::authoring::diagnose_enriched_metadata(&saved_and_reopened(payload))
        .into_iter()
        .filter(|diagnostic| {
            diagnostic.level
                == crate::native_pack::authoring::AuthoringDiagnosticLevel::ActionRequired
        })
        .map(|diagnostic| {
            let resolutions = serde_json::to_value(&diagnostic.resolutions).unwrap();
            let resolutions = resolutions
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_owned())
                .collect();
            (diagnostic.code, resolutions)
        })
        .collect()
}

/// Le geste qu'envoie « À corriger » pour une réparation de fin
/// (`diagnosticResolutions.js`).
fn ending_repair(resolution: &str) -> Value {
    let members = match resolution {
        "make-ending" => json!({
            "ok": {"form": "set", "value": false},
            "autoplay": {"form": "set", "value": false},
            "home": {"form": "set", "value": true}
        }),
        "enable-home" => json!({"home": {"form": "set", "value": true}}),
        other => panic!("réparation inattendue : {other}"),
    };
    json!({
        "gesture": "set-stage-controls", "stageUuid": TARGET,
        "update": {"form": "members", "members": members}
    })
}

#[test]
fn an_active_ok_without_destination_is_repaired_into_an_ending_in_one_gesture() {
    let mut source = source_document();
    source["stageNodes"][1]["controlSettings"] = controls(true, true, false, true, true);
    let initial = payload_from(&source);
    assert_eq!(
        blocking(&initial),
        vec![(
            "OK_WITHOUT_USABLE_DESTINATION".to_owned(),
            vec!["make-ending".to_owned()]
        )]
    );
    let repaired = applied(&initial, bindings(), ending_repair("make-ending"));
    assert!(blocking(&repaired.payload).is_empty());
    let after = saved_and_reopened(&repaired.payload);
    let controls = after.document.stage_nodes[1]
        .control_settings
        .value()
        .unwrap();
    assert_eq!(
        (controls.ok(), controls.autoplay(), controls.home()),
        (false, false, true)
    );
    // La molette et la pause ne bougent pas ; aucune destination OK n'est créée.
    assert_eq!((controls.wheel(), controls.pause()), (true, true));
    assert_eq!(after.document.stage_nodes[1].ok_transition, Presence::Null);
    assert_eq!(
        after.document.stage_nodes[1].home_transition,
        Presence::Null
    );
    assert!(!assess_graph_document_export_readiness(Ok(&after)).blocked);
}

#[test]
fn a_stage_without_any_exit_is_repaired_by_enabling_home() {
    let mut source = source_document();
    source["stageNodes"][1]["controlSettings"] = controls(true, false, false, true, false);
    let initial = payload_from(&source);
    assert_eq!(
        blocking(&initial),
        vec![("NO_USABLE_EXIT".to_owned(), vec!["enable-home".to_owned()])]
    );
    let repaired = applied(&initial, bindings(), ending_repair("enable-home"));
    assert!(blocking(&repaired.payload).is_empty());
    let after = saved_and_reopened(&repaired.payload);
    assert_eq!(
        after.document.stage_nodes[1]
            .control_settings
            .value()
            .unwrap(),
        &ControlSettings::authored(true, false, true, true, false)
    );
}

#[test]
fn unsafe_controls_remain_editable_and_block_readiness_until_repaired() {
    let mut source = source_document();
    source["stageNodes"][1]["controlSettings"]["home"] = json!(true);
    let initial = payload_from(&source);
    let before = saved_and_reopened(&initial);
    assert!(!assess_graph_document_export_readiness(Ok(&before)).blocked);
    let unsafe_outcome = applied(
        &initial,
        bindings(),
        json!({
            "gesture": "set-stage-controls", "stageUuid": TARGET,
            "update": {"form": "members", "members": {"home": {"form": "set", "value": false}}}
        }),
    );
    let unsafe_payload = saved_and_reopened(&unsafe_outcome.payload);
    assert!(assess_graph_document_export_readiness(Ok(&unsafe_payload)).blocked);
    assert!(
        crate::native_pack::authoring::diagnose_enriched_metadata(&unsafe_payload)
            .iter()
            .any(|diagnostic| diagnostic.code == "NO_USABLE_EXIT")
    );
    let repaired = applied(
        &unsafe_outcome.payload,
        bindings(),
        json!({
            "gesture": "set-stage-controls", "stageUuid": TARGET,
            "update": {"form": "members", "members": {"home": {"form": "set", "value": true}}}
        }),
    );
    assert!(
        !assess_graph_document_export_readiness(Ok(&saved_and_reopened(&repaired.payload))).blocked
    );
}

#[test]
fn each_boolean_moves_alone_and_the_transition_survives_its_control() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    assert!(before.document.stage_nodes[0].ok_transition.is_value());

    // Désactiver OK ne détruit pas la transition existante.
    let outcome = applied(
        &payload,
        bindings(),
        members(json!({"ok": {"form": "set", "value": false}})),
    );
    let after = saved_and_reopened(&outcome.payload);
    let controls = stage_controls(&after, 0)
        .value()
        .expect("objet de contrôles");
    assert_eq!(controls.ok, Presence::Value(false));
    assert_eq!(
        after.document.stage_nodes[0].ok_transition, before.document.stage_nodes[0].ok_transition,
        "l'identité de la transition et de son Action est conservée"
    );

    // Les quatre autres membres n'ont pas bougé.
    let previous = stage_controls(&before, 0)
        .value()
        .expect("objet de contrôles");
    assert_eq!(controls.wheel, previous.wheel);
    assert_eq!(controls.home, previous.home);
    assert_eq!(controls.pause, previous.pause);
    assert_eq!(controls.autoplay, previous.autoplay);

    // Et le retour on→off→on rend exactement l'état de départ.
    let restored = applied(
        &outcome.payload,
        bindings(),
        members(json!({"ok": {"form": "set", "value": true}})),
    );
    assert_eq!(
        saved_and_reopened(&restored.payload).document,
        before.document
    );
}

#[test]
fn a_member_can_be_cleared_without_the_gesture_inventing_a_value_for_it() {
    // Absent, `null` et valeur restent trois états distincts, et
    // l'auteur peut revenir sur une décision sans qu'un défaut soit fabriqué.
    let payload = payload();
    let outcome = applied(
        &payload,
        bindings(),
        members(json!({"pause": {"form": "null"}, "autoplay": {"form": "absent"}})),
    );
    let after = saved_and_reopened(&outcome.payload);
    let controls = stage_controls(&after, 0)
        .value()
        .expect("objet de contrôles");
    assert_eq!(controls.pause, Presence::Null);
    assert_eq!(controls.autoplay, Presence::Absent);
    assert!(!controls.is_complete());

    // L'export standard est bloqué, le projet reste éditable et
    // enregistrable. Le geste ne complète rien pour débloquer quoi que ce soit.
    assert!(assess_graph_document_export_readiness(Ok(&after)).blocked);
    assert_eq!(
        encode_authoring_payload(&after).expect("payload réencodable"),
        outcome.payload
    );
}

#[test]
fn an_incomplete_object_is_only_completed_by_an_explicit_choice_of_the_five() {
    let mut source = source_document();
    source["stageNodes"][0]["controlSettings"] = json!({"ok": true});
    let payload = payload_from(&source);

    // Poser un membre isolé fabriquerait l'objet partiel que Story Studio
    // s'interdit de créer : le geste renvoie au choix explicite.
    let mut absent = source_document();
    absent["stageNodes"][0]["controlSettings"] = Value::Null;
    let error = refused(
        &payload_from(&absent),
        bindings(),
        members(json!({"home": {"form": "set", "value": true}})),
    );
    assert_eq!(error.code, "CONTROL_SETTINGS_ABSENT");

    absent["stageNodes"][0]
        .as_object_mut()
        .expect("Stage objet")
        .remove("controlSettings");
    let error = refused(
        &payload_from(&absent),
        bindings(),
        members(json!({"home": {"form": "set", "value": true}})),
    );
    assert_eq!(error.code, "CONTROL_SETTINGS_ABSENT");

    // Un objet déjà présent mais partiel se complète membre par membre…
    let outcome = applied(
        &payload,
        bindings(),
        members(json!({
            "wheel": {"form": "set", "value": false},
            "home": {"form": "set", "value": false},
            "pause": {"form": "set", "value": false},
            "autoplay": {"form": "set", "value": false}
        })),
    );
    let after = saved_and_reopened(&outcome.payload);
    assert!(stage_controls(&after, 0).is_complete());

    // …et la forme explicite des cinq valeurs vaut sur un objet absent.
    let outcome = applied(
        &payload_from(&absent),
        bindings(),
        json!({
            "gesture": "set-stage-controls",
            "stageUuid": ENTRY,
            "update": {
                "form": "complete",
                "wheel": true, "ok": true, "home": false,
                "pause": false, "autoplay": false
            }
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    let controls = stage_controls(&after, 0)
        .value()
        .expect("objet de contrôles");
    assert!(controls.is_complete());
    assert_eq!(controls.wheel, Presence::Value(true));
    assert_eq!(controls.home, Presence::Value(false));
    // La transition d'origine n'a pas été touchée par la complétion.
    assert!(after.document.stage_nodes[0].ok_transition.is_value());
}

#[test]
fn a_gesture_that_names_no_control_is_refused_rather_than_guessed() {
    let payload = payload();
    let error = refused(&payload, bindings(), members(json!({})));
    assert_eq!(error.code, "EMPTY_CONTROLS_UPDATE");

    let error = refused(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stage-controls",
            "stageUuid": "aucun-stage",
            "update": {"form": "members", "members": {"ok": {"form": "set", "value": true}}}
        }),
    );
    assert_eq!(error.code, "UNKNOWN_NODE");
}

#[test]
fn a_control_gesture_leaves_the_context_and_the_other_stages_intact() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let outcome = applied(
        &payload,
        bindings(),
        members(json!({"wheel": {"form": "set", "value": true}})),
    );
    let after = saved_and_reopened(&outcome.payload);

    assert_eq!(before.context, after.context);
    assert_eq!(
        before.document.stage_nodes[1],
        after.document.stage_nodes[1]
    );
    assert_eq!(before.document.action_nodes, after.document.action_nodes);
    assert_eq!(outcome.media_bindings, bindings());
}

#[test]
fn a_selection_is_set_in_one_transaction_and_refused_whole() {
    let payload = payload();
    let before = decode_authoring_payload(&payload).expect("payload de départ");
    let pause_off =
        json!({"form": "members", "members": {"pause": {"form": "set", "value": false}}});

    // Un bouton basculé pour toute la sélection, les autres membres intacts.
    let outcome = applied(
        &payload,
        bindings(),
        json!({
            "gesture": "set-stages-controls",
            "stageUuids": [ENTRY, TARGET],
            "update": {"form": "members", "members": {"pause": {"form": "set", "value": true}}}
        }),
    );
    let after = saved_and_reopened(&outcome.payload);
    for index in 0..2 {
        let controls = stage_controls(&after, index)
            .value()
            .expect("objet de contrôles");
        let previous = stage_controls(&before, index)
            .value()
            .expect("objet de contrôles");
        assert_eq!(controls.pause, Presence::Value(true));
        assert_eq!(controls.ok, previous.ok);
        assert_eq!(controls.wheel, previous.wheel);
    }

    // Un Écran sans objet de contrôles refuse la demande entière : l'autre
    // Écran n'est pas réglé à moitié, et rien n'est complété à sa place.
    let mut absent = source_document();
    absent["stageNodes"][1]["controlSettings"] = Value::Null;
    let error = refused(
        &payload_from(&absent),
        bindings(),
        json!({"gesture": "set-stages-controls", "stageUuids": [ENTRY, TARGET], "update": pause_off}),
    );
    assert_eq!(error.code, "CONTROL_SETTINGS_ABSENT");

    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "set-stages-controls", "stageUuids": [ENTRY, ENTRY], "update": pause_off}),
    );
    assert_eq!(error.code, "DUPLICATE_STAGE");
    let error = refused(
        &payload,
        bindings(),
        json!({"gesture": "set-stages-controls", "stageUuids": [], "update": pause_off}),
    );
    assert_eq!(error.code, "EMPTY_STAGE_SELECTION");
}
