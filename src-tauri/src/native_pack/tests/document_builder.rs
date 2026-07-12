use super::*;

// Helpers de caracterisation structurelle d'un projet canonique. Anciennement
// dans native_pack/stats.rs au service du dry-run (commande retiree : jamais
// branchee au frontend ni testee). Conserves ici car les tests de
// canonicalisation ci-dessous verifient les compteurs (menus, stories,
// profondeur) comme garde-fou de la structure produite par canonicalize_project.
struct NativePackStats {
    root_entry_count: usize,
    menu_count: usize,
    story_count: usize,
    zip_count: usize,
    max_depth: usize,
}

fn collect_stats(entries: &[CanonicalEntry]) -> NativePackStats {
    let mut stats = NativePackStats {
        root_entry_count: entries.len(),
        menu_count: 0,
        story_count: 0,
        zip_count: 0,
        max_depth: if entries.is_empty() { 0 } else { 1 },
    };
    for entry in entries {
        walk_entry(entry, 1, &mut stats);
    }
    stats
}

fn walk_entry(entry: &CanonicalEntry, depth: usize, stats: &mut NativePackStats) {
    stats.max_depth = stats.max_depth.max(depth);
    match entry {
        CanonicalEntry::Menu(menu) => {
            stats.menu_count += 1;
            for child in &menu.children {
                walk_entry(child, depth + 1, stats);
            }
        }
        CanonicalEntry::Story(_) => stats.story_count += 1,
        CanonicalEntry::Zip(_) => stats.zip_count += 1,
        // Une référence n'ajoute aucun nœud propre à l'arbre (arête seulement).
        CanonicalEntry::Ref(_) => {}
    }
}

#[test]
fn builds_story_title_without_item_audio() {
    let project = CanonicalProject {
        name: "Missing item audio".to_string(),
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
        entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "story-id".to_string(),
            name: "Story Without Item Audio".to_string(),
            native_stage_id: None,
            audio: Some("story.mp3".to_string()),
            item_audio: None,
            item_image: Some("item.png".to_string()),
            after_playback_prompt_audio: None,
            after_playback_prompt_control_settings: None,
            after_playback_prompt_ok_target: None,
            after_playback_prompt_home_target: None,
            after_playback_prompt_home_none: false,
            after_playback_sequence: Vec::new(),
            after_playback_home_step: None,
            wheel: false,
            ok: false,
            home: true,
            pause: true,
            autoplay: true,
            return_after_play: None,
            return_on_home: None,
            return_on_home_none: false,
            title_return_on_home: None,
            title_return_on_home_none: false,
            title_control_settings: Some(crate::domain::project::EntryControlSettings {
                autoplay: Some(false),
                wheel: Some(true),
                pause: Some(false),
                ok: Some(true),
                home: Some(true),
            }),
        })],

        shared_entries: Vec::new(),
    };
    let report = report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset(
                "root/Story Without Item Audio#story-id/storyAudio",
                "story.mp3",
            ),
            prepared_asset(
                "root/Story Without Item Audio#story-id/itemImage",
                "item.png",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("story document");
    let title_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Story Without Item Audio")
        .expect("title stage");

    assert_eq!(title_stage.audio, None);
    assert_eq!(title_stage.image.as_deref(), Some("item.png"));
    assert!(title_stage.control_settings.wheel);
    assert!(title_stage.control_settings.ok);
    assert!(title_stage.control_settings.home);
    assert!(!title_stage.control_settings.pause);
    assert!(!title_stage.control_settings.autoplay);
    assert_eq!(
        serde_json::to_value(title_stage).expect("serialize title stage")["audio"],
        serde_json::Value::Null,
    );
    assert!(title_stage.ok_transition.is_some());
}

#[test]
fn root_ref_can_target_shared_story() {
    let shared_label = scoped_label_id("shared", "shared-story", "Shared Story");
    let project = CanonicalProject {
        name: "Shared story".to_string(),
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
        entries: vec![CanonicalEntry::Ref(CanonicalRef {
            id: "ref-shared".to_string(),
            target: "story:shared-story".to_string(),
            ref_kind: Some("continue".to_string()),
        })],
        shared_entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "shared-story".to_string(),
            name: "Shared Story".to_string(),
            audio: Some("shared.mp3".to_string()),
            item_audio: Some("shared-title.mp3".to_string()),
            item_image: Some("shared.png".to_string()),
            ..Default::default()
        })],
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset(&format!("{shared_label}/storyAudio"), "shared.mp3"),
            prepared_asset(&format!("{shared_label}/itemAudio"), "shared-title.mp3"),
            prepared_asset(&format!("{shared_label}/itemImage"), "shared.png"),
        ],
        Vec::new(),
    ))
    .expect("shared ref document");

    let cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .expect("cover stage");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| {
            Some(action.id.as_str()) == cover.ok_transition.as_ref().map(|t| t.action_node.as_str())
        })
        .expect("root action");
    let target_stage_id = root_action.options.first().expect("root ref option");
    let target_stage = document
        .stage_nodes
        .iter()
        .find(|stage| &stage.uuid == target_stage_id)
        .expect("shared title stage");

    assert_eq!(target_stage.name, "Titre - Shared Story");
}

#[test]
fn imported_direct_story_stage_stays_combined() {
    let project = CanonicalProject {
        name: "Direct native story".to_string(),
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
        entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "direct".to_string(),
            name: "Direct".to_string(),
            native_stage_id: Some("native-direct".to_string()),
            audio: Some("direct.mp3".to_string()),
            autoplay: true,
            return_on_home_none: true,
            ..Default::default()
        })],
        shared_entries: Vec::new(),
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Direct#direct/storyAudio", "direct.mp3"),
        ],
        Vec::new(),
    ))
    .expect("direct native story document");

    assert!(document
        .stage_nodes
        .iter()
        .any(|stage| stage.name == "Direct"));
    assert!(!document
        .stage_nodes
        .iter()
        .any(|stage| stage.name == "Titre - Direct"));
    assert!(!document
        .stage_nodes
        .iter()
        .any(|stage| stage.name == "Histoire - Direct"));
}

