//! L'observation d'un payload d'auteur, ligne de la matrice par ligne de la matrice.
//!
//! Ce module ne décide d'aucune politique : il constate ce que le document
//! exhibe, et rattache chaque constat à la ligne de la matrice qui le qualifie
//! déjà. La qualification elle-même vient du catalogue, jamais d'ici.
//!
//! Trois issues, et trois seulement, pour une ligne d'interopérabilité :
//!
//! - le document exhibe le construct et le payload permet de l'observer →
//!   `EvidenceRef` sur cette ligne ;
//! - le construct est pertinent mais inobservable → `unevaluated` ;
//! - la ligne ne s'applique pas à ce document → **rien**. Une ligne
//!   inapplicable n'est pas une dimension non observable, et la confondre
//!   avec elle dégraderait chaque agrégat sans raison.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use super::super::authoring::{
    diagnose_enriched_metadata, position_is_fractional, position_is_out_of_short_range,
    value_origin,
};
use super::super::{
    classify_stage_id, stable_node_paths, validate_graph_document_integrity, DecodedStoryDocument,
    OpaqueMemberKind, OptionSelection, PackIdentityOrigin, Position, StageNode, StoryDecodeError,
    StoryDocument, Transition, ValueOrigin,
};
use super::contract::{ContractLine, DimensionId, LineTreatment};
use super::{
    DimensionAssessment, DimensionQualification, EvidenceRef, ReadinessDiagnostic,
    ReadinessDiagnosticLevel, ReadinessObservation, UnevaluatedDimension,
};

/// Le code du diagnostic de doublon racine produit par le décodeur de dialecte.
const DUPLICATE_ROOT_KEY: &str = "duplicate-root-key-last-wins";

type Observed = (
    Vec<DimensionAssessment>,
    Vec<UnevaluatedDimension>,
    Vec<ReadinessDiagnostic>,
);

