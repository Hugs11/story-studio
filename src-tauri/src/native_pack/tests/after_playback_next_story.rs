//! Résolution `next_story` sur les cibles de fin exposées (prompt et séquence).
//! Garantit que Rust résout `next_story` vers la sœur suivante comme le miroir JS, et
//! retombe sur le repli canonique du champ pour la dernière histoire.

use super::*;

fn plain_story(id: &str, name: &str) -> CanonicalStory {
    CanonicalStory {
        id: id.to_string(),
        name: name.to_string(),
        audio: Some(format!("{id}.mp3")),
        item_audio: Some(format!("{id}-item.mp3")),
        item_image: Some(format!("{id}-item.png")),
        ..Default::default()
    }
}

fn prompt_story(
    id: &str,
    name: &str,
    ok_target: Option<&str>,
    home_target: Option<&str>,
    home_none: bool,
) -> CanonicalStory {
    CanonicalStory {
        after_playback_prompt_audio: Some("prompt.mp3".to_string()),
        after_playback_prompt_ok_target: ok_target.map(str::to_string),
        after_playback_prompt_home_target: home_target.map(str::to_string),
        after_playback_prompt_home_none: home_none,
        ..plain_story(id, name)
    }
}

fn seq_step(
    name: &str,
    ok_target: Option<&str>,
    home_target: Option<&str>,
) -> CanonicalAfterPlaybackStep {
    CanonicalAfterPlaybackStep {
        id: format!("step-{name}"),
        name: name.to_string(),
        audio: Some("seq.mp3".to_string()),
        image: None,
        control_settings: None,
        ok_target: ok_target.map(str::to_string),
        ok_choice_targets: Vec::new(),
        home_target: home_target.map(str::to_string),
        home_follows_ok: false,
        home_none: false,
    }
}

fn sequence_story(
    id: &str,
    name: &str,
    steps: Vec<CanonicalAfterPlaybackStep>,
    home_step: Option<CanonicalAfterPlaybackStep>,
) -> CanonicalStory {
    CanonicalStory {
        after_playback_sequence: steps,
        after_playback_home_step: home_step,
        ..plain_story(id, name)
    }
}

/// Rapport pour un menu racine unique contenant `stories`, tous les assets requis générés.
fn menu_report(stories: Vec<CanonicalStory>) -> NativeAssetPreparationReport {
    let mut assets = vec![
        prepared_asset("rootAudio", "cover.mp3"),
        prepared_asset("rootImage", "cover.png"),
        prepared_asset("root/Menu#menu/menuAudio", "menu.mp3"),
        prepared_asset("root/Menu#menu/menuImage", "menu.png"),
    ];
    for story in &stories {
        let base = format!("root/Menu#menu/{}#{}", story.name, story.id);
        if story.item_audio.is_some() {
            assets.push(prepared_asset(&format!("{base}/itemAudio"), "item.mp3"));
        }
        if story.item_image.is_some() {
            assets.push(prepared_asset(&format!("{base}/itemImage"), "item.png"));
        }
        assets.push(prepared_asset(&format!("{base}/storyAudio"), "story.mp3"));
        if story.after_playback_prompt_audio.is_some() {
            assets.push(prepared_asset(
                &format!("{base}/afterPlaybackPromptAudio"),
                "prompt.mp3",
            ));
        }
        for (index, step) in story.after_playback_sequence.iter().enumerate() {
            if step.audio.is_some() {
                assets.push(prepared_asset(
                    &format!("{base}/afterPlaybackSequence/{index}/audio"),
                    "seq.mp3",
                ));
            }
            if step.image.is_some() {
                assets.push(prepared_asset(
                    &format!("{base}/afterPlaybackSequence/{index}/image"),
                    "seq.png",
                ));
            }
        }
        if let Some(home_step) = &story.after_playback_home_step {
            if home_step.audio.is_some() {
                assets.push(prepared_asset(
                    &format!("{base}/afterPlaybackHomeStep/audio"),
                    "hs.mp3",
                ));
            }
            if home_step.image.is_some() {
                assets.push(prepared_asset(
                    &format!("{base}/afterPlaybackHomeStep/image"),
                    "hs.png",
                ));
            }
        }
    }
    report_for(
        CanonicalProject {
            name: "Next-story pack".to_string(),
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
                image: Some("menu.png".to_string()),
                auto_black_image: false,
                children: stories.into_iter().map(CanonicalEntry::Story).collect(),
                ..Default::default()
            })],
            shared_entries: Vec::new(),
        },
        assets,
        Vec::new(),
    )
}

fn stage_by_name<'a>(document: &'a StoryDocument, name: &str) -> &'a StageNode {
    document
        .stage_nodes
        .iter()
        .find(|stage| stage.name == name)
        .unwrap_or_else(|| panic!("stage `{name}` introuvable"))
}

fn transition_target<'a>(document: &'a StoryDocument, transition: &Transition) -> &'a StageNode {
    let action = document
        .action_nodes
        .iter()
        .find(|action| action.id == transition.action_node)
        .expect("action node cible");
    let stage_id = action
        .options
        .get(transition.option_index as usize)
        .expect("option index");
    document
        .stage_nodes
        .iter()
        .find(|stage| &stage.uuid == stage_id)
        .expect("stage cible")
}

