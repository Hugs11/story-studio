//! Une seule règle de navigation pour les deux éditeurs (`port_rules`) : le
//! générateur par menus refuse exactement ce que le graphe bloque dans
//! « À corriger », et accepte exactement ce que le graphe laisse générer.
//! Formes éprouvées sur une Lunii et dans STUdio 0.5.4 le 29/09/2026.

use serde_json::{json, Value};

use crate::native_pack::authoring::{diagnose_enriched_metadata, AuthoringDiagnosticLevel};
use crate::native_pack::decode_story_document;
use crate::native_pack::document::validate_document_for_studio_compat;

const CODES: [&str; 5] = [
    "HOME_LOOPS_TO_SELF",
    "OK_LOOPS_TO_SELF",
    "ENTRY_STAGE_AS_OPTION",
    "OK_WITHOUT_USABLE_DESTINATION",
    "NO_USABLE_EXIT",
];

fn controls(wheel: bool, ok: bool, home: bool, autoplay: bool) -> Value {
    json!({"wheel": wheel, "ok": ok, "home": home, "pause": false, "autoplay": autoplay})
}

/// Entrée → question (molette) → liste [histoire A, histoire B] ; chaque
/// histoire revient à la question. Aucune des formes interdites.
fn base() -> Value {
    json!({
        "format": "v1", "version": 1,
        "stageNodes": [
            {"uuid": "entry", "squareOne": true, "audio": "e.mp3", "image": "e.png",
             "controlSettings": controls(true, true, false, false),
             "okTransition": {"actionNode": "to-question", "optionIndex": 0}, "homeTransition": null},
            {"uuid": "question", "squareOne": false, "audio": "q.mp3", "image": null,
             "controlSettings": controls(false, true, true, true),
             "okTransition": {"actionNode": "stories", "optionIndex": 0}, "homeTransition": null},
            {"uuid": "story-a", "squareOne": false, "audio": "a.mp3", "image": "a.png",
             "controlSettings": controls(true, true, true, true),
             "okTransition": {"actionNode": "to-question", "optionIndex": 0},
             "homeTransition": null},
            {"uuid": "story-b", "squareOne": false, "audio": "b.mp3", "image": "b.png",
             "controlSettings": controls(true, true, true, true),
             "okTransition": {"actionNode": "to-question", "optionIndex": 0},
             "homeTransition": null}
        ],
        "actionNodes": [
            {"id": "to-question", "options": ["question"]},
            {"id": "stories", "options": ["story-a", "story-b"]}
        ]
    })
}

/// Le verdict des deux éditeurs sur le même document : codes bloquants du
/// graphe, et refus (ou non) du générateur par menus.
fn verdicts(value: &Value) -> (Vec<String>, bool) {
    let decoded = decode_story_document(&value.to_string()).expect("document décodable");
    let graph: Vec<String> = diagnose_enriched_metadata(&decoded)
        .into_iter()
        .filter(|diagnostic| CODES.contains(&diagnostic.code.as_str()))
        .inspect(|diagnostic| {
            assert_eq!(diagnostic.level, AuthoringDiagnosticLevel::ActionRequired);
        })
        .map(|diagnostic| diagnostic.code)
        .collect();
    let menus_refuses = validate_document_for_studio_compat(&decoded.document).is_err();
    (graph, menus_refuses)
}

#[test]
fn a_sound_document_passes_both_editors() {
    assert_eq!(verdicts(&base()), (Vec::new(), false));
}

#[test]
fn home_and_ok_to_the_same_stage_passes_both_editors() {
    // L'écran de fin de packs officiels : Accueil
    // et OK mènent à la question. STUdio ne le vérifie pas, la Lunii le joue.
    let mut value = base();
    value["stageNodes"][2]["homeTransition"] =
        json!({"actionNode": "to-question", "optionIndex": 0});
    assert_eq!(verdicts(&value), (Vec::new(), false));
}

#[test]
fn home_looping_to_itself_is_refused_by_both_editors() {
    // Pack publié : Accueil sur la question ramène la question ; la Lunii s'y
    // fige muette.
    let mut value = base();
    value["actionNodes"][0]["options"] = json!(["question", "story-a"]);
    value["stageNodes"][1]["homeTransition"] =
        json!({"actionNode": "to-question", "optionIndex": 0});
    assert_eq!(
        verdicts(&value),
        (vec!["HOME_LOOPS_TO_SELF".to_string()], true)
    );
}

