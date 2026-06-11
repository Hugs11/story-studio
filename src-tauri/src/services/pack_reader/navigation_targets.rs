use std::collections::{HashMap, HashSet};

pub(super) fn assign_return_targets(
    entries: &mut [serde_json::Value],
    stage_names: &HashMap<String, String>,
) -> Vec<serde_json::Value> {
    let menu_ids: HashSet<String> = entries
        .iter()
        .flat_map(collect_menu_ids_from_entry)
        .collect();

    let story_stage_map: HashMap<String, String> = build_story_stage_map(entries);
    let mut unresolved_transitions = Vec::new();

    for entry in entries.iter_mut() {
        resolve_entry_return_targets(
            entry,
            &menu_ids,
            &story_stage_map,
            stage_names,
            &mut unresolved_transitions,
        );
    }
    unresolved_transitions
}

#[derive(Default)]
struct AutoNextImportDetection {
    has_chain: bool,
    has_conflict: bool,
}

pub(super) fn extract_auto_next_return_overrides(entries: &mut [serde_json::Value]) -> bool {
    let mut detection = AutoNextImportDetection::default();
    inspect_auto_next_entries(entries, None, &mut detection);
    let auto_next_detected = detection.has_chain && !detection.has_conflict;
    if auto_next_detected {
        strip_auto_next_return_overrides(entries, None);
    }
    auto_next_detected
}

fn inspect_auto_next_entries(
    entries: &[serde_json::Value],
    parent_menu_id: Option<&str>,
    detection: &mut AutoNextImportDetection,
) {
    inspect_auto_next_level(entries, parent_menu_id, detection);
    for entry in entries {
        if entry.get("type").and_then(|value| value.as_str()) != Some("menu") {
            continue;
        }
        let menu_id = entry.get("id").and_then(|value| value.as_str());
        if let Some(children) = entry.get("children").and_then(|value| value.as_array()) {
            inspect_auto_next_entries(children, menu_id, detection);
        }
    }
}

fn inspect_auto_next_level(
    entries: &[serde_json::Value],
    parent_menu_id: Option<&str>,
    detection: &mut AutoNextImportDetection,
) {
    let story_indices: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.get("type").and_then(|value| value.as_str()) == Some("story"))
        .map(|(index, _)| index)
        .collect();
    if story_indices.is_empty() {
        return;
    }

    for (position, story_index) in story_indices.iter().enumerate() {
        let story = &entries[*story_index];
        if has_after_playback_end_step(story) {
            detection.has_conflict = true;
            return;
        }

        let return_target = story
            .get("returnAfterPlay")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let is_last_story = position + 1 == story_indices.len();
        if is_last_story {
            if !target_matches_parent(return_target, parent_menu_id) {
                detection.has_conflict = true;
                return;
            }
            continue;
        }

        let next_story = &entries[story_indices[position + 1]];
        let Some(next_story_id) = next_story.get("id").and_then(|value| value.as_str()) else {
            detection.has_conflict = true;
            return;
        };
        if !target_matches_story(return_target, next_story_id) {
            detection.has_conflict = true;
            return;
        }
        detection.has_chain = true;
    }
}

fn strip_auto_next_return_overrides(
    entries: &mut [serde_json::Value],
    parent_menu_id: Option<&str>,
) {
    let story_indices: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.get("type").and_then(|value| value.as_str()) == Some("story"))
        .map(|(index, _)| index)
        .collect();

    for (position, story_index) in story_indices.iter().enumerate() {
        let return_target = entries[*story_index]
            .get("returnAfterPlay")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let is_last_story = position + 1 == story_indices.len();
        let should_strip = if is_last_story {
            target_matches_parent(return_target, parent_menu_id)
        } else {
            entries[story_indices[position + 1]]
                .get("id")
                .and_then(|value| value.as_str())
                .map(|next_story_id| target_matches_story(return_target, next_story_id))
                .unwrap_or(false)
        };
        if should_strip {
            if let Some(obj) = entries[*story_index].as_object_mut() {
                obj.remove("returnAfterPlay");
            }
        }
    }

    for entry in entries.iter_mut() {
        if entry.get("type").and_then(|value| value.as_str()) != Some("menu") {
            continue;
        }
        let menu_id = entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        if let Some(children) = entry
            .get_mut("children")
            .and_then(|value| value.as_array_mut())
        {
            strip_auto_next_return_overrides(children, menu_id.as_deref());
        }
    }
}

