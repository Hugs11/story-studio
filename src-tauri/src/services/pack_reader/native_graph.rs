use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::stage::{
    is_stage_autoplay, resolve_asset, stage_action_options, stage_control_bool, stage_controls,
    stage_position_key,
};
use super::transitions::transition_target_stage_id;

pub(super) fn native_graph_with_resolved_assets(
    doc: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> serde_json::Value {
    let mut document = doc.clone();
    if let Some(stages) = document
        .get_mut("stageNodes")
        .and_then(|value| value.as_array_mut())
    {
        for stage in stages {
            if let Some(audio) = stage
                .get("audio")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets))
            {
                stage["audio"] = serde_json::Value::String(audio);
            }
            if let Some(image) = stage
                .get("image")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets))
            {
                stage["image"] = serde_json::Value::String(image);
            }
        }
    }

    let stage_count = document
        .get("stageNodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    let action_count = document
        .get("actionNodes")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);

    serde_json::json!({
        "formatVersion": 1,
        "kind": "imported-story-graph",
        "preserveForRoundTrip": true,
        "projectionStatus": "lossy",
        "projectionReason": "branching-graph",
        "stageCount": stage_count,
        "actionCount": action_count,
        "document": document,
    })
}

pub(super) fn has_interactive_branching_graph(
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    stages.values().any(|stage| {
        if !is_stage_autoplay(stage) {
            return false;
        }
        let options = stage_action_options(stage, actions);
        options.len() >= 2
            && options.iter().all(|stage_id| {
                stages.get(stage_id).is_some_and(|candidate| {
                    stage_control_bool(candidate, "wheel", false) && !is_stage_autoplay(candidate)
                })
            })
    })
}

fn native_projection_label(
    stage_id: &str,
    stage: &serde_json::Value,
    stage_ordinals: &HashMap<String, usize>,
) -> String {
    let explicit_name = stage
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "Stage title");
    if let Some(name) = explicit_name {
        return name.to_string();
    }
    let ordinal = stage_ordinals.get(stage_id).copied().unwrap_or(0) + 1;
    let kind = if stage
        .get("squareOne")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "Depart"
    } else if stage_control_bool(stage, "wheel", false) && !is_stage_autoplay(stage) {
        "Choix"
    } else if is_stage_autoplay(stage) {
        "Lecture"
    } else {
        "Stage"
    };
    format!("{} {:02}", kind, ordinal)
}

fn native_projection_ordinals(
    stages: &HashMap<&str, &serde_json::Value>,
) -> HashMap<String, usize> {
    let mut ordered: Vec<(&str, &serde_json::Value)> = stages
        .iter()
        .map(|(stage_id, stage)| (*stage_id, *stage))
        .collect();
    ordered.sort_by_key(|(_, stage)| stage_position_key(stage));
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, (stage_id, _))| (stage_id.to_string(), index))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn native_projection_story_entry(
    stage_id: &str,
    stage: &serde_json::Value,
    label: String,
    assets: &HashMap<String, PathBuf>,
    is_reference: bool,
    reference_counter: &mut usize,
) -> serde_json::Value {
    let audio = resolve_asset(stage.get("audio").and_then(|value| value.as_str()), assets);
    let image = resolve_asset(stage.get("image").and_then(|value| value.as_str()), assets);
    let id = if is_reference {
        *reference_counter += 1;
        format!("native-ref-{}-{}", *reference_counter, stage_id)
    } else {
        stage_id.to_string()
    };
    serde_json::json!({
        "id": id,
        "type": "story",
        "name": if is_reference { format!("Retour vers {}", label) } else { label },
        "audio": audio,
        "itemAudio": audio,
        "itemImage": image,
        "nativeStageId": stage_id,
        "nativeReference": is_reference,
        "controlSettings": if is_reference {
            serde_json::json!({
                "autoplay": true,
                "wheel": false,
                "pause": false,
                "ok": false,
                "home": true,
            })
        } else {
            stage_controls(stage)
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn native_projection_entry_for_stage(
    stage_id: &str,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
    stage_ordinals: &HashMap<String, usize>,
    active_path: &mut HashSet<String>,
    expanded: &mut HashSet<String>,
    reference_counter: &mut usize,
) -> Option<serde_json::Value> {
    let stage = *stages.get(stage_id)?;
    let label = native_projection_label(stage_id, stage, stage_ordinals);
    if active_path.contains(stage_id) || expanded.contains(stage_id) {
        return Some(native_projection_story_entry(
            stage_id,
            stage,
            label,
            assets,
            true,
            reference_counter,
        ));
    }

    active_path.insert(stage_id.to_string());
    let options = stage_action_options(stage, actions);
    let is_choice = stage_control_bool(stage, "wheel", false) && !is_stage_autoplay(stage);
    let entry = if is_choice && !options.is_empty() {
        expanded.insert(stage_id.to_string());
        let children: Vec<serde_json::Value> = options
            .iter()
            .filter_map(|target_id| {
                native_projection_entry_for_stage(
                    target_id,
                    stages,
                    actions,
                    assets,
                    stage_ordinals,
                    active_path,
                    expanded,
                    reference_counter,
                )
            })
            .collect();
        let audio = resolve_asset(stage.get("audio").and_then(|value| value.as_str()), assets);
        let image = resolve_asset(stage.get("image").and_then(|value| value.as_str()), assets);
        serde_json::json!({
            "id": stage_id,
            "type": "menu",
            "name": label,
            "audio": audio,
            "image": image,
            "autoBlackImage": image.is_none(),
            "nativeStageId": stage_id,
            "controlSettings": stage_controls(stage),
            "returnOnHomeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
            "children": children,
        })
    } else {
        expanded.insert(stage_id.to_string());
        native_projection_story_entry(stage_id, stage, label, assets, false, reference_counter)
    };
    active_path.remove(stage_id);
    Some(entry)
}

pub(super) fn build_native_graph_projection_entries(
    square_one: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    let stage_ordinals = native_projection_ordinals(stages);
    let mut active_path = HashSet::new();
    let mut expanded = HashSet::new();
    let mut reference_counter = 0usize;
    stage_action_options(square_one, actions)
        .iter()
        .filter_map(|stage_id| {
            native_projection_entry_for_stage(
                stage_id,
                stages,
                actions,
                assets,
                &stage_ordinals,
                &mut active_path,
                &mut expanded,
                &mut reference_counter,
            )
        })
        .collect()
}

pub(super) fn build_native_graph_flat_stage_map_entry(
    stages: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    let stage_ordinals = native_projection_ordinals(stages);
    let mut ordered: Vec<(&str, &serde_json::Value)> = stages
        .iter()
        .filter(|(_, stage)| {
            !stage
                .get("squareOne")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .map(|(stage_id, stage)| (*stage_id, *stage))
        .collect();
    ordered.sort_by_key(|(_, stage)| stage_position_key(stage));

    let mut reference_counter = 0usize;
    let children: Vec<serde_json::Value> = ordered
        .into_iter()
        .map(|(stage_id, stage)| {
            native_projection_story_entry(
                stage_id,
                stage,
                native_projection_label(stage_id, stage, &stage_ordinals),
                assets,
                false,
                &mut reference_counter,
            )
        })
        .collect();

    if children.is_empty() {
        Vec::new()
    } else {
        vec![serde_json::json!({
            "id": "native-graph-stage-map",
            "type": "menu",
            "name": "Carte du graphe interactif",
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "autoBlackImage": true,
            "controlSettings": {
                "autoplay": false,
                "wheel": true,
                "pause": false,
                "ok": true,
                "home": true,
            },
            "children": children,
        })]
    }
}
