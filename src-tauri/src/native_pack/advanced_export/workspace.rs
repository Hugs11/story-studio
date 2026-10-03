//! L'espace de travail d'un export, et sa propriété.
//!
//! L'export possède et nettoie **ses seuls** fichiers. Aucun cache de projet
//! n'est utilisé comme preuve, et aucun fichier temporaire n'entre dans le
//! `.mbah`. Cet espace est donc créé à chaque appel, sous une racine qui ne
//! peut appartenir à personne d'autre, et détruit sur **tous** les chemins de
//! sortie — succès, refus, annulation.
//!
//! Sa destruction n'est pas silencieuse : un échec est rendu à l'appelant, qui
//! le rapporte. Un espace de travail resté sur le disque est une fuite, qu'il ne faut
//! pas masquer.

use std::fs;
use std::path::PathBuf;

use super::AdvancedExportError;

/// Les deux territoires d'un export : la préparation des médias, et l'archive
/// locale. Ils sont séparés pour que le périmètre d'écriture de chacun soit
/// lisible dans le chemin lui-même.
pub(super) struct ExportWorkspace {
    root: PathBuf,
}

impl ExportWorkspace {
    pub(super) fn at(root: PathBuf) -> Result<Self, AdvancedExportError> {
        fs::create_dir_all(&root).map_err(|error| AdvancedExportError::OutputWrite {
            path: root.to_string_lossy().to_string(),
            message: error.to_string(),
        })?;
        Ok(Self { root })
    }

    /// Racine confiée à la préparation des médias, qui y écrit ses
    /// instantanés et ses sorties — et nulle part ailleurs.
    pub(super) fn assets_root(&self) -> PathBuf {
        self.root.join("assets")
    }

    /// Dossier du ZIP local, avant publication.
    pub(super) fn archive_root(&self) -> PathBuf {
        self.root.join("archive")
    }

    /// Détruit l'espace de travail. L'échec est rendu comme un texte à
    /// rapporter, jamais comme un refus : à ce stade l'archive est publiée, et
    /// un dossier temporaire résiduel n'invalide pas l'export.
    pub(super) fn destroy(self) -> Result<(), String> {
        match fs::remove_dir_all(&self.root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                let message = format!(
                    "L'espace de travail temporaire '{}' n'a pas pu être supprimé : {error}",
                    self.root.display()
                );
                log::warn!(target: "advanced_export", "{message}");
                Err(message)
            }
        }
    }
}
