use crate::support::user_message::{codes, UserMessage};
use serde::Serialize;

use crate::domain::project::SilenceMode;

use super::CanonicalOptions;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NativeAssetStats {
    pub(crate) requested_asset_count: usize,
    pub(crate) unique_asset_count: usize,
    pub(crate) transformed_audio_count: usize,
    pub(crate) imported_zip_count: usize,
}

pub(crate) fn build_asset_notes(
    options: &CanonicalOptions,
    stats: &NativeAssetStats,
) -> Vec<String> {
    let mut notes = Vec::new();
    notes.push(UserMessage::new(codes::GENERATION_NATIVE_MEDIA_PIPELINE_NOTICE).into_transport());
    notes.push(UserMessage::new(codes::GENERATION_AUDIO_NORMALIZATION_NOTICE).into_transport());
    match options.silence_mode {
        SilenceMode::Off => {}
        SilenceMode::Add => {
            notes
                .push("Le silence debut/fin est ajoute pendant la preparation native.".to_string());
        }
        SilenceMode::Normalize => {
            notes.push(UserMessage::new(codes::GENERATION_AUDIO_SILENCE_NOTICE).into_transport());
        }
    }
    if stats.imported_zip_count > 0 {
        notes.push(UserMessage::new(codes::GENERATION_IMPORTED_ZIP_MERGE_NOTICE).into_transport());
    }
    if stats.unique_asset_count < stats.requested_asset_count {
        notes.push(UserMessage::new(codes::GENERATION_ASSET_DEDUPLICATION_NOTICE).into_transport());
    }
    notes
}
