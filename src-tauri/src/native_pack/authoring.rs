//! Diagnostics d'authoring et transformations enrichies pures.
//!
//! Cette couche ne décide ni de l'intégrité du graphe (`integrity.rs`), ni de
//! sa préparation d'export. Elle rend visibles les pertes qui exigent
//! une décision de l'auteur et conserve cette décision avec la valeur exacte à
//! laquelle elle s'applique.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::port_rules::{port_violations, PortViolation};
use super::{
    stable_node_paths, DecodedStoryDocument, OpaqueExportDisposition, OpaqueMember,
    OpaqueMemberKind, Position, PositionExportDecision, PositionExportDisposition, Presence,
    StoryDocument, ValueOrigin, STAGE_TYPE_FALLBACK,
};

const SHORT_MIN: f64 = -32_768.0;
const SHORT_MAX: f64 = 32_767.0;
const KNOWN_STAGE_TYPES: &[&str] = &[
    "stage",
    "cover",
    "story",
    "menu.optionstage",
    "menu.questionstage",
];
const KNOWN_ACTION_TYPES: &[&str] = &[
    "story.storyaction",
    "menu.questionaction",
    "menu.optionsaction",
];
const STORY_STAGE_TYPE: &str = "story";
const STORY_ACTION_TYPE: &str = "story.storyaction";
const MENU_QUESTION_STAGE_TYPE: &str = "menu.questionstage";
const MENU_OPTION_STAGE_TYPE: &str = "menu.optionstage";
const MENU_QUESTION_ACTION_TYPE: &str = "menu.questionaction";
const MENU_OPTIONS_ACTION_TYPE: &str = "menu.optionsaction";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum AuthoringDiagnosticLevel {
    Info,
    Warning,
    ActionRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AuthoringResolution {
    ConnectOrRemoveOrphan,
    RepairKnownGroup,
    FlattenKnownGroup,
    ScalePositionToShortRange,
    OmitPosition,
    PreserveRawAcceptDantsuLoss,
    PreserveOpaqueUntested,
    RemoveOpaqueExplicitly,
    PromoteOpaqueAfterProof,
    CompleteControlSettings,
    ClearHomeTransition,
    DisableHome,
    /// OK et lecture automatique désactivés, Accueil activé : la fin
    /// validée sur l'appareil. Aucune destination OK n'est inventée.
    MakeEnding,
    EnableHome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthoringDiagnostic {
    pub(crate) level: AuthoringDiagnosticLevel,
    pub(crate) code: String,
    pub(crate) path: String,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) resolutions: Vec<AuthoringResolution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthoringGuardAssessment {
    pub(crate) blocked: bool,
    pub(crate) diagnostics: Vec<AuthoringDiagnostic>,
}

impl AuthoringDiagnostic {
    fn new(
        level: AuthoringDiagnosticLevel,
        code: &str,
        path: impl Into<String>,
        message: impl Into<String>,
        resolutions: Vec<AuthoringResolution>,
    ) -> Self {
        Self {
            level,
            code: code.to_string(),
            path: path.into(),
            message: message.into(),
            resolutions,
        }
    }
}

/// Point pur commun à la préparation d'export et à la readiness. Il ne couvre
/// volontairement ni l'intégrité du graphe, ni l'agrégat complet de readiness :
/// il ne répond qu'à la question « une perte authored attend-elle encore une
/// décision ? ».
#[allow(dead_code)] // Point d'intégration pas encore raccordé.
pub(crate) fn assess_authoring_export_guards(
    payload: &DecodedStoryDocument,
) -> AuthoringGuardAssessment {
    let diagnostics = diagnose_enriched_metadata(payload);
    let blocked = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.level == AuthoringDiagnosticLevel::ActionRequired);
    AuthoringGuardAssessment {
        blocked,
        diagnostics,
    }
}

/// Diagnostics de fidélité d'authoring, distincts des erreurs d'intégrité du graphe.
pub(crate) fn diagnose_enriched_metadata(
    payload: &DecodedStoryDocument,
) -> Vec<AuthoringDiagnostic> {
    let document = &payload.document;
    let stage_paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    let action_paths = stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
        action.id.as_str()
    });
    let mut diagnostics = Vec::new();

    diagnose_unknown_types(document, &stage_paths, &action_paths, &mut diagnostics);
    diagnose_groups(document, &stage_paths, &action_paths, &mut diagnostics);
    diagnose_orphan_actions(payload, &action_paths, &mut diagnostics);
    diagnose_opaque_members(payload, &mut diagnostics);
    diagnose_incomplete_controls(document, &stage_paths, &mut diagnostics);
    diagnose_entry_stage(document, &stage_paths, &action_paths, &mut diagnostics);
    diagnose_severed_transitions(payload, &stage_paths, &mut diagnostics);

    diagnostics
}

