//! L'exécuteur fermé : le point de confiance de la garantie 1.
//!
//! Il faut mesurer ce que l'adressage **ne** prouve pas : relire un fichier dit
//! ce qui s'y trouve, pas quelle tâche l'y a mis. En écrivant la conversion de
//! A à l'adresse de B et réciproquement, toutes les égalités du contrôle
//! d'archive passent. Ce qui empêche une écriture croisée n'est donc pas un
//! contrôle après coup — aucun n'y suffit — mais la **frontière d'exécution**.
//!
//! Elle tient à une règle unique, visible dans la signature de [`TaskExecutor::run`] :
//! **un seul argument, un descripteur**. Les deux extrémités en sont dérivées —
//! l'entrée de `snapshotSha256`, la sortie de `taskKey` —, le vecteur
//! d'arguments de l'outil est construit ici à partir du seul `plan`, et aucune
//! fonction de ce module n'accepte un chemin d'entrée ou de destination. Un
//! couple croisé n'est pas rejeté : il n'est pas **exprimable**.
//!
//! Ce que cette frontière ne couvre pas est assumé tel quel : une
//! faute **derrière** elle — code faux, outil ou système de fichiers qui
//! corrompt — n'est détectée par aucune de ces égalités. Le filet
//! complémentaire est la garantie 2, bornée aux fixtures distinguables.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use super::super::audio::mp3_encode_args;
use super::super::image::ensure_image_320x240;
use super::super::parallel::try_map_parallel;
use super::digest::sha256_file;
use super::plan::{ConversionPlan, ConversionTask, PlanFailure};
use super::probe::{classify, run_tool, StdoutHandling, ToolOperation};
use super::workspace::{AdvancedWorkspace, WorkspaceError};

/// Ce qui peut arrêter une exécution, dans les trois familles de refus de la préparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExecutionFailure {
    /// `media-unavailable`, avec sa cause typée.
    Media(PlanFailure),
    /// `output-write` : nos propres écritures.
    Write(WorkspaceError),
    /// `media-oracle` : adresse occupée par un contenu étranger, tâche non
    /// terminée.
    Oracle(String),
}

impl From<WorkspaceError> for ExecutionFailure {
    fn from(error: WorkspaceError) -> Self {
        ExecutionFailure::Write(error)
    }
}

/// Ce qu'une exécution rend à son appelant : **rien d'exploitable**.
///
/// C'est délibéré : le registre ne lit aucun retour de conversion, il relit les
/// adresses dérivées des clés. Inverser deux reçus est donc sans effet sur ce
/// que la préparation observe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionReceipt {
    task_key: String,
}

impl ExecutionReceipt {
    /// Réservé aux comptes rendus et aux contre-épreuves ; le registre ne
    /// l'appelle pas.
    pub(crate) fn task_key(&self) -> &str {
        &self.task_key
    }
}

/// Exécute des tâches, et rien d'autre.
pub(crate) struct TaskExecutor<'a> {
    workspace: &'a AdvancedWorkspace,
    ffmpeg: &'a Path,
    deadline: Duration,
    /// Les clés de tâche **revendiquées** par cette préparation.
    ///
    /// Le mémo était un `HashSet` simple tant que les tâches s'exécutaient une
    /// par une. Depuis qu'elles s'exécutent en parallèle, il porte l'invariant
    /// qui rend cette concurrence sûre — « une clé de tâche, une exécution, une
    /// adresse » — et il doit donc être revendiqué **avant** le travail, pas
    /// constaté après : deux exécutions concurrentes de la même clé écriraient
    /// sinon le même fichier temporaire.
    claimed: Mutex<HashSet<String>>,
}

impl<'a> TaskExecutor<'a> {
    pub(crate) fn new(
        workspace: &'a AdvancedWorkspace,
        ffmpeg: &'a Path,
        deadline: Duration,
    ) -> Self {
        Self {
            workspace,
            ffmpeg,
            deadline,
            claimed: Mutex::new(HashSet::new()),
        }
    }

    /// Exécute **une** tâche décrite par **un** descripteur.
    ///
    /// Aucun chemin n'entre ici et aucun n'en sort : l'entrée, le temporaire et
    /// la destination sont dérivés du descripteur. C'est la surface que
    /// les bancs éprouvent.
    pub(crate) fn run(&self, task: &ConversionTask) -> Result<ExecutionReceipt, ExecutionFailure> {
        let task_key = task.task_key();
        let input = self.workspace.snapshot_path(task.snapshot_sha256());
        let output = self.workspace.output_path(&task_key);
        let pending = self.workspace.pending_output_path(&task_key);

        // Deux références de même instantané et de même plan sont la même
        // tâche : une exécution, une adresse. C'est la déduplication, et elle
        // est **atomique** — la revendication et son constat ne peuvent pas être
        // séparés par une autre exécution.
        if !self.claim(&task_key) {
            return Ok(ExecutionReceipt { task_key });
        }

        // Une tâche en défaut n'est **pas** une tâche exécutée : sa
        // revendication est rendue, en un seul endroit plutôt qu'à chacune des
        // neuf sorties d'erreur du corps.
        match self.execute_claimed(task, &task_key, &input, &output, &pending) {
            Ok(()) => Ok(ExecutionReceipt { task_key }),
            Err(failure) => {
                self.release(&task_key);
                Err(failure)
            }
        }
    }

    /// Revendique une clé de tâche. Faux si cette préparation l'a déjà prise.
    fn claim(&self, task_key: &str) -> bool {
        self.claimed
            .lock()
            .expect("mémo des tâches revendiquées")
            .insert(task_key.to_string())
    }

