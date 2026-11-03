use crate::support::user_message;
use crate::support::user_message::codes;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;

use crate::domain::project::{EntryControlSettings, ProjectEntry};
#[cfg(test)]
use crate::native_pack::OptionSelection;
use crate::native_pack::{ActionNode, StageNode, StoryDocument};

use super::stage::imported_story_name;

pub(crate) struct GraphImportOutput {
    pub(crate) root_entries: Vec<ProjectEntry>,
    pub(crate) shared_entries: Vec<ProjectEntry>,
    pub(crate) out_of_tree_edges: Vec<OutOfTreeEdge>,
    pub(crate) diagnostics: Vec<String>,
    play_stage_by_entry: HashMap<String, String>,
}

pub(super) struct GraphImportProjection {
    pub(super) root_entries: Vec<serde_json::Value>,
    pub(super) shared_entries: Vec<serde_json::Value>,
    pub(super) out_of_tree_edges: Vec<OutOfTreeEdge>,
    pub(super) diagnostics: Vec<String>,
}

/// Une arête OK que l'arbre de l'éditeur par menus ne peut pas porter : sa cible
/// est déjà placée ailleurs (convergence, élément partagé) ou est un ancêtre
/// (boucle). L'arbre n'a pas de nœud pour la représenter ; elle est seulement
/// consignée ici, et sa présence rend la projection non éditable par menus
/// (`IMPORT_AUTHORING_HIERARCHY_INCOMPLETE`) : un tel pack relève de l'éditeur
/// graphe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutOfTreeEdge {
    /// Entrée projetée qui porte l'arête ; `None` pour une option de la racine.
    pub(crate) source_entry_id: Option<String>,
    /// Cible typée (`menu:`/`story:`/`story_play:`) de l'arête.
    pub(crate) target: String,
}

/// Arêtes hors arbre encore portées par la projection : celles d'une entrée que
/// la suite de l'import a retirée (pont de nuit) disparaissent avec elle.
pub(super) fn live_out_of_tree_edge_count(
    edges: &[OutOfTreeEdge],
    root_entries: &[serde_json::Value],
    shared_entries: &[serde_json::Value],
) -> usize {
    fn collect<'v>(entries: &'v [serde_json::Value], ids: &mut HashSet<&'v str>) {
        for entry in entries {
            if let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) {
                ids.insert(id);
            }
            if let Some(children) = entry.get("children").and_then(serde_json::Value::as_array) {
                collect(children, ids);
            }
        }
    }
    let mut ids = HashSet::new();
    collect(root_entries, &mut ids);
    collect(shared_entries, &mut ids);
    edges
        .iter()
        .filter(|edge| {
            edge.source_entry_id
                .as_deref()
                .is_none_or(|source| ids.contains(source))
        })
        .count()
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
        out_of_tree_edges: output.out_of_tree_edges,
        diagnostics: output.diagnostics,
    })
}