fn diagnose_unknown_types(
    document: &StoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    for (stage, path) in document.stage_nodes.iter().zip(stage_paths) {
        if let Some(stage_type) = stage.stage_type.as_deref() {
            if !KNOWN_STAGE_TYPES.contains(&stage_type) {
                diagnostics.push(AuthoringDiagnostic::new(
                    AuthoringDiagnosticLevel::Warning,
                    "ENRICHED_TYPE_UNKNOWN",
                    format!("{path}/type"),
                    format!(
                        "Type de Stage inconnu « {stage_type} », conservé sans remapping ni sémantique déduite."
                    ),
                    Vec::new(),
                ));
            }
        }
    }
    for (action, path) in document.action_nodes.iter().zip(action_paths) {
        if let Some(action_type) = action.action_type.as_deref() {
            if !KNOWN_ACTION_TYPES.contains(&action_type) {
                diagnostics.push(AuthoringDiagnostic::new(
                    AuthoringDiagnosticLevel::Warning,
                    "ENRICHED_TYPE_UNKNOWN",
                    format!("{path}/type"),
                    format!(
                        "Type d'Action inconnu « {action_type} », conservé sans remapping ni sémantique déduite."
                    ),
                    Vec::new(),
                ));
            }
        }
    }
}

/// La forme d'un groupe enrichi telle que les diagnostics la reconnaissent.
/// Partagée avec la projection de lecture : deux règles de reconnaissance
/// divergeraient, et l'UI afficherait une forme que le diagnostic ne signale
/// pas. Reconnaître une forme n'est pas l'interpréter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KnownGroupKind {
    Story,
    Menu,
    Unknown,
}

#[derive(Debug, Default)]
pub(crate) struct GroupMembers {
    pub(crate) stage_indices: Vec<usize>,
    pub(crate) action_indices: Vec<usize>,
}

pub(crate) fn collect_groups(document: &StoryDocument) -> BTreeMap<String, GroupMembers> {
    let mut groups = BTreeMap::<String, GroupMembers>::new();
    for (index, stage) in document.stage_nodes.iter().enumerate() {
        if let Some(group_id) = stage.group_id.as_deref() {
            groups
                .entry(group_id.to_string())
                .or_default()
                .stage_indices
                .push(index);
        }
    }
    for (index, action) in document.action_nodes.iter().enumerate() {
        if let Some(group_id) = action.group_id.as_deref() {
            groups
                .entry(group_id.to_string())
                .or_default()
                .action_indices
                .push(index);
        }
    }
    groups
}

