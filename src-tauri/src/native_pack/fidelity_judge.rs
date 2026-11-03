//! Juge de fidélité canonique — garde-fou entre pack géré et lecture seule.
//!
//! Question binaire, par pack : « le chemin **canonique** (`StoryBuilder`, sans
//! parachute) régénère-t-il fidèlement le pack importé ? ». Ce verdict pilote
//! désormais l'éditabilité et bloque la génération quand un ancien `nativeGraph`
//! actif ne peut pas être reproduit par le modèle Story Studio.
//!
//! Méthode : générer le document via le canonique en **ignorant** le `nativeGraph`,
//! puis comparer STRUCTURELLEMENT (UUID-agnostique) au snapshot `nativeGraph.document`
//! d'origine — l'oracle, vérité terrain du pack. Sans `nativeGraph`, le pack est déjà
//! pleinement modélisé : l'arbre EST la source de vérité, donc fidèle dès qu'il génère
//! un document STUdio-valide.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use super::assets::pipeline::{active_native_graph, collect_asset_requests, AssetSourceKind};
use super::canonical::CanonicalProject;
use super::document::{ActionNode, StageNode, StoryDocument, Transition};
use super::option_selection::OptionSelection;
use super::stats::NativeAssetStats;
use super::{build_canonical_story_document, NativeAssetPreparationReport, PreparedAsset};

/// Verdict du juge : fidèle ou non, avec le détail des écarts. Chaque écart = une
/// « forme » de stage dont le compte diffère entre la génération canonique et l'oracle
/// (un nœud / une arête présent d'un côté et pas de l'autre) → matière à combler.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct FidelityReport {
    pub(crate) faithful: bool,
    pub(crate) generated_stage_count: usize,
    pub(crate) oracle_stage_count: usize,
    pub(crate) invalid_transition_count: usize,
    pub(crate) asset_presence_gap_count: usize,
    pub(crate) topology_gaps: Vec<String>,
    #[serde(skip)]
    pub(crate) topology_gap_kinds: Vec<TopologyGapKind>,
    pub(crate) asset_presence_gaps: Vec<String>,
    pub(crate) gaps: Vec<String>,
}

impl FidelityReport {
    fn failed(reason: String) -> Self {
        Self {
            faithful: false,
            generated_stage_count: 0,
            oracle_stage_count: 0,
            invalid_transition_count: 0,
            asset_presence_gap_count: 0,
            topology_gap_kinds: vec![TopologyGapKind::Other],
            topology_gaps: vec![reason.clone()],
            asset_presence_gaps: Vec::new(),
            gaps: vec![reason],
        }
    }

    /// Pack pleinement modélisé (aucun parachute) : aucun oracle ne peut le contredire.
    fn modeled(generated_stage_count: usize) -> Self {
        Self {
            faithful: true,
            generated_stage_count,
            oracle_stage_count: 0,
            invalid_transition_count: 0,
            asset_presence_gap_count: 0,
            topology_gap_kinds: Vec::new(),
            topology_gaps: Vec::new(),
            asset_presence_gaps: Vec::new(),
            gaps: Vec::new(),
        }
    }
}

/// Décide si la génération canonique d'un pack est fidèle à l'oracle.
///
/// - `Ok(report)` : le juge a tourné ; `report.faithful` tranche.
/// - `Err(_)` : le juge n'a PAS pu tourner (snapshot oracle illisible) — exceptionnel.
///
/// Un échec de génération canonique n'est pas une erreur du juge mais un verdict
/// (« non fidèle : ne génère même pas »), replié dans `FidelityReport::failed`.
pub(crate) fn canonical_roundtrip_is_faithful(
    canonical: &CanonicalProject,
) -> Result<FidelityReport, String> {
    let generated = match canonical_document_for_fidelity(canonical) {
        Ok(document) => document,
        Err(error) => {
            return Ok(FidelityReport::failed(format!(
                "échec de génération canonique : {error}"
            )))
        }
    };

    let Some(graph) = active_native_graph(canonical.native_graph.as_ref()) else {
        return Ok(FidelityReport::modeled(generated.stage_nodes.len()));
    };

    let oracle_value = graph
        .get("document")
        .cloned()
        .ok_or_else(|| "Graphe natif sans document story.json.".to_string())?;
    let oracle: StoryDocument = serde_json::from_value(oracle_value)
        .map_err(|error| format!("Graphe natif invalide : {error}"))?;

    Ok(compare_documents_structural(&generated, &oracle))
}

/// Construit le document canonique avec des assets **fictifs** (noms seulement) : le
/// juge compare des structures de graphe, jamais des octets — donc ni ffmpeg ni vrais
/// fichiers. Tous les rôles utiles sont couverts (`collect_asset_requests` est le
/// sur-ensemble des rôles de l'arbre ; les rôles `nativeGraph` en trop sont inoffensifs).
fn canonical_document_for_fidelity(canonical: &CanonicalProject) -> Result<StoryDocument, String> {
    let assets = placeholder_assets(canonical);
    let report = fidelity_report_for(canonical.clone(), assets);
    build_canonical_story_document(&report)
}

fn placeholder_assets(canonical: &CanonicalProject) -> Vec<PreparedAsset> {
    collect_asset_requests(canonical, 1.0, 1.0)
        .into_iter()
        .enumerate()
        .map(|(index, request)| {
            let extension = match request.source_kind {
                AssetSourceKind::Image => "bmp",
                _ => "mp3",
            };
            PreparedAsset {
                role: request.role,
                source_path: String::new(),
                source_kind: "fidelity".to_string(),
                staged_asset_name: format!("fidelity-{index}.{extension}"),
                staged_asset_path: String::new(),
                transformed: false,
                deduplicated: false,
            }
        })
        .collect()
}

