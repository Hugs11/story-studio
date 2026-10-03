//! `validate_graph_document_integrity` — l'intégrité **abstraite** du graphe
//! d'auteur.
//!
//! Un document est accepté ou refusé sur ses seules propriétés référentielles.
//! Ce validateur est défini indépendamment du corpus, de STUdio, de Lunii.QT,
//! de `validate_document_for_studio_compat` et de la sémantique des groupes
//! enrichis : **aucune** règle n'est héritée de ce validateur historique, et
//! `normalize_document_for_studio_compat` n'est jamais appelée avant de valider.
//!
//! Ce qui **n'est pas** une erreur d'intégrité :
//!
//! - la syntaxe non-UUID d'un identifiant de Stage, question d'export traitée
//!   par la préparation ;
//! - l'inatteignabilité depuis `squareOne` ;
//! - une Action non référencée par sa seule existence, dont le diagnostic
//!   appartient à `diagnose_enriched_metadata` ;
//! - cycle, self-loop OK, self-loop HOME, HOME égal à OK, ActionNode partagé,
//!   convergence, parents multiples ;
//! - l'existence physique, le transcodage et l'identité des médias : les champs
//!   média peuvent être nuls.
//!
//! Aucune borne maximale de nombre d'options n'entre ici : ni `MAX_OPTIONS=100`
//! ni `MAX_OPTIONS=2^31−1` ne sont fondés. Une roue de 101 options est
//! `UNTESTED`, pas `INVALID`.
//!
//! Une valeur JSON `optionIndex < -1` est refusée **au décodage** par
//! `OptionSelection`, donc avant ce validateur : elle n'est pas traitée ici.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::dialect::{stable_node_paths, DiagnosticSeverity, ImportDiagnostic};
use super::document::{ActionNode, StoryDocument};

/// Les neuf erreurs bloquantes d'intégrité.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum GraphIntegrityCode {
    /// Identifiant de Stage non vide.
    StageIdEmpty,
    /// Identifiants de Stage uniques. STUdio range les Stages dans une
    /// `LinkedHashMap` indexée par `uuid` : un doublon fusionne silencieusement
    /// deux nœuds.
    DuplicateStageId,
    /// Identifiant d'ActionNode non vide.
    ActionIdEmpty,
    /// Identifiants d'Action uniques. Leur espace reste distinct de
    /// celui des Stages : un Stage et une Action peuvent partager un identifiant
    /// sans que ce soit une erreur.
    DuplicateActionId,
    /// Exactement un Stage `squareOne`.
    SquareOneCount,
    /// Toute transition non nulle référence un ActionNode existant.
    TransitionActionMissing,
    /// Aucune entrée `null` dans `Action.options[]`.
    OptionTargetNull,
    /// Toute option référence un Stage existant.
    OptionTargetMissing,
    /// `Random` exige `N ≥ 1`, `Fixed(i)` exige `0 ≤ i < N`.
    OptionSelectionInvalid,
}

impl GraphIntegrityCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            GraphIntegrityCode::StageIdEmpty => "STAGE_ID_EMPTY",
            GraphIntegrityCode::DuplicateStageId => "DUPLICATE_STAGE_ID",
            GraphIntegrityCode::ActionIdEmpty => "ACTION_ID_EMPTY",
            GraphIntegrityCode::DuplicateActionId => "DUPLICATE_ACTION_ID",
            GraphIntegrityCode::SquareOneCount => "SQUARE_ONE_COUNT",
            GraphIntegrityCode::TransitionActionMissing => "TRANSITION_ACTION_MISSING",
            GraphIntegrityCode::OptionTargetNull => "OPTION_TARGET_NULL",
            GraphIntegrityCode::OptionTargetMissing => "OPTION_TARGET_MISSING",
            GraphIntegrityCode::OptionSelectionInvalid => "OPTION_SELECTION_INVALID",
        }
    }
}

/// Une erreur bloquante, localisée par le chemin d'auteur stable du nœud
/// concerné — le même ancrage que les diagnostics d'import, pour qu'on
/// puisse agréger les deux sans réconcilier deux conventions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphIntegrityError {
    pub(crate) code: GraphIntegrityCode,
    pub(crate) path: String,
    pub(crate) message: String,
}