pub(crate) fn classify_group(document: &StoryDocument, group: &GroupMembers) -> KnownGroupKind {
    let stage_types = group
        .stage_indices
        .iter()
        .map(|&index| document.stage_nodes[index].stage_type.as_deref())
        .collect::<Vec<_>>();
    let action_types = group
        .action_indices
        .iter()
        .map(|&index| document.action_nodes[index].action_type.as_deref())
        .collect::<Vec<_>>();
    let has_story_marker = stage_types.contains(&Some(STORY_STAGE_TYPE))
        || action_types.contains(&Some(STORY_ACTION_TYPE));
    let has_menu_marker = stage_types
        .iter()
        .flatten()
        .any(|value| matches!(*value, MENU_QUESTION_STAGE_TYPE | MENU_OPTION_STAGE_TYPE))
        || action_types
            .iter()
            .flatten()
            .any(|value| matches!(*value, MENU_QUESTION_ACTION_TYPE | MENU_OPTIONS_ACTION_TYPE));

    if has_story_marker
        && !has_menu_marker
        && stage_types
            .iter()
            .all(|value| *value == Some(STORY_STAGE_TYPE))
        && action_types
            .iter()
            .all(|value| *value == Some(STORY_ACTION_TYPE))
    {
        KnownGroupKind::Story
    } else if has_menu_marker
        && !has_story_marker
        && stage_types.iter().all(|value| {
            matches!(
                *value,
                Some(MENU_QUESTION_STAGE_TYPE | MENU_OPTION_STAGE_TYPE)
            )
        })
        && action_types.iter().all(|value| {
            matches!(
                *value,
                Some(MENU_QUESTION_ACTION_TYPE | MENU_OPTIONS_ACTION_TYPE)
            )
        })
    {
        KnownGroupKind::Menu
    } else {
        KnownGroupKind::Unknown
    }
}

fn diagnose_groups(
    document: &StoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    for (group_id, group) in collect_groups(document) {
        let path = group_path(&group, stage_paths, action_paths);
        match classify_group(document, &group) {
            KnownGroupKind::Story if !story_group_is_coherent(document, &group) => {
                diagnostics.push(incoherent_group_diagnostic(&group_id, path, "story"));
            }
            KnownGroupKind::Menu if !menu_group_is_coherent(document, &group) => {
                diagnostics.push(incoherent_group_diagnostic(&group_id, path, "menu"));
            }
            KnownGroupKind::Unknown => diagnostics.push(AuthoringDiagnostic::new(
                AuthoringDiagnosticLevel::Warning,
                "ENRICHED_GROUP_UNKNOWN",
                path,
                format!(
                    "Forme de groupe enrichi inconnue « {group_id} », conservée sans interprétation."
                ),
                Vec::new(),
            )),
            KnownGroupKind::Story | KnownGroupKind::Menu => {}
        }
    }
}

fn group_path(group: &GroupMembers, stage_paths: &[String], action_paths: &[String]) -> String {
    group
        .stage_indices
        .first()
        .map(|&index| format!("{}/groupId", stage_paths[index]))
        .or_else(|| {
            group
                .action_indices
                .first()
                .map(|&index| format!("{}/groupId", action_paths[index]))
        })
        .unwrap_or_else(|| "/".to_string())
}

fn incoherent_group_diagnostic(group_id: &str, path: String, kind: &str) -> AuthoringDiagnostic {
    AuthoringDiagnostic::new(
        AuthoringDiagnosticLevel::ActionRequired,
        "ENRICHED_GROUP_INCOHERENT",
        path,
        format!(
            "Le groupe {kind} connu « {group_id} » ne respecte plus sa forme interne ; ses marqueurs sont conservés jusqu'à réparation ou flatten explicite."
        ),
        vec![
            AuthoringResolution::RepairKnownGroup,
            AuthoringResolution::FlattenKnownGroup,
        ],
    )
}

fn story_group_is_coherent(document: &StoryDocument, group: &GroupMembers) -> bool {
    if group.stage_indices.len() != 1 || group.action_indices.len() != 1 {
        return false;
    }
    let stage = &document.stage_nodes[group.stage_indices[0]];
    let action = &document.action_nodes[group.action_indices[0]];
    stage.stage_type.as_deref() == Some(STORY_STAGE_TYPE)
        && action.action_type.as_deref() == Some(STORY_ACTION_TYPE)
        && action.options == [Some(stage.uuid.clone())]
}

