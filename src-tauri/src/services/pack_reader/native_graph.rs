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

/// Projection fidèle d'un graphe branchant en arbre lisible (Étape 3).
///
/// Décomposition en arbre couvrant restreinte aux arêtes OK :
/// - chaîne linéaire (1 option OK) → histoires sœurs chaînées par `returnAfterPlay` ;
/// - choix (≥2 options OK) → menu dont chaque option est une branche séparée ;
/// - convergence vers un nœud déjà placé → badge `returnAfterPlay` quand un hôte existe,
///   sinon feuille `ref` (orphelin) ;
/// - les transitions Home ne sont pas suivies (elles restent des badges/transitions).
struct GraphProjector<'a> {
    stages: &'a HashMap<&'a str, &'a serde_json::Value>,
    actions: &'a HashMap<&'a str, &'a serde_json::Value>,
    assets: &'a HashMap<String, PathBuf>,
    ordinals: HashMap<String, usize>,
    placed: HashSet<String>,
    kind_is_menu: HashMap<String, bool>,
    ref_counter: usize,
}

impl<'a> GraphProjector<'a> {
    fn new(
        stages: &'a HashMap<&'a str, &'a serde_json::Value>,
        actions: &'a HashMap<&'a str, &'a serde_json::Value>,
        assets: &'a HashMap<String, PathBuf>,
    ) -> Self {
        Self {
            ordinals: native_projection_ordinals(stages),
            stages,
            actions,
            assets,
            placed: HashSet::new(),
            kind_is_menu: HashMap::new(),
            ref_counter: 0,
        }
    }

    fn ok_options(&self, stage_id: &str) -> Vec<String> {
        self.stages
            .get(stage_id)
            .map(|stage| {
                stage_action_options(stage, self.actions)
                    .iter()
                    .map(|id| (*id).to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Cible de navigation typée d'un stage déjà placé, cohérente avec son rendu.
    fn navigation_target(&self, stage_id: &str) -> String {
        let prefix = if self.kind_is_menu.get(stage_id).copied().unwrap_or(false) {
            "menu:"
        } else {
            "story:"
        };
        format!("{}{}", prefix, stage_id)
    }

    fn label(&self, stage_id: &str) -> String {
        self.stages
            .get(stage_id)
            .map(|stage| native_projection_label(stage_id, stage, &self.ordinals))
            .unwrap_or_default()
    }

    fn story_entry(&self, stage_id: &str) -> serde_json::Value {
        let stage = self.stages.get(stage_id).copied();
        let audio =
            stage.and_then(|s| resolve_asset(s.get("audio").and_then(|v| v.as_str()), self.assets));
        let image =
            stage.and_then(|s| resolve_asset(s.get("image").and_then(|v| v.as_str()), self.assets));
        serde_json::json!({
            "id": stage_id,
            "type": "story",
            "name": self.label(stage_id),
            "audio": audio,
            "itemAudio": audio,
            "itemImage": image,
            "nativeStageId": stage_id,
            "controlSettings": stage.map(stage_controls).unwrap_or_else(|| serde_json::json!({})),
        })
    }

    fn menu_entry(&self, stage_id: &str, children: Vec<serde_json::Value>) -> serde_json::Value {
        let stage = self.stages.get(stage_id).copied();
        let audio =
            stage.and_then(|s| resolve_asset(s.get("audio").and_then(|v| v.as_str()), self.assets));
        let image =
            stage.and_then(|s| resolve_asset(s.get("image").and_then(|v| v.as_str()), self.assets));
        serde_json::json!({
            "id": stage_id,
            "type": "menu",
            "name": self.label(stage_id),
            "audio": audio,
            "image": image,
            "autoBlackImage": image.is_none(),
            "nativeStageId": stage_id,
            "controlSettings": stage.map(stage_controls).unwrap_or_else(|| serde_json::json!({})),
            "returnOnHomeStageId": stage
                .and_then(|s| transition_target_stage_id(s.get("homeTransition"), self.actions)),
            "children": children,
        })
    }

    fn ref_entry(&mut self, stage_id: &str) -> serde_json::Value {
        self.ref_counter += 1;
        serde_json::json!({
            "id": format!("native-ref-{}-{}", self.ref_counter, stage_id),
            "type": "ref",
            "target": self.navigation_target(stage_id),
            "refKind": "continue",
            "nativeStageId": stage_id,
        })
    }

    /// Rattache `returnAfterPlay` à la dernière histoire-sœur si elle n'en a pas déjà.
    fn link_previous(out: &mut [serde_json::Value], target: String) {
        if let Some(last) = out.last_mut() {
            if last.get("type").and_then(|v| v.as_str()) == Some("story")
                && last.get("returnAfterPlay").is_none()
            {
                last["returnAfterPlay"] = serde_json::Value::String(target);
            }
        }
    }

    /// Décompose une chaîne linéaire en histoires sœurs chaînées, jusqu'à un choix,
    /// une feuille, ou une convergence vers un nœud déjà placé.
    fn decompose_run(&mut self, start: &str) -> Vec<serde_json::Value> {
        let mut out: Vec<serde_json::Value> = Vec::new();
        let mut current = start.to_string();
        loop {
            if self.placed.contains(&current) {
                let target = self.navigation_target(&current);
                let host_is_story = out
                    .last()
                    .and_then(|entry| entry.get("type"))
                    .and_then(|value| value.as_str())
                    == Some("story");
                if host_is_story {
                    Self::link_previous(&mut out, target);
                } else {
                    let leaf = self.ref_entry(&current);
                    out.push(leaf);
                }
                break;
            }
            self.placed.insert(current.clone());
            let options = self.ok_options(&current);
            if options.len() >= 2 {
                self.kind_is_menu.insert(current.clone(), true);
                Self::link_previous(&mut out, self.navigation_target(&current));
                let mut children = Vec::with_capacity(options.len());
                for option in &options {
                    children.push(self.branch_wrapper(option));
                }
                let menu = self.menu_entry(&current, children);
                out.push(menu);
                break;
            }
            self.kind_is_menu.insert(current.clone(), false);
            Self::link_previous(&mut out, self.navigation_target(&current));
            let story = self.story_entry(&current);
            out.push(story);
            if options.len() == 1 {
                current = options[0].clone();
                continue;
            }
            break;
        }
        out
    }

    /// Enveloppe une branche (option d'un choix) en un menu conteneur unique.
    fn branch_wrapper(&mut self, option: &str) -> serde_json::Value {
        if self.placed.contains(option) {
            return self.ref_entry(option);
        }
        self.placed.insert(option.to_string());
        let continuation = self.ok_options(option);
        if continuation.is_empty() {
            // Branche feuille (option sélectionnable sans suite) → histoire, pas un menu vide.
            self.kind_is_menu.insert(option.to_string(), false);
            return self.story_entry(option);
        }
        self.kind_is_menu.insert(option.to_string(), true);
        let children = if continuation.len() >= 2 {
            let mut nested = Vec::with_capacity(continuation.len());
            for opt in &continuation {
                nested.push(self.branch_wrapper(opt));
            }
            nested
        } else {
            self.decompose_run(&continuation[0])
        };
        self.menu_entry(option, children)
    }
}

pub(super) fn build_native_graph_projection_entries(
    square_one: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    let mut projector = GraphProjector::new(stages, actions, assets);
    let square_options = stage_action_options(square_one, actions);
    let mut entries = Vec::new();
    for option in &square_options {
        entries.extend(projector.decompose_run(option));
    }
    entries
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
