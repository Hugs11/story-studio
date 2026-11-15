//! Agrégation de packs dont la couverture ouvre directement plusieurs choix.

use super::*;

#[test]
fn single_choice_and_unwrapped_zip_keep_their_normalized_serialized_bytes() {
    use sha2::{Digest, Sha256};
    let mut single_choice = pack_with_two_root_choices(true);
    single_choice
        .action_nodes
        .retain(|action| action.id != "play-2");
    single_choice.action_nodes[0].options.truncate(1);
    single_choice
        .stage_nodes
        .retain(|stage| stage.uuid != "title-2" && stage.uuid != "story-2");
    // Empreintes obtenues avec builder/imported_zip.rs de 1f02c6d1,
    // avant correction, puis vérifiées sur deux exécutions indépendantes.
    for (label, packs, expected) in [
        (
            "single-choice-wrapper",
            vec![("Pack A", single_choice.clone()), ("Pack B", single_choice)],
            "8a806355d0c3335cbd5b01b4941ca2f19edff369ee447941e0464a7e1b2c28cf",
        ),
        (
            "unwrapped-multi-choice",
            vec![("Pack A", pack_with_two_root_choices(true))],
            "2a12a92d70e752bf1b4e8a3d120b9b5009e93366159d836c3da1e42585509378",
        ),
    ] {
        let mut document = aggregate(packs);
        // Le constructeur tire des UUID neufs à chaque appel. Seuls ces
        // identifiants sont normalisés, dans l'ordre d'émission des nœuds.
        let stage_ids: HashMap<_, _> = document
            .stage_nodes
            .iter()
            .enumerate()
            .map(|(index, stage)| (stage.uuid.clone(), format!("stage-{index}")))
            .collect();
        let action_ids: HashMap<_, _> = document
            .action_nodes
            .iter()
            .enumerate()
            .map(|(index, action)| (action.id.clone(), format!("action-{index}")))
            .collect();
        for stage in &mut document.stage_nodes {
            stage.uuid = stage_ids[&stage.uuid].clone();
            for transition in [&mut stage.home_transition, &mut stage.ok_transition] {
                if let Some(transition) = transition.value_mut() {
                    transition.action_node = action_ids[&transition.action_node].clone();
                }
            }
        }
        for action in &mut document.action_nodes {
            action.id = action_ids[&action.id].clone();
            for target in action.options.iter_mut().flatten() {
                *target = stage_ids[target].clone();
            }
        }
        let json = crate::native_pack::writer::serialize_story_with_pack_uuid(
            &document,
            "11111111-2222-4333-8444-555566667777",
        )
        .expect("serialization");
        assert_eq!(
            format!("{:x}", Sha256::digest(json.as_bytes())),
            expected,
            "{label}"
        );
    }
}

fn stage(
    uuid: &str,
    square_one: bool,
    controls: ControlSettings,
    ok: Presence<Transition>,
    home: Presence<Transition>,
) -> StageNode {
    StageNode {
        uuid: uuid.to_string(),
        name: Presence::Value(uuid.to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(square_one),
        group_id: Presence::Absent,
        audio: Presence::Value(format!("{uuid}.mp3")),
        image: Presence::Value(format!("{uuid}.png")),
        control_settings: Presence::Value(controls),
        home_transition: home,
        ok_transition: ok,
        position: no_authored_position(),
    }
}

fn action(id: &str, options: &[&str]) -> ActionNode {
    ActionNode {
        id: id.to_string(),
        name: Presence::Value("Action node".to_string()),
        action_type: Presence::Absent,
        group_id: Presence::Absent,
        options: named_option_targets(options.iter().map(|o| o.to_string()).collect()),
        position: no_authored_position(),
    }
}

/// Pack source : couverture → choix direct entre deux histoires (titre 1,
/// titre 2). `back_to_list` : la fin de chaque histoire revient à la liste
/// (forme Story Studio) ; sinon elle revient sur son propre titre par une
/// Action à elle (`back-1`, `back-2`), sans repasser par la liste.
fn pack_with_two_root_choices(back_to_list: bool) -> StoryDocument {
    let end = |index: usize| {
        if back_to_list {
            Presence::Value(transition("root-action", index))
        } else {
            Presence::Value(transition(&format!("back-{}", index + 1), 0))
        }
    };
    StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
        action_nodes: {
            let mut actions = vec![
                action("root-action", &["title-1", "title-2"]),
                action("play-1", &["story-1"]),
                action("play-2", &["story-2"]),
            ];
            if !back_to_list {
                actions.push(action("back-1", &["title-1"]));
                actions.push(action("back-2", &["title-2"]));
            }
            actions
        },
        stage_nodes: vec![
            stage(
                "cover",
                true,
                ControlSettings::authored(true, true, false, false, false),
                Presence::Value(transition("root-action", 0)),
                Presence::Null,
            ),
            stage(
                "title-1",
                false,
                ControlSettings::authored(true, true, true, false, false),
                Presence::Value(transition("play-1", 0)),
                Presence::Null,
            ),
            stage(
                "title-2",
                false,
                ControlSettings::authored(true, true, true, false, false),
                Presence::Value(transition("play-2", 0)),
                Presence::Null,
            ),
            stage(
                "story-1",
                false,
                ControlSettings::authored(false, false, true, true, true),
                end(0),
                end(0),
            ),
            stage(
                "story-2",
                false,
                ControlSettings::authored(false, false, true, true, true),
                end(1),
                end(1),
            ),
        ],
    }
}

