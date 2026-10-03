//! Gestes de structure : créer un Stage avec son Action et ses médias, retirer
//! un Stage, retirer une Action.
//!
//! À la création, tout nouveau Stage reçoit un **UUID canonique et unique dès
//! sa création**, tiré du CSPRNG du système comme l'identité de pack, jamais
//! dérivé d'un nom ni fourni par l'appelant. Rien de tel n'est imposé aux
//! ActionNodes : l'UUID est recommandé sans en faire une exigence
//! d'interopérabilité — 22 718 identifiants `action-N` ont été exercés — donc
//! un identifiant d'Action fourni est accepté **tel quel** et n'est jamais
//! normalisé.
//!
//! Les retraits ne réparent rien à la place de l'auteur. Retirer un Stage
//! encore désigné par une option demanderait de retargeter ou de supprimer
//! cette option, ce qui relève d'une décision explicite : le geste refuse et
//! nomme les options concernées. En revanche une Action laissée sans transition
//! entrante **survit** : c'est un état intermédiaire légitime, que le
//! diagnostic d'authoring signale sans que rien ne soit perdu.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::anchors::{occurrence_shifts, removal_fate, rewrite_context_anchors, AnchorReport};
use super::media::{bind_created_media, CreatedMedia, MediaBindingReport};
use super::options::{
    incoming_option_ids, incoming_transition_paths, option_id, remove_option,
    resolve_option_target, set_option_target, transition_path, ActionOptionTarget, DecisionBook,
    ReferenceReport, SelectionDecision, SelectionEffect,
};
use super::transitions::{set_stage_transition, TransitionSlot, TransitionUpdate};
use super::GestureError;
use crate::native_pack::persistence::AdvancedMediaBinding;
use crate::native_pack::{
    stable_node_paths, ActionNode, ControlSettings, DecodedStoryDocument, Presence, StageNode,
    StoryDocument,
};

