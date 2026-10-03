use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;

use crate::domain::project::{EntryControlSettings, ProjectEntry};
#[cfg(test)]
use crate::native_pack::OptionSelection;
use crate::native_pack::{sanitize_stage_label, ActionNode, StageNode, StoryDocument};

use super::stage::imported_story_name;

pub(crate) struct GraphImportOutput {
    pub(crate) root_entries: Vec<ProjectEntry>,
    pub(crate) shared_entries: Vec<ProjectEntry>,
    pub(crate) diagnostics: Vec<String>,
    play_stage_by_entry: HashMap<String, String>,
}

pub(super) struct GraphImportProjection {
    pub(super) root_entries: Vec<serde_json::Value>,
    pub(super) shared_entries: Vec<serde_json::Value>,
    pub(super) diagnostics: Vec<String>,
}

/// Variante sans assets, réservée aux tests du module (la prod passe par
/// `project_story_graph_values`, qui résout les chemins d'assets).
#[cfg(test)]
pub(crate) fn project_story_graph(document: &StoryDocument) -> Result<GraphImportOutput, String> {
    GraphProjector::new(document).project()
}

pub(super) fn project_story_graph_values(
    document: &StoryDocument,
    assets: &HashMap<String, PathBuf>,
) -> Result<GraphImportProjection, String> {
    let output = GraphProjector::new_with_assets(document, Some(assets)).project()?;
    let mut root_entries = entries_to_json(&output.root_entries);
    let mut shared_entries = entries_to_json(&output.shared_entries);
    annotate_play_stage_ids(&mut root_entries, &output.play_stage_by_entry);
    annotate_play_stage_ids(&mut shared_entries, &output.play_stage_by_entry);
    Ok(GraphImportProjection {
        root_entries,
        shared_entries,
        diagnostics: output.diagnostics,
    })
}

pub(super) fn promote_autonomous_root_ref_values(
    root_entries: &mut [serde_json::Value],
    shared_entries: &mut Vec<serde_json::Value>,
) -> bool {
    let Ok(parsed_roots) = serde_json::from_value::<Vec<ProjectEntry>>(serde_json::Value::Array(
        root_entries.to_vec(),
    )) else {
        return false;
    };
    let Ok(parsed_shared) = serde_json::from_value::<Vec<ProjectEntry>>(serde_json::Value::Array(
        shared_entries.clone(),
    )) else {
        return false;
    };
    let Some(promoted_index) = autonomous_root_ref_index(&parsed_roots, &parsed_shared) else {
        return false;
    };

    root_entries[0] = shared_entries.remove(promoted_index);
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryShape<'a> {
    Menu,
    Story {
        play_stage_id: &'a str,
        title_stage_id: Option<&'a str>,
    },
}

impl EntryShape<'_> {
    fn entry_type(self) -> &'static str {
        match self {
            EntryShape::Menu => "menu",
            EntryShape::Story { .. } => "story",
        }
    }
}

struct GraphProjector<'a> {
    stages: HashMap<&'a str, &'a StageNode>,
    actions: HashMap<&'a str, &'a ActionNode>,
    assets: Option<&'a HashMap<String, PathBuf>>,
    ok_edges: HashMap<&'a str, Vec<&'a str>>,
    indexed_router_actions: HashSet<&'a str>,
    title_stage_by_play_stage: HashMap<&'a str, &'a str>,
    reachable: HashSet<&'a str>,
    shared_ids: HashSet<&'a str>,
    emitted_shared: HashSet<&'a str>,
    shared_entries: Vec<ProjectEntry>,
    diagnostics: Vec<String>,
}

/// Max tree depth accepted by `graph_import`. Deeper inputs are treated as
/// graph/catalog structures and declined so the dispatcher can fall back.
const MAX_TREE_DEPTH: usize = 128;

impl<'a> GraphProjector<'a> {
    #[cfg(test)]
    fn new(document: &'a StoryDocument) -> Self {
        Self::new_with_assets(document, None)
    }

    fn new_with_assets(
        document: &'a StoryDocument,
        assets: Option<&'a HashMap<String, PathBuf>>,
    ) -> Self {
        let stages: HashMap<&str, &StageNode> = document
            .stage_nodes
            .iter()
            .map(|stage| (stage.uuid.as_str(), stage))
            .collect();
        let actions: HashMap<&str, &ActionNode> = document
            .action_nodes
            .iter()
            .map(|action| (action.id.as_str(), action))
            .collect();
        let mut projector = Self {
            stages,
            actions,
            assets,
            ok_edges: HashMap::new(),
            indexed_router_actions: HashSet::new(),
            title_stage_by_play_stage: HashMap::new(),
            reachable: HashSet::new(),
            shared_ids: HashSet::new(),
            emitted_shared: HashSet::new(),
            shared_entries: Vec::new(),
            diagnostics: Vec::new(),
        };
        projector.index_ok_edges(document);
        projector.index_title_stage_by_play_stage();
        projector
    }

    fn project(mut self) -> Result<GraphImportOutput, String> {
        let square_one_id = self.square_one_id()?;
        self.index_reachable(square_one_id);
        self.index_shared_ids(square_one_id);

        let mut root_entries = Vec::new();
        let mut active = Vec::new();
        let mut emitted_tree = HashSet::new();
        for (option_index, target_id) in self.ok_targets(square_one_id).iter().enumerate() {
            let entry = if root_entries.is_empty() && !self.indexed_router_actions.is_empty() {
                // La première cible de squareOne est l'ancre de l'arbre authoring.
                // Une arête de retour vers cette ancre ne doit pas la déplacer dans
                // le pool partagé : elle sera modélisée comme navigation de fin.
                self.build_concrete_entry(target_id, &mut active, &mut emitted_tree, true)
            } else {
                self.build_edge_entry(
                    square_one_id,
                    option_index,
                    target_id,
                    &mut active,
                    &mut emitted_tree,
                )
            };
            if let Some(entry) = entry {
                root_entries.push(entry);
            }
        }
        self.preserve_unreachable_helper_stages();
        let play_stage_by_entry = self
            .title_stage_by_play_stage
            .iter()
            .map(|(play_stage_id, entry_stage_id)| {
                ((*entry_stage_id).to_string(), (*play_stage_id).to_string())
            })
            .collect();

        Ok(GraphImportOutput {
            root_entries,
            shared_entries: self.shared_entries,
            diagnostics: self.diagnostics,
            play_stage_by_entry,
        })
    }