fn menu_group_is_coherent(document: &StoryDocument, group: &GroupMembers) -> bool {
    let question_stages = group
        .stage_indices
        .iter()
        .map(|&index| &document.stage_nodes[index])
        .filter(|stage| stage.stage_type.as_deref() == Some(MENU_QUESTION_STAGE_TYPE))
        .collect::<Vec<_>>();
    let option_stages = group
        .stage_indices
        .iter()
        .map(|&index| &document.stage_nodes[index])
        .filter(|stage| stage.stage_type.as_deref() == Some(MENU_OPTION_STAGE_TYPE))
        .collect::<Vec<_>>();
    let question_actions = group
        .action_indices
        .iter()
        .map(|&index| &document.action_nodes[index])
        .filter(|action| action.action_type.as_deref() == Some(MENU_QUESTION_ACTION_TYPE))
        .collect::<Vec<_>>();
    let options_actions = group
        .action_indices
        .iter()
        .map(|&index| &document.action_nodes[index])
        .filter(|action| action.action_type.as_deref() == Some(MENU_OPTIONS_ACTION_TYPE))
        .collect::<Vec<_>>();
    if question_stages.len() != 1
        || option_stages.is_empty()
        || question_actions.len() != 1
        || options_actions.len() != 1
    {
        return false;
    }

    let question_stage = question_stages[0];
    let question_action = question_actions[0];
    let options_action = options_actions[0];
    // Les liens du menu suivent Action.options, jamais l'ordre physique des
    // Stages. Comparer les multiplicités garde le contrôle des doublons/cibles
    // manquantes sans faire d'une permutation de stockage une édition.
    let mut expected_options = option_stages
        .iter()
        .map(|stage| Some(stage.uuid.clone()))
        .collect::<Vec<_>>();
    let mut actual_options = options_action.options.clone();
    expected_options.sort();
    actual_options.sort();
    let question_targets_itself = question_action.options == [Some(question_stage.uuid.clone())];
    let selection_is_valid = question_stage
        .ok_transition
        .value()
        .is_some_and(|transition| {
            transition.action_node == options_action.id
                && transition
                    .selection
                    .is_within_bounds(options_action.options.len())
        });

    question_targets_itself && actual_options == expected_options && selection_is_valid
}

fn diagnose_orphan_actions(
    payload: &DecodedStoryDocument,
    action_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    let document = &payload.document;
    let referenced_actions = document
        .stage_nodes
        .iter()
        .flat_map(|stage| [stage.ok_transition.value(), stage.home_transition.value()])
        .flatten()
        .map(|transition| transition.action_node.as_str())
        .collect::<HashSet<_>>();
    let stage_ids = document
        .stage_nodes
        .iter()
        .map(|stage| stage.uuid.as_str())
        .collect::<HashSet<_>>();

    for (action, path) in document.action_nodes.iter().zip(action_paths) {
        if referenced_actions.contains(action.id.as_str()) {
            continue;
        }
        let has_valid_option = action
            .named_options()
            .any(|target| stage_ids.contains(target));
        let has_authored_metadata = !action.name.is_absent()
            || !action.position.is_absent()
            || !action.action_type.is_absent()
            || !action.group_id.is_absent()
            || payload.context.opaque_members.iter().any(|member| {
                member.path == *path
                    && (member.kind == OpaqueMemberKind::UnknownExtension
                        || (member.kind == OpaqueMemberKind::KnownAlias
                            && member.export_disposition
                                != Some(OpaqueExportDisposition::NeverEmitStandard)))
            });
        let strict_empty_scaffold = action.options.is_empty() && !has_authored_metadata;

        if strict_empty_scaffold {
            diagnostics.push(AuthoringDiagnostic::new(
                AuthoringDiagnosticLevel::Info,
                "ORPHAN_ACTION_EMPTY_SCAFFOLD",
                path,
                "Action orpheline strictement vide : aucun contenu authored ne serait perdu.",
                Vec::new(),
            ));
        } else if has_valid_option || has_authored_metadata || !action.options.is_empty() {
            diagnostics.push(AuthoringDiagnostic::new(
                AuthoringDiagnosticLevel::ActionRequired,
                "ORPHAN_ACTION_AUTHORED_CONTENT",
                path,
                "Action orpheline porte du contenu authored que les passerelles supprimeraient silencieusement.",
                vec![AuthoringResolution::ConnectOrRemoveOrphan],
            ));
        }
    }
}

