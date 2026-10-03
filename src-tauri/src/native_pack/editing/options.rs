//! Gestes d'options : insérer, retargeter une occurrence, réordonner, retirer.
//!
//! Une option n'a **pas d'identité propre** dans le dialecte : son identité est
//! son rang. Tous les gestes de ce module adressent donc une occurrence par son
//! ordinal courant, jamais par sa destination — envoyer des cibles
//! dédupliquerait deux occurrences visant le même Écran, et c'est exactement
//! l'information qu'il faut rendre visible.
//!
//! Trois règles gouvernent la maintenance des indices, et elles sont
//! appliquées à **toutes** les transitions entrantes de l'Action touchée, jamais
//! à celle que l'auteur regarde :
//!
//! - réordonnancement : conserve la destination sélectionnée ;
//! - insertion à `k` : décale `Fixed(i ≥ k)` vers `Fixed(i+1)` ;
//! - retrait à `k` : décrémente `Fixed(i > k)`, laisse `Fixed(i < k)`
//!   et `Random` intacts, et **exige une décision explicite** pour la transition
//!   qui visait exactement `k`. `Fixed(k)` ne glisse jamais sur la voisine.
//!
//! Les règles elles-mêmes vivent dans `OptionSelection` et ne sont pas réécrites
//! ici : ce module les invoque et rend leurs effets observables.

use serde::{Deserialize, Serialize};

use super::structure::unique_action_index;
use super::transitions::TransitionSlot;
use super::GestureError;
use crate::native_pack::{OptionSelection, Presence, StoryDocument, Transition};

/// La destination d'une occurrence d'option.
///
/// Le tag `target` et ses variantes sont ceux que la création de Stage exposait
/// déjà : une seule forme IPC pour désigner une cible d'option, quel que soit le
/// geste. `created-stage` n'est acceptable que dans un geste qui crée réellement
/// un Stage ; ailleurs il est refusé au lieu d'être interprété.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "target", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum ActionOptionTarget {
    /// Le Stage que ce même geste vient de créer : son UUID n'existe pas encore
    /// quand l'appelant formule sa demande, il ne peut donc pas le citer.
    CreatedStage,
    Stage {
        uuid: String,
    },
    /// Une cible nulle est admise comme forme d'entrée : l'auteur peut
    /// réserver un rang sans le pourvoir, et le diagnostic le signale.
    Null,
}

/// Résout une destination demandée en cible de dialecte.
///
/// `created_stage` n'est fourni que par la création de Stage ; partout ailleurs
/// il vaut `None` et la variante correspondante est un refus typé.
pub(crate) fn resolve_option_target(
    document: &StoryDocument,
    target: &ActionOptionTarget,
    created_stage: Option<&str>,
    path: &str,
) -> Result<Option<String>, GestureError> {
    match target {
        ActionOptionTarget::Null => Ok(None),
        ActionOptionTarget::CreatedStage => created_stage.map(|uuid| Some(uuid.to_string())).ok_or_else(|| {
            GestureError::new(
                "NO_CREATED_STAGE",
                path,
                "Aucun Stage n'est créé par ce geste : désigner la destination par son identifiant.".to_string(),
            )
        }),
        ActionOptionTarget::Stage { uuid } => {
            let Some(stage) = document.stage_nodes.iter().find(|stage| stage.uuid == *uuid) else {
                return Err(GestureError::new(
                    "UNKNOWN_STAGE",
                    path,
                    format!("L'option désigne un Stage introuvable : « {uuid} »."),
                ));
            };
            // L'Écran d'entrée n'est jamais une destination : STUdio lui retire
            // sa prise d'arrivée et écrit `null` à la place d'un tel lien. On y
            // revient par le retour par défaut de la Lunii, un Accueil sans
            // destination. Tous les gestes qui posent une cible passent ici.
            if stage.is_square_one() {
                return Err(GestureError::new(
                    "ENTRY_STAGE_AS_OPTION",
                    path,
                    "L'Écran d'entrée ne peut pas être le choix d'une liste : on y revient par le bouton Accueil laissé sans destination.".to_string(),
                ));
            }
            Ok(Some(uuid.clone()))
        }
    }
}

