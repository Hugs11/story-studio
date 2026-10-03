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
                end_message_autoplay: true,
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
        .find(|stage| stage.label() == "Cache cache")
        .expect("root menu stage");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Histoire - Inside menu" && stage.image.has_no_value())
        .expect("inside menu play stage");
    // Root action has two options: standalone story title (index 0) and Cache cache menu (index 1).
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| {
            action
                .named_options()
                .any(|option| option == menu_stage.uuid)
        })
        .expect("root action");

    assert!(menu_stage.control_settings.wheel());
    assert!(!menu_stage.control_settings.autoplay());
    // After playback: return directly to Cache cache menu stage (index 1 in root action),
    // matching the UI's resolveReturnTarget fallback → parentMenu.id.
    assert_eq!(
        play_stage
            .home_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .value()
            .map(|transition| transition.selection),
        Some(OptionSelection::Fixed(1))
    );
    assert!(play_stage.control_settings.autoplay());
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
                end_message_autoplay: true,
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
        .find(|stage| stage.is_square_one())
        .expect("cover stage");
    let root_choice_action = document
        .action_nodes
        .iter()
        .find(|action| action.options.len() == 2)
        .expect("root choice action");

    assert_eq!(
        cover
            .ok_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(root_choice_action.id.as_str())
    );
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.label() == "Root zip pack" && !stage.is_square_one())
            .count(),
        0
    );
}