/// Nombre de tirages avant d'admettre qu'aucun UUID libre n'a été obtenu.
///
/// Une collision est hors de portée d'un CSPRNG en production ; la borne existe
/// pour qu'une source injectée constante échoue franchement au lieu de boucler.
const UUID_DRAW_ATTEMPTS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ControlsInput {
    pub(crate) wheel: bool,
    pub(crate) ok: bool,
    pub(crate) home: bool,
    pub(crate) pause: bool,
    pub(crate) autoplay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateActionRequest {
    /// Absent, un UUID est tiré ; présent, il est conservé verbatim.
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) options: Vec<ActionOptionTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateStageRequest {
    #[serde(default)]
    pub(crate) name: Option<String>,
    /// Les cinq booléens sont exigés de l'appelant. Un objet partiel est une
    /// forme d'entrée admise **à l'import**, jamais une chose que Story Studio
    /// fabrique — la créer serait une perte connue d'avance.
    pub(crate) controls: ControlsInput,
    #[serde(default)]
    pub(crate) audio: Option<CreatedMedia>,
    #[serde(default)]
    pub(crate) image: Option<CreatedMedia>,
    #[serde(default)]
    pub(crate) action: Option<CreateActionRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedNodes {
    pub(crate) stage_uuid: String,
    pub(crate) action_id: Option<String>,
}

pub(crate) fn unique_stage_index(
    document: &StoryDocument,
    stage_uuid: &str,
) -> Result<usize, GestureError> {
    unique_index(
        document.stage_nodes.iter().map(|stage| stage.uuid.as_str()),
        stage_uuid,
        "Stage",
        &format!("/stageNodes/@uuid={stage_uuid}#0"),
    )
}

pub(crate) fn unique_action_index(
    document: &StoryDocument,
    action_id: &str,
) -> Result<usize, GestureError> {
    unique_index(
        document
            .action_nodes
            .iter()
            .map(|action| action.id.as_str()),
        action_id,
        "ActionNode",
        &format!("/actionNodes/@id={action_id}#0"),
    )
}

/// Un identifiant dupliqué est décodable (il est refusé à l'intégrité,
/// pas à la lecture) : le geste refuse d'agir plutôt que de choisir lui-même
/// lequel des homonymes l'auteur visait.
fn unique_index<'a>(
    identifiers: impl Iterator<Item = &'a str>,
    wanted: &str,
    kind: &str,
    path: &str,
) -> Result<usize, GestureError> {
    let matches: Vec<usize> = identifiers
        .enumerate()
        .filter(|(_, identifier)| *identifier == wanted)
        .map(|(index, _)| index)
        .collect();
    match matches.as_slice() {
        [index] => Ok(*index),
        [] => Err(GestureError::new(
            "UNKNOWN_NODE",
            path,
            format!("Aucun {kind} « {wanted} » dans le document."),
        )),
        several => Err(GestureError::new(
            "AMBIGUOUS_NODE",
            path,
            format!(
                "{} {kind}s portent l'identifiant « {wanted} » : lever le doublon avant d'éditer.",
                several.len()
            ),
        )),
    }
}

fn presence_from_option(value: &Option<String>) -> Presence<String> {
    match value {
        Some(value) => Presence::Value(value.clone()),
        None => Presence::Absent,
    }
}

fn draw_unique_uuid(
    next: &mut dyn FnMut() -> Uuid,
    taken: &mut dyn FnMut(&str) -> bool,
    path: &str,
) -> Result<String, GestureError> {
    for _ in 0..UUID_DRAW_ATTEMPTS {
        let candidate = next().to_string();
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(GestureError::new(
        "IDENTIFIER_COLLISION",
        path,
        "Aucun identifiant libre obtenu : la source d'identifiants ne varie pas.".to_string(),
    ))
}

/// Crée le Stage, son ActionNode facultatif et leurs liaisons médias.
///
/// Le Stage naît `squareOne: false` **explicite** : un pack n'admet qu'une
/// entrée, et un nouvel écran ne doit jamais la devenir par accident. Ses
/// présences reproduisent celles d'un document créé par Story Studio — médias à
/// `null`, transitions absentes — pour qu'un projet neuf et un écran ajouté ne
/// portent pas deux conventions de dialecte différentes.
pub(crate) fn create_stage(
    payload: &mut DecodedStoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    request: &CreateStageRequest,
    next: &mut dyn FnMut() -> Uuid,
    media: &mut MediaBindingReport,
) -> Result<CreatedNodes, GestureError> {
    let document = &mut payload.document;
    let stage_uuid = {
        let stages = &document.stage_nodes;
        draw_unique_uuid(
            next,
            &mut |candidate| stages.iter().any(|stage| stage.uuid == candidate),
            "/stageNodes",
        )?
    };

    let action = match &request.action {
        None => None,
        Some(requested) => Some(build_action(document, requested, Some(&stage_uuid), next)?),
    };

    // Les liaisons sont résolues avant toute écriture : un média refusé ne doit
    // pas laisser derrière lui un Stage à moitié créé.
    let audio = media_presence(&request.audio, bindings, "/stageNodes/audio", media)?;
    let image = media_presence(&request.image, bindings, "/stageNodes/image", media)?;

    let created = StageNode {
        uuid: stage_uuid.clone(),
        name: presence_from_option(&request.name),
        square_one: Presence::Value(false),
        audio,
        image,
        control_settings: Presence::Value(ControlSettings::authored(
            request.controls.wheel,
            request.controls.ok,
            request.controls.home,
            request.controls.pause,
            request.controls.autoplay,
        )),
        ..StageNode::default()
    };
    document.stage_nodes.push(created);
    let action_id = action.map(|action| {
        let id = action.id.clone();
        document.action_nodes.push(action);
        id
    });

    Ok(CreatedNodes {
        stage_uuid,
        action_id,
    })
}

fn media_presence(
    requested: &Option<CreatedMedia>,
    bindings: &mut Vec<AdvancedMediaBinding>,
    path: &str,
    media: &mut MediaBindingReport,
) -> Result<Presence<String>, GestureError> {
    match requested {
        None => Ok(Presence::Null),
        Some(created) => bind_created_media(bindings, created, path, media).map(Presence::Value),
    }
}

fn build_action(
    document: &StoryDocument,
    requested: &CreateActionRequest,
    stage_uuid: Option<&str>,
    next: &mut dyn FnMut() -> Uuid,
) -> Result<ActionNode, GestureError> {
    let id = match &requested.id {
        Some(id) if id.trim().is_empty() => {
            return Err(GestureError::new(
                "INVALID_ACTION_ID",
                "/actionNodes",
                "Un identifiant d'ActionNode ne peut pas être vide.".to_string(),
            ))
        }
        // Verbatim : `action-1` est référentiellement valide et ne doit pas être
        // remplacé par un UUID au seul motif de sa graphie.
        Some(id) => {
            if document.action_nodes.iter().any(|action| action.id == *id) {
                return Err(GestureError::new(
                    "IDENTIFIER_COLLISION",
                    &format!("/actionNodes/@id={id}#0"),
                    format!("L'identifiant d'ActionNode « {id} » est déjà pris."),
                ));
            }
            id.clone()
        }
        None => draw_unique_uuid(
            next,
            &mut |candidate| {
                document
                    .action_nodes
                    .iter()
                    .any(|action| action.id == candidate)
            },
            "/actionNodes",
        )?,
    };

    let mut options = Vec::with_capacity(requested.options.len());
    for (index, option) in requested.options.iter().enumerate() {
        options.push(resolve_option_target(
            document,
            option,
            stage_uuid,
            &option_id(&id, index),
        )?);
    }

    Ok(ActionNode {
        id,
        name: presence_from_option(&requested.name),
        options,
        ..ActionNode::default()
    })
}

/// Création d'une Action **autonome**, sans Stage créé dans le même geste.
///
/// Une Action détachée est admise comme état d'auteur intermédiaire :
/// elle peut naître sans transition entrante, et même sans option. Son raccord
/// reste un geste distinct et explicite (`set-stage-transition`) : poser la
/// transition dans la création la rendrait implicite. Lorsqu'un auteur relie
/// ensuite un Écran à cette Action vide depuis le graphe, le geste dédié
/// `connect-stage-to-empty-action` réserve explicitement la première option
/// avant de poser la transition.
pub(crate) fn create_action(
    payload: &mut DecodedStoryDocument,
    request: &CreateActionRequest,
    next: &mut dyn FnMut() -> Uuid,
) -> Result<CreatedNodes, GestureError> {
    let action = build_action(&payload.document, request, None, next)?;
    let action_id = action.id.clone();
    payload.document.action_nodes.push(action);
    Ok(CreatedNodes {
        stage_uuid: String::new(),
        action_id: Some(action_id),
    })
}

/// Réassignation de l'entrée.
///
/// Après le geste, **exactement un** Stage porte `squareOne: true`. Les Stages
/// qui ne sont pas l'entrée et ne l'étaient pas ne sont pas touchés : forcer un
/// `false` explicite sur une absence détruirait une distinction de présence qu'il faut
/// protéger, sans rien apporter.
///
/// `packIdentity` n'est **pas** recalculée : elle a été acquise une fois et
/// doit rester stable à travers une réassignation d'entrée. C'est précisément
/// ce qui distingue l'identité du pack de l'entrée courante.
pub(crate) fn set_square_one(
    document: &mut StoryDocument,
    stage_uuid: &str,
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let index = unique_stage_index(document, stage_uuid)?;
    for position in 0..document.stage_nodes.len() {
        let stage = &mut document.stage_nodes[position];
        let becomes = if position == index {
            if stage.square_one == Presence::Value(true) {
                continue;
            }
            true
        } else {
            if !stage.is_square_one() {
                continue;
            }
            false
        };
        stage.square_one = Presence::Value(becomes);
        report
            .square_one
            .push(format!("/stageNodes/@uuid={}#0", stage.uuid));
    }
    Ok(())
}

/// La décision d'auteur sur une occurrence d'option qui désigne un Stage retiré.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum OptionResolution {
    /// L'occurrence garde son rang et change de destination : aucune sélection
    /// n'est touchée, donc aucune décision de transition n'est requise.
    Retarget { uuid: String },
    /// L'occurrence garde son rang, cible nulle, que le diagnostic signale.
    Null,
    /// L'occurrence disparaît : les transitions qui la visaient exactement
    /// réclament leur décision dans `selections`.
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OptionDecision {
    pub(crate) action_id: String,
    pub(crate) ordinal: usize,
    pub(crate) resolution: OptionResolution,
}

/// Le plan explicite d'un retrait de Stage.
///
/// Il n'y a pas de cascade : chaque occurrence entrante reçoit sa décision, et
/// chaque transition privée de destination la sienne. Un plan qui ne couvre pas
/// tout est refusé **avant** toute mutation, avec l'inventaire manquant.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StageRemovalPlan {
    #[serde(default)]
    pub(crate) options: Vec<OptionDecision>,
    #[serde(default)]
    pub(crate) selections: Vec<SelectionDecision>,
}

/// Le plan explicite d'un retrait d'Action : une décision par transition
/// entrante, exprimée dans la forme de `set-stage-transition`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionRemovalPlan {
    #[serde(default)]
    pub(crate) transitions: Vec<TransitionDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransitionDecision {
    pub(crate) stage_uuid: String,
    pub(crate) slot: TransitionSlot,
    pub(crate) update: TransitionUpdate,
}

pub(crate) fn delete_stage(
    payload: &mut DecodedStoryDocument,
    stage_uuid: &str,
    plan: Option<&StageRemovalPlan>,
    anchors: &mut AnchorReport,
    references: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let index = unique_stage_index(&payload.document, stage_uuid)?;
    let path = format!("/stageNodes/@uuid={stage_uuid}#0");
    if payload.document.stage_nodes[index].is_square_one() {
        return Err(GestureError::new(
            "SQUARE_ONE_REMOVAL",
            &path,
            "Le Stage d'entrée ne se retire pas : un pack a exactement un Écran d'entrée, et le transfert de l'entrée est un geste distinct."
                .to_string(),
        ));
    }
    let referencing = incoming_option_ids(&payload.document, stage_uuid);
    let Some(plan) = plan else {
        if referencing.is_empty() {
            remove_node(payload, NodeKind::Stage, index, anchors);
            return Ok(());
        }
        return Err(GestureError::new(
            "STAGE_STILL_TARGETED",
            &path,
            format!(
                "{} occurrence(s) d'options désignent encore ce Stage : il faut décider explicitement de les rediriger ou de les retirer.",
                referencing.len()
            ),
        )
        .with_references(referencing));
    };

    // Couverture exacte : ni occurrence oubliée, ni décision sans objet.
    for option in &referencing {
        let covered = plan
            .options
            .iter()
            .any(|decision| option_id(&decision.action_id, decision.ordinal) == *option);
        if !covered {
            return Err(GestureError::new(
                "OPTION_DECISION_REQUIRED",
                option,
                "Cette occurrence désigne le Stage retiré et n'a reçu aucune décision.".to_string(),
            )
            .with_references(referencing.clone()));
        }
    }
    for decision in &plan.options {
        let target = option_id(&decision.action_id, decision.ordinal);
        if !referencing.contains(&target) {
            return Err(GestureError::new(
                "UNEXPECTED_OPTION_DECISION",
                &target,
                "Cette occurrence ne désigne pas le Stage retiré : le geste n'y touche pas."
                    .to_string(),
            ));
        }
        if let OptionResolution::Retarget { uuid } = &decision.resolution {
            if uuid == stage_uuid {
                return Err(GestureError::new(
                    "UNKNOWN_STAGE",
                    &target,
                    "Le retargeting désigne le Stage que le geste retire.".to_string(),
                ));
            }
        }
    }

    // Les rangs bougent quand une occurrence est retirée : les conservations
    // d'abord, puis les retraits du rang le plus haut vers le plus bas, pour que
    // chaque ordinal reste celui que l'auteur a désigné.
    let mut decisions = DecisionBook::new(&plan.selections);
    for decision in &plan.options {
        match &decision.resolution {
            OptionResolution::Retarget { uuid } => set_option_target(
                &mut payload.document,
                &decision.action_id,
                decision.ordinal,
                &ActionOptionTarget::Stage { uuid: uuid.clone() },
                references,
            )?,
            OptionResolution::Null => set_option_target(
                &mut payload.document,
                &decision.action_id,
                decision.ordinal,
                &ActionOptionTarget::Null,
                references,
            )?,
            OptionResolution::Remove => {}
        }
    }
    let mut removals: Vec<&OptionDecision> = plan
        .options
        .iter()
        .filter(|decision| decision.resolution == OptionResolution::Remove)
        .collect();
    removals.sort_by(|left, right| {
        right
            .ordinal
            .cmp(&left.ordinal)
            .then_with(|| left.action_id.cmp(&right.action_id))
    });
    for decision in removals {
        remove_option(
            &mut payload.document,
            &decision.action_id,
            decision.ordinal,
            &mut decisions,
            references,
        )?;
    }
    decisions.unused()?;

    // Le Stage est relocalisé : les retraits d'options précédents n'ont pas
    // changé la collection des Stages, mais le relire est plus sûr que de
    // supposer un index calculé avant les mutations.
    let index = unique_stage_index(&payload.document, stage_uuid)?;
    let remaining = incoming_option_ids(&payload.document, stage_uuid);
    if !remaining.is_empty() {
        return Err(GestureError::new(
            "STAGE_STILL_TARGETED",
            &path,
            "Le plan laisse des occurrences désignant le Stage retiré.".to_string(),
        )
        .with_references(remaining));
    }
    remove_node(payload, NodeKind::Stage, index, anchors);
    Ok(())
}

pub(crate) fn delete_action(
    payload: &mut DecodedStoryDocument,
    action_id: &str,
    plan: Option<&ActionRemovalPlan>,
    anchors: &mut AnchorReport,
    references: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let index = unique_action_index(&payload.document, action_id)?;
    let path = format!("/actionNodes/@id={action_id}#0");
    let referencing = incoming_transition_paths(&payload.document, action_id);
    let Some(plan) = plan else {
        if referencing.is_empty() {
            remove_node(payload, NodeKind::Action, index, anchors);
            return Ok(());
        }
        return Err(GestureError::new(
            "ACTION_STILL_TARGETED",
            &path,
            format!(
                "{} transition(s) référencent encore cet ActionNode : les retirer ou les rediriger est une décision explicite.",
                referencing.len()
            ),
        )
        .with_references(referencing));
    };

    for transition in &referencing {
        let covered = plan
            .transitions
            .iter()
            .any(|decision| transition_path(&decision.stage_uuid, decision.slot) == *transition);
        if !covered {
            return Err(GestureError::new(
                "TRANSITION_DECISION_REQUIRED",
                transition,
                "Cette transition vise l'Action retirée et n'a reçu aucune décision.".to_string(),
            )
            .with_references(referencing.clone()));
        }
    }
    for decision in &plan.transitions {
        let target = transition_path(&decision.stage_uuid, decision.slot);
        if !referencing.contains(&target) {
            return Err(GestureError::new(
                "UNEXPECTED_TRANSITION_DECISION",
                &target,
                "Cette transition ne vise pas l'Action retirée : le geste n'y touche pas."
                    .to_string(),
            ));
        }
        if let TransitionUpdate::Set { action_node, .. } = &decision.update {
            if action_node == action_id {
                return Err(GestureError::new(
                    "UNKNOWN_ACTION",
                    &target,
                    "Le retargeting désigne l'Action que le geste retire.".to_string(),
                ));
            }
        }
    }

    for decision in &plan.transitions {
        let stage = unique_stage_index(&payload.document, &decision.stage_uuid)?;
        let before = decision
            .slot
            .read(&payload.document.stage_nodes[stage])
            .value()
            .map(|transition| transition.selection.to_dialect_index())
            .expect("transition relevée comme entrante");
        set_stage_transition(
            &mut payload.document,
            &decision.stage_uuid,
            decision.slot,
            &decision.update,
        )?;
        let after = decision
            .slot
            .read(&payload.document.stage_nodes[stage])
            .value()
            .map(|transition| transition.selection.to_dialect_index());
        references.selections.push(SelectionEffect {
            path: transition_path(&decision.stage_uuid, decision.slot),
            action_node: action_id.to_string(),
            before,
            after,
            decided: true,
        });
    }

    let index = unique_action_index(&payload.document, action_id)?;
    let remaining = incoming_transition_paths(&payload.document, action_id);
    if !remaining.is_empty() {
        return Err(GestureError::new(
            "ACTION_STILL_TARGETED",
            &path,
            "Le plan laisse des transitions visant l'Action retirée.".to_string(),
        )
        .with_references(remaining));
    }
    remove_node(payload, NodeKind::Action, index, anchors);
    Ok(())
}

#[derive(Clone, Copy)]
enum NodeKind {
    Stage,
    Action,
}

/// Retire le nœud **et** ses ancrages, dans le même geste.
///
/// Les chemins sont relevés avant et après le retrait plutôt que recalculés :
/// c'est ce qui rend le décalage d'occurrence exact sans dupliquer la règle
/// d'ancrage de `stable_node_paths`.
fn remove_node(
    payload: &mut DecodedStoryDocument,
    kind: NodeKind,
    index: usize,
    anchors: &mut AnchorReport,
) {
    let before = node_paths(&payload.document, kind);
    let removed = before[index].clone();
    match kind {
        NodeKind::Stage => {
            payload.document.stage_nodes.remove(index);
        }
        NodeKind::Action => {
            payload.document.action_nodes.remove(index);
        }
    }
    let after = node_paths(&payload.document, kind);
    let shifts = occurrence_shifts(&before, &after, index);
    rewrite_context_anchors(
        &mut payload.context,
        |path| removal_fate(&removed, &shifts, path),
        anchors,
    );
}

fn node_paths(document: &StoryDocument, kind: NodeKind) -> Vec<String> {
    match kind {
        NodeKind::Stage => {
            stable_node_paths(&document.stage_nodes, "stageNodes", "uuid", |stage| {
                stage.uuid.as_str()
            })
        }
        NodeKind::Action => {
            stable_node_paths(&document.action_nodes, "actionNodes", "id", |action| {
                action.id.as_str()
            })
        }
    }
}
