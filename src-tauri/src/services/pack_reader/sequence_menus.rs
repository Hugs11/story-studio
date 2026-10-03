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
        uniquify_imported_continuation_ids(&mut children);
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

fn uniquify_imported_continuation_ids(children: &mut [serde_json::Value]) {
    let mut id_counts = HashMap::new();
    let mut reserved_ids = HashSet::new();
    for child in children.iter() {
        collect_continuation_entry_ids(child, &mut id_counts, &mut reserved_ids);
    }

    let mut targeted_ids = HashSet::new();
    for child in children.iter() {
        collect_continuation_navigation_targets(child, &mut targeted_ids);
    }

    let mut seen_ids = HashMap::new();
    let mut next_suffixes = HashMap::new();
    for child in children.iter_mut() {
        rename_duplicate_continuation_ids(
            child,
            &id_counts,
            &targeted_ids,
            &mut reserved_ids,
            &mut seen_ids,
            &mut next_suffixes,
        );
    }
}

fn collect_continuation_entry_ids(
    entry: &serde_json::Value,
    id_counts: &mut HashMap<String, usize>,
    reserved_ids: &mut HashSet<String>,
) {
    let Some(object) = entry.as_object() else {
        return;
    };
    if let Some(id) = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
    {
        *id_counts.entry(id.to_string()).or_default() += 1;
        reserved_ids.insert(id.to_string());
    }
    if let Some(children) = object.get("children").and_then(serde_json::Value::as_array) {
        for child in children {
            collect_continuation_entry_ids(child, id_counts, reserved_ids);
        }
    }
}

fn collect_continuation_navigation_targets(
    value: &serde_json::Value,
    targeted_ids: &mut HashSet<String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if continuation_navigation_target_key(key) {
                    if let Some(target) = child.as_str() {
                        if let Some(target_id) = continuation_navigation_target_id(target) {
                            targeted_ids.insert(target_id.to_string());
                        }
                    }
                } else if key == "okChoiceTargets" {
                    if let Some(targets) = child.as_array() {
                        for target in targets {
                            if let Some(target_id) =
                                target.as_str().and_then(continuation_navigation_target_id)
                            {
                                targeted_ids.insert(target_id.to_string());
                            }
                        }
                    }
                }
                collect_continuation_navigation_targets(child, targeted_ids);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_continuation_navigation_targets(value, targeted_ids);
            }
        }
        _ => {}
    }
}

fn continuation_navigation_target_key(key: &str) -> bool {
    matches!(
        key,
        "target"
            | "okTarget"
            | "homeTarget"
            | "returnAfterPlay"
            | "returnOnHome"
            | "titleReturnOnHome"
            | "afterPlaybackPromptOkTarget"
            | "afterPlaybackPromptHomeTarget"
            | "targetId"
            | "effectiveTargetId"
    )
}

fn continuation_navigation_target_id(target: &str) -> Option<&str> {
    let target = target.trim();
    if target.is_empty() || matches!(target, "root" | "current_menu" | "next_story") {
        return None;
    }
    Some(target.split_once(':').map(|(_, id)| id).unwrap_or(target))
}