#[test]
fn wraps_imported_zips_when_multiple_root_entries_are_selectable() {
    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["import-menu".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
            ActionNode {
                id: "import-menu-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["import-title".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Debut".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                audio: Presence::Value("import-cover.mp3".to_string()),
                image: Presence::Value("import-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-menu".to_string(),
                name: Presence::Value("Quel épisode veux-tu écouter".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("import-menu.mp3".to_string()),
                image: Presence::Value("import-menu.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, true, false, true,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-menu-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-title".to_string(),
                name: Presence::Value("1".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("import-title.mp3".to_string()),
                image: Presence::Value("import-title.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, false, true, false, false,
                )),
                home_transition: Presence::Value(transition("import-root-action", 0)),
                ok_transition: Presence::Null,
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
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
                end_message_autoplay: true,
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
        .find(|stage| stage.label() == "Pack A")
        .expect("wrapper Pack A");
    let pack_b_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Pack B")
        .expect("wrapper Pack B");

    assert!(pack_a_stage.control_settings.wheel());
    assert!(!pack_a_stage.control_settings.autoplay());
    assert!(pack_a_stage.home_transition.has_no_value());
    assert!(pack_b_stage.control_settings.wheel());
    assert!(!pack_b_stage.control_settings.autoplay());
    assert!(pack_b_stage.home_transition.has_no_value());
    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.label() == "Debut")
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
            if let Some(count) = option
                .as_deref()
                .and_then(|option| incoming_counts.get_mut(option))
            {
                *count += 1;
            }
        }
    }
    let orphaned_stages: Vec<&str> = document
        .stage_nodes
        .iter()
        .filter(|stage| {
            !stage.is_square_one()
                && incoming_counts
                    .get(stage.uuid.as_str())
                    .copied()
                    .unwrap_or_default()
                    == 0
        })
        .map(|stage| stage.label())
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
        for transition in [stage.ok_transition.value(), stage.home_transition.value()]
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
        .map(|action| action.label())
        .collect();
    assert!(
        orphaned_actions.is_empty(),
        "unexpected orphaned actions: {:?}",
        orphaned_actions
    );
    validate_document_for_studio_compat(&document)
        .expect("STUdio-compatible direct root ZIP aggregation");
}

#[test]
fn imported_zip_wrapper_inside_menu_returns_home_to_parent_selector() {
    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![ActionNode {
            id: "import-root-action".to_string(),
            name: Presence::Value("Action node".to_string()),
            options: named_option_targets(vec!["import-content".to_string()]),
            position: no_authored_position(),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
        }],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Imported cover".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                audio: Presence::Null,
                image: Presence::Null,
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-content".to_string(),
                name: Presence::Value("Imported content".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Null,
                image: Presence::Null,
                control_settings: Presence::Value(simple_story_controls()),
                home_transition: Presence::Null,
                ok_transition: Presence::Null,
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
    };

    let report = report_for(
        CanonicalProject {
            name: "Nested imported ZIP".to_string(),
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Parent selector".to_string(),
                audio: Some("menu.mp3".to_string()),
                auto_black_image: true,
                children: vec![CanonicalEntry::Zip(CanonicalZip {
                    name: "Imported child".to_string(),
                    zip_path: Some("imported.zip".to_string()),
                    ..Default::default()
                })],
                ..Default::default()
            })],
            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Parent selector/menuAudio", "menu.mp3"),
        ],
        vec![imported_zip_bundle(
            "root/Parent selector/Imported child/zip",
            "import-cover",
            "import-root-action",
            "import-content",
            "import-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("nested imported ZIP document");
    let parent = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Parent selector")
        .expect("parent selector stage");
    let wrapper = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported child")
        .expect("imported ZIP wrapper");
    let imported_content = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported content")
        .expect("imported ZIP content");
    let home = wrapper
        .home_transition
        .value()
        .expect("wrapper Home transition");
    let home_target = document
        .action_nodes
        .iter()
        .find(|action| action.id == home.action_node)
        .and_then(|action| {
            action
                .options
                .get(home.selection.fixed_index().expect("sélection fixe"))
        })
        .expect("wrapper Home target");

    assert_eq!(home_target.as_deref(), Some(parent.uuid.as_str()));
    assert_ne!(home_target.as_deref(), Some(wrapper.uuid.as_str()));

    let content_home = imported_content
        .home_transition
        .value()
        .expect("imported content Home transition");
    let content_home_target = document
        .action_nodes
        .iter()
        .find(|action| action.id == content_home.action_node)
        .and_then(|action| {
            action.options.get(
                content_home
                    .selection
                    .fixed_index()
                    .expect("sélection fixe"),
            )
        })
        .expect("imported content Home target");
    assert_eq!(content_home_target.as_deref(), Some(wrapper.uuid.as_str()));
    validate_document_for_studio_compat(&document).expect("STUdio-compatible nested ZIP wrapper");
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
                end_message_autoplay: true,
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
        .find(|stage| stage.label() == "Menu sans image")
        .expect("menu stage");

    assert!(menu_stage.image.has_no_value());
    assert!(menu_stage.control_settings.autoplay());
}

#[test]
fn builds_regular_imported_zip_under_root() {
    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["import-menu".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
            ActionNode {
                id: "import-menu-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["import-title".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
            ActionNode {
                id: "import-play-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["import-play".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Cover node".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                audio: Presence::Value("import-cover.mp3".to_string()),
                image: Presence::Value("import-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-menu".to_string(),
                name: Presence::Value("Imported menu".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("import-menu.mp3".to_string()),
                image: Presence::Value("import-menu.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, true, false, true,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-menu-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-title".to_string(),
                name: Presence::Value("Imported title".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("import-item.mp3".to_string()),
                image: Presence::Value("import-item.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, true, false, false,
                )),
                home_transition: Presence::Value(transition("import-root-action", 0)),
                ok_transition: Presence::Value(transition("import-play-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "import-play".to_string(),
                name: Presence::Value("Imported play".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("import-story.mp3".to_string()),
                image: Presence::Null,
                control_settings: Presence::Value(playback_controls()),
                home_transition: Presence::Value(transition("import-menu-action", 0)),
                ok_transition: Presence::Value(transition("import-menu-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
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
                end_message_autoplay: true,
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
    assert_free_document_passes_gates(&report, &document);
    let imported_cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Cover node" && !stage.is_square_one())
        .expect("imported cover");
    let imported_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported menu")
        .expect("imported menu");
    let imported_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported title")
        .expect("imported title");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![Some(imported_cover.uuid.clone())])
        .expect("root action");
    let imported_root_action = document
        .action_nodes
        .iter()
        .find(|action| {
            action.id != root_action.id && action.options == vec![Some(imported_menu.uuid.clone())]
        })
        .expect("imported root action");

    assert_eq!(
        imported_cover
            .ok_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(imported_root_action.id.as_str())
    );
    assert!(imported_cover.home_transition.has_no_value());
    assert!(!imported_menu.is_square_one());
    assert_eq!(
        imported_menu
            .home_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        imported_menu
            .home_transition
            .value()
            .map(|transition| transition.selection),
        Some(OptionSelection::Fixed(0))
    );
    assert_eq!(
        imported_title
            .home_transition
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(imported_root_action.id.as_str())
    );
}

#[test]
fn builds_collection_import_without_extra_square_one() {
    let imported = StoryDocument {
        title: Presence::Value("Collection".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        action_nodes: vec![
            ActionNode {
                id: "collection-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["collection-menu".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
            ActionNode {
                id: "collection-menu-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["child-cover".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
            ActionNode {
                id: "child-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                options: named_option_targets(vec!["child-story".to_string()]),
                position: no_authored_position(),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "collection-cover".to_string(),
                name: Presence::Value("Cover node".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                audio: Presence::Value("collection-cover.mp3".to_string()),
                image: Presence::Value("collection-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("collection-root-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "collection-menu".to_string(),
                name: Presence::Value("Collection menu".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("collection-menu.mp3".to_string()),
                image: Presence::Value("collection-menu.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, true, false, true,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("collection-menu-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "child-cover".to_string(),
                name: Presence::Value("Cover node".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("child-cover.mp3".to_string()),
                image: Presence::Value("child-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    true, true, true, false, false,
                )),
                home_transition: Presence::Value(transition("collection-root-action", 0)),
                ok_transition: Presence::Value(transition("child-root-action", 0)),
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
            StageNode {
                uuid: "child-story".to_string(),
                name: Presence::Value("Child story".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                audio: Presence::Value("child-story.mp3".to_string()),
                image: Presence::Null,
                control_settings: Presence::Value(simple_story_controls()),
                home_transition: Presence::Value(transition("collection-menu-action", 0)),
                ok_transition: Presence::Null,
                position: no_authored_position(),
                group_id: Presence::Absent,
            },
        ],
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
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
                end_message_autoplay: true,
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
        .find(|stage| stage.label() == "Collection menu")
        .expect("collection menu");
    let child_cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.audio.as_deref() == Some("child-cover.mp3"))
        .expect("child cover");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![Some(collection_menu.uuid.clone())])
        .expect("root action");

    assert_eq!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.is_square_one())
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
            .value()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        child_cover
            .home_transition
            .value()
            .map(|transition| transition.selection),
        Some(OptionSelection::Fixed(0))
    );
}

/// Le chemin ZIP incorporé clone réellement les Stages et Actions du document
/// source (`builder/imported_zip.rs`). Les champs enrichis et la position
/// d'auteur de la source doivent survivre à ce clonage, et l'absence de
/// position sur un nœud source doit rester une absence — pas un `{0,0}`
/// synthétisé au passage.
#[test]
fn an_embedded_zip_keeps_the_enriched_fields_and_authored_positions_of_its_source() {
    let controls = ControlSettings::authored(false, false, true, false, false);
    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
        action_nodes: vec![ActionNode {
            id: "import-root-action".to_string(),
            name: Presence::Value("Action node".to_string()),
            action_type: Presence::Value("type-action-source".to_string()),
            group_id: Presence::Value("groupe-source".to_string()),
            options: named_option_targets(vec!["import-story".to_string()]),
            position: Presence::Value(Position {
                x: serde_json::Number::from_f64(12.5).expect("x"),
                y: serde_json::Number::from(-8),
            }),
        }],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Debut".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                group_id: Presence::Absent,
                audio: Presence::Value("import-cover.mp3".to_string()),
                image: Presence::Value("import-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: Presence::Absent,
            },
            StageNode {
                uuid: "import-story".to_string(),
                name: Presence::Value("Histoire importée".to_string()),
                stage_type: Presence::Value("type-stage-source".to_string()),
                square_one: Presence::Value(false),
                group_id: Presence::Value("groupe-source".to_string()),
                audio: Presence::Value("import-story.mp3".to_string()),
                image: Presence::Null,
                control_settings: Presence::Value(controls),
                home_transition: Presence::Absent,
                ok_transition: Presence::Null,
                position: Presence::Value(Position {
                    x: serde_json::Number::from_f64(-990.4606467901111).expect("x"),
                    y: serde_json::Number::from(240),
                }),
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
                end_message_autoplay: true,
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
                "root/Imported pack / imported import-story.mp3",
                "import-story.mp3",
            ),
        ],
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-story",
            "import-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("document avec ZIP incorporé");
    assert_free_document_passes_gates(&report, &document);
    let cloned = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Histoire importée")
        .expect("stage cloné du ZIP");

    assert_eq!(cloned.group_id.as_deref(), Some("groupe-source"));
    assert_eq!(cloned.stage_type.as_deref(), Some("type-stage-source"));
    assert_eq!(
        cloned
            .position
            .value()
            .and_then(|position| position.x.as_f64())
            .map(f64::to_bits),
        Some((-990.4606467901111_f64).to_bits()),
        "la position d'auteur du ZIP source doit survivre au clonage, à la valeur près"
    );
    assert!(
        matches!(cloned.image, Presence::Null),
        "un `image: null` source reste `null`, pas une absence"
    );
    assert!(
        cloned.home_transition.is_absent() || cloned.home_transition.is_value(),
        "une transition Home absente ne doit pas devenir un `null` inventé"
    );

    let cloned_action = document
        .action_nodes
        .iter()
        .find(|action| action.group_id.is_value())
        .expect("action clonée du ZIP");
    assert_eq!(cloned_action.group_id.as_deref(), Some("groupe-source"));
    assert_eq!(
        cloned_action.action_type.as_deref(),
        Some("type-action-source")
    );
    assert_eq!(
        cloned_action
            .position
            .value()
            .and_then(|position| position.x.as_f64()),
        Some(12.5)
    );

    // Le stage de couverture importé n'avait pas de position : le builder n'en
    // invente pas une pour lui.
    let cloned_cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Debut")
        .expect("couverture clonée");
    assert!(cloned_cover.position.is_absent());
}

/// Le chemin ZIP incorporé remappe les identifiants d'Action mais
/// **recopie la sélection**. Une transition `Random` du pack source doit rester
/// `Random` dans le pack produit, et ne pas devenir `Fixed(0)` au passage.
#[test]
fn an_embedded_zip_keeps_a_random_selection_of_its_source() {
    let controls = ControlSettings::authored(true, true, false, false, false);
    let leaf = |uuid: &str, name: &str, audio: &str| StageNode {
        uuid: uuid.to_string(),
        name: Presence::Value(name.to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(false),
        group_id: Presence::Absent,
        audio: Presence::Value(audio.to_string()),
        image: Presence::Null,
        control_settings: Presence::Value(simple_story_controls()),
        home_transition: Presence::Null,
        ok_transition: Presence::Null,
        position: Presence::Absent,
    };
    let mut random_stage = StageNode {
        uuid: "import-story".to_string(),
        name: Presence::Value("Histoire aléatoire".to_string()),
        stage_type: Presence::Value("stage".to_string()),
        square_one: Presence::Value(false),
        group_id: Presence::Absent,
        audio: Presence::Value("import-story.mp3".to_string()),
        image: Presence::Null,
        control_settings: Presence::Value(controls),
        home_transition: Presence::Null,
        ok_transition: Presence::Value(transition("import-choice", 0)),
        position: Presence::Absent,
    };
    random_stage
        .ok_transition
        .value_mut()
        .expect("transition OK")
        .selection = OptionSelection::Random;

    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
        action_nodes: vec![
            ActionNode {
                id: "import-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec!["import-story".to_string()]),
                position: Presence::Absent,
            },
            ActionNode {
                id: "import-choice".to_string(),
                name: Presence::Value("Choix aléatoire".to_string()),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec!["import-a".to_string(), "import-b".to_string()]),
                position: Presence::Absent,
            },
        ],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Debut".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                group_id: Presence::Absent,
                audio: Presence::Value("import-cover.mp3".to_string()),
                image: Presence::Value("import-cover.png".to_string()),
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: Presence::Absent,
            },
            random_stage,
            leaf("import-a", "Branche A", "import-a.mp3"),
            leaf("import-b", "Branche B", "import-b.mp3"),
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
                end_message_autoplay: true,
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
                "root/Imported pack / imported import-story.mp3",
                "import-story.mp3",
            ),
            prepared_asset("root/Imported pack / imported import-a.mp3", "import-a.mp3"),
            prepared_asset("root/Imported pack / imported import-b.mp3", "import-b.mp3"),
        ],
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-story",
            "import-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("document avec ZIP incorporé");
    let cloned = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Histoire aléatoire")
        .expect("stage cloné du ZIP");
    assert_eq!(
        cloned.ok_transition.value().map(|t| t.selection),
        Some(OptionSelection::Random),
        "la sentinelle du ZIP source doit survivre au remappage d'identifiants"
    );

    // Et jusqu'au `story.json` réellement écrit : `-1`, pas `0`.
    let emitted = serde_json::to_value(&document).expect("sérialisation");
    let stage = emitted["stageNodes"]
        .as_array()
        .expect("stages")
        .iter()
        .find(|stage| stage["name"] == serde_json::json!("Histoire aléatoire"))
        .expect("stage émis");
    assert_eq!(stage["okTransition"]["optionIndex"], serde_json::json!(-1));
}

/// Les deux emplacements d'un ZIP incorporé dont un Stage **omet** `audio` et
/// `image`, jusqu'au `story.json` réellement écrit par le writer.
///
/// Ces champs étaient autrefois des `Option<String>` sans `skip_serializing_if` :
/// une omission source ressortait à `null` dans le pack. Avec `Presence`, la
/// clé disparaît du pack et STUdio figé lève une `NullPointerException`
/// (`ArchiveStoryPackReader.java:200-210`). Le document d'auteur, lui, doit
/// continuer à distinguer l'omission du `null`.
#[test]
fn an_embedded_zip_omitting_media_keeps_the_omission_but_never_drops_the_pack_keys() {
    fn imported_document() -> StoryDocument {
        StoryDocument {
            title: Presence::Value("Imported".to_string()),
            version: Presence::Value(1),
            description: Presence::Value(String::new()),
            format: Presence::Value("v1".to_string()),
            night_mode_available: Presence::Value(false),
            uuid: Presence::Absent,
            factory_disabled: Presence::Absent,
            action_nodes: vec![ActionNode {
                id: "import-root-action".to_string(),
                name: Presence::Value("Action node".to_string()),
                action_type: Presence::Absent,
                group_id: Presence::Absent,
                options: named_option_targets(vec!["import-content".to_string()]),
                position: no_authored_position(),
            }],
            stage_nodes: vec![
                StageNode {
                    uuid: "import-cover".to_string(),
                    name: Presence::Value("Imported cover".to_string()),
                    stage_type: Presence::Value("stage".to_string()),
                    square_one: Presence::Value(true),
                    group_id: Presence::Absent,
                    audio: Presence::Null,
                    image: Presence::Null,
                    control_settings: Presence::Value(ControlSettings::authored(
                        false, true, false, false, false,
                    )),
                    home_transition: Presence::Null,
                    ok_transition: Presence::Value(transition("import-root-action", 0)),
                    position: no_authored_position(),
                },
                StageNode {
                    uuid: "import-content".to_string(),
                    name: Presence::Value("Imported content".to_string()),
                    stage_type: Presence::Value("stage".to_string()),
                    square_one: Presence::Value(false),
                    group_id: Presence::Absent,
                    // Le pack source n'a écrit ni `audio` ni `image` : c'est
                    // l'omission, que `Presence` rend représentable.
                    audio: Presence::Absent,
                    image: Presence::Absent,
                    control_settings: Presence::Value(simple_story_controls()),
                    home_transition: Presence::Null,
                    ok_transition: Presence::Null,
                    position: no_authored_position(),
                },
            ],
        }
    }

    let root_report = report_for(
        CanonicalProject {
            name: "Imported at root".to_string(),
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
        ],
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-content",
            "import-cover",
            imported_document(),
        )],
    );

    let menu_report = report_for(
        CanonicalProject {
            name: "Imported under a menu".to_string(),
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Parent selector".to_string(),
                audio: Some("menu.mp3".to_string()),
                auto_black_image: true,
                children: vec![CanonicalEntry::Zip(CanonicalZip {
                    name: "Imported child".to_string(),
                    zip_path: Some("imported.zip".to_string()),
                    ..Default::default()
                })],
                ..Default::default()
            })],
            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Parent selector/menuAudio", "menu.mp3"),
        ],
        vec![imported_zip_bundle(
            "root/Parent selector/Imported child/zip",
            "import-cover",
            "import-root-action",
            "import-content",
            "import-cover",
            imported_document(),
        )],
    );

    for (label, report) in [("racine", root_report), ("menu", menu_report)] {
        let document = build_story_document(&report)
            .unwrap_or_else(|error| panic!("{label} : document avec ZIP incorporé : {error}"));
        validate_document_for_studio_compat(&document)
            .unwrap_or_else(|error| panic!("{label} : {error}"));

        let cloned = document
            .stage_nodes
            .iter()
            .find(|stage| stage.label() == "Imported content")
            .unwrap_or_else(|| panic!("{label} : stage cloné du ZIP"));
        assert!(
            cloned.audio.is_absent() && cloned.image.is_absent(),
            "{label} : l'auteur doit conserver l'omission source, pas un `null` inventé"
        );

        let raw = super::super::writer::serialize_story_with_pack_uuid(
            &document,
            "11111111-2222-3333-4444-555566667777",
        )
        .unwrap_or_else(|error| panic!("{label} : {error}"));
        let story: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{label} : {error}"));

        for (index, stage) in story["stageNodes"]
            .as_array()
            .unwrap_or_else(|| panic!("{label} : stageNodes"))
            .iter()
            .enumerate()
        {
            for key in ["audio", "image"] {
                assert!(
                    stage.get(key).is_some(),
                    "{label} : stageNodes[{index}] sans propriété '{key}' : STUdio déréférence la clé absente"
                );
            }
        }

        let emitted = story["stageNodes"]
            .as_array()
            .expect("stageNodes")
            .iter()
            .find(|stage| stage["name"] == serde_json::json!("Imported content"))
            .unwrap_or_else(|| panic!("{label} : stage cloné dans le pack"));
        assert!(
            emitted["audio"].is_null(),
            "{label} : audio omis émis à null"
        );
        assert!(
            emitted["image"].is_null(),
            "{label} : image omise émise à null"
        );
    }
}

/// Un `controlSettings` incomplet est conservé par l'auteur, mais le pack Libre
/// ne peut pas l'émettre. Le writer refuse avec un message localisé au lieu
/// d'inventer le contrôle manquant — les deux passerelles figées lisent les
/// cinq membres sans garde.
#[test]
fn an_embedded_zip_with_incomplete_controls_is_kept_but_refused_by_the_pack_writer() {
    let mut incomplete = ControlSettings::authored(false, false, true, false, false);
    incomplete.pause = Presence::Absent;

    let imported = StoryDocument {
        title: Presence::Value("Imported".to_string()),
        version: Presence::Value(1),
        description: Presence::Value(String::new()),
        format: Presence::Value("v1".to_string()),
        night_mode_available: Presence::Value(false),
        uuid: Presence::Absent,
        factory_disabled: Presence::Absent,
        action_nodes: vec![ActionNode {
            id: "import-root-action".to_string(),
            name: Presence::Value("Action node".to_string()),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
            options: named_option_targets(vec!["import-content".to_string()]),
            position: no_authored_position(),
        }],
        stage_nodes: vec![
            StageNode {
                uuid: "import-cover".to_string(),
                name: Presence::Value("Imported cover".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(true),
                group_id: Presence::Absent,
                audio: Presence::Null,
                image: Presence::Null,
                control_settings: Presence::Value(ControlSettings::authored(
                    false, true, false, false, false,
                )),
                home_transition: Presence::Null,
                ok_transition: Presence::Value(transition("import-root-action", 0)),
                position: no_authored_position(),
            },
            StageNode {
                uuid: "import-content".to_string(),
                name: Presence::Value("Imported content".to_string()),
                stage_type: Presence::Value("stage".to_string()),
                square_one: Presence::Value(false),
                group_id: Presence::Absent,
                audio: Presence::Null,
                image: Presence::Null,
                // `pause` n'a jamais été écrit par la source.
                control_settings: Presence::Value(incomplete),
                home_transition: Presence::Null,
                ok_transition: Presence::Null,
                position: no_authored_position(),
            },
        ],
    };

    let report = report_for(
        CanonicalProject {
            name: "Imported with partial controls".to_string(),
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
        ],
        vec![imported_zip_bundle(
            "root/Imported pack/zip",
            "import-cover",
            "import-root-action",
            "import-content",
            "import-cover",
            imported,
        )],
    );

    let document = build_story_document(&report).expect("document avec contrôles partiels");
    let cloned = document
        .stage_nodes
        .iter()
        .find(|stage| stage.label() == "Imported content")
        .expect("stage cloné du ZIP");
    assert_eq!(
        cloned
            .control_settings
            .value()
            .expect("objet conservé")
            .pause,
        Presence::Absent,
        "l'auteur conserve l'absence : elle n'est ni complétée ni transformée en false"
    );

    let error = super::super::writer::serialize_story_with_pack_uuid(
        &document,
        "11111111-2222-3333-4444-555566667777",
    )
    .expect_err("le pack ne peut pas être écrit avec des contrôles incomplets");
    assert!(error.contains("Contrôles incomplets"), "{error}");
    assert!(error.contains("Imported content"), "{error}");

    // Le même document, une fois les cinq contrôles renseignés, s'écrit.
    let mut completed = document.clone();
    for stage in &mut completed.stage_nodes {
        if let Some(controls) = stage.control_settings.value_mut() {
            if controls.pause.is_absent() {
                controls.pause = Presence::Value(false);
            }
        }
    }
    let raw = super::super::writer::serialize_story_with_pack_uuid(
        &completed,
        "11111111-2222-3333-4444-555566667777",
    )
    .expect("pack complet sérialisable");
    let story: serde_json::Value = serde_json::from_str(&raw).expect("story.json valide");
    for stage in story["stageNodes"].as_array().expect("stageNodes") {
        for key in ["wheel", "ok", "home", "pause", "autoplay"] {
            assert!(
                stage["controlSettings"]
                    .get(key)
                    .is_some_and(|value| value.is_boolean()),
                "controlSettings.{key} doit être un booléen explicite dans le pack"
            );
        }
    }
}