    fn square_one_id(&mut self) -> Result<&'a str, String> {
        self.stages
            .values()
            .find(|stage| stage.is_square_one())
            .map(|stage| stage.uuid.as_str())
            .ok_or_else(|| "story.json sans squareOne".to_string())
    }

    fn index_ok_edges(&mut self, document: &'a StoryDocument) {
        let mut option_indices_by_action: HashMap<&str, HashSet<usize>> = HashMap::new();
        for stage in &document.stage_nodes {
            let Some(transition) = stage.ok_transition.value() else {
                continue;
            };
            // `Random` ne désigne aucun indice : il ne fait pas d'une Action un
            // routeur indexé partagé, et il n'est surtout pas rabattu sur `0`
            // (une sélection aléatoire n'est pas l'option `0`).
            if let Some(index) = transition.selection.fixed_index() {
                if self.actions.contains_key(transition.action_node.as_str()) {
                    option_indices_by_action
                        .entry(transition.action_node.as_str())
                        .or_default()
                        .insert(index);
                }
            }
        }
        let indexed_router_actions: HashSet<&str> = option_indices_by_action
            .into_iter()
            .filter_map(|(action_id, indices)| {
                let action = self.actions.get(action_id)?;
                let targets_are_non_interactive = action.named_options().all(|stage_id| {
                    self.stages
                        .get(stage_id)
                        .is_some_and(|stage| !stage.control_settings.wheel())
                });
                (indices.len() > 1 && targets_are_non_interactive).then_some(action_id)
            })
            .collect();
        self.indexed_router_actions = indexed_router_actions.clone();

        for stage in &document.stage_nodes {
            let Some(transition) = stage.ok_transition.value() else {
                continue;
            };
            let Some(action) = self.actions.get(transition.action_node.as_str()) else {
                self.diagnostics.push(format!(
                    "Stage '{}' okTransition vers action introuvable '{}'",
                    stage.label(),
                    transition.action_node
                ));
                continue;
            };

            let action_targets: Vec<&str> = action
                .named_options()
                .filter(|target_id| {
                    let known = self.stages.contains_key(target_id);
                    if !known {
                        self.diagnostics.push(format!(
                            "Action '{}' pointe vers stage introuvable '{}'",
                            action.label(),
                            target_id
                        ));
                    }
                    known
                })
                .collect();

            // Un routeur indexé n'aplatit que les sélections fixes : une
            // sélection aléatoire conserve tout son éventail de destinations,
            // qu'aucune analyse statique ne doit trancher par un tirage.
            let routed_index = indexed_router_actions
                .contains(transition.action_node.as_str())
                .then(|| transition.selection.fixed_index())
                .flatten();
            let targets = match routed_index {
                Some(option_index) => match action_targets.get(option_index).copied() {
                    Some(target) => vec![target],
                    None => {
                        self.diagnostics.push(format!(
                            "Stage '{}' okTransition option {} hors limites pour l'action '{}' ({} options)",
                            stage.label(),
                            transition.selection,
                            action.label(),
                            action_targets.len()
                        ));
                        Vec::new()
                    }
                },
                None => action_targets,
            };

            if !targets.is_empty() {
                self.ok_edges.insert(stage.uuid.as_str(), targets);
            }
        }
    }

    fn index_reachable(&mut self, square_one_id: &'a str) {
        let mut queue = VecDeque::from([square_one_id]);
        while let Some(stage_id) = queue.pop_front() {
            if !self.reachable.insert(stage_id) {
                continue;
            }
            for target_id in self.ok_targets(stage_id) {
                queue.push_back(target_id);
            }
        }
    }

    fn index_title_stage_by_play_stage(&mut self) {
        for (stage_id, stage) in &self.stages {
            if stage.is_square_one()
                || !stage.control_settings.wheel()
                || stage.control_settings.autoplay()
            {
                continue;
            }
            let targets = self.ok_targets(stage_id);
            if targets.len() != 1 {
                continue;
            }
            let play_stage_id = targets[0];
            if self
                .stages
                .get(play_stage_id)
                .is_some_and(|candidate| is_playback_stage(candidate))
                && (self.indexed_router_actions.is_empty()
                    || self.ok_targets(play_stage_id).len() <= 1)
            {
                self.title_stage_by_play_stage
                    .insert(play_stage_id, stage_id);
            }
        }
    }

    fn index_shared_ids(&mut self, square_one_id: &'a str) {
        let mut indegree: HashMap<&str, usize> = HashMap::new();
        for source_id in &self.reachable {
            for target_id in self.ok_targets(source_id) {
                if !self.reachable.contains(target_id) {
                    continue;
                }
                let entry_stage_id = self.entry_stage_id(target_id);
                if entry_stage_id == square_one_id {
                    continue;
                }
                if entry_stage_id == *source_id && entry_stage_id != target_id {
                    continue;
                }
                *indegree.entry(entry_stage_id).or_insert(0) += 1;
            }
        }
        for (target_id, count) in indegree {
            if count > 1 {
                self.shared_ids.insert(target_id);
            }
        }

        let mut active = HashSet::new();
        let mut visited = HashSet::new();
        self.mark_cycle_targets(square_one_id, &mut active, &mut visited);
        self.shared_ids.remove(square_one_id);
    }

    fn mark_cycle_targets(
        &mut self,
        stage_id: &'a str,
        active: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) {
        if !visited.insert(stage_id) {
            return;
        }
        if active.len() > MAX_TREE_DEPTH {
            return;
        }
        active.insert(stage_id);

        for target_id in self.ok_targets(stage_id) {
            if !self.reachable.contains(target_id) {
                continue;
            }
            if active.contains(target_id) {
                self.shared_ids.insert(target_id);
            } else if !visited.contains(target_id) {
                self.mark_cycle_targets(target_id, active, visited);
            }
        }

        active.remove(stage_id);
    }

    fn ok_targets(&self, stage_id: &str) -> Vec<&'a str> {
        self.ok_edges.get(stage_id).cloned().unwrap_or_default()
    }

    fn build_edge_entry(
        &mut self,
        source_id: &'a str,
        option_index: usize,
        target_id: &'a str,
        active: &mut Vec<&'a str>,
        emitted_tree: &mut HashSet<&'a str>,
    ) -> Option<ProjectEntry> {
        if !self.reachable.contains(target_id) {
            return None;
        }
        if self.should_reference(target_id, active, emitted_tree) {
            let target = self.typed_target(target_id)?;
            self.ensure_shared_entry(target_id, active, emitted_tree);
            return Some(ref_entry(
                source_id,
                option_index,
                &target,
                active.contains(&target_id),
            ));
        }
        self.build_concrete_entry(target_id, active, emitted_tree, true)
    }

    fn should_reference(
        &self,
        target_id: &'a str,
        active: &[&'a str],
        emitted_tree: &HashSet<&'a str>,
    ) -> bool {
        let entry_stage_id = self.entry_stage_id(target_id);
        self.shared_ids.contains(target_id)
            || self.shared_ids.contains(entry_stage_id)
            || active.contains(&target_id)
            || active.contains(&entry_stage_id)
            || emitted_tree.contains(target_id)
            || emitted_tree.contains(entry_stage_id)
    }

    fn ensure_shared_entry(
        &mut self,
        stage_id: &'a str,
        active: &mut Vec<&'a str>,
        emitted_tree: &mut HashSet<&'a str>,
    ) {
        let entry_stage_id = self.entry_stage_id(stage_id);
        self.shared_ids.insert(entry_stage_id);
        if !self.emitted_shared.insert(entry_stage_id) {
            return;
        }
        if let Some(entry) = self.build_concrete_entry(entry_stage_id, active, emitted_tree, false)
        {
            self.shared_entries.push(entry);
        }
    }

    fn build_concrete_entry(
        &mut self,
        stage_id: &'a str,
        active: &mut Vec<&'a str>,
        emitted_tree: &mut HashSet<&'a str>,
        mark_tree: bool,
    ) -> Option<ProjectEntry> {
        let entry_stage_id = self.entry_stage_id(stage_id);
        let stage = *self.stages.get(entry_stage_id)?;
        if active.len() > MAX_TREE_DEPTH {
            self.diagnostics.push(format!(
                "Graphe trop profond pour une modelisation en arbre (profondeur > {MAX_TREE_DEPTH}), stage '{}'",
                stage.label()
            ));
            return None;
        }
        let shape = self.entry_shape(entry_stage_id)?;
        let targets = match shape {
            EntryShape::Menu => self.ok_targets(entry_stage_id),
            EntryShape::Story { play_stage_id, .. } => self.ok_targets(play_stage_id),
        };
        let mut entry = self.stage_entry(entry_stage_id, shape)?;

        if mark_tree {
            emitted_tree.insert(entry_stage_id);
            if let EntryShape::Story { play_stage_id, .. } = shape {
                emitted_tree.insert(play_stage_id);
            }
        }
        active.push(entry_stage_id);
        let pushed_play_stage = match shape {
            EntryShape::Story { play_stage_id, .. } if play_stage_id != stage_id => {
                active.push(play_stage_id);
                true
            }
            _ => false,
        };

        match shape {
            EntryShape::Menu => {
                for (option_index, target_id) in targets.iter().enumerate() {
                    if let Some(child) = self.build_edge_entry(
                        stage_id,
                        option_index,
                        target_id,
                        active,
                        emitted_tree,
                    ) {
                        entry.children.push(child);
                    }
                }
            }
            EntryShape::Story { title_stage_id, .. } => {
                if let Some(target_id) = targets.first().copied() {
                    if let Some(target) = self.typed_target(target_id) {
                        let target_entry_id = self.entry_stage_id(target_id);
                        if !active.contains(&target_entry_id)
                            && !emitted_tree.contains(target_entry_id)
                        {
                            self.ensure_shared_entry(target_id, active, emitted_tree);
                        }
                        entry.return_after_play = Some(target);
                    }
                }
                let self_return_target = title_stage_id.unwrap_or(stage_id);
                let extra_targets_are_shared_return = targets.len() > 1
                    && targets
                        .first()
                        .is_some_and(|target_id| *target_id == self_return_target);
                if targets.len() > 1 && !extra_targets_are_shared_return {
                    self.diagnostics.push(format!(
                        "Stage '{}' a plusieurs sorties OK non modelisees en story",
                        stage.label()
                    ));
                }
            }
        }

        if pushed_play_stage {
            active.pop();
        }
        active.pop();
        Some(entry)
    }

    fn typed_target(&self, stage_id: &'a str) -> Option<String> {
        let entry_stage_id = self.entry_stage_id(stage_id);
        if entry_stage_id != stage_id {
            return Some(format!("story_play:{entry_stage_id}"));
        }
        let prefix = self.entry_shape(entry_stage_id)?.entry_type();
        Some(format!("{prefix}:{entry_stage_id}"))
    }

    fn entry_stage_id(&self, stage_id: &'a str) -> &'a str {
        self.title_stage_by_play_stage
            .get(stage_id)
            .copied()
            .unwrap_or(stage_id)
    }

    fn entry_shape(&self, stage_id: &'a str) -> Option<EntryShape<'a>> {
        if let Some(title_stage_id) = self.title_stage_by_play_stage.get(stage_id).copied() {
            return Some(EntryShape::Story {
                play_stage_id: stage_id,
                title_stage_id: Some(title_stage_id),
            });
        }
        let stage = self.stages.get(stage_id)?;
        let targets = self.ok_targets(stage_id);
        if stage.control_settings.autoplay() && targets.len() >= 2 {
            return Some(EntryShape::Menu);
        }
        if stage.control_settings.wheel() && !stage.control_settings.autoplay() {
            if targets.len() == 1 {
                let play_stage_id = targets[0];
                if self
                    .stages
                    .get(play_stage_id)
                    .is_some_and(|stage| is_playback_stage(stage))
                    && (self.indexed_router_actions.is_empty()
                        || self.ok_targets(play_stage_id).len() <= 1)
                {
                    return Some(EntryShape::Story {
                        play_stage_id,
                        title_stage_id: Some(stage_id),
                    });
                }
            }
            return Some(EntryShape::Menu);
        }

        Some(EntryShape::Story {
            play_stage_id: stage_id,
            title_stage_id: None,
        })
    }

    fn stage_entry(&self, stage_id: &'a str, shape: EntryShape<'a>) -> Option<ProjectEntry> {
        let stage = self.stages.get(stage_id)?;
        match shape {
            EntryShape::Menu => Some(ProjectEntry {
                id: stage.uuid.clone(),
                entry_type: "menu".to_string(),
                name: stage.label().to_string(),
                native_stage_id: Some(stage.uuid.clone()),
                audio: self.resolve_asset(stage.audio.as_deref()),
                image: self.resolve_asset(stage.image.as_deref()),
                auto_black_image: stage.image.has_no_value(),
                control_settings: Some(stage_controls(stage)),
                return_on_home: self.home_project_target(stage.uuid.as_str()),
                return_on_home_none: stage.home_transition.has_no_value(),
                ..Default::default()
            }),
            EntryShape::Story {
                play_stage_id,
                title_stage_id: Some(title_stage_id),
            } => {
                let title_stage = self.stages.get(title_stage_id)?;
                let play_stage = self.stages.get(play_stage_id)?;
                Some(ProjectEntry {
                    id: title_stage.uuid.clone(),
                    entry_type: "story".to_string(),
                    name: imported_story_name(title_stage.label(), play_stage.label()).to_string(),
                    native_stage_id: Some(title_stage.uuid.clone()),
                    audio: self.resolve_asset(play_stage.audio.as_deref()),
                    image: self.resolve_asset(play_stage.image.as_deref()),
                    item_audio: self.resolve_asset(title_stage.audio.as_deref()),
                    item_image: self.resolve_asset(title_stage.image.as_deref()),
                    control_settings: Some(stage_controls(play_stage)),
                    title_control_settings: Some(stage_controls(title_stage)),
                    return_on_home: self.home_project_target(play_stage.uuid.as_str()),
                    return_on_home_none: play_stage.home_transition.has_no_value(),
                    title_return_on_home: self.home_project_target(title_stage.uuid.as_str()),
                    title_return_on_home_none: title_stage.home_transition.has_no_value(),
                    ..Default::default()
                })
            }
            EntryShape::Story {
                play_stage_id,
                title_stage_id: None,
            } => {
                let play_stage = self.stages.get(play_stage_id)?;
                Some(ProjectEntry {
                    id: play_stage.uuid.clone(),
                    entry_type: "story".to_string(),
                    name: play_stage.label().to_string(),
                    native_stage_id: Some(play_stage.uuid.clone()),
                    audio: self.resolve_asset(play_stage.audio.as_deref()),
                    image: self.resolve_asset(play_stage.image.as_deref()),
                    control_settings: Some(stage_controls(play_stage)),
                    return_on_home: self.home_project_target(play_stage.uuid.as_str()),
                    return_on_home_none: play_stage.home_transition.has_no_value(),
                    ..Default::default()
                })
            }
        }
    }

    fn preserve_unreachable_helper_stages(&mut self) {
        let mut stage_ids: Vec<&str> = self.stages.keys().copied().collect();
        stage_ids.sort_unstable();
        for stage_id in stage_ids {
            if self.reachable.contains(stage_id) || self.emitted_shared.contains(stage_id) {
                continue;
            }
            let Some(stage) = self.stages.get(stage_id).copied() else {
                continue;
            };
            if !is_unreachable_helper_stage(stage) {
                continue;
            }
            let targets = self.ok_targets(stage_id);
            let Some(target_id) = targets.first().copied() else {
                continue;
            };
            if !self.reachable.contains(target_id) {
                continue;
            }
            let Some(target) = self.typed_target(target_id) else {
                continue;
            };
            self.shared_entries.push(ProjectEntry {
                id: stage.uuid.clone(),
                entry_type: "menu".to_string(),
                name: stage.label().to_string(),
                native_stage_id: Some(stage.uuid.clone()),
                audio: self.resolve_asset(stage.audio.as_deref()),
                image: self.resolve_asset(stage.image.as_deref()),
                auto_black_image: stage.image.has_no_value(),
                control_settings: Some(stage_controls(stage)),
                children: vec![ref_entry(stage.uuid.as_str(), 0, &target, false)],
                ..Default::default()
            });
            self.emitted_shared.insert(stage_id);
        }
    }

    /// La destination unique du Home d'un Stage.
    ///
    /// Une sélection `Random` n'en désigne aucune : elle rend `None` plutôt que
    /// l'option `0`. Le Home projeté est alors « aucun retour
    /// modélisé », ce que le juge de fidélité relève comme un écart avec
    /// l'oracle — c'est le garde qui empêche de régénérer un `Fixed(0)` à la
    /// place d'un `Random`.
    fn home_target(&self, stage_id: &str) -> Option<&'a str> {
        let stage = self.stages.get(stage_id)?;
        let transition = stage.home_transition.value()?;
        let action = self.actions.get(transition.action_node.as_str())?;
        action.option_target(transition.selection.fixed_index()?)
    }

    fn home_project_target(&self, stage_id: &str) -> Option<String> {
        let target_id = self.home_target(stage_id)?;
        if self
            .stages
            .get(target_id)
            .is_some_and(|stage| stage.is_square_one())
        {
            return Some("root".to_string());
        }
        self.typed_target(target_id)
    }

    fn resolve_asset(&self, name: Option<&str>) -> Option<String> {
        let name = name?.trim();
        if name.is_empty() {
            return None;
        }
        let short = name.strip_prefix("assets/").unwrap_or(name);
        match self.assets {
            Some(assets) => assets
                .get(short)
                .map(crate::support::paths::path_for_frontend),
            None => Some(name.to_string()),
        }
    }
}

fn is_playback_stage(stage: &StageNode) -> bool {
    (stage.control_settings.autoplay() || !stage.control_settings.wheel())
        && stage
            .audio
            .as_deref()
            .is_some_and(|audio| !audio.trim().is_empty())
}

fn is_unreachable_helper_stage(stage: &StageNode) -> bool {
    !stage.is_square_one()
        && stage
            .audio
            .as_deref()
            .is_none_or(|audio| audio.trim().is_empty())
        && stage
            .image
            .as_deref()
            .is_none_or(|image| image.trim().is_empty())
        && !stage.control_settings.wheel()
        && stage.control_settings.ok()
        && stage.control_settings.home()
        && !stage.control_settings.pause()
        && stage.control_settings.autoplay()
        && stage.home_transition.has_no_value()
        && stage.ok_transition.is_value()
}

fn stage_controls(stage: &StageNode) -> EntryControlSettings {
    EntryControlSettings {
        autoplay: Some(stage.control_settings.autoplay()),
        wheel: Some(stage.control_settings.wheel()),
        pause: Some(stage.control_settings.pause()),
        ok: Some(stage.control_settings.ok()),
        home: Some(stage.control_settings.home()),
    }
}

fn ref_entry(
    source_id: &str,
    option_index: usize,
    target: &str,
    is_back_edge: bool,
) -> ProjectEntry {
    ProjectEntry {
        id: format!(
            "ref-{}-{}-{}",
            sanitize_stage_label(source_id),
            option_index,
            sanitize_stage_label(target)
        ),
        entry_type: "ref".to_string(),
        name: "Reference".to_string(),
        target: Some(target.to_string()),
        ref_kind: Some(if is_back_edge { "return" } else { "continue" }.to_string()),
        ..Default::default()
    }
}

/// Promotes the only projected root ref when its target is the only autonomous
/// shared entry. Any additional ref keeps the projection read-only: it may
/// represent a return edge or another shared graph relationship.
#[cfg(test)]
fn promote_autonomous_root_ref(
    root_entries: &mut [ProjectEntry],
    shared_entries: &mut Vec<ProjectEntry>,
) -> bool {
    let Some(promoted_index) = autonomous_root_ref_index(root_entries, shared_entries) else {
        return false;
    };
    let promoted = shared_entries.remove(promoted_index);
    root_entries[0] = promoted;
    true
}

fn autonomous_root_ref_index(
    root_entries: &[ProjectEntry],
    shared_entries: &[ProjectEntry],
) -> Option<usize> {
    if root_entries.len() != 1
        || shared_entries.len() != 1
        || root_entries[0].entry_type != "ref"
        || count_refs(root_entries) != 1
        || count_refs(shared_entries) != 0
    {
        return None;
    }

    let target = root_entries[0].target.as_deref()?;
    typed_target_matches_entry(target, &shared_entries[0]).then_some(0)
}

fn count_refs(entries: &[ProjectEntry]) -> usize {
    entries
        .iter()
        .map(|entry| usize::from(entry.entry_type == "ref") + count_refs(&entry.children))
        .sum()
}

fn typed_target_matches_entry(target: &str, entry: &ProjectEntry) -> bool {
    let Some((kind, target_id)) = target.trim().split_once(':') else {
        return false;
    };
    let target_id = target_id.trim();
    if target_id.is_empty()
        || (entry.id.trim() != target_id
            && entry.native_stage_id.as_deref().map(str::trim) != Some(target_id))
    {
        return false;
    }

    match kind.trim() {
        "menu" => entry.entry_type == "menu",
        "story" | "story_play" | "story_home_step" => entry.entry_type == "story",
        _ => false,
    }
}

fn entries_to_json(entries: &[ProjectEntry]) -> Vec<serde_json::Value> {
    entries.iter().map(entry_to_json).collect()
}

fn annotate_play_stage_ids(
    entries: &mut [serde_json::Value],
    play_stage_by_entry: &HashMap<String, String>,
) {
    for entry in entries {
        if entry.get("type").and_then(serde_json::Value::as_str) == Some("story") {
            if let Some(play_stage_id) = entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| play_stage_by_entry.get(id))
            {
                entry["_playStageId"] = serde_json::Value::String(play_stage_id.clone());
            }
        }
        if let Some(children) = entry
            .get_mut("children")
            .and_then(serde_json::Value::as_array_mut)
        {
            annotate_play_stage_ids(children, play_stage_by_entry);
        }
    }
}

