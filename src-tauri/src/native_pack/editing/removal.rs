//! Retrait d'un lot de nœuds en **une seule** transaction.
//!
//! `delete-stage` et `delete-action` visent un nœud chacun. Couper cinq nœuds
//! en cinq gestes donnerait cinq pas d'annulation pour un seul geste d'auteur,
//! et laisserait deux nœuds partis et trois restés si le troisième était
//! refusé. C'est exactement ce que `paste.rs` évite côté collage.
//!
//! **Le plan reste explicite, et il porte sur ce qui survit.** Une référence
//! qui vient d'un nœud que le geste retire aussi ne demande aucune décision :
//! elle disparaît avec son porteur dans la même transaction, et il n'y a rien
//! à décider du sort de quelque chose qui ne survit pas. Une référence venue
//! du **dehors**, elle, survit et perd sa destination : c'est
//! une décision d'auteur, et le geste exige sa couverture exacte — ni
//! occurrence oubliée, ni décision sans objet. L'invariant « aucune cascade
//! implicite » est donc tenu au seul endroit où il veut dire quelque chose.
//!
//! **Rien n'est réimplémenté.** Les références entrant dans le lot sont
//! d'abord annulées — celles du dehors selon le plan de l'auteur, celles du
//! dedans parce que leur porteur s'en va —, après quoi plus aucun nœud du lot
//! n'est désigné. `delete_stage` et `delete_action` sont alors appelés **sans
//! plan** et empruntent leur chemin court : mêmes gardes, même retrait de
//! nœud, mêmes ancrages réécrits. Les règles de couverture ne sont pas
//! recopiées ici ; elles ne s'appliquent simplement plus, le lot étant propre.
//!
//! **`Remove` n'est pas offert sur un lot.** Retirer une occupation de rang
//! décale les rangs suivants, et demanderait de rejouer les ordinaux d'un plan
//! à l'autre. La coupe n'en a pas besoin : elle met les cibles à `null`.
//! Le retrait d'un Écran emploie son propre geste, qui retire ses occurrences
//! dans un ordre déterministe.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use super::anchors::AnchorReport;
use super::options::{
    incoming_option_ids, incoming_transition_paths, option_id, set_option_target, transition_path,
    ActionOptionTarget, ReferenceReport,
};
use super::structure::{
    delete_action, delete_stage, unique_action_index, unique_stage_index, OptionDecision,
    OptionResolution, TransitionDecision,
};
use super::transitions::{set_stage_transition, TransitionSlot, TransitionUpdate};
use super::GestureError;
use crate::native_pack::{DecodedStoryDocument, Presence, SeveredTransition, StoryDocument};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteSubgraphRequest {
    #[serde(default)]
    pub(crate) stages: Vec<String>,
    #[serde(default)]
    pub(crate) actions: Vec<String>,
    /// Le sort des occurrences d'options **survivantes** qui désignent un Écran
    /// retiré. Une occurrence portée par une Action elle-même retirée n'y est
    /// pas, et n'y a pas sa place.
    #[serde(default)]
    pub(crate) options: Vec<OptionDecision>,
    /// Le sort des transitions **survivantes** qui visent une Action retirée.
    #[serde(default)]
    pub(crate) transitions: Vec<TransitionDecision>,
}

fn invalid(message: String) -> GestureError {
    GestureError::new("INVALID_REMOVAL", "/subgraph", message)
}

fn mark_severed(payload: &mut DecodedStoryDocument, stage_uuid: &str, slot: TransitionSlot) {
    let path = transition_path(stage_uuid, slot);
    if payload
        .context
        .severed_transitions
        .iter()
        .any(|severed| severed.path == path)
    {
        return;
    }
    payload
        .context
        .severed_transitions
        .push(SeveredTransition { path });
}

