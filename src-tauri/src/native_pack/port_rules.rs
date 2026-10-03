//! Les règles de navigation de la Lunii, appliquées à l'identique par les
//! deux éditeurs : le générateur par menus
//! (`validate_document_for_studio_compat`) refuse, le graphe
//! (`diagnose_enriched_metadata`) bloque la génération par « À corriger ».
//!
//! Sur un Écran atteignable depuis l'entrée, les déclencheurs OK et automatique
//! actifs exigent une destination utilisable.
//! Un Écran accessible sans ces déclencheurs ni Accueil doit pouvoir atteindre
//! une sortie par la molette dans la liste effectivement ouverte. L'entrée
//! initiale reste exclue de ce diagnostic d'impasse.
//!
//! Accueil et OK vers le même Écran sont admis. Une sélection aléatoire
//! ne désigne pas une arrivée certaine pour les règles de boucle sur soi.

use std::collections::{HashMap, VecDeque};

use super::document::{ActionNode, StoryDocument, Transition};
use super::option_selection::OptionSelection;
use super::presence::Presence;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortViolation {
    /// Accueil ramène l'Écran `stage` sur lui-même. `implicit` : sans
    /// destination, sur l'Écran d'entrée.
    HomeLoopsToSelf {
        stage: usize,
        implicit: bool,
    },
    /// OK ou la lecture automatique ramène l'Écran `stage` sur lui-même.
    OkLoopsToSelf {
        stage: usize,
    },
    OkWithoutUsableDestination {
        stage: usize,
    },
    NoUsableExit {
        stage: usize,
    },
    /// Le choix `option` de la liste `action` vise l'Écran d'entrée.
    EntryStageAsOption {
        action: usize,
        option: usize,
    },
}

impl PortViolation {
    pub(crate) fn code(self) -> &'static str {
        match self {
            PortViolation::HomeLoopsToSelf { .. } => "HOME_LOOPS_TO_SELF",
            PortViolation::OkLoopsToSelf { .. } => "OK_LOOPS_TO_SELF",
            PortViolation::OkWithoutUsableDestination { .. } => "OK_WITHOUT_USABLE_DESTINATION",
            PortViolation::NoUsableExit { .. } => "NO_USABLE_EXIT",
            PortViolation::EntryStageAsOption { .. } => "ENTRY_STAGE_AS_OPTION",
        }
    }
}

pub(crate) fn port_violations(document: &StoryDocument) -> Vec<PortViolation> {
    let actions: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let stages: HashMap<&str, usize> = document
        .stage_nodes
        .iter()
        .enumerate()
        .map(|(index, stage)| (stage.uuid.as_str(), index))
        .collect();
    let random_usable: HashMap<&str, bool> = actions
        .iter()
        .map(|(&id, action)| {
            (
                id,
                !action.options.is_empty()
                    && action
                        .options
                        .iter()
                        .all(|target| target.as_deref().is_some_and(|id| stages.contains_key(id))),
            )
        })
        .collect();
    let usable = |transition: Option<&Transition>| -> bool {
        let Some(transition) = transition else {
            return false;
        };
        let Some(action) = actions.get(transition.action_node.as_str()) else {
            return false;
        };
        match transition.selection {
            OptionSelection::Fixed(index) => action
                .option_target(index)
                .is_some_and(|id| stages.contains_key(id)),
            OptionSelection::Random => random_usable[transition.action_node.as_str()],
        }
    };
    let landing = |transition: Option<&Transition>| -> Option<&str> {
        let transition = transition?;
        let action = actions.get(transition.action_node.as_str())?;
        action.option_target(transition.selection.fixed_index()?)
    };
    let entry = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .map(|stage| stage.uuid.as_str());

    let mut violations = Vec::new();
    for (index, stage) in document.stage_nodes.iter().enumerate() {
        let own = stage.uuid.as_str();
        if stage.control_settings.home() {
            match stage.home_transition.value() {
                Some(transition) => {
                    if landing(Some(transition)) == Some(own) {
                        violations.push(PortViolation::HomeLoopsToSelf {
                            stage: index,
                            implicit: false,
                        });
                    }
                }
                None => {
                    if entry == Some(own) {
                        violations.push(PortViolation::HomeLoopsToSelf {
                            stage: index,
                            implicit: true,
                        });
                    }
                }
            }
        }
        if (stage.control_settings.ok() || stage.control_settings.autoplay())
            && landing(stage.ok_transition.value()) == Some(own)
        {
            violations.push(PortViolation::OkLoopsToSelf { stage: index });
        }
    }
    let accessibility = accessible_dead_ends(document, &stages, &usable);
    for (index, stage) in document.stage_nodes.iter().enumerate() {
        // Un Écran que rien n'atteint ne peut pas afficher Error : des packs
        // publiés gardent de tels Écrans orphelins et se jouent normalement.
        // Sans Écran d'entrée, l'accessibilité est inconnue : tous restent vérifiés.
        let reachable = accessibility
            .reached
            .as_ref()
            .is_none_or(|reached| reached[index]);
        if reachable
            && (stage.control_settings.ok() || stage.control_settings.autoplay())
            && !usable(stage.ok_transition.value())
        {
            violations.push(PortViolation::OkWithoutUsableDestination { stage: index });
        }
    }
    violations.extend(accessibility.dead_ends);
    if let Some(entry) = entry {
        for (action_index, action) in document.action_nodes.iter().enumerate() {
            for (option_index, target) in action.options.iter().enumerate() {
                if target.as_deref() == Some(entry) {
                    violations.push(PortViolation::EntryStageAsOption {
                        action: action_index,
                        option: option_index,
                    });
                }
            }
        }
    }
    violations
}

