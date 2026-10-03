use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use std::collections::{HashMap, HashSet, VecDeque};

use super::option_selection::OptionSelection;
use super::port_rules::{port_violations, PortViolation};
use super::presence::Presence;

/// Le repli d'affichage historique d'une Action sans `name`. C'est un repli de
/// **comportement** du consommateur, jamais une présence d'auteur : il ne
/// ressort pas à la sérialisation.
pub(crate) const ACTION_NODE_FALLBACK_NAME: &str = "Action node";

/// Le repli d'interprétation historique d'un Stage sans `type`.
pub(crate) const STAGE_TYPE_FALLBACK: &str = "stage";

/// Le document d'auteur : unique représentation Rust du dialecte STUdio v1.
///
/// Les champs présence-sensibles portent `Presence<T>` : absent, `null` et
/// valeur ne doivent jamais être confondus, et un `#[serde(default)]`
/// historique ne doit pas créer à lui seul une présence d'auteur. `stageNodes`
/// et `actionNodes` restent obligatoires : ils font partie de la structure
/// d'export, pas des champs présence-sensibles.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct StoryDocument {
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) title: Presence<String>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) version: Presence<i32>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) description: Presence<String>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) format: Presence<String>,
    #[serde(
        rename = "nightModeAvailable",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) night_mode_available: Presence<bool>,
    /// Racine non autoritaire, présence-sensible à l'import. Jusqu'ici hors
    /// modèle et réinjectée après coup par le writer et par le convertisseur
    /// FS, donc systématiquement perdue à la relecture.
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) uuid: Presence<String>,
    /// Champ connu **opaque**. Aucune interprétation ici, donc
    /// aucun typage `bool` qui ferait échouer une graphie inattendue.
    #[serde(
        rename = "factoryDisabled",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) factory_disabled: Presence<Value>,
    #[serde(rename = "actionNodes")]
    pub(crate) action_nodes: Vec<ActionNode>,
    #[serde(rename = "stageNodes")]
    pub(crate) stage_nodes: Vec<StageNode>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct ActionNode {
    pub(crate) id: String,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) name: Presence<String>,
    /// `Action.type` doit être représentable et conservé, sans qu'on en déduise
    /// une sémantique.
    #[serde(rename = "type", default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) action_type: Presence<String>,
    /// Marqueur de groupe enrichi, conservé sans interprétation.
    #[serde(
        rename = "groupId",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) group_id: Presence<String>,
    /// Un élément de tableau n'est jamais « absent », mais il peut être `null` :
    /// deux états suffisent. `None` porte une cible nulle jusqu'au diagnostic
    /// d'intégrité (`OptionTargetNull`) au lieu de faire échouer tout le document
    /// avant tout classificateur.
    pub(crate) options: Vec<Option<String>>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) position: Presence<Position>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct StageNode {
    pub(crate) uuid: String,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) name: Presence<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) stage_type: Presence<String>,
    #[serde(
        rename = "squareOne",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) square_one: Presence<bool>,
    /// Marqueur de groupe enrichi, conservé sans interprétation.
    #[serde(
        rename = "groupId",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) group_id: Presence<String>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) audio: Presence<String>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) image: Presence<String>,
    /// L'objet lui-même est présence-sensible : le dialecte porte des Stages
    /// sans `controlSettings` et des `controlSettings: null`.
    #[serde(
        rename = "controlSettings",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) control_settings: Presence<ControlSettings>,
    #[serde(
        rename = "homeTransition",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) home_transition: Presence<Transition>,
    #[serde(
        rename = "okTransition",
        default,
        skip_serializing_if = "Presence::is_absent"
    )]
    pub(crate) ok_transition: Presence<Transition>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) position: Presence<Position>,
}

impl StageNode {
    /// Le libellé du Stage pour un message ou une comparaison locale, avec le
    /// repli historique de la chaîne vide. Ne crée aucune présence d'auteur.
    pub(crate) fn label(&self) -> &str {
        self.name.as_str_or("")
    }

