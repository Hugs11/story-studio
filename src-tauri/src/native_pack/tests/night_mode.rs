use super::*;

#[test]
fn inserts_night_stage_between_story_end_and_next_choice() {
    let report = report_for(
        CanonicalProject {
            name: "Night pack".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: true,
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Choose a story".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        name: "Story Alpha".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("item.mp3".to_string()),
                        item_image: Some("item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        name: "Story Beta".to_string(),
                        audio: Some("beta-story.mp3".to_string()),
                        item_audio: Some("beta-item.mp3".to_string()),
                        item_image: Some("beta-item.png".to_string()),
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Choose a story/menuAudio", "menu.mp3"),
            prepared_asset("root/Choose a story/menuImage", "menu.png"),
            prepared_asset("root/Choose a story/Story Alpha/itemAudio", "item.mp3"),
            prepared_asset("root/Choose a story/Story Alpha/itemImage", "item.png"),
            prepared_asset("root/Choose a story/Story Alpha/storyAudio", "story.mp3"),
            prepared_asset("root/Choose a story/Story Beta/itemAudio", "beta-item.mp3"),
            prepared_asset("root/Choose a story/Story Beta/itemImage", "beta-item.png"),
            prepared_asset(
                "root/Choose a story/Story Beta/storyAudio",
                "beta-story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("night mode document");
    let menu_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Choose a story")
        .expect("menu stage");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Story Alpha" && stage.image.is_none())
        .expect("play stage");
    let second_play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Story Beta" && stage.image.is_none())
        .expect("second play stage");
    let night_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "nightStage")
        .expect("night stage");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![menu_stage.uuid.clone()])
        .expect("root action");
    let night_entry_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![night_stage.uuid.clone()])
        .expect("night entry action");

    assert!(document.night_mode_available);
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "nightStage")
            .count(),
        1
    );
    assert_eq!(
        document
            .action_nodes
            .iter()
            .filter(|action| action.options == vec![night_stage.uuid.clone()])
            .count(),
        1
    );
    assert_eq!(night_stage.audio.as_deref(), Some("night.mp3"));
    assert!(night_stage.image.is_none());
    assert!(night_stage.control_settings.autoplay);
    assert!(night_stage.control_settings.ok);
    assert!(night_stage.control_settings.home);
    assert_eq!(
        play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(night_entry_action.id.as_str())
    );
    assert_eq!(
        second_play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(night_entry_action.id.as_str())
    );
    assert_eq!(
        night_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        night_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(0)
    );
    assert!(night_stage.home_transition.is_none());
}