/// La décision d'auteur exigée pour une transition que le geste ne peut pas
/// maintenir sans choisir à sa place.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum SelectionResolution {
    /// Nouvelle sélection, exprimée dans la liste d'options **résultante** :
    /// `-1` est `Random`, `i ≥ 0` est `Fixed(i)` après le retrait.
    #[serde(rename_all = "camelCase")]
    Select {
        option_index: i64,
    },
    /// Retrait de la transition, sous la forme de présence choisie.
    Null,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionDecision {
    pub(crate) stage_uuid: String,
    pub(crate) slot: TransitionSlot,
    pub(crate) resolution: SelectionResolution,
}

/// Les décisions de l'auteur, consommées une fois chacune.
///
/// Un retrait de Stage peut retirer plusieurs occurrences d'options, chacune
/// réclamant ses propres décisions : elles arrivent donc en **une** liste, et
/// c'est le carnet qui sait laquelle a déjà servi. Vérifier les restes à chaque
/// retrait refuserait la décision légitime du retrait suivant.
pub(crate) struct DecisionBook<'a> {
    decisions: &'a [SelectionDecision],
    used: Vec<bool>,
}

impl<'a> DecisionBook<'a> {
    pub(crate) fn new(decisions: &'a [SelectionDecision]) -> Self {
        Self {
            used: vec![false; decisions.len()],
            decisions,
        }
    }

    fn take(&mut self, stage_uuid: &str, slot: TransitionSlot) -> Option<&'a SelectionResolution> {
        let index = self
            .decisions
            .iter()
            .enumerate()
            .position(|(index, decision)| {
                !self.used[index] && decision.stage_uuid == stage_uuid && decision.slot == slot
            })?;
        self.used[index] = true;
        Some(&self.decisions[index].resolution)
    }

    /// Les décisions qui n'ont rien tranché. Une commande qui les accepterait
    /// laisserait croire à l'auteur qu'il a décidé de quelque chose.
    pub(crate) fn unused(&self) -> Result<(), GestureError> {
        for (index, decision) in self.decisions.iter().enumerate() {
            if !self.used[index] {
                return Err(GestureError::new(
                    "UNEXPECTED_SELECTION_DECISION",
                    &transition_path(&decision.stage_uuid, decision.slot),
                    "Cette transition conserve sa destination : le geste ne demande aucune décision ici."
                        .to_string(),
                ));
            }
        }
        Ok(())
    }
}

/// L'effet d'un geste sur une transition entrante.
///
/// `decided` sépare ce que la règle a maintenu de ce que l'auteur a tranché :
/// c'est la différence entre « votre destination est conservée » et « vous avez
/// choisi une autre destination », et l'interface ne doit pas les confondre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectionEffect {
    pub(crate) path: String,
    pub(crate) action_node: String,
    pub(crate) before: i64,
    /// `None` : la transition a été retirée par la décision de l'auteur.
    pub(crate) after: Option<i64>,
    pub(crate) decided: bool,
}

/// L'effet d'un geste sur une occurrence d'option.
///
/// Les deux identifiants de vue encadrent le geste : `optionId` est l'occurrence
/// telle que l'auteur la désignait, `becomes` celle qu'il retrouvera. Un rang
/// créé n'a pas de premier, un rang retiré pas de second, et un réordonnancement
/// les porte tous les deux — c'est ce qui rend une permutation relisible sans
/// recalculer les rangs en JavaScript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptionEffect {
    pub(crate) option_id: Option<String>,
    pub(crate) becomes: Option<String>,
    pub(crate) before: Option<String>,
    pub(crate) after: Option<String>,
}

/// Ce qu'un geste a fait des références entrantes de sa cible.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceReport {
    pub(crate) selections: Vec<SelectionEffect>,
    pub(crate) options: Vec<OptionEffect>,
    /// Les Stages dont `squareOne` a changé, dans l'ordre du document.
    pub(crate) square_one: Vec<String>,
}

pub(crate) fn action_path(action_id: &str) -> String {
    format!("/actionNodes/@id={action_id}#0")
}

