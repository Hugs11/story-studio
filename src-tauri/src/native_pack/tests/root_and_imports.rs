use super::*;

#[test]
fn makes_root_menu_selectable_when_pack_has_multiple_root_entries() {
    let report = report_for(
        CanonicalProject {
            name: "Mixed root pack".to_string(),
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
            },
            entries: vec![
                CanonicalEntry::Story(CanonicalStory {
                    name: "Standalone story".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("story-item.mp3".to_string()),
                    item_image: Some("story-item.png".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Menu(CanonicalMenu {
                    name: "Cache cache".to_string(),
                    audio: Some("menu.mp3".to_string()),
                    image: Some("menu.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Story(CanonicalStory {
                        name: "Inside menu".to_string(),
                        audio: Some("inside-story.mp3".to_string()),
                        item_audio: Some("inside-item.mp3".to_string()),
                        item_image: Some("inside-item.png".to_string()),
                        autoplay: true,
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Standalone story/itemAudio", "story-item.mp3"),
            prepared_asset("root/Standalone story/itemImage", "story-item.png"),
            prepared_asset("root/Standalone story/storyAudio", "story.mp3"),
            prepared_asset("root/Cache cache/menuAudio", "menu.mp3"),
            prepared_asset("root/Cache cache/menuImage", "menu.png"),
            prepared_asset("root/Cache cache/Inside menu/itemAudio", "inside-item.mp3"),
            prepared_asset("root/Cache cache/Inside menu/itemImage", "inside-item.png"),
            prepared_asset(
                "root/Cache cache/Inside menu/storyAudio",
                "inside-story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("mixed root document");
    let menu_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Cache cache")
        .expect("root menu stage");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Inside menu" && stage.image.is_none())
        .expect("inside menu play stage");
    // Root action has two options: standalone story title (index 0) and Cache cache menu (index 1).
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options.contains(&menu_stage.uuid))
        .expect("root action");

    assert!(menu_stage.control_settings.wheel);
    assert!(!menu_stage.control_settings.autoplay);
    // After playback: return directly to Cache cache menu stage (index 1 in root action),
    // matching the UI's resolveReturnTarget fallback → parentMenu.id.
    assert_eq!(
        play_stage
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(1)
    );
    assert!(play_stage.control_settings.autoplay);
}

#[test]
fn keeps_single_cover_stage_when_pack_has_multiple_root_entries() {
    let report = report_for(
        CanonicalProject {
            name: "Root zip pack".to_string(),
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
            },
            entries: vec![
                CanonicalEntry::Story(CanonicalStory {
                    name: "Story one".to_string(),
                    audio: Some("story-1.mp3".to_string()),
                    item_audio: Some("story-1-item.mp3".to_string()),
                    item_image: Some("story-1-item.png".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    name: "Story two".to_string(),
                    audio: Some("story-2.mp3".to_string()),
                    item_audio: Some("story-2-item.mp3".to_string()),
                    item_image: Some("story-2-item.png".to_string()),
                    ..Default::default()
                }),
            ],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Story one/itemAudio", "story-1-item.mp3"),
            prepared_asset("root/Story one/itemImage", "story-1-item.png"),
            prepared_asset("root/Story one/storyAudio", "story-1.mp3"),
            prepared_asset("root/Story two/itemAudio", "story-2-item.mp3"),
            prepared_asset("root/Story two/itemImage", "story-2-item.png"),
            prepared_asset("root/Story two/storyAudio", "story-2.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("root selection document");
    let cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .expect("cover stage");
    let root_choice_action = document
        .action_nodes
        .iter()
        .find(|action| action.options.len() == 2)
        .expect("root choice action");

    assert_eq!(
        cover
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_choice_action.id.as_str())
    );
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "Root zip pack" && !stage.square_one)
            .count(),
        0
    );
}

#[test]
fn wraps_imported_zips_when_multiple_root_entries_are_selectable() {
    let imported = StoryDocument {
        title: "Imported".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["import-menu".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "import-menu-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["import-title".to_string()],
                position: zero_position(),
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: "Debut".to_string(),
                stage_type: "stage".to_string(),
                square_one: true,
                audio: Some("import-cover.mp3".to_string()),
                image: Some("import-cover.png".to_string()),
                control_settings: ControlSettings {
                    wheel: false,
                    ok: true,
                    home: false,
                    pause: false,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: Some(transition("import-root-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "import-menu".to_string(),
                name: "Quel épisode veux-tu écouter".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("import-menu.mp3".to_string()),
                image: Some("import-menu.png".to_string()),
                control_settings: ControlSettings {
                    wheel: false,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: true,
                },
                home_transition: None,
                ok_transition: Some(transition("import-menu-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "import-title".to_string(),
                name: "1".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("import-title.mp3".to_string()),
                image: Some("import-title.png".to_string()),
                control_settings: ControlSettings {
                    wheel: true,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: false,
                },
                home_transition: Some(transition("import-root-action", 0)),
                ok_transition: None,
                position: zero_position(),
            },
        ],
    };

    let report = report_for(
        CanonicalProject {
            name: "Multi imported root".to_string(),
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
            },
            entries: vec![
                CanonicalEntry::Zip(CanonicalZip {
                    name: "Pack A".to_string(),
                    zip_path: Some("pack-a.zip".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Zip(CanonicalZip {
                    name: "Pack B".to_string(),
                    zip_path: Some("pack-b.zip".to_string()),
                    ..Default::default()
                }),
            ],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset(
                "root/Pack A / imported import-cover.mp3",
                "import-cover.mp3",
            ),
            prepared_asset(
                "root/Pack A / imported import-cover.png",
                "import-cover.png",
            ),
            prepared_asset("root/Pack A / imported import-menu.mp3", "import-menu.mp3"),
            prepared_asset("root/Pack A / imported import-menu.png", "import-menu.png"),
            prepared_asset(
                "root/Pack A / imported import-title.mp3",
                "import-title.mp3",
            ),
            prepared_asset(
                "root/Pack A / imported import-title.png",
                "import-title.png",
            ),
            prepared_asset(
                "root/Pack B / imported import-cover.mp3",
                "import-cover.mp3",
            ),
            prepared_asset(
                "root/Pack B / imported import-cover.png",
                "import-cover.png",
            ),
            prepared_asset("root/Pack B / imported import-menu.mp3", "import-menu.mp3"),
            prepared_asset("root/Pack B / imported import-menu.png", "import-menu.png"),
            prepared_asset(
                "root/Pack B / imported import-title.mp3",
                "import-title.mp3",
            ),
            prepared_asset(
                "root/Pack B / imported import-title.png",
                "import-title.png",
            ),
        ],
        vec![
            imported_zip_bundle(
                "root/Pack A/zip",
                "import-cover",
                "import-root-action",
                "import-menu",
                "import-cover",
                imported.clone(),
            ),
            imported_zip_bundle(
                "root/Pack B/zip",
                "import-cover",
                "import-root-action",
                "import-menu",
                "import-cover",
                imported,
            ),
        ],
    );

    let document = build_story_document(&report).expect("multiple imported zips");
    let pack_a_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Pack A")
        .expect("wrapper Pack A");
    let pack_b_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Pack B")
        .expect("wrapper Pack B");

    assert!(pack_a_stage.control_settings.wheel);
    assert!(!pack_a_stage.control_settings.autoplay);
    assert!(pack_b_stage.control_settings.wheel);
    assert!(!pack_b_stage.control_settings.autoplay);
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "Debut")
            .count(),
        0
    );

    let mut incoming_counts: HashMap<&str, usize> = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), 0))
        .collect();
    for action in &document.action_nodes {
        for option in &action.options {
            if let Some(count) = incoming_counts.get_mut(option.as_str()) {
                *count += 1;
            }
        }
    }
    let orphaned_stages: Vec<&str> = document
        .stage_nodes
        .iter()
        .filter(|stage| {
            !stage.square_one
                && incoming_counts
                    .get(stage.uuid.as_str())
                    .copied()
                    .unwrap_or_default()
                    == 0
        })
        .map(|stage| stage.name.as_str())
        .collect();
    assert!(
        orphaned_stages.is_empty(),
        "unexpected orphaned stages: {:?}",
        orphaned_stages
    );

    let mut action_incoming_counts: HashMap<&str, usize> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), 0))
        .collect();
    for stage in &document.stage_nodes {
        for transition in [stage.ok_transition.as_ref(), stage.home_transition.as_ref()]
            .into_iter()
            .flatten()
        {
            if let Some(count) = action_incoming_counts.get_mut(transition.action_node.as_str()) {
                *count += 1;
            }
        }
    }
    let orphaned_actions: Vec<&str> = document
        .action_nodes
        .iter()
        .filter(|action| {
            action_incoming_counts
                .get(action.id.as_str())
                .copied()
                .unwrap_or_default()
                == 0
        })
        .map(|action| action.name.as_str())
        .collect();
    assert!(
        orphaned_actions.is_empty(),
        "unexpected orphaned actions: {:?}",
        orphaned_actions
    );
}

#[test]
fn omits_menu_image_when_auto_black_image_is_enabled() {
    let report = report_for(
        CanonicalProject {
            name: "No image menu".to_string(),
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
            },
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Menu sans image".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: true,
                children: vec![CanonicalEntry::Story(CanonicalStory {
                    name: "Story".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("item.mp3".to_string()),
                    item_image: Some("item.png".to_string()),
                    ..Default::default()
                })],
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Menu sans image/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu sans image/Story/itemAudio", "item.mp3"),
            prepared_asset("root/Menu sans image/Story/itemImage", "item.png"),
            prepared_asset("root/Menu sans image/Story/storyAudio", "story.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("auto black menu document");
    let menu_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Menu sans image")
        .expect("menu stage");

    assert!(menu_stage.image.is_none());
    assert!(menu_stage.control_settings.autoplay);
}

#[test]
fn builds_regular_imported_zip_under_root() {
    let imported = StoryDocument {
        title: "Imported".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["import-menu".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "import-menu-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["import-title".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "import-play-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["import-play".to_string()],
                position: zero_position(),
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: "Cover node".to_string(),
                stage_type: "stage".to_string(),
                square_one: true,
                audio: Some("import-cover.mp3".to_string()),
                image: Some("import-cover.png".to_string()),
                control_settings: ControlSettings {
                    wheel: true,
                    ok: true,
                    home: false,
                    pause: false,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: Some(transition("import-root-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "import-menu".to_string(),
                name: "Imported menu".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("import-menu.mp3".to_string()),
                image: Some("import-menu.png".to_string()),
                control_settings: ControlSettings {
                    wheel: false,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: true,
                },
                home_transition: None,
                ok_transition: Some(transition("import-menu-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "import-title".to_string(),
                name: "Imported title".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("import-item.mp3".to_string()),
                image: Some("import-item.png".to_string()),
                control_settings: ControlSettings {
                    wheel: true,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: false,
                },
                home_transition: Some(transition("import-root-action", 0)),
                ok_transition: Some(transition("import-play-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "import-play".to_string(),
                name: "Imported play".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("import-story.mp3".to_string()),
                image: None,
                control_settings: playback_controls(),
                home_transition: Some(transition("import-menu-action", 0)),
                ok_transition: Some(transition("import-menu-action", 0)),
                position: zero_position(),
            },
        ],
    };

    let report = report_for(
        CanonicalProject {
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
            },
            entries: vec![CanonicalEntry::Zip(CanonicalZip {
                name: "Imported pack".to_string(),
                zip_path: Some("imported.zip".to_string()),
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset(
                "root/Imported pack / imported import-cover.mp3",
                "import-cover.mp3",
            ),
            prepared_asset(
                "root/Imported pack / imported import-cover.png",
                "import-cover.png",
            ),
            prepared_asset(
                "root/Imported pack / imported import-menu.mp3",
                "import-menu.mp3",
            ),
            prepared_asset(
                "root/Imported pack / imported import-menu.png",
                "import-menu.png",
            ),
            prepared_asset(
                "root/Imported pack / imported import-item.mp3",
                "import-item.mp3",
            ),
            prepared_asset(
                "root/Imported pack / imported import-item.png",
                "import-item.png",
            ),
            prepared_asset(
                "root/Imported pack / imported import-story.mp3",
                "import-story.mp3",
            ),
        ],
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-menu",
            "import-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("regular imported zip");
    let imported_cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Cover node" && !stage.square_one)
        .expect("imported cover");
    let imported_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Imported menu")
        .expect("imported menu");
    let imported_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Imported title")
        .expect("imported title");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![imported_cover.uuid.clone()])
        .expect("root action");
    let imported_root_action = document
        .action_nodes
        .iter()
        .find(|action| {
            action.id != root_action.id && action.options == vec![imported_menu.uuid.clone()]
        })
        .expect("imported root action");

    assert_eq!(
        imported_cover
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(imported_root_action.id.as_str())
    );
    assert!(imported_cover.home_transition.is_none());
    assert!(!imported_menu.square_one);
    assert_eq!(
        imported_menu
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        imported_menu
            .home_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(0)
    );
    assert_eq!(
        imported_title
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(imported_root_action.id.as_str())
    );
}

#[test]
fn builds_collection_import_without_extra_square_one() {
    let imported = StoryDocument {
        title: "Collection".to_string(),
        version: 1,
        description: String::new(),
        format: "v1".to_string(),
        night_mode_available: false,
        action_nodes: vec![
            ActionNode {
                id: "collection-root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["collection-menu".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "collection-menu-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["child-cover".to_string()],
                position: zero_position(),
            },
            ActionNode {
                id: "child-root-action".to_string(),
                name: "Action node".to_string(),
                options: vec!["child-story".to_string()],
                position: zero_position(),
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "collection-cover".to_string(),
                name: "Cover node".to_string(),
                stage_type: "stage".to_string(),
                square_one: true,
                audio: Some("collection-cover.mp3".to_string()),
                image: Some("collection-cover.png".to_string()),
                control_settings: ControlSettings {
                    wheel: true,
                    ok: true,
                    home: false,
                    pause: false,
                    autoplay: false,
                },
                home_transition: None,
                ok_transition: Some(transition("collection-root-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "collection-menu".to_string(),
                name: "Collection menu".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("collection-menu.mp3".to_string()),
                image: Some("collection-menu.png".to_string()),
                control_settings: ControlSettings {
                    wheel: false,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: true,
                },
                home_transition: None,
                ok_transition: Some(transition("collection-menu-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "child-cover".to_string(),
                name: "Cover node".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("child-cover.mp3".to_string()),
                image: Some("child-cover.png".to_string()),
                control_settings: ControlSettings {
                    wheel: true,
                    ok: true,
                    home: true,
                    pause: false,
                    autoplay: false,
                },
                home_transition: Some(transition("collection-root-action", 0)),
                ok_transition: Some(transition("child-root-action", 0)),
                position: zero_position(),
            },
            StageNode {
                uuid: "child-story".to_string(),
                name: "Child story".to_string(),
                stage_type: "stage".to_string(),
                square_one: false,
                audio: Some("child-story.mp3".to_string()),
                image: None,
                control_settings: simple_story_controls(),
                home_transition: Some(transition("collection-menu-action", 0)),
                ok_transition: None,
                position: zero_position(),
            },
        ],
    };

    let report = report_for(
        CanonicalProject {
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
            },
            entries: vec![CanonicalEntry::Zip(CanonicalZip {
                name: "Collection import".to_string(),
                zip_path: Some("collection.zip".to_string()),
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset(
                "root/Collection import / imported collection-cover.mp3",
                "collection-cover.mp3",
            ),
            prepared_asset(
                "root/Collection import / imported collection-cover.png",
                "collection-cover.png",
            ),
            prepared_asset(
                "root/Collection import / imported collection-menu.mp3",
                "collection-menu.mp3",
            ),
            prepared_asset(
                "root/Collection import / imported collection-menu.png",
                "collection-menu.png",
            ),
            prepared_asset(
                "root/Collection import / imported child-cover.mp3",
                "child-cover.mp3",
            ),
            prepared_asset(
                "root/Collection import / imported child-cover.png",
                "child-cover.png",
            ),
            prepared_asset(
                "root/Collection import / imported child-story.mp3",
                "child-story.mp3",
            ),
        ],
        vec![imported_zip_bundle(
            "root/Collection import/zip",
            "collection-cover",
            "collection-root-action",
            "collection-menu",
            "collection-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("collection imported zip");
    let collection_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Collection menu")
        .expect("collection menu");
    let child_cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.audio.as_deref() == Some("child-cover.mp3"))
        .expect("child cover");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![collection_menu.uuid.clone()])
        .expect("root action");

    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.square_one)
            .count(),
        1
    );
    assert!(document
        .stage_nodes
        .iter()
        .all(|stage| stage.uuid != "collection-cover"));
    assert_eq!(
        child_cover
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        child_cover
            .home_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(0)
    );
}