    /// Rend une revendication, une tâche en défaut n'ayant rien produit.
    fn release(&self, task_key: &str) {
        self.claimed
            .lock()
            .expect("mémo des tâches revendiquées")
            .remove(task_key);
    }

    /// Le corps de l'exécution, une fois la clé revendiquée.
    fn execute_claimed(
        &self,
        task: &ConversionTask,
        task_key: &str,
        input: &Path,
        output: &Path,
        pending: &Path,
    ) -> Result<(), ExecutionFailure> {
        if output.exists() {
            return Err(ExecutionFailure::Oracle(format!(
                "l'adresse de sortie {} est occupée par un contenu que cette préparation n'a pas produit",
                output.display()
            )));
        }

        // Le répertoire de destination est créé et vérifié **avant** l'appel :
        // une destination sous un parent absent ferait sortir l'outil en échec
        // et l'auteur s'entendrait dire de remplacer un média sain.
        let outputs_dir = self.workspace.outputs_dir();
        fs::create_dir_all(&outputs_dir).map_err(|error| write_error(&outputs_dir, &error))?;

        if !outputs_dir.is_dir() {
            return Err(ExecutionFailure::Write(WorkspaceError {
                path: outputs_dir.to_string_lossy().to_string(),
                message: "répertoire de sortie indisponible".to_string(),
            }));
        }
        let _ = fs::remove_file(pending);

        match task.plan() {
            ConversionPlan::AudioVerbatim | ConversionPlan::ImageVerbatim { .. } => {
                fs::copy(input, pending).map_err(|error| write_error(pending, &error))?;
            }
            ConversionPlan::AudioEncode { filters, .. } => {
                let run = run_tool(
                    self.ffmpeg,
                    &mp3_encode_args(input, pending, filters),
                    self.deadline,
                    StdoutHandling::Discard,
                );
                if let Some(cause) =
                    classify(ToolOperation::Conversion, &run.outcome, run.produced_data())
                {
                    let _ = fs::remove_file(pending);
                    return Err(ExecutionFailure::Media(PlanFailure {
                        cause,
                        detail: run.detail(),
                    }));
                }
            }
            ConversionPlan::ImageResizePng => {
                let bytes = fs::read(input).map_err(|error| write_error(input, &error))?;
                let png = encode_png_320x240(&bytes).map_err(|message| {
                    ExecutionFailure::Media(PlanFailure {
                        cause: super::MediaCause::ProcessingFailed,
                        detail: message,
                    })
                })?;
                fs::write(pending, &png).map_err(|error| write_error(pending, &error))?;
            }
        }

        // La fin de tâche est constatée avant la publication de sa sortie : le
        // renommage n'a lieu que sur un travail achevé.
        if !pending.is_file() {
            return Err(ExecutionFailure::Oracle(format!(
                "la tâche {task_key} n'a pas produit de sortie"
            )));
        }
        fs::rename(pending, output).map_err(|error| write_error(output, &error))?;
        Ok(())
    }
}

/// Ce que le registre porte pour une tâche, **relu à son adresse**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutedConversion {
    pub(crate) task_key: String,
    pub(crate) output_path: PathBuf,
    pub(crate) output_sha256: String,
    pub(crate) output_bytes: u64,
}

/// Construit le registre **après** que toutes les tâches sont terminées.
///
/// Il ne lit aucun reçu : pour chaque descripteur, il recalcule la clé, en
/// dérive l'adresse, et relit ce qui s'y trouve. Inverser deux retours de
/// conversion ne change donc rien à ce que cette fonction observe.
pub(crate) fn read_registry(
    workspace: &AdvancedWorkspace,
    tasks: &[ConversionTask],
) -> Result<Vec<ExecutedConversion>, ExecutionFailure> {
    // Chaque entrée est relue à une adresse dérivée de sa propre clé de tâche,
    // et son empreinte ne dépend que de son contenu : deux entrées ne peuvent
    // ni se gêner, ni s'influencer. Le relevé reste dans l'ordre des tâches.
    try_map_parallel(tasks, |task| {
        let task_key = task.task_key();
        let output_path = workspace.output_path(&task_key);
        if !output_path.is_file() {
            return Err(ExecutionFailure::Oracle(format!(
                "la tâche {task_key} n'a laissé aucune sortie à son adresse"
            )));
        }
        let (output_sha256, output_bytes) =
            sha256_file(&output_path).map_err(|error| write_error(&output_path, &error))?;
        Ok(ExecutedConversion {
            task_key,
            output_path,
            output_sha256,
            output_bytes,
        })
    })
}

/// Redimensionne si besoin, et encode **toujours** en PNG.
///
/// `ensure_image_320x240` rend `None` dès que l'image mesure déjà 320×240,
/// quelle que soit son extension : c'est le trou qu'un `.webp` de 320×240
/// traverse pour être perdu en silence chez STUdio. Ce cas doit être réencodé ;
/// la brique est donc réutilisée telle quelle, et son `None` signifie ici
/// « dimensions déjà bonnes, format à refaire ».
fn encode_png_320x240(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if let Some(resized) = ensure_image_320x240(bytes, "média avancé")? {
        return Ok(resized);
    }
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(out)
}

fn write_error(path: &Path, error: &std::io::Error) -> ExecutionFailure {
    ExecutionFailure::Write(WorkspaceError {
        path: path.to_string_lossy().to_string(),
        message: error.to_string(),
    })
}