fn rename_duplicate_continuation_ids(
    entry: &mut serde_json::Value,
    id_counts: &HashMap<String, usize>,
    targeted_ids: &HashSet<String>,
    reserved_ids: &mut HashSet<String>,
    seen_ids: &mut HashMap<String, usize>,
    next_suffixes: &mut HashMap<String, usize>,
) {
    let Some(object) = entry.as_object_mut() else {
        return;
    };
    if let Some(id) = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    {
        let seen = seen_ids.entry(id.clone()).or_default();
        *seen += 1;
        if id_counts.get(&id).copied().unwrap_or_default() > 1
            && *seen > 1
            && !targeted_ids.contains(&id)
        {
            let suffix = next_suffixes.entry(id.clone()).or_insert(2);
            let replacement = loop {
                let candidate = format!("{id}-occurrence-{suffix}");
                *suffix += 1;
                if reserved_ids.insert(candidate.clone()) {
                    break candidate;
                }
            };
            object.insert("id".to_string(), serde_json::Value::String(replacement));
        }
    }
    if let Some(children) = object
        .get_mut("children")
        .and_then(serde_json::Value::as_array_mut)
    {
        for child in children {
            rename_duplicate_continuation_ids(
                child,
                id_counts,
                targeted_ids,
                reserved_ids,
                seen_ids,
                next_suffixes,
            );
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, entry_type: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "type": entry_type, "name": id })
    }

    fn ids(children: &[serde_json::Value]) -> Vec<&str> {
        children
            .iter()
            .map(|entry| entry["id"].as_str().expect("id"))
            .collect()
    }

    #[test]
    fn continuation_menu_and_story_duplicate_ids_are_suffixed_before_prefixing() {
        let mut children = vec![entry("shared", "menu"), entry("shared", "story")];

        uniquify_imported_continuation_ids(&mut children);
        for child in &mut children {
            prefix_imported_continuation_ids(child, "sequence-choice");
        }

        assert_eq!(
            ids(&children),
            vec![
                "sequence-choice-shared",
                "sequence-choice-shared-occurrence-2"
            ]
        );
    }

    #[test]
    fn continuation_identical_story_duplicates_are_both_preserved() {
        let mut children = vec![entry("shared", "story"), entry("shared", "story")];

        uniquify_imported_continuation_ids(&mut children);

        assert_eq!(ids(&children), vec!["shared", "shared-occurrence-2"]);
        assert_eq!(children.len(), 2);
        assert_eq!(children[0]["type"], children[1]["type"]);
        assert_eq!(children[0]["name"], children[1]["name"]);
    }

    #[test]
    fn continuation_three_duplicate_ids_receive_sequential_suffixes() {
        let mut children = vec![
            entry("shared", "story"),
            entry("shared", "story"),
            entry("shared", "story"),
        ];

        uniquify_imported_continuation_ids(&mut children);

        assert_eq!(
            ids(&children),
            vec!["shared", "shared-occurrence-2", "shared-occurrence-3"]
        );
    }

    #[test]
    fn continuation_duplicate_ids_skip_reserved_source_suffixes() {
        let mut children = vec![
            entry("shared", "story"),
            entry("shared", "story"),
            entry("shared-occurrence-2", "story"),
        ];

        uniquify_imported_continuation_ids(&mut children);

        assert_eq!(
            ids(&children),
            vec!["shared", "shared-occurrence-3", "shared-occurrence-2"]
        );
    }

    #[test]
    fn continuation_targeted_duplicate_ids_are_not_renamed_for_every_supported_field() {
        let target_fields = [
            "target",
            "okTarget",
            "homeTarget",
            "returnAfterPlay",
            "returnOnHome",
            "titleReturnOnHome",
            "afterPlaybackPromptOkTarget",
            "afterPlaybackPromptHomeTarget",
            "targetId",
            "effectiveTargetId",
        ];
        for field in target_fields {
            let mut first = entry("shared", "story");
            first.as_object_mut().expect("entry object").insert(
                field.to_string(),
                serde_json::Value::String("story:shared".to_string()),
            );
            let mut children = vec![first, entry("shared", "story")];

            uniquify_imported_continuation_ids(&mut children);

            assert_eq!(ids(&children), vec!["shared", "shared"], "{field}");
        }

        let mut first = entry("shared", "story");
        first["okChoiceTargets"] = serde_json::json!(["shared", "menu:other"]);
        let mut children = vec![first, entry("shared", "story")];

        uniquify_imported_continuation_ids(&mut children);

        assert_eq!(ids(&children), vec!["shared", "shared"]);
    }

    #[test]
    fn continuation_id_transformation_is_deterministic() {
        let children = vec![
            serde_json::json!({
                "id": "shared",
                "type": "menu",
                "children": [entry("nested", "story")]
            }),
            serde_json::json!({
                "id": "shared",
                "type": "story",
                "children": [entry("nested", "story")]
            }),
        ];
        let mut left = children.clone();
        let mut right = children;

        uniquify_imported_continuation_ids(&mut left);
        uniquify_imported_continuation_ids(&mut right);

        assert_eq!(left, right);
    }

    #[test]
    fn continuation_unique_historical_ids_are_unchanged() {
        let mut children = vec![
            serde_json::json!({
                "id": "menu",
                "type": "menu",
                "children": [entry("nested", "story")]
            }),
            entry("story", "story"),
        ];
        let expected = children.clone();

        uniquify_imported_continuation_ids(&mut children);

        assert_eq!(children, expected);
    }
}