fn fidelity_report_for(
    project: CanonicalProject,
    assets: Vec<PreparedAsset>,
) -> NativeAssetPreparationReport {
    NativeAssetPreparationReport {
        project,
        pack_uuid: String::new(),
        stage_dir: String::new(),
        assets_dir: String::new(),
        assets,
        imported_zips: Vec::new(),
        stats: NativeAssetStats {
            requested_asset_count: 0,
            unique_asset_count: 0,
            transformed_audio_count: 0,
            imported_zip_count: 0,
        },
        notes: Vec::new(),
        warnings: Vec::new(),
        for_simulation: false,
    }
}

/// Compare deux documents par **multiset de formes de stages** (UUID-agnostique).
/// Une forme = les contrôles/assets d'un stage + les formes de ses cibles OK/Home
/// (arêtes à 1 niveau de profondeur). Un écart de compte révèle une structure présente
/// d'un côté seulement (nœud/arête perdu ou ajouté). Même métrique que le harnais
/// `assert_fidelity` éprouvé, ici promue en code de production. La copie graphe
/// d'un projet par menus s'en sert aussi comme garde (`graph_copy`).
pub(crate) fn compare_documents_structural(
    generated: &StoryDocument,
    oracle: &StoryDocument,
) -> FidelityReport {
    let mut topology_gaps = Vec::new();
    let mut topology_gap_kinds = Vec::new();

    if !generated
        .stage_nodes
        .iter()
        .any(|stage| stage.is_square_one())
    {
        topology_gap_kinds.push(TopologyGapKind::MissingEntry);
        topology_gaps.push("stage squareOne manquant dans la génération canonique".to_string());
    }
    // Le juge est un oracle de **comportement runtime**, pas l'oracle d'auteur :
    // il compare le mode nuit effectif, pour lequel absent et `false` sont
    // équivalents. La distinction de présence reste portée par le document.
    if generated.night_mode_available.is_true() != oracle.night_mode_available.is_true() {
        topology_gap_kinds.push(TopologyGapKind::NightMode);
        topology_gaps.push(format!(
            "nightModeAvailable : généré={} oracle={}",
            generated.night_mode_available.is_true(),
            oracle.night_mode_available.is_true()
        ));
    }

    topology_gap_kinds.extend(
        multiset_differences(&node_shapes(generated), &node_shapes(oracle))
            .into_iter()
            .map(|_| TopologyGapKind::Other),
    );
    topology_gaps.extend(compare_multiset(
        "stage",
        &node_shapes(generated),
        &node_shapes(oracle),
    ));

    let generated_topology = topology_shapes(generated);
    let oracle_topology = topology_shapes(oracle);
    topology_gap_kinds.extend(
        multiset_differences(&generated_topology.shapes, &oracle_topology.shapes)
            .into_iter()
            .map(|shape| TopologyGapKind::Transition(shape.clone())),
    );
    topology_gap_kinds.extend(std::iter::repeat_n(
        TopologyGapKind::InvalidTransition,
        generated_topology.invalid_transitions.len() + oracle_topology.invalid_transitions.len(),
    ));
    topology_gaps.extend(compare_multiset(
        "transition",
        &generated_topology.shapes,
        &oracle_topology.shapes,
    ));
    topology_gaps.extend(
        generated_topology
            .invalid_transitions
            .iter()
            .map(|gap| format!("transition invalide générée : {gap}")),
    );
    topology_gaps.extend(
        oracle_topology
            .invalid_transitions
            .iter()
            .map(|gap| format!("transition invalide oracle : {gap}")),
    );

    let asset_presence_gaps = compare_asset_presence(generated, oracle);
    let asset_presence_gap_count = count_multiset_delta(
        &asset_presence_shapes(generated),
        &asset_presence_shapes(oracle),
    );
    let invalid_transition_count =
        generated_topology.invalid_transitions.len() + oracle_topology.invalid_transitions.len();

    let mut gaps = topology_gaps.clone();
    gaps.extend(asset_presence_gaps.clone());

    FidelityReport {
        faithful: gaps.is_empty() && invalid_transition_count == 0,
        generated_stage_count: generated.stage_nodes.len(),
        oracle_stage_count: oracle.stage_nodes.len(),
        invalid_transition_count,
        asset_presence_gap_count,
        topology_gaps,
        topology_gap_kinds,
        asset_presence_gaps,
        gaps,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ControlShape {
    square_one: bool,
    has_audio: bool,
    has_image: bool,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
}

fn control_shape(stage: &StageNode) -> ControlShape {
    // Empreinte de comportement runtime : `has_audio` est vrai pour une valeur,
    // faux pour une absence comme pour un `null`. La distinction des deux reste
    // dans le document, elle n'appartient pas à cette empreinte.
    ControlShape {
        square_one: stage.is_square_one(),
        has_audio: stage.audio.is_value(),
        has_image: stage.image.is_value(),
        wheel: stage.control_settings.wheel(),
        ok: stage.control_settings.ok(),
        home: stage.control_settings.home(),
        pause: stage.control_settings.pause(),
        autoplay: stage.control_settings.autoplay(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct AssetPresenceShape {
    square_one: bool,
    wheel: bool,
    ok: bool,
    home: bool,
    pause: bool,
    autoplay: bool,
    has_audio: bool,
    has_image: bool,
}

fn asset_presence_shape(stage: &StageNode) -> AssetPresenceShape {
    AssetPresenceShape {
        square_one: stage.is_square_one(),
        wheel: stage.control_settings.wheel(),
        ok: stage.control_settings.ok(),
        home: stage.control_settings.home(),
        pause: stage.control_settings.pause(),
        autoplay: stage.control_settings.autoplay(),
        has_audio: stage.audio.is_value(),
        has_image: stage.image.is_value(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum TransitionKind {
    Ok,
    Home,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum InvalidTransitionKind {
    MissingAction,
    /// `Random` sur une Action sans option, ou `Fixed(i)` avec `i >= N`.
    /// `-1` n'entre plus ici, c'est la sentinelle `Random`.
    OptionOutOfBounds,
    MissingTargetStage,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum TransitionState {
    Missing,
    Selected {
        selection: OptionSelection,
        option_count: usize,
    },
    OptionTarget {
        target: ControlShape,
        option_index: usize,
        option_count: usize,
    },
    Invalid {
        reason: InvalidTransitionKind,
        selection: OptionSelection,
        option_count: Option<usize>,
    },
}

/// Preuve interne exclue des rapports IPC/persistés ; texte purement diagnostique.
#[derive(Debug, Clone)]
pub(crate) enum TopologyGapKind {
    Other,
    MissingEntry,
    NightMode,
    InvalidTransition,
    Transition(TopologyShape),
}

impl TopologyGapKind {
    pub(crate) fn blocks_aggregate_tolerance(&self) -> bool {
        matches!(
            self,
            Self::NightMode | Self::MissingEntry | Self::InvalidTransition
        )
    }

    pub(crate) fn is_end_home_or_night(&self) -> bool {
        match self {
            Self::NightMode => true,
            Self::Transition(shape) => {
                if matches!(shape.state, TransitionState::Invalid { .. }) {
                    return false;
                }
                // Le reconnaisseur Debug historique cherchait dans la source et la cible.
                // Conserver exactement cette union, y compris les champs true/false mêlés.
                let mut controls = vec![&shape.source];
                if let TransitionState::OptionTarget { target, .. } = &shape.state {
                    controls.push(target);
                }
                match shape.kind {
                    TransitionKind::Home => {
                        controls.iter().any(|c| c.pause) && controls.iter().any(|c| c.autoplay)
                    }
                    TransitionKind::Ok => {
                        controls.iter().any(|c| c.has_audio)
                            && controls.iter().any(|c| !c.has_image)
                            && controls.iter().any(|c| !c.wheel)
                            && controls.iter().any(|c| c.ok)
                            && controls.iter().any(|c| c.home)
                            && controls.iter().any(|c| !c.pause)
                    }
                }
            }
            _ => false,
        }
    }
}

fn multiset_differences<'a, T: Ord>(
    generated: &'a BTreeMap<T, usize>,
    oracle: &'a BTreeMap<T, usize>,
) -> Vec<&'a T> {
    let mut keys: BTreeSet<&T> = generated.keys().collect();
    keys.extend(oracle.keys());
    keys.into_iter()
        .filter(|key| {
            generated.get(*key).copied().unwrap_or(0) != oracle.get(*key).copied().unwrap_or(0)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct TopologyShape {
    source: ControlShape,
    kind: TransitionKind,
    state: TransitionState,
}

struct TopologySignature {
    shapes: BTreeMap<TopologyShape, usize>,
    invalid_transitions: Vec<String>,
}

fn transition_state(
    stage_name: &str,
    kind: &TransitionKind,
    transition: Option<&Transition>,
    actions: &HashMap<&str, &ActionNode>,
    stages: &HashMap<&str, &StageNode>,
    indexed_router_actions: &BTreeSet<&str>,
) -> Vec<(TransitionState, Option<String>)> {
    let Some(transition) = transition else {
        return vec![(TransitionState::Missing, None)];
    };
    let label = match kind {
        TransitionKind::Ok => "OK",
        TransitionKind::Home => "HOME",
    };
    let Some(action) = actions.get(transition.action_node.as_str()) else {
        return vec![(
            TransitionState::Invalid {
                reason: InvalidTransitionKind::MissingAction,
                selection: transition.selection,
                option_count: None,
            },
            Some(format!(
                "{stage_name} {label} action introuvable '{}'",
                transition.action_node
            )),
        )];
    };
    let option_count = action.options.len();
    // Une sélection aléatoire ne désigne aucun indice : elle ne peut pas être
    // aplatie comme un routeur indexé, elle garde tout son éventail.
    let routed_index = indexed_router_actions
        .contains(transition.action_node.as_str())
        .then(|| transition.selection.fixed_index())
        .flatten();
    let is_indexed_router = routed_index.is_some();
    let mut states = vec![(
        TransitionState::Selected {
            selection: if is_indexed_router {
                OptionSelection::Fixed(0)
            } else {
                transition.selection
            },
            option_count: if is_indexed_router { 1 } else { option_count },
        },
        None,
    )];
    if !transition.selection.is_within_bounds(option_count) {
        states.push((
            TransitionState::Invalid {
                reason: InvalidTransitionKind::OptionOutOfBounds,
                selection: transition.selection,
                option_count: Some(option_count),
            },
            Some(format!(
                "{stage_name} {label} sélection {} hors limites ({} option(s))",
                transition.selection, option_count
            )),
        ));
    }
    if let Some(option_index) = routed_index.filter(|index| *index < option_count) {
        let stage_id = action.option_target(option_index).unwrap_or_default();
        let Some(target) = stages.get(stage_id) else {
            states.push((
                TransitionState::Invalid {
                    reason: InvalidTransitionKind::MissingTargetStage,
                    selection: transition.selection,
                    option_count: Some(option_count),
                },
                Some(format!(
                    "{stage_name} {label} option {option_index} cible stage introuvable '{}'",
                    stage_id
                )),
            ));
            return states;
        };
        states.push((
            TransitionState::OptionTarget {
                target: control_shape(target),
                option_index: 0,
                option_count: 1,
            },
            None,
        ));
        return states;
    }
    for (option_index, option) in action.options.iter().enumerate() {
        let stage_id = option.as_deref().unwrap_or_default();
        let Some(target) = stages.get(stage_id) else {
            states.push((
                TransitionState::Invalid {
                    reason: InvalidTransitionKind::MissingTargetStage,
                    selection: OptionSelection::Fixed(option_index),
                    option_count: Some(option_count),
                },
                Some(format!(
                    "{stage_name} {label} option {option_index} cible stage introuvable '{}'",
                    stage_id
                )),
            ));
            continue;
        };
        states.push((
            TransitionState::OptionTarget {
                target: control_shape(target),
                option_index,
                option_count,
            },
            None,
        ));
    }
    states
}

fn node_shapes(document: &StoryDocument) -> BTreeMap<ControlShape, usize> {
    let mut shapes = BTreeMap::new();
    for stage in &document.stage_nodes {
        *shapes.entry(control_shape(stage)).or_insert(0) += 1;
    }
    shapes
}

fn asset_presence_shapes(document: &StoryDocument) -> BTreeMap<AssetPresenceShape, usize> {
    let mut shapes = BTreeMap::new();
    for stage in &document.stage_nodes {
        *shapes.entry(asset_presence_shape(stage)).or_insert(0) += 1;
    }
    shapes
}

fn indexed_router_actions<'a>(
    document: &'a StoryDocument,
    actions: &HashMap<&'a str, &'a ActionNode>,
    stages: &HashMap<&'a str, &'a StageNode>,
) -> BTreeSet<&'a str> {
    let mut option_indices: HashMap<&str, BTreeSet<usize>> = HashMap::new();
    for stage in &document.stage_nodes {
        if let Some(transition) = stage.ok_transition.value() {
            // `Random` ne désigne pas un indice : il ne fait pas d'une Action un
            // routeur indexé partagé.
            if let Some(index) = transition.selection.fixed_index() {
                option_indices
                    .entry(transition.action_node.as_str())
                    .or_default()
                    .insert(index);
            }
        }
    }

    option_indices
        .into_iter()
        .filter_map(|(action_id, indices)| {
            let action = actions.get(action_id)?;
            let targets_are_non_interactive = action.named_options().all(|stage_id| {
                stages
                    .get(stage_id)
                    .is_some_and(|stage| !stage.control_settings.wheel())
            });
            (indices.len() > 1 && targets_are_non_interactive).then_some(action_id)
        })
        .collect()
}

fn topology_shapes(document: &StoryDocument) -> TopologySignature {
    let actions: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let stages: HashMap<&str, &StageNode> = document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), stage))
        .collect();
    let indexed_router_actions = indexed_router_actions(document, &actions, &stages);

    let mut shapes = BTreeMap::new();
    let mut invalid_transitions = Vec::new();
    for stage in &document.stage_nodes {
        for (kind, transition) in [
            (TransitionKind::Ok, stage.ok_transition.value()),
            (TransitionKind::Home, stage.home_transition.value()),
        ] {
            for (state, invalid) in transition_state(
                stage.label(),
                &kind,
                transition,
                &actions,
                &stages,
                &indexed_router_actions,
            ) {
                if let Some(invalid) = invalid {
                    invalid_transitions.push(invalid);
                }
                let shape = TopologyShape {
                    source: control_shape(stage),
                    kind: kind.clone(),
                    state,
                };
                *shapes.entry(shape).or_insert(0) += 1;
            }
        }
    }
    TopologySignature {
        shapes,
        invalid_transitions,
    }
}

fn compare_multiset<T>(
    label: &str,
    generated: &BTreeMap<T, usize>,
    oracle: &BTreeMap<T, usize>,
) -> Vec<String>
where
    T: std::fmt::Debug + Ord,
{
    let mut gaps = Vec::new();
    let mut keys: BTreeSet<&T> = generated.keys().collect();
    keys.extend(oracle.keys());
    for key in keys {
        let in_generated = generated.get(key).copied().unwrap_or(0);
        let in_oracle = oracle.get(key).copied().unwrap_or(0);
        if in_generated != in_oracle {
            gaps.push(format!(
                "{label} généré={in_generated} oracle={in_oracle} : {key:?}"
            ));
        }
    }
    gaps
}

fn count_multiset_delta<T>(generated: &BTreeMap<T, usize>, oracle: &BTreeMap<T, usize>) -> usize
where
    T: Ord,
{
    let mut keys: BTreeSet<&T> = generated.keys().collect();
    keys.extend(oracle.keys());
    keys.into_iter()
        .map(|key| {
            let in_generated = generated.get(key).copied().unwrap_or(0);
            let in_oracle = oracle.get(key).copied().unwrap_or(0);
            in_generated.abs_diff(in_oracle)
        })
        .sum()
}

fn compare_asset_presence(generated: &StoryDocument, oracle: &StoryDocument) -> Vec<String> {
    compare_multiset(
        "présence asset",
        &asset_presence_shapes(generated),
        &asset_presence_shapes(oracle),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_pack::{
        named_option_targets, CanonicalEntry, CanonicalMenu, CanonicalOptions, CanonicalStory,
        Presence,
    };

    fn story(id: &str, name: &str, audio: &str) -> CanonicalEntry {
        CanonicalEntry::Story(CanonicalStory {
            id: id.to_string(),
            name: name.to_string(),
            audio: Some(audio.to_string()),
            ..Default::default()
        })
    }

    /// Type d'architecture : un menu (carrefour) hébergeant deux histoires. Pleinement
    /// modélisable → génération canonique propre. Pas de `nativeGraph` (l'appelant en
    /// injecte un dans certains tests pour jouer l'oracle).
    fn sample_project() -> CanonicalProject {
        CanonicalProject {
            name: "Juge".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("cover.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions::default(),
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: vec![
                    story("story-a", "Histoire A", "a.mp3"),
                    story("story-b", "Histoire B", "b.mp3"),
                ],
                ..Default::default()
            })],
            shared_entries: Vec::new(),
        }
    }

    fn wrap_oracle(document: &StoryDocument) -> serde_json::Value {
        serde_json::json!({
            "preserveForRoundTrip": true,
            "document": serde_json::to_value(document).expect("serialize oracle"),
        })
    }

    fn first_stage_with_ok(document: &mut StoryDocument) -> &mut StageNode {
        document
            .stage_nodes
            .iter_mut()
            .find(|stage| stage.ok_transition.is_value())
            .expect("stage with ok transition")
    }

    fn first_stage_with_home(document: &mut StoryDocument) -> &mut StageNode {
        document
            .stage_nodes
            .iter_mut()
            .find(|stage| stage.home_transition.is_value())
            .expect("stage with home transition")
    }

    fn judge_against_oracle(project: &CanonicalProject, oracle: StoryDocument) -> FidelityReport {
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));
        canonical_roundtrip_is_faithful(&with_oracle).expect("judge runs")
    }

    /// Fidèle : l'oracle EST la génération canonique du même arbre. Le juge régénère
    /// (UUIDs frais, donc différents de l'oracle) et compare : même structure → fidèle.
    /// Prouve du même coup que la comparaison est UUID-agnostique.
    #[test]
    fn judge_passes_when_native_graph_matches_canonical_build() {
        let project = sample_project();
        let oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));

        let report = canonical_roundtrip_is_faithful(&with_oracle).expect("judge runs");
        assert!(report.faithful, "écarts inattendus : {:?}", report.gaps);
        assert!(report.gaps.is_empty());
        assert_eq!(report.generated_stage_count, report.oracle_stage_count);
        assert_eq!(report.invalid_transition_count, 0);
        assert_eq!(report.asset_presence_gap_count, 0);
    }

    #[test]
    fn indexed_non_interactive_router_is_behaviorally_equivalent_to_direct_transitions() {
        let generated: StoryDocument = serde_json::from_value(serde_json::json!({
            "title": "Generated",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "actionNodes": [
                { "id": "entry", "name": "Entry", "options": ["source-a", "source-b"], "position": { "x": 0, "y": 0 } },
                { "id": "direct-a", "name": "A", "options": ["target-a"], "position": { "x": 0, "y": 0 } },
                { "id": "direct-b", "name": "B", "options": ["target-b"], "position": { "x": 0, "y": 0 } }
            ],
            "stageNodes": [
                {
                    "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "entry", "optionIndex": 0 }, "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                },
                {
                    "uuid": "source-a", "name": "Source A", "type": "stage", "squareOne": false,
                    "audio": "a.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "direct-a", "optionIndex": 0 }, "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                },
                {
                    "uuid": "source-b", "name": "Source B", "type": "stage", "squareOne": false,
                    "audio": "b.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": true, "home": false, "pause": false, "autoplay": true },
                    "okTransition": { "actionNode": "direct-b", "optionIndex": 0 }, "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                },
                {
                    "uuid": "target-a", "name": "Target A", "type": "stage", "squareOne": false,
                    "audio": "ta.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                    "okTransition": null, "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                },
                {
                    "uuid": "target-b", "name": "Target B", "type": "stage", "squareOne": false,
                    "audio": "tb.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                    "okTransition": null, "homeTransition": null,
                    "position": { "x": 0, "y": 0 }
                }
            ]
        }))
        .expect("generated document");
        let mut oracle = generated.clone();
        oracle
            .action_nodes
            .retain(|action| action.id != "direct-a" && action.id != "direct-b");
        oracle.action_nodes.push(ActionNode {
            id: "indexed-router".to_string(),
            name: Presence::Value("Indexed router".to_string()),
            options: named_option_targets(vec!["target-a".to_string(), "target-b".to_string()]),
            position: generated.action_nodes[0].position.clone(),
            action_type: Presence::Absent,
            group_id: Presence::Absent,
        });
        for (stage_id, option_index) in [("source-a", 0), ("source-b", 1)] {
            oracle
                .stage_nodes
                .iter_mut()
                .find(|stage| stage.uuid == stage_id)
                .and_then(|stage| stage.ok_transition.value_mut())
                .expect("source transition")
                .clone_from(&Transition::fixed("indexed-router", option_index));
        }

        let report = compare_documents_structural(&generated, &oracle);
        assert!(report.faithful, "écarts inattendus : {:?}", report.gaps);
    }

    /// Non fidèle : l'oracle porte une structure que l'arbre ne reproduit plus (édition
    /// de structure perdue / import lossy) — modélisée ici par un stage supplémentaire.
    /// Le juge doit la signaler. C'est exactement la « perte silencieuse » à éliminer.
    #[test]
    fn judge_flags_structure_absent_from_the_tree() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let extra = oracle.stage_nodes[0].clone();
        oracle.stage_nodes.push(extra);
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));

        let report = canonical_roundtrip_is_faithful(&with_oracle).expect("judge runs");
        assert!(
            !report.faithful,
            "le juge aurait dû détecter le nœud en trop"
        );
        assert!(!report.gaps.is_empty());
        assert_eq!(
            report.oracle_stage_count,
            report.generated_stage_count + 1,
            "l'oracle a un stage de plus que la génération canonique",
        );
    }

    /// Pleinement modélisé (aucun parachute) : l'arbre est la source de vérité, donc
    /// fidèle dès qu'il génère un document valide. Aucun oracle à comparer.
    #[test]
    fn judge_passes_for_fully_modeled_pack_without_native_graph() {
        let project = sample_project();
        let report = canonical_roundtrip_is_faithful(&project).expect("judge runs");
        assert!(report.faithful);
        assert_eq!(report.oracle_stage_count, 0);
        assert!(report.generated_stage_count > 0);
    }

    /// Génération impossible (dossier sans aucun choix jouable → échec bloquant de
    /// `build_menu_branch`) : verdict « non fidèle », pas une erreur du juge.
    #[test]
    fn judge_reports_unfaithful_when_canonical_build_fails() {
        let project = CanonicalProject {
            name: "Dossier vide".to_string(),
            project_type: "pack".to_string(),
            pack_version: 1,
            pack_description: String::new(),
            root_audio: Some("root.mp3".to_string()),
            root_image: Some("cover.png".to_string()),
            thumbnail_image: None,
            night_mode_audio: None,
            night_mode_return: None,
            night_mode_home_return: None,
            native_graph: None,
            options: CanonicalOptions::default(),
            entries: vec![CanonicalEntry::Menu(CanonicalMenu {
                id: "carrefour".to_string(),
                name: "Carrefour".to_string(),
                audio: Some("menu.mp3".to_string()),
                image: Some("menu.png".to_string()),
                children: Vec::new(),
                ..Default::default()
            })],

            shared_entries: Vec::new(),
        };

        let report = canonical_roundtrip_is_faithful(&project).expect("judge runs");
        assert!(!report.faithful);
        assert!(
            report
                .gaps
                .iter()
                .any(|gap| gap.contains("génération canonique")),
            "le verdict doit mentionner l'échec de génération : {:?}",
            report.gaps,
        );
    }

    #[test]
    fn judge_flags_missing_ok_transition() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        first_stage_with_ok(&mut oracle).ok_transition = Presence::Null;

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(
            report
                .topology_gaps
                .iter()
                .any(|gap| gap.contains("transition")),
            "écart de topologie attendu : {:?}",
            report.topology_gaps,
        );
    }

    #[test]
    fn judge_flags_missing_home_transition() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        first_stage_with_home(&mut oracle).home_transition = Presence::Null;

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(
            report
                .topology_gaps
                .iter()
                .any(|gap| gap.contains("HOME") || gap.contains("transition")),
            "écart HOME attendu : {:?}",
            report.topology_gaps,
        );
    }

    #[test]
    fn judge_flags_different_option_index() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let stage = oracle
            .stage_nodes
            .iter_mut()
            .find(|stage| {
                stage.ok_transition.value().is_some_and(|transition| {
                    oracle
                        .action_nodes
                        .iter()
                        .find(|action| action.id == transition.action_node)
                        .map(|action| action.options.len() > 1)
                        .unwrap_or(false)
                })
            })
            .expect("stage with multi-option ok");
        stage
            .ok_transition
            .value_mut()
            .expect("ok transition")
            .selection = OptionSelection::Fixed(1);

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(
            report
                .topology_gaps
                .iter()
                .any(|gap| gap.contains("selection: Fixed(1)")),
            "écart de sélection attendu : {:?}",
            report.topology_gaps,
        );
    }

    #[test]
    fn judge_flags_non_current_choice_option_target_gap() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let replacement_stage_id = oracle
            .stage_nodes
            .iter()
            .find(|stage| stage.is_square_one())
            .expect("squareOne stage")
            .uuid
            .clone();
        let action_id = oracle
            .stage_nodes
            .iter()
            .filter_map(|stage| stage.ok_transition.value())
            .find(|transition| {
                oracle
                    .action_nodes
                    .iter()
                    .find(|action| action.id == transition.action_node)
                    .map(|action| action.options.len() > 1)
                    .unwrap_or(false)
            })
            .expect("multi-option transition")
            .action_node
            .clone();
        let action = oracle
            .action_nodes
            .iter_mut()
            .find(|action| action.id == action_id)
            .expect("multi-option action");
        assert!(
            action.options.len() > 1,
            "le test doit modifier une option non courante"
        );
        action.options[1] = Some(replacement_stage_id);

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(
            report.topology_gaps.iter().any(|gap| {
                gap.contains("OptionTarget")
                    && gap.contains("option_index: 1")
                    && gap.contains("square_one: true")
            }),
            "écart d'option non courante attendu : {:?}",
            report.topology_gaps,
        );
    }

    #[test]
    fn judge_counts_missing_action_as_invalid_transition() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let action_id = first_stage_with_ok(&mut oracle)
            .ok_transition
            .value()
            .expect("ok transition")
            .action_node
            .clone();
        oracle.action_nodes.retain(|action| action.id != action_id);

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(report.invalid_transition_count > 0);
        assert!(
            report
                .topology_gaps
                .iter()
                .any(|gap| gap.contains("action introuvable")),
            "transition invalide attendue : {:?}",
            report.topology_gaps,
        );
    }

    #[test]
    fn judge_flags_audio_image_presence_gaps() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let stage = oracle
            .stage_nodes
            .iter_mut()
            .find(|stage| stage.audio.is_value())
            .expect("stage with audio");
        stage.audio = Presence::Null;

        let report = judge_against_oracle(&project, oracle);

        assert!(!report.faithful);
        assert!(report.asset_presence_gap_count > 0);
        assert!(
            !report.asset_presence_gaps.is_empty(),
            "écart de présence asset attendu",
        );
    }

    #[test]
    fn normal_generation_uses_canonical_when_native_graph_is_faithful() {
        let project = sample_project();
        let oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));
        let report = fidelity_report_for(with_oracle.clone(), placeholder_assets(&with_oracle));

        let generated = crate::native_pack::build_story_document(&report)
            .expect("faithful nativeGraph should generate canonically");

        assert_eq!(generated.stage_nodes.len(), oracle.stage_nodes.len());
    }

    #[test]
    fn normal_generation_blocks_unfaithful_native_graph() {
        let project = sample_project();
        let mut oracle = canonical_document_for_fidelity(&project).expect("oracle builds");
        oracle.stage_nodes.push(oracle.stage_nodes[0].clone());
        let mut with_oracle = project.clone();
        with_oracle.native_graph = Some(wrap_oracle(&oracle));
        let report = fidelity_report_for(with_oracle.clone(), placeholder_assets(&with_oracle));

        let error = crate::native_pack::build_story_document(&report)
            .expect_err("unfaithful nativeGraph must be blocked");

        assert!(
            crate::support::user_message::contains_code(
                &error,
                "EXPORT_CANONICAL_GRAPH_DIVERGENCE_DETAIL"
            ),
            "diagnostic inattendu : {error}",
        );
    }

    /// Deux documents qui ne diffèrent que par `Random` / `Fixed(0)`
    /// ne doivent pas devenir équivalents pour le juge maintenant que `-1` n'est
    /// plus classé invalide. C'est le contrôle négatif du retrait de
    /// `NegativeOptionIndex`.
    #[test]
    fn judge_separates_a_random_selection_from_a_fixed_zero() {
        let fixed: StoryDocument = serde_json::from_value(serde_json::json!({
            "title": "Random", "version": 1, "description": "", "format": "v1",
            "nightModeAvailable": false,
            "actionNodes": [
                { "id": "choice", "name": "Choice", "options": ["left", "right"],
                  "position": { "x": 0, "y": 0 } }
            ],
            "stageNodes": [
                { "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                  "audio": "root.mp3", "image": null,
                  "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                  "okTransition": { "actionNode": "choice", "optionIndex": 0 }, "homeTransition": null,
                  "position": { "x": 0, "y": 0 } },
                { "uuid": "left", "name": "Left", "type": "stage", "squareOne": false,
                  "audio": "l.mp3", "image": null,
                  "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                  "okTransition": null, "homeTransition": null, "position": { "x": 0, "y": 0 } },
                { "uuid": "right", "name": "Right", "type": "stage", "squareOne": false,
                  "audio": "r.mp3", "image": null,
                  "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                  "okTransition": null, "homeTransition": null, "position": { "x": 0, "y": 0 } }
            ]
        }))
        .expect("document fixe");

        let mut random = fixed.clone();
        random.stage_nodes[0]
            .ok_transition
            .value_mut()
            .expect("transition OK")
            .selection = OptionSelection::Random;

        // Chacun est fidèle à lui-même : la comparaison n'est pas devenue
        // aveugle, elle distingue seulement les deux sélections.
        assert!(compare_documents_structural(&random, &random).faithful);
        assert!(compare_documents_structural(&fixed, &fixed).faithful);

        let report = compare_documents_structural(&random, &fixed);
        assert!(
            !report.faithful,
            "Random et Fixed(0) ne doivent pas être équivalents : {:?}",
            report.gaps
        );
        // Et surtout : aucun des deux n'est classé « invalide » au passage.
        assert_eq!(report.invalid_transition_count, 0, "{:?}", report.gaps);
    }

    /// La sentinelle reste une sélection valide sur les deux ports, y compris
    /// quand le Stage est une roue ou un stage d'autoplay. Le test E2E de
    /// référence couvre HOME ; ici on garde l'absence de classement « invalide ».
    #[test]
    fn judge_accepts_random_on_ok_and_home_for_wheel_and_autoplay_stages() {
        for (wheel, autoplay) in [(true, false), (false, true)] {
            let document: StoryDocument = serde_json::from_value(serde_json::json!({
                "title": "Random", "version": 1, "description": "", "format": "v1",
                "nightModeAvailable": false,
                "actionNodes": [
                    { "id": "choice", "name": "Choice", "options": ["left", "right"],
                      "position": { "x": 0, "y": 0 } }
                ],
                "stageNodes": [
                    { "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                      "audio": "root.mp3", "image": null,
                      "controlSettings": { "wheel": wheel, "ok": true, "home": true, "pause": false, "autoplay": autoplay },
                      "okTransition": { "actionNode": "choice", "optionIndex": -1 },
                      "homeTransition": { "actionNode": "choice", "optionIndex": -1 },
                      "position": { "x": 0, "y": 0 } },
                    { "uuid": "left", "name": "Left", "type": "stage", "squareOne": false,
                      "audio": "l.mp3", "image": null,
                      "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                      "okTransition": null, "homeTransition": null, "position": { "x": 0, "y": 0 } },
                    { "uuid": "right", "name": "Right", "type": "stage", "squareOne": false,
                      "audio": "r.mp3", "image": null,
                      "controlSettings": { "wheel": false, "ok": false, "home": false, "pause": true, "autoplay": true },
                      "okTransition": null, "homeTransition": null, "position": { "x": 0, "y": 0 } }
                ]
            }))
            .expect("document aléatoire");

            let report = compare_documents_structural(&document, &document);
            assert!(report.faithful, "{:?}", report.gaps);
            assert_eq!(
                report.invalid_transition_count, 0,
                "`-1` ne doit plus être classé invalide (wheel={wheel}, autoplay={autoplay})"
            );
        }
    }

    /// `Random` sur une Action sans option reste bloquant : c'est
    /// `OptionSelectionInvalid`, et le juge le voit aussi comme une transition
    /// invalide.
    #[test]
    fn judge_still_flags_a_random_selection_on_an_empty_action() {
        let document: StoryDocument = serde_json::from_value(serde_json::json!({
            "title": "Random", "version": 1, "description": "", "format": "v1",
            "nightModeAvailable": false,
            "actionNodes": [
                { "id": "empty", "name": "Empty", "options": [], "position": { "x": 0, "y": 0 } }
            ],
            "stageNodes": [
                { "uuid": "root", "name": "Root", "type": "stage", "squareOne": true,
                  "audio": "root.mp3", "image": null,
                  "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                  "okTransition": { "actionNode": "empty", "optionIndex": -1 }, "homeTransition": null,
                  "position": { "x": 0, "y": 0 } }
            ]
        }))
        .expect("document aléatoire vide");

        let report = compare_documents_structural(&document, &document);
        assert!(!report.faithful);
        assert!(report.invalid_transition_count > 0);
    }
}

#[cfg(test)]
pub(crate) fn test_end_gap(home: bool) -> TopologyGapKind {
    TopologyGapKind::Transition(TopologyShape {
        source: ControlShape {
            square_one: false,
            has_audio: true,
            has_image: false,
            wheel: false,
            ok: !home,
            home: true,
            pause: home,
            autoplay: home,
        },
        kind: if home {
            TransitionKind::Home
        } else {
            TransitionKind::Ok
        },
        state: TransitionState::Missing,
    })
}

#[cfg(test)]
mod tolerance_contract_tests {
    use super::*;
    #[test]
    fn typed_tolerance_matches_every_historical_debug_motif() {
        // Toutes les formes booléennes, les deux ports, la source seule ou avec
        // cible, et chaque classe d’état dont Invalid : ancien reconnaisseur comme oracle.
        let controls: Vec<_> = (0..256)
            .map(|n| ControlShape {
                square_one: n & 1 != 0,
                has_audio: n & 2 != 0,
                has_image: n & 4 != 0,
                wheel: n & 8 != 0,
                ok: n & 16 != 0,
                home: n & 32 != 0,
                pause: n & 64 != 0,
                autoplay: n & 128 != 0,
            })
            .collect();
        for source in &controls {
            for target in &controls {
                for kind in [TransitionKind::Ok, TransitionKind::Home] {
                    for state in [
                        TransitionState::Missing,
                        TransitionState::Selected {
                            selection: OptionSelection::Fixed(0),
                            option_count: 1,
                        },
                        TransitionState::OptionTarget {
                            target: target.clone(),
                            option_index: 0,
                            option_count: 1,
                        },
                        TransitionState::Invalid {
                            reason: InvalidTransitionKind::MissingAction,
                            selection: OptionSelection::Fixed(0),
                            option_count: None,
                        },
                    ] {
                        let shape = TopologyShape {
                            source: source.clone(),
                            kind: kind.clone(),
                            state,
                        };
                        let text = format!("transition généré=1 oracle=0 : {shape:?}");
                        let old = !text.contains("Invalid")
                            && ((text.contains("kind: Home")
                                && text.contains("pause: true")
                                && text.contains("autoplay: true"))
                                || (text.contains("kind: Ok")
                                    && text.contains("has_audio: true")
                                    && text.contains("has_image: false")
                                    && text.contains("wheel: false")
                                    && text.contains("ok: true")
                                    && text.contains("home: true")
                                    && text.contains("pause: false")));
                        assert_eq!(
                            TopologyGapKind::Transition(shape).is_end_home_or_night(),
                            old,
                            "{text}"
                        );
                    }
                }
            }
        }
        assert!(TopologyGapKind::NightMode.is_end_home_or_night());
        for gap in [
            TopologyGapKind::Other,
            TopologyGapKind::MissingEntry,
            TopologyGapKind::InvalidTransition,
        ] {
            assert!(!gap.is_end_home_or_night());
        }
        for gap in [
            TopologyGapKind::NightMode,
            TopologyGapKind::MissingEntry,
            TopologyGapKind::InvalidTransition,
        ] {
            assert!(gap.blocks_aggregate_tolerance());
        }
        assert!(!TopologyGapKind::Other.blocks_aggregate_tolerance());
    }
}