/// Qualifie un payload décodé.
pub(super) fn observe(payload: &DecodedStoryDocument) -> Observed {
    let mut diagnostics: Vec<ReadinessDiagnostic> = payload
        .context
        .diagnostics
        .iter()
        .cloned()
        .map(ReadinessDiagnostic::Decode)
        .collect();
    diagnostics.extend(
        diagnose_enriched_metadata(payload)
            .into_iter()
            .map(ReadinessDiagnostic::Authoring),
    );

    // L'agrégat commence par « décodage plus GVI », et pour cause :
    // les prédicats de la matrice portent sur un graphe qui tient. Sur une référence
    // pendante ou un `squareOne` ambigu, « convergence SUPPORTED » ne serait pas
    // une qualification prudente, ce serait une qualification fausse. Toute la
    // matrice part donc en `unevaluated`, et l'agrégat reste `UNTESTED`.
    if let Err(errors) = validate_graph_document_integrity(&payload.document) {
        let reason = format!(
            "Intégrité de graphe invalide ({}) : aucune règle de préparation n'est observable sur un graphe dont les références ne résolvent pas.",
            errors
                .iter()
                .map(|error| error.code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        diagnostics.extend(errors.into_iter().map(ReadinessDiagnostic::GraphIntegrity));
        return (
            Vec::new(),
            every_dimension_unevaluated(&reason),
            diagnostics,
        );
    }

    let graph = Graph::new(&payload.document);
    let mut observations = Observations::default();

    observe_topology(&graph, &mut observations);
    observe_selections(&graph, &mut observations);
    observe_wheel_widths(&graph, &mut observations);
    observe_media_omissions(&graph, &mut observations);
    observe_reachability_and_controls(&graph, &mut observations);
    observe_identifiers(&graph, &mut observations);
    observe_pack_identity(payload, &mut observations);
    observe_root_fields(payload, &graph, &mut observations, &mut diagnostics);
    observe_known_omissions(&graph, &mut observations);
    observe_positions(payload, &graph, &mut observations);
    observe_enriched_markers(&graph, &mut observations);
    observe_extensions(payload, &mut observations);
    observe_root_duplicates(payload, &mut observations);

    let (dimensions, unevaluated) = observations.finish();
    (dimensions, unevaluated, diagnostics)
}

/// Qualifie un document refusé au décodage.
///
/// Rien n'a été représenté : aucune dimension n'est évaluable, et les
/// diagnostics de décodage restent disponibles avec leur provenance pour
/// expliquer le blocage sans inventer de qualification.
pub(super) fn observe_rejected(error: &StoryDecodeError) -> Observed {
    let reason = format!(
        "Document refusé au décodage ({}) : aucune représentation n'existe à qualifier.",
        error
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    (
        Vec::new(),
        every_dimension_unevaluated(&reason),
        error
            .diagnostics
            .iter()
            .cloned()
            .map(ReadinessDiagnostic::Decode)
            .collect(),
    )
}

fn every_dimension_unevaluated(reason: &str) -> Vec<UnevaluatedDimension> {
    DimensionId::ALL
        .into_iter()
        .map(|id| UnevaluatedDimension {
            id,
            lines: id.lines().collect(),
            reason: reason.to_string(),
        })
        .collect()
}

/// Le collecteur de preuves. Il refuse par construction d'enregistrer une
/// preuve sur une ligne qui n'est pas une ligne de dimension, et prend la
/// qualification dans le catalogue plutôt que chez l'appelant.
#[derive(Default)]
struct Observations {
    evidence: BTreeMap<DimensionId, Vec<EvidenceRef>>,
    unevaluated: BTreeMap<DimensionId, String>,
}

impl Observations {
    fn record(
        &mut self,
        line: ContractLine,
        path: impl Into<String>,
        observation: impl Into<String>,
    ) {
        let LineTreatment::Dimension { id } = line.treatment() else {
            debug_assert!(false, "ligne {} sans dimension", line.row());
            return;
        };
        let Some(qualification) = line.contract_qualification() else {
            debug_assert!(false, "ligne {} sans qualification", line.row());
            return;
        };
        self.evidence.entry(id).or_default().push(EvidenceRef::new(
            line,
            qualification,
            path,
            observation,
        ));
    }

    fn defer(&mut self, id: DimensionId, reason: impl Into<String>) {
        self.unevaluated.entry(id).or_insert_with(|| reason.into());
    }

    fn finish(self) -> (Vec<DimensionAssessment>, Vec<UnevaluatedDimension>) {
        let dimensions = self
            .evidence
            .into_iter()
            .filter(|(id, _)| !self.unevaluated.contains_key(id))
            .map(|(id, evidence)| DimensionAssessment {
                // La qualification d'une dimension est la plus faible de ses
                // preuves : elle ne peut pas dépasser ce que ses lignes disent.
                qualification: evidence
                    .iter()
                    .map(|reference| reference.qualification)
                    .min()
                    .unwrap_or(DimensionQualification::Untested),
                id,
                evidence,
            })
            .collect();
        let unevaluated = self
            .unevaluated
            .into_iter()
            .map(|(id, reason)| UnevaluatedDimension {
                id,
                lines: id.lines().collect(),
                reason,
            })
            .collect();
        (dimensions, unevaluated)
    }
}

/// Index de lecture d'un document dont GVI a déjà garanti la cohérence :
/// identifiants uniques, références résolues, `squareOne` unique.
struct Graph<'a> {
    document: &'a StoryDocument,
    stage_paths: Vec<String>,
    action_paths: Vec<String>,
    stage_index: HashMap<&'a str, usize>,
    action_index: HashMap<&'a str, usize>,
    entry_index: usize,
}

impl<'a> Graph<'a> {
    fn new(document: &'a StoryDocument) -> Self {
        Self {
            stage_paths: stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
                stage.uuid.as_str()
            }),
            action_paths: stable_node_paths(
                &document.action_nodes,
                "actionNodes",
                "id",
                |action| action.id.as_str(),
            ),
            stage_index: document
                .stage_nodes
                .iter()
                .enumerate()
                .map(|(index, stage)| (stage.uuid.as_str(), index))
                .collect(),
            action_index: document
                .action_nodes
                .iter()
                .enumerate()
                .map(|(index, action)| (action.id.as_str(), index))
                .collect(),
            entry_index: document
                .stage_nodes
                .iter()
                .position(StageNode::is_square_one)
                .expect("GVI garantit un squareOne unique"),
            document,
        }
    }

    /// Les transitions déclarées, avec le Stage porteur et le port concerné.
    fn transitions(&self) -> impl Iterator<Item = (usize, &'static str, &'a Transition)> {
        self.document
            .stage_nodes
            .iter()
            .enumerate()
            .flat_map(|(index, stage)| {
                [
                    ("okTransition", &stage.ok_transition),
                    ("homeTransition", &stage.home_transition),
                ]
                .into_iter()
                .filter_map(move |(port, transition)| {
                    transition
                        .value()
                        .map(|transition| (index, port, transition))
                })
            })
    }

    /// Les Stages qu'une transition peut désigner. `Random` les désigne tous.
    fn targets(&self, transition: &Transition) -> Vec<&'a str> {
        let action =
            &self.document.action_nodes[self.action_index[transition.action_node.as_str()]];
        transition
            .selection
            .candidate_indices(action.options.len())
            .filter_map(|index| action.option_target(index))
            .collect()
    }

    fn stage_path(&self, index: usize) -> &str {
        &self.stage_paths[index]
    }

    fn action_path(&self, id: &str) -> &str {
        &self.action_paths[self.action_index[id]]
    }
}