#[test]
fn imported_title_home_story_play_targets_playback_stage() {
    let project = CanonicalProject {
        name: "Title home to play".to_string(),
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
            id: "menu".to_string(),
            name: "Menu".to_string(),
            audio: Some("menu.mp3".to_string()),
            auto_black_image: true,
            children: vec![
                CanonicalEntry::Story(CanonicalStory {
                    id: "source".to_string(),
                    name: "Source".to_string(),
                    audio: Some("source.mp3".to_string()),
                    item_audio: Some("source-title.mp3".to_string()),
                    item_image: Some("source.png".to_string()),
                    title_return_on_home: Some("story_play:target".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    id: "target".to_string(),
                    name: "Target".to_string(),
                    audio: Some("target.mp3".to_string()),
                    item_audio: Some("target-title.mp3".to_string()),
                    item_image: Some("target.png".to_string()),
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],
        shared_entries: Vec::new(),
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu#menu/Source#source/itemAudio", "source-title.mp3"),
            prepared_asset("root/Menu#menu/Source#source/itemImage", "source.png"),
            prepared_asset("root/Menu#menu/Source#source/storyAudio", "source.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemAudio", "target-title.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemImage", "target.png"),
            prepared_asset("root/Menu#menu/Target#target/storyAudio", "target.mp3"),
        ],
        Vec::new(),
    ))
    .expect("title home direct playback document");

    let source_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Source")
        .expect("source title");
    let target_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Target")
        .expect("target playback");
    let home_action = document
        .action_nodes
        .iter()
        .find(|action| {
            Some(action.id.as_str())
                == source_title
                    .home_transition
                    .as_ref()
                    .map(|transition| transition.action_node.as_str())
        })
        .expect("source title home action");

    assert_eq!(
        home_action
            .options
            .get(source_title.home_transition.as_ref().unwrap().option_index as usize)
            .map(String::as_str),
        Some(target_play.uuid.as_str())
    );
}

#[test]
fn imported_menu_home_story_play_targets_playback_stage() {
    let project = CanonicalProject {
        name: "Menu home to play".to_string(),
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
            id: "menu".to_string(),
            name: "Menu".to_string(),
            audio: Some("menu.mp3".to_string()),
            auto_black_image: true,
            return_on_home: Some("story_play:target".to_string()),
            children: vec![CanonicalEntry::Story(CanonicalStory {
                id: "target".to_string(),
                name: "Target".to_string(),
                audio: Some("target.mp3".to_string()),
                item_audio: Some("target-title.mp3".to_string()),
                item_image: Some("target.png".to_string()),
                ..Default::default()
            })],
            ..Default::default()
        })],
        shared_entries: Vec::new(),
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemAudio", "target-title.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemImage", "target.png"),
            prepared_asset("root/Menu#menu/Target#target/storyAudio", "target.mp3"),
        ],
        Vec::new(),
    ))
    .expect("menu home direct playback document");

    let menu_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Menu")
        .expect("menu stage");
    let target_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Target")
        .expect("target playback");
    let home_action = document
        .action_nodes
        .iter()
        .find(|action| {
            Some(action.id.as_str())
                == menu_stage
                    .home_transition
                    .as_ref()
                    .map(|transition| transition.action_node.as_str())
        })
        .expect("menu home action");

    assert_eq!(
        home_action
            .options
            .get(menu_stage.home_transition.as_ref().unwrap().option_index as usize)
            .map(String::as_str),
        Some(target_play.uuid.as_str())
    );
}

#[test]
fn imported_story_home_story_play_targets_playback_stage() {
    let project = CanonicalProject {
        name: "Story home to play".to_string(),
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
            id: "menu".to_string(),
            name: "Menu".to_string(),
            audio: Some("menu.mp3".to_string()),
            auto_black_image: true,
            children: vec![
                CanonicalEntry::Story(CanonicalStory {
                    id: "source".to_string(),
                    name: "Source".to_string(),
                    native_stage_id: Some("native-source-title".to_string()),
                    audio: Some("source.mp3".to_string()),
                    item_audio: Some("source-title.mp3".to_string()),
                    item_image: Some("source.png".to_string()),
                    return_on_home: Some("story_play:target".to_string()),
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    id: "target".to_string(),
                    name: "Target".to_string(),
                    audio: Some("target.mp3".to_string()),
                    item_audio: Some("target-title.mp3".to_string()),
                    item_image: Some("target.png".to_string()),
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],
        shared_entries: Vec::new(),
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu#menu/Source#source/itemAudio", "source-title.mp3"),
            prepared_asset("root/Menu#menu/Source#source/itemImage", "source.png"),
            prepared_asset("root/Menu#menu/Source#source/storyAudio", "source.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemAudio", "target-title.mp3"),
            prepared_asset("root/Menu#menu/Target#target/itemImage", "target.png"),
            prepared_asset("root/Menu#menu/Target#target/storyAudio", "target.mp3"),
        ],
        Vec::new(),
    ))
    .expect("story home direct playback document");

    let source_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Source")
        .expect("source playback");
    let target_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Target")
        .expect("target playback");
    let home_action = document
        .action_nodes
        .iter()
        .find(|action| {
            Some(action.id.as_str())
                == source_play
                    .home_transition
                    .as_ref()
                    .map(|transition| transition.action_node.as_str())
        })
        .expect("source playback home action");

    assert_eq!(
        home_action
            .options
            .get(source_play.home_transition.as_ref().unwrap().option_index as usize)
            .map(String::as_str),
        Some(target_play.uuid.as_str())
    );
}