fn aggregate(packs: Vec<(&str, StoryDocument)>) -> StoryDocument {
    let mut assets = vec![
        prepared_asset("rootAudio", "agg-cover.mp3"),
        prepared_asset("rootImage", "agg-cover.png"),
    ];
    let mut entries = Vec::new();
    let mut bundles = Vec::new();
    for (name, document) in packs {
        for stage in &document.stage_nodes {
            for file in [stage.audio.value(), stage.image.value()]
                .into_iter()
                .flatten()
            {
                assets.push(prepared_asset(
                    &format!("root/{name} / imported {file}"),
                    file,
                ));
            }
        }
        entries.push(CanonicalEntry::Zip(CanonicalZip {
            name: name.to_string(),
            zip_path: Some(format!("{name}.zip")),
            ..Default::default()
        }));
        bundles.push(imported_zip_bundle(
            &format!("root/{name}/zip"),
            "cover",
            "root-action",
            "title-1",
            "cover",
            document,
        ));
    }
    let report = report_for(
        CanonicalProject {
            name: "Agrégat".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: false,
                end_message_autoplay: true,
            },
            entries,
            shared_entries: Vec::new(),
        },
        assets,
        bundles,
    );
    build_story_document(&report).expect("agrégat")
}

fn find_stage<'a>(document: &'a StoryDocument, label: &str) -> &'a StageNode {
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == label)
        .unwrap_or_else(|| panic!("stage {label}"))
}

fn find_action<'a>(document: &'a StoryDocument, id: &str) -> &'a ActionNode {
    document
        .action_nodes
        .iter()
        .find(|action| action.id == id)
        .unwrap_or_else(|| panic!("action {id}"))
}

/// Les Écrans que la molette propose après OK sur un Écran : les options de
/// l'Action visée par son `okTransition`.
fn wheel_choices_after_ok<'a>(document: &'a StoryDocument, from: &StageNode) -> Vec<&'a str> {
    let ok = from.ok_transition.value().expect("ok transition");
    find_action(document, &ok.action_node)
        .named_options()
        .map(|uuid| {
            document
                .stage_nodes
                .iter()
                .find(|stage| stage.uuid == uuid)
                .expect("option stage")
                .label()
        })
        .collect()
}

/// Tous les Écrans atteignables depuis l'entrée (OK, Home, toutes les options
/// de chaque Action traversée).
fn reachable_labels(document: &StoryDocument) -> std::collections::BTreeSet<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut queue: Vec<&StageNode> = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.is_square_one())
        .collect();
    let mut seen_ids = std::collections::HashSet::new();
    while let Some(stage) = queue.pop() {
        if !seen_ids.insert(stage.uuid.clone()) {
            continue;
        }
        seen.insert(stage.label().to_string());
        for transition in [stage.ok_transition.value(), stage.home_transition.value()]
            .into_iter()
            .flatten()
        {
            for uuid in find_action(document, &transition.action_node).named_options() {
                if let Some(next) = document.stage_nodes.iter().find(|s| s.uuid == uuid) {
                    queue.push(next);
                }
            }
        }
    }
    seen
}