fn entry_to_json(entry: &ProjectEntry) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "id".to_string(),
        serde_json::Value::String(entry.id.clone()),
    );
    object.insert(
        "type".to_string(),
        serde_json::Value::String(entry.entry_type.clone()),
    );
    object.insert(
        "name".to_string(),
        serde_json::Value::String(entry.name.clone()),
    );
    insert_optional_string(&mut object, "nativeStageId", entry.native_stage_id.as_ref());
    insert_optional_string(&mut object, "target", entry.target.as_ref());
    insert_optional_string(&mut object, "refKind", entry.ref_kind.as_ref());
    insert_optional_string(&mut object, "audio", entry.audio.as_ref());
    insert_optional_string(&mut object, "image", entry.image.as_ref());
    if entry.auto_black_image {
        object.insert("autoBlackImage".to_string(), serde_json::Value::Bool(true));
    }
    insert_optional_string(&mut object, "itemAudio", entry.item_audio.as_ref());
    insert_optional_string(&mut object, "itemImage", entry.item_image.as_ref());
    insert_optional_string(
        &mut object,
        "returnAfterPlay",
        entry.return_after_play.as_ref(),
    );
    insert_optional_string(&mut object, "returnOnHome", entry.return_on_home.as_ref());
    if entry.return_on_home_none {
        object.insert(
            "returnOnHomeNone".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    insert_optional_string(
        &mut object,
        "titleReturnOnHome",
        entry.title_return_on_home.as_ref(),
    );
    if entry.title_return_on_home_none {
        object.insert(
            "titleReturnOnHomeNone".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    if let Some(control_settings) = entry.control_settings.as_ref() {
        object.insert(
            "controlSettings".to_string(),
            controls_to_json(control_settings),
        );
    }
    if let Some(control_settings) = entry.title_control_settings.as_ref() {
        object.insert(
            "titleControlSettings".to_string(),
            controls_to_json(control_settings),
        );
    }
    if !entry.children.is_empty() {
        object.insert(
            "children".to_string(),
            serde_json::Value::Array(entries_to_json(&entry.children)),
        );
    }
    serde_json::Value::Object(object)
}

fn insert_optional_string(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<&String>,
) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        object.insert(key.to_string(), serde_json::Value::String(value.clone()));
    }
}

fn controls_to_json(settings: &EntryControlSettings) -> serde_json::Value {
    serde_json::json!({
        "autoplay": settings.autoplay.unwrap_or(false),
        "wheel": settings.wheel.unwrap_or(false),
        "pause": settings.pause.unwrap_or(false),
        "ok": settings.ok.unwrap_or(false),
        "home": settings.home.unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Number;

    use super::*;
    use crate::native_pack::{
        named_option_targets, ControlSettings, Position, Presence, Transition,
    };

    fn document(stages: Vec<StageNode>, actions: Vec<ActionNode>) -> StoryDocument {
        StoryDocument {
            title: Presence::Value("Synthetic".to_string()),
            version: Presence::Value(1),
            description: Presence::Value(String::new()),
            format: Presence::Value("v1".to_string()),
            night_mode_available: Presence::Value(false),
            action_nodes: actions,
            stage_nodes: stages,
            uuid: Presence::Absent,
            factory_disabled: Presence::Absent,
        }
    }

    fn action(id: &str, options: &[&str]) -> ActionNode {
        ActionNode {
            id: id.to_string(),
            name: Presence::Value(id.to_string()),
            options: named_option_targets(
                options.iter().map(|option| (*option).to_string()).collect(),
            ),
            position: Presence::Value(position()),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
        }
    }

    fn stage(
        id: &str,
        name: &str,
        wheel: bool,
        autoplay: bool,
        ok_action: Option<&str>,
        home_action: Option<&str>,
        audio: Option<&str>,
    ) -> StageNode {
        StageNode {
            uuid: id.to_string(),
            name: Presence::Value(name.to_string()),
            stage_type: Presence::Value("stage".to_string()),
            square_one: Presence::Value(id == "root"),
            audio: Presence::from_nullable(audio.map(str::to_string)),
            image: Presence::Null,
            control_settings: Presence::Value(ControlSettings::authored(
                wheel,
                ok_action.is_some(),
                home_action.is_some(),
                false,
                autoplay,
            )),
            home_transition: Presence::from_nullable(
                home_action.map(|action_node| Transition::fixed(action_node, 0)),
            ),
            ok_transition: Presence::from_nullable(
                ok_action.map(|action_node| Transition::fixed(action_node, 0)),
            ),
            position: Presence::Value(position()),
            group_id: Presence::Absent,
        }
    }

    fn stage_with_ok_option(
        id: &str,
        name: &str,
        wheel: bool,
        autoplay: bool,
        ok_action: &str,
        option_index: usize,
        audio: Option<&str>,
    ) -> StageNode {
        let mut value = stage(id, name, wheel, autoplay, Some(ok_action), None, audio);
        value
            .ok_transition
            .value_mut()
            .expect("ok transition")
            .selection = OptionSelection::Fixed(option_index);
        value
    }

    fn position() -> Position {
        Position {
            x: Number::from(0),
            y: Number::from(0),
        }
    }

    fn collect_ids(entries: &[ProjectEntry], ids: &mut Vec<String>) {
        for entry in entries {
            ids.push(entry.id.clone());
            collect_ids(&entry.children, ids);
        }
    }

    fn collect_targets(entries: &[ProjectEntry], targets: &mut Vec<String>) {
        for entry in entries {
            if let Some(target) = entry.target.as_ref() {
                targets.push(target.clone());
            }
            if let Some(target) = entry.return_after_play.as_ref() {
                targets.push(target.clone());
            }
            collect_targets(&entry.children, targets);
        }
    }

    fn synthetic_entry(id: &str, entry_type: &str, native_stage_id: Option<&str>) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            entry_type: entry_type.to_string(),
            name: id.to_string(),
            native_stage_id: native_stage_id.map(str::to_string),
            ..ProjectEntry::default()
        }
    }

    fn synthetic_ref(target: &str) -> ProjectEntry {
        ProjectEntry {
            id: "root-ref".to_string(),
            entry_type: "ref".to_string(),
            name: "Reference".to_string(),
            target: Some(target.to_string()),
            ..ProjectEntry::default()
        }
    }

    #[test]
    fn autonomous_root_ref_is_promoted() {
        let mut roots = vec![synthetic_ref("story:shared")];
        let mut shared = vec![synthetic_entry("shared", "story", Some("native-shared"))];

        assert!(promote_autonomous_root_ref(&mut roots, &mut shared));
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "shared");
        assert!(shared.is_empty());
    }

    #[test]
    fn autonomous_root_ref_accepts_native_stage_id_target() {
        let mut roots = vec![synthetic_ref("story:native-shared")];
        let mut shared = vec![synthetic_entry("shared", "story", Some("native-shared"))];

        assert!(promote_autonomous_root_ref(&mut roots, &mut shared));
        assert_eq!(roots[0].id, "shared");
        assert!(shared.is_empty());
    }

    #[test]
    fn multiple_shared_entries_are_not_promoted() {
        let mut roots = vec![synthetic_ref("story:shared")];
        let mut shared = vec![
            synthetic_entry("shared", "story", None),
            synthetic_entry("other", "story", None),
        ];

        assert!(!promote_autonomous_root_ref(&mut roots, &mut shared));
        assert_eq!(roots[0].entry_type, "ref");
        assert_eq!(shared.len(), 2);
    }

    #[test]
    fn internal_ref_keeps_root_projection_unchanged() {
        let mut roots = vec![synthetic_ref("menu:shared")];
        let mut shared = vec![ProjectEntry {
            children: vec![synthetic_ref("story:other")],
            ..synthetic_entry("shared", "menu", None)
        }];

        assert!(!promote_autonomous_root_ref(&mut roots, &mut shared));
        assert_eq!(roots[0].entry_type, "ref");
        assert_eq!(shared[0].children.len(), 1);
    }

    #[test]
    fn absent_or_ambiguous_target_keeps_root_projection_unchanged() {
        for target in ["story:missing", "story:shared:ambiguous"] {
            let mut roots = vec![synthetic_ref(target)];
            let mut shared = vec![synthetic_entry("shared", "story", None)];

            assert!(!promote_autonomous_root_ref(&mut roots, &mut shared));
            assert_eq!(roots[0].entry_type, "ref");
            assert_eq!(shared.len(), 1);
        }
    }

    #[test]
    fn cycle_back_ref_keeps_root_projection_unchanged() {
        let mut roots = vec![synthetic_ref("menu:shared")];
        let mut shared = vec![ProjectEntry {
            children: vec![ProjectEntry {
                children: vec![ProjectEntry {
                    ref_kind: Some("return".to_string()),
                    ..synthetic_ref("menu:shared")
                }],
                ..synthetic_entry("story", "story", None)
            }],
            ..synthetic_entry("shared", "menu", None)
        }];

        assert!(!promote_autonomous_root_ref(&mut roots, &mut shared));
        assert_eq!(roots[0].entry_type, "ref");
        assert_eq!(shared.len(), 1);
    }

    #[test]
    fn promotion_preserves_order_native_ids_and_returns() {
        let mut roots = vec![synthetic_ref("menu:native-shared")];
        let mut shared = vec![ProjectEntry {
            native_stage_id: Some("native-shared".to_string()),
            return_after_play: Some("story:after".to_string()),
            children: vec![
                synthetic_entry("first", "story", Some("native-first")),
                synthetic_entry("second", "story", Some("native-second")),
            ],
            ..synthetic_entry("shared", "menu", None)
        }];

        assert!(promote_autonomous_root_ref(&mut roots, &mut shared));
        let promoted = &roots[0];
        assert_eq!(promoted.id, "shared");
        assert_eq!(promoted.native_stage_id.as_deref(), Some("native-shared"));
        assert_eq!(promoted.return_after_play.as_deref(), Some("story:after"));
        assert_eq!(
            promoted
                .children
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(shared.is_empty());
    }

    #[test]
    fn binary_choice_without_convergence_stays_tree_only() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage(
                    "choice",
                    "Choice",
                    true,
                    false,
                    Some("choice-action"),
                    None,
                    Some("choice.mp3"),
                ),
                stage("story-a", "A", false, true, None, None, Some("a.mp3")),
                stage("story-b", "B", false, true, None, None, Some("b.mp3")),
            ],
            vec![
                action("root-action", &["choice"]),
                action("choice-action", &["story-a", "story-b"]),
            ],
        ))
        .unwrap();

        assert!(output.shared_entries.is_empty());
        assert_eq!(output.root_entries.len(), 1);
        assert_eq!(output.root_entries[0].id, "choice");
        assert_eq!(output.root_entries[0].children.len(), 2);
        assert_eq!(output.root_entries[0].children[0].id, "story-a");
        assert_eq!(output.root_entries[0].children[1].id, "story-b");
    }

    #[test]
    fn nested_choices_through_reused_routers_stay_hierarchical() {
        let output = project_story_graph(&document(
            vec![
                stage_with_ok_option("root", "Root", true, false, "state-router", 0, None),
                stage(
                    "intro",
                    "First choice",
                    false,
                    true,
                    Some("first-choice"),
                    None,
                    Some("intro.mp3"),
                ),
                stage_with_ok_option(
                    "first-a",
                    "First A",
                    true,
                    false,
                    "state-router",
                    1,
                    Some("first-a.mp3"),
                ),
                stage_with_ok_option(
                    "first-b",
                    "First B",
                    true,
                    false,
                    "state-router",
                    2,
                    Some("first-b.mp3"),
                ),
                stage(
                    "second-a",
                    "Second choice A",
                    false,
                    true,
                    Some("second-choice-a"),
                    None,
                    Some("second-a.mp3"),
                ),
                stage(
                    "second-b",
                    "Second choice B",
                    false,
                    true,
                    Some("second-choice-b"),
                    None,
                    Some("second-b.mp3"),
                ),
                stage_with_ok_option(
                    "leaf-a1",
                    "Leaf A1",
                    true,
                    false,
                    "result-router",
                    0,
                    Some("leaf-a1.mp3"),
                ),
                stage_with_ok_option(
                    "leaf-a2",
                    "Leaf A2",
                    true,
                    false,
                    "result-router",
                    1,
                    Some("leaf-a2.mp3"),
                ),
                stage_with_ok_option(
                    "leaf-b1",
                    "Leaf B1",
                    true,
                    false,
                    "result-router",
                    2,
                    Some("leaf-b1.mp3"),
                ),
                stage_with_ok_option(
                    "leaf-b2",
                    "Leaf B2",
                    true,
                    false,
                    "result-router",
                    3,
                    Some("leaf-b2.mp3"),
                ),
                stage(
                    "story-a1",
                    "Story A1",
                    false,
                    true,
                    None,
                    None,
                    Some("a1.mp3"),
                ),
                stage(
                    "story-a2",
                    "Story A2",
                    false,
                    true,
                    None,
                    None,
                    Some("a2.mp3"),
                ),
                stage(
                    "story-b1",
                    "Story B1",
                    false,
                    true,
                    None,
                    None,
                    Some("b1.mp3"),
                ),
                stage(
                    "story-b2",
                    "Story B2",
                    false,
                    true,
                    None,
                    None,
                    Some("b2.mp3"),
                ),
            ],
            vec![
                action("state-router", &["intro", "second-a", "second-b"]),
                action("first-choice", &["first-a", "first-b"]),
                action("second-choice-a", &["leaf-a1", "leaf-a2"]),
                action("second-choice-b", &["leaf-b1", "leaf-b2"]),
                action(
                    "result-router",
                    &["story-a1", "story-a2", "story-b1", "story-b2"],
                ),
            ],
        ))
        .unwrap();

        assert!(output.shared_entries.is_empty());
        let mut ids = Vec::new();
        collect_ids(&output.root_entries, &mut ids);
        assert!(ids.iter().all(|id| !id.starts_with("ref-")));
        for expected in ["leaf-a1", "leaf-a2", "leaf-b1", "leaf-b2"] {
            assert!(ids.iter().any(|id| id == expected), "missing {expected}");
        }
    }

    #[test]
    fn direct_stage_without_home_transition_marks_return_on_home_none() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage("story", "Story", false, true, None, None, Some("story.mp3")),
            ],
            vec![action("root-action", &["story"])],
        ))
        .unwrap();

        assert_eq!(output.root_entries.len(), 1);
        assert_eq!(output.root_entries[0].id, "story");
        assert!(output.root_entries[0].return_on_home_none);
    }

    #[test]
    fn unreachable_autoplay_helper_stage_is_preserved_as_orphan_shared_entry() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage("story", "Story", false, true, None, None, Some("story.mp3")),
                {
                    let mut helper = stage(
                        "helper",
                        "Helper",
                        false,
                        true,
                        Some("helper-action"),
                        None,
                        None,
                    );
                    if let Some(controls) = helper.control_settings.value_mut() {
                        controls.home = Presence::Value(true);
                    }
                    helper
                },
            ],
            vec![
                action("root-action", &["story"]),
                action("helper-action", &["story"]),
            ],
        ))
        .unwrap();

        assert_eq!(output.shared_entries.len(), 1);
        let helper = &output.shared_entries[0];
        assert_eq!(helper.id, "helper");
        assert_eq!(helper.entry_type, "menu");
        assert_eq!(helper.children.len(), 1);
        assert_eq!(helper.children[0].entry_type, "ref");
        assert_eq!(helper.children[0].target.as_deref(), Some("story:story"));
    }

    #[test]
    fn convergent_choice_hub_moves_to_shared_entries() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage(
                    "choice",
                    "Choice",
                    true,
                    false,
                    Some("choice-action"),
                    None,
                    None,
                ),
                stage(
                    "branch-a",
                    "Branch A",
                    true,
                    false,
                    Some("branch-a-action"),
                    None,
                    None,
                ),
                stage(
                    "branch-b",
                    "Branch B",
                    true,
                    false,
                    Some("branch-b-action"),
                    None,
                    None,
                ),
                stage("hub", "Hub", true, false, None, None, Some("hub.mp3")),
            ],
            vec![
                action("root-action", &["choice"]),
                action("choice-action", &["branch-a", "branch-b"]),
                action("branch-a-action", &["hub"]),
                action("branch-b-action", &["hub"]),
            ],
        ))
        .unwrap();

        assert_eq!(output.shared_entries.len(), 1);
        assert_eq!(output.shared_entries[0].id, "hub");
        let branch_a = &output.root_entries[0].children[0];
        let branch_b = &output.root_entries[0].children[1];
        assert_eq!(branch_a.children[0].entry_type, "ref");
        assert_eq!(branch_a.children[0].target.as_deref(), Some("menu:hub"));
        assert_eq!(branch_b.children[0].entry_type, "ref");
        assert_eq!(branch_b.children[0].target.as_deref(), Some("menu:hub"));
    }

    #[test]
    fn ok_cycle_becomes_reference_without_recursive_tree() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage("a", "A", true, false, Some("a-action"), None, None),
                stage("b", "B", true, false, Some("b-action"), None, None),
            ],
            vec![
                action("root-action", &["a"]),
                action("a-action", &["b"]),
                action("b-action", &["a"]),
            ],
        ))
        .unwrap();

        assert_eq!(output.root_entries.len(), 1);
        assert_eq!(output.root_entries[0].entry_type, "ref");
        assert_eq!(output.root_entries[0].target.as_deref(), Some("menu:a"));
        assert_eq!(output.shared_entries.len(), 1);
        assert_eq!(output.shared_entries[0].id, "a");
        let back_ref = &output.shared_entries[0].children[0].children[0];
        assert_eq!(back_ref.entry_type, "ref");
        assert_eq!(back_ref.target.as_deref(), Some("menu:a"));
        assert_eq!(back_ref.ref_kind.as_deref(), Some("return"));
    }

    #[test]
    fn home_transition_target_never_enters_tree() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage(
                    "menu",
                    "Menu",
                    true,
                    false,
                    Some("menu-action"),
                    Some("home-action"),
                    None,
                ),
                stage("story", "Story", false, true, None, None, Some("story.mp3")),
                stage(
                    "home-only",
                    "Home only",
                    false,
                    true,
                    None,
                    None,
                    Some("home.mp3"),
                ),
            ],
            vec![
                action("root-action", &["menu"]),
                action("menu-action", &["story"]),
                action("home-action", &["home-only"]),
            ],
        ))
        .unwrap();

        let mut ids = Vec::new();
        collect_ids(&output.root_entries, &mut ids);
        collect_ids(&output.shared_entries, &mut ids);
        assert!(!ids.iter().any(|id| id == "home-only"));
    }

    #[test]
    fn shared_title_wheel_keeps_autoplay_playback_as_story_entry() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage(
                    "choice",
                    "Choice",
                    true,
                    false,
                    Some("choice-action"),
                    None,
                    None,
                ),
                stage(
                    "branch-a",
                    "Branch A",
                    true,
                    false,
                    Some("branch-a-action"),
                    None,
                    None,
                ),
                stage(
                    "branch-b",
                    "Branch B",
                    true,
                    false,
                    Some("branch-b-action"),
                    None,
                    None,
                ),
                stage(
                    "title",
                    "Titre - Episode 5",
                    true,
                    false,
                    Some("title-action"),
                    None,
                    Some("title.mp3"),
                ),
                stage(
                    "play",
                    "Histoire - Episode 5",
                    false,
                    true,
                    None,
                    None,
                    Some("play.mp3"),
                ),
            ],
            vec![
                action("root-action", &["choice"]),
                action("choice-action", &["branch-a", "branch-b"]),
                action("branch-a-action", &["title"]),
                action("branch-b-action", &["title"]),
                action("title-action", &["play"]),
            ],
        ))
        .unwrap();

        assert_eq!(output.shared_entries.len(), 1);
        let title = &output.shared_entries[0];
        assert_eq!(title.id, "title");
        assert_eq!(title.entry_type, "story");
        assert_eq!(title.name, "Episode 5");
        assert!(title.children.is_empty());
        assert_eq!(title.item_audio.as_deref(), Some("title.mp3"));
        assert_eq!(title.audio.as_deref(), Some("play.mp3"));
        assert!(title.title_control_settings.is_some());
        assert_eq!(
            output.root_entries[0].children[0].children[0]
                .target
                .as_deref(),
            Some("story:title")
        );
    }

    #[test]
    fn direct_target_to_shared_playback_uses_story_play_target() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage(
                    "choice",
                    "Choice",
                    true,
                    false,
                    Some("choice-action"),
                    None,
                    None,
                ),
                stage(
                    "title",
                    "Title",
                    true,
                    false,
                    Some("title-action"),
                    None,
                    Some("title.mp3"),
                ),
                stage(
                    "play",
                    "Playback",
                    false,
                    true,
                    None,
                    None,
                    Some("play.mp3"),
                ),
            ],
            vec![
                action("root-action", &["choice"]),
                action("choice-action", &["title", "play"]),
                action("title-action", &["play"]),
            ],
        ))
        .unwrap();

        assert_eq!(output.shared_entries.len(), 1);
        assert_eq!(output.shared_entries[0].id, "title");
        assert_eq!(output.shared_entries[0].entry_type, "story");
        let choice = &output.root_entries[0];
        assert_eq!(choice.children[0].target.as_deref(), Some("story:title"));
        assert_eq!(
            choice.children[1].target.as_deref(),
            Some("story_play:title")
        );
    }

    #[test]
    fn unreachable_convergence_does_not_create_unused_shared_entries() {
        let output = project_story_graph(&document(
            vec![
                stage("root", "Root", true, false, Some("root-action"), None, None),
                stage("story", "Story", false, true, None, None, Some("story.mp3")),
                stage(
                    "ghost-a",
                    "Ghost A",
                    true,
                    false,
                    Some("ghost-a-action"),
                    None,
                    None,
                ),
                stage(
                    "ghost-b",
                    "Ghost B",
                    true,
                    false,
                    Some("ghost-b-action"),
                    None,
                    None,
                ),
                stage("ghost-hub", "Ghost Hub", true, false, None, None, None),
            ],
            vec![
                action("root-action", &["story"]),
                action("ghost-a-action", &["ghost-hub"]),
                action("ghost-b-action", &["ghost-hub"]),
            ],
        ))
        .unwrap();

        assert!(output.shared_entries.is_empty());

        let mut targets = Vec::new();
        collect_targets(&output.root_entries, &mut targets);
        collect_targets(&output.shared_entries, &mut targets);
        for shared in &output.shared_entries {
            let typed = format!("{}:{}", shared.entry_type, shared.id);
            assert!(targets.iter().any(|target| target == &typed));
        }
    }

    /// Une sélection aléatoire n'est jamais résolue vers l'option
    /// `0` par le projecteur. Sur un routeur indexé — le seul cas où le
    /// projecteur aplatit une Action sur une destination unique — elle garde tout
    /// son éventail.
    #[test]
    fn a_random_ok_selection_keeps_every_destination_instead_of_option_zero() {
        let mut stages = vec![
            stage(
                "root",
                "Root",
                false,
                false,
                Some("root-action"),
                None,
                None,
            ),
            // Deux indices fixes distincts sur la même Action : c'est ce qui en
            // fait un « routeur indexé partagé » pour le projecteur.
            stage_with_ok_option(
                "fixed-source-0",
                "Fixed source 0",
                true,
                false,
                "state-router",
                0,
                Some("fixed-0.mp3"),
            ),
            stage_with_ok_option(
                "fixed-source",
                "Fixed source",
                true,
                false,
                "state-router",
                1,
                Some("fixed.mp3"),
            ),
            stage("state-a", "State A", false, true, None, None, Some("a.mp3")),
            stage("state-b", "State B", false, true, None, None, Some("b.mp3")),
        ];
        // Le Stage aléatoire vise le même routeur indexé que le Stage fixe.
        let mut random_source = stage(
            "random-source",
            "Random source",
            true,
            false,
            Some("state-router"),
            None,
            Some("random.mp3"),
        );
        random_source
            .ok_transition
            .value_mut()
            .expect("transition OK")
            .selection = OptionSelection::Random;
        stages.push(random_source);

        let synthetic = document(
            stages,
            vec![
                action("root-action", &["fixed-source-0", "fixed-source"]),
                action("state-router", &["state-a", "state-b"]),
            ],
        );
        let projector = GraphProjector::new(&synthetic);

        // Le Stage fixe est bien aplati sur sa seule destination indexée…
        assert_eq!(projector.ok_targets("fixed-source"), vec!["state-b"]);
        // …tandis que le Stage aléatoire conserve les deux, sans jamais se
        // rabattre sur « state-a » (l'option 0).
        assert_eq!(
            projector.ok_targets("random-source"),
            vec!["state-a", "state-b"]
        );
    }

    /// Le Home d'une sélection aléatoire ne désigne pas une destination unique :
    /// le projecteur n'en modélise aucune plutôt que d'affirmer l'option `0`.
    #[test]
    fn a_random_home_selection_models_no_single_return_target() {
        let mut home_stage = stage(
            "leaf",
            "Leaf",
            true,
            false,
            None,
            Some("home-action"),
            Some("leaf.mp3"),
        );
        home_stage
            .home_transition
            .value_mut()
            .expect("transition Home")
            .selection = OptionSelection::Random;

        let synthetic = document(
            vec![
                stage(
                    "root",
                    "Root",
                    false,
                    false,
                    Some("root-action"),
                    None,
                    None,
                ),
                home_stage,
                stage("home-a", "Home A", false, true, None, None, Some("ha.mp3")),
                stage("home-b", "Home B", false, true, None, None, Some("hb.mp3")),
            ],
            vec![
                action("root-action", &["leaf"]),
                action("home-action", &["home-a", "home-b"]),
            ],
        );
        let projector = GraphProjector::new(&synthetic);

        assert_eq!(projector.home_target("leaf"), None);
    }
}