#[test]
fn night_stage_preserves_story_specific_return_after_play() {
    let report = report_for(
        CanonicalProject {
            name: "Night story returns".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: true,
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "menu".to_string(),
                name: "Choose a story".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        id: "alpha".to_string(),
                        name: "Story Alpha".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("item.mp3".to_string()),
                        item_image: Some("item.png".to_string()),
                        return_after_play: Some("story:beta".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        id: "beta".to_string(),
                        name: "Story Beta".to_string(),
                        audio: Some("beta-story.mp3".to_string()),
                        item_audio: Some("beta-item.mp3".to_string()),
                        item_image: Some("beta-item.png".to_string()),
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Choose a story#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Choose a story#menu/menuImage", "menu.png"),
            prepared_asset(
                "root/Choose a story#menu/Story Alpha#alpha/itemAudio",
                "item.mp3",
            ),
            prepared_asset(
                "root/Choose a story#menu/Story Alpha#alpha/itemImage",
                "item.png",
            ),
            prepared_asset(
                "root/Choose a story#menu/Story Alpha#alpha/storyAudio",
                "story.mp3",
            ),
            prepared_asset(
                "root/Choose a story#menu/Story Beta#beta/itemAudio",
                "beta-item.mp3",
            ),
            prepared_asset(
                "root/Choose a story#menu/Story Beta#beta/itemImage",
                "beta-item.png",
            ),
            prepared_asset(
                "root/Choose a story#menu/Story Beta#beta/storyAudio",
                "beta-story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("night story return document");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Story Alpha" && stage.image.is_none())
        .expect("play stage");
    let night_entry_action_id = play_stage
        .ok_transition
        .as_ref()
        .map(|transition| transition.action_node.as_str())
        .expect("play night transition");
    let night_stage_id = document
        .action_nodes
        .iter()
        .find(|action| action.id == night_entry_action_id)
        .and_then(|action| action.options.first())
        .expect("night stage id");
    let night_stage = document
        .stage_nodes
        .iter()
        .find(|stage| &stage.uuid == night_stage_id)
        .expect("night stage");
    let return_transition = night_stage
        .ok_transition
        .as_ref()
        .expect("night return transition");
    let return_action = document
        .action_nodes
        .iter()
        .find(|action| action.id == return_transition.action_node)
        .expect("night return action");
    let return_stage_id = return_action
        .options
        .get(return_transition.option_index as usize)
        .expect("night return target");
    let return_stage = document
        .stage_nodes
        .iter()
        .find(|stage| &stage.uuid == return_stage_id)
        .expect("night return stage");

    assert_eq!(return_stage.name, "Titre - Story Beta");
    assert!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "nightStage")
            .count()
            >= 2
    );
}

#[test]
fn night_mode_return_next_story_creates_story_specific_night_stages() {
    let report = report_for(
        CanonicalProject {
            name: "Night next-story".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: Some("next_story".to_string()),
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: true,
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "menu".to_string(),
                name: "Choisis".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-a".to_string(),
                        name: "Histoire A".to_string(),
                        audio: Some("a.mp3".to_string()),
                        item_audio: Some("a-item.mp3".to_string()),
                        item_image: Some("a-item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-b".to_string(),
                        name: "Histoire B".to_string(),
                        audio: Some("b.mp3".to_string()),
                        item_audio: Some("b-item.mp3".to_string()),
                        item_image: Some("b-item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-c".to_string(),
                        name: "Histoire C".to_string(),
                        audio: Some("c.mp3".to_string()),
                        item_audio: Some("c-item.mp3".to_string()),
                        item_image: Some("c-item.png".to_string()),
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Choisis#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Choisis#menu/menuImage", "menu.png"),
            prepared_asset(
                "root/Choisis#menu/Histoire A#story-a/itemAudio",
                "a-item.mp3",
            ),
            prepared_asset(
                "root/Choisis#menu/Histoire A#story-a/itemImage",
                "a-item.png",
            ),
            prepared_asset("root/Choisis#menu/Histoire A#story-a/storyAudio", "a.mp3"),
            prepared_asset(
                "root/Choisis#menu/Histoire B#story-b/itemAudio",
                "b-item.mp3",
            ),
            prepared_asset(
                "root/Choisis#menu/Histoire B#story-b/itemImage",
                "b-item.png",
            ),
            prepared_asset("root/Choisis#menu/Histoire B#story-b/storyAudio", "b.mp3"),
            prepared_asset(
                "root/Choisis#menu/Histoire C#story-c/itemAudio",
                "c-item.mp3",
            ),
            prepared_asset(
                "root/Choisis#menu/Histoire C#story-c/itemImage",
                "c-item.png",
            ),
            prepared_asset("root/Choisis#menu/Histoire C#story-c/storyAudio", "c.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("night next-story document");

    let story_a_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire A" && stage.image.is_none())
        .expect("story A play stage");
    let story_b_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire B" && stage.image.is_none())
        .expect("story B play stage");
    let story_c_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire C" && stage.image.is_none())
        .expect("story C play stage");

    let a_target = resolve_night_return_stage(&document, story_a_play);
    let b_target = resolve_night_return_stage(&document, story_b_play);
    let c_target = resolve_night_return_stage(&document, story_c_play);

    assert_eq!(a_target.name, "Titre - Histoire B");
    assert_eq!(b_target.name, "Titre - Histoire C");
    // Last story has no next sibling → fallback to the menu replay (parent stage).
    assert_eq!(c_target.name, "Choisis");

    // next_story produces a different resolved target per story, so multiple distinct night
    // stages are emitted (one per source story).
    let night_stage_count = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.name == "nightStage")
        .count();
    assert!(
        night_stage_count >= 2,
        "expected ≥2 night stages for next_story routing, got {night_stage_count}"
    );
}

#[test]
fn night_mode_return_global_menu_reuses_single_night_stage() {
    let report = report_for(
        CanonicalProject {
            name: "Night global menu".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: Some("menu:menu-end".to_string()),
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: true,
            },
            entries: vec![
                CanonicalEntry::Menu(CanonicalMenu {
                    id: "menu-main".to_string(),
                    name: "Histoires".to_string(),
                    audio: Some("main.mp3".to_string()),
                    image: Some("main.png".to_string()),
                    auto_black_image: false,
                    children: vec![
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-a".to_string(),
                            name: "Histoire A".to_string(),
                            audio: Some("a.mp3".to_string()),
                            item_audio: Some("a-item.mp3".to_string()),
                            item_image: Some("a-item.png".to_string()),
                            ..Default::default()
                        }),
                        CanonicalEntry::Story(CanonicalStory {
                            id: "story-b".to_string(),
                            name: "Histoire B".to_string(),
                            audio: Some("b.mp3".to_string()),
                            item_audio: Some("b-item.mp3".to_string()),
                            item_image: Some("b-item.png".to_string()),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                }),
                CanonicalEntry::Menu(CanonicalMenu {
                    id: "menu-end".to_string(),
                    name: "Final".to_string(),
                    audio: Some("final.mp3".to_string()),
                    image: Some("final.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Story(CanonicalStory {
                        id: "story-z".to_string(),
                        name: "Histoire Z".to_string(),
                        audio: Some("z.mp3".to_string()),
                        item_audio: Some("z-item.mp3".to_string()),
                        item_image: Some("z-item.png".to_string()),
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Histoires#menu-main/menuAudio", "main.mp3"),
            prepared_asset("root/Histoires#menu-main/menuImage", "main.png"),
            prepared_asset(
                "root/Histoires#menu-main/Histoire A#story-a/itemAudio",
                "a-item.mp3",
            ),
            prepared_asset(
                "root/Histoires#menu-main/Histoire A#story-a/itemImage",
                "a-item.png",
            ),
            prepared_asset(
                "root/Histoires#menu-main/Histoire A#story-a/storyAudio",
                "a.mp3",
            ),
            prepared_asset(
                "root/Histoires#menu-main/Histoire B#story-b/itemAudio",
                "b-item.mp3",
            ),
            prepared_asset(
                "root/Histoires#menu-main/Histoire B#story-b/itemImage",
                "b-item.png",
            ),
            prepared_asset(
                "root/Histoires#menu-main/Histoire B#story-b/storyAudio",
                "b.mp3",
            ),
            prepared_asset("root/Final#menu-end/menuAudio", "final.mp3"),
            prepared_asset("root/Final#menu-end/menuImage", "final.png"),
            prepared_asset(
                "root/Final#menu-end/Histoire Z#story-z/itemAudio",
                "z-item.mp3",
            ),
            prepared_asset(
                "root/Final#menu-end/Histoire Z#story-z/itemImage",
                "z-item.png",
            ),
            prepared_asset("root/Final#menu-end/Histoire Z#story-z/storyAudio", "z.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("night global menu document");

    let story_a_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire A" && stage.image.is_none())
        .expect("story A play stage");
    let story_b_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire B" && stage.image.is_none())
        .expect("story B play stage");
    let story_z_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Histoire Z" && stage.image.is_none())
        .expect("story Z play stage");

    let a_target = resolve_night_return_stage(&document, story_a_play);
    let b_target = resolve_night_return_stage(&document, story_b_play);
    let z_target = resolve_night_return_stage(&document, story_z_play);

    assert_eq!(a_target.name, "Final");
    assert_eq!(b_target.name, "Final");
    assert_eq!(z_target.name, "Final");

    // Global destination → single shared night stage thanks to night_bridge_cache.
    let night_stage_count = document
        .stage_nodes
        .iter()
        .filter(|stage| stage.name == "nightStage")
        .count();
    assert_eq!(
        night_stage_count, 1,
        "expected 1 shared night stage for a global menu destination, got {night_stage_count}"
    );
}

#[test]
fn night_mode_return_story_target_routes_to_story_title() {
    let report = report_for(
        CanonicalProject {
            name: "Night to story title".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("root.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: Some("night.mp3".to_string()),
            night_mode_return: Some("story:story-target".to_string()),
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions {
                silence_mode: crate::domain::project::SilenceMode::Off,
                harmonize_loudness: true,
                auto_next: false,
                night_mode: true,
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "menu".to_string(),
                name: "Choisis".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-source".to_string(),
                        name: "Source".to_string(),
                        audio: Some("s.mp3".to_string()),
                        item_audio: Some("s-item.mp3".to_string()),
                        item_image: Some("s-item.png".to_string()),
                        ..Default::default()
                    }),
                    CanonicalEntry::Story(CanonicalStory {
                        id: "story-target".to_string(),
                        name: "Cible".to_string(),
                        audio: Some("t.mp3".to_string()),
                        item_audio: Some("t-item.mp3".to_string()),
                        item_image: Some("t-item.png".to_string()),
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            })],
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Choisis#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Choisis#menu/menuImage", "menu.png"),
            prepared_asset(
                "root/Choisis#menu/Source#story-source/itemAudio",
                "s-item.mp3",
            ),
            prepared_asset(
                "root/Choisis#menu/Source#story-source/itemImage",
                "s-item.png",
            ),
            prepared_asset("root/Choisis#menu/Source#story-source/storyAudio", "s.mp3"),
            prepared_asset(
                "root/Choisis#menu/Cible#story-target/itemAudio",
                "t-item.mp3",
            ),
            prepared_asset(
                "root/Choisis#menu/Cible#story-target/itemImage",
                "t-item.png",
            ),
            prepared_asset("root/Choisis#menu/Cible#story-target/storyAudio", "t.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("night story target document");

    let source_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Source" && stage.image.is_none())
        .expect("source play stage");

    let target = resolve_night_return_stage(&document, source_play);
    assert_eq!(target.name, "Titre - Cible");
}

/// Type d'architecture : un pack night-capable (document `nightModeAvailable: true`) rejoué
/// par le parachute alors que la DÉTECTION du pont nuit a échoué à l'import
/// (`options.night_mode == false`). Round-trip : le drapeau doit être PRÉSERVÉ, pas effacé
/// par l'option dérivée de la détection.
#[test]
fn parachute_preserves_declared_night_mode_available_when_bridge_not_detected() {
    let native_graph = serde_json::json!({
        "preserveForRoundTrip": true,
        "projectionStatus": "lossy",
        "document": {
            "title": "Night Capable",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": true,
            "stageNodes": [
                {
                    "uuid": "cover", "name": "Cover", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "a0", "optionIndex": 0 },
                    "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                },
                {
                    "uuid": "story", "name": "Story", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": "story.png",
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": false, "autoplay": true },
                    "okTransition": null,
                    "homeTransition": null,
                    "position": { "x": 120, "y": 0 }
                }
            ],
            "actionNodes": [
                { "id": "a0", "name": "Root", "options": ["story"], "position": { "x": 60, "y": 0 } }
            ]
        }
    });

    let project = CanonicalProject {
        name: "Night Capable".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("cover.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: Some(native_graph),
        // La détection a échoué : l'option vaut false bien que le pack soit night-capable.
        options: CanonicalOptions {
            silence_mode: crate::domain::project::SilenceMode::Off,
            harmonize_loudness: true,
            auto_next: false,
            night_mode: false,
        },
        entries: vec![],
    };

    let assets = vec![
        prepared_asset("rootAudio", "root.mp3"),
        prepared_asset("rootImage", "cover.png"),
        prepared_asset("nativeGraph/story/audio", "story.mp3"),
        prepared_asset("nativeGraph/story/image", "story.png"),
    ];

    let document =
        build_story_document(&report_for(project, assets, Vec::new())).expect("parachute build");

    assert!(
        document.night_mode_available,
        "le drapeau nightModeAvailable du document d'origine doit survivre au round-trip parachute",
    );
}