/// Les Écrans atteints depuis l'entrée (`None` sans Écran d'entrée) et les
/// impasses parmi eux.
struct Accessibility {
    reached: Option<Vec<bool>>,
    dead_ends: Vec<PortViolation>,
}

/// Chaque option conserve son contexte (liste, ordinal), même si son Écran
/// apparaît ailleurs. Les arêtes inverses de molette propagent les sorties
/// sans confondre ces occurrences ni analyser des cycles OK/Accueil.
fn accessible_dead_ends(
    document: &StoryDocument,
    stages: &HashMap<&str, usize>,
    usable: &impl Fn(Option<&Transition>) -> bool,
) -> Accessibility {
    let Some(entry) = document
        .stage_nodes
        .iter()
        .position(|stage| stage.is_square_one())
    else {
        return Accessibility {
            reached: None,
            dead_ends: Vec::new(),
        };
    };
    let mut contexts = vec![Some(entry)];
    let mut neighbors = vec![None];
    let mut ranges = HashMap::new();
    for action in &document.action_nodes {
        let start = contexts.len();
        let count = action.options.len();
        ranges.insert(action.id.as_str(), (start, count));
        for (ordinal, target) in action.options.iter().enumerate() {
            contexts.push(target.as_deref().and_then(|id| stages.get(id).copied()));
            neighbors.push(Some((
                start + (ordinal + count - 1) % count,
                start + (ordinal + 1) % count,
            )));
        }
    }
    let mut reached = vec![false; contexts.len()];
    let mut exits = vec![false; contexts.len()];
    let mut reverse_wheel = vec![Vec::new(); contexts.len()];
    let mut expanded = vec![false; document.stage_nodes.len()];
    let mut random_expanded = std::collections::HashSet::new();
    let mut queue = VecDeque::from([0]);
    reached[0] = true;
    while let Some(context) = queue.pop_front() {
        let Some(stage_index) = contexts[context] else {
            continue;
        };
        let stage = &document.stage_nodes[stage_index];
        let Some(controls) = stage.control_settings.value() else {
            exits[context] = true;
            continue;
        };
        let unknown = !controls.is_complete();
        exits[context] = unknown
            || (controls.home()
                && (stage.home_transition.value().is_none()
                    || usable(stage.home_transition.value())))
            || ((controls.ok() || controls.autoplay()) && usable(stage.ok_transition.value()));
        if controls.wheel() {
            if let Some((previous, next)) = neighbors[context] {
                for neighbor in [previous, next] {
                    if contexts[neighbor].is_some() {
                        reverse_wheel[neighbor].push(context);
                        if !reached[neighbor] {
                            reached[neighbor] = true;
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }
        if expanded[stage_index] {
            continue;
        }
        expanded[stage_index] = true;
        for (enabled, transition) in [
            (controls.home(), stage.home_transition.value()),
            (
                controls.ok() || controls.autoplay(),
                stage.ok_transition.value(),
            ),
        ] {
            if !enabled {
                continue;
            }
            let Some(transition) = transition else {
                continue;
            };
            let Some(&(start, count)) = ranges.get(transition.action_node.as_str()) else {
                continue;
            };
            let indices = match transition.selection {
                OptionSelection::Fixed(index) if index < count => start + index..start + index + 1,
                OptionSelection::Fixed(_) => continue,
                OptionSelection::Random => {
                    if !random_expanded.insert(transition.action_node.as_str()) {
                        continue;
                    }
                    start..start + count
                }
            };
            for target in indices {
                if !reached[target] {
                    reached[target] = true;
                    queue.push_back(target);
                }
            }
        }
    }
    let mut queue: VecDeque<usize> = exits
        .iter()
        .enumerate()
        .filter_map(|(index, &exit)| exit.then_some(index))
        .collect();
    while let Some(context) = queue.pop_front() {
        for &previous in &reverse_wheel[context] {
            if !exits[previous] {
                exits[previous] = true;
                queue.push_back(previous);
            }
        }
    }
    let mut reached_stages = vec![false; document.stage_nodes.len()];
    for (context, stage_index) in contexts.iter().enumerate() {
        if let Some(stage_index) = *stage_index {
            reached_stages[stage_index] |= reached[context];
        }
    }
    let mut blocked = vec![false; document.stage_nodes.len()];
    for (context, stage_index) in contexts.iter().enumerate().skip(1) {
        let Some(stage_index) = *stage_index else {
            continue;
        };
        let Some(controls) = document.stage_nodes[stage_index].control_settings.value() else {
            continue;
        };
        if reached[context]
            && !exits[context]
            && controls.is_complete()
            && [&controls.home, &controls.ok, &controls.autoplay]
                .iter()
                .all(|control| **control == Presence::Value(false))
        {
            blocked[stage_index] = true;
        }
    }
    Accessibility {
        reached: Some(reached_stages),
        dead_ends: blocked
            .into_iter()
            .enumerate()
            .filter_map(|(stage, blocked)| blocked.then_some(PortViolation::NoUsableExit { stage }))
            .collect(),
    }
}
