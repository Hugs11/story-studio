use serde::Serialize;

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
    notes.push("Le pipeline assets natif prepare deja les medias hors SPG.".to_string());
    if options.convert_format {
        notes.push("Les audios sont reencodes en mp3 44.1 kHz mono quand necessaire.".to_string());
    } else {
        notes.push("La conversion audio globale est desactivee : les fichiers compatibles sont conserves tels quels.".to_string());
    }
    if options.add_silence {
        notes.push("Le silence debut/fin est ajoute pendant la preparation native.".to_string());
    }
    if stats.imported_zip_count > 0 {
        notes.push("Les ZIPs importes sont prepares pour fusion native sans SPG.".to_string());
    }
    if stats.unique_asset_count < stats.requested_asset_count {
        notes.push(
            "La deduplication de contenu fonctionne deja au niveau des assets prepares."
                .to_string(),
        );
    }
    notes
}
