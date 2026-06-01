use serde_json::Number;

use super::super::{CanonicalStory, ControlSettings, Position, Transition};
use crate::domain::project::EntryControlSettings;

pub(crate) fn playback_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: false,
        home: true,
        pause: true,
        autoplay: true,
    }
}

pub(crate) fn night_story_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: true,
        home: true,
        pause: false,
        autoplay: true,
    }
}

pub(crate) fn post_playback_prompt_controls() -> ControlSettings {
    ControlSettings {
        wheel: false,
        ok: true,
        home: true,
        pause: false,
        autoplay: true,
    }
}

pub(crate) fn title_controls_from_settings(
    settings: Option<&EntryControlSettings>,
) -> ControlSettings {
    let fallback = ControlSettings {
        wheel: true,
        ok: true,
        home: true,
        pause: false,
        autoplay: false,
    };
    ControlSettings {
        wheel: settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel),
        ok: settings.and_then(|c| c.ok).unwrap_or(fallback.ok),
        home: settings.and_then(|c| c.home).unwrap_or(fallback.home),
        pause: settings.and_then(|c| c.pause).unwrap_or(fallback.pause),
        autoplay: settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay),
    }
}

pub(crate) fn should_emit_combined_story_stage(
    story: &CanonicalStory,
    has_night_mode: bool,
) -> bool {
    has_night_mode
        && story.title_control_settings.is_none()
        && story.item_audio == story.audio
        && story.wheel
        && story.autoplay
}

pub(crate) fn prompt_controls_from_settings(
    settings: Option<&EntryControlSettings>,
) -> ControlSettings {
    let fallback = post_playback_prompt_controls();
    ControlSettings {
        wheel: settings.and_then(|c| c.wheel).unwrap_or(fallback.wheel),
        ok: settings.and_then(|c| c.ok).unwrap_or(fallback.ok),
        home: settings.and_then(|c| c.home).unwrap_or(fallback.home),
        pause: settings.and_then(|c| c.pause).unwrap_or(fallback.pause),
        autoplay: settings
            .and_then(|c| c.autoplay)
            .unwrap_or(fallback.autoplay),
    }
}

pub(crate) fn transition(action_id: &str, option_index: i32) -> Transition {
    Transition {
        action_node: action_id.to_string(),
        option_index,
    }
}

pub(crate) fn stage_transition_uses_action(
    transition: Option<&Transition>,
    action_id: &str,
) -> bool {
    transition
        .map(|transition| transition.action_node == action_id)
        .unwrap_or(false)
}

pub(crate) fn action_node_name() -> String {
    "Action node".to_string()
}

pub(crate) fn zero_position() -> Position {
    Position {
        x: Number::from(0),
        y: Number::from(0),
    }
}
