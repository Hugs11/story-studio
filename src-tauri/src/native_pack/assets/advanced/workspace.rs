//! Adressage de l'espace de travail d'un export avancé.
//!
//! L'exécuteur fermé est le point de confiance de la garantie 1 : il dérive
//! **les deux extrémités du même descripteur**, et aucun appelant ne fournit de
//! chemin. Ce type est la moitié « adresse » de cette promesse. Il n'expose que
//! des dérivations pures d'une empreinte ou d'une clé de tâche, et **aucune**
//! fonction ne prend un chemin de l'extérieur.
//!
//! Les écritures faites ici sont les écritures locales autorisées :
//! instantanés et sorties de conversion, sous la racine confiée par l'appelant,
//! et nulle part ailleurs. Aucune archive n'est publiée depuis ce module.

use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOTS_DIR: &str = "snapshots";
const OUTPUTS_DIR: &str = "outputs";

/// Racine de travail d'une préparation, et les deux répertoires qu'elle porte.
#[derive(Debug, Clone)]
pub(crate) struct AdvancedWorkspace {
    root: PathBuf,
}

impl AdvancedWorkspace {
    /// Ouvre l'espace de travail sous `root`, en créant ses répertoires.
    ///
    /// L'échec est une panne d'écriture locale : c'est `output-write`, pas
    /// un défaut du média.
    pub(crate) fn open(root: &Path) -> Result<Self, WorkspaceError> {
        let workspace = Self {
            root: root.to_path_buf(),
        };
        for dir in [workspace.snapshots_dir(), workspace.outputs_dir()] {
            fs::create_dir_all(&dir).map_err(|error| WorkspaceError {
                path: dir.to_string_lossy().to_string(),
                message: error.to_string(),
            })?;
        }
        Ok(workspace)
    }

    pub(crate) fn snapshots_dir(&self) -> PathBuf {
        self.root.join(SNAPSHOTS_DIR)
    }

    pub(crate) fn outputs_dir(&self) -> PathBuf {
        self.root.join(OUTPUTS_DIR)
    }

    /// Adresse d'un instantané, dérivée de l'empreinte de son contenu.
    pub(crate) fn snapshot_path(&self, snapshot_sha256: &str) -> PathBuf {
        self.snapshots_dir().join(snapshot_sha256)
    }

    /// Adresse d'une sortie de conversion, dérivée de la clé de sa tâche.
    ///
    /// C'est la seule façon d'obtenir une destination de conversion : rien ne
    /// permet d'en composer une à partir d'autre chose que d'une clé de tâche.
    pub(crate) fn output_path(&self, task_key: &str) -> PathBuf {
        self.outputs_dir().join(task_key)
    }

    /// Temporaire privé à une tâche, renommé atomiquement vers son adresse
    /// définitive quand — et seulement quand — la tâche s'est achevée.
    pub(crate) fn pending_output_path(&self, task_key: &str) -> PathBuf {
        self.outputs_dir().join(format!("{task_key}.pending"))
    }
}

/// Panne d'écriture de l'espace de travail : `output-write`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceError {
    pub(crate) path: String,
    pub(crate) message: String,
}