fn diagnose_opaque_members(
    payload: &DecodedStoryDocument,
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    for member in &payload.context.opaque_members {
        if opaque_member_never_emitted(payload, member) {
            continue;
        }
        let path = format!(
            "{}/{}",
            member.path.trim_end_matches('/'),
            pointer_segment(&member.key)
        );
        let current = member.export_disposition.is_some()
            && member.export_disposition_value.matches_json(&member.value)
            && member.export_disposition_origin == Some(member.origin);
        if current {
            if member.export_disposition == Some(OpaqueExportDisposition::PreserveUntested) {
                diagnostics.push(AuthoringDiagnostic::new(
                    AuthoringDiagnosticLevel::Warning,
                    "OPAQUE_EXTENSION_PRESERVED_UNTESTED",
                    path,
                    "Extension opaque préservée tel quel par décision explicite ; sa dimension d'interopérabilité reste UNTESTED.",
                    Vec::new(),
                ));
            }
            continue;
        }
        diagnostics.push(AuthoringDiagnostic::new(
            AuthoringDiagnosticLevel::ActionRequired,
            if member.export_disposition.is_some() {
                "OPAQUE_EXTENSION_DISPOSITION_STALE"
            } else {
                "OPAQUE_EXTENSION_DISPOSITION_REQUIRED"
            },
            path,
            "Extension opaque conservée : choisir explicitement préservation UNTESTED, suppression assumée ou promotion après preuve.",
            vec![
                AuthoringResolution::PreserveOpaqueUntested,
                AuthoringResolution::RemoveOpaqueExplicitly,
                AuthoringResolution::PromoteOpaqueAfterProof,
            ],
        ));
    }
}

fn diagnose_incomplete_controls(
    document: &StoryDocument,
    stage_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    for (stage, path) in document.stage_nodes.iter().zip(stage_paths) {
        if !stage.control_settings.is_complete() {
            diagnostics.push(AuthoringDiagnostic::new(
                AuthoringDiagnosticLevel::ActionRequired,
                "CONTROL_SETTINGS_INCOMPLETE",
                format!("{path}/controlSettings"),
                "Les cinq booléens de contrôle doivent être renseignés explicitement avant export standard.",
                vec![AuthoringResolution::CompleteControlSettings],
            ));
        }
    }
}

/// Les règles de navigation de la Lunii (`port_rules`), **bloquantes** comme au
/// générateur par menus : une seule règle pour le même appareil.
///
/// Mesuré le 29/09/2026 sur 516 `story.json` réels : aucune option vers
/// l'entrée, aucun Accueil sans destination sur l'entrée, aucune boucle OK ;
/// une vingtaine d'Accueil explicites qui ramènent l'Écran sur lui-même
/// (une série de packs publiés), qui piègent l'enfant sur la Lunii et sont donc à
/// corriger avant de générer.
fn diagnose_entry_stage(
    document: &StoryDocument,
    stage_paths: &[String],
    action_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    for violation in port_violations(document) {
        let (path, message, resolutions) = match violation {
            PortViolation::HomeLoopsToSelf { stage, implicit: true } => (
                format!("{}/controlSettings/home", stage_paths[stage]),
                "Sur l'Écran d'entrée, le bouton Accueil ramènerait ici même : désactivez-le.",
                vec![AuthoringResolution::DisableHome],
            ),
            PortViolation::HomeLoopsToSelf { stage, implicit: false } => (
                format!("{}/homeTransition", stage_paths[stage]),
                "Le bouton Accueil ramène cet Écran sur lui-même, et la Lunii s'y bloque : retirez sa destination pour revenir au début du pack.",
                vec![AuthoringResolution::ClearHomeTransition],
            ),
            PortViolation::OkLoopsToSelf { stage } => (
                format!("{}/okTransition", stage_paths[stage]),
                "Le bouton OK ramène cet Écran sur lui-même : choisissez une autre destination.",
                Vec::new(),
            ),
            PortViolation::OkWithoutUsableDestination { stage } => (
                format!("{}/okTransition", stage_paths[stage]),
                "OK ou la fin automatique est actif sans destination utilisable : reliez une destination ou désactivez ces déclencheurs.",
                vec![AuthoringResolution::MakeEnding],
            ),
            PortViolation::NoUsableExit { stage } => (
                format!("{}/controlSettings", stage_paths[stage]),
                "Cet Écran accessible ne permet aucune sortie, même par la molette : ajoutez une sortie utilisable.",
                vec![AuthoringResolution::EnableHome],
            ),
            PortViolation::EntryStageAsOption { action, option } => (
                format!("{}/options/{option}", action_paths[action]),
                "Ce choix mène à l'Écran d'entrée, qui ne peut pas être une destination : retirez-le ou changez son Écran. On revient au début par le bouton Accueil laissé sans destination.",
                Vec::new(),
            ),
        };
        diagnostics.push(AuthoringDiagnostic::new(
            AuthoringDiagnosticLevel::ActionRequired,
            violation.code(),
            path,
            message,
            resolutions,
        ));
    }
}

