use super::*;

#[test]
fn assigns_imported_title_home_targets() {
    let mut entries = vec![serde_json::json!({
        "id": "root-menu",
        "type": "menu",
        "name": "Root",
        "children": [
            {
                "id": "target-menu",
                "type": "menu",
                "name": "Target",
                "children": [
                    {
                        "id": "plain-story",
                        "type": "story",
                        "name": "Plain",
                        "_playStageId": "plain-play"
                    }
                ]
            },
            {
                "id": "story-with-title-home",
                "type": "story",
                "name": "With title home",
                "_playStageId": "story-play",
                "titleReturnOnHomeStageId": "target-menu"
            },
            {
                "id": "story-without-title-home",
                "type": "story",
                "name": "Without title home",
                "_playStageId": "story-no-home-play",
                "titleReturnOnHomeStageId": null,
                "titleReturnOnHomeNone": true
            },
            {
                "id": "story-title-home-to-story",
                "type": "story",
                "name": "Home to story",
                "_playStageId": "story-home-to-story-play",
                "titleReturnOnHomeStageId": "plain-play"
            }
        ]
    })];

    let unresolved = assign_return_targets(&mut entries, &HashMap::new());
    assert!(unresolved.is_empty());
    let children = entries[0]
        .get("children")
        .and_then(|value| value.as_array())
        .expect("root children");

    assert_eq!(
        children[1]
            .get("titleReturnOnHome")
            .and_then(|v| v.as_str()),
        Some("target-menu")
    );
    assert_eq!(
        children[2]
            .get("titleReturnOnHomeNone")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        children[3]
            .get("titleReturnOnHome")
            .and_then(|v| v.as_str()),
        Some("story_play:plain-story")
    );
    assert!(children[1].get("titleReturnOnHomeStageId").is_none());
    assert!(children[2].get("titleReturnOnHomeStageId").is_none());
}