    /// Vrai seulement pour un `squareOne: true` explicite. L'absence et `null`
    /// ne désignent pas l'entrée : c'était déjà le comportement du
    /// `#[serde(default)]` retiré, mais il est maintenant distinguable.
    pub(crate) fn is_square_one(&self) -> bool {
        self.square_one.is_true()
    }
}

/// Les cibles d'une Action construite par Story Studio : toutes nommées,
/// aucune nulle. Une cible `null` ne vient que d'un document source.
pub(crate) fn named_option_targets(targets: Vec<String>) -> Vec<Option<String>> {
    targets.into_iter().map(Some).collect()
}

impl ActionNode {
    /// Le libellé de l'Action pour un message, avec le repli historique
    /// `"Action node"`. Ne crée aucune présence d'auteur.
    pub(crate) fn label(&self) -> &str {
        self.name.as_str_or(ACTION_NODE_FALLBACK_NAME)
    }

    /// Les cibles réellement nommées, dans l'ordre. Une cible `null` est
    /// ignorée par les consommateurs de navigation ; elle reste dans `options`
    /// pour que le diagnostic d'intégrité la signale et que l'index des options
    /// soit conservé.
    pub(crate) fn named_options(&self) -> impl Iterator<Item = &str> {
        self.options.iter().filter_map(|option| option.as_deref())
    }

    /// La cible nommée à cet index, ou `None` si l'index est hors limites ou
    /// si la cible est `null`.
    pub(crate) fn option_target(&self, index: usize) -> Option<&str> {
        self.options.get(index).and_then(|option| option.as_deref())
    }
}

/// Les cinq contrôles d'un Stage, chacun présence-sensible.
///
/// L'objet doit être complet **en sortie**, mais le dialecte d'entrée porte
/// réellement des objets partiels : à l'entrée, on conserve chaque booléen
/// présent et chaque absence/`null` sans valeur par défaut ni déduction depuis
/// une transition. Les accesseurs répondent `true` pour un `true` explicite
/// seulement ; ils ne donnent aucun sens à l'absence, ils constatent l'absence
/// de port.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ControlSettings {
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) wheel: Presence<bool>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) ok: Presence<bool>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) home: Presence<bool>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) pause: Presence<bool>,
    #[serde(default, skip_serializing_if = "Presence::is_absent")]
    pub(crate) autoplay: Presence<bool>,
}

impl ControlSettings {
    /// Les cinq contrôles explicitement renseignés par un auteur ou par un
    /// constructeur Libre, qui décide toujours de la valeur des cinq.
    pub(crate) fn authored(wheel: bool, ok: bool, home: bool, pause: bool, autoplay: bool) -> Self {
        Self {
            wheel: Presence::Value(wheel),
            ok: Presence::Value(ok),
            home: Presence::Value(home),
            pause: Presence::Value(pause),
            autoplay: Presence::Value(autoplay),
        }
    }

    pub(crate) fn wheel(&self) -> bool {
        self.wheel.is_true()
    }

    pub(crate) fn ok(&self) -> bool {
        self.ok.is_true()
    }

    pub(crate) fn home(&self) -> bool {
        self.home.is_true()
    }

    pub(crate) fn pause(&self) -> bool {
        self.pause.is_true()
    }

    pub(crate) fn autoplay(&self) -> bool {
        self.autoplay.is_true()
    }

    /// Vrai quand les cinq valeurs booléennes sont explicitement renseignées :
    /// c'est la seule forme autorisée en sortie de pack.
    pub(crate) fn is_complete(&self) -> bool {
        [
            &self.wheel,
            &self.ok,
            &self.home,
            &self.pause,
            &self.autoplay,
        ]
        .iter()
        .all(|control| control.is_value())
    }

    /// Les cinq contrôles et leur nom de clé, dans l'ordre du dialecte.
    pub(crate) fn members(&self) -> [(&'static str, &Presence<bool>); 5] {
        [
            ("wheel", &self.wheel),
            ("ok", &self.ok),
            ("home", &self.home),
            ("pause", &self.pause),
            ("autoplay", &self.autoplay),
        ]
    }
}

/// Un objet de contrôles absent ou `null` ne porte évidemment aucun port : les
/// accesseurs répondent `false` sans que le consommateur ait à distinguer les
/// trois formes, et la distinction survit dans le modèle.
impl Presence<ControlSettings> {
    pub(crate) fn wheel(&self) -> bool {
        self.value().is_some_and(ControlSettings::wheel)
    }