#[test]
fn root_story_return_to_shared_story_uses_single_option_action() {
    let project = CanonicalProject {
        name: "Return to shared".to_string(),
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
        entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "source".to_string(),
            name: "Source".to_string(),
            audio: Some("source.mp3".to_string()),
            item_audio: Some("source-title.mp3".to_string()),
            item_image: Some("source.png".to_string()),
            return_after_play: Some("story:target".to_string()),
            ..Default::default()
        })],
        shared_entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "target".to_string(),
            name: "Target".to_string(),
            audio: Some("target.mp3".to_string()),
            item_audio: Some("target-title.mp3".to_string()),
            item_image: Some("target.png".to_string()),
            ..Default::default()
        })],
    };
    let document = build_story_document(&report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Source#source/itemAudio", "source-title.mp3"),
            prepared_asset("root/Source#source/itemImage", "source.png"),
            prepared_asset("root/Source#source/storyAudio", "source.mp3"),
            prepared_asset("shared/Target#target/itemAudio", "target-title.mp3"),
            prepared_asset("shared/Target#target/itemImage", "target.png"),
            prepared_asset("shared/Target#target/storyAudio", "target.mp3"),
        ],
        Vec::new(),
    ))
    .expect("shared return document");

    let source_play = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Source")
        .expect("source playback");
    let target_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Target")
        .expect("target title");
    let ok_transition = source_play.ok_transition.as_ref().expect("source ok");
    let ok_action = document
        .action_nodes
        .iter()
        .find(|action| action.id == ok_transition.action_node)
        .expect("source ok action");

    assert_eq!(ok_action.options.len(), 1);
    assert_eq!(
        ok_action.options.get(ok_transition.option_index as usize),
        Some(&target_title.uuid)
    );
}