impl GraphIntegrityError {
    fn new(code: GraphIntegrityCode, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Valide l'intégrité abstraite du document d'auteur.
///
/// Rend `Ok(())` ou la liste **complète** des erreurs bloquantes : un auteur
/// doit voir tout ce qu'il a à corriger, pas la première erreur rencontrée.
pub(crate) fn validate_graph_document_integrity(
    document: &StoryDocument,
) -> Result<(), Vec<GraphIntegrityError>> {
    let stage_paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    let action_paths = stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
        action.id.as_str()
    });

    let mut errors = Vec::new();
    check_node_identifiers(
        document
            .stage_nodes
            .iter()
            .map(|stage| stage.uuid.as_str())
            .zip(stage_paths.iter()),
        IdentifierRules::STAGE,
        &mut errors,
    );
    check_node_identifiers(
        document
            .action_nodes
            .iter()
            .map(|action| action.id.as_str())
            .zip(action_paths.iter()),
        IdentifierRules::ACTION,
        &mut errors,
    );
    check_square_one_count(document, &stage_paths, &mut errors);

    // Les identifiants vides ou dupliqués sont déjà signalés ci-dessus ; les
    // index de résolution retiennent la première occurrence d'un identifiant
    // pour que les prédicats référentiels restent lisibles sur un document qui
    // porte déjà un doublon.
    let mut known_stage_ids: HashSet<&str> = HashSet::new();
    for stage in &document.stage_nodes {
        known_stage_ids.insert(stage.uuid.as_str());
    }
    let mut actions_by_id: HashMap<&str, &ActionNode> = HashMap::new();
    for action in &document.action_nodes {
        actions_by_id.entry(action.id.as_str()).or_insert(action);
    }

    check_option_targets(document, &action_paths, &known_stage_ids, &mut errors);
    check_transitions(document, &stage_paths, &actions_by_id, &mut errors);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Les erreurs d'intégrité présentées comme diagnostics d'import.
///
/// L'intégrité **ne bloque pas la lecture** : le document est conservé tel
/// qu'il est entré, et l'intégrité est bloquante à la préparation d'export et à
/// la readiness, pas à l'entrée. Le verdict d'import expose donc les erreurs
/// sans les transformer en refus.
///
/// Les codes sont ceux de `GraphIntegrityCode`, en majuscules, et se distinguent ainsi des
/// codes de décodage en minuscules produits par le dialecte.
pub(crate) fn graph_integrity_import_diagnostics(
    document: &StoryDocument,
) -> Vec<ImportDiagnostic> {
    let Err(errors) = validate_graph_document_integrity(document) else {
        return Vec::new();
    };
    errors
        .into_iter()
        .map(|error| ImportDiagnostic {
            severity: DiagnosticSeverity::Error,
            code: error.code.as_str().to_string(),
            path: error.path,
            message: error.message,
            retained: super::Presence::Absent,
            discarded: Vec::new(),
        })
        .collect()
}

/// Les deux jeux de règles d'identifiant : Stages et ActionNodes partagent la
/// même logique, mais pas leurs codes ni leur champ.
struct IdentifierRules {
    id_field: &'static str,
    label: &'static str,
    empty_code: GraphIntegrityCode,
    duplicate_code: GraphIntegrityCode,
}

impl IdentifierRules {
    const STAGE: Self = Self {
        id_field: "uuid",
        label: "Stage",
        empty_code: GraphIntegrityCode::StageIdEmpty,
        duplicate_code: GraphIntegrityCode::DuplicateStageId,
    };
    const ACTION: Self = Self {
        id_field: "id",
        label: "ActionNode",
        empty_code: GraphIntegrityCode::ActionIdEmpty,
        duplicate_code: GraphIntegrityCode::DuplicateActionId,
    };
}

fn check_node_identifiers<'a, I>(
    nodes: I,
    rules: IdentifierRules,
    errors: &mut Vec<GraphIntegrityError>,
) where
    I: Iterator<Item = (&'a str, &'a String)>,
{
    let IdentifierRules {
        id_field,
        label,
        empty_code,
        duplicate_code,
    } = rules;
    let mut seen: HashSet<&str> = HashSet::new();
    for (id, path) in nodes {
        if id.is_empty() {
            errors.push(GraphIntegrityError::new(
                empty_code,
                format!("{path}/{id_field}"),
                format!("{label} sans identifiant : le champ « {id_field} » est vide."),
            ));
            continue;
        }
        if !seen.insert(id) {
            errors.push(GraphIntegrityError::new(
                duplicate_code,
                format!("{path}/{id_field}"),
                format!("Identifiant de {label} en double : « {id} »."),
            ));
        }
    }
}

