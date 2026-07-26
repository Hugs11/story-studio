use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::after_playback::{is_imported_night_mode_stage_candidate, is_named_night_bridge_stage};
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
    fallback_overrides: Vec<NightFallbackOverride>,
}

struct NightFallbackOverride {
    story_id: String,
    target: String,
}

struct NightBridgeInstance {
    story_id: String,
    night_stage_id: String,
    return_stage_id: Option<String>,
    home_stage_id: Option<String>,
    next_story_stage_id: Option<String>,
    expected_next_or_fallback_stage_id: String,
    autoplay: bool,
    named_night_bridge: bool,
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

fn infer_night_return(
    instances: &[NightBridgeInstance],
    root_stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<(String, Vec<NightFallbackOverride>)> {
    if instances
        .iter()
        .any(|instance| instance.return_stage_id.is_none())
    {
        return None;
    }

    let has_next_story = instances
        .iter()
        .any(|instance| instance.next_story_stage_id.is_some());
    let all_named_night_bridges = instances.iter().all(|instance| instance.named_night_bridge);
    let every_non_terminal_follows_next = instances.iter().all(|instance| {
        instance
            .next_story_stage_id
            .as_ref()
            .is_none_or(|next_story| instance.return_stage_id.as_ref() == Some(next_story))
    });
    if has_next_story && all_named_night_bridges && every_non_terminal_follows_next {
        let mut fallback_overrides = Vec::new();
        for instance in instances
            .iter()
            .filter(|instance| instance.next_story_stage_id.is_none())
        {
            let actual_target = instance.return_stage_id.as_deref()?;
            if actual_target == instance.expected_next_or_fallback_stage_id {
                continue;
            }
            let target = normalize_stage_navigation_target(
                actual_target,
                root_stage_id,
                menu_ids,
                story_stage_map,
            )?;
            fallback_overrides.push(NightFallbackOverride {
                story_id: instance.story_id.clone(),
                target,
            });
        }
        return Some(("next_story".to_string(), fallback_overrides));
    }

    infer_night_target(
        instances,
        |instance| instance.return_stage_id.as_ref(),
        root_stage_id,
        menu_ids,
        story_stage_map,
    )
    .map(|target| (target, Vec::new()))
}

pub(super) fn apply_night_fallback_overrides(
    entries: &mut [serde_json::Value],
    detection: &NightBridgeDetection,
) {
    for entry in entries {
        if entry.get("type").and_then(|value| value.as_str()) == Some("menu") {
            if let Some(children) = entry
                .get_mut("children")
                .and_then(serde_json::Value::as_array_mut)
            {
                apply_night_fallback_overrides(children, detection);
            }
            continue;
        }

        let Some(entry_id) = entry.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(target) = detection
            .fallback_overrides
            .iter()
            .find(|fallback| fallback.story_id == entry_id)
            .map(|fallback| fallback.target.clone())
        else {
            continue;
        };
        entry["returnAfterPlay"] = serde_json::Value::String(target);
    }
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
            story_id: context.story_id,
            night_stage_id: night_stage_id.to_string(),
            return_stage_id: transition_target_stage_id(night_stage.get("okTransition"), actions)
                .map(str::to_string),
            home_stage_id: transition_target_stage_id(night_stage.get("homeTransition"), actions)
                .map(str::to_string),
            next_story_stage_id: context.next_story_id.clone(),
            expected_next_or_fallback_stage_id: context
                .next_story_id
                .unwrap_or(context.fallback_stage_id),
            autoplay: is_stage_autoplay(night_stage),
            named_night_bridge: is_named_night_bridge_stage(night_stage),
        });
    }

    if instances.is_empty() {
        return None;
    }

    let distinct_night_stages: HashSet<&str> = instances
        .iter()
        .map(|instance| instance.night_stage_id.as_str())
        .collect();
    let (return_target, fallback_overrides) =
        infer_night_return(&instances, root_stage_id, &menu_ids, &story_stage_map)?;
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
        fallback_overrides,
    })
}