#[test]
fn generates_imported_prompt_controls_and_home_null() {
    let project = CanonicalProject {
        name: "Prompt navigation".to_string(),
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
        entries: vec![CanonicalEntry::Story(CanonicalStory {
            id: "story-id".to_string(),
            name: "Prompt Story".to_string(),
            native_stage_id: None,
            audio: Some("story.mp3".to_string()),
            item_audio: Some("item.mp3".to_string()),
            item_image: Some("item.png".to_string()),
            after_playback_prompt_audio: Some("prompt.mp3".to_string()),
            after_playback_prompt_control_settings: Some(EntryControlSettings {
                autoplay: Some(false),
                wheel: Some(false),
                pause: Some(false),
                ok: Some(true),
                home: Some(true),
            }),
            after_playback_prompt_ok_target: Some("root".to_string()),
            after_playback_prompt_home_target: None,
            after_playback_prompt_home_none: true,
            after_playback_sequence: Vec::new(),
            after_playback_home_step: None,
            wheel: false,
            ok: false,
            home: true,
            pause: true,
            autoplay: true,
            return_after_play: None,
            return_on_home: None,
            return_on_home_none: false,
            title_return_on_home: None,
            title_return_on_home_none: false,
            title_control_settings: None,
        })],

        shared_entries: Vec::new(),
    };
    let report = report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Prompt Story#story-id/itemAudio", "item.mp3"),
            prepared_asset("root/Prompt Story#story-id/itemImage", "item.png"),
            prepared_asset("root/Prompt Story#story-id/storyAudio", "story.mp3"),
            prepared_asset(
                "root/Prompt Story#story-id/afterPlaybackPromptAudio",
                "prompt.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("story document");
    let prompt_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Fin - Prompt Story")
        .expect("prompt stage");

    assert_eq!(prompt_stage.audio.as_deref(), Some("prompt.mp3"));
    assert!(!prompt_stage.control_settings.autoplay);
    assert!(prompt_stage.control_settings.ok);
    assert!(prompt_stage.control_settings.home);
    assert!(prompt_stage.ok_transition.is_some());
    assert!(prompt_stage.home_transition.is_none());
}

#[test]
fn exports_after_playback_sequence_before_story_return() {
    let project = CanonicalProject {
        name: "Sequence navigation".to_string(),
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
            name: "Menu".to_string(),
            audio: Some("menu.mp3".to_string()),
            image: Some("menu.png".to_string()),
            auto_black_image: false,
            children: vec![
                CanonicalEntry::Story(CanonicalStory {
                    id: "first".to_string(),
                    name: "Premier".to_string(),
                    audio: Some("first-story.mp3".to_string()),
                    item_audio: Some("first-item.mp3".to_string()),
                    item_image: Some("first.png".to_string()),
                    return_after_play: Some("story:second".to_string()),
                    after_playback_sequence: vec![
                        CanonicalAfterPlaybackStep {
                            id: "bell".to_string(),
                            name: "Cloche".to_string(),
                            audio: Some("bell.mp3".to_string()),
                            image: None,
                            control_settings: Some(EntryControlSettings {
                                autoplay: Some(true),
                                wheel: Some(false),
                                pause: Some(false),
                                ok: Some(false),
                                home: Some(false),
                            }),
                            ok_target: None,
                            ok_choice_targets: Vec::new(),
                            home_target: None,
                            home_follows_ok: false,
                            home_none: true,
                        },
                        CanonicalAfterPlaybackStep {
                            id: "ok".to_string(),
                            name: "Ok ?".to_string(),
                            audio: Some("ok.mp3".to_string()),
                            image: None,
                            control_settings: Some(EntryControlSettings {
                                autoplay: Some(false),
                                wheel: Some(false),
                                pause: Some(false),
                                ok: Some(true),
                                home: Some(true),
                            }),
                            ok_target: Some("story_play:second".to_string()),
                            ok_choice_targets: Vec::new(),
                            home_target: None,
                            home_follows_ok: false,
                            home_none: true,
                        },
                    ],
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    id: "second".to_string(),
                    name: "Second".to_string(),
                    audio: Some("second-story.mp3".to_string()),
                    item_audio: Some("second-item.mp3".to_string()),
                    item_image: Some("second.png".to_string()),
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],

        shared_entries: Vec::new(),
    };
    let report = report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("nightModeAudio", "night.mp3"),
            prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu#menu/menuImage", "menu.png"),
            prepared_asset("root/Menu#menu/Premier#first/itemAudio", "first-item.mp3"),
            prepared_asset("root/Menu#menu/Premier#first/itemImage", "first.png"),
            prepared_asset("root/Menu#menu/Premier#first/storyAudio", "first-story.mp3"),
            prepared_asset(
                "root/Menu#menu/Premier#first/afterPlaybackSequence/0/audio",
                "bell.mp3",
            ),
            prepared_asset(
                "root/Menu#menu/Premier#first/afterPlaybackSequence/1/audio",
                "ok.mp3",
            ),
            prepared_asset("root/Menu#menu/Second#second/itemAudio", "second-item.mp3"),
            prepared_asset("root/Menu#menu/Second#second/itemImage", "second.png"),
            prepared_asset(
                "root/Menu#menu/Second#second/storyAudio",
                "second-story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("story document");
    let action_by_id: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let target_stage_name = |transition: &Transition| -> &str {
        let action = action_by_id
            .get(transition.action_node.as_str())
            .expect("action");
        let stage_id = action.options[transition.option_index as usize].as_str();
        document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == stage_id)
            .map(|stage| stage.name.as_str())
            .expect("stage")
    };

    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Premier")
        .expect("play stage");
    assert_eq!(
        target_stage_name(play_stage.ok_transition.as_ref().expect("play ok")),
        "Cloche"
    );

    let bell_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Cloche")
        .expect("bell stage");
    assert_eq!(bell_stage.audio.as_deref(), Some("bell.mp3"));
    assert!(bell_stage.control_settings.autoplay);
    assert_eq!(
        target_stage_name(bell_stage.ok_transition.as_ref().expect("bell ok")),
        "Ok ?"
    );

    let ok_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Ok ?")
        .expect("ok stage");
    assert_eq!(ok_stage.audio.as_deref(), Some("ok.mp3"));
    assert!(!ok_stage.control_settings.autoplay);
    assert!(ok_stage.control_settings.ok);
    assert_eq!(
        target_stage_name(ok_stage.ok_transition.as_ref().expect("prompt ok")),
        "Histoire - Second"
    );
    assert!(
        document
            .stage_nodes
            .iter()
            .filter(|stage| stage.name == "nightStage")
            .count()
            <= 1
    );
}

#[test]
fn auto_next_overrides_end_steps_and_story_returns() {
    let project = CanonicalProject {
        name: "Auto-next pack".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: Some("night.mp3".to_string()),
        night_mode_return: Some("root".to_string()),
        night_mode_home_return: None,
        native_graph: None,
        options: CanonicalOptions {
            silence_mode: crate::domain::project::SilenceMode::Off,
            harmonize_loudness: true,
            auto_next: true,
            night_mode: true,
        },
        entries: vec![CanonicalEntry::Menu(CanonicalMenu {
            id: "menu".to_string(),
            name: "Menu".to_string(),
            audio: Some("menu.mp3".to_string()),
            image: Some("menu.png".to_string()),
            auto_black_image: false,
            children: vec![
                CanonicalEntry::Story(CanonicalStory {
                    id: "first".to_string(),
                    name: "Premier".to_string(),
                    audio: Some("first-story.mp3".to_string()),
                    item_audio: Some("first-item.mp3".to_string()),
                    item_image: Some("first.png".to_string()),
                    return_after_play: Some("root".to_string()),
                    after_playback_prompt_audio: Some("prompt.mp3".to_string()),
                    after_playback_sequence: vec![CanonicalAfterPlaybackStep {
                        id: "bell".to_string(),
                        name: "Cloche".to_string(),
                        audio: Some("bell.mp3".to_string()),
                        image: None,
                        control_settings: None,
                        ok_target: Some("root".to_string()),
                        ok_choice_targets: Vec::new(),
                        home_target: None,
                        home_follows_ok: false,
                        home_none: true,
                    }],
                    ..Default::default()
                }),
                CanonicalEntry::Story(CanonicalStory {
                    id: "second".to_string(),
                    name: "Second".to_string(),
                    audio: Some("second-story.mp3".to_string()),
                    item_audio: Some("second-item.mp3".to_string()),
                    item_image: Some("second.png".to_string()),
                    ..Default::default()
                }),
            ],
            ..Default::default()
        })],

        shared_entries: Vec::new(),
    };
    let report = report_for(
        project,
        vec![
            prepared_asset("rootAudio", "root.mp3"),
            prepared_asset("rootImage", "root.png"),
            prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
            prepared_asset("root/Menu#menu/menuImage", "menu.png"),
            prepared_asset("root/Menu#menu/Premier#first/itemAudio", "first-item.mp3"),
            prepared_asset("root/Menu#menu/Premier#first/itemImage", "first.png"),
            prepared_asset("root/Menu#menu/Premier#first/storyAudio", "first-story.mp3"),
            prepared_asset("root/Menu#menu/Second#second/itemAudio", "second-item.mp3"),
            prepared_asset("root/Menu#menu/Second#second/itemImage", "second.png"),
            prepared_asset(
                "root/Menu#menu/Second#second/storyAudio",
                "second-story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("auto-next story document");
    let action_by_id: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let target_stage_name = |transition: &Transition| -> &str {
        let action = action_by_id
            .get(transition.action_node.as_str())
            .expect("action");
        let stage_id = action.options[transition.option_index as usize].as_str();
        document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == stage_id)
            .map(|stage| stage.name.as_str())
            .expect("stage")
    };

    let first_play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Premier")
        .expect("first play stage");
    let second_play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Second")
        .expect("second play stage");

    assert!(!document.night_mode_available);
    assert!(first_play_stage.control_settings.autoplay);
    assert!(second_play_stage.control_settings.autoplay);
    assert!(document
        .stage_nodes
        .iter()
        .all(|stage| stage.name != "nightStage"));
    assert!(document
        .stage_nodes
        .iter()
        .all(|stage| stage.name != "Cloche"));
    assert!(document
        .stage_nodes
        .iter()
        .all(|stage| !stage.name.starts_with("Fin -")));
    assert_eq!(
        target_stage_name(first_play_stage.ok_transition.as_ref().expect("first ok")),
        "Histoire - Second"
    );
    assert_eq!(
        target_stage_name(
            first_play_stage
                .home_transition
                .as_ref()
                .expect("first home")
        ),
        "Menu"
    );
    assert_eq!(
        target_stage_name(second_play_stage.ok_transition.as_ref().expect("second ok")),
        "Menu"
    );
}

#[test]
fn canonicalizes_pack_structure() {
    let project = Project {
        name: "Pack".to_string(),
        project_type: Some("pack".to_string()),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        root_entries: vec![
            story("Racine"),
            ProjectEntry {
                id: "menu".to_string(),
                entry_type: "menu".to_string(),
                name: "Menu".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![story("Menu story")],
                ..ProjectEntry::default()
            },
        ],
        global_options: sample_options(),
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),

        shared_entries: Vec::new(),
    };

    let canonical = canonicalize_project(&project);
    let stats = collect_stats(&canonical.entries);

    assert_eq!(canonical.entries.len(), 2);
    assert_eq!(stats.root_entry_count, 2);
    assert_eq!(stats.menu_count, 1);
    assert_eq!(stats.story_count, 2);
    assert_eq!(stats.zip_count, 0);
    assert_eq!(stats.max_depth, 2);
}

#[test]
fn canonicalizes_recursive_root_entries_structure() {
    let project = Project {
        name: "Recursive pack".to_string(),
        project_type: Some("pack".to_string()),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: None,
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        root_entries: vec![ProjectEntry {
            entry_type: "menu".to_string(),
            name: "Choose a character".to_string(),
            audio: Some("menu-1.mp3".to_string()),
            image: Some("menu-1.png".to_string()),
            item_audio: None,
            item_image: None,
            zip_path: None,
            auto_black_image: false,
            children: vec![ProjectEntry {
                entry_type: "menu".to_string(),
                name: "Choose a place".to_string(),
                audio: Some("menu-2.mp3".to_string()),
                image: Some("menu-2.png".to_string()),
                item_audio: None,
                item_image: None,
                zip_path: None,
                auto_black_image: false,
                children: vec![ProjectEntry {
                    entry_type: "story".to_string(),
                    name: "Nested Story".to_string(),
                    audio: Some("story.mp3".to_string()),
                    image: None,
                    item_audio: Some("story-item.mp3".to_string()),
                    item_image: Some("story-item.png".to_string()),
                    zip_path: None,
                    auto_black_image: false,
                    children: vec![],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
        global_options: sample_options(),
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),

        shared_entries: Vec::new(),
    };

    let canonical = canonicalize_project(&project);
    let stats = collect_stats(&canonical.entries);

    assert_eq!(canonical.entries.len(), 1);
    assert_eq!(stats.root_entry_count, 1);
    assert_eq!(stats.menu_count, 2);
    assert_eq!(stats.story_count, 1);
    assert_eq!(stats.zip_count, 0);
    assert_eq!(stats.max_depth, 3);
}

#[test]
fn collects_asset_requests_for_pack() {
    let project = CanonicalProject {
        name: "Pack".to_string(),
        project_type: "pack".to_string(),
        pack_version: 1,
        pack_description: String::new(),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some("root.png".to_string()),
        thumbnail_image: Some("thumb.png".to_string()),
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
        entries: vec![
            CanonicalEntry::Menu(CanonicalMenu {
                name: "Menu".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![CanonicalEntry::Zip(CanonicalZip {
                    name: "Zip".to_string(),
                    zip_path: Some("pack.zip".to_string()),
                    ..Default::default()
                })],
                ..Default::default()
            }),
            CanonicalEntry::Story(CanonicalStory {
                name: "Story".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                ..Default::default()
            }),
        ],

        shared_entries: Vec::new(),
    };

    let requests = collect_asset_requests(&project, 1.0);
    assert_eq!(requests.len(), 10);
    assert!(requests
        .iter()
        .any(|request| matches!(request.source_kind, AssetSourceKind::Zip)));
    assert!(requests
        .iter()
        .any(|request| request.role == "root/Menu/menuAudio"));
    assert!(requests
        .iter()
        .any(|request| request.role == "root/Story/itemAudio"));
}

#[test]
fn stages_duplicate_binary_asset_once() {
    let base = std::env::temp_dir().join(format!("story_studio_native_pack_test_{}", now_millis()));
    let assets_dir = base.join("assets");
    fs::create_dir_all(&assets_dir).expect("create assets dir");
    let source = base.join("sample.png");
    let mut file = fs::File::create(&source).expect("create source");
    file.write_all(b"same-content").expect("write source");

    let mut seen = HashMap::new();
    let first = stage_binary_asset(
        "role1",
        source.to_string_lossy().as_ref(),
        "image",
        &assets_dir,
        &mut seen,
        false,
    )
    .expect("first asset");
    let second = stage_binary_asset(
        "role2",
        source.to_string_lossy().as_ref(),
        "image",
        &assets_dir,
        &mut seen,
        false,
    )
    .expect("second asset");

    assert_eq!(first.staged_asset_name, second.staged_asset_name);
    assert!(!first.deduplicated);
    assert!(second.deduplicated);

    let _ = fs::remove_dir_all(base);
}

#[test]
fn writes_each_deduplicated_asset_only_once_in_final_zip() {
    let base = std::env::temp_dir().join(format!("story_studio_native_zip_test_{}", now_millis()));
    let stage_dir = base.join("stage");
    let assets_dir = stage_dir.join("assets");
    let output_dir = base.join("out");
    fs::create_dir_all(&assets_dir).expect("create assets dir");
    fs::create_dir_all(&output_dir).expect("create output dir");

    let asset_path = assets_dir.join("shared.mp3");
    fs::write(&asset_path, b"shared-audio").expect("write staged asset");
    let cover_path = base.join("cover.png");
    write_test_png(&cover_path);
    let cover_asset_path = assets_dir.join("cover.png");
    fs::write(&cover_asset_path, b"cover-asset").expect("write staged cover asset");

    let project = Project {
        name: "Dedup pack".to_string(),
        project_type: Some("pack".to_string()),
        root_audio: Some("root.mp3".to_string()),
        root_image: Some(cover_path.to_string_lossy().to_string()),
        thumbnail_image: Some(cover_path.to_string_lossy().to_string()),
        night_mode_audio: None,
        night_mode_return: None,
        night_mode_home_return: None,
        native_graph: None,
        root_entries: vec![ProjectEntry {
            id: "story".to_string(),
            entry_type: "story".to_string(),
            name: "Story".to_string(),
            audio: Some("story.mp3".to_string()),
            item_audio: Some("item.mp3".to_string()),
            item_image: Some("item.png".to_string()),
            zip_path: None,
            ..ProjectEntry::default()
        }],
        global_options: GlobalOptions {
            add_silence: false,
            silence_mode: None,
            harmonize_loudness: true,
            add_silence_duration_sec: 1.0,
            auto_next: false,
            night_mode: false,
        },
        pack_version: 1,
        pack_description: String::new(),
        pack_uuid: String::new(),

        shared_entries: Vec::new(),
    };

    let report = NativeAssetPreparationReport {
        project: canonicalize_project(&project),
        pack_uuid: String::new(),
        stage_dir: stage_dir.to_string_lossy().to_string(),
        assets_dir: assets_dir.to_string_lossy().to_string(),
        assets: vec![
            PreparedAsset {
                role: "rootAudio".to_string(),
                source_path: "source/shared.mp3".to_string(),
                source_kind: "audio".to_string(),
                staged_asset_name: "shared.mp3".to_string(),
                staged_asset_path: asset_path.to_string_lossy().to_string(),
                transformed: false,
                deduplicated: false,
            },
            PreparedAsset {
                role: "root/Story#story/itemAudio".to_string(),
                source_path: "source/shared.mp3".to_string(),
                source_kind: "audio".to_string(),
                staged_asset_name: "shared.mp3".to_string(),
                staged_asset_path: asset_path.to_string_lossy().to_string(),
                transformed: false,
                deduplicated: true,
            },
            PreparedAsset {
                role: "root/Story#story/storyAudio".to_string(),
                source_path: "source/shared.mp3".to_string(),
                source_kind: "audio".to_string(),
                staged_asset_name: "shared.mp3".to_string(),
                staged_asset_path: asset_path.to_string_lossy().to_string(),
                transformed: false,
                deduplicated: true,
            },
            PreparedAsset {
                role: "rootImage".to_string(),
                source_path: "source/cover.png".to_string(),
                source_kind: "image".to_string(),
                staged_asset_name: "cover.png".to_string(),
                staged_asset_path: cover_asset_path.to_string_lossy().to_string(),
                transformed: false,
                deduplicated: false,
            },
            PreparedAsset {
                role: "root/Story#story/itemImage".to_string(),
                source_path: "source/cover.png".to_string(),
                source_kind: "image".to_string(),
                staged_asset_name: "cover.png".to_string(),
                staged_asset_path: cover_asset_path.to_string_lossy().to_string(),
                transformed: false,
                deduplicated: true,
            },
        ],
        imported_zips: Vec::new(),
        stats: NativeAssetStats {
            requested_asset_count: 5,
            unique_asset_count: 2,
            transformed_audio_count: 0,
            imported_zip_count: 0,
        },
        notes: Vec::new(),
    };

    let zip_path = write_native_pack_zip(
        &report,
        &build_story_document(&report).expect("story doc"),
        &output_dir,
    )
    .expect("write zip");

    let zip_file = fs::File::open(&zip_path).expect("open zip");
    let mut archive = zip::ZipArchive::new(zip_file).expect("read zip");
    let mut shared_count = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).expect("zip entry");
        if entry.name() == "assets/shared.mp3" {
            shared_count += 1;
        }
    }

    assert_eq!(shared_count, 1);

    let _ = fs::remove_dir_all(base);
}

#[test]
fn builds_simple_story_pack() {
    let report = report_for(
        CanonicalProject {
            name: "Single Story".to_string(),
            project_type: "simple".to_string(),
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
            entries: vec![CanonicalEntry::Story(CanonicalStory {
                name: "Single Story".to_string(),
                audio: Some("story.mp3".to_string()),
                item_audio: Some("item.mp3".to_string()),
                item_image: Some("item.png".to_string()),
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Single Story/storyAudio", "story.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("simple story document");

    assert_eq!(document.action_nodes.len(), 1);
    assert_eq!(document.stage_nodes.len(), 2);

    let cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Cover node")
        .expect("cover stage");
    let story_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "histoire")
        .expect("simple story stage");
    let root_action = &document.action_nodes[0];

    assert_eq!(root_action.name, "Action node");
    assert_eq!(root_action.options, vec![story_stage.uuid.clone()]);
    assert_eq!(
        cover.ok_transition.as_ref().map(|t| t.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(story_stage.audio.as_deref(), Some("story.mp3"));
    assert!(story_stage.image.is_none());
    assert!(story_stage.ok_transition.is_none());
    assert!(story_stage.home_transition.is_none());
    assert!(!story_stage.control_settings.autoplay);
    assert!(story_stage.control_settings.pause);
    assert!(!story_stage.control_settings.ok);
    assert!(story_stage.control_settings.home);
    assert!(!story_stage.control_settings.wheel);
}

#[test]
fn builds_menu_story_with_title_returning_to_root_and_play_to_menu() {
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
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                name: "Choose a story".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: vec![CanonicalEntry::Story(CanonicalStory {
                    name: "Story Alpha".to_string(),
                    audio: Some("story.mp3".to_string()),
                    item_audio: Some("item.mp3".to_string()),
                    item_image: Some("item.png".to_string()),
                    autoplay: true,
                    ..Default::default()
                })],
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Choose a story/menuAudio", "menu.mp3"),
            prepared_asset("root/Choose a story/menuImage", "menu.png"),
            prepared_asset("root/Choose a story/Story Alpha/itemAudio", "item.mp3"),
            prepared_asset("root/Choose a story/Story Alpha/itemImage", "item.png"),
            prepared_asset("root/Choose a story/Story Alpha/storyAudio", "story.mp3"),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("menu story document");

    assert_eq!(document.action_nodes.len(), 3);
    assert_eq!(document.stage_nodes.len(), 4);

    let cover = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Cover node")
        .expect("cover stage");
    let menu_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Choose a story")
        .expect("menu stage");
    let title_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Story Alpha" && stage.image.is_some())
        .expect("title stage");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Story Alpha" && stage.image.is_none())
        .expect("play stage");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![menu_stage.uuid.clone()])
        .expect("root action");
    let menu_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![title_stage.uuid.clone()])
        .expect("menu action");

    assert_eq!(root_action.name, "Action node");
    assert_eq!(menu_action.name, "Action node");
    assert_eq!(
        cover.ok_transition.as_ref().map(|t| t.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        menu_stage
            .ok_transition
            .as_ref()
            .map(|t| t.action_node.as_str()),
        Some(menu_action.id.as_str())
    );
    assert_eq!(
        title_stage
            .home_transition
            .as_ref()
            .map(|t| t.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    // After playback: return directly to menu stage (not story title),
    // matching the UI's resolveReturnTarget fallback → parentMenu.id.
    assert_eq!(
        play_stage
            .home_transition
            .as_ref()
            .map(|t| t.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .as_ref()
            .map(|t| t.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        play_stage.home_transition.as_ref().map(|t| t.option_index),
        Some(0)
    );
    assert_eq!(
        play_stage.ok_transition.as_ref().map(|t| t.option_index),
        Some(0)
    );
    assert!(menu_stage.control_settings.autoplay);
    assert!(title_stage.control_settings.wheel);
    assert!(play_stage.control_settings.autoplay);
}

#[test]
fn builds_recursive_menu_story_tree() {
    let report = report_for(
        CanonicalProject {
            name: "Recursive pack".to_string(),
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
                name: "Choose a character".to_string(),
                audio: Some("menu-1.mp3".to_string()),
                image: Some("menu-1.png".to_string()),
                auto_black_image: false,
                children: vec![CanonicalEntry::Menu(CanonicalMenu {
                    name: "Nested Menu".to_string(),
                    audio: Some("menu-2.mp3".to_string()),
                    image: Some("menu-2.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Story(CanonicalStory {
                        name: "Nested Story".to_string(),
                        audio: Some("story.mp3".to_string()),
                        item_audio: Some("item.mp3".to_string()),
                        item_image: Some("item.png".to_string()),
                        ..Default::default()
                    })],
                    ..Default::default()
                })],
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        },
        vec![
            prepared_asset("rootAudio", "cover.mp3"),
            prepared_asset("rootImage", "cover.png"),
            prepared_asset("root/Choose a character/menuAudio", "menu-1.mp3"),
            prepared_asset("root/Choose a character/menuImage", "menu-1.png"),
            prepared_asset(
                "root/Choose a character/Nested Menu/menuAudio",
                "menu-2.mp3",
            ),
            prepared_asset(
                "root/Choose a character/Nested Menu/menuImage",
                "menu-2.png",
            ),
            prepared_asset(
                "root/Choose a character/Nested Menu/Nested Story/itemAudio",
                "item.mp3",
            ),
            prepared_asset(
                "root/Choose a character/Nested Menu/Nested Story/itemImage",
                "item.png",
            ),
            prepared_asset(
                "root/Choose a character/Nested Menu/Nested Story/storyAudio",
                "story.mp3",
            ),
        ],
        Vec::new(),
    );

    let document = build_story_document(&report).expect("recursive menu document");

    let top_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Choose a character")
        .expect("top menu stage");
    let submenu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Nested Menu")
        .expect("submenu stage");
    let title_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Nested Story" && stage.image.is_some())
        .expect("title stage");
    let play_stage = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Histoire - Nested Story" && stage.image.is_none())
        .expect("play stage");
    let top_menu_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![submenu.uuid.clone()])
        .expect("top menu action");
    let _submenu_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![title_stage.uuid.clone()])
        .expect("submenu action");

    assert!(top_menu.home_transition.is_none());
    assert!(submenu.home_transition.is_none());
    assert!(!submenu.control_settings.autoplay);
    assert!(submenu.control_settings.wheel);
    assert_eq!(document.stage_nodes[0].name, "Cover node");
    assert_eq!(document.stage_nodes[1].name, "Choose a character");
    assert_eq!(document.stage_nodes[2].name, "Nested Menu");
    assert_eq!(
        title_stage
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(top_menu_action.id.as_str())
    );
    assert_eq!(
        title_stage
            .home_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(0)
    );
    // After playback: return to Nested Menu submenu stage (matching resolveReturnTarget → parentMenu.id).
    assert_eq!(
        play_stage
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(top_menu_action.id.as_str())
    );
    assert_eq!(
        play_stage
            .ok_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(top_menu_action.id.as_str())
    );
    assert!(play_stage.control_settings.autoplay);
}

#[test]
fn preserves_explicit_menu_home_transition() {
    let report = report_for(
            CanonicalProject {
                name: "Menu home navigation".to_string(),
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
                    id: "characters".to_string(),
                    name: "Choose a character".to_string(),
                    audio: Some("menu-1.mp3".to_string()),
                    image: Some("menu-1.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Menu(CanonicalMenu {
                        id: "branch".to_string(),
                        name: "Nested Menu".to_string(),
                        audio: Some("menu-2.mp3".to_string()),
                        image: Some("menu-2.png".to_string()),
                        auto_black_image: false,
                        return_on_home: Some("characters".to_string()),
                        children: vec![CanonicalEntry::Story(CanonicalStory {
                            id: "nested".to_string(),
                            name: "Nested Story".to_string(),
                            audio: Some("story.mp3".to_string()),
                            item_audio: Some("item.mp3".to_string()),
                            item_image: Some("item.png".to_string()),
                            ..Default::default()
                        })],
                        ..Default::default()
                    })],
                    ..Default::default()
                })],

                shared_entries: Vec::new(),
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choose a character#characters/menuAudio", "menu-1.mp3"),
                prepared_asset("root/Choose a character#characters/menuImage", "menu-1.png"),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/menuAudio",
                    "menu-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/menuImage",
                    "menu-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/storyAudio",
                    "story.mp3",
                ),
            ],
            Vec::new(),
        );

    let document = build_story_document(&report).expect("menu home document");
    let top_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Choose a character")
        .expect("top menu stage");
    let submenu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Nested Menu")
        .expect("submenu stage");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![top_menu.uuid.clone()])
        .expect("root action");

    assert!(top_menu.home_transition.is_none());
    assert_eq!(
        submenu
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert_eq!(
        submenu
            .home_transition
            .as_ref()
            .map(|transition| transition.option_index),
        Some(0)
    );
}

#[test]
fn preserves_imported_story_title_home_transition() {
    let report = report_for(
            CanonicalProject {
                name: "Title home navigation".to_string(),
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
                    id: "characters".to_string(),
                    name: "Choose a character".to_string(),
                    audio: Some("menu-1.mp3".to_string()),
                    image: Some("menu-1.png".to_string()),
                    auto_black_image: false,
                    children: vec![CanonicalEntry::Menu(CanonicalMenu {
                        id: "branch".to_string(),
                        name: "Nested Menu".to_string(),
                        audio: Some("menu-2.mp3".to_string()),
                        image: Some("menu-2.png".to_string()),
                        auto_black_image: false,
                        children: vec![
                            CanonicalEntry::Story(CanonicalStory {
                                id: "nested".to_string(),
                                name: "Nested Story".to_string(),
                                audio: Some("story.mp3".to_string()),
                                item_audio: Some("item.mp3".to_string()),
                                item_image: Some("item.png".to_string()),
                                title_return_on_home: Some("characters".to_string()),
                                ..Default::default()
                            }),
                            CanonicalEntry::Story(CanonicalStory {
                                id: "silent".to_string(),
                                name: "Silent title home".to_string(),
                                audio: Some("story-2.mp3".to_string()),
                                item_audio: Some("item-2.mp3".to_string()),
                                item_image: Some("item-2.png".to_string()),
                                title_return_on_home_none: true,
                                ..Default::default()
                            }),
                        ],
                        ..Default::default()
                    })],
                    ..Default::default()
                })],

                shared_entries: Vec::new(),
            },
            vec![
                prepared_asset("rootAudio", "cover.mp3"),
                prepared_asset("rootImage", "cover.png"),
                prepared_asset("root/Choose a character#characters/menuAudio", "menu-1.mp3"),
                prepared_asset("root/Choose a character#characters/menuImage", "menu-1.png"),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/menuAudio",
                    "menu-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/menuImage",
                    "menu-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/itemAudio",
                    "item.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/itemImage",
                    "item.png",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Nested Story#nested/storyAudio",
                    "story.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Silent title home#silent/itemAudio",
                    "item-2.mp3",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Silent title home#silent/itemImage",
                    "item-2.png",
                ),
                prepared_asset(
                    "root/Choose a character#characters/Nested Menu#branch/Silent title home#silent/storyAudio",
                    "story-2.mp3",
                ),
            ],
            Vec::new(),
        );

    let document = build_story_document(&report).expect("title home document");
    let top_menu = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Choose a character")
        .expect("top menu stage");
    let nested_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Nested Story")
        .expect("nested title stage");
    let silent_title = document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == "Titre - Silent title home")
        .expect("silent title stage");
    let root_action = document
        .action_nodes
        .iter()
        .find(|action| action.options == vec![top_menu.uuid.clone()])
        .expect("root action");

    assert_eq!(
        nested_title
            .home_transition
            .as_ref()
            .map(|transition| transition.action_node.as_str()),
        Some(root_action.id.as_str())
    );
    assert!(silent_title.home_transition.is_none());
}
