use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::after_playback::is_imported_night_mode_stage_candidate;
use super::navigation_targets::{
    build_story_stage_map, collect_menu_ids_from_entry, collect_story_navigation_contexts,
    resolve_navigation_target_for_stage,
};
use super::stage::{is_stage_autoplay, resolve_asset, stage_action_options};
use super::transitions::transition_target_stage_id;

pub(super) struct NightBridgeDetection {
    pub(super) audio: String,
    pub(super) return_target: Option<String>,
    pub(super) home_target: Option<String>,
    pub(super) autoplay: Option<bool>,
}

struct NightBridgeInstance {
    night_stage_id: String,
    return_stage_id: Option<String>,
    home_stage_id: Option<String>,
    expected_next_or_fallback_stage_id: String,
    autoplay: bool,
}

fn normalize_stage_navigation_target(
    stage_id: &str,
    root_stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<String> {
    if stage_id == root_stage_id {
        return Some("root".to_string());
    }
    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
        .and_then(|value| value.as_str().map(str::to_string))
}

fn infer_night_target(
    instances: &[NightBridgeInstance],
    target_for: impl Fn(&NightBridgeInstance) -> Option<&String>,
    root_stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<String> {
    let targets: Vec<&String> = instances.iter().filter_map(&target_for).collect();
    if targets.is_empty() {
        return None;
    }
    if targets.len() == instances.len()
        && instances.iter().all(|instance| {
            target_for(instance) == Some(&instance.expected_next_or_fallback_stage_id)
        })
    {
        return Some("next_story".to_string());
    }
    let first = targets[0];
    if targets.iter().all(|target| *target == first) {
        return normalize_stage_navigation_target(first, root_stage_id, menu_ids, story_stage_map);
    }
    None
}

pub(super) fn detect_imported_night_mode(
    night_mode_available: bool,
    root_stage_id: &str,
    entries: &[serde_json::Value],
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Option<NightBridgeDetection> {
    if !night_mode_available {
        return None;
    }

    let menu_ids: HashSet<String> = entries
        .iter()
        .flat_map(collect_menu_ids_from_entry)
        .collect();
    let story_stage_map = build_story_stage_map(entries);
    let mut contexts = Vec::new();
    collect_story_navigation_contexts(entries, None, &mut contexts);

    let mut instances = Vec::new();
    let mut audio: Option<String> = None;
    for context in contexts {
        let Some(play_stage) = stages.get(context.play_stage_id.as_str()) else {
            continue;
        };
        if !is_stage_autoplay(play_stage) {
            continue;
        }
        let opts = stage_action_options(play_stage, actions);
        if opts.len() != 1 {
            continue;
        }
        let night_stage_id = opts[0];
        let Some(night_stage) = stages.get(night_stage_id) else {
            continue;
        };
        if !is_imported_night_mode_stage_candidate(night_stage, actions) {
            continue;
        }
        let resolved_audio = resolve_asset(
            night_stage.get("audio").and_then(|value| value.as_str()),
            assets,
        )?;
        if audio
            .as_deref()
            .is_some_and(|existing| existing != resolved_audio)
        {
            return None;
        }
        audio = Some(resolved_audio);
        instances.push(NightBridgeInstance {
            night_stage_id: night_stage_id.to_string(),
            return_stage_id: transition_target_stage_id(night_stage.get("okTransition"), actions)
                .map(str::to_string),
            home_stage_id: transition_target_stage_id(night_stage.get("homeTransition"), actions)
                .map(str::to_string),
            expected_next_or_fallback_stage_id: context
                .next_story_id
                .unwrap_or(context.fallback_stage_id),
            autoplay: is_stage_autoplay(night_stage),
        });
    }

    if instances.is_empty() {
        return None;
    }

    let distinct_night_stages: HashSet<&str> = instances
        .iter()
        .map(|instance| instance.night_stage_id.as_str())
        .collect();
    let return_target = infer_night_target(
        &instances,
        |instance| instance.return_stage_id.as_ref(),
        root_stage_id,
        &menu_ids,
        &story_stage_map,
    )?;
    if distinct_night_stages.len() > 1 && return_target != "next_story" {
        return None;
    }
    let home_target = infer_night_target(
        &instances,
        |instance| instance.home_stage_id.as_ref(),
        root_stage_id,
        &menu_ids,
        &story_stage_map,
    );
    let first_autoplay = instances[0].autoplay;
    let autoplay = instances
        .iter()
        .all(|instance| instance.autoplay == first_autoplay)
        .then_some(first_autoplay);

    Some(NightBridgeDetection {
        audio: audio?,
        return_target: Some(return_target),
        home_target,
        autoplay,
    })
}
