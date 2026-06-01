use std::collections::{HashMap, HashSet};

use super::stage::{
    is_stage_autoplay, stage_action_options, stage_control_bool, stage_controls, stage_uuid,
};
use super::transitions::{
    has_transition_target, resolve_transition_return_stage_id, transition_action_options,
    transition_target_stage_id,
};

struct PromptStageDetection<'a> {
    stage_id: &'a str,
    ok_target_stage_id: Option<&'a str>,
    home_target_stage_id: Option<&'a str>,
    home_transition_none: bool,
    control_settings: serde_json::Value,
}

pub(super) fn is_named_night_bridge_stage(stage: &serde_json::Value) -> bool {
    let name = stage
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    name.eq_ignore_ascii_case("nightStage")
        && !stage_control_bool(stage, "wheel", false)
        && stage
            .get("audio")
            .and_then(|value| value.as_str())
            .is_some()
}

pub(super) fn is_imported_night_mode_stage_candidate(
    stage: &serde_json::Value,
    actions: &HashMap<&str, &serde_json::Value>,
) -> bool {
    !stage_control_bool(stage, "wheel", false)
        && stage
            .get("audio")
            .and_then(|value| value.as_str())
            .is_some()
        && has_transition_target(stage.get("okTransition"), actions)
}

fn resolve_playback_completion_stage_id<'a>(
    transition: Option<&'a serde_json::Value>,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    let mut current = transition_target_stage_id(transition, actions)?;
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current) {
            return Some(current);
        }
        let Some(stage) = stages.get(current) else {
            return Some(current);
        };

        let is_non_selectable_autoplay =
            is_stage_autoplay(stage) && !stage_control_bool(stage, "wheel", false);
        let should_follow = is_non_selectable_autoplay
            || (stage_control_bool(stage, "ok", false)
                && !stage_control_bool(stage, "wheel", false));
        if !should_follow {
            return Some(current);
        }

        let Some(next) = transition_target_stage_id(stage.get("okTransition"), actions) else {
            return Some(current);
        };
        if next == current {
            return Some(current);
        }
        current = next;
    }
}

fn candidate_prompt_stage<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<PromptStageDetection<'a>> {
    let direct_home_target = transition_target_stage_id(play_stage.get("homeTransition"), actions)?;
    let direct_ok_target = transition_target_stage_id(play_stage.get("okTransition"), actions)?;

    if direct_ok_target == direct_home_target {
        return None;
    }

    let prompt_stage = stages.get(direct_ok_target)?;
    let prompt_home = transition_target_stage_id(prompt_stage.get("homeTransition"), actions);
    let prompt_ok = transition_target_stage_id(prompt_stage.get("okTransition"), actions);
    let prompt_has_audio = prompt_stage.get("audio").and_then(|v| v.as_str()).is_some();
    let prompt_ok_enabled = stage_control_bool(prompt_stage, "ok", false);

    if !is_named_night_bridge_stage(prompt_stage)
        && prompt_has_audio
        && prompt_ok_enabled
        && prompt_ok.is_some()
        && prompt_ok != Some(direct_ok_target)
        && (prompt_home.is_none()
            || prompt_home == Some(direct_home_target)
            || prompt_home == prompt_ok)
    {
        Some(PromptStageDetection {
            stage_id: direct_ok_target,
            ok_target_stage_id: prompt_ok,
            home_target_stage_id: prompt_home,
            home_transition_none: prompt_home.is_none(),
            control_settings: stage_controls(prompt_stage),
        })
    } else {
        None
    }
}

pub(super) fn candidate_prompt_stage_id<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
) -> Option<&'a str> {
    candidate_prompt_stage(play_stage, stages, actions).map(|candidate| candidate.stage_id)
}