/// Un retrait de nœud ou d'option peut rompre une transition survivante,
/// exactement comme une coupe. La forme choisie (null ou absente) n'efface pas
/// cette provenance ; un nouveau raccord ou la désactivation explicite du
/// contrôle l'efface.
pub(super) fn mark_transitions_severed_by_removal(
    payload: &mut DecodedStoryDocument,
    previously_linked: &[(String, TransitionSlot)],
) {
    let surviving = payload
        .document
        .stage_nodes
        .iter()
        .map(|stage| (stage.uuid.as_str(), stage))
        .collect::<HashMap<_, _>>();
    let lost = previously_linked
        .iter()
        .filter(|(uuid, slot)| {
            surviving
                .get(uuid.as_str())
                .is_some_and(|stage| !slot.read(stage).is_value())
        })
        .cloned()
        .collect::<Vec<_>>();
    for (uuid, slot) in lost {
        mark_severed(payload, &uuid, slot);
    }
}

/// Les marques que le document a cessé de justifier.
///
/// Une marque dit « cette transition a été coupée et n'a pas été refaite ».
/// Dès que la transition retrouve une valeur ou que son bouton est explicitement
/// désactivé, elle n'a plus rien à signaler et s'efface. La
/// purge est centrale et passe après **chaque** geste : aucun chemin d'écriture
/// n'a donc à penser à effacer une marque qu'il vient de rendre caduque.
pub(crate) fn prune_severed_transitions(payload: &mut DecodedStoryDocument) {
    let document = &payload.document;
    payload.context.severed_transitions.retain(|severed| {
        !document.stage_nodes.iter().any(|stage| {
            TransitionSlot::all().into_iter().any(|slot| {
                if transition_path(&stage.uuid, slot) != severed.path {
                    return false;
                }
                if slot.read(stage).is_value() {
                    return true;
                }
                stage
                    .control_settings
                    .value()
                    .is_some_and(|controls| match slot {
                        TransitionSlot::Ok => {
                            controls.ok == Presence::Value(false)
                                && controls.autoplay == Presence::Value(false)
                        }
                        TransitionSlot::Home => controls.home == Presence::Value(false),
                    })
            })
        })
    });
}

/// Les occurrences d'options qui désignent `stage_uuid` **et** que le geste ne
/// retire pas. Ce sont celles, et seulement celles, dont le sort est une
/// décision d'auteur.
fn surviving_options(
    document: &StoryDocument,
    stage_uuid: &str,
    removed_actions: &HashSet<&str>,
) -> Vec<String> {
    document
        .action_nodes
        .iter()
        .filter(|action| !removed_actions.contains(action.id.as_str()))
        .flat_map(|action| {
            action
                .options
                .iter()
                .enumerate()
                .filter(|(_, option)| option.as_deref() == Some(stage_uuid))
                .map(|(ordinal, _)| option_id(&action.id, ordinal))
        })
        .collect()
}

/// Les transitions qui visent `action_id` **et** que le geste ne retire pas.
fn surviving_transitions(
    document: &StoryDocument,
    action_id: &str,
    removed_stages: &HashSet<&str>,
) -> Vec<String> {
    document
        .stage_nodes
        .iter()
        .filter(|stage| !removed_stages.contains(stage.uuid.as_str()))
        .flat_map(|stage| {
            TransitionSlot::all().into_iter().filter_map(move |slot| {
                slot.read(stage)
                    .value()
                    .filter(|transition| transition.action_node == action_id)
                    .map(|_| transition_path(&stage.uuid, slot))
            })
        })
        .collect()
}

fn check_unique(identifiers: &[String], label: &str) -> Result<(), GestureError> {
    let mut seen = HashSet::new();
    for identifier in identifiers {
        if !seen.insert(identifier.as_str()) {
            return Err(invalid(format!(
                "Le {label} « {identifier} » est nommé deux fois dans le même retrait."
            )));
        }
    }
    Ok(())
}

