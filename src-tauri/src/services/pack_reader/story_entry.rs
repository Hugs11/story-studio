use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::after_playback::detect_story_return_stage_id;
use super::stage::{resolve_asset, stage_controls, stage_uuid};

pub(super) fn resolve_after_playback_sequence_assets(
    steps: &[serde_json::Value],
    assets: &HashMap<String, PathBuf>,
) -> Vec<serde_json::Value> {
    steps
        .iter()
        .map(|step| {
            let mut step = step.clone();
            let resolved_audio = step
                .get("audio")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets));
            step["audio"] = resolved_audio
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            let resolved_image = step
                .get("image")
                .and_then(|value| value.as_str())
                .and_then(|asset| resolve_asset(Some(asset), assets));
            step["image"] = resolved_image
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            step
        })
        .collect()
}

pub(super) fn resolve_after_playback_step_assets(
    step: &serde_json::Value,
    assets: &HashMap<String, PathBuf>,
) -> serde_json::Value {
    resolve_after_playback_sequence_assets(std::slice::from_ref(step), assets)
        .into_iter()
        .next()
        .unwrap_or(serde_json::Value::Null)
}
#[allow(clippy::too_many_arguments)]
pub(super) fn autoplay_stage_to_story_entry(
    stage: &serde_json::Value,
    name: String,
    item_audio: Option<String>,
    item_image: Option<String>,
    assets: &HashMap<String, PathBuf>,
    actions: &HashMap<&str, &serde_json::Value>,
    stages: &HashMap<&str, &serde_json::Value>,
    prompt_stage_usage: &HashMap<String, usize>,
    night_mode_available: bool,
    story_play_stage_ids: &HashSet<&str>,
) -> serde_json::Value {
    let detection = detect_story_return_stage_id(
        stage,
        stages,
        actions,
        prompt_stage_usage,
        night_mode_available,
        story_play_stage_ids,
    );
    let after_playback_prompt_audio = detection.prompt_stage_id.as_ref().and_then(|stage_id| {
        stages.get(stage_id.as_str()).and_then(|prompt_stage| {
            resolve_asset(prompt_stage.get("audio").and_then(|v| v.as_str()), assets)
        })
    });
    let after_playback_home_step = detection
        .home_step
        .as_ref()
        .map(|step| resolve_after_playback_step_assets(step, assets));

    serde_json::json!({
        "id": stage_uuid(stage).unwrap_or(""),
        "type": "story",
        "name": name,
        "audio": item_audio.clone(),
        "itemAudio": item_audio,
        "itemImage": item_image,
        "_playStageId": stage_uuid(stage),
        "returnStageId": detection.target_stage_id,
        "returnStoryStageId": detection.next_story_stage_id,
        "returnOnHomeStageId": detection
            .home_stage_id
            .clone()
            .filter(|target| Some(target.as_str()) != detection.target_stage_id.as_deref()),
        "returnOnHomeNone": detection.home_stage_id.is_none(),
        "homeStoryStageId": detection.home_story_stage_id,
        "afterPlaybackPromptAudio": after_playback_prompt_audio,
        "afterPlaybackPromptControlSettings": detection.prompt_control_settings,
        "afterPlaybackPromptOkStageId": detection.prompt_ok_stage_id,
        "afterPlaybackPromptHomeStageId": detection.prompt_home_stage_id,
        "afterPlaybackPromptHomeNone": detection.prompt_home_transition_none,
        "afterPlaybackSequence": resolve_after_playback_sequence_assets(&detection.after_playback_sequence, assets),
        "afterPlaybackHomeStep": after_playback_home_step,
        "controlSettings": stage_controls(stage),
    })
}