    pub(crate) fn ok(&self) -> bool {
        self.value().is_some_and(ControlSettings::ok)
    }

    pub(crate) fn home(&self) -> bool {
        self.value().is_some_and(ControlSettings::home)
    }

    pub(crate) fn pause(&self) -> bool {
        self.value().is_some_and(ControlSettings::pause)
    }

    pub(crate) fn autoplay(&self) -> bool {
        self.value().is_some_and(ControlSettings::autoplay)
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.value().is_some_and(ControlSettings::is_complete)
    }
}

/// Une transition du dialecte : l'ActionNode visé et la sélection d'option.
///
/// La sélection est un concept sémantique unique : le champ porte donc
/// `OptionSelection`, jamais un entier signé qu'un consommateur pourrait
/// rabattre vers `0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Transition {
    #[serde(rename = "actionNode")]
    pub(crate) action_node: String,
    #[serde(rename = "optionIndex")]
    pub(crate) selection: OptionSelection,
}

impl Transition {
    /// Une transition vers l'option d'indice connu. Les constructeurs Story
    /// Studio ne produisent que cette forme : ils choisissent toujours une
    /// destination précise.
    pub(crate) fn fixed(action_node: impl Into<String>, option_index: usize) -> Self {
        Self {
            action_node: action_node.into(),
            selection: OptionSelection::fixed(option_index),
        }
    }
}

impl<'de> Deserialize<'de> for Transition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct TransitionFields {
            #[serde(rename = "actionNode")]
            action_node: Option<String>,
            /// `OptionSelection` refuse elle-même `< -1` : le refus de dialecte
            /// est appliqué une seule fois, dans le type.
            #[serde(rename = "optionIndex")]
            option_index: Option<OptionSelection>,
        }

        let fields = TransitionFields::deserialize(deserializer)?;
        let action_node = fields
            .action_node
            .ok_or_else(|| serde::de::Error::missing_field("actionNode"))?;
        let selection = fields
            .option_index
            .ok_or_else(|| serde::de::Error::missing_field("optionIndex"))?;
        Ok(Self {
            action_node,
            selection,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Position {
    pub(crate) x: Number,
    pub(crate) y: Number,
}

pub(crate) struct AfterPlaybackSequenceTransitions {
    pub(crate) ok: Transition,
    pub(crate) home: Option<Transition>,
}

// Ajoute un suffixe d'id assaini pour éviter les collisions de rôle quand des
// entrées sœurs partagent le même libellé. Replie sur le nom seul quand l'id
// est vide (certains tests et imports legacy construisent encore des entrées sans id).
pub(crate) fn scoped_label_id(prefix: &str, id: &str, name: &str) -> String {
    let trimmed = name.trim();
    let label = if trimmed.is_empty() {
        "(sans nom)"
    } else {
        trimmed
    };
    if id.is_empty() {
        format!("{}/{}", prefix, label)
    } else {
        format!("{}/{}#{}", prefix, label, sanitize_stage_label(id))
    }
}

pub(crate) fn sanitize_stage_label(label: &str) -> String {
    let sanitized: String = label
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | ' ' => '_',
            _ => c,
        })
        .collect();
    sanitized.trim_matches('_').to_string()
}