// ── Prompt ──────────────────────────────────────────────────────────────────

#[test]
fn prompt_ok_next_story_targets_next_sibling_title() {
    let document = build_story_document(&menu_report(vec![
        prompt_story("a", "A", Some("next_story"), None, false),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - A");
    let target = transition_target(&document, prompt.ok_transition.as_ref().expect("prompt ok"));
    assert_eq!(target.name, "Titre - B");
}

#[test]
fn prompt_ok_next_story_on_last_story_falls_back_to_menu() {
    let document = build_story_document(&menu_report(vec![
        plain_story("a", "A"),
        prompt_story("b", "B", Some("next_story"), None, false),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - B");
    let target = transition_target(&document, prompt.ok_transition.as_ref().expect("prompt ok"));
    // Dernière sœur : repli canonique du retour de lecture = stage du menu parent.
    assert_eq!(target.name, "Menu");
}

#[test]
fn prompt_home_next_story_targets_next_sibling_title() {
    let document = build_story_document(&menu_report(vec![
        prompt_story("a", "A", None, Some("next_story"), false),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - A");
    let target = transition_target(&document, prompt.home_transition.as_ref().expect("prompt home"));
    assert_eq!(target.name, "Titre - B");
}

#[test]
fn prompt_home_next_story_on_last_story_falls_back_to_prompt_ok() {
    let document = build_story_document(&menu_report(vec![
        plain_story("a", "A"),
        prompt_story("b", "B", Some("root"), Some("next_story"), false),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - B");
    let ok = prompt.ok_transition.as_ref().expect("prompt ok");
    let home = prompt.home_transition.as_ref().expect("prompt home");
    // Dernière sœur : `next_story` non résolu → repli sur la transition OK du prompt (la racine),
    // jamais le Home de l'histoire. Home et OK pointent donc vers la même transition.
    assert_eq!(home.action_node, ok.action_node);
    assert_eq!(home.option_index, ok.option_index);
}

#[test]
fn prompt_home_none_emits_no_transition() {
    let document = build_story_document(&menu_report(vec![
        prompt_story("a", "A", Some("root"), None, true),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - A");
    assert!(prompt.home_transition.is_none());
}

#[test]
fn prompt_home_empty_follows_ok_including_next_story() {
    let document = build_story_document(&menu_report(vec![
        prompt_story("a", "A", Some("next_story"), None, false),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let prompt = stage_by_name(&document, "Fin - A");
    let ok = prompt.ok_transition.as_ref().expect("prompt ok");
    let home = prompt.home_transition.as_ref().expect("prompt home");
    // Home vide suit exactement OK...
    assert_eq!(home.action_node, ok.action_node);
    assert_eq!(home.option_index, ok.option_index);
    // ...et OK a bien résolu next_story vers la sœur suivante.
    assert_eq!(transition_target(&document, ok).name, "Titre - B");
}

// ── Séquence ────────────────────────────────────────────────────────────────

#[test]
fn sequence_final_ok_next_story_targets_next_sibling_title() {
    let document = build_story_document(&menu_report(vec![
        sequence_story("a", "A", vec![seq_step("SeqA", Some("next_story"), None)], None),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let step = stage_by_name(&document, "SeqA");
    let target = transition_target(&document, step.ok_transition.as_ref().expect("seq ok"));
    assert_eq!(target.name, "Titre - B");
}

#[test]
fn sequence_final_ok_next_story_on_last_story_falls_back_to_menu() {
    let document = build_story_document(&menu_report(vec![
        plain_story("a", "A"),
        sequence_story("b", "B", vec![seq_step("SeqB", Some("next_story"), None)], None),
    ]))
    .expect("document");

    let step = stage_by_name(&document, "SeqB");
    let target = transition_target(&document, step.ok_transition.as_ref().expect("seq ok"));
    assert_eq!(target.name, "Menu");
}

#[test]
fn sequence_step_home_next_story_targets_next_sibling_title() {
    let document = build_story_document(&menu_report(vec![
        sequence_story(
            "a",
            "A",
            vec![seq_step("SeqA", Some("root"), Some("next_story"))],
            None,
        ),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let step = stage_by_name(&document, "SeqA");
    let target = transition_target(&document, step.home_transition.as_ref().expect("seq home"));
    assert_eq!(target.name, "Titre - B");
}

#[test]
fn sequence_home_step_home_next_story_targets_next_sibling_title() {
    let home_step = CanonicalAfterPlaybackStep {
        id: "home-step".to_string(),
        name: "Reaction A".to_string(),
        audio: Some("hs.mp3".to_string()),
        image: None,
        control_settings: None,
        ok_target: None,
        ok_choice_targets: Vec::new(),
        home_target: Some("next_story".to_string()),
        home_follows_ok: false,
        home_none: false,
    };
    let document = build_story_document(&menu_report(vec![
        sequence_story(
            "a",
            "A",
            vec![
                seq_step("SeqA1", None, None),
                seq_step("SeqA2", Some("root"), None),
            ],
            Some(home_step),
        ),
        plain_story("b", "B"),
    ]))
    .expect("document");

    let step = stage_by_name(&document, "Reaction A");
    let target = transition_target(&document, step.home_transition.as_ref().expect("home step home"));
    assert_eq!(target.name, "Titre - B");
}