pub(super) struct StoryReturnDetection {
    pub(super) target_stage_id: Option<String>,
    pub(super) home_stage_id: Option<String>,
    pub(super) prompt_stage_id: Option<String>,
    pub(super) prompt_ok_stage_id: Option<String>,
    pub(super) prompt_home_stage_id: Option<String>,
    pub(super) prompt_home_transition_none: bool,
    pub(super) prompt_control_settings: Option<serde_json::Value>,
    pub(super) after_playback_sequence: Vec<serde_json::Value>,
    pub(super) home_step: Option<serde_json::Value>,
    #[cfg(test)]
    pub(super) advanced: bool,
    pub(super) next_story_stage_id: Option<String>,
    pub(super) home_story_stage_id: Option<String>,
}

struct AfterPlaybackSequenceDetection {
    steps: Vec<serde_json::Value>,
    pub(super) home_step: Option<serde_json::Value>,
    final_target_stage_id: Option<String>,
}

/// Retourne true si `stage_id` est un play stage d'histoire (autoplay+audio) ou un stage de titre
/// qui mène directement (single option) à un tel play stage.
/// Ceci couvre les packs où okTransition pointe sur le stage titre de l'épisode suivant plutôt que
/// directement sur son stage de lecture.
fn is_story_stage_entry<'a>(
    stage_id: &'a str,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
    story_play_stage_ids: &HashSet<&str>,
) -> bool {
    if story_play_stage_ids.contains(stage_id) {
        return true;
    }
    // Un stage titre (non autoplay) avec une seule option menant à un play stage
    if let Some(stage) = stages.get(stage_id) {
        if is_after_playback_sequence_stage(stage) {
            return false;
        }
        if !is_stage_autoplay(stage) {
            let opts = stage_action_options(stage, actions);
            if opts.len() == 1 && story_play_stage_ids.contains(opts[0]) {
                return true;
            }
        }
    }
    false
}

fn is_after_playback_sequence_stage(stage: &serde_json::Value) -> bool {
    let wheel = stage_control_bool(stage, "wheel", false);
    !wheel && (is_stage_autoplay(stage) || stage_control_bool(stage, "ok", false))
}

fn detect_after_playback_sequence(
    play_stage: &serde_json::Value,
    stages: &HashMap<&str, &serde_json::Value>,
    actions: &HashMap<&str, &serde_json::Value>,
    story_play_stage_ids: &HashSet<&str>,
) -> Option<AfterPlaybackSequenceDetection> {
    let mut current = transition_target_stage_id(play_stage.get("okTransition"), actions)?;
    let mut visited = HashSet::new();
    let mut steps = Vec::new();
    let mut final_target_stage_id = None;

    loop {
        if !visited.insert(current.to_string()) {
            break;
        }
        if is_story_stage_entry(current, stages, actions, story_play_stage_ids) {
            final_target_stage_id = Some(current.to_string());
            break;
        }

        let Some(stage) = stages.get(current) else {
            final_target_stage_id = Some(current.to_string());
            break;
        };
        if !is_after_playback_sequence_stage(stage) {
            final_target_stage_id = Some(current.to_string());
            break;
        }

        let next_target = transition_target_stage_id(stage.get("okTransition"), actions);
        let next_is_terminal = next_target
            .map(|target| {
                is_story_stage_entry(target, stages, actions, story_play_stage_ids)
                    || stages
                        .get(target)
                        .map(|next_stage| !is_after_playback_sequence_stage(next_stage))
                        .unwrap_or(true)
            })
            .unwrap_or(true);

        let mut step = serde_json::json!({
            "id": stage_uuid(stage).unwrap_or(""),
            "name": stage.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "audio": serde_json::Value::Null,
            "image": serde_json::Value::Null,
            "controlSettings": stage_controls(stage),
            "homeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
            "homeFollowsOk": has_transition_target(stage.get("homeTransition"), actions)
                && transition_target_stage_id(stage.get("homeTransition"), actions) == next_target,
            "homeNone": !has_transition_target(stage.get("homeTransition"), actions),
        });
        if let Some(audio) = stage.get("audio").and_then(|v| v.as_str()) {
            step["audio"] = serde_json::Value::String(audio.to_string());
        }
        if let Some(image) = stage.get("image").and_then(|v| v.as_str()) {
            step["image"] = serde_json::Value::String(image.to_string());
        }
        if next_is_terminal {
            if let Some(target) = next_target {
                step["okStageId"] = serde_json::Value::String(target.to_string());
                final_target_stage_id = Some(target.to_string());
            }
            let choice_options = transition_action_options(stage.get("okTransition"), actions);
            if choice_options.len() > 1 {
                step["okChoiceStageIds"] = serde_json::Value::Array(
                    choice_options
                        .into_iter()
                        .map(|target| serde_json::Value::String(target.to_string()))
                        .collect(),
                );
            }
        }
        steps.push(step);

        let Some(next) = next_target else {
            break;
        };
        if next_is_terminal {
            break;
        }
        current = next;
    }

    let home_step = transition_target_stage_id(play_stage.get("homeTransition"), actions)
        .and_then(|home_stage_id| {
            let first_step_id = steps
                .first()
                .and_then(|step| step.get("id"))
                .and_then(|value| value.as_str());
            if Some(home_stage_id) == first_step_id {
                return None;
            }
            let stage = stages.get(home_stage_id)?;
            if !is_after_playback_sequence_stage(stage) {
                return None;
            }
            let next_target = transition_target_stage_id(stage.get("okTransition"), actions);
            let mut step = serde_json::json!({
                "id": stage_uuid(stage).unwrap_or(""),
                "name": stage.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "audio": serde_json::Value::Null,
                "image": serde_json::Value::Null,
                "controlSettings": stage_controls(stage),
                "homeStageId": transition_target_stage_id(stage.get("homeTransition"), actions),
                "homeFollowsOk": has_transition_target(stage.get("homeTransition"), actions)
                    && transition_target_stage_id(stage.get("homeTransition"), actions) == next_target,
                "homeNone": !has_transition_target(stage.get("homeTransition"), actions),
            });
            if let Some(audio) = stage.get("audio").and_then(|v| v.as_str()) {
                step["audio"] = serde_json::Value::String(audio.to_string());
            }
            if let Some(image) = stage.get("image").and_then(|v| v.as_str()) {
                step["image"] = serde_json::Value::String(image.to_string());
            }
            Some(step)
        });

    if steps.len() > 1 {
        Some(AfterPlaybackSequenceDetection {
            steps,
            home_step,
            final_target_stage_id,
        })
    } else {
        None
    }
}

