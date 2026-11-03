//! Reuses the existing asset inventory, conversion plans and bundled FFmpeg.
//! Device image plans use the same inventory, executor and output oracle.
use super::{check, failure, PrepStep, Result};
use crate::native_pack::{
    advanced_export::AdvancedExportError, persistence::AdvancedMediaBinding,
    prepare_storyteller_assets, StoryDocument,
};
use crate::support::user_message::{codes, UserMessage};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) fn prepare(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    owned: &Path,
    cancel: &AtomicBool,
    on_step: &mut dyn FnMut(PrepStep),
) -> Result<HashMap<String, PathBuf>> {
    check(cancel)?;
    if document
        .stage_nodes
        .iter()
        .all(|s| s.image.value().is_none() && s.audio.value().is_none_or(|r| r.is_empty()))
    {
        return Ok(HashMap::new());
    }
    let ffmpeg = crate::support::ffmpeg::get_ffmpeg_path().map_err(UserMessage::from)?;
    let prepared = prepare_storyteller_assets(
        document,
        bindings,
        &owned.join("assets"),
        &ffmpeg,
        Some(cancel),
        // Sounds win when both kinds are re-encoded: one label, the heavier work.
        &mut |notice| {
            on_step(if notice.audio {
                PrepStep::ConvertingSounds
            } else {
                PrepStep::ConvertingImages
            })
        },
    );
    // Priorité à l'annulation, y compris si une tâche en cours a échoué.
    check(cancel)?;
    let prepared = prepared
        .map_err(|e| {
            let detail = format!("{e:?}");
            unreadable(document, e.into()).unwrap_or_else(|| failure(detail))
        })?
        .ok_or_else(|| UserMessage::new(codes::GENERATION_CANCELLED))?;
    let mut paths = HashMap::new();
    for destination in prepared.destinations {
        check(cancel)?;
        let entry = prepared
            .archive_entries
            .iter()
            .find(|e| e.archive_name == destination.archive_name)
            .ok_or_else(|| failure("missing converted media"))?;
        paths.insert(destination.asset_ref, entry.output_path.clone());
    }
    Ok(paths)
}

/// A medium the engine cannot decode is a fault of the pack itself, the same at
/// every attempt: a refusal naming the screen that carries it (its author
/// label), never a path or a file name. Other unavailable media stay failures.
fn unreadable(document: &StoryDocument, error: AdvancedExportError) -> Option<UserMessage> {
    let AdvancedExportError::MediaUnavailable { entries } = error else {
        return None;
    };
    // Causes that describe the file's content, not its access or the tools.
    let damaged = |cause: &serde_json::Value| {
        matches!(
            cause.as_str(),
            Some("undecodable" | "validation-failed" | "empty")
        )
    };
    let entry = entries.iter().find(|entry| {
        serde_json::to_value(entry.cause)
            .ok()
            .is_some_and(|cause| damaged(&cause))
    })?;
    let screen = entry.stage_ids.iter().find_map(|id| {
        document
            .stage_nodes
            .iter()
            .find(|stage| &stage.uuid == id)
            .and_then(|stage| stage.name.value())
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
    });
    let image = entry.kind.label() == "image";
    Some(match (image, screen) {
        (true, Some(screen)) => {
            UserMessage::new(codes::STORYTELLER_IMAGE_UNREADABLE).param("screen", screen)
        }
        (true, None) => UserMessage::new(codes::STORYTELLER_IMAGE_UNREADABLE_UNNAMED),
        (false, Some(screen)) => {
            UserMessage::new(codes::STORYTELLER_SOUND_UNREADABLE).param("screen", screen)
        }
        (false, None) => UserMessage::new(codes::STORYTELLER_SOUND_UNREADABLE_UNNAMED),
    })
}