/// Les transitions qu'un retrait a coupées et que l'auteur n'a pas refaites.
///
/// La marque de coupe complète les règles de ports : elle conserve la décision
/// d'auteur à prendre après le retrait d'une destination, indépendamment des
/// contrôles actuels. Elle s'efface lorsque la transition retrouve une valeur.
fn diagnose_severed_transitions(
    payload: &DecodedStoryDocument,
    stage_paths: &[String],
    diagnostics: &mut Vec<AuthoringDiagnostic>,
) {
    if payload.context.severed_transitions.is_empty() {
        return;
    }
    for (stage, path) in payload.document.stage_nodes.iter().zip(stage_paths) {
        for (field, transition) in [
            ("okTransition", &stage.ok_transition),
            ("homeTransition", &stage.home_transition),
        ] {
            if transition.is_value() {
                continue;
            }
            let anchor = format!("{path}/{field}");
            if !payload
                .context
                .severed_transitions
                .iter()
                .any(|severed| severed.path == anchor)
            {
                continue;
            }
            let control = if field == "okTransition" {
                "OK"
            } else {
                "HOME"
            };
            diagnostics.push(AuthoringDiagnostic::new(
                AuthoringDiagnosticLevel::ActionRequired,
                "TRANSITION_SEVERED_BY_REMOVAL",
                anchor,
                format!(
                    "Un retrait a laissé cet Écran sans destination {control} : le raccorder, ou désactiver ce bouton."
                ),
                Vec::new(),
            ));
        }
    }
}

/// La provenance retenue pour ce chemin d'auteur. Partagée avec la readiness,
/// qui distingue les lignes « position source » et « position créée par
/// Story Studio » exactement sur ce même critère.
pub(crate) fn value_origin(payload: &DecodedStoryDocument, path: &str) -> ValueOrigin {
    payload
        .context
        .value_provenance
        .iter()
        .rev()
        .find(|entry| entry.path == path)
        .map(|entry| entry.origin)
        .unwrap_or(payload.context.default_value_origin)
}

pub(crate) fn position_is_fractional(position: &Position) -> bool {
    [&position.x, &position.y].into_iter().any(|number| {
        number
            .as_f64()
            .is_some_and(|value| value.is_finite() && value.fract() != 0.0)
    })
}

pub(crate) fn position_is_out_of_short_range(position: &Position) -> bool {
    [&position.x, &position.y].into_iter().any(|number| {
        number
            .as_f64()
            .is_some_and(|value| !(SHORT_MIN..=SHORT_MAX).contains(&value))
    })
}

/// Enregistre une disposition uniquement pour la position authored courante.
#[allow(dead_code)] // Commande headless pas encore raccordée.
pub(crate) fn set_position_export_disposition(
    payload: &mut DecodedStoryDocument,
    path: &str,
    disposition: PositionExportDisposition,
) -> Result<(), String> {
    let position = authored_position(&payload.document, path)
        .cloned()
        .ok_or_else(|| format!("Position authored introuvable : {path}"))?;
    if !position_is_out_of_short_range(&position) {
        return Err(
            "Une disposition de position ne s'applique qu'à une position hors short.".to_string(),
        );
    }
    let origin = value_origin(payload, path);
    if disposition == PositionExportDisposition::PreserveRawAcceptDantsuLoss
        && origin != ValueOrigin::SourceStudio
    {
        return Err(
            "La perte d'affichage dans STUdio ne peut être acceptée que pour une position héritée d'une source Studio."
                .to_string(),
        );
    }
    payload
        .context
        .position_export_decisions
        .retain(|decision| decision.path != path);
    payload
        .context
        .position_export_decisions
        .push(PositionExportDecision {
            path: path.to_string(),
            origin,
            position,
            disposition,
        });
    Ok(())
}