/// Ligne 1 — cycle, self-loops, convergence, Action partagé, HOME==OK.
fn observe_topology(graph: &Graph<'_>, observations: &mut Observations) {
    let mut constructs: Vec<String> = Vec::new();
    let mut anchor: Option<String> = None;
    let mut note = |label: String, path: &str, anchor: &mut Option<String>| {
        anchor.get_or_insert_with(|| path.to_string());
        constructs.push(label);
    };

    let self_loop = graph.transitions().find(|(index, _, transition)| {
        let uuid = graph.document.stage_nodes[*index].uuid.as_str();
        graph.targets(transition).contains(&uuid)
    });
    if let Some((index, port, _)) = self_loop {
        note(
            format!("self-loop sur {port}"),
            graph.stage_path(index),
            &mut anchor,
        );
    }

    let mut incoming: HashMap<&str, usize> = HashMap::new();
    for action in &graph.document.action_nodes {
        for target in action.named_options() {
            *incoming.entry(target).or_default() += 1;
        }
    }
    if let Some(target) = incoming
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(target, _)| *target)
        .min()
    {
        note(
            "convergence".to_string(),
            graph.stage_path(graph.stage_index[target]),
            &mut anchor,
        );
    }

    let mut references: HashMap<&str, usize> = HashMap::new();
    for (_, _, transition) in graph.transitions() {
        *references
            .entry(transition.action_node.as_str())
            .or_default() += 1;
    }
    if let Some(action) = references
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(action, _)| *action)
        .min()
    {
        note(
            "ActionNode partagé".to_string(),
            graph.action_path(action),
            &mut anchor,
        );
    }

    let home_equals_ok = graph
        .document
        .stage_nodes
        .iter()
        .enumerate()
        .find(
            |(_, stage)| match (stage.ok_transition.value(), stage.home_transition.value()) {
                (Some(ok), Some(home)) => ok == home || graph.targets(ok) == graph.targets(home),
                _ => false,
            },
        );
    if let Some((index, _)) = home_equals_ok {
        note("HOME==OK".to_string(), graph.stage_path(index), &mut anchor);
    }

    if let Some(index) = find_cycle(graph) {
        note("cycle".to_string(), graph.stage_path(index), &mut anchor);
    }

    if let Some(anchor) = anchor {
        observations.record(
            ContractLine::GraphTopology,
            anchor,
            format!("Topologies observées : {}.", constructs.join(", ")),
        );
    }
}

/// Le premier Stage par lequel un cycle se referme, s'il en existe un.
fn find_cycle(graph: &Graph<'_>) -> Option<usize> {
    let mut state = vec![0u8; graph.document.stage_nodes.len()];
    let mut stack = Vec::new();
    for start in 0..graph.document.stage_nodes.len() {
        if state[start] != 0 {
            continue;
        }
        stack.push((start, 0usize));
        state[start] = 1;
        while let Some((index, cursor)) = stack.pop() {
            let successors = stage_successors(graph, index);
            if cursor < successors.len() {
                stack.push((index, cursor + 1));
                let next = successors[cursor];
                match state[next] {
                    0 => {
                        state[next] = 1;
                        stack.push((next, 0));
                    }
                    1 => return Some(next),
                    _ => {}
                }
            } else {
                state[index] = 2;
            }
        }
    }
    None
}

