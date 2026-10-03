//! Étape 12 : relecture réelle de l'archive locale, et contrôle exact.
//!
//! C'est la seconde moitié du contrôle d'archive : la préparation des médias
//! éprouve le **rattachement structurel** avant l'archive, et il reste à relire
//! le ZIP écrit.
//!
//! Le contrôle lui-même vit dans `native_pack::archive_review`, partagé avec la
//! chaîne Libre. Ce fichier n'en garde que ce qui est propre à
//! l'export avancé : traduire la préparation avancée en attentes, et un
//! désaccord en refus `media-oracle` **avant toute publication**. Tout écart
//! reste un défaut interne, et rien n'est publié.

use std::collections::BTreeSet;
use std::path::Path;

use super::super::archive_review::{
    review_written_archive, ArchiveExpectation, ExpectedArchiveEntry,
};
use super::super::assets::advanced::report::AdvancedAssetPreparation;
use super::AdvancedExportError;

/// Ce que la relecture a effectivement trouvé.
#[derive(Debug)]
pub(super) struct ArchiveVerification {
    pub(super) entry_names: Vec<String>,
}

/// Relit l'archive locale et confronte son contenu à la préparation.
pub(super) fn verify_written_archive(
    zip_path: &Path,
    expected_story_json: &str,
    prepared: &AdvancedAssetPreparation,
    expects_thumbnail: bool,
) -> Result<ArchiveVerification, AdvancedExportError> {
    let expectation = ArchiveExpectation {
        story_json: expected_story_json,
        distinct_names: prepared
            .name_table
            .distinct_names()
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<String>>(),
        entries: prepared
            .archive_entries
            .iter()
            .map(|entry| ExpectedArchiveEntry {
                archive_name: entry.archive_name.clone(),
                output_sha256: entry.output_sha256.clone(),
            })
            .collect(),
        expects_thumbnail,
    };

    let review = review_written_archive(zip_path, &expectation);
    if !review.disagreements.is_empty() {
        return Err(AdvancedExportError::MediaOracle {
            disagreements: review.disagreements,
        });
    }
    Ok(ArchiveVerification {
        entry_names: review.entry_names,
    })
}