/// La règle de non-émission des clés connues reste prioritaire sur les
/// dispositions d'extensions.
pub(crate) fn opaque_member_never_emitted(
    payload: &DecodedStoryDocument,
    member: &OpaqueMember,
) -> bool {
    if member.path == "/" && matches!(member.key.as_str(), "image" | "official") {
        return true;
    }
    if member.kind != OpaqueMemberKind::KnownAlias {
        return false;
    }
    let Some(alias) = member.value.as_str() else {
        return false;
    };
    let document = &payload.document;
    match member.key.as_str() {
        "id" => stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
            stage.uuid.as_str()
        })
        .iter()
        .zip(&document.stage_nodes)
        .any(|(path, stage)| *path == member.path && stage.uuid == alias),
        "uuid" => stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
            action.id.as_str()
        })
        .iter()
        .zip(&document.action_nodes)
        .any(|(path, action)| *path == member.path && action.id == alias),
        _ => false,
    }
}

/// Attache une disposition opaque à la valeur et à la provenance courantes.
#[allow(dead_code)] // Commande headless pas encore raccordée.
pub(crate) fn set_opaque_export_disposition(
    payload: &mut DecodedStoryDocument,
    path: &str,
    key: &str,
    source_occurrence: usize,
    disposition: OpaqueExportDisposition,
) -> Result<(), String> {
    let index = payload
        .context
        .opaque_members
        .iter()
        .position(|member| {
            member.path == path
                && member.key == key
                && member.source_occurrence == source_occurrence
        })
        .ok_or_else(|| format!("Extension opaque introuvable : {path}/{key}"))?;
    if matches!(
        disposition,
        OpaqueExportDisposition::PreserveUntested | OpaqueExportDisposition::PromoteAfterProof
    ) && opaque_member_never_emitted(payload, &payload.context.opaque_members[index])
    {
        return Err("L'export standard n'émet pas cette clé connue.".to_string());
    }
    let member = &mut payload.context.opaque_members[index];
    if disposition == OpaqueExportDisposition::NeverEmitStandard
        && !matches!(
            member.kind,
            OpaqueMemberKind::KnownAlias | OpaqueMemberKind::KnownNeverEmitted
        )
    {
        return Err("NeverEmitStandard est réservé aux membres connus non canoniques.".to_string());
    }
    member.export_disposition = Some(disposition);
    member.export_disposition_value = Presence::from_json(member.value.clone());
    member.export_disposition_origin = Some(member.origin);
    Ok(())
}

/// Édition headless d'une position : la valeur entre dans le document d'auteur
/// et sa provenance devient `Authored`. Une décision antérieure reste stockée
/// comme trace, mais ne correspond plus à la valeur et ne débloque donc rien.
#[allow(dead_code)] // Transformation pure pas encore raccordée.
pub(crate) fn set_authored_position(
    payload: &mut DecodedStoryDocument,
    path: &str,
    position: Position,
) -> Result<(), String> {
    let target = authored_position_mut(&mut payload.document, path)
        .ok_or_else(|| format!("Nœud de position introuvable : {path}"))?;
    *target = Presence::Value(position);
    payload
        .context
        .value_provenance
        .retain(|entry| entry.path != path);
    payload
        .context
        .value_provenance
        .push(super::ValueProvenance {
            path: path.to_string(),
            origin: ValueOrigin::Authored,
        });
    Ok(())
}