fn has_after_playback_end_step(entry: &serde_json::Value) -> bool {
    entry
        .get("afterPlaybackPromptAudio")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .is_some()
        || entry
            .get("afterPlaybackSequence")
            .and_then(|value| value.as_array())
            .map(|steps| !steps.is_empty())
            .unwrap_or(false)
}

fn target_matches_story(target: Option<&str>, story_id: &str) -> bool {
    let Some(target) = target else {
        return false;
    };
    target == format!("story:{story_id}") || target == format!("story_play:{story_id}")
}

fn target_matches_parent(target: Option<&str>, parent_menu_id: Option<&str>) -> bool {
    match parent_menu_id {
        Some(menu_id) => {
            target.is_none()
                || target == Some("current_menu")
                || target == Some(menu_id)
                || target == Some(format!("menu:{menu_id}").as_str())
        }
        None => target.is_none() || target == Some("root"),
    }
}

/// Construit une table { stage_uuid → story_item_uuid } couvrant :
/// - l'UUID du titre (= item id)
/// - l'UUID du play stage (champ temporaire _playStageId)
pub(super) fn build_story_stage_map(entries: &[serde_json::Value]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for entry in entries {
        collect_story_stage_uuids(entry, &mut map);
    }
    map
}

pub(super) fn collect_story_stage_uuids(
    entry: &serde_json::Value,
    map: &mut HashMap<String, String>,
) {
    let entry_type = entry.get("type").and_then(|v| v.as_str());
    if entry_type == Some("story") {
        if let Some(item_id) = entry.get("id").and_then(|v| v.as_str()) {
            map.insert(item_id.to_string(), item_id.to_string());
            if let Some(play_id) = entry.get("_playStageId").and_then(|v| v.as_str()) {
                map.insert(play_id.to_string(), item_id.to_string());
            }
            if let Some(home_step_id) = entry
                .get("afterPlaybackHomeStep")
                .and_then(|value| value.as_object())
                .and_then(|step| step.get("id"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                map.insert(
                    home_step_id.to_string(),
                    format!("story_home_step:{}", item_id),
                );
            }
        }
    } else if entry_type == Some("menu") {
        if let Some(children) = entry.get("children").and_then(|v| v.as_array()) {
            for child in children {
                collect_story_stage_uuids(child, map);
            }
        }
    }
}

pub(super) fn collect_menu_ids_from_entry(entry: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    if entry.get("type").and_then(|v| v.as_str()) == Some("menu") {
        if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
            ids.push(id.to_string());
        }
        if let Some(children) = entry.get("children").and_then(|v| v.as_array()) {
            for child in children {
                ids.extend(collect_menu_ids_from_entry(child));
            }
        }
    }
    ids
}

pub(super) struct StoryNavigationContext {
    pub(super) play_stage_id: String,
    pub(super) next_story_id: Option<String>,
    pub(super) fallback_stage_id: String,
}