/// Catalogue classification uses the importer's entry shapes and indexed routers.
/// Its result is stored by the catalogue: a change of result requires a new
/// `LISTENING_VERSION` (`services/catalogue/analyze/listening.rs`).
/// Playback return edges and menu/game loops are navigation, not additional
/// stories: every stage reachable through OK edges is visited once. A non-story
/// stage without an OK target (dead end), a missing target and interactive
/// playback remain unknown.
pub(crate) fn story_audio(document: &StoryDocument) -> Option<Vec<(String, String)>> {
    let projector = GraphProjector::new_with_assets(document, None);
    if !projector.diagnostics.is_empty()
        || document
            .stage_nodes
            .iter()
            .filter(|s| s.is_square_one())
            .count()
            != 1
        || projector.stages.len() != document.stage_nodes.len()
        || projector.actions.len() != document.action_nodes.len()
    {
        return None;
    }
    fn visit<'a>(
        p: &GraphProjector<'a>,
        ok_marks_transitions: bool,
        id: &'a str,
        done: &mut HashSet<&'a str>,
        stories: &mut HashMap<String, String>,
        depth: usize,
    ) -> Option<()> {
        if depth > MAX_TREE_DEPTH {
            return None;
        }
        // A stage already visited (menu/game loop, shared target) adds nothing:
        // its targets are explored from its first visit.
        if !done.insert(id) {
            return Some(());
        }
        let stage = p.stages.get(id)?;
        if !stage.is_square_one() {
            let candidate = match p.entry_shape(id)? {
                EntryShape::Story { play_stage_id, .. } => play_stage_id,
                EntryShape::Menu => id,
            };
            let play = p.stages.get(candidate)?;
            // Import shapes also preserve prompts as entries. A listening
            // story must permit uninterrupted playback: pausable with no wheel,
            // or a terminal non-interactive sound. In particular, autoplay menu
            // prompts and title/transition audio are not listening stories.
            if is_playback_stage(play)
                && !play.control_settings.wheel()
                // Official packs mark their stories ok=false; their pausable
                // introductions and game prompts are OK-skippable autoplay
                // transitions. Packs whose stories accept OK keep counting them.
                && !(ok_marks_transitions
                    && play.control_settings.ok()
                    && play.control_settings.autoplay())
                && (play.control_settings.pause() || p.ok_targets(candidate).is_empty())
            {
                stories.insert(candidate.to_owned(), play.audio.as_deref()?.to_owned());
                return Some(());
            }
        }
        let targets = p.ok_targets(id);
        if targets.is_empty() {
            return None;
        }
        for target in targets {
            visit(p, ok_marks_transitions, target, done, stories, depth + 1)?;
        }
        Some(())
    }
    let root = document.stage_nodes.iter().find(|s| s.is_square_one())?;
    let mut stories = HashMap::new();
    let ok_marks_transitions = document.stage_nodes.iter().any(|s| {
        is_playback_stage(s)
            && !s.control_settings.wheel()
            && !s.control_settings.ok()
            && s.control_settings.pause()
    });
    visit(
        &projector,
        ok_marks_transitions,
        &root.uuid,
        &mut HashSet::new(),
        &mut stories,
        0,
    )?;
    if stories.is_empty() {
        return None;
    }
    let mut stories: Vec<_> = stories.into_iter().collect();
    stories.sort();
    Some(stories)
}

