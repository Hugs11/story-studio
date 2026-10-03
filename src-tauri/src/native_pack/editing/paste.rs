//! Collage d'un sous-graphe : N Écrans, M Actions et leurs raccords **en une
//! seule transaction**.
//!
//! Le geste existe pour cette atomicité et pour rien d'autre. Un collage parti
//! en N gestes donnerait N pas d'annulation pour un seul geste d'auteur, et
//! laisserait un état à moitié collé si l'un d'eux était refusé — deux Écrans
//! posés, leur Action manquante, et une plomberie que personne n'a demandée.
//!
//! **Le collage est clos sur lui-même.** Une option ne peut désigner qu'un
//! Écran de ce même collage, par son rang, et une transition qu'une de ses
//! Actions. C'est le choix retenu : les raccords internes à la sélection sont
//! recopiés, ceux qui en sortent sont perdus, et c'est aussi ce qui empêche la
//! demande de forger une référence vers un nœud que l'auteur n'a pas visé.
//! Raccorder le collage au graphe existant reste un geste distinct, celui que
//! l'auteur fait ensuite à la souris.
//!
//! **Rien n'est recréé ici.** Chaque Écran passe par `create_stage` et chaque
//! Action par `create_action` : identifiants tirés du CSPRNG,
//! `squareOne: false` explicite (un Écran collé ne devient jamais l'entrée),
//! médias liés par `bind_created_media`, et transitions posées par
//! `set_stage_transition`, qui seul juge les bornes de sélection. Un collage
//! n'est pas une seconde façon de créer un nœud.

use serde::Deserialize;
use uuid::Uuid;

use super::constructions::{ConstructionReport, ConstructionTransition};
use super::media::{CreatedMedia, MediaBindingReport};
use super::options::ActionOptionTarget;
use super::positions::{
    place_authored, LayoutEntry, NodeKind, NodeRef, PositionInput, PositionReport,
};
use super::structure::{
    create_action, create_stage, ControlsInput, CreateActionRequest, CreateStageRequest,
    CreatedNodes,
};
use super::transitions::{set_stage_transition, TransitionSlot, TransitionUpdate};
use super::GestureError;
use crate::native_pack::persistence::AdvancedMediaBinding;
use crate::native_pack::DecodedStoryDocument;

/// Un Écran collé. Volontairement **plus étroit** que `CreateStageRequest` :
/// son `action` imbriquée créerait une Action qu'aucun rang ne désigne, donc
/// invisible aux options et aux transitions du collage.
///
/// `controls` reste les cinq booléens. Un Écran source aux contrôles partiels
/// est donc collé **complet**, aux valeurs observées : un objet partiel est une
/// forme d'entrée admise à l'import, jamais une chose que Story Studio
/// fabrique, et la création d'un Écran n'en a jamais produit.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PasteStage {
    #[serde(default)]
    pub(crate) name: Option<String>,
    pub(crate) controls: ControlsInput,
    /// Le média est **partagé**, pas dupliqué, et suit la règle de
    /// `bind_created_media`. Sans emplacement, la référence doit déjà être
    /// liée dans ce projet et la liaison est réutilisée — le collage dans le
    /// projet de la copie. Avec emplacement, la référence doit être libre et
    /// une liaison neuve est créée vers le fichier de la source — le collage
    /// venu d'un autre document, dont le presse-papier emporte le fichier.
    /// Le choix entre les deux revient à l'appelant ; une référence inconnue
    /// sans emplacement ressort en `UNBOUND_ASSET_REF` au lieu d'être liée à
    /// un fichier inventé.
    #[serde(default)]
    pub(crate) audio: Option<CreatedMedia>,
    #[serde(default)]
    pub(crate) image: Option<CreatedMedia>,
    #[serde(default)]
    pub(crate) position: Option<PositionInput>,
}

