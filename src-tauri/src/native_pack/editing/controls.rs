//! Geste de contrôles : les cinq booléens d'un Stage, chacun indépendamment.
//!
//! Un `controlSettings` partiel, absent ou `null`, et un membre `null`, sont
//! admis en **entrée**, mais aucune complétion implicite n'est permise :
//! l'export standard reste bloqué tant que les cinq valeurs ne sont pas
//! renseignées, et seule une commande explicite de l'auteur les renseigne. Ce
//! module tient les deux moitiés de cette règle :
//!
//! - la forme `members` modifie les membres **nommés** et ne touche à rien
//!   d'autre. Elle exige un objet déjà présent : compléter un objet absent ou
//!   `null` membre par membre fabriquerait exactement l'objet partiel que
//!   Story Studio s'interdit de créer ;
//! - la forme `complete` est ce choix explicite. Elle renseigne les cinq
//!   valeurs en un geste, y compris sur un objet absent, `null` ou partiel.
//!
//! Pour le reste, ce geste **n'efface aucune transition**. Désactiver OK ou
//! HOME laisse l'arête en place ; la retirer est `set-stage-transition`, et
//! elle seule.

use serde::Deserialize;

use super::structure::unique_stage_index;
use super::transitions::TransitionSlot;
use super::GestureError;
use crate::native_pack::{ControlSettings, Presence, StoryDocument};

/// La forme d'un membre après le geste, présence comprise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum ControlUpdate {
    Set { value: bool },
    Null,
    Absent,
}

impl ControlUpdate {
    fn presence(self) -> Presence<bool> {
        match self {
            ControlUpdate::Set { value } => Presence::Value(value),
            ControlUpdate::Null => Presence::Null,
            ControlUpdate::Absent => Presence::Absent,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlMembers {
    #[serde(default)]
    wheel: Option<ControlUpdate>,
    #[serde(default)]
    ok: Option<ControlUpdate>,
    #[serde(default)]
    home: Option<ControlUpdate>,
    #[serde(default)]
    pause: Option<ControlUpdate>,
    #[serde(default)]
    autoplay: Option<ControlUpdate>,
}

impl ControlMembers {
    fn named(self) -> Vec<(&'static str, ControlUpdate)> {
        [
            ("wheel", self.wheel),
            ("ok", self.ok),
            ("home", self.home),
            ("pause", self.pause),
            ("autoplay", self.autoplay),
        ]
        .into_iter()
        .filter_map(|(key, update)| update.map(|update| (key, update)))
        .collect()
    }

    fn apply(self, controls: &mut ControlSettings) {
        for (key, update) in self.named() {
            let presence = update.presence();
            match key {
                "wheel" => controls.wheel = presence,
                "ok" => controls.ok = presence,
                "home" => controls.home = presence,
                "pause" => controls.pause = presence,
                _ => controls.autoplay = presence,
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "form", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum ControlsUpdate {
    /// Modification indépendante des membres nommés, sur un objet déjà présent.
    Members { members: ControlMembers },
    /// Le choix explicite de l'auteur : les cinq valeurs, en un geste.
    #[serde(rename_all = "camelCase")]
    Complete {
        wheel: bool,
        ok: bool,
        home: bool,
        pause: bool,
        autoplay: bool,
    },
}

pub(crate) fn set_stage_controls(
    document: &mut StoryDocument,
    stage_uuid: &str,
    update: &ControlsUpdate,
) -> Result<(), GestureError> {
    let index = unique_stage_index(document, stage_uuid)?;
    let path = format!("/stageNodes/@uuid={stage_uuid}#0/controlSettings");
    let stage = &mut document.stage_nodes[index];

    match update {
        ControlsUpdate::Complete {
            wheel,
            ok,
            home,
            pause,
            autoplay,
        } => {
            stage.control_settings = Presence::Value(ControlSettings::authored(
                *wheel, *ok, *home, *pause, *autoplay,
            ));
        }
        ControlsUpdate::Members { members } => {
            if members.named().is_empty() {
                return Err(GestureError::new(
                    "EMPTY_CONTROLS_UPDATE",
                    &path,
                    "Aucun contrôle n'est nommé : le geste ne devine pas lequel modifier."
                        .to_string(),
                ));
            }
            let Some(controls) = stage.control_settings.value_mut() else {
                return Err(GestureError::new(
                    "CONTROL_SETTINGS_ABSENT",
                    &path,
                    "Ce Stage ne porte pas d'objet de contrôles : le compléter est un choix explicite des cinq valeurs, pas la pose d'un membre isolé."
                        .to_string(),
                ));
            };
            members.apply(controls);
        }
    }
    Ok(())
}

/// Le même réglage posé sur plusieurs Écrans d'une sélection, en une seule
/// transaction : un bouton basculé pour tous, une seule étape d'annulation.
///
/// Chaque Écran reçoit exactement ce que `set_stage_controls` ferait de lui
/// seul — la forme `members` refuse donc encore un Écran sans objet de
/// contrôles. La demande est refusée entière au premier refus,
/// et un Écran nommé deux fois est refusé avant toute écriture.
pub(crate) fn set_stages_controls(
    document: &mut StoryDocument,
    stage_uuids: &[String],
    update: &ControlsUpdate,
) -> Result<(), GestureError> {
    if stage_uuids.is_empty() {
        return Err(GestureError::new(
            "EMPTY_STAGE_SELECTION",
            "/stageNodes",
            "Aucun Écran n'est désigné : le geste ne règle rien.".to_string(),
        ));
    }
    for (position, stage_uuid) in stage_uuids.iter().enumerate() {
        if stage_uuids[..position].contains(stage_uuid) {
            return Err(GestureError::new(
                "DUPLICATE_STAGE",
                &format!("/stageNodes/@uuid={stage_uuid}#0/controlSettings"),
                "Cet Écran est désigné deux fois dans la même demande.".to_string(),
            ));
        }
    }
    for stage_uuid in stage_uuids {
        set_stage_controls(document, stage_uuid, update)?;
    }
    Ok(())
}

/// Activation du contrôle qu'exige la prise d'où part un raccord : OK pour la
/// prise OK, HOME pour la prise HOME. Tirer depuis une prise dit déjà qu'on
/// veut cette sortie ; le raccord allume la touche qui la rend jouable, dans la
/// même transaction. Les autres membres et leur présence restent intacts, et la
/// lecture automatique n'est jamais allumée à la place d'OK : elle change la
/// façon dont l'Écran se joue, pas seulement la touche qui en sort.
pub(crate) fn activate_slot_control(
    document: &mut StoryDocument,
    stage_uuid: &str,
    slot: TransitionSlot,
) -> Result<(), GestureError> {
    let enabled = Some(ControlUpdate::Set { value: true });
    let members = match slot {
        TransitionSlot::Ok => ControlMembers {
            ok: enabled,
            ..ControlMembers::default()
        },
        TransitionSlot::Home => ControlMembers {
            home: enabled,
            ..ControlMembers::default()
        },
    };
    set_stage_controls(document, stage_uuid, &ControlsUpdate::Members { members })
}