fn stage_successors(graph: &Graph<'_>, index: usize) -> Vec<usize> {
    let stage = &graph.document.stage_nodes[index];
    [&stage.ok_transition, &stage.home_transition]
        .into_iter()
        .filter_map(|transition| transition.value())
        .flat_map(|transition| graph.targets(transition))
        .map(|target| graph.stage_index[target])
        .collect()
}

/// Lignes 2 et 3 — `Fixed(i)` in-bounds et `Random=-1` sur OK / HOME.
fn observe_selections(graph: &Graph<'_>, observations: &mut Observations) {
    let mut fixed: Option<(String, usize)> = None;
    let mut random_ports: Vec<&'static str> = Vec::new();
    let mut random_anchor: Option<String> = None;
    let mut random_count = 0usize;

    for (index, port, transition) in graph.transitions() {
        match transition.selection {
            OptionSelection::Fixed(_) => {
                let entry = fixed.get_or_insert_with(|| (graph.stage_path(index).to_string(), 0));
                entry.1 += 1;
            }
            OptionSelection::Random => {
                random_anchor.get_or_insert_with(|| graph.stage_path(index).to_string());
                random_count += 1;
                if !random_ports.contains(&port) {
                    random_ports.push(port);
                }
            }
        }
    }

    if let Some((path, count)) = fixed {
        observations.record(
            ContractLine::OrderedWheelFixedSelection,
            path,
            format!("{count} sélection(s) Fixed(i) dans les bornes de leur roue ordonnée."),
        );
    }
    if let Some(path) = random_anchor {
        observations.record(
            ContractLine::RandomSelection,
            path,
            format!(
                "{random_count} sélection(s) Random sur {}.",
                random_ports.join(" et ")
            ),
        );
    }
}

/// Lignes 7 et 8 — largeur de roue mesurée jusqu'à 100, au-delà non mesurée.
fn observe_wheel_widths(graph: &Graph<'_>, observations: &mut Observations) {
    const MEASURED_WIDTH: usize = 100;
    let mut measured: Option<(String, usize, usize)> = None;
    let mut beyond: Option<(String, usize, usize)> = None;

    for (action, path) in graph.document.action_nodes.iter().zip(&graph.action_paths) {
        let width = action.options.len();
        if width < 2 {
            continue;
        }
        let slot = if width <= MEASURED_WIDTH {
            &mut measured
        } else {
            &mut beyond
        };
        let entry = slot.get_or_insert_with(|| (path.clone(), 0, 0));
        entry.1 += 1;
        entry.2 = entry.2.max(width);
    }

    if let Some((path, count, widest)) = measured {
        observations.record(
            ContractLine::WheelUpToOneHundred,
            path,
            format!(
                "{count} roue(s) d'au plus {MEASURED_WIDTH} options, la plus large à {widest}."
            ),
        );
    }
    if let Some((path, count, widest)) = beyond {
        observations.record(
            ContractLine::WheelBeyondOneHundred,
            path,
            format!(
                "{count} roue(s) au-delà de {MEASURED_WIDTH} options, la plus large à {widest} : aucune capacité démontrée, sans blocage pour autant."
            ),
        );
    }
}

/// Ligne 9 — Stage sans image/audio, clés standard `null`.
fn observe_media_omissions(graph: &Graph<'_>, observations: &mut Observations) {
    let mut anchor: Option<String> = None;
    let mut count = 0usize;
    for (stage, path) in graph.document.stage_nodes.iter().zip(&graph.stage_paths) {
        if stage.audio.has_no_value() || stage.image.has_no_value() {
            anchor.get_or_insert_with(|| path.clone());
            count += 1;
        }
    }
    if let Some(path) = anchor {
        observations.record(
            ContractLine::StageWithoutMedia,
            path,
            format!("{count} Stage(s) sans audio et/ou sans image."),
        );
    }
}