pub(super) fn collect_story_navigation_contexts(
    entries: &[serde_json::Value],
    parent_menu_id: Option<&str>,
    contexts: &mut Vec<StoryNavigationContext>,
) {
    for (index, entry) in entries.iter().enumerate() {
        match entry.get("type").and_then(|value| value.as_str()) {
            Some("story") => {
                let Some(story_id) = entry.get("id").and_then(|value| value.as_str()) else {
                    continue;
                };
                let play_stage_id = entry
                    .get("_playStageId")
                    .and_then(|value| value.as_str())
                    .unwrap_or(story_id);
                let next_story_id = entries[(index + 1)..].iter().find_map(|candidate| {
                    if candidate.get("type").and_then(|value| value.as_str()) == Some("story") {
                        candidate
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    } else {
                        None
                    }
                });
                contexts.push(StoryNavigationContext {
                    play_stage_id: play_stage_id.to_string(),
                    next_story_id,
                    fallback_stage_id: parent_menu_id.unwrap_or(story_id).to_string(),
                });
            }
            Some("menu") => {
                let menu_id = entry.get("id").and_then(|value| value.as_str());
                if let Some(children) = entry.get("children").and_then(|value| value.as_array()) {
                    collect_story_navigation_contexts(children, menu_id, contexts);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn push_unresolved_transition(
    unresolved_transitions: &mut Vec<serde_json::Value>,
    entry_id: Option<&str>,
    entry_name: Option<&str>,
    field: &str,
    target_stage_id: Option<&str>,
    target_stage_name: Option<&str>,
    detail: &str,
) {
    if field == "returnOnHome" && target_stage_name == Some("Cloche retour") {
        return;
    }

    let label = entry_name.unwrap_or("Entree importee");
    let target_label = target_stage_name
        .filter(|name| !name.trim().is_empty())
        .or(target_stage_id);
    let message = match target_label {
        Some(target) => format!("{label} — {detail} vers « {target} » non modelisee."),
        None => format!("{label} — {detail} non modelisee."),
    };
    unresolved_transitions.push(serde_json::json!({
        "entryId": entry_id,
        "entryName": entry_name,
        "field": field,
        "targetStageId": target_stage_id,
        "targetStageName": target_stage_name,
        "message": message,
    }));
}

pub(super) fn resolve_entry_return_targets(
    entry: &mut serde_json::Value,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
    stage_names: &HashMap<String, String>,
    unresolved_transitions: &mut Vec<serde_json::Value>,
) {
    let entry_id = entry.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let entry_name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    if entry.get("type").and_then(|v| v.as_str()) == Some("story") {
        let return_stage_id = entry
            .get("returnStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let return_on_home_stage_id = entry
            .get("returnOnHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let return_on_home_none = entry
            .get("returnOnHomeNone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let title_return_on_home_stage_id = entry
            .get("titleReturnOnHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let title_return_on_home_none = entry
            .get("titleReturnOnHomeNone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let return_story_stage_id = entry
            .get("returnStoryStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let home_story_stage_id = entry
            .get("homeStoryStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let prompt_ok_stage_id = entry
            .get("afterPlaybackPromptOkStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let prompt_home_stage_id = entry
            .get("afterPlaybackPromptHomeStageId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("returnStageId");
            obj.remove("returnOnHomeStageId");
            obj.remove("returnOnHomeNone");
            obj.remove("titleReturnOnHomeStageId");
            obj.remove("titleReturnOnHomeNone");
            obj.remove("returnStoryStageId");
            obj.remove("homeStoryStageId");
            obj.remove("afterPlaybackPromptOkStageId");
            obj.remove("afterPlaybackPromptHomeStageId");
            obj.remove("_playStageId");
            if let Some(steps) = obj
                .get_mut("afterPlaybackSequence")
                .and_then(|value| value.as_array_mut())
            {
                for step in steps.iter_mut() {
                    let Some(step_obj) = step.as_object_mut() else {
                        continue;
                    };
                    let ok_stage_id = step_obj
                        .remove("okStageId")
                        .and_then(|value| value.as_str().map(|value| value.to_string()));
                    let ok_choice_stage_ids: Vec<String> = step_obj
                        .remove("okChoiceStageIds")
                        .and_then(|value| value.as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect();
                    let home_stage_id = step_obj
                        .remove("homeStageId")
                        .and_then(|value| value.as_str().map(|value| value.to_string()));
                    let ok_choice_targets: Vec<serde_json::Value> = ok_choice_stage_ids
                        .iter()
                        .filter_map(|stage_id| {
                            resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                        })
                        .collect();
                    if ok_choice_targets.len() > 1 {
                        step_obj.insert(
                            "okChoiceTargets".to_string(),
                            serde_json::Value::Array(ok_choice_targets),
                        );
                    }
                    if let Some(target) = ok_stage_id.as_deref().and_then(|stage_id| {
                        resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                    }) {
                        step_obj.insert("okTarget".to_string(), target);
                    } else if let Some(stage_id) = ok_stage_id.as_deref() {
                        let step_name = step_obj
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("?");
                        let detail = format!("destination OK de l'etape « {step_name} »");
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "afterPlaybackSequence.okTarget",
                            Some(stage_id),
                            stage_names.get(stage_id).map(String::as_str),
                            &detail,
                        );
                    }
                    if let Some(target) = home_stage_id.as_deref().and_then(|stage_id| {
                        resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                    }) {
                        step_obj.insert("homeTarget".to_string(), target);
                    } else if let Some(stage_id) = home_stage_id.as_deref() {
                        let step_name = step_obj
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("?");
                        let detail = format!("destination Home de l'etape « {step_name} »");
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "afterPlaybackSequence.homeTarget",
                            Some(stage_id),
                            stage_names.get(stage_id).map(String::as_str),
                            &detail,
                        );
                    }
                }
            }
            // Cible OK : story→story prioritaire sur menu→story
            if let Some(home_step_obj) = obj
                .get_mut("afterPlaybackHomeStep")
                .and_then(|value| value.as_object_mut())
            {
                let home_stage_id = home_step_obj
                    .remove("homeStageId")
                    .and_then(|value| value.as_str().map(|value| value.to_string()));
                if let Some(target) = home_stage_id.as_deref().and_then(|stage_id| {
                    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                }) {
                    home_step_obj.insert("homeTarget".to_string(), target);
                } else if let Some(stage_id) = home_stage_id.as_deref() {
                    let step_name = home_step_obj
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("?");
                    let detail = format!("destination Home de l'etape Â« {step_name} Â»");
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "afterPlaybackHomeStep.homeTarget",
                        Some(stage_id),
                        stage_names.get(stage_id).map(String::as_str),
                        &detail,
                    );
                }
            }
            if let Some(stage_id) = return_story_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&stage_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnAfterPlay".to_string(), target);
                } else if let Some(target_id) = return_stage_id {
                    // The "next story" stage didn't map to a story item (e.g. night-mode outro
                    // stage that leads back to menu) — fall back to the menu return target.
                    if let Some(target) =
                        resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                    {
                        obj.insert("returnAfterPlay".to_string(), target);
                    } else {
                        push_unresolved_transition(
                            unresolved_transitions,
                            entry_id.as_deref(),
                            entry_name.as_deref(),
                            "returnAfterPlay",
                            Some(&target_id),
                            stage_names.get(&target_id).map(String::as_str),
                            "destination de retour apres lecture",
                        );
                    }
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnAfterPlay",
                        Some(&stage_id),
                        stage_names.get(&stage_id).map(String::as_str),
                        "destination de retour apres lecture",
                    );
                }
            } else if let Some(target_id) = return_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnAfterPlay".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnAfterPlay",
                        Some(&target_id),
                        stage_names.get(&target_id).map(String::as_str),
                        "destination de retour apres lecture",
                    );
                }
            }
            // Cible Home : story→story prioritaire
            if let Some(stage_id) = home_story_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&stage_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnOnHome".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnOnHome",
                        Some(&stage_id),
                        stage_names.get(&stage_id).map(String::as_str),
                        "destination du bouton Accueil",
                    );
                }
            } else if return_on_home_none {
                obj.insert(
                    "returnOnHomeNone".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else if let Some(target_id) = return_on_home_stage_id {
                if let Some(target) =
                    resolve_navigation_target_for_stage(&target_id, menu_ids, story_stage_map)
                {
                    obj.insert("returnOnHome".to_string(), target);
                } else {
                    push_unresolved_transition(
                        unresolved_transitions,
                        entry_id.as_deref(),
                        entry_name.as_deref(),
                        "returnOnHome",
                        Some(&target_id),
                        stage_names.get(&target_id).map(String::as_str),
                        "destination du bouton Accueil",
                    );
                }
            }
            if let Some(target) = title_return_on_home_stage_id
                .as_deref()
                .and_then(|stage_id| {
                    resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
                })
            {
                obj.insert("titleReturnOnHome".to_string(), target);
            } else if title_return_on_home_none {
                obj.insert(
                    "titleReturnOnHomeNone".to_string(),
                    serde_json::Value::Bool(true),
                );
            } else if let Some(stage_id) = title_return_on_home_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "titleReturnOnHome",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination Accueil du titre",
                );
            }
            if let Some(target) = prompt_ok_stage_id.as_deref().and_then(|stage_id| {
                resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
            }) {
                obj.insert("afterPlaybackPromptOkTarget".to_string(), target);
            } else if let Some(stage_id) = prompt_ok_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "afterPlaybackPromptOkTarget",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination OK du prompt final",
                );
            }
            if let Some(target) = prompt_home_stage_id.as_deref().and_then(|stage_id| {
                resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
            }) {
                obj.insert("afterPlaybackPromptHomeTarget".to_string(), target);
            } else if let Some(stage_id) = prompt_home_stage_id.as_deref() {
                push_unresolved_transition(
                    unresolved_transitions,
                    entry_id.as_deref(),
                    entry_name.as_deref(),
                    "afterPlaybackPromptHomeTarget",
                    Some(stage_id),
                    stage_names.get(stage_id).map(String::as_str),
                    "destination Home du prompt final",
                );
            }
        }
        return;
    }

    if entry.get("type").and_then(|v| v.as_str()) != Some("menu") {
        return;
    }

    let return_on_home_stage_id = entry
        .get("returnOnHomeStageId")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    if let Some(obj) = entry.as_object_mut() {
        obj.remove("returnOnHomeStageId");
        if let Some(target) = return_on_home_stage_id.as_deref().and_then(|stage_id| {
            resolve_navigation_target_for_stage(stage_id, menu_ids, story_stage_map)
        }) {
            obj.insert("returnOnHome".to_string(), target);
        } else if let Some(stage_id) = return_on_home_stage_id.as_deref() {
            push_unresolved_transition(
                unresolved_transitions,
                entry_id.as_deref(),
                entry_name.as_deref(),
                "returnOnHome",
                Some(stage_id),
                stage_names.get(stage_id).map(String::as_str),
                "destination Accueil du menu",
            );
        }
    }

    if let Some(children) = entry.get_mut("children").and_then(|v| v.as_array_mut()) {
        for child in children.iter_mut() {
            resolve_entry_return_targets(
                child,
                menu_ids,
                story_stage_map,
                stage_names,
                unresolved_transitions,
            );
        }
        compress_menu_return_defaults(entry);
    }
}

