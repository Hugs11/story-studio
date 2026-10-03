//! Constructions d'auteur : uniquement des Stages/Actions ordinaires.
//! Le payload privé du geste porte toute la construction ; aucun état partiel
//! n'est publié, même si un raccord ou un média est refusé en fin d'opération.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::controls::{activate_slot_control, set_stage_controls, ControlsUpdate};
use super::media::MediaBindingReport;
use super::options::{insert_option, set_option_target, ActionOptionTarget, ReferenceReport};
use super::positions::{
    place_authored, LayoutEntry, NodeKind, NodeRef, PositionInput, PositionReport,
};
use super::structure::{
    create_action, create_stage, unique_action_index, unique_stage_index, ControlsInput,
    CreateActionRequest, CreateStageRequest, CreatedNodes,
};
use super::transitions::{set_stage_transition, TransitionSlot, TransitionUpdate};
use super::GestureError;
use crate::native_pack::persistence::AdvancedMediaBinding;
use crate::native_pack::DecodedStoryDocument;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConstructionKind {
    Scene,
    Choice,
    Sequence,
    Random,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConstructionItem {
    pub(crate) name: String,
    /// Choix : suite après validation. Hasard : écran existant à réutiliser.
    pub(crate) target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConstructionSource {
    pub(crate) stage_uuid: String,
    pub(crate) slot: TransitionSlot,
    /// Modification distincte et explicite des contrôles de l'écran source.
    pub(crate) controls: ControlsUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateConstructionRequest {
    pub(crate) kind: ConstructionKind,
    pub(crate) name: String,
    pub(crate) items: Vec<ConstructionItem>,
    pub(crate) controls: ControlsInput,
    pub(crate) option_controls: ControlsInput,
    pub(crate) question: bool,
    pub(crate) destination: Option<String>,
    pub(crate) source: Option<ConstructionSource>,
}

/// Création déposée depuis une prise du graphe. Les deux variantes portent la
/// création et son raccord dans **une seule** demande : le codec ne publie le
/// document suivant que si la dernière validation a elle aussi réussi.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "direction", rename_all = "kebab-case")]
pub(crate) enum CreateLinkedNodeRequest {
    #[serde(rename_all = "camelCase")]
    StageToAction {
        stage_uuid: String,
        slot: TransitionSlot,
        action: CreateActionRequest,
        option_index: i64,
        /// Allume la touche qu'exige `slot` (OK ou HOME) avec le raccord.
        #[serde(default)]
        activate_control: bool,
        position: PositionInput,
    },
    #[serde(rename_all = "camelCase")]
    ActionToStage {
        action_id: String,
        index: usize,
        #[serde(default)]
        replace_missing: bool,
        stage: CreateStageRequest,
        position: PositionInput,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConstructionTransition {
    pub(crate) stage_uuid: String,
    pub(crate) slot: TransitionSlot,
    pub(crate) action_id: String,
    pub(crate) option_index: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConstructionReport {
    pub(crate) stages: Vec<String>,
    pub(crate) actions: Vec<String>,
    pub(crate) transitions: Vec<ConstructionTransition>,
    pub(crate) connected: bool,
}

struct Builder<'a> {
    payload: &'a mut DecodedStoryDocument,
    bindings: &'a mut Vec<AdvancedMediaBinding>,
    next: &'a mut dyn FnMut() -> Uuid,
    media: &'a mut MediaBindingReport,
    report: ConstructionReport,
}

/// Un Écran que la construction laisse sans destination OK naît en fin
/// valide sur la Lunii : OK et lecture automatique désactivés, Accueil actif
/// (sans destination, il ramène au début). Les autres gardent leurs réglages.
fn controls_for(controls: &ControlsInput, has_ok_destination: bool) -> ControlsInput {
    if has_ok_destination {
        return controls.clone();
    }
    ControlsInput {
        ok: false,
        autoplay: false,
        home: true,
        ..controls.clone()
    }
}

impl Builder<'_> {
    fn stage(
        &mut self,
        name: &str,
        controls: &ControlsInput,
        has_ok_destination: bool,
    ) -> Result<String, GestureError> {
        let created = create_stage(
            self.payload,
            self.bindings,
            &CreateStageRequest {
                name: Some(name.to_owned()),
                controls: controls_for(controls, has_ok_destination),
                audio: None,
                image: None,
                action: None,
            },
            self.next,
            self.media,
        )?;
        self.report.stages.push(created.stage_uuid.clone());
        Ok(created.stage_uuid)
    }

    fn action(&mut self, name: &str, targets: &[String]) -> Result<String, GestureError> {
        let created = create_action(
            self.payload,
            &CreateActionRequest {
                id: None,
                name: Some(name.to_owned()),
                options: targets
                    .iter()
                    .map(|uuid| ActionOptionTarget::Stage { uuid: uuid.clone() })
                    .collect(),
            },
            self.next,
        )?;
        let id = created
            .action_id
            .expect("create_action rend l'identifiant créé");
        self.report.actions.push(id.clone());
        Ok(id)
    }

    fn transition(
        &mut self,
        stage: &str,
        slot: TransitionSlot,
        action: &str,
        index: i64,
    ) -> Result<(), GestureError> {
        set_stage_transition(
            &mut self.payload.document,
            stage,
            slot,
            &TransitionUpdate::Set {
                action_node: action.to_owned(),
                option_index: index,
            },
        )?;
        self.report.transitions.push(ConstructionTransition {
            stage_uuid: stage.to_owned(),
            slot,
            action_id: action.to_owned(),
            option_index: index,
        });
        Ok(())
    }

    fn route(
        &mut self,
        stage: &str,
        target: &str,
        slot: TransitionSlot,
    ) -> Result<(), GestureError> {
        let index = unique_stage_index(&self.payload.document, target)?;
        let label = self.payload.document.stage_nodes[index]
            .name
            .value()
            .filter(|name| !name.trim().is_empty())
            .map(String::as_str)
            .unwrap_or(target);
        let name = format!("Vers {label}");
        let action = self.action(&name, &[target.to_owned()])?;
        self.transition(stage, slot, &action, 0)
    }
}

fn invalid(message: &str) -> GestureError {
    GestureError::new("INVALID_CONSTRUCTION", "/construction", message.to_owned())
}

pub(crate) fn create_construction(
    payload: &mut DecodedStoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    request: &CreateConstructionRequest,
    next: &mut dyn FnMut() -> Uuid,
    media: &mut MediaBindingReport,
) -> Result<(CreatedNodes, ConstructionReport), GestureError> {
    use ConstructionKind::*;
    if request.name.trim().is_empty() {
        return Err(invalid("Donner un nom à la construction."));
    }
    let minimum = match request.kind {
        Scene => 0,
        Sequence => 1,
        Choice | Random => 2,
    };
    if request.items.len() < minimum || (request.kind == Scene && !request.items.is_empty()) {
        return Err(invalid(
            "Le nombre de passages ou de propositions ne convient pas à cette construction.",
        ));
    }
    if request.kind == Random && request.source.is_none() {
        return Err(invalid(
            "Le tirage au sort exige une transition entrante explicite.",
        ));
    }
    if request.question && request.kind != Choice {
        return Err(invalid(
            "La question appartient uniquement à la construction Choix.",
        ));
    }
    for item in &request.items {
        if item.name.trim().is_empty() && !(request.kind == Random && item.target.is_some()) {
            return Err(invalid("Nommer chaque nouveau passage ou proposition."));
        }
        if request.kind == Sequence && item.target.is_some() {
            return Err(invalid(
                "Une séquence crée ses passages ; sa destination finale est distincte.",
            ));
        }
        if let Some(target) = &item.target {
            unique_stage_index(&payload.document, target)?;
        }
    }
    if let Some(target) = &request.destination {
        unique_stage_index(&payload.document, target)?;
    }
    if let Some(source) = &request.source {
        unique_stage_index(&payload.document, &source.stage_uuid)?;
    }

    let mut builder = Builder {
        payload,
        bindings,
        next,
        media,
        report: ConstructionReport::default(),
    };
    let (entry_stage, entry_action) = match request.kind {
        Scene => {
            let stage = builder.stage(
                &request.name,
                &request.controls,
                request.destination.is_some(),
            )?;
            if let Some(target) = &request.destination {
                builder.route(&stage, target, TransitionSlot::Ok)?;
            }
            (Some(stage), None)
        }
        Sequence => {
            let mut stages = Vec::new();
            let last = request.items.len() - 1;
            for (index, item) in request.items.iter().enumerate() {
                stages.push(builder.stage(
                    &item.name,
                    &request.controls,
                    index < last || request.destination.is_some(),
                )?);
            }
            for pair in stages.windows(2) {
                builder.route(&pair[0], &pair[1], TransitionSlot::Ok)?;
            }
            if let Some(target) = &request.destination {
                builder.route(
                    stages.last().expect("séquence non vide"),
                    target,
                    TransitionSlot::Ok,
                )?;
            }
            (Some(stages[0].clone()), None)
        }
        Choice | Random => {
            let mut targets = Vec::new();
            for item in &request.items {
                if request.kind == Random {
                    if let Some(target) = &item.target {
                        targets.push(target.clone());
                        continue;
                    }
                }
                let controls = if request.kind == Choice {
                    &request.option_controls
                } else {
                    &request.controls
                };
                let target = item.target.as_ref().or(request.destination.as_ref());
                let stage = builder.stage(&item.name, controls, target.is_some())?;
                if let Some(target) = target {
                    builder.route(&stage, target, TransitionSlot::Ok)?;
                }
                targets.push(stage);
            }
            let action = builder.action(&request.name, &targets)?;
            if request.question {
                let stage = builder.stage(&request.name, &request.controls, true)?;
                builder.transition(&stage, TransitionSlot::Ok, &action, 0)?;
                (Some(stage), Some(action))
            } else {
                (None, Some(action))
            }
        }
    };
    if let Some(source) = &request.source {
        if let Some(stage) = &entry_stage {
            builder.route(&source.stage_uuid, stage, source.slot)?;
        } else if let Some(action) = &entry_action {
            builder.transition(
                &source.stage_uuid,
                source.slot,
                action,
                if request.kind == Random { -1 } else { 0 },
            )?;
        }
        set_stage_controls(
            &mut builder.payload.document,
            &source.stage_uuid,
            &source.controls,
        )?;
        builder.report.connected = true;
    }
    Ok((
        CreatedNodes {
            stage_uuid: entry_stage.unwrap_or_default(),
            action_id: entry_action,
        },
        builder.report,
    ))
}

pub(crate) fn create_linked_node(
    payload: &mut DecodedStoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    request: &CreateLinkedNodeRequest,
    next: &mut dyn FnMut() -> Uuid,
    media: &mut MediaBindingReport,
    references: &mut ReferenceReport,
    positions: &mut PositionReport,
) -> Result<(CreatedNodes, ConstructionReport), GestureError> {
    match request {
        CreateLinkedNodeRequest::StageToAction {
            stage_uuid,
            slot,
            action,
            option_index,
            activate_control,
            position,
        } => {
            unique_stage_index(&payload.document, stage_uuid)?;
            if action.options.is_empty() {
                return Err(invalid(
                    "Une Action créée depuis un raccord porte au moins une option.",
                ));
            }
            if *option_index < -1 || *option_index >= action.options.len() as i64 {
                return Err(invalid(
                    "L'option choisie doit appartenir à l'Action créée, ou être aléatoire.",
                ));
            }
            let created = create_action(payload, action, next)?;
            if *activate_control {
                activate_slot_control(&mut payload.document, stage_uuid, *slot)?;
            }
            let action_id = created
                .action_id
                .as_ref()
                .expect("create_action rend l'identifiant créé")
                .clone();
            set_stage_transition(
                &mut payload.document,
                stage_uuid,
                *slot,
                &TransitionUpdate::Set {
                    action_node: action_id.clone(),
                    option_index: *option_index,
                },
            )?;
            place_authored(
                payload,
                &[LayoutEntry {
                    node: NodeRef {
                        kind: NodeKind::Action,
                        id: action_id.clone(),
                    },
                    position: position.clone(),
                }],
                positions,
            )?;
            Ok((
                created,
                ConstructionReport {
                    actions: vec![action_id.clone()],
                    transitions: vec![ConstructionTransition {
                        stage_uuid: stage_uuid.clone(),
                        slot: *slot,
                        action_id,
                        option_index: *option_index,
                    }],
                    connected: true,
                    ..ConstructionReport::default()
                },
            ))
        }
        CreateLinkedNodeRequest::ActionToStage {
            action_id,
            index,
            replace_missing,
            stage,
            position,
        } => {
            if *replace_missing {
                let action_index = unique_action_index(&payload.document, action_id)?;
                if payload.document.action_nodes[action_index]
                    .options
                    .get(*index)
                    != Some(&None)
                {
                    return Err(invalid(
                        "La destination à compléter n'existe plus à cette place.",
                    ));
                }
            }
            let created = create_stage(payload, bindings, stage, next, media)?;
            let target = ActionOptionTarget::Stage {
                uuid: created.stage_uuid.clone(),
            };
            if *replace_missing {
                set_option_target(
                    &mut payload.document,
                    action_id,
                    *index,
                    &target,
                    references,
                )?;
            } else {
                insert_option(
                    &mut payload.document,
                    action_id,
                    *index,
                    &target,
                    references,
                )?;
            }
            place_authored(
                payload,
                &[LayoutEntry {
                    node: NodeRef {
                        kind: NodeKind::Stage,
                        id: created.stage_uuid.clone(),
                    },
                    position: position.clone(),
                }],
                positions,
            )?;
            Ok((
                created.clone(),
                ConstructionReport {
                    stages: vec![created.stage_uuid],
                    connected: true,
                    ..ConstructionReport::default()
                },
            ))
        }
    }
}
