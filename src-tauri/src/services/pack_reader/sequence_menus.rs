use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::projection::walk_entry;

#[allow(clippy::too_many_arguments)]
pub(super) fn expand_sequence_choice_menus(
    entries: Vec<serde_json::Value>,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
    existing_story_stage_ids: &HashSet<String>,
) -> Vec<serde_json::Value> {
    let mut expanded = Vec::new();
    for mut entry in entries {
        if entry.get("type").and_then(|value| value.as_str()) == Some("menu") {
            if let Some(children) = entry
                .get_mut("children")
                .and_then(|value| value.as_array_mut())
            {
                let current_children = std::mem::take(children);
                *children = expand_sequence_choice_menus(
                    current_children,
                    stages,
                    actions,
                    assets,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                    existing_story_stage_ids,
                );
            }
            expanded.push(entry);
            continue;
        }

        let continuation_menus = extract_sequence_choice_menus(
            &mut entry,
            stages,
            actions,
            assets,
            prompt_stage_usage,
            night_mode_available,
            story_play_stage_ids,
            existing_story_stage_ids,
        );
        expanded.push(entry);
        expanded.extend(continuation_menus);
    }
    expanded
}

#[allow(clippy::too_many_arguments)]
fn extract_sequence_choice_menus(
    entry: &mut serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
    existing_story_stage_ids: &HashSet<String>,
) -> Vec<serde_json::Value> {
    if entry.get("type").and_then(|value| value.as_str()) != Some("story") {
        return Vec::new();
    }
    let entry_id = entry
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("story")
        .to_string();
    let entry_name = entry
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Histoire")
        .to_string();

    let Some(steps) = entry
        .get_mut("afterPlaybackSequence")
        .and_then(|value| value.as_array_mut())
    else {
        return Vec::new();
    };

    let mut menus = Vec::new();
    for step in steps.iter_mut() {
        let Some(step_obj) = step.as_object_mut() else {
            continue;
        };
        let choice_ids: Vec<String> = step_obj
            .get("okChoiceStageIds")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        if choice_ids.len() <= 1
            || choice_ids
                .iter()
                .all(|stage_id| existing_story_stage_ids.contains(stage_id))
        {
            continue;
        }

        let step_id = step_obj
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("step");
        let step_name = step_obj
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("Ok ?")
            .to_string();
        let menu_id = format!("{entry_id}-sequence-choice-{step_id}");
        let mut local_visited = HashSet::new();
        let mut children: Vec<serde_json::Value> = choice_ids
            .iter()
            .filter_map(|stage_id| {
                let stage = stages.get(stage_id.as_str())?;
                walk_entry(
                    stage,
                    stages,
                    actions,
                    assets,
                    &mut local_visited,
                    prompt_stage_usage,
                    night_mode_available,
                    story_play_stage_ids,
                )
                .ok()
            })
            .collect();
        if children.is_empty() {
            continue;
        }
        for child in children.iter_mut() {
            prefix_imported_continuation_ids(child, &menu_id);
        }

        step_obj.remove("okChoiceStageIds");
        step_obj.remove("okStageId");
        step_obj.insert(
            "okTarget".to_string(),
            serde_json::Value::String(menu_id.clone()),
        );
        menus.push(serde_json::json!({
            "id": menu_id,
            "type": "menu",
            "name": format!("Suite apres {entry_name}"),
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": {
                "autoplay": false,
                "wheel": true,
                "ok": true,
                "home": true,
                "pause": false
            },
            "children": children,
            "_importedContinuation": {
                "sourceStoryId": entry_id,
                "sourceStoryName": entry_name,
                "sourceStepName": step_name
            }
        }));
    }
    menus
}

fn prefix_imported_continuation_ids(entry: &mut serde_json::Value, prefix: &str) {
    if let Some(obj) = entry.as_object_mut() {
        if let Some(id) = obj
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        {
            obj.insert(
                "id".to_string(),
                serde_json::Value::String(format!("{prefix}-{id}")),
            );
        }
        if let Some(children) = obj
            .get_mut("children")
            .and_then(|value| value.as_array_mut())
        {
            for child in children.iter_mut() {
                prefix_imported_continuation_ids(child, prefix);
            }
        }
    }
}