/// Ligne 10 — composante inatteignable, profils de contrôle, contrôle
/// désactivé portant tout de même une transition.
fn observe_reachability_and_controls(graph: &Graph<'_>, observations: &mut Observations) {
    let mut constructs: Vec<String> = Vec::new();
    let mut anchor: Option<String> = None;

    let reachable = reachable_stages(graph);
    let unreachable =
        (0..graph.document.stage_nodes.len()).find(|index| !reachable.contains(index));
    if let Some(index) = unreachable {
        anchor.get_or_insert_with(|| graph.stage_path(index).to_string());
        constructs.push(format!(
            "{} composante(s) inatteignable(s) depuis squareOne",
            graph.document.stage_nodes.len() - reachable.len()
        ));
    }

    let profiles = graph
        .document
        .stage_nodes
        .iter()
        .zip(&graph.stage_paths)
        .filter(|(stage, _)| stage.control_settings.is_complete())
        .count();
    if profiles > 0 {
        if let Some((_, path)) = graph
            .document
            .stage_nodes
            .iter()
            .zip(&graph.stage_paths)
            .find(|(stage, _)| stage.control_settings.is_complete())
        {
            anchor.get_or_insert_with(|| path.clone());
        }
        constructs.push(format!("{profiles} profil(s) de contrôle complet(s)"));
    }

    let disabled_with_transition = graph
        .document
        .stage_nodes
        .iter()
        .zip(&graph.stage_paths)
        .find(|(stage, _)| {
            let controls = &stage.control_settings;
            (stage.ok_transition.is_value() && !controls.ok() && !controls.autoplay())
                || (stage.home_transition.is_value() && !controls.home())
        });
    if let Some((_, path)) = disabled_with_transition {
        anchor.get_or_insert_with(|| path.clone());
        constructs.push("contrôle désactivé portant une transition".to_string());
    }

    if let Some(anchor) = anchor {
        observations.record(
            ContractLine::ReachabilityAndControlProfiles,
            anchor,
            format!("Observé : {}.", constructs.join(" ; ")),
        );
    }

    // Ligne 11 — objet de contrôles incomplet conservé à l'entrée.
    let incomplete = graph
        .document
        .stage_nodes
        .iter()
        .zip(&graph.stage_paths)
        .filter(|(stage, _)| !stage.control_settings.is_complete())
        .collect::<Vec<_>>();
    if let Some((_, path)) = incomplete.first() {
        observations.record(
            ContractLine::IncompleteControlSettings,
            format!("{path}/controlSettings"),
            format!(
                "{} objet(s) de contrôles incomplet(s) conservés tels quels ; aucune passerelle figée n'a été mesurée sur cette forme.",
                incomplete.len()
            ),
        );
    }
}

