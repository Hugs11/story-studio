use std::collections::{HashMap, HashSet};

use crate::native_pack::OptionSelection;

use super::stage::{action_option_slots, action_options};

/// Les destinations que la sélection d'une transition peut atteindre, dans
/// l'ordre des options.
///
/// `Random` les désigne toutes : il ne doit jamais être rabattu sur
/// l'option `0`, et une projection statique n'a pas à tirer au sort. `Fixed(i)`
/// n'en désigne qu'une, et aucune si `i` est hors bornes.
pub(super) fn transition_candidate_targets<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Vec<&'a str> {
    let Some(action_id) = transition
        .and_then(|t| t.get("actionNode"))
        .and_then(|v| v.as_str())
    else {
        return Vec::new();
    };
    let Some(index) = transition
        .and_then(|t| t.get("optionIndex"))
        .and_then(|v| v.as_i64())
    else {
        return Vec::new();
    };
    let Ok(selection) = OptionSelection::from_dialect_index(index) else {
        return Vec::new();
    };
    let Some(action) = actions.get(action_id) else {
        return Vec::new();
    };
    let slots = action_option_slots(action);
    selection
        .candidate_indices(slots.len())
        .filter_map(|index| slots.get(index).copied().flatten())
        .collect()
}

/// La destination **unique** d'une transition, ou `None` quand il n'y en a pas
/// exactement une.
///
/// Une sélection aléatoire sur plusieurs options n'en a pas : la projection
/// arborescente ne modélise alors aucun retour, ce que le juge de fidélité
/// relève comme un écart avec l'oracle. C'est le comportement voulu : mieux vaut
/// une projection incomplète qu'une projection qui affirme `Fixed(0)`.
pub(super) fn transition_target_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let targets = transition_candidate_targets(transition, actions);
    match targets.as_slice() {
        [target] => Some(target),
        _ => None,
    }
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

/// Vrai dès que la transition atteint au moins une destination. Une sélection
/// aléatoire en a autant que l'Action a d'options : elle n'est pas « absente ».
pub(super) fn has_transition_target(
    transition: Option<&serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    !transition_candidate_targets(transition, actions).is_empty()
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