/// Ouvre les ports que STUdio recrée depuis `controlSettings` avant de rejouer
/// les transitions. Cette normalisation ne doit pas être appelée sur un
/// document d'auteur : elle n'agit que sur une sortie Libre.
///
/// Elle ne bascule qu'une valeur **déjà renseignée** : compléter un contrôle
/// absent reviendrait à déduire un contrôle d'une transition, ce qui est
/// interdit. Un objet incomplet est refusé plus loin, par le writer, avec un
/// message explicite.
///
/// Exception : une transition d'un contrôle désactivé qui ramène l'Écran sur
/// lui-même n'est pas rouverte mais retirée. Rouvrir le port créerait la boucle
/// que `port_rules` refuse ; la retirer ne change rien au lecteur, pour qui ce
/// contrôle est inerte, ni à STUdio, qui ne relie aucune transition à un port
/// absent.
pub(crate) fn normalize_document_for_studio_compat(document: &mut StoryDocument) {
    let action_targets: HashMap<String, Vec<Option<String>>> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.clone(), action.options.clone()))
        .collect();
    let lands_on = |transition: &Presence<Transition>, stage_id: &str| -> bool {
        transition
            .value()
            .and_then(|transition| {
                let options = action_targets.get(&transition.action_node)?;
                options.get(transition.selection.fixed_index()?)?.as_deref()
            })
            .is_some_and(|target| target == stage_id)
    };
    for stage in &mut document.stage_nodes {
        let declares_ok = stage.ok_transition.is_value();
        let declares_home = stage.home_transition.is_value();
        let ok_loops = lands_on(&stage.ok_transition, &stage.uuid);
        let home_loops = lands_on(&stage.home_transition, &stage.uuid);
        let Some(controls) = stage.control_settings.value_mut() else {
            continue;
        };
        if declares_ok && !controls.ok() && !controls.autoplay() && controls.ok.is_value() {
            if ok_loops {
                stage.ok_transition = Presence::Null;
            } else {
                controls.ok = Presence::Value(true);
            }
        }
        if declares_home && !controls.home() && controls.home.is_value() {
            if home_loops {
                stage.home_transition = Presence::Null;
            } else {
                controls.home = Presence::Value(true);
            }
        }
    }
}

pub(crate) fn validate_document_for_studio_compat(document: &StoryDocument) -> Result<(), String> {
    let stage_ids: HashSet<&str> = document
        .stage_nodes
        .iter()
        .map(|stage| stage.uuid.as_str())
        .collect();
    let action_map: HashMap<&str, &ActionNode> = document
        .action_nodes
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();
    let mut issues = Vec::new();

    for action in &document.action_nodes {
        for (option_index, option) in action.options.iter().enumerate() {
            // Une cible `null` n'est pas une cible introuvable : elle est
            // laissée au diagnostic d'intégrité, pas rabattue ici.
            let Some(stage_id) = option.as_deref() else {
                continue;
            };
            if !stage_ids.contains(stage_id) {
                issues.push(format!(
                    "Action '{}' option {} pointe vers un stage introuvable '{}'",
                    action.label(),
                    option_index,
                    stage_id
                ));
            }
        }
    }

    for stage in &document.stage_nodes {
        validate_stage_transition(
            &action_map,
            stage,
            "okTransition",
            stage.ok_transition.value(),
            stage.control_settings.ok() || stage.control_settings.autoplay(),
            &mut issues,
        );
        validate_stage_transition(
            &action_map,
            stage,
            "homeTransition",
            stage.home_transition.value(),
            stage.control_settings.home(),
            &mut issues,
        );
    }

    for violation in port_violations(document) {
        issues.push(port_violation_message(document, violation));
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "story.json natif incompatible STUdio : {}",
            issues.join(" | ")
        ))
    }
}

fn port_violation_message(document: &StoryDocument, violation: PortViolation) -> String {
    match violation {
        PortViolation::HomeLoopsToSelf { stage, implicit } => {
            let label = document.stage_nodes[stage].label();
            if implicit {
                format!("Stage '{label}' : écran d'entrée avec Accueil actif sans destination, Accueil ramène ici même")
            } else {
                format!("Stage '{label}' : homeTransition ramène l'écran sur lui-même")
            }
        }
        PortViolation::OkLoopsToSelf { stage } => format!(
            "Stage '{}' : okTransition ramène l'écran sur lui-même",
            document.stage_nodes[stage].label()
        ),
        PortViolation::OkWithoutUsableDestination { stage } => format!(
            "Stage '{}' : OK ou fin automatique actif sans destination utilisable",
            document.stage_nodes[stage].label()
        ),
        PortViolation::NoUsableExit { stage } => format!(
            "Stage '{}' : écran accessible sans sortie utilisable, même par la molette",
            document.stage_nodes[stage].label()
        ),
        PortViolation::EntryStageAsOption { action, option } => format!(
            "Action '{}' option {} vise l'écran d'entrée",
            document.action_nodes[action].label(),
            option
        ),
    }
}