pub(crate) fn option_id(action_id: &str, ordinal: usize) -> String {
    format!("{}/options#{ordinal}", action_path(action_id))
}

pub(crate) fn transition_path(stage_uuid: &str, slot: TransitionSlot) -> String {
    format!("/stageNodes/@uuid={stage_uuid}#0/{}", slot.field())
}

/// Les transitions qui visent cette Action, dans l'ordre du document.
///
/// Rendre l'indice du Stage plutôt qu'une référence permet d'écrire ensuite sans
/// conserver d'emprunt sur le document pendant le calcul des nouvelles valeurs.
fn incoming(document: &StoryDocument, action_id: &str) -> Vec<(usize, TransitionSlot)> {
    let mut found = Vec::new();
    for (index, stage) in document.stage_nodes.iter().enumerate() {
        for slot in TransitionSlot::all() {
            if slot
                .read(stage)
                .value()
                .is_some_and(|transition| transition.action_node == action_id)
            {
                found.push((index, slot));
            }
        }
    }
    found
}

fn selection_of(document: &StoryDocument, stage: usize, slot: TransitionSlot) -> OptionSelection {
    slot.read(&document.stage_nodes[stage])
        .value()
        .expect("transition relevée comme entrante")
        .selection
}

/// Applique une transformation d'indice à toutes les transitions entrantes.
///
/// `maintain` rend `None` quand la règle refuse de choisir : c'est le cas de
/// `Fixed(k)` sur l'option retirée, et l'appelant doit alors avoir obtenu une
/// décision explicite de l'auteur.
fn maintain_incoming(
    document: &mut StoryDocument,
    action_id: &str,
    report: &mut ReferenceReport,
    maintain: impl Fn(OptionSelection) -> Option<OptionSelection>,
) {
    for (stage, slot) in incoming(document, action_id) {
        let before = selection_of(document, stage, slot);
        let Some(after) = maintain(before) else {
            continue;
        };
        if after == before {
            continue;
        }
        let uuid = document.stage_nodes[stage].uuid.clone();
        slot.write(&mut document.stage_nodes[stage])
            .value_mut()
            .expect("transition relevée comme entrante")
            .selection = after;
        report.selections.push(SelectionEffect {
            path: transition_path(&uuid, slot),
            action_node: action_id.to_string(),
            before: before.to_dialect_index(),
            after: Some(after.to_dialect_index()),
            decided: false,
        });
    }
}

fn option_count(document: &StoryDocument, action_id: &str) -> Result<usize, GestureError> {
    let index = unique_action_index(document, action_id)?;
    Ok(document.action_nodes[index].options.len())
}

fn out_of_range(action_id: &str, ordinal: usize, count: usize, bound: usize) -> GestureError {
    GestureError::new(
        "OPTION_ORDINAL_OUT_OF_RANGE",
        &option_id(action_id, ordinal),
        format!(
            "L'ActionNode « {action_id} » porte {count} option(s) : le rang {ordinal} n'est pas adressable (maximum {bound})."
        ),
    )
}

/// Insertion d'une occurrence au rang `index`.
pub(crate) fn insert_option(
    document: &mut StoryDocument,
    action_id: &str,
    index: usize,
    target: &ActionOptionTarget,
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let count = option_count(document, action_id)?;
    if index > count {
        return Err(out_of_range(action_id, index, count, count));
    }
    let resolved = resolve_option_target(document, target, None, &option_id(action_id, index))?;
    let action = unique_action_index(document, action_id)?;
    document.action_nodes[action]
        .options
        .insert(index, resolved.clone());
    report.options.push(OptionEffect {
        option_id: None,
        becomes: Some(option_id(action_id, index)),
        before: None,
        after: resolved,
    });
    maintain_incoming(document, action_id, report, |selection| {
        Some(selection.after_option_inserted(index))
    });
    Ok(())
}