/// Racine dont l'unique option vise l'unique entrée partagée, sans aucune autre
/// arête hors arbre : cette entrée devient la racine. Toute autre arête hors
/// arbre (retour, autre convergence) laisse la projection non éditable.
pub(super) fn promote_autonomous_root_target_values(
    root_entries: &mut Vec<serde_json::Value>,
    shared_entries: &mut Vec<serde_json::Value>,
    out_of_tree_edges: &mut Vec<OutOfTreeEdge>,
) -> bool {
    if !root_entries.is_empty()
        || shared_entries.len() != 1
        || live_out_of_tree_edge_count(out_of_tree_edges, root_entries, shared_entries) != 1
    {
        return false;
    }
    let Some(root_edge_index) = out_of_tree_edges
        .iter()
        .position(|edge| edge.source_entry_id.is_none())
    else {
        return false;
    };
    let Ok(shared) = serde_json::from_value::<ProjectEntry>(shared_entries[0].clone()) else {
        return false;
    };
    if !typed_target_matches_entry(&out_of_tree_edges[root_edge_index].target, &shared) {
        return false;
    }
    root_entries.push(shared_entries.remove(0));
    out_of_tree_edges.remove(root_edge_index);
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
    out_of_tree_edges: Vec<OutOfTreeEdge>,
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
            out_of_tree_edges: Vec::new(),
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
        for target_id in self.ok_targets(square_one_id).iter() {
            let entry = if root_entries.is_empty() && !self.indexed_router_actions.is_empty() {
                // La première cible de squareOne est l'ancre de l'arbre authoring.
                // Une arête de retour vers cette ancre ne doit pas la déplacer dans
                // le pool partagé : elle sera modélisée comme navigation de fin.
                self.build_concrete_entry(target_id, &mut active, &mut emitted_tree, true)
            } else {
                self.build_edge_entry(None, target_id, &mut active, &mut emitted_tree)
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
            out_of_tree_edges: self.out_of_tree_edges,
            diagnostics: self.diagnostics,
            play_stage_by_entry,
        })
    }

    fn square_one_id(&mut self) -> Result<&'a str, String> {
        self.stages
            .values()
            .find(|stage| stage.is_square_one())
            .map(|stage| stage.uuid.as_str())
            .ok_or_else(|| {
                user_message::UserMessage::new(codes::IMPORT_STORY_ENTRY_STAGE_ABSENT)
                    .with_detail("story.json sans squareOne".to_string())
                    .into_transport()
            })
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
                self.diagnostics.push({
                    let _msg_stage_label = (stage.label()).to_string();
                    let _msg_transition_action_node = (transition.action_node).to_string();
                    user_message::UserMessage::new(
                        codes::IMPORT_OK_ACTION_MISSING,
                    )
                        .param(
                            "stageLabel",
                            user_message::transport_param(_msg_stage_label.clone()),
                        )
                        .param(
                            "actionNodeId",
                            user_message::transport_param(_msg_transition_action_node.clone()),
                        )
                        .with_detail(format!(
                            "Stage '{_msg_stage_label}' okTransition vers action introuvable '{_msg_transition_action_node}'",
                            _msg_stage_label = user_message::transport_detail(&_msg_stage_label),
                            _msg_transition_action_node = user_message::transport_detail(&_msg_transition_action_node),
                        ))
                        .into_transport()
                    });
                continue;
            };

            let action_targets: Vec<&str> = action
                .named_options()
                .filter(|target_id| {
                    let known = self.stages.contains_key(target_id);
                    if !known {
                        self.diagnostics.push({
                        let _msg_action_label = (action.label()).to_string();
                        let _msg_target_id = (target_id).to_string();
                        user_message::UserMessage::new(
                            codes::IMPORT_ACTION_STAGE_MISSING,
                        )
                            .param(
                                "actionLabel",
                                user_message::transport_param(_msg_action_label.clone()),
                            )
                            .param(
                                "targetId",
                                user_message::transport_param(_msg_target_id.clone()),
                            )
                            .with_detail(format!(
                                "Action '{_msg_action_label}' pointe vers stage introuvable '{_msg_target_id}'",
                                _msg_action_label = user_message::transport_detail(&_msg_action_label),
                                _msg_target_id = user_message::transport_detail(&_msg_target_id),
                            ))
                            .into_transport()
                        });
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
                        self.diagnostics.push({
                            let _msg_stage_label = (stage.label()).to_string();
                            let transition_selection = (transition.selection).to_string();
                            let _msg_action_label = (action.label()).to_string();
                            let _msg_action_targets = (action_targets.len()).to_string();
                            user_message::UserMessage::new(
                                codes::IMPORT_OK_OPTION_OUTSIDE,
                            )
                                .param(
                                    "stageLabel",
                                    user_message::transport_param(_msg_stage_label.clone()),
                                )
                                .param(
                                    "selectionIndex",
                                    user_message::transport_param(transition_selection.clone()),
                                )
                                .param(
                                    "actionLabel",
                                    user_message::transport_param(_msg_action_label.clone()),
                                )
                                .param(
                                    "actionTargets",
                                    user_message::transport_param(_msg_action_targets.clone()),
                                )
                                .with_detail(format!(
                                    "Stage '{_msg_stage_label}' okTransition option {transition_selection} hors limites pour l'action '{_msg_action_label}' ({_msg_action_targets} options)",
                                    _msg_action_label = user_message::transport_detail(&_msg_action_label),
                                    _msg_action_targets = user_message::transport_detail(&_msg_action_targets),
                                    _msg_stage_label = user_message::transport_detail(&_msg_stage_label),
                                    transition_selection = user_message::transport_detail(&transition_selection),
                                ))
                                .into_transport()
                            });
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

    /// `source_entry_id` : entrée projetée qui porte l'option (`None` à la racine).
    /// Rend l'entrée construite à cette place, ou `None` : cible injoignable, non
    /// projetable, ou déjà placée ailleurs — l'arête est alors consignée hors arbre
    /// dans `out_of_tree_edges`, sans nœud.
    fn build_edge_entry(
        &mut self,
        source_entry_id: Option<&'a str>,
        target_id: &'a str,
        active: &mut Vec<&'a str>,
        emitted_tree: &mut HashSet<&'a str>,
    ) -> Option<ProjectEntry> {
        if !self.reachable.contains(target_id) {
            return None;
        }
        if self.target_is_out_of_tree(target_id, active, emitted_tree) {
            let target = self.typed_target(target_id)?;
            self.ensure_shared_entry(target_id, active, emitted_tree);
            self.out_of_tree_edges.push(OutOfTreeEdge {
                source_entry_id: source_entry_id.map(str::to_string),
                target,
            });
            return None;
        }
        self.build_concrete_entry(target_id, active, emitted_tree, true)
    }

    /// La cible est déjà placée (partagée, ancêtre actif ou déjà émise) : l'arbre
    /// ne peut pas la contenir une seconde fois.
    fn target_is_out_of_tree(
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
            self.diagnostics.push({
                let _msg_max_tree_depth = (MAX_TREE_DEPTH).to_string();
                let _msg_stage_label = (stage.label()).to_string();
                user_message::UserMessage::new(
                    codes::IMPORT_GRAPH_DEPTH_LIMIT,
                )
                    .param(
                        "maxDepth",
                        user_message::transport_param(_msg_max_tree_depth.clone()),
                    )
                    .param(
                        "stageLabel",
                        user_message::transport_param(_msg_stage_label.clone()),
                    )
                    .with_detail(format!(
                        "Graphe trop profond pour une modelisation en arbre (profondeur > {_msg_max_tree_depth}), stage '{_msg_stage_label}'",
                        _msg_max_tree_depth = user_message::transport_detail(&_msg_max_tree_depth),
                        _msg_stage_label = user_message::transport_detail(&_msg_stage_label),
                    ))
                    .into_transport()
                });
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
                let source_entry_id = stage.uuid.as_str();
                for target_id in &targets {
                    if let Some(child) = self.build_edge_entry(
                        Some(source_entry_id),
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
                    self.diagnostics.push({
                        let _msg_stage_label = (stage.label()).to_string();
                        user_message::UserMessage::new(
                            codes::IMPORT_STAGE_OUTPUTS_UNSUPPORTED,
                        )
                            .param(
                                "stageLabel",
                                user_message::transport_param(_msg_stage_label.clone()),
                            )
                            .with_detail(format!(
                                "Stage '{_msg_stage_label}' a plusieurs sorties OK non modelisees en story",
                                _msg_stage_label = user_message::transport_detail(&_msg_stage_label),
                            ))
                            .into_transport()
                        });
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
                ..Default::default()
            });
            // Son unique sortie vise un nœud déjà placé : arête hors arbre.
            self.out_of_tree_edges.push(OutOfTreeEdge {
                source_entry_id: Some(stage.uuid.clone()),
                target,
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

    fn root_edge(target: &str) -> OutOfTreeEdge {
        OutOfTreeEdge {
            source_entry_id: None,
            target: target.to_string(),
        }
    }

    fn inner_edge(source: &str, target: &str) -> OutOfTreeEdge {
        OutOfTreeEdge {
            source_entry_id: Some(source.to_string()),
            target: target.to_string(),
        }
    }

    /// Promotion de la cible unique de la racine, sur les valeurs JSON que
    /// produit `project_story_graph_values`.
    fn promote(
        shared: Vec<ProjectEntry>,
        mut edges: Vec<OutOfTreeEdge>,
    ) -> (
        bool,
        Vec<serde_json::Value>,
        Vec<serde_json::Value>,
        Vec<OutOfTreeEdge>,
    ) {
        let mut roots = Vec::new();
        let mut shared = entries_to_json(&shared);
        let promoted = promote_autonomous_root_target_values(&mut roots, &mut shared, &mut edges);
        (promoted, roots, shared, edges)
    }

    #[test]
    fn autonomous_root_target_is_promoted() {
        let (promoted, roots, shared, edges) = promote(
            vec![synthetic_entry("shared", "story", Some("native-shared"))],
            vec![root_edge("story:shared")],
        );

        assert!(promoted);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0]["id"], "shared");
        assert!(shared.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn autonomous_root_target_accepts_native_stage_id_target() {
        let (promoted, roots, shared, _) = promote(
            vec![synthetic_entry("shared", "story", Some("native-shared"))],
            vec![root_edge("story:native-shared")],
        );

        assert!(promoted);
        assert_eq!(roots[0]["id"], "shared");
        assert!(shared.is_empty());
    }

    #[test]
    fn multiple_shared_entries_are_not_promoted() {
        let (promoted, roots, shared, edges) = promote(
            vec![
                synthetic_entry("shared", "story", None),
                synthetic_entry("other", "story", None),
            ],
            vec![root_edge("story:shared")],
        );

        assert!(!promoted);
        assert!(roots.is_empty());
        assert_eq!(shared.len(), 2);
        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn internal_out_of_tree_edge_keeps_root_projection_unchanged() {
        let (promoted, roots, shared, edges) = promote(
            vec![synthetic_entry("shared", "menu", None)],
            vec![
                root_edge("menu:shared"),
                inner_edge("shared", "story:other"),
            ],
        );

        assert!(!promoted);
        assert!(roots.is_empty());
        assert_eq!(shared.len(), 1);
        assert_eq!(edges.len(), 2);
    }

    #[test]
    fn absent_or_ambiguous_target_keeps_root_projection_unchanged() {
        for target in ["story:missing", "story:shared:ambiguous"] {
            let (promoted, roots, shared, _) = promote(
                vec![synthetic_entry("shared", "story", None)],
                vec![root_edge(target)],
            );

            assert!(!promoted);
            assert!(roots.is_empty());
            assert_eq!(shared.len(), 1);
        }
    }

    #[test]
    fn cycle_back_edge_keeps_root_projection_unchanged() {
        let (promoted, roots, shared, _) = promote(
            vec![ProjectEntry {
                children: vec![synthetic_entry("story", "story", None)],
                ..synthetic_entry("shared", "menu", None)
            }],
            vec![root_edge("menu:shared"), inner_edge("story", "menu:shared")],
        );

        assert!(!promoted);
        assert!(roots.is_empty());
        assert_eq!(shared.len(), 1);
    }

    #[test]
    fn promotion_preserves_order_native_ids_and_returns() {
        let (promoted, roots, shared, _) = promote(
            vec![ProjectEntry {
                native_stage_id: Some("native-shared".to_string()),
                return_after_play: Some("story:after".to_string()),
                children: vec![
                    synthetic_entry("first", "story", Some("native-first")),
                    synthetic_entry("second", "story", Some("native-second")),
                ],
                ..synthetic_entry("shared", "menu", None)
            }],
            vec![root_edge("menu:native-shared")],
        );

        assert!(promoted);
        let promoted = &roots[0];
        assert_eq!(promoted["id"], "shared");
        assert_eq!(promoted["nativeStageId"], "native-shared");
        assert_eq!(promoted["returnAfterPlay"], "story:after");
        assert_eq!(
            promoted["children"]
                .as_array()
                .expect("children")
                .iter()
                .map(|entry| entry["id"].as_str().expect("id"))
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
        // Sa sortie vise un nœud déjà placé : aucun nœud, une arête hors arbre.
        assert!(helper.children.is_empty());
        assert_eq!(
            output.out_of_tree_edges,
            vec![inner_edge("helper", "story:story")]
        );
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
        // La convergence n'a pas de nœud dans l'arbre : deux arêtes hors arbre.
        assert!(branch_a.children.is_empty());
        assert!(branch_b.children.is_empty());
        assert_eq!(
            output.out_of_tree_edges,
            vec![
                inner_edge("branch-a", "menu:hub"),
                inner_edge("branch-b", "menu:hub"),
            ]
        );
    }

    #[test]
    fn ok_cycle_becomes_out_of_tree_edge_without_recursive_tree() {
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

        // Ni la racine ni le retour de la boucle n'ont de nœud dans l'arbre.
        assert!(output.root_entries.is_empty());
        assert_eq!(output.shared_entries.len(), 1);
        assert_eq!(output.shared_entries[0].id, "a");
        assert!(output.shared_entries[0].children[0].children.is_empty());
        assert_eq!(
            output.out_of_tree_edges,
            vec![inner_edge("b", "menu:a"), root_edge("menu:a")]
        );
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
        assert!(output.root_entries[0].children[0].children.is_empty());
        assert_eq!(
            output.out_of_tree_edges,
            vec![
                inner_edge("branch-a", "story:title"),
                inner_edge("branch-b", "story:title"),
            ]
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
        assert!(output.root_entries[0].children.is_empty());
        assert_eq!(
            output.out_of_tree_edges,
            vec![
                inner_edge("choice", "story:title"),
                inner_edge("choice", "story_play:title"),
            ]
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

#[cfg(test)]
mod listening_tests {
    use super::*;
    use serde_json::json;
    fn measure(
        stages: serde_json::Value,
        actions: serde_json::Value,
    ) -> Option<Vec<(String, String)>> {
        story_audio(
            &serde_json::from_value(json!({"stageNodes":stages,"actionNodes":actions})).unwrap(),
        )
    }
    #[test]
    fn listening_descends_prompts_and_deduplicates_shared_playback() {
        let stages = json!([
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"menu","audio":"prompt.mp3","controlSettings":{"autoplay":true},"okTransition":{"actionNode":"titles","optionIndex":0}},
            {"uuid":"a","audio":"title-a.mp3","controlSettings":{"wheel":true},"okTransition":{"actionNode":"play","optionIndex":0}},
            {"uuid":"b","audio":"title-b.mp3","controlSettings":{"wheel":true},"okTransition":{"actionNode":"play","optionIndex":0}},
            {"uuid":"p","audio":"story.mp3","controlSettings":{"pause":true,"autoplay":true},"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"detached","audio":"unused.mp3","controlSettings":{"pause":true}}
        ]);
        let actions = json!([{"id":"root","options":["menu"]},{"id":"titles","options":["a","b"]},{"id":"play","options":["p"]}]);
        assert_eq!(
            measure(stages, actions),
            Some(vec![("p".into(), "story.mp3".into())])
        );
    }
    #[test]
    fn ok_skippable_stories_count_when_no_stage_marks_stories_with_ok_false() {
        let stages = json!([
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"menu","audio":"q.mp3","controlSettings":{"autoplay":true},"okTransition":{"actionNode":"ch","optionIndex":0}},
            {"uuid":"s1","audio":"s1.mp3","controlSettings":{"ok":true,"home":true,"pause":true,"autoplay":true},"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"s2","audio":"s2.mp3","controlSettings":{"ok":true,"home":true,"pause":true,"autoplay":true},"okTransition":{"actionNode":"root","optionIndex":0}}
        ]);
        let actions = json!([{"id":"root","options":["menu"]},{"id":"ch","options":["s1","s2"]}]);
        assert_eq!(
            measure(stages, actions),
            Some(vec![
                ("s1".into(), "s1.mp3".into()),
                ("s2".into(), "s2.mp3".into())
            ])
        );
    }
    #[test]
    fn a_game_loop_back_to_the_hub_keeps_the_stories_counted() {
        let stages = json!([
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"hub","audio":"hub.mp3","controlSettings":{"autoplay":true},"okTransition":{"actionNode":"hub-options","optionIndex":0}},
            {"uuid":"t1","audio":"t1.mp3","controlSettings":{"wheel":true,"ok":true},"okTransition":{"actionNode":"play1","optionIndex":0}},
            {"uuid":"t2","audio":"t2.mp3","controlSettings":{"wheel":true,"ok":true},"okTransition":{"actionNode":"play2","optionIndex":0}},
            {"uuid":"g","audio":"game.mp3","controlSettings":{"wheel":true,"ok":true},"okTransition":{"actionNode":"question","optionIndex":0}},
            {"uuid":"p1","audio":"p1.mp3","controlSettings":{"pause":true,"autoplay":true},"okTransition":{"actionNode":"back","optionIndex":0}},
            {"uuid":"p2","audio":"p2.mp3","controlSettings":{"pause":true,"autoplay":true},"okTransition":{"actionNode":"back","optionIndex":0}},
            {"uuid":"q","audio":"answer.mp3","controlSettings":{"ok":true,"autoplay":true},"okTransition":{"actionNode":"back","optionIndex":0}}
        ]);
        let actions = json!([
            {"id":"root","options":["hub"]},
            {"id":"hub-options","options":["t1","t2","g"]},
            {"id":"play1","options":["p1"]},
            {"id":"play2","options":["p2"]},
            {"id":"question","options":["q"]},
            {"id":"back","options":["hub"]}
        ]);
        assert_eq!(
            measure(stages, actions),
            Some(vec![
                ("p1".into(), "p1.mp3".into()),
                ("p2".into(), "p2.mp3".into())
            ])
        );
    }
    #[test]
    fn a_wheel_dead_end_beside_a_story_leaves_the_measure_unknown() {
        let stages = json!([
            {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"menu","audio":"q.mp3","controlSettings":{"autoplay":true},"okTransition":{"actionNode":"ch","optionIndex":0}},
            {"uuid":"s1","audio":"s1.mp3","controlSettings":{"home":true,"pause":true,"autoplay":true},"okTransition":{"actionNode":"root","optionIndex":0}},
            {"uuid":"w","audio":"w.mp3","controlSettings":{"wheel":true}}
        ]);
        let actions = json!([{"id":"root","options":["menu"]},{"id":"ch","options":["s1","w"]}]);
        assert!(measure(stages, actions).is_none());
    }
    #[test]
    fn story_free_loops_missing_targets_and_interactive_dead_ends_are_unknown() {
        for target in ["r", "missing", "wheel"] {
            assert!(measure(json!([
                {"uuid":"r","squareOne":true,"okTransition":{"actionNode":"choice","optionIndex":0}},
                {"uuid":"wheel","audio":"choice.mp3","controlSettings":{"wheel":true,"pause":true}}
            ]),json!([{"id":"choice","options":[target]}])).is_none());
        }
    }
}