/// Après OK sur la couverture d'un pack agrégé, la molette doit proposer les
/// mêmes choix que la couverture du pack d'origine (titre 1 ET titre 2).
#[test]
fn wrapped_pack_keeps_every_first_level_choice_when_stories_return_to_the_list() {
    let source = pack_with_two_root_choices(true);
    assert_eq!(
        wheel_choices_after_ok(&source, find_stage(&source, "cover")),
        vec!["title-1", "title-2"],
        "témoin : le pack source propose deux choix"
    );
    let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
    let wrapper = find_stage(&document, "Pack A");
    assert_eq!(
        wheel_choices_after_ok(&document, wrapper),
        vec!["title-1", "title-2"],
        "OK sur la couverture du pack agrégé ne propose plus que le premier choix"
    );
}

/// Le cas le plus courant : deux packs PRODUITS PAR STORY STUDIO (deux
/// histoires à la racine), agrégés. Le pack source vient du constructeur
/// lui-même, les ancres sont celles de `imported_zip_anchors`.
#[test]
fn two_story_studio_packs_keep_both_stories_on_the_wheel_once_aggregated() {
    let story = |name: &str| {
        CanonicalEntry::Story(CanonicalStory {
            name: name.to_string(),
            audio: Some(format!("{name}.mp3")),
            item_audio: Some(format!("{name}-item.mp3")),
            item_image: Some(format!("{name}-item.png")),
            ..Default::default()
        })
    };
    let project = |entries: Vec<CanonicalEntry>| CanonicalProject {
        name: "Pack".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        options: CanonicalOptions {
            silence_mode: crate::domain::project::SilenceMode::Off,
            harmonize_loudness: true,
            auto_next: false,
            night_mode: false,
            end_message_autoplay: true,
        },
        entries,
        shared_entries: Vec::new(),
    };
    let mut source_assets = vec![
        prepared_asset("rootAudio", "cover.mp3"),
        prepared_asset("rootImage", "cover.png"),
    ];
    for name in ["Un", "Deux"] {
        source_assets.push(prepared_asset(
            &format!("root/{name}/itemAudio"),
            &format!("{name}-item.mp3"),
        ));
        source_assets.push(prepared_asset(
            &format!("root/{name}/itemImage"),
            &format!("{name}-item.png"),
        ));
        source_assets.push(prepared_asset(
            &format!("root/{name}/storyAudio"),
            &format!("{name}.mp3"),
        ));
    }
    let source = build_story_document(&report_for(
        project(vec![story("Un"), story("Deux")]),
        source_assets,
        Vec::new(),
    ))
    .expect("pack Story Studio à deux histoires");
    let cover = source
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .expect("couverture");
    let source_choices = wheel_choices_after_ok(&source, cover);
    assert_eq!(source_choices.len(), 2, "témoin : {source_choices:?}");
    let root_action_id = cover.ok_transition.value().expect("ok").action_node.clone();
    let post_root = find_action(&source, &root_action_id)
        .option_target(0)
        .expect("option 0")
        .to_string();

    let mut assets = vec![
        prepared_asset("rootAudio", "agg-cover.mp3"),
        prepared_asset("rootImage", "agg-cover.png"),
    ];
    let mut entries = Vec::new();
    let mut bundles = Vec::new();
    for name in ["Pack A", "Pack B"] {
        entries.push(CanonicalEntry::Zip(CanonicalZip {
            name: name.to_string(),
            zip_path: Some(format!("{name}.zip")),
            ..Default::default()
        }));
        bundles.push(imported_zip_bundle(
            &format!("root/{name}/zip"),
            &cover.uuid,
            &root_action_id,
            &post_root,
            &cover.uuid,
            source.clone(),
        ));
    }
    assets.push(prepared_asset("unused", "unused.mp3"));
    let document = build_story_document(&report_for(project(entries), assets, bundles))
        .expect("agrégat de deux packs Story Studio");
    let wrapper = find_stage(&document, "Pack A");
    assert_eq!(
        wheel_choices_after_ok(&document, wrapper),
        source_choices,
        "après OK sur « Pack A », la molette ne propose plus que la première histoire"
    );
}