fn check_square_one_count(
    document: &StoryDocument,
    stage_paths: &[String],
    errors: &mut Vec<GraphIntegrityError>,
) {
    let entries: Vec<&String> = document
        .stage_nodes
        .iter()
        .zip(stage_paths)
        .filter(|(stage, _)| stage.is_square_one())
        .map(|(_, path)| path)
        .collect();
    if entries.len() == 1 {
        return;
    }
    // Le chemin désigne la collection quand il n'y a aucune entrée, et la
    // deuxième entrée en trop quand il y en a plusieurs : dans les deux cas il
    // pointe l'endroit où la correction doit avoir lieu.
    let path = entries
        .get(1)
        .map(|path| (*path).clone())
        .unwrap_or_else(|| "/stageNodes".to_string());
    errors.push(GraphIntegrityError::new(
        GraphIntegrityCode::SquareOneCount,
        path,
        format!(
            "Le document doit contenir exactement un Stage squareOne ; il en contient {}.",
            entries.len()
        ),
    ));
}

fn check_option_targets(
    document: &StoryDocument,
    action_paths: &[String],
    known_stage_ids: &HashSet<&str>,
    errors: &mut Vec<GraphIntegrityError>,
) {
    for (action, path) in document.action_nodes.iter().zip(action_paths) {
        for (index, option) in action.options.iter().enumerate() {
            let option_path = format!("{path}/options/{index}");
            let Some(target) = option.as_deref() else {
                errors.push(GraphIntegrityError::new(
                    GraphIntegrityCode::OptionTargetNull,
                    option_path,
                    format!(
                        "L'option {index} de l'ActionNode « {} » est nulle : elle ne désigne aucun Stage.",
                        action.id
                    ),
                ));
                continue;
            };
            if !known_stage_ids.contains(target) {
                errors.push(GraphIntegrityError::new(
                    GraphIntegrityCode::OptionTargetMissing,
                    option_path,
                    format!(
                        "L'option {index} de l'ActionNode « {} » désigne un Stage introuvable : « {target} ».",
                        action.id
                    ),
                ));
            }
        }
    }
}

fn check_transitions(
    document: &StoryDocument,
    stage_paths: &[String],
    actions_by_id: &HashMap<&str, &ActionNode>,
    errors: &mut Vec<GraphIntegrityError>,
) {
    for (stage, path) in document.stage_nodes.iter().zip(stage_paths) {
        for (field, transition) in [
            ("okTransition", stage.ok_transition.value()),
            ("homeTransition", stage.home_transition.value()),
        ] {
            // Une transition absente ou `null` ne définit aucune arête : elle
            // n'est pas une erreur d'intégrité (`TransitionActionMissing`
            // porte sur les transitions **non nulles**).
            let Some(transition) = transition else {
                continue;
            };
            let transition_path = format!("{path}/{field}");
            let Some(action) = actions_by_id.get(transition.action_node.as_str()) else {
                errors.push(GraphIntegrityError::new(
                    GraphIntegrityCode::TransitionActionMissing,
                    format!("{transition_path}/actionNode"),
                    format!(
                        "La transition {field} du Stage « {} » référence un ActionNode introuvable : « {} ».",
                        stage.uuid, transition.action_node
                    ),
                ));
                continue;
            };
            let option_count = action.options.len();
            if !transition.selection.is_within_bounds(option_count) {
                errors.push(GraphIntegrityError::new(
                    GraphIntegrityCode::OptionSelectionInvalid,
                    format!("{transition_path}/optionIndex"),
                    format!(
                        "La transition {field} du Stage « {} » sélectionne {} sur un ActionNode de {option_count} option(s).",
                        stage.uuid, transition.selection
                    ),
                ));
            }
        }
    }
}