#[test]
fn home_without_destination_on_the_entry_is_refused_by_both_editors() {
    let mut value = base();
    value["stageNodes"][0]["controlSettings"]["home"] = json!(true);
    assert_eq!(
        verdicts(&value),
        (vec!["HOME_LOOPS_TO_SELF".to_string()], true)
    );
}

#[test]
fn ok_looping_to_itself_is_refused_by_both_editors() {
    let mut value = base();
    value["stageNodes"][2]["okTransition"] = json!({"actionNode": "stories", "optionIndex": 0});
    assert_eq!(
        verdicts(&value),
        (vec!["OK_LOOPS_TO_SELF".to_string()], true)
    );
}

#[test]
fn ok_without_destination_is_not_a_loop_but_is_unsafe() {
    // L'absence de destination ne boucle pas, mais OK actif provoque Error.
    let mut value = base();
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(
        verdicts(&value),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
}

#[test]
fn autoplay_without_destination_is_unsafe_even_with_home() {
    let mut value = base();
    value["stageNodes"][2]["controlSettings"] = controls(true, false, true, true);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(
        verdicts(&value),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
}

#[test]
fn home_alone_and_ok_alone_are_valid_exits() {
    let mut value = base();
    value["stageNodes"][2]["controlSettings"] = controls(true, false, true, false);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    value["stageNodes"][3]["controlSettings"] = controls(false, true, false, false);
    assert_eq!(verdicts(&value), (Vec::new(), false));
}

#[test]
fn wheel_in_a_single_choice_is_not_an_exit() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a"]);
    value["stageNodes"][2]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(verdicts(&value), (vec!["NO_USABLE_EXIT".into()], true));
}

#[test]
fn wheel_can_reach_another_choice_with_an_exit() {
    let mut value = base();
    value["stageNodes"][2]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(verdicts(&value), (Vec::new(), false));
}

#[test]
fn several_choices_without_an_exit_are_not_enough_for_the_wheel() {
    let mut value = base();
    for index in [2, 3] {
        value["stageNodes"][index]["controlSettings"] = controls(true, false, false, false);
        value["stageNodes"][index]["okTransition"] = Value::Null;
    }
    assert_eq!(
        verdicts(&value),
        (vec!["NO_USABLE_EXIT".into(), "NO_USABLE_EXIT".into()], true)
    );
}

#[test]
fn wheel_uses_the_opened_list_not_every_list_containing_the_stage() {
    let mut value = base();
    value["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "alone", "options": ["story-a"]}));
    value["stageNodes"][1]["okTransition"] = json!({"actionNode": "alone", "optionIndex": 0});
    value["stageNodes"][2]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(verdicts(&value), (vec!["NO_USABLE_EXIT".into()], true));
}

/// Un Écran qu'aucun bouton ni aucune liste n'atteint : OK et lecture
/// automatique actifs sans destination, Accueil vers la question. Des packs
/// publiés en contiennent et se jouent normalement sur l'appareil.
fn with_orphan_ending() -> Value {
    let mut value = base();
    value["stageNodes"].as_array_mut().unwrap().push(json!({
        "uuid": "orphan", "squareOne": false, "audio": "o.mp3", "image": null,
        "controlSettings": controls(false, true, true, true),
        "okTransition": null,
        "homeTransition": {"actionNode": "to-question", "optionIndex": 0}
    }));
    value
}

#[test]
fn unreachable_ok_without_destination_is_not_a_violation() {
    assert_eq!(verdicts(&with_orphan_ending()), (Vec::new(), false));
}

#[test]
fn the_same_stage_once_reachable_needs_an_ok_destination() {
    let mut value = with_orphan_ending();
    value["actionNodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "to-orphan", "options": ["orphan"]}));
    value["stageNodes"][2]["okTransition"] = json!({"actionNode": "to-orphan", "optionIndex": 0});
    assert_eq!(
        verdicts(&value),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
}

#[test]
fn the_entry_needs_an_ok_destination_even_with_nothing_after_it() {
    let mut value = base();
    value["stageNodes"][0]["okTransition"] = Value::Null;
    assert_eq!(
        verdicts(&value),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
}

#[test]
fn unreachable_unfinished_stage_is_not_an_accessible_dead_end() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a"]);
    value["stageNodes"][3]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][3]["okTransition"] = Value::Null;
    assert_eq!(verdicts(&value), (Vec::new(), false));
}

#[test]
fn active_ok_requires_a_resolved_destination() {
    let mut absent = base();
    absent["stageNodes"][2]
        .as_object_mut()
        .unwrap()
        .remove("okTransition");
    assert_eq!(
        verdicts(&absent),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
    for transition in [
        json!({"actionNode": "absent", "optionIndex": 0}),
        json!({"actionNode": "stories", "optionIndex": 8}),
    ] {
        let mut value = base();
        value["stageNodes"][2]["okTransition"] = transition;
        assert_eq!(
            verdicts(&value),
            (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
        );
    }
    for options in [json!([]), json!([null]), json!(["absent"])] {
        let mut value = base();
        value["actionNodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "broken", "options": options}));
        value["stageNodes"][2]["okTransition"] = json!({"actionNode": "broken", "optionIndex": 0});
        assert_eq!(
            verdicts(&value),
            (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
        );
    }
}

#[test]
fn random_ok_requires_all_possible_destinations_to_resolve() {
    let mut value = base();
    value["stageNodes"][2]["okTransition"] =
        json!({"actionNode": "to-question", "optionIndex": -1});
    assert_eq!(verdicts(&value), (Vec::new(), false));
    value["actionNodes"][0]["options"] = json!(["question", null]);
    assert_eq!(
        verdicts(&value),
        (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
    );
}

#[test]
fn random_ok_rejects_empty_or_missing_targets() {
    for options in [json!([]), json!(["absent"]), json!([null])] {
        let mut value = base();
        value["actionNodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "broken", "options": options}));
        value["stageNodes"][2]["okTransition"] = json!({"actionNode": "broken", "optionIndex": -1});
        assert_eq!(
            verdicts(&value),
            (vec!["OK_WITHOUT_USABLE_DESTINATION".into()], true)
        );
    }
}

#[test]
fn initial_entry_is_not_an_accessible_all_off_dead_end() {
    let mut value = base();
    value["stageNodes"].as_array_mut().unwrap().truncate(1);
    value["stageNodes"][0]["controlSettings"] = controls(false, false, false, false);
    value["stageNodes"][0]["okTransition"] = Value::Null;
    value["actionNodes"] = json!([]);
    assert_eq!(verdicts(&value), (Vec::new(), false));
}

#[test]
fn duplicate_options_do_not_borrow_an_exit_from_another_occurrence() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a", "story-a", "story-b"]);
    value["stageNodes"][2]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][2]["okTransition"] = Value::Null;
    assert_eq!(verdicts(&value), (Vec::new(), false));
    value["stageNodes"][2]["controlSettings"]["wheel"] = json!(false);
    assert_eq!(verdicts(&value), (vec!["NO_USABLE_EXIT".into()], true));
}

#[test]
fn wheel_cannot_cross_a_choice_whose_wheel_is_disabled() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a", "story-b", "question", "story-b"]);
    value["stageNodes"][2]["controlSettings"] = controls(true, false, false, false);
    value["stageNodes"][3]["controlSettings"] = controls(false, false, false, false);
    value["stageNodes"][1]["okTransition"] = json!({"actionNode": "stories", "optionIndex": 0});
    assert_eq!(
        verdicts(&value),
        (vec!["NO_USABLE_EXIT".into(), "NO_USABLE_EXIT".into()], true)
    );
}

#[test]
fn random_arrival_checks_each_possible_context_but_fixed_arrival_does_not() {
    let mut value = base();
    value["stageNodes"][3]["controlSettings"] = controls(false, false, false, false);
    value["stageNodes"][3]["okTransition"] = Value::Null;
    value["stageNodes"][2]["controlSettings"]["wheel"] = json!(false);
    assert_eq!(verdicts(&value), (Vec::new(), false));
    value["stageNodes"][1]["okTransition"]["optionIndex"] = json!(-1);
    assert_eq!(verdicts(&value), (vec!["NO_USABLE_EXIT".into()], true));
}

#[test]
fn unknown_controls_are_not_treated_as_an_explicit_dead_end() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a"]);
    value["stageNodes"][2]["controlSettings"] = json!({"wheel": true, "home": false, "ok": false});
    value["stageNodes"][2]["okTransition"] = Value::Null;
    let (graph, _) = verdicts(&value);
    assert!(graph.is_empty());
    for controls in [
        json!({"home": false, "ok": false, "autoplay": false, "pause": false}),
        json!({"wheel": null, "home": false, "ok": false, "autoplay": false, "pause": false}),
        Value::Null,
    ] {
        value["stageNodes"][2]["controlSettings"] = controls;
        assert!(verdicts(&value).0.is_empty());
    }
}

#[test]
fn the_entry_as_a_choice_is_refused_by_both_editors() {
    let mut value = base();
    value["actionNodes"][1]["options"] = json!(["story-a", "story-b", "entry"]);
    assert_eq!(
        verdicts(&value),
        (vec!["ENTRY_STAGE_AS_OPTION".to_string()], true)
    );
}