fn reachable_stages(graph: &Graph<'_>) -> HashSet<usize> {
    let mut seen = HashSet::from([graph.entry_index]);
    let mut queue = VecDeque::from([graph.entry_index]);
    while let Some(index) = queue.pop_front() {
        for next in stage_successors(graph, index) {
            if seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen
}

/// Lignes 13 à 16 — graphies des identifiants de Stage et d'Action.
fn observe_identifiers(graph: &Graph<'_>, observations: &mut Observations) {
    let mut canonical: Option<(String, usize)> = None;
    let mut hyphenless: Option<(String, usize)> = None;
    let mut unparsable: Option<(String, usize)> = None;

    for (stage, path) in graph.document.stage_nodes.iter().zip(&graph.stage_paths) {
        let slot = if !classify_stage_id(&stage.uuid).bridge_compatible {
            &mut unparsable
        } else if is_canonical_uuid_graphie(&stage.uuid) {
            &mut canonical
        } else {
            &mut hyphenless
        };
        let entry = slot.get_or_insert_with(|| (path.clone(), 0));
        entry.1 += 1;
    }

    if let Some((path, count)) = canonical {
        observations.record(
            ContractLine::CanonicalStageId,
            path,
            format!("{count} identifiant(s) de Stage en graphie UUID canonique."),
        );
    }
    if let Some((path, count)) = hyphenless {
        observations.record(
            ContractLine::HyphenlessStageId,
            path,
            format!(
                "{count} identifiant(s) de Stage parsable(s) hors graphie canonique, conservé(s) sans normalisation."
            ),
        );
    }
    if let Some((path, count)) = unparsable {
        observations.record(
            ContractLine::UnparsableStageId,
            path,
            format!("{count} identifiant(s) de Stage non parsable(s) : remap d'export requis."),
        );
    }

    let mut non_uuid_actions: Option<(String, usize)> = None;
    for (action, path) in graph.document.action_nodes.iter().zip(&graph.action_paths) {
        if is_canonical_uuid_graphie(&action.id) {
            continue;
        }
        let entry = non_uuid_actions.get_or_insert_with(|| (path.clone(), 0));
        entry.1 += 1;
    }
    if let Some((path, count)) = non_uuid_actions {
        observations.record(
            ContractLine::NonUuidActionId,
            path,
            format!("{count} identifiant(s) d'Action non-UUID, résolus par chaîne."),
        );
    }

    // Ligne 17 — `squareOne` ailleurs qu'à l'index 0.
    if graph.entry_index != 0 {
        observations.record(
            ContractLine::SquareOneNotFirst,
            graph.stage_path(graph.entry_index),
            format!(
                "Stage d'entrée à l'index {} : l'export le permute au minimum sur la copie.",
                graph.entry_index
            ),
        );
    }
}

/// La graphie canonique `8-4-4-4-12`, seule surface dominante de la ligne 13 de
/// la matrice. Toute autre graphie acceptée par les deux passerelles relève de
/// la ligne 14, qui impose de préserver l'écriture d'origine.
fn is_canonical_uuid_graphie(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// Ligne 18 — `packIdentity` projetée ou générée, ou identité encore à générer.
fn observe_pack_identity(payload: &DecodedStoryDocument, observations: &mut Observations) {
    let identity = &payload.context.pack_identity;
    match identity.origin {
        PackIdentityOrigin::FsEntryStage => {
            observations.record(
                ContractLine::ProjectedPackIdentity,
                identity.source_path.as_deref().unwrap_or("/"),
                "Identité de pack projetée depuis le dossier d'un pack FS : l'export la porte sur le Stage d'entrée préparé.",
            );
        }
        PackIdentityOrigin::RequiresGeneration => {
            // L'identité stable n'existe pas encore : sa création et sa
            // persistance relèvent du codec de projet. La ligne reste
            // pertinente — un export en a besoin — mais rien ne permet de la
            // qualifier.
            observations.defer(
                DimensionId::PackIdentity,
                identity.unresolved_reason.clone().unwrap_or_else(|| {
                    "Identité de pack non résolue : la portée sur le Stage d'entrée ne peut pas être qualifiée.".to_string()
                }),
            );
        }
        // Identité générée puis persistée par le codec de projet : le Stage
        // d'entrée d'auteur reste inchangé et c'est la copie préparée qui
        // portera cette chaîne. C'est exactement la projection que la ligne 18
        // qualifie `PREPARED`. Aucune autre dimension n'est touchée : résoudre
        // l'identité ne promeut rien et ne rend valide aucun graphe qui ne
        // l'était pas.
        PackIdentityOrigin::Generated => {
            observations.record(
                ContractLine::ProjectedPackIdentity,
                identity.source_path.as_deref().unwrap_or("/"),
                identity.generation_reason.as_ref().map_or_else(
                    || "Identité de pack générée et enregistrée avec le projet.".to_string(),
                    |reason| {
                        format!("Identité de pack générée et enregistrée avec le projet ({reason})")
                    },
                ),
            );
        }
        // Identité lue sur le Stage `squareOne` de la source : ce n'est pas une
        // identité *projetée*, et la ligne 18 ne s'applique pas. La graphie de
        // cet identifiant est déjà qualifiée par les lignes 13 à 15.
        PackIdentityOrigin::SquareOneStage => {}
    }
}

/// Lignes 19, 20 et 26 — champs racine connus.
fn observe_root_fields(
    payload: &DecodedStoryDocument,
    graph: &Graph<'_>,
    observations: &mut Observations,
    diagnostics: &mut Vec<ReadinessDiagnostic>,
) {
    let document = &payload.document;

    if let Some(root_uuid) = document.uuid.as_deref() {
        let identity = payload
            .context
            .pack_identity
            .value
            .as_deref()
            .unwrap_or_else(|| document.stage_nodes[graph.entry_index].uuid.as_str());
        if root_uuid != identity {
            observations.record(
                ContractLine::DivergentRootUuid,
                "/uuid",
                format!(
                    "Racine uuid `{root_uuid}` divergente de l'identité `{identity}` : conservée, non autoritaire."
                ),
            );
            // La colonne « Readiness / fidélité » de la ligne 19 demande cet
            // avertissement de provenance, qu'aucune couche amont ne produit.
            diagnostics.push(ReadinessDiagnostic::Readiness(ReadinessObservation {
                level: ReadinessDiagnosticLevel::Warning,
                code: "ROOT_UUID_DIVERGENT".to_string(),
                path: "/uuid".to_string(),
                message: format!(
                    "La racine uuid `{root_uuid}` ne désigne pas l'identité du pack `{identity}` ; elle est conservée sans faire autorité."
                ),
            }));
        }
    }

    if document.version.value().copied() == Some(256)
        && value_origin(payload, "/version") == ValueOrigin::SourceNativeDerived
    {
        observations.record(
            ContractLine::ProjectedVersion256,
            "/version",
            "version:256 lue en little-endian sur le header natif : provenance établie, export Studio jamais soumis aux passerelles figées.",
        );
    }

    if !document.factory_disabled.is_absent() {
        observations.record(
            ContractLine::FactoryDisabled,
            "/factoryDisabled",
            "factoryDisabled présent et conservé sans interprétation ; les consommateurs figés l'ignorent.",
        );
    }
}

/// Ligne 21 — omissions optionnelles connues.
///
/// `audio` et `image` en sont exclus : ils appartiennent à la ligne 9, et les
/// compter deux fois donnerait une couverture apparente sans preuve nouvelle.
fn observe_known_omissions(graph: &Graph<'_>, observations: &mut Observations) {
    let document = graph.document;
    let mut anchor: Option<String> = None;
    let mut count = 0usize;
    let note = |absent: bool, path: &str, anchor: &mut Option<String>, count: &mut usize| {
        if absent {
            anchor.get_or_insert_with(|| path.to_string());
            *count += 1;
        }
    };

    for (absent, path) in [
        (document.title.is_absent(), "/title"),
        (document.description.is_absent(), "/description"),
        (
            document.night_mode_available.is_absent(),
            "/nightModeAvailable",
        ),
        (document.uuid.is_absent(), "/uuid"),
        (document.factory_disabled.is_absent(), "/factoryDisabled"),
    ] {
        note(absent, path, &mut anchor, &mut count);
    }

    for (stage, path) in document.stage_nodes.iter().zip(&graph.stage_paths) {
        for (absent, field) in [
            (stage.name.is_absent(), "name"),
            (stage.stage_type.is_absent(), "type"),
            (stage.group_id.is_absent(), "groupId"),
            (stage.position.is_absent(), "position"),
        ] {
            note(absent, &format!("{path}/{field}"), &mut anchor, &mut count);
        }
    }
    for (action, path) in document.action_nodes.iter().zip(&graph.action_paths) {
        for (absent, field) in [
            (action.name.is_absent(), "name"),
            (action.action_type.is_absent(), "type"),
            (action.group_id.is_absent(), "groupId"),
            (action.position.is_absent(), "position"),
        ] {
            note(absent, &format!("{path}/{field}"), &mut anchor, &mut count);
        }
    }

    if let Some(path) = anchor {
        observations.record(
            ContractLine::KnownOptionalOmissions,
            path,
            format!("{count} omission(s) optionnelle(s) connue(s), conservées telles quelles."),
        );
    }
}

/// Lignes 22 et 23 — positions fractionnaires et hors `short`.
///
/// Ces lignes restent des observations de qualification interopérable. Elles
/// ne constituent jamais un diagnostic d'erreur ou une décision à demander à
/// l'auteur : les valeurs source restent celles du document. Seule la copie
/// d'export ramène une disposition hors `short` dans l'intervalle, par un
/// facteur unique (`fit_positions_to_short_range`).
fn observe_positions(
    payload: &DecodedStoryDocument,
    graph: &Graph<'_>,
    observations: &mut Observations,
) {
    let mut fractional: Option<(String, usize)> = None;
    let mut out_of_range: Option<(String, usize)> = None;

    for (position, path) in positions(graph) {
        let origin = value_origin(payload, &path);
        let from_source = matches!(
            origin,
            ValueOrigin::SourceStudio | ValueOrigin::SourceNativeDerived
        );
        if from_source && position_is_fractional(position) {
            let entry = fractional.get_or_insert_with(|| (path.clone(), 0));
            entry.1 += 1;
        }
        if origin == ValueOrigin::SourceStudio && position_is_out_of_short_range(position) {
            let entry = out_of_range.get_or_insert_with(|| (path.clone(), 0));
            entry.1 += 1;
        }
    }

    if let Some((path, count)) = fractional {
        observations.record(
            ContractLine::FractionalSourcePosition,
            path,
            format!("{count} position(s) source fractionnaire(s), conservées sans arrondi."),
        );
    }
    if let Some((path, count)) = out_of_range {
        observations.record(
            ContractLine::SourcePositionOutOfShortRange,
            path,
            format!(
                "{count} coordonnée(s) source hors short : l'export réduit toute la disposition pour la ramener dans l'intervalle ; la fidélité de position reste non mesurée."
            ),
        );
    }
}

fn positions<'a>(graph: &'a Graph<'a>) -> Vec<(&'a Position, String)> {
    graph
        .document
        .stage_nodes
        .iter()
        .zip(&graph.stage_paths)
        .filter_map(|(stage, path)| {
            stage
                .position
                .value()
                .map(|position| (position, format!("{path}/position")))
        })
        .chain(
            graph
                .document
                .action_nodes
                .iter()
                .zip(&graph.action_paths)
                .filter_map(|(action, path)| {
                    action
                        .position
                        .value()
                        .map(|position| (position, format!("{path}/position")))
                }),
        )
        .collect()
}

/// Ligne 25 — fidélité des groupes enrichis et d'`Action.type`.
fn observe_enriched_markers(graph: &Graph<'_>, observations: &mut Observations) {
    let mut anchor: Option<String> = None;
    let mut stage_groups = 0usize;
    let mut action_groups = 0usize;
    let mut action_types = 0usize;

    for (stage, path) in graph.document.stage_nodes.iter().zip(&graph.stage_paths) {
        if stage.group_id.is_value() {
            anchor.get_or_insert_with(|| format!("{path}/groupId"));
            stage_groups += 1;
        }
    }
    for (action, path) in graph.document.action_nodes.iter().zip(&graph.action_paths) {
        if action.group_id.is_value() {
            anchor.get_or_insert_with(|| format!("{path}/groupId"));
            action_groups += 1;
        }
        if action.action_type.is_value() {
            anchor.get_or_insert_with(|| format!("{path}/type"));
            action_types += 1;
        }
    }

    if let Some(path) = anchor {
        observations.record(
            ContractLine::EnrichedGroupFidelity,
            path,
            format!(
                "{stage_groups} Stage.groupId, {action_groups} Action.groupId et {action_types} Action.type conservés par l'oracle d'auteur ; leur traitement par les passerelles figées reste non mesuré."
            ),
        );
    }
}

/// Ligne 27 — extensions inconnues, quel que soit le niveau.
fn observe_extensions(payload: &DecodedStoryDocument, observations: &mut Observations) {
    let unknown = payload
        .context
        .opaque_members
        .iter()
        .filter(|member| member.kind == OpaqueMemberKind::UnknownExtension)
        .collect::<Vec<_>>();
    let Some(first) = unknown.first() else {
        return;
    };
    let scopes = {
        let mut scopes = unknown
            .iter()
            .map(|member| format!("{:?}", member.scope))
            .collect::<Vec<_>>();
        scopes.sort();
        scopes.dedup();
        scopes
    };
    observations.record(
        ContractLine::UnknownExtension,
        format!("{}/{}", first.path.trim_end_matches('/'), first.key),
        format!(
            "{} extension(s) inconnue(s) capturées aux niveaux {} ; leur disposition d'export reste explicite.",
            unknown.len(),
            scopes.join(", ")
        ),
    );
}

/// Ligne 28 — doublon de clé racine connue, retenu last-wins.
fn observe_root_duplicates(payload: &DecodedStoryDocument, observations: &mut Observations) {
    let duplicates = payload
        .context
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == DUPLICATE_ROOT_KEY)
        .collect::<Vec<_>>();
    if let Some(first) = duplicates.first() {
        observations.record(
            ContractLine::KnownRootDuplicate,
            &first.path,
            format!(
                "{} clé(s) racine dupliquée(s) : dernière occurrence retenue et occurrences écartées conservées au diagnostic.",
                duplicates.len()
            ),
        );
    }
}
