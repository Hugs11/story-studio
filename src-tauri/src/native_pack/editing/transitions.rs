//! Geste de transition : poser, remplacer ou retirer OK et HOME.
//!
//! Trois règles se croisent ici et aucune ne se déduit d'une autre :
//!
//! - une transition est un **objet complet ou rien**. Le geste
//!   ne pose jamais un `actionNode` sans sélection, ni une sélection sans
//!   `actionNode` ; l'absence d'`optionIndex` n'invente pas `Fixed(0)`.
//! - le booléen de contrôle correspondant n'est ni lu ni écrit. Une transition
//!   posée ne rend pas `ok: true`, et un `ok: false` n'empêche pas de la poser
//!   — le motif « contrôle désactivé + transition » est mesuré dans 6 packs du
//!   corpus et doit rester livrable.
//! - retirer une transition est une commande **distincte** de la
//!   désactivation d'un contrôle. Elle existe donc, explicitement, et elle est
//!   la seule à effacer une arête.
//!
//! Enfin, absent et `null` restent distincts : le retrait porte
//! sa forme, il ne choisit pas à la place de l'auteur.

use serde::{Deserialize, Serialize};

use super::options::{insert_option, ActionOptionTarget, ReferenceReport};
use super::structure::{unique_action_index, unique_stage_index};
use super::GestureError;
use crate::native_pack::{OptionSelection, Presence, StageNode, StoryDocument, Transition};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TransitionSlot {
    Ok,
    Home,
}

impl TransitionSlot {
    pub(super) fn field(self) -> &'static str {
        match self {
            TransitionSlot::Ok => "okTransition",
            TransitionSlot::Home => "homeTransition",
        }
    }

    /// Les deux emplacements d'un Stage, dans l'ordre du dialecte. Les gestes
    /// d'options parcourent **toutes** les transitions entrantes d'une Action :
    /// énumérer les emplacements ici évite que chaque appelant en oublie un.
    pub(super) fn all() -> [TransitionSlot; 2] {
        [TransitionSlot::Ok, TransitionSlot::Home]
    }

    pub(super) fn read(self, stage: &StageNode) -> &Presence<Transition> {
        match self {
            TransitionSlot::Ok => &stage.ok_transition,
            TransitionSlot::Home => &stage.home_transition,
        }
    }

    pub(super) fn write(self, stage: &mut StageNode) -> &mut Presence<Transition> {
        match self {
            TransitionSlot::Ok => &mut stage.ok_transition,
            TransitionSlot::Home => &mut stage.home_transition,
        }
    }
}

/// Les trois formes qu'une transition peut prendre après le geste.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum TransitionUpdate {
    /// Pose ou remplace : les deux membres sont obligatoires par construction.
    #[serde(rename_all = "camelCase")]
    Set {
        action_node: String,
        /// L'entier du dialecte : `-1` est `Random`, `i ≥ 0` est `Fixed(i)`, et
        /// `< -1` n'est pas représentable.
        option_index: i64,
    },
    /// Retrait sous forme `null` explicite.
    Null,
    /// Retrait par absence de clé.
    Absent,
}

pub(crate) fn set_stage_transition(
    document: &mut StoryDocument,
    stage_uuid: &str,
    slot: TransitionSlot,
    update: &TransitionUpdate,
) -> Result<(), GestureError> {
    let field = slot.field();
    let index = super::structure::unique_stage_index(document, stage_uuid)?;
    let path = format!("/stageNodes/@uuid={stage_uuid}#0/{field}");

    let presence = match update {
        TransitionUpdate::Absent => Presence::Absent,
        TransitionUpdate::Null => Presence::Null,
        TransitionUpdate::Set {
            action_node,
            option_index,
        } => {
            let selection =
                OptionSelection::from_dialect_index(*option_index).map_err(|error| {
                    GestureError::new(
                        "OPTION_INDEX_OUT_OF_DIALECT",
                        &format!("{path}/optionIndex"),
                        error.to_string(),
                    )
                })?;
            let action = document
                .action_nodes
                .iter()
                .find(|action| action.id == *action_node)
                .ok_or_else(|| {
                    GestureError::new(
                        "UNKNOWN_ACTION",
                        &format!("{path}/actionNode"),
                        format!("Aucun ActionNode « {action_node} » dans le document."),
                    )
                })?;
            // `Fixed(i)` exige `0 ≤ i < N` et `Random` exige `N ≥ 1`. Poser une
            // sélection hors bornes fabriquerait une erreur bloquante que
            // l'auteur n'a pas demandée ; le geste refuse au lieu de laisser le
            // document se dégrader.
            if !selection.is_within_bounds(action.options.len()) {
                return Err(GestureError::new(
                    "OPTION_SELECTION_OUT_OF_BOUNDS",
                    &format!("{path}/optionIndex"),
                    format!(
                        "L'ActionNode « {action_node} » porte {} option(s) : {selection} n'en désigne aucune.",
                        action.options.len()
                    ),
                ));
            }
            Presence::Value(Transition {
                action_node: action_node.clone(),
                selection,
            })
        }
    };

    *slot.write(&mut document.stage_nodes[index]) = presence;
    Ok(())
}

/// Raccorde directement un Écran à une Action encore vide.
///
/// Le graphe autorise cet ordre de construction : l'auteur peut poser
/// `Écran → Action`, puis créer l'Écran de sortie. La première occurrence est
/// donc réservée avec une cible nulle dans la même transaction que la
/// transition entrante ; aucun état intermédiaire ne peut laisser une
/// sélection hors bornes.
pub(crate) fn connect_stage_to_empty_action(
    document: &mut StoryDocument,
    stage_uuid: &str,
    slot: TransitionSlot,
    action_node: &str,
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    unique_stage_index(document, stage_uuid)?;
    let action_index = unique_action_index(document, action_node)?;
    if !document.action_nodes[action_index].options.is_empty() {
        return Err(GestureError::new(
            "ACTION_NOT_EMPTY",
            &format!("/actionNodes/@id={action_node}#0"),
            format!("L'ActionNode « {action_node} » possède déjà une ou plusieurs options."),
        ));
    }

    insert_option(document, action_node, 0, &ActionOptionTarget::Null, report)?;
    set_stage_transition(
        document,
        stage_uuid,
        slot,
        &TransitionUpdate::Set {
            action_node: action_node.to_owned(),
            option_index: 0,
        },
    )
}