/// Retarget d'une occurrence existante : son rang ne bouge pas, donc aucune
/// sélection n'a à être maintenue. C'est précisément ce qui distingue ce geste
/// d'un retrait suivi d'une insertion.
pub(crate) fn set_option_target(
    document: &mut StoryDocument,
    action_id: &str,
    ordinal: usize,
    target: &ActionOptionTarget,
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let count = option_count(document, action_id)?;
    if ordinal >= count {
        return Err(out_of_range(
            action_id,
            ordinal,
            count,
            count.saturating_sub(1),
        ));
    }
    let resolved = resolve_option_target(document, target, None, &option_id(action_id, ordinal))?;
    let action = unique_action_index(document, action_id)?;
    let before = std::mem::replace(
        &mut document.action_nodes[action].options[ordinal],
        resolved.clone(),
    );
    report.options.push(OptionEffect {
        option_id: Some(option_id(action_id, ordinal)),
        becomes: Some(option_id(action_id, ordinal)),
        before,
        after: resolved,
    });
    Ok(())
}

/// Réordonnancement explicite.
///
/// La demande porte une **permutation des rangs courants** : `new_position_of_old[i]`
/// est la nouvelle position de l'option qui occupait `i`. Une liste de cibles
/// fusionnerait deux occurrences de même destination ; une permutation ne le
/// peut pas, et c'est la raison de cette forme.
pub(crate) fn reorder_options(
    document: &mut StoryDocument,
    action_id: &str,
    new_position_of_old: &[usize],
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let count = option_count(document, action_id)?;
    let path = format!("{}/options", action_path(action_id));
    if new_position_of_old.len() != count {
        return Err(GestureError::new(
            "INVALID_OPTION_PERMUTATION",
            &path,
            format!(
                "La permutation porte {} rang(s) pour {count} option(s) : chaque occurrence doit recevoir une place.",
                new_position_of_old.len()
            ),
        ));
    }
    let mut seen = vec![false; count];
    for position in new_position_of_old {
        let Some(slot) = seen.get_mut(*position) else {
            return Err(GestureError::new(
                "INVALID_OPTION_PERMUTATION",
                &path,
                format!("La permutation désigne la place {position} hors des {count} rangs."),
            ));
        };
        if std::mem::replace(slot, true) {
            return Err(GestureError::new(
                "INVALID_OPTION_PERMUTATION",
                &path,
                format!("Deux occurrences reçoivent la place {position}."),
            ));
        }
    }

    let action = unique_action_index(document, action_id)?;
    let previous = std::mem::take(&mut document.action_nodes[action].options);
    let mut reordered = vec![None; count];
    for (old, target) in previous.into_iter().enumerate() {
        reordered[new_position_of_old[old]] = target;
    }
    for (old, position) in new_position_of_old.iter().enumerate() {
        if old != *position {
            report.options.push(OptionEffect {
                option_id: Some(option_id(action_id, old)),
                becomes: Some(option_id(action_id, *position)),
                before: reordered[*position].clone(),
                after: reordered[*position].clone(),
            });
        }
    }
    document.action_nodes[action].options = reordered;
    maintain_incoming(document, action_id, report, |selection| {
        Some(selection.after_options_reordered(new_position_of_old))
    });
    Ok(())
}