pub(super) fn resolve_navigation_target_for_stage(
    stage_id: &str,
    menu_ids: &HashSet<String>,
    story_stage_map: &HashMap<String, String>,
) -> Option<serde_json::Value> {
    if let Some(item_id) = story_stage_map.get(stage_id) {
        if item_id.starts_with("story_home_step:") {
            return Some(serde_json::Value::String(item_id.clone()));
        }
        let prefix = if stage_id == item_id {
            "story"
        } else {
            "story_play"
        };
        return Some(serde_json::Value::String(format!("{}:{}", prefix, item_id)));
    }
    if menu_ids.contains(stage_id) {
        return Some(serde_json::Value::String(stage_id.to_string()));
    }
    None
}

pub(super) fn remove_night_mode_return_overrides(
    entries: &mut [serde_json::Value],
    night_target: &str,
    parent_menu_id: Option<&str>,
) {
    for index in 0..entries.len() {
        if entries[index].get("type").and_then(|value| value.as_str()) == Some("menu") {
            let menu_id = entries[index]
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if let Some(children) = entries[index]
                .get_mut("children")
                .and_then(|value| value.as_array_mut())
            {
                remove_night_mode_return_overrides(children, night_target, menu_id.as_deref());
            }
            continue;
        }

        if entries[index].get("type").and_then(|value| value.as_str()) != Some("story") {
            continue;
        }

        let expected_target = if night_target == "next_story" {
            entries[(index + 1)..]
                .iter()
                .find_map(|candidate| {
                    if candidate.get("type").and_then(|value| value.as_str()) == Some("story") {
                        candidate
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(|id| format!("story:{id}"))
                    } else {
                        None
                    }
                })
                .or_else(|| parent_menu_id.map(|id| format!("menu:{id}")))
        } else {
            Some(night_target.to_string())
        };

        if entries[index]
            .get("returnAfterPlay")
            .and_then(|value| value.as_str())
            == expected_target.as_deref()
        {
            if let Some(obj) = entries[index].as_object_mut() {
                obj.remove("returnAfterPlay");
            }
        }
    }
}