#[test]
fn autoplay_choice_options_are_imported_as_story_leaves() {
    let doc = serde_json::json!({
        "title": "Autoplay choices",
        "nightModeAvailable": false,
        "actionNodes": [
            { "id": "square-action", "options": ["composer", "standalone"] },
            { "id": "composer-action", "options": ["piece-1", "piece-2"] },
            { "id": "piece-1-action", "options": ["piece-1", "piece-2"] },
            { "id": "piece-2-action", "options": ["bell"] },
            { "id": "bell-action", "options": ["info"] },
            { "id": "info-action", "options": ["ok-prompt"] },
            { "id": "prompt-action", "options": ["piece-3", "bonus"] },
            { "id": "home-action", "options": ["composer"] }
        ],
        "stageNodes": [
            {
                "uuid": "square",
                "squareOne": true,
                "okTransition": { "actionNode": "square-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false }
            },
            {
                "uuid": "composer",
                "name": "Composer",
                "audio": "composer.mp3",
                "image": "composer.png",
                "okTransition": { "actionNode": "composer-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
            },
            {
                "uuid": "piece-1",
                "name": "Piece 1",
                "audio": "piece-1.mp3",
                "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "piece-1-action", "optionIndex": 1 },
                "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
            },
            {
                "uuid": "piece-2",
                "name": "Piece 2",
                "audio": "piece-2.mp3",
                "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "piece-2-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
            },
            {
                "uuid": "bell",
                "name": "Bell",
                "audio": "bell.mp3",
                "okTransition": { "actionNode": "bell-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
            },
            {
                "uuid": "info",
                "name": "Info",
                "audio": "info.mp3",
                "okTransition": { "actionNode": "info-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": false }
            },
            {
                "uuid": "ok-prompt",
                "name": "Ok ?",
                "audio": "ok.mp3",
                "okTransition": { "actionNode": "prompt-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
            },
            {
                "uuid": "piece-3",
                "name": "Piece 3",
                "audio": "piece-3.mp3",
                "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
            },
            {
                "uuid": "bonus",
                "name": "Bonus",
                "audio": "bonus.mp3",
                "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": true, "ok": false, "home": true }
            },
            {
                "uuid": "standalone",
                "name": "Standalone",
                "audio": "standalone.mp3",
                "controlSettings": { "autoplay": false }
            }
        ]
    });
    let assets = HashMap::from([
        ("composer.mp3".to_string(), PathBuf::from("composer.mp3")),
        ("composer.png".to_string(), PathBuf::from("composer.png")),
        ("piece-1.mp3".to_string(), PathBuf::from("piece-1.mp3")),
        ("piece-2.mp3".to_string(), PathBuf::from("piece-2.mp3")),
        ("piece-3.mp3".to_string(), PathBuf::from("piece-3.mp3")),
        ("bonus.mp3".to_string(), PathBuf::from("bonus.mp3")),
        ("bell.mp3".to_string(), PathBuf::from("bell.mp3")),
        ("info.mp3".to_string(), PathBuf::from("info.mp3")),
        ("ok.mp3".to_string(), PathBuf::from("ok.mp3")),
        (
            "standalone.mp3".to_string(),
            PathBuf::from("standalone.mp3"),
        ),
    ]);

    let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
    assert_eq!(
        result
            .get("advancedTransitionsDetected")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
    let entries = result
        .get("entries")
        .and_then(|value| value.as_array())
        .expect("entries array");
    let composer = entries
        .iter()
        .find(|entry| entry.get("id").and_then(|value| value.as_str()) == Some("composer"))
        .expect("composer entry");
    let children = composer
        .get("children")
        .and_then(|value| value.as_array())
        .expect("composer children");

    assert_eq!(children.len(), 3);
    assert_eq!(
        children[2].get("type").and_then(|value| value.as_str()),
        Some("menu")
    );
    assert_eq!(
        children[0]
            .get("returnAfterPlay")
            .and_then(|value| value.as_str()),
        Some("story:piece-2")
    );
    assert_eq!(
        children[1]
            .get("returnAfterPlay")
            .and_then(|value| value.as_str()),
        Some("story_play:piece-2-sequence-choice-ok-prompt-piece-3")
    );
    let sequence = children[1]
        .get("afterPlaybackSequence")
        .and_then(|value| value.as_array())
        .expect("piece 2 sequence");
    assert_eq!(sequence.len(), 3);
    assert_eq!(
        sequence[0].get("name").and_then(|value| value.as_str()),
        Some("Bell")
    );
    assert_eq!(
        sequence[0].get("audio").and_then(|value| value.as_str()),
        Some("bell.mp3")
    );
    assert_eq!(
        sequence[2].get("name").and_then(|value| value.as_str()),
        Some("Ok ?")
    );
    assert_eq!(
        sequence[2].get("okTarget").and_then(|value| value.as_str()),
        Some("piece-2-sequence-choice-ok-prompt")
    );
    let continuation_children = children[2]
        .get("children")
        .and_then(|value| value.as_array())
        .expect("continuation children");
    assert_eq!(continuation_children.len(), 2);
    assert_eq!(
        continuation_children[0]
            .get("name")
            .and_then(|value| value.as_str()),
        Some("Piece 3")
    );
    assert_eq!(
        continuation_children[0]
            .get("id")
            .and_then(|value| value.as_str()),
        Some("piece-2-sequence-choice-ok-prompt-piece-3")
    );
    assert_eq!(
        continuation_children[1]
            .get("name")
            .and_then(|value| value.as_str()),
        Some("Bonus")
    );
    assert_eq!(
        continuation_children[1]
            .get("id")
            .and_then(|value| value.as_str()),
        Some("piece-2-sequence-choice-ok-prompt-bonus")
    );
    assert!(children[0].get("children").is_none());
}

#[test]
fn home_transition_to_story_entry_is_not_advanced() {
    let title_stage = serde_json::json!({
        "uuid": "story-title",
        "okTransition": { "actionNode": "title-action", "optionIndex": 0 },
        "controlSettings": { "autoplay": false }
    });
    let play_stage = serde_json::json!({
        "uuid": "story-play",
        "audio": "story.mp3",
        "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
        "okTransition": { "actionNode": "ok-action", "optionIndex": 0 },
        "controlSettings": { "autoplay": true }
    });
    let menu_stage = serde_json::json!({
        "uuid": "return-menu",
        "controlSettings": { "autoplay": false }
    });
    let title_action = serde_json::json!({
        "id": "title-action",
        "options": ["story-play"]
    });
    let home_action = serde_json::json!({
        "id": "home-action",
        "options": ["story-title"]
    });
    let ok_action = serde_json::json!({
        "id": "ok-action",
        "options": ["return-menu"]
    });

    let stages = HashMap::from([
        ("story-title", &title_stage),
        ("story-play", &play_stage),
        ("return-menu", &menu_stage),
    ]);
    let actions = HashMap::from([
        ("title-action", &title_action),
        ("home-action", &home_action),
        ("ok-action", &ok_action),
    ]);
    let prompt_stage_usage = HashMap::new();
    let story_play_stage_ids = HashSet::from(["story-play"]);

    let detection = detect_story_return_stage_id(
        &play_stage,
        &stages,
        &actions,
        &prompt_stage_usage,
        false,
        &story_play_stage_ids,
    );

    assert!(!detection.advanced);
    assert_eq!(detection.target_stage_id.as_deref(), Some("return-menu"));
    assert_eq!(
        detection.home_story_stage_id.as_deref(),
        Some("story-title")
    );
}

#[test]
fn non_autoplay_prompt_stage_is_detected_as_after_playback_prompt() {
    let play_stage = serde_json::json!({
        "uuid": "story-play",
        "audio": "story.mp3",
        "homeTransition": { "actionNode": "home-action", "optionIndex": 0 },
        "okTransition": { "actionNode": "prompt-entry-action", "optionIndex": 0 },
        "controlSettings": { "autoplay": true, "ok": false, "home": true }
    });
    let prompt_stage = serde_json::json!({
        "uuid": "prompt-stage",
        "audio": "prompt.mp3",
        "homeTransition": null,
        "okTransition": { "actionNode": "prompt-ok-action", "optionIndex": 0 },
        "controlSettings": {
            "autoplay": false,
            "wheel": false,
            "pause": false,
            "ok": true,
            "home": true
        }
    });
    let current_title_stage = serde_json::json!({
        "uuid": "current-title",
        "okTransition": { "actionNode": "current-title-action", "optionIndex": 0 },
        "controlSettings": { "autoplay": false }
    });
    let next_title_stage = serde_json::json!({
        "uuid": "next-title",
        "okTransition": { "actionNode": "next-title-action", "optionIndex": 0 },
        "controlSettings": { "autoplay": false }
    });
    let next_play_stage = serde_json::json!({
        "uuid": "next-play",
        "audio": "next.mp3",
        "controlSettings": { "autoplay": true }
    });
    let home_action = serde_json::json!({
        "id": "home-action",
        "options": ["current-title"]
    });
    let prompt_entry_action = serde_json::json!({
        "id": "prompt-entry-action",
        "options": ["prompt-stage"]
    });
    let prompt_ok_action = serde_json::json!({
        "id": "prompt-ok-action",
        "options": ["next-title"]
    });
    let current_title_action = serde_json::json!({
        "id": "current-title-action",
        "options": ["story-play"]
    });
    let next_title_action = serde_json::json!({
        "id": "next-title-action",
        "options": ["next-play"]
    });

    let stages = HashMap::from([
        ("story-play", &play_stage),
        ("prompt-stage", &prompt_stage),
        ("current-title", &current_title_stage),
        ("next-title", &next_title_stage),
        ("next-play", &next_play_stage),
    ]);
    let actions = HashMap::from([
        ("home-action", &home_action),
        ("prompt-entry-action", &prompt_entry_action),
        ("prompt-ok-action", &prompt_ok_action),
        ("current-title-action", &current_title_action),
        ("next-title-action", &next_title_action),
    ]);
    let prompt_stage_usage = HashMap::from([("prompt-stage".to_string(), 1)]);
    let story_play_stage_ids = HashSet::from(["story-play", "next-play"]);

    let detection = detect_story_return_stage_id(
        &play_stage,
        &stages,
        &actions,
        &prompt_stage_usage,
        true,
        &story_play_stage_ids,
    );

    assert!(!detection.advanced);
    assert_eq!(detection.prompt_stage_id.as_deref(), Some("prompt-stage"));
    assert_eq!(detection.prompt_ok_stage_id.as_deref(), Some("next-title"));
    assert_eq!(detection.prompt_home_stage_id, None);
    assert_eq!(detection.next_story_stage_id.as_deref(), Some("next-title"));
    assert_eq!(
        detection.home_story_stage_id.as_deref(),
        Some("current-title")
    );
    assert!(detection.prompt_home_transition_none);
    assert_eq!(
        detection
            .prompt_control_settings
            .as_ref()
            .and_then(|controls| controls.get("autoplay"))
            .and_then(|value| value.as_bool()),
        Some(false)
    );
}

#[test]
fn repeated_prompt_stages_are_not_imported_as_global_night_mode() {
    let doc = serde_json::json!({
        "title": "Prompt pack",
        "nightModeAvailable": true,
        "actionNodes": [
            { "id": "root-action", "options": ["story-1", "story-2"] },
            { "id": "story-1-title-action", "options": ["story-1-play"] },
            { "id": "story-2-title-action", "options": ["story-2-play"] },
            { "id": "story-1-play-action", "options": ["story-1-prompt"] },
            { "id": "story-2-play-action", "options": ["story-2-prompt"] },
            { "id": "story-1-prompt-action", "options": ["story-2"] },
            { "id": "story-2-prompt-action", "options": ["story-1"] },
            { "id": "story-1-home-action", "options": ["story-1"] },
            { "id": "story-2-home-action", "options": ["story-2"] }
        ],
        "stageNodes": [
            {
                "uuid": "square",
                "squareOne": true,
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false }
            },
            {
                "uuid": "story-1",
                "name": "Lombric",
                "audio": "story-1-title.mp3",
                "okTransition": { "actionNode": "story-1-title-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
            },
            {
                "uuid": "story-1-play",
                "name": "Lombric lecture",
                "audio": "story-1.mp3",
                "homeTransition": { "actionNode": "story-1-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-1-play-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
            },
            {
                "uuid": "story-1-prompt",
                "name": "Une autre bestiole",
                "audio": "prompt.mp3",
                "homeTransition": null,
                "okTransition": { "actionNode": "story-1-prompt-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
            },
            {
                "uuid": "story-2",
                "name": "Limace",
                "audio": "story-2-title.mp3",
                "okTransition": { "actionNode": "story-2-title-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
            },
            {
                "uuid": "story-2-play",
                "name": "Limace lecture",
                "audio": "story-2.mp3",
                "homeTransition": { "actionNode": "story-2-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-2-play-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
            },
            {
                "uuid": "story-2-prompt",
                "name": "Une autre bestiole",
                "audio": "prompt.mp3",
                "homeTransition": null,
                "okTransition": { "actionNode": "story-2-prompt-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": false, "ok": true, "home": true }
            }
        ]
    });
    let assets = HashMap::from([
        (
            "story-1-title.mp3".to_string(),
            PathBuf::from("story-1-title.mp3"),
        ),
        ("story-1.mp3".to_string(), PathBuf::from("story-1.mp3")),
        (
            "story-2-title.mp3".to_string(),
            PathBuf::from("story-2-title.mp3"),
        ),
        ("story-2.mp3".to_string(), PathBuf::from("story-2.mp3")),
        ("prompt.mp3".to_string(), PathBuf::from("prompt.mp3")),
    ]);

    let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
    assert_eq!(result["nightMode"].as_bool(), Some(false));
    assert!(result["nightModeAudio"].is_null());
    assert!(result["nightModeReturn"].is_null());

    let entries = result["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0]["afterPlaybackPromptAudio"].as_str(),
        Some("prompt.mp3")
    );
    assert_eq!(
        entries[0]["afterPlaybackPromptOkTarget"].as_str(),
        Some("story:story-2")
    );
    assert_eq!(
        entries[1]["afterPlaybackPromptOkTarget"].as_str(),
        Some("story:story-1")
    );
}

#[test]
fn duplicated_night_stages_are_imported_as_next_story_night_mode() {
    let doc = serde_json::json!({
        "title": "Night next",
        "nightModeAvailable": true,
        "actionNodes": [
            { "id": "root-action", "options": ["story-1", "story-2"] },
            { "id": "story-1-title-action", "options": ["story-1-play"] },
            { "id": "story-2-title-action", "options": ["story-2-play"] },
            { "id": "story-1-play-action", "options": ["story-1-night"] },
            { "id": "story-2-play-action", "options": ["story-2-night"] },
            { "id": "story-1-night-action", "options": ["story-2"] },
            { "id": "story-2-night-action", "options": ["story-2"] },
            { "id": "night-home-action", "options": ["square"] },
            { "id": "story-1-home-action", "options": ["story-1"] },
            { "id": "story-2-home-action", "options": ["story-2"] }
        ],
        "stageNodes": [
            {
                "uuid": "square",
                "squareOne": true,
                "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false }
            },
            {
                "uuid": "story-1",
                "name": "Lombric",
                "audio": "story-1-title.mp3",
                "okTransition": { "actionNode": "story-1-title-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
            },
            {
                "uuid": "story-1-play",
                "name": "Lombric lecture",
                "audio": "story-1.mp3",
                "homeTransition": { "actionNode": "story-1-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-1-play-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
            },
            {
                "uuid": "story-1-night",
                "name": "nightStage",
                "audio": "night.mp3",
                "homeTransition": { "actionNode": "night-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-1-night-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": true, "home": true }
            },
            {
                "uuid": "story-2",
                "name": "Limace",
                "audio": "story-2-title.mp3",
                "okTransition": { "actionNode": "story-2-title-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": false, "wheel": true, "ok": true, "home": true }
            },
            {
                "uuid": "story-2-play",
                "name": "Limace lecture",
                "audio": "story-2.mp3",
                "homeTransition": { "actionNode": "story-2-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-2-play-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": false, "home": true }
            },
            {
                "uuid": "story-2-night",
                "name": "nightStage",
                "audio": "night.mp3",
                "homeTransition": { "actionNode": "night-home-action", "optionIndex": 0 },
                "okTransition": { "actionNode": "story-2-night-action", "optionIndex": 0 },
                "controlSettings": { "autoplay": true, "wheel": false, "ok": true, "home": true }
            }
        ]
    });
    let assets = HashMap::from([
        (
            "story-1-title.mp3".to_string(),
            PathBuf::from("story-1-title.mp3"),
        ),
        ("story-1.mp3".to_string(), PathBuf::from("story-1.mp3")),
        (
            "story-2-title.mp3".to_string(),
            PathBuf::from("story-2-title.mp3"),
        ),
        ("story-2.mp3".to_string(), PathBuf::from("story-2.mp3")),
        ("night.mp3".to_string(), PathBuf::from("night.mp3")),
    ]);

    let result = walk_story_doc_to_entries(&doc, &assets).expect("imported entries");
    assert_eq!(result["nightMode"].as_bool(), Some(true));
    assert_eq!(result["nightModeAudio"].as_str(), Some("night.mp3"));
    assert_eq!(result["nightModeReturn"].as_str(), Some("next_story"));
    assert_eq!(result["nightModeHomeReturn"].as_str(), Some("root"));

    let entries = result["entries"].as_array().expect("entries");
    assert!(entries
        .iter()
        .all(|entry| entry["afterPlaybackPromptAudio"].as_str().is_none()));
    assert!(entries
        .iter()
        .all(|entry| entry["returnAfterPlay"].as_str().is_none()));
}

#[test]
fn modeled_after_playback_sequence_is_not_reported_as_unresolved_transition() {
    let mut entries = vec![serde_json::json!({
        "id": "menu",
        "type": "menu",
        "name": "Menu",
        "children": [
            {
                "id": "story",
                "type": "story",
                "name": "Story",
                "_playStageId": "story-play",
                "afterPlaybackSequence": [
                    {
                        "id": "step",
                        "name": "Ok ?",
                        "okStageId": "next-play",
                        "homeStageId": "menu"
                    }
                ]
            },
            {
                "id": "next",
                "type": "story",
                "name": "Next",
                "_playStageId": "next-play"
            }
        ]
    })];

    let unresolved = assign_return_targets(&mut entries, &HashMap::new());
    let step = &entries[0]["children"][0]["afterPlaybackSequence"][0];

    assert!(unresolved.is_empty());
    assert_eq!(step["okTarget"].as_str(), Some("story_play:next"));
    assert_eq!(step["homeTarget"].as_str(), Some("menu"));
}

#[test]
fn unresolved_after_playback_sequence_target_is_reported() {
    let mut entries = vec![serde_json::json!({
        "id": "story",
        "type": "story",
        "name": "Story",
        "afterPlaybackSequence": [
            {
                "id": "step",
                "name": "Ok ?",
                "okStageId": "missing-stage"
            }
        ]
    })];

    let unresolved = assign_return_targets(
        &mut entries,
        &HashMap::from([("missing-stage".to_string(), "Hidden target".to_string())]),
    );

    assert_eq!(unresolved.len(), 1);
    assert_eq!(
        unresolved[0]["targetStageName"].as_str(),
        Some("Hidden target")
    );
    assert!(entries[0]["afterPlaybackSequence"][0]
        .get("okTarget")
        .is_none());
}

#[test]
fn cloche_retour_home_targets_do_not_flood_import_warnings() {
    let mut entries = vec![serde_json::json!({
        "id": "story",
        "type": "story",
        "name": "Story",
        "returnOnHomeStageId": "cloche-retour"
    })];

    let unresolved = assign_return_targets(
        &mut entries,
        &HashMap::from([("cloche-retour".to_string(), "Cloche retour".to_string())]),
    );

    assert!(unresolved.is_empty());
    assert!(entries[0].get("returnOnHome").is_none());
}