/// La destination d'une occurrence d'option, **par rang dans le collage**.
///
/// Un UUID serait celui du nœud d'origine : l'exprimer par un rang est ce qui
/// fait qu'un motif collé se raccorde à sa propre copie et non à son modèle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "target", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum PasteOptionTarget {
    Stage {
        stage: usize,
    },
    /// Un rang réservé sans destination est une forme légitime.
    /// C'est ce que devient une option qui sortait de la sélection copiée.
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PasteAction {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) options: Vec<PasteOptionTarget>,
    #[serde(default)]
    pub(crate) position: Option<PositionInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PasteTransition {
    pub(crate) stage: usize,
    pub(crate) slot: TransitionSlot,
    pub(crate) action: usize,
    /// L'entier du dialecte : `-1` est `Random`, `i ≥ 0` est `Fixed(i)`.
    pub(crate) option_index: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PasteSubgraphRequest {
    #[serde(default)]
    pub(crate) stages: Vec<PasteStage>,
    #[serde(default)]
    pub(crate) actions: Vec<PasteAction>,
    #[serde(default)]
    pub(crate) transitions: Vec<PasteTransition>,
}

fn invalid(message: String) -> GestureError {
    GestureError::new("INVALID_PASTE", "/subgraph", message)
}

/// Les rangs sont vérifiés **avant** la première écriture, parce qu'un rang
/// hors du collage indexerait un tableau et paniquerait. Les bornes de
/// sélection, elles, ne sont pas rejugées ici : `set_stage_transition` les
/// tient déjà, et les recopier serait une seconde règle à maintenir. Un refus
/// survenu après des écritures ne publie rien — le document muté est local au
/// geste et part avec lui.
fn check_ranks(request: &PasteSubgraphRequest) -> Result<(), GestureError> {
    for (rank, action) in request.actions.iter().enumerate() {
        for (ordinal, option) in action.options.iter().enumerate() {
            if let PasteOptionTarget::Stage { stage } = option {
                if *stage >= request.stages.len() {
                    return Err(invalid(format!(
                        "L'option {ordinal} de l'Action collée {rank} désigne un Écran hors du collage."
                    )));
                }
            }
        }
    }
    for transition in &request.transitions {
        if transition.stage >= request.stages.len() {
            return Err(invalid(format!(
                "Une transition collée part d'un Écran hors du collage (rang {}).",
                transition.stage
            )));
        }
        if transition.action >= request.actions.len() {
            return Err(invalid(format!(
                "Une transition collée mène à une Action hors du collage (rang {}).",
                transition.action
            )));
        }
    }
    Ok(())
}

pub(crate) fn paste_subgraph(
    payload: &mut DecodedStoryDocument,
    bindings: &mut Vec<AdvancedMediaBinding>,
    request: &PasteSubgraphRequest,
    next: &mut dyn FnMut() -> Uuid,
    media: &mut MediaBindingReport,
    positions: &mut PositionReport,
) -> Result<(CreatedNodes, ConstructionReport), GestureError> {
    if request.stages.is_empty() && request.actions.is_empty() {
        return Err(invalid(
            "Le presse-papier ne porte aucun nœud à coller.".to_string(),
        ));
    }
    check_ranks(request)?;

    // Les Écrans d'abord : une option ne peut désigner qu'un Écran du collage,
    // et il doit exister quand `resolve_option_target` la résout.
    let mut stages = Vec::with_capacity(request.stages.len());
    for stage in &request.stages {
        let created = create_stage(
            payload,
            bindings,
            &CreateStageRequest {
                name: stage.name.clone(),
                controls: stage.controls.clone(),
                audio: stage.audio.clone(),
                image: stage.image.clone(),
                action: None,
            },
            next,
            media,
        )?;
        stages.push(created.stage_uuid);
    }

    let mut actions = Vec::with_capacity(request.actions.len());
    for action in &request.actions {
        let created = create_action(
            payload,
            &CreateActionRequest {
                id: None,
                name: action.name.clone(),
                options: action
                    .options
                    .iter()
                    .map(|option| match option {
                        PasteOptionTarget::Stage { stage } => ActionOptionTarget::Stage {
                            uuid: stages[*stage].clone(),
                        },
                        PasteOptionTarget::Null => ActionOptionTarget::Null,
                    })
                    .collect(),
            },
            next,
        )?;
        actions.push(
            created
                .action_id
                .expect("create_action rend l'identifiant créé"),
        );
    }

    let mut report = ConstructionReport {
        stages: stages.clone(),
        actions: actions.clone(),
        transitions: Vec::with_capacity(request.transitions.len()),
        // `connected` dit le raccord au graphe **existant**. Un collage est clos
        // sur lui-même par décision d'auteur : il n'en pose aucun.
        connected: false,
    };
    for transition in &request.transitions {
        let stage_uuid = &stages[transition.stage];
        let action_id = &actions[transition.action];
        set_stage_transition(
            &mut payload.document,
            stage_uuid,
            transition.slot,
            &TransitionUpdate::Set {
                action_node: action_id.clone(),
                option_index: transition.option_index,
            },
        )?;
        report.transitions.push(ConstructionTransition {
            stage_uuid: stage_uuid.clone(),
            slot: transition.slot,
            action_id: action_id.clone(),
            option_index: transition.option_index,
        });
    }

    // Les positions partent **en un seul** `place_authored` et deviennent les
    // positions d'auteur des cartes collées : il vérifie toute la demande avant
    // d'écrire, et un collage dont une seule carte serait refusée l'est entier,
    // pas à moitié posé.
    let entries: Vec<LayoutEntry> = request
        .stages
        .iter()
        .zip(&stages)
        .filter_map(|(stage, uuid)| {
            stage.position.clone().map(|position| LayoutEntry {
                node: NodeRef {
                    kind: NodeKind::Stage,
                    id: uuid.clone(),
                },
                position,
            })
        })
        .chain(
            request
                .actions
                .iter()
                .zip(&actions)
                .filter_map(|(action, id)| {
                    action.position.clone().map(|position| LayoutEntry {
                        node: NodeRef {
                            kind: NodeKind::Action,
                            id: id.clone(),
                        },
                        position,
                    })
                }),
        )
        .collect();
    if !entries.is_empty() {
        place_authored(payload, &entries, positions)?;
    }

    Ok((
        CreatedNodes {
            stage_uuid: stages.first().cloned().unwrap_or_default(),
            action_id: actions.first().cloned(),
        },
        report,
    ))
}
