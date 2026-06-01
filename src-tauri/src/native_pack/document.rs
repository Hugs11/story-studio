use serde::{Deserialize, Serialize};
use serde_json::Number;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoryDocument {
    pub(crate) title: String,
    pub(crate) version: i32,
    pub(crate) description: String,
    pub(crate) format: String,
    #[serde(rename = "nightModeAvailable")]
    pub(crate) night_mode_available: bool,
    #[serde(rename = "actionNodes")]
    pub(crate) action_nodes: Vec<ActionNode>,
    #[serde(rename = "stageNodes")]
    pub(crate) stage_nodes: Vec<StageNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ActionNode {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) options: Vec<String>,
    #[serde(default = "zero_position")]
    pub(crate) position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StageNode {
    pub(crate) uuid: String,
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) stage_type: String,
    #[serde(rename = "squareOne", default)]
    pub(crate) square_one: bool,
    pub(crate) audio: Option<String>,
    pub(crate) image: Option<String>,
    #[serde(rename = "controlSettings")]
    pub(crate) control_settings: ControlSettings,
    #[serde(rename = "homeTransition")]
    pub(crate) home_transition: Option<Transition>,
    #[serde(rename = "okTransition")]
    pub(crate) ok_transition: Option<Transition>,
    #[serde(default = "zero_position")]
    pub(crate) position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ControlSettings {
    pub(crate) wheel: bool,
    pub(crate) ok: bool,
    pub(crate) home: bool,
    pub(crate) pause: bool,
    pub(crate) autoplay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Transition {
    #[serde(rename = "actionNode")]
    pub(crate) action_node: String,
    #[serde(rename = "optionIndex")]
    pub(crate) option_index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Position {
    pub(crate) x: Number,
    pub(crate) y: Number,
}

pub(crate) struct AfterPlaybackSequenceTransitions {
    pub(crate) ok: Transition,
    pub(crate) home: Option<Transition>,
}

// Appends a sanitized id suffix to prevent role collisions
// when sibling entries share the same display name (e.g. all named "Stage title"
// after importing a Lunii official pack). Falls back to name-only when id is
// empty (some tests and legacy imports can still construct id-less entries).
pub(crate) fn scoped_label_id(prefix: &str, id: &str, name: &str) -> String {
    let trimmed = name.trim();
    let label = if trimmed.is_empty() {
        "(sans nom)"
    } else {
        trimmed
    };
    if id.is_empty() {
        format!("{}/{}", prefix, label)
    } else {
        format!("{}/{}#{}", prefix, label, sanitize_stage_label(id))
    }
}

pub(crate) fn sanitize_stage_label(label: &str) -> String {
    let sanitized: String = label
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            _ => c,
        })
        .collect();
    sanitized.trim_matches('_').to_string()
}

pub(crate) fn normalize_document_for_studio_compat(document: &mut StoryDocument) {
    for stage in &mut document.stage_nodes {
        // STUdio recreates ports from controlSettings before replaying transitions.
        // A declared transition must therefore expose the matching port.
        if stage.ok_transition.is_some()
            && !stage.control_settings.ok
            && !stage.control_settings.autoplay
        {
            stage.control_settings.ok = true;
        }
        if stage.home_transition.is_some() && !stage.control_settings.home {
            stage.control_settings.home = true;
        }
    }
}

pub(crate) fn validate_document_for_studio_compat(document: &StoryDocument) -> Result<(), String> {
    let stage_ids: HashSet<&str> = document
        .stage_nodes
        .iter()
        .map(|stage| stage.uuid.as_str())
        .collect();
    let action_map: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let mut issues = Vec::new();

    for action in &document.action_nodes {
        for (option_index, stage_id) in action.options.iter().enumerate() {
            if !stage_ids.contains(stage_id.as_str()) {
                issues.push(format!(
                    "Action '{}' option {} pointe vers un stage introuvable '{}'",
                    action.name, option_index, stage_id
                ));
            }
        }
    }

    for stage in &document.stage_nodes {
        validate_stage_transition(
            &action_map,
            stage,
            "okTransition",
            stage.ok_transition.as_ref(),
            stage.control_settings.ok || stage.control_settings.autoplay,
            &mut issues,
        );
        validate_stage_transition(
            &action_map,
            stage,
            "homeTransition",
            stage.home_transition.as_ref(),
            stage.control_settings.home,
            &mut issues,
        );

        // Après Studio rule: homeTransition must not loop back to the same stage
        if let Some(ht) = stage.home_transition.as_ref() {
            if let Some(action) = action_map.get(ht.action_node.as_str()) {
                let idx = ht.option_index as usize;
                if ht.option_index >= 0
                    && idx < action.options.len()
                    && action.options[idx] == stage.uuid
                {
                    issues.push(format!(
                        "Stage '{}' : homeTransition boucle sur lui-même (interdit par STUdio)",
                        stage.name
                    ));
                }
            }
        }

        // Après Studio rule: homeTransition and okTransition must not resolve to the same target stage.
        // Only applies to navigation/title stages (wheel=true). Pure play stages (wheel=false,
        // autoplay=true) legitimately route both transitions to the same return target.
        if stage.control_settings.wheel {
            if let (Some(ht), Some(ot)) =
                (stage.home_transition.as_ref(), stage.ok_transition.as_ref())
            {
                let h_target = action_map.get(ht.action_node.as_str()).and_then(|a| {
                    if ht.option_index >= 0 {
                        a.options.get(ht.option_index as usize)
                    } else {
                        None
                    }
                });
                let o_target = action_map.get(ot.action_node.as_str()).and_then(|a| {
                    if ot.option_index >= 0 {
                        a.options.get(ot.option_index as usize)
                    } else {
                        None
                    }
                });
                if let (Some(h), Some(o)) = (h_target, o_target) {
                    if h == o {
                        issues.push(format!(
                            "Stage '{}' : homeTransition et okTransition arrivent sur le même nœud (interdit par STUdio)",
                            stage.name
                        ));
                    }
                }
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "story.json natif incompatible STUdio : {}",
            issues.join(" | ")
        ))
    }
}

fn validate_stage_transition(
    action_map: &HashMap<&str, &ActionNode>,
    stage: &StageNode,
    transition_label: &str,
    transition: Option<&Transition>,
    port_available: bool,
    issues: &mut Vec<String>,
) {
    let Some(transition) = transition else {
        return;
    };

    if !port_available {
        issues.push(format!(
            "Stage '{}' declare {} sans port compatible",
            stage.name, transition_label
        ));
    }

    let Some(action) = action_map.get(transition.action_node.as_str()) else {
        issues.push(format!(
            "Stage '{}' pointe via {} vers une action introuvable '{}'",
            stage.name, transition_label, transition.action_node
        ));
        return;
    };

    if transition.option_index < -1 {
        issues.push(format!(
            "Stage '{}' utilise un optionIndex invalide {} sur {}",
            stage.name, transition.option_index, transition_label
        ));
        return;
    }

    if transition.option_index >= 0 && transition.option_index as usize >= action.options.len() {
        issues.push(format!(
            "Stage '{}' utilise un optionIndex hors limites {} sur {}",
            stage.name, transition.option_index, transition_label
        ));
    }
}

pub(crate) fn reorder_document_for_display(document: &mut StoryDocument) {
    let stage_map: HashMap<String, StageNode> = document
        .stage_nodes
        .iter()
        .cloned()
        .map(|stage| (stage.uuid.clone(), stage))
        .collect();
    let action_map: HashMap<String, ActionNode> = document
        .action_nodes
        .iter()
        .cloned()
        .map(|action| (action.id.clone(), action))
        .collect();

    let square_one_id = document
        .stage_nodes
        .iter()
        .find(|stage| stage.square_one)
        .map(|stage| stage.uuid.clone());

    let mut ordered_stage_ids = Vec::new();
    let mut ordered_action_ids = Vec::new();
    let mut seen_stages = HashSet::new();
    let mut seen_actions = HashSet::new();
    let mut queue = VecDeque::new();

    if let Some(stage_id) = square_one_id {
        queue.push_back(GraphNodeRef::Stage(stage_id));
    }

    while let Some(node_ref) = queue.pop_front() {
        match node_ref {
            GraphNodeRef::Stage(stage_id) => {
                if !seen_stages.insert(stage_id.clone()) {
                    continue;
                }
                ordered_stage_ids.push(stage_id.clone());
                if let Some(action_id) = stage_map
                    .get(&stage_id)
                    .and_then(|stage| stage.ok_transition.as_ref())
                    .map(|transition| transition.action_node.clone())
                {
                    queue.push_back(GraphNodeRef::Action(action_id));
                }
            }
            GraphNodeRef::Action(action_id) => {
                if !seen_actions.insert(action_id.clone()) {
                    continue;
                }
                ordered_action_ids.push(action_id.clone());
                if let Some(action) = action_map.get(&action_id) {
                    for stage_id in &action.options {
                        queue.push_back(GraphNodeRef::Stage(stage_id.clone()));
                    }
                }
            }
        }
    }

    for stage in &document.stage_nodes {
        if seen_stages.insert(stage.uuid.clone()) {
            ordered_stage_ids.push(stage.uuid.clone());
        }
    }
    for action in &document.action_nodes {
        if seen_actions.insert(action.id.clone()) {
            ordered_action_ids.push(action.id.clone());
        }
    }

    document.stage_nodes = ordered_stage_ids
        .into_iter()
        .filter_map(|stage_id| stage_map.get(&stage_id).cloned())
        .collect();
    document.action_nodes = ordered_action_ids
        .into_iter()
        .filter_map(|action_id| action_map.get(&action_id).cloned())
        .collect();
}

fn zero_position() -> Position {
    Position {
        x: Number::from(0),
        y: Number::from(0),
    }
}

enum GraphNodeRef {
    Stage(String),
    Action(String),
}