/// Retrait d'une occurrence, décisions d'auteur comprises.
///
/// Le geste refuse **avant toute mutation** tant qu'une transition visant
/// exactement le rang retiré, ou une `Random` que le retrait rendrait vide, n'a
/// pas reçu sa décision. Les décisions sans objet sont elles aussi refusées :
/// une commande qui en accepterait une laisserait croire à l'auteur qu'il a
/// tranché quelque chose.
pub(crate) fn remove_option(
    document: &mut StoryDocument,
    action_id: &str,
    ordinal: usize,
    decisions: &mut DecisionBook<'_>,
    report: &mut ReferenceReport,
) -> Result<(), GestureError> {
    let count = option_count(document, action_id)?;
    if ordinal >= count {
        return Err(out_of_range(
            action_id,
            ordinal,
            count,
            count.saturating_sub(1),
        ));
    }
    let remaining = count - 1;
    let mut pending: Vec<(usize, TransitionSlot)> = Vec::new();
    for (stage, slot) in incoming(document, action_id) {
        let selection = selection_of(document, stage, slot);
        let maintained = selection.after_option_removed(ordinal);
        match maintained {
            Some(kept) if kept.is_within_bounds(remaining) => {}
            // `Fixed(k)` sur l'option retirée, ou `Random` sur une Action que le
            // retrait viderait : dans les deux cas la destination disparaît et
            // il est interdit d'en choisir une autre à la place de l'auteur.
            _ => pending.push((stage, slot)),
        }
    }

    let mut resolutions = Vec::with_capacity(pending.len());
    for (stage, slot) in &pending {
        let uuid = document.stage_nodes[*stage].uuid.clone();
        let Some(resolution) = decisions.take(&uuid, *slot) else {
            return Err(GestureError::new(
                "OPTION_SELECTION_DECISION_REQUIRED",
                &transition_path(&uuid, *slot),
                format!(
                    "Le retrait du rang {ordinal} prive cette transition de sa destination : il faut décider explicitement de la rediriger ou de la retirer."
                ),
            )
            .with_references(
                pending
                    .iter()
                    .map(|(stage, slot)| transition_path(&document.stage_nodes[*stage].uuid, *slot))
                    .collect(),
            ));
        };
        resolutions.push((*stage, *slot, resolution.clone()));
    }

    // Les décisions sont validées avant d'écrire : un indice hors bornes ne doit
    // pas laisser une Action déjà amputée de son option.
    let mut planned = Vec::with_capacity(resolutions.len());
    for (stage, slot, resolution) in &resolutions {
        let uuid = document.stage_nodes[*stage].uuid.clone();
        let path = transition_path(&uuid, *slot);
        let presence = match resolution {
            SelectionResolution::Null => Presence::Null,
            SelectionResolution::Absent => Presence::Absent,
            SelectionResolution::Select { option_index } => {
                let selection =
                    OptionSelection::from_dialect_index(*option_index).map_err(|error| {
                        GestureError::new(
                            "OPTION_INDEX_OUT_OF_DIALECT",
                            &format!("{path}/optionIndex"),
                            error.to_string(),
                        )
                    })?;
                if !selection.is_within_bounds(remaining) {
                    return Err(GestureError::new(
                        "OPTION_SELECTION_OUT_OF_BOUNDS",
                        &format!("{path}/optionIndex"),
                        format!(
                            "Après retrait, l'ActionNode « {action_id} » porte {remaining} option(s) : {selection} n'en désigne aucune."
                        ),
                    ));
                }
                Presence::Value(Transition {
                    action_node: action_id.to_string(),
                    selection,
                })
            }
        };
        planned.push((*stage, *slot, path, presence));
    }

    let action = unique_action_index(document, action_id)?;
    let removed = document.action_nodes[action].options.remove(ordinal);
    report.options.push(OptionEffect {
        option_id: Some(option_id(action_id, ordinal)),
        becomes: None,
        before: removed,
        after: None,
    });
    maintain_incoming(document, action_id, report, |selection| {
        selection
            .after_option_removed(ordinal)
            .filter(|kept| kept.is_within_bounds(remaining))
    });
    for (stage, slot, path, presence) in planned {
        let before = slot
            .read(&document.stage_nodes[stage])
            .value()
            .map(|transition| transition.selection.to_dialect_index());
        let after = presence
            .value()
            .map(|transition| transition.selection.to_dialect_index());
        *slot.write(&mut document.stage_nodes[stage]) = presence;
        report.selections.push(SelectionEffect {
            path,
            action_node: action_id.to_string(),
            before: before.expect("transition relevée comme entrante"),
            after,
            decided: true,
        });
    }
    Ok(())
}

/// Les transitions qui visent une Action, rendues comme inventaire de refus.
pub(crate) fn incoming_transition_paths(document: &StoryDocument, action_id: &str) -> Vec<String> {
    incoming(document, action_id)
        .into_iter()
        .map(|(stage, slot)| transition_path(&document.stage_nodes[stage].uuid, slot))
        .collect()
}

/// Les occurrences d'options qui désignent un Stage, rendues comme inventaire.
pub(crate) fn incoming_option_ids(document: &StoryDocument, stage_uuid: &str) -> Vec<String> {
    document
        .action_nodes
        .iter()
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