pub(super) fn compress_menu_return_defaults(entry: &mut serde_json::Value) {
    if entry.get("type").and_then(|v| v.as_str()) != Some("menu") {
        return;
    }

    let Some(menu_id) = entry
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
    else {
        return;
    };

    let Some(children) = entry.get_mut("children").and_then(|v| v.as_array_mut()) else {
        return;
    };

    let story_targets: Vec<String> = children
        .iter()
        .filter(|child| child.get("type").and_then(|v| v.as_str()) == Some("story"))
        .filter_map(|child| {
            child
                .get("returnAfterPlay")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
        })
        .collect();

    if story_targets.is_empty() {
        return;
    }

    let first_target = story_targets[0].clone();
    if !story_targets.iter().all(|target| target == &first_target) {
        return;
    }

    for child in children.iter_mut() {
        if child.get("type").and_then(|v| v.as_str()) != Some("story") {
            continue;
        }
        if child.get("returnAfterPlay").and_then(|v| v.as_str()) == Some(first_target.as_str()) {
            if let Some(obj) = child.as_object_mut() {
                obj.remove("returnAfterPlay");
            }
        }
    }

    if let Some(obj) = entry.as_object_mut() {
        if first_target == menu_id {
            obj.remove("returnAfterPlay");
        } else {
            obj.insert(
                "returnAfterPlay".to_string(),
                serde_json::Value::String(first_target),
            );
        }
    }
}