pub(super) fn detect_story_return_stage_id<'a>(
    play_stage: &'a serde_json::Value,
    stages: &'a HashMap<&str, &serde_json::Value>,
    actions: &'a HashMap<&str, &serde_json::Value>,
    prompt_stage_usage: &HashMap<String, usize>,
    _night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> StoryReturnDetection {
    let direct_home_target = transition_target_stage_id(play_stage.get("homeTransition"), actions);
    let direct_ok_target = transition_target_stage_id(play_stage.get("okTransition"), actions);
    let direct_ok_is_night_bridge = direct_ok_target
        .and_then(|stage_id| stages.get(stage_id))
        .is_some_and(|stage| is_named_night_bridge_stage(stage));
    let candidate_prompt = if direct_ok_is_night_bridge {
        None
    } else {
        candidate_prompt_stage(play_stage, stages, actions)
    };
    let sequence = if !direct_ok_is_night_bridge && candidate_prompt.is_none() {
        detect_after_playback_sequence(play_stage, stages, actions, story_play_stage_ids)
    } else {
        None
    };

    // Story→story uniquement si le stage courant est autoplay (stage de lecture réel).
    // On accepte aussi que la cible soit un stage titre qui mène à un play stage (packs Toudou-like).
    let is_autoplay = is_stage_autoplay(play_stage);
    let ok_is_story = is_autoplay
        && direct_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let home_is_story = is_autoplay
        && direct_home_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let prompt_ok_is_story = is_autoplay
        && candidate_prompt
            .as_ref()
            .and_then(|candidate| candidate.ok_target_stage_id)
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let sequence_ok_target = sequence
        .as_ref()
        .and_then(|sequence| sequence.final_target_stage_id.as_deref());
    let sequence_ok_is_story = is_autoplay
        && sequence_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));
    let completion_ok_target = if !direct_ok_is_night_bridge
        && !ok_is_story
        && candidate_prompt.is_none()
        && sequence.is_none()
    {
        resolve_playback_completion_stage_id(play_stage.get("okTransition"), stages, actions)
    } else {
        None
    };
    let completion_ok_is_story = is_autoplay
        && completion_ok_target
            .is_some_and(|id| is_story_stage_entry(id, stages, actions, story_play_stage_ids));

    let next_story_stage_id = if ok_is_story {
        direct_ok_target.map(str::to_string)
    } else if prompt_ok_is_story {
        candidate_prompt
            .as_ref()
            .and_then(|candidate| candidate.ok_target_stage_id)
            .map(str::to_string)
    } else if sequence_ok_is_story {
        sequence_ok_target.map(str::to_string)
    } else if completion_ok_is_story {
        completion_ok_target.map(str::to_string)
    } else {
        None
    };
    let home_story_stage_id = if home_is_story {
        direct_home_target.map(str::to_string)
    } else {
        None
    };

    let home_target =
        resolve_transition_return_stage_id(play_stage.get("homeTransition"), stages, actions);
    let ok_target =
        resolve_transition_return_stage_id(play_stage.get("okTransition"), stages, actions);
    let target_stage_id = if let Some(candidate) = candidate_prompt.as_ref() {
        candidate.ok_target_stage_id.map(str::to_string)
    } else if sequence.is_some() {
        sequence_ok_target
            .filter(|target| !is_story_stage_entry(target, stages, actions, story_play_stage_ids))
            .map(str::to_string)
    } else {
        match (home_target, ok_target, completion_ok_target) {
            (_, _, Some(completion))
                if Some(completion) != direct_ok_target
                    && !is_story_stage_entry(completion, stages, actions, story_play_stage_ids) =>
            {
                Some(completion.to_string())
            }
            (Some(home), Some(ok), _) if home == ok => Some(home.to_string()),
            _ => None,
        }
    };

    let prompt_stage_id = if sequence.is_some() {
        None
    } else {
        candidate_prompt.as_ref().and_then(|stage_id| {
            let usage = prompt_stage_usage
                .get(stage_id.stage_id)
                .copied()
                .unwrap_or(0);
            if usage <= 1 {
                Some(stage_id.stage_id.to_string())
            } else {
                None
            }
        })
    };
    let prompt_ok_stage_id = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .and_then(|candidate| candidate.ok_target_stage_id.map(str::to_string));
    let prompt_home_stage_id = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .and_then(|candidate| candidate.home_target_stage_id.map(str::to_string));
    let prompt_home_transition_none = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .map(|candidate| candidate.home_transition_none)
        .unwrap_or(false);
    let prompt_control_settings = prompt_stage_id
        .as_ref()
        .and(candidate_prompt.as_ref())
        .map(|candidate| candidate.control_settings.clone());

    let after_playback_sequence = sequence
        .as_ref()
        .map(|sequence| sequence.steps.clone())
        .unwrap_or_default();
    let home_step = sequence
        .as_ref()
        .and_then(|sequence| sequence.home_step.clone());

    #[cfg(test)]
    let advanced = if !after_playback_sequence.is_empty()
        || prompt_stage_id.is_some()
        || candidate_prompt.is_some()
        || ok_is_story
        || home_is_story
    {
        false
    } else {
        match (direct_home_target, direct_ok_target, home_target, ok_target) {
            (Some(direct_home), Some(direct_ok), Some(home), Some(ok)) => {
                direct_home != direct_ok || direct_home != home || direct_ok != ok
            }
            (Some(_), None, Some(_), None) => false,
            (None, None, None, None) => false,
            _ => true,
        }
    };

    StoryReturnDetection {
        target_stage_id,
        home_stage_id: home_target.map(|value| value.to_string()),
        prompt_stage_id,
        prompt_ok_stage_id,
        prompt_home_stage_id,
        prompt_home_transition_none,
        prompt_control_settings,
        after_playback_sequence,
        home_step,
        #[cfg(test)]
        advanced,
        next_story_stage_id,
        home_story_stage_id,
    }
}