/// Variante : la fin d'une histoire ne repasse pas par la liste.
/// Le deuxième choix du pack source ne doit pas devenir inatteignable.
#[test]
fn wrapped_pack_keeps_every_story_reachable_when_stories_stop_at_the_end() {
    let source = pack_with_two_root_choices(false);
    let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
    let reachable = reachable_labels(&document);
    assert!(
        reachable.contains("story-2"),
        "la deuxième histoire de chaque pack est inatteignable : {reachable:?}"
    );
}

/// Home sur le DEUXIÈME choix d'un pack agrégé doit revenir au menu
/// d'agrégation, comme Home sur le premier.
#[test]
fn home_on_every_first_level_choice_returns_to_the_aggregate_menu() {
    let source = pack_with_two_root_choices(true);
    let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
    let titles: Vec<&StageNode> = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.label() == "title-1" || stage.label() == "title-2")
        .collect();
    assert_eq!(titles.len(), 4);
    for title in titles {
        assert!(
            title.home_transition.value().is_some(),
            "Home sur « {} » quitte le pack agrégé au lieu de revenir au menu",
            title.label()
        );
    }
}

#[test]
fn single_choice_question_home_returns_to_parent_even_when_authored() {
    let mut source = pack_with_two_root_choices(true);
    source.action_nodes[0].options.truncate(1);
    source.action_nodes.retain(|action| action.id != "play-2");
    source
        .stage_nodes
        .retain(|stage| stage.uuid != "title-2" && stage.uuid != "story-2");
    source.stage_nodes[1].home_transition = Presence::Value(transition("authored-home", 0));
    source
        .action_nodes
        .push(action("authored-home", &["story-1"]));

    let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
    let wrapper = find_stage(&document, "Pack A");
    let question = find_stage(&document, "title-1");
    let home = question.home_transition.value().expect("Home question");
    let parent = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .expect("couverture agrégat")
        .ok_transition
        .value()
        .expect("menu parent");
    assert_eq!(home.action_node, parent.action_node);
    assert_eq!(
        find_action(&document, &home.action_node)
            .option_target(home.selection.fixed_index().expect("fixed selection")),
        Some(wrapper.uuid.as_str()),
        "Home sur la question sélectionne le pack dans le menu parent"
    );
}

#[test]
fn wrapped_pack_preserves_authored_home_and_fills_absent_home() {
    for authored_index in 0..2 {
        let mut source = pack_with_two_root_choices(true);
        source.stage_nodes[2 - authored_index].home_transition = Presence::Absent;
        source.stage_nodes[1 + authored_index].home_transition =
            Presence::Value(transition("authored-home", 0));
        source
            .action_nodes
            .push(action("authored-home", &["story-1"]));
        let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
        let wrapper = find_stage(&document, "Pack A");
        let options: Vec<_> = find_action(
            &document,
            &wrapper.ok_transition.value().expect("OK").action_node,
        )
        .named_options()
        .collect();
        for (index, target) in options.iter().enumerate() {
            let stage = document
                .stage_nodes
                .iter()
                .find(|stage| &stage.uuid == target)
                .expect("choice");
            let home = stage.home_transition.value().expect("Home");
            let destination = find_action(&document, &home.action_node)
                .option_target(home.selection.fixed_index().expect("fixed selection"))
                .expect("destination");
            if index != authored_index {
                assert_eq!(
                    destination, wrapper.uuid,
                    "absent Home returns to the selected pack"
                );
            } else {
                assert_eq!(
                    document
                        .stage_nodes
                        .iter()
                        .find(|stage| stage.uuid == destination)
                        .expect("authored target")
                        .label(),
                    "story-1"
                );
            }
        }
    }
}

/// Exploration : les portes d'archive laissent-elles passer ces deux formes ?
#[test]
fn probe_gates_on_aggregated_multi_choice_packs() {
    use crate::native_pack::observed_gates::{
        observe_document_gates, refusal_from_gates, GatePolicy,
    };
    for back_to_list in [true, false] {
        let source = pack_with_two_root_choices(back_to_list);
        let document = aggregate(vec![("Pack A", source.clone()), ("Pack B", source)]);
        let uuid = "11111111-2222-4333-8444-555566667777";
        let story_json =
            crate::native_pack::writer::serialize_story_with_pack_uuid(&document, uuid)
                .expect("écriture");
        let observations = observe_document_gates(&story_json, Some(uuid), GatePolicy::ENFORCED);
        println!(
            "back_to_list={back_to_list} refusal={:?}",
            refusal_from_gates(&observations)
        );
    }
}
