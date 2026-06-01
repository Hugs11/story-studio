use std::collections::{HashMap, HashSet};

use super::stage::action_options;

pub(super) fn transition_target_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let action_id = transition
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())?;
    let option_index = transition
        .and_then(|t| t.get("optionIndex"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let action = actions.get(action_id)?;
    let options = action_options(action);
    let index = if option_index < 0 {
        0_usize
    } else {
        option_index as usize
    };
    options.get(index).copied()
}

pub(super) fn transition_action_options<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Vec<&'a str> {
    let Some(action_id) = transition
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())
    else {
        return Vec::new();
    };
    actions
        .get(action_id)
        .map(|action| action_options(action))
        .unwrap_or_default()
}

pub(super) fn has_transition_target(
    transition: Option<&serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    transition_target_stage_id(transition, actions).is_some()
}

pub(super) fn stage_next_single_option<'a>(
    stage_id: &'a str,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let stage = stages.get(stage_id)?;
    let action_id = stage
        .get("okTransition")
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())?;
    let action = actions.get(action_id)?;
    let options = action_options(action);
    if options.len() == 1 {
        options.first().copied()
    } else {
        None
    }
}

pub(super) fn resolve_transition_return_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let mut current = transition_target_stage_id(transition, actions)?;
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current) {
            return Some(current);
        }

        let Some(next) = stage_next_single_option(current, stages, actions) else {
            return Some(current);
        };
        current = next;
    }
}
