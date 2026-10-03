use super::super::{CanonicalStory, ControlSettings, Position, Presence, Transition};
use crate::domain::project::EntryControlSettings;

pub(crate) fn playback_controls() -> ControlSettings {
    ControlSettings::authored(false, false, true, true, true)
}

pub(crate) fn night_story_controls(autoplay: bool) -> ControlSettings {
    ControlSettings::authored(false, true, true, false, autoplay)
}

pub(crate) fn post_playback_prompt_controls() -> ControlSettings {
    ControlSettings::authored(false, true, true, false, true)
}

pub(crate) fn title_controls_from_settings(
    settings: Option<&EntryControlSettings>,
) -> ControlSettings {
    let fallback = ControlSettings::authored(true, true, true, false, false);
    ControlSettings::authored(
        settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel()),
        settings.and_then(|c| c.ok).unwrap_or(fallback.ok()),
        settings.and_then(|c| c.home).unwrap_or(fallback.home()),
        settings.and_then(|c| c.pause).unwrap_or(fallback.pause()),
        settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay()),
    )
}

pub(crate) fn should_emit_combined_story_stage(
    story: &CanonicalStory,
    has_night_mode: bool,
) -> bool {
    let imported_direct_stage = story
        .native_stage_id
        .as_deref()
        .is_some_and(|stage_id| !stage_id.trim().is_empty())
        && story.audio.is_some()
        && story.item_audio.is_none()
        && story.item_image.is_none()
        && story.title_control_settings.is_none();

    imported_direct_stage
        || (has_night_mode
            && story.title_control_settings.is_none()
            && story.item_audio == story.audio
            && story.wheel
            && story.autoplay)
}

pub(crate) fn prompt_controls_from_settings(
    settings: Option<&EntryControlSettings>,
) -> ControlSettings {
    let fallback = post_playback_prompt_controls();
    ControlSettings::authored(
        settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel()),
        settings.and_then(|c| c.ok).unwrap_or(fallback.ok()),
        settings.and_then(|c| c.home).unwrap_or(fallback.home()),
        settings.and_then(|c| c.pause).unwrap_or(fallback.pause()),
        settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay()),
    )
}

/// Une transition vers une option d'indice connu : les constructeurs Libre
/// choisissent toujours une destination précise, jamais `Random`.
pub(crate) fn transition(action_id: &str, option_index: usize) -> Transition {
    Transition::fixed(action_id, option_index)
}

pub(crate) fn stage_transition_uses_action(
    transition: Option<&Transition>,
    action_id: &str,
) -> bool {
    transition
        .map(|transition| transition.action_node == action_id)
        .unwrap_or(false)
}

/// Le nom que les constructeurs Libre donnent explicitement à leurs Actions.
/// C'est un choix d'auteur du builder, pas le repli de lecture retiré du
/// modèle : il est émis.
pub(crate) fn action_node_name() -> Presence<String> {
    Presence::Value(super::super::ACTION_NODE_FALLBACK_NAME.to_string())
}

/// Le `type` que les constructeurs Libre donnent explicitement à leurs Stages.
pub(crate) fn default_stage_type() -> Presence<String> {
    Presence::Value(super::super::STAGE_TYPE_FALLBACK.to_string())
}

/// Un nœud créé par un constructeur Libre ne porte aucune position d'auteur.
/// Une disposition synthétique se range dans l'état d'éditeur, pas dans le
/// document ; la préparation n'émet `position` que si elle vient de la source
/// ou d'une intention explicite. Un `{0,0}` posé par ces constructeurs ne serait
/// ni l'un ni l'autre.
pub(crate) fn no_authored_position() -> Presence<Position> {
    Presence::Absent
}