fn validate_stage_transition(
    action_map: &HashMap<&str, &ActionNode>,
    stage: &StageNode,
    transition_label: &str,
    transition: Option<&Transition>,
    port_available: bool,
    issues: &mut Vec<String>,
) {
    let Some(transition) = transition else {
        return;
    };

    if !port_available {
        issues.push(format!(
            "Stage '{}' declare {} sans port compatible",
            stage.label(),
            transition_label
        ));
    }

    let Some(action) = action_map.get(transition.action_node.as_str()) else {
        issues.push(format!(
            "Stage '{}' pointe via {} vers une action introuvable '{}'",
            stage.label(),
            transition_label,
            transition.action_node
        ));
        return;
    };

    // `< -1` n'est plus représentable : `OptionSelection` le refuse au décodage.
    // Reste la borne haute, qui vaut aussi pour `Random` sur une Action sans
    // option.
    if !transition.selection.is_within_bounds(action.options.len()) {
        issues.push(format!(
            "Stage '{}' utilise une sélection hors limites ({}) sur {}",
            stage.label(),
            transition.selection,
            transition_label
        ));
    }
}

pub(crate) fn reorder_document_for_display(document: &mut StoryDocument) {
    let stage_map: HashMap<String, StageNode> = document
        .stage_nodes
        .iter()
        .cloned()
        .map(|stage| (stage.uuid.clone(), stage))
        .collect();
    let action_map: HashMap<String, ActionNode> = document
        .action_nodes
        .iter()
        .cloned()
        .map(|action| (action.id.clone(), action))
        .collect();

    let square_one_id = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
        .map(|stage| stage.uuid.clone());

    let mut ordered_stage_ids = Vec::new();
    let mut ordered_action_ids = Vec::new();
    let mut seen_stages = HashSet::new();
    let mut seen_actions = HashSet::new();
    let mut queue = VecDeque::new();

    if let Some(stage_id) = square_one_id {
        queue.push_back(GraphNodeRef::Stage(stage_id));
    }

    while let Some(node_ref) = queue.pop_front() {
        match node_ref {
            GraphNodeRef::Stage(stage_id) => {
                if !seen_stages.insert(stage_id.clone()) {
                    continue;
                }
                ordered_stage_ids.push(stage_id.clone());
                if let Some(action_id) = stage_map
                    .get(&stage_id)
                    .and_then(|stage| stage.ok_transition.value())
                    .map(|transition| transition.action_node.clone())
                {
                    queue.push_back(GraphNodeRef::Action(action_id));
                }
            }
            GraphNodeRef::Action(action_id) => {
                if !seen_actions.insert(action_id.clone()) {
                    continue;
                }
                ordered_action_ids.push(action_id.clone());
                if let Some(action) = action_map.get(&action_id) {
                    for stage_id in action.named_options() {
                        queue.push_back(GraphNodeRef::Stage(stage_id.to_string()));
                    }
                }
            }
        }
    }

    for stage in &document.stage_nodes {
        if seen_stages.insert(stage.uuid.clone()) {
            ordered_stage_ids.push(stage.uuid.clone());
        }
    }
    for action in &document.action_nodes {
        if seen_actions.insert(action.id.clone()) {
            ordered_action_ids.push(action.id.clone());
        }
    }

    document.stage_nodes = ordered_stage_ids
        .into_iter()
        .filter_map(|stage_id| stage_map.get(&stage_id).cloned())
        .collect();
    document.action_nodes = ordered_action_ids
        .into_iter()
        .filter_map(|action_id| action_map.get(&action_id).cloned())
        .collect();
}

enum GraphNodeRef {
    Stage(String),
    Action(String),
}