pub(crate) fn delete_subgraph(
    payload: &mut DecodedStoryDocument,
    request: &DeleteSubgraphRequest,
    anchors: &mut AnchorReport,
    references: &mut ReferenceReport,
) -> Result<(), GestureError> {
    if request.stages.is_empty() && request.actions.is_empty() {
        return Err(invalid("Aucun nœud à retirer.".to_string()));
    }
    check_unique(&request.stages, "Stage")?;
    check_unique(&request.actions, "ActionNode")?;

    // Tout est vérifié avant la première écriture : un identifiant inconnu ou
    // ambigu doit refuser le lot entier, pas la moitié.
    for stage_uuid in &request.stages {
        let index = unique_stage_index(&payload.document, stage_uuid)?;
        if payload.document.stage_nodes[index].is_square_one() {
            return Err(GestureError::new(
                "SQUARE_ONE_REMOVAL",
                &format!("/stageNodes/@uuid={stage_uuid}#0"),
                "Le Stage d'entrée ne se retire pas : un pack a exactement un Écran d'entrée, et le transfert de l'entrée est un geste distinct."
                    .to_string(),
            ));
        }
    }
    for action_id in &request.actions {
        unique_action_index(&payload.document, action_id)?;
    }

    let removed_stages: HashSet<&str> = request.stages.iter().map(String::as_str).collect();
    let removed_actions: HashSet<&str> = request.actions.iter().map(String::as_str).collect();

    // --- Couverture exacte du plan, sur les seules références survivantes ---
    let mut expected_options: Vec<String> = Vec::new();
    for stage_uuid in &request.stages {
        expected_options.extend(surviving_options(
            &payload.document,
            stage_uuid,
            &removed_actions,
        ));
    }
    for option in &expected_options {
        let covered = request
            .options
            .iter()
            .any(|decision| option_id(&decision.action_id, decision.ordinal) == *option);
        if !covered {
            return Err(GestureError::new(
                "OPTION_DECISION_REQUIRED",
                option,
                "Cette occurrence survit au retrait et désigne un Écran retiré : elle n'a reçu aucune décision."
                    .to_string(),
            )
            .with_references(expected_options.clone()));
        }
    }
    for decision in &request.options {
        let target = option_id(&decision.action_id, decision.ordinal);
        if !expected_options.contains(&target) {
            return Err(GestureError::new(
                "UNEXPECTED_OPTION_DECISION",
                &target,
                "Cette occupation de rang ne survit pas au retrait, ou ne désigne aucun Écran retiré : le geste n'y touche pas."
                    .to_string(),
            ));
        }
        match &decision.resolution {
            OptionResolution::Remove => {
                return Err(GestureError::new(
                    "UNSUPPORTED_REMOVAL_RESOLUTION",
                    &target,
                    "Un retrait par lot ne retire pas d'occupation de rang : les rangs suivants glisseraient d'un plan à l'autre. Retirer un rang se fait par `delete-stage`."
                        .to_string(),
                ))
            }
            OptionResolution::Retarget { uuid } if removed_stages.contains(uuid.as_str()) => {
                return Err(GestureError::new(
                    "UNKNOWN_STAGE",
                    &target,
                    "Le retargeting désigne un Stage que le geste retire.".to_string(),
                ))
            }
            _ => {}
        }
    }

    let mut expected_transitions: Vec<String> = Vec::new();
    for action_id in &request.actions {
        expected_transitions.extend(surviving_transitions(
            &payload.document,
            action_id,
            &removed_stages,
        ));
    }
    for transition in &expected_transitions {
        let covered = request
            .transitions
            .iter()
            .any(|decision| transition_path(&decision.stage_uuid, decision.slot) == *transition);
        if !covered {
            return Err(GestureError::new(
                "TRANSITION_DECISION_REQUIRED",
                transition,
                "Cette transition survit au retrait et vise une Action retirée : elle n'a reçu aucune décision."
                    .to_string(),
            )
            .with_references(expected_transitions.clone()));
        }
    }
    for decision in &request.transitions {
        let target = transition_path(&decision.stage_uuid, decision.slot);
        if !expected_transitions.contains(&target) {
            return Err(GestureError::new(
                "UNEXPECTED_TRANSITION_DECISION",
                &target,
                "Cette transition ne survit pas au retrait, ou ne vise aucune Action retirée : le geste n'y touche pas."
                    .to_string(),
            ));
        }
        if let TransitionUpdate::Set { action_node, .. } = &decision.update {
            if removed_actions.contains(action_node.as_str()) {
                return Err(GestureError::new(
                    "UNKNOWN_ACTION",
                    &target,
                    "Le retargeting désigne une Action que le geste retire.".to_string(),
                ));
            }
        }
    }

    // --- Application : le dehors selon le plan, le dedans parce qu'il s'en va
    for decision in &request.options {
        let target = match &decision.resolution {
            OptionResolution::Retarget { uuid } => ActionOptionTarget::Stage { uuid: uuid.clone() },
            _ => ActionOptionTarget::Null,
        };
        set_option_target(
            &mut payload.document,
            &decision.action_id,
            decision.ordinal,
            &target,
            references,
        )?;
    }
    for decision in &request.transitions {
        set_stage_transition(
            &mut payload.document,
            &decision.stage_uuid,
            decision.slot,
            &decision.update,
        )?;
        // La marque de rupture. Elle n'est posée que là : un Écran **survivant**
        // qui menait quelque part et n'y mène plus parce que le geste a retiré
        // sa destination. Un reciblage n'en pose pas — la plomberie est refaite.
        //
        // C'est le seul témoin de la différence entre « cet Écran est la fin de
        // l'histoire » et « on vient de couper l'Action d'en dessous » : le
        // document, lui, montre exactement la même chose dans les deux cas.
        if !matches!(decision.update, TransitionUpdate::Set { .. }) {
            mark_severed(payload, &decision.stage_uuid, decision.slot);
        }
    }

    // Les références internes au lot. Elles ne survivent pas, donc elles n'ont
    // pas de décision ; on les délie tout de même pour que chaque retrait
    // emprunte le chemin sans plan de `delete_stage` / `delete_action`.
    for stage_uuid in &request.stages {
        let inside: Vec<(String, usize)> = payload
            .document
            .action_nodes
            .iter()
            .filter(|action| removed_actions.contains(action.id.as_str()))
            .flat_map(|action| {
                action
                    .options
                    .iter()
                    .enumerate()
                    .filter(|(_, option)| option.as_deref() == Some(stage_uuid.as_str()))
                    .map(|(ordinal, _)| (action.id.clone(), ordinal))
                    .collect::<Vec<_>>()
            })
            .collect();
        for (action_id, ordinal) in inside {
            set_option_target(
                &mut payload.document,
                &action_id,
                ordinal,
                &ActionOptionTarget::Null,
                references,
            )?;
        }
    }
    for action_id in &request.actions {
        let inside: Vec<(String, TransitionSlot)> = payload
            .document
            .stage_nodes
            .iter()
            .filter(|stage| removed_stages.contains(stage.uuid.as_str()))
            .flat_map(|stage| {
                TransitionSlot::all()
                    .into_iter()
                    .filter(|slot| {
                        slot.read(stage)
                            .value()
                            .is_some_and(|transition| transition.action_node == *action_id)
                    })
                    .map(|slot| (stage.uuid.clone(), slot))
                    .collect::<Vec<_>>()
            })
            .collect();
        for (stage_uuid, slot) in inside {
            set_stage_transition(
                &mut payload.document,
                &stage_uuid,
                slot,
                &TransitionUpdate::Null,
            )?;
        }
    }

    // --- Le lot est propre : chaque retrait emprunte son chemin sans plan ---
    for stage_uuid in &request.stages {
        debug_assert!(incoming_option_ids(&payload.document, stage_uuid).is_empty());
        delete_stage(payload, stage_uuid, None, anchors, references)?;
    }
    for action_id in &request.actions {
        debug_assert!(incoming_transition_paths(&payload.document, action_id).is_empty());
        delete_action(payload, action_id, None, anchors, references)?;
    }
    Ok(())
}