/// Rend authored une position d'auto-layout uniquement sur invocation
/// explicite. Sans cet appel, elle reste dans `editor_positions` et ne rejoint
/// jamais le document sérialisé.
#[allow(dead_code)] // Transformation pure pas encore raccordée.
pub(crate) fn apply_editor_position_to_authoring(
    payload: &mut DecodedStoryDocument,
    path: &str,
) -> Result<(), String> {
    let index = payload
        .context
        .editor_positions
        .iter()
        .position(|entry| entry.path == path)
        .ok_or_else(|| format!("Position d'éditeur introuvable : {path}"))?;
    let position = payload.context.editor_positions[index].position.clone();
    set_authored_position(payload, path, position)?;
    payload.context.editor_positions.remove(index);
    Ok(())
}

/// Transformation pure représentant une édition de navigation. Les marqueurs
/// enrichis ne sont jamais effacés comme effet de bord ; le diagnostic décide
/// ensuite si la forme connue est encore cohérente.
#[allow(dead_code)] // Transformation pure pas encore raccordée.
pub(crate) fn with_action_option_target(
    document: &StoryDocument,
    action_id: &str,
    option_index: usize,
    target: Option<String>,
) -> Result<StoryDocument, String> {
    let mut edited = document.clone();
    let action = edited
        .action_nodes
        .iter_mut()
        .find(|action| action.id == action_id)
        .ok_or_else(|| format!("Action introuvable : {action_id}"))?;
    let option = action
        .options
        .get_mut(option_index)
        .ok_or_else(|| format!("Option introuvable : {action_id}[{option_index}]"))?;
    *option = target;
    Ok(edited)
}

/// Flatten volontaire d'une forme connue. Cette fonction est le seul endroit
/// qui retire les marqueurs ; diagnostic, validation et futures étapes
/// d'export n'ont aucune raison de l'appeler implicitement.
#[allow(dead_code)] // Transformation pure pas encore raccordée.
pub(crate) fn flatten_known_group(
    document: &StoryDocument,
    group_id: &str,
) -> Result<StoryDocument, String> {
    let groups = collect_groups(document);
    let group = groups
        .get(group_id)
        .ok_or_else(|| format!("Groupe introuvable : {group_id}"))?;
    if classify_group(document, group) == KnownGroupKind::Unknown {
        return Err(format!(
            "Le groupe « {group_id} » porte une forme inconnue ; aucun flatten sémantique n'est prétendu."
        ));
    }

    let mut flattened = document.clone();
    for &index in &group.stage_indices {
        let stage = &mut flattened.stage_nodes[index];
        stage.group_id = Presence::Absent;
        stage.stage_type = Presence::Value(STAGE_TYPE_FALLBACK.to_string());
    }
    for &index in &group.action_indices {
        let action = &mut flattened.action_nodes[index];
        action.group_id = Presence::Absent;
        action.action_type = Presence::Absent;
    }
    Ok(flattened)
}

fn authored_position<'a>(document: &'a StoryDocument, path: &str) -> Option<&'a Position> {
    let stage_paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    if let Some((index, _)) = stage_paths
        .iter()
        .enumerate()
        .find(|(_, node_path)| format!("{node_path}/position") == path)
    {
        return document.stage_nodes[index].position.value();
    }
    let action_paths = stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
        action.id.as_str()
    });
    action_paths
        .iter()
        .enumerate()
        .find(|(_, node_path)| format!("{node_path}/position") == path)
        .and_then(|(index, _)| document.action_nodes[index].position.value())
}

fn authored_position_mut<'a>(
    document: &'a mut StoryDocument,
    path: &str,
) -> Option<&'a mut Presence<Position>> {
    let stage_paths = stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
        stage.uuid.as_str()
    });
    if let Some((index, _)) = stage_paths
        .iter()
        .enumerate()
        .find(|(_, node_path)| format!("{node_path}/position") == path)
    {
        return Some(&mut document.stage_nodes[index].position);
    }
    let action_paths = stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
        action.id.as_str()
    });
    let index = action_paths
        .iter()
        .enumerate()
        .find(|(_, node_path)| format!("{node_path}/position") == path)
        .map(|(index, _)| index)?;
    Some(&mut document.action_nodes[index].position)
}

fn pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
