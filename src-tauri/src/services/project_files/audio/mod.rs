pub(crate) mod edit;
pub(crate) mod embed;
pub(crate) mod pipeline;

pub use edit::*;
pub use embed::*;
pub use pipeline::*;

/// Format de travail sans perte de l'espace de travail. On n'encode en MP3
/// qu'à la génération du pack ; tout l'audio manipulé par l'app (assemblage,
/// éditions) reste en FLAC pour ne plus empiler d'encodages lossy.
pub(crate) const WORKING_AUDIO_EXTENSION: &str = "flac";

/// Formats déjà sans perte, conservés tels quels par les éditions. Les autres
/// (mp3/ogg/m4a/aac/webm) sont convertis vers `WORKING_AUDIO_EXTENSION` à la
/// première édition.
pub(crate) const LOSSLESS_WORKING_EXTENSIONS: &[&str] = &["flac", "wav"];

/// Extension de sortie d'une édition pour une entrée donnée : on garde un
/// format sans perte existant, sinon on bascule vers FLAC.
pub(crate) fn working_output_extension(input_ext: &str) -> String {
    let ext = input_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if LOSSLESS_WORKING_EXTENSIONS.contains(&ext.as_str()) {
        ext
    } else {
        WORKING_AUDIO_EXTENSION.to_string()
    }
}
