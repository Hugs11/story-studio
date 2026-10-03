//! Préparation des médias d'un projet avancé.
//!
//! Ce module transforme les références médias d'un document d'auteur en
//! fichiers réellement prêts pour l'archive, et **prouve que chacun arrive à sa
//! destination**. Il n'écrit aucun ZIP : l'archive, sa couverture et sa
//! publication appartiennent à l'export, qui appelle ce module.
//!
//! ## L'enchaînement, et pourquoi il est dans cet ordre
//!
//! ```text
//! document + liaisons
//!   → inventaire   : résolution, instantané validé, format réel, décodabilité
//!   → plans        : un descripteur immuable par média, mesures comprises
//!   → exécution    : sorties adressées par clé de tâche, jamais par un chemin reçu
//!   → registre     : relu aux adresses dérivées, jamais aux retours d'exécution
//!   → table de noms: assetRef → sha1.ext, injective sur les huit derniers caractères
//!   → oracle       : la chaîne entière re-dérivée, destination par destination
//! ```
//!
//! L'inventaire est **complet** avant qu'une conversion commence : convertir une
//! heure de son pour découvrir ensuite qu'un autre média manque serait payer
//! cher un refus qu'on pouvait rendre tout de suite.
//!
//! ## Ce que ce module ne fait pas
//!
//! Il ne touche ni au document d'auteur, ni à son contexte, ni à ses liaisons :
//! il les lit. Il n'emprunte pas l'orchestration audio du mode Libre, qui refuse
//! un média silencieux valide **avant** d'envisager la copie verbatim — un
//! silence voulu par l'auteur n'est pas un média manquant. Il ne fait tourner
//! **aucun contrôle perceptuel** : la garantie 2 est un contrôle de conformance
//! borné, réservé aux bancs, et aucun média valide ne peut donc être refusé par
//! un résultat non concluant.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::native_pack::persistence::AdvancedMediaBinding;
use crate::native_pack::{NativeGenerationWarning, StoryDocument};
use crate::support::ffmpeg::file_ext;

pub(crate) mod digest;
pub(crate) mod executor;
pub(crate) mod format;
pub(crate) mod inventory;
pub(crate) mod naming;
pub(crate) mod oracle;
pub(crate) mod plan;
pub(crate) mod probe;
pub(crate) mod report;
pub(crate) mod workspace;

#[cfg(test)]
pub(crate) mod conformance;
#[cfg(test)]
mod tests;

use super::audio::harmonization_warning;
use super::parallel::{partition_map_parallel, try_map_parallel};
use executor::{read_registry, ExecutedConversion, ExecutionFailure, TaskExecutor};
use inventory::{inventory_media, media_destinations, InventoriedMedia, InventoryError};
use naming::{build_archive_name_table, ArchiveNameConflict, NameCandidate, NamingError};
use oracle::{verify_attachment, OracleDisagreement};
use plan::{plan_audio, plan_image, AdvancedAudioOptions, ConversionPlan, ConversionTask};
use probe::DEFAULT_TOOL_DEADLINE;
use report::{
    transformation_of, AdvancedAssetPreparation, AssetConversionRecord, PreparedDestination,
};
use workspace::{AdvancedWorkspace, WorkspaceError};

/// La nature d'une place du graphe : les deux seuls champs médias d'un Stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaKind {
    Audio,
    Image,
}

impl MediaKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            MediaKind::Audio => "audio",
            MediaKind::Image => "image",
        }
    }
}

/// Les onze causes d'indisponibilité d'un média, disjointes et ordonnées.
///
/// L'ordre de déclaration est celui de leur évaluation : la première qui
/// s'applique est retenue, et une entrée n'en reçoit jamais deux.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaCause {
    BindingAbsent,
    PathNull,
    NotFound,
    NotRegular,
    ReadDenied,
    Empty,
    Undecodable,
    ValidationFailed,
    ToolUnavailable,
    ToolInterrupted,
    ProcessingFailed,
}

/// Une entrée du refus agrégé `media-unavailable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaUnavailable {
    pub(crate) asset_ref: String,
    #[serde(rename = "field")]
    pub(crate) kind: MediaKind,
    pub(crate) stage_ids: Vec<String>,
    pub(crate) last_known_path: Option<String>,
    pub(crate) cause: MediaCause,
    /// Ce que l'outil ou le système a dit, comme **donnée** : jamais analysé
    /// pour choisir une cause.
    pub(crate) detail: String,
}

/// Un fichier prêt à écrire, une fois par nom d'archive distinct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedArchiveEntry {
    pub(crate) archive_name: String,
    pub(crate) output_path: PathBuf,
    pub(crate) output_sha256: String,
    pub(crate) output_bytes: u64,
}

/// Les quatre refus que la préparation peut rendre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AssetPreparationError {
    /// Agrégé, à causes typées : aucune archive, aucun média substitué.
    MediaUnavailable(Vec<MediaUnavailable>),
    ArchiveNameCollision(Vec<ArchiveNameConflict>),
    /// Défaut interne : la chaîne ne se referme pas sur elle-même.
    MediaOracle(Vec<OracleDisagreement>),
    /// Nos propres écritures, jamais une lecture source.
    OutputWrite(WorkspaceError),
}

impl From<WorkspaceError> for AssetPreparationError {
    fn from(error: WorkspaceError) -> Self {
        AssetPreparationError::OutputWrite(error)
    }
}

impl From<NamingError> for AssetPreparationError {
    fn from(error: NamingError) -> Self {
        match error {
            NamingError::Collision(conflicts) => {
                AssetPreparationError::ArchiveNameCollision(conflicts)
            }
            NamingError::Write(error) => AssetPreparationError::OutputWrite(error),
        }
    }
}

/// Prépare les médias du document, et rend de quoi écrire l'archive.
///
/// `workspace_root` appartient à l'appelant : ce module y écrit ses instantanés
/// et ses sorties, et **nulle part ailleurs**. Il ne le détruit pas non plus —
/// sa durée de vie et son nettoyage sont ceux de l'export.
pub(crate) fn prepare_advanced_assets(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    workspace_root: &Path,
    ffmpeg: &Path,
    options: &AdvancedAudioOptions,
) -> Result<AdvancedAssetPreparation, AssetPreparationError> {
    prepare_advanced_assets_within(
        document,
        bindings,
        workspace_root,
        ffmpeg,
        options,
        DEFAULT_TOOL_DEADLINE,
    )
}

/// Même chaîne, délai d'outil explicite. Les bancs s'en servent pour éprouver
/// le dépassement sans attendre le délai de production.
pub(crate) fn prepare_advanced_assets_within(
    document: &StoryDocument,
    bindings: &[AdvancedMediaBinding],
    workspace_root: &Path,
    ffmpeg: &Path,
    options: &AdvancedAudioOptions,
    deadline: Duration,
) -> Result<AdvancedAssetPreparation, AssetPreparationError> {
    let workspace = AdvancedWorkspace::open(workspace_root)?;
    let destinations = media_destinations(document);

    let media = inventory_media(document, bindings, &workspace, ffmpeg, deadline)
        .map_err(inventory_refusal)?;

    // Un descripteur par média, arrêté avant toute exécution.
    //
    // Planifier un son, c'est le **mesurer** : sa dynamique, ses silences de
    // bord. Chaque mesure est une lecture FFmpeg complète et n'a besoin que de
    // son propre instantané — d'où le parallélisme, qui ne change ni les
    // descripteurs produits, ni l'ordre dans lequel les défauts sont annoncés.
    let (planned, plan_failures) = partition_map_parallel(&media, |item| {
        let snapshot = workspace.snapshot_path(&item.snapshot_sha256);
        let plan = match item.kind {
            MediaKind::Audio => plan_audio(ffmpeg, &snapshot, item.mpeg_header, options, deadline),
            MediaKind::Image => {
                let facts = item
                    .image_facts
                    .expect("une image inventoriée porte ses dimensions");
                Ok(plan_image(
                    facts.width,
                    facts.height,
                    facts.studio_extension,
                ))
            }
        };
        match plan {
            Ok(plan) => Ok((
                item.asset_ref.clone(),
                ConversionTask::new(item.snapshot_sha256.clone(), plan),
            )),
            Err(failure) => Err(MediaUnavailable {
                asset_ref: item.asset_ref.clone(),
                kind: item.kind,
                stage_ids: stage_ids_of(&destinations, &item.asset_ref),
                last_known_path: Some(item.source_path.clone()),
                cause: failure.cause,
                detail: failure.detail,
            }),
        }
    });
    if !plan_failures.is_empty() {
        return Err(AssetPreparationError::MediaUnavailable(plan_failures));
    }
    let tasks: BTreeMap<String, ConversionTask> = planned.into_iter().collect();

    // Deux références de même instantané et de même plan sont **la même
    // tâche** : une exécution, une adresse.
    let mut distinct_tasks: Vec<ConversionTask> = Vec::new();
    for task in tasks.values() {
        if !distinct_tasks.iter().any(|known| known == task) {
            distinct_tasks.push(task.clone());
        }
    }

    // L'exécution, en parallèle. C'est la conversion elle-même, et de loin le
    // poste le plus cher d'une production.
    //
    // Deux propriétés de ce module la rendent parallélisable sans rien changer :
    // les tâches sont **déjà dédupliquées** ici, donc deux exécutions
    // concurrentes ne visent jamais la même adresse ; et chaque sortie est
    // adressée par sa clé de tâche, dérivée de son contenu, jamais par un chemin
    // reçu. Le registre est relu **après**, aux adresses dérivées — l'ordre de
    // retour des conversions n'entre donc nulle part.
    let executor = TaskExecutor::new(&workspace, ffmpeg, deadline);
    // Le reçu n'est pas conservé : le registre relit les adresses.
    try_map_parallel(&distinct_tasks, |task| {
        executor
            .run(task)
            .map_err(|failure| execution_refusal(failure, task, &media, &destinations))
    })?;

    let executed =
        read_registry(&workspace, &distinct_tasks).map_err(execution_refusal_without_media)?;
    let registry: BTreeMap<String, ExecutedConversion> = executed
        .into_iter()
        .map(|entry| (entry.task_key.clone(), entry))
        .collect();

    // Table des noms d'archive, allouée dans un ordre qui ne doit rien à
    // l'ordre de retour des conversions.
    let candidates: Vec<NameCandidate<'_>> = media
        .iter()
        .map(|item| {
            let task = &tasks[&item.asset_ref];
            let executed = &registry[&task.task_key()];
            NameCandidate {
                asset_ref: &item.asset_ref,
                output_sha256: &executed.output_sha256,
                output_path: &executed.output_path,
                extension: task.plan().output_extension(),
            }
        })
        .collect();
    let name_table = build_archive_name_table(&candidates)?;

    verify_attachment(
        &workspace,
        &destinations,
        &media,
        &tasks,
        &registry,
        &name_table,
    )
    .map_err(AssetPreparationError::MediaOracle)?;

    let audio_warnings =
        harmonization_warnings(document, ffmpeg, &media, &destinations, &tasks, &registry);
    let mut preparation = build_preparation(&media, &destinations, &tasks, &registry, name_table);
    preparation.audio_warnings = audio_warnings;
    Ok(preparation)
}

/// Les avertissements d'harmonisation, un par média qui en porte un, avec
/// le même message et les mêmes mesures que l'éditeur par menus. Le libellé
/// est celui de l'Écran qui fait entendre ce son.
fn harmonization_warnings(
    document: &StoryDocument,
    ffmpeg: &Path,
    media: &[InventoriedMedia],
    destinations: &[inventory::MediaDestination],
    tasks: &BTreeMap<String, ConversionTask>,
    registry: &BTreeMap<String, ExecutedConversion>,
) -> Vec<NativeGenerationWarning> {
    let mut warnings = Vec::new();
    for item in media {
        let task = &tasks[&item.asset_ref];
        let ConversionPlan::AudioEncode {
            notice: Some(notice),
            ..
        } = task.plan()
        else {
            continue;
        };
        let executed = &registry[&task.task_key()];
        warnings.push(harmonization_warning(
            ffmpeg,
            &executed.output_path,
            item.asset_ref.clone(),
            stage_label_of(document, destinations, &item.asset_ref),
            notice.clone(),
        ));
    }
    warnings
}

/// Le nom du premier Écran qui porte ce son, et combien d'autres le partagent.
/// Un Écran sans nom retombe sur la référence du média.
fn stage_label_of(
    document: &StoryDocument,
    destinations: &[inventory::MediaDestination],
    asset_ref: &str,
) -> String {
    let mut names: Vec<&str> = Vec::new();
    for destination in destinations
        .iter()
        .filter(|destination| destination.asset_ref == asset_ref)
    {
        let name = document
            .stage_nodes
            .iter()
            .find(|stage| stage.uuid == destination.stage_uuid)
            .map(|stage| stage.label().trim())
            .filter(|name| !name.is_empty());
        if let Some(name) = name {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    match names.as_slice() {
        [] => asset_ref.to_string(),
        [only] => (*only).to_string(),
        [first, rest @ ..] => format!("{first} (+{})", rest.len()),
    }
}

fn build_preparation(
    media: &[InventoriedMedia],
    destinations: &[inventory::MediaDestination],
    tasks: &BTreeMap<String, ConversionTask>,
    registry: &BTreeMap<String, ExecutedConversion>,
    name_table: naming::ArchiveNameTable,
) -> AdvancedAssetPreparation {
    let mut assets = Vec::with_capacity(media.len());
    let mut first_holder: BTreeMap<String, String> = BTreeMap::new();
    for item in media {
        let task = &tasks[&item.asset_ref];
        let task_key = task.task_key();
        let executed = &registry[&task_key];
        let archive_name = name_table
            .archive_name(&item.asset_ref)
            .expect("l'oracle a vérifié la complétude de la table")
            .to_string();
        let deduplicated_with = first_holder
            .entry(archive_name.clone())
            .or_insert_with(|| item.asset_ref.clone())
            .clone();
        let deduplicated_with = (deduplicated_with != item.asset_ref).then_some(deduplicated_with);

        let output_extension = task.plan().output_extension();
        let source_extension = file_ext(&item.source_path).to_ascii_lowercase();
        let resized = item
            .image_facts
            .is_some_and(|facts| facts.width != 320 || facts.height != 240);
        assets.push(AssetConversionRecord {
            asset_ref: item.asset_ref.clone(),
            archive_name,
            kind: item.kind,
            transformation: transformation_of(
                task.plan(),
                extensions_agree(&source_extension, output_extension),
                resized,
            ),
            reason: reason_for(item, task.plan()),
            detected_source_format: item.detected_source_format.clone(),
            output_format: output_extension.to_string(),
            snapshot_sha256: item.snapshot_sha256.clone(),
            task_key,
            output_sha256: executed.output_sha256.clone(),
            source_bytes: item.source_bytes,
            output_bytes: executed.output_bytes,
            applied_plan: task
                .plan()
                .applied()
                .into_iter()
                .map(|step| step.label())
                .collect(),
            deduplicated_with,
        });
    }

    let prepared_destinations = destinations
        .iter()
        .map(|destination| {
            let task = &tasks[&destination.asset_ref];
            let executed = &registry[&task.task_key()];
            PreparedDestination {
                stage_uuid: destination.stage_uuid.clone(),
                kind: destination.kind,
                asset_ref: destination.asset_ref.clone(),
                archive_name: name_table
                    .archive_name(&destination.asset_ref)
                    .expect("l'oracle a vérifié la complétude de la table")
                    .to_string(),
                output_sha256: executed.output_sha256.clone(),
            }
        })
        .collect();

    let mut archive_entries: Vec<PreparedArchiveEntry> = Vec::new();
    for record in &assets {
        if archive_entries
            .iter()
            .any(|entry| entry.archive_name == record.archive_name)
        {
            continue;
        }
        let executed = &registry[&record.task_key];
        archive_entries.push(PreparedArchiveEntry {
            archive_name: record.archive_name.clone(),
            output_path: executed.output_path.clone(),
            output_sha256: executed.output_sha256.clone(),
            output_bytes: executed.output_bytes,
        });
    }

    AdvancedAssetPreparation {
        assets,
        destinations: prepared_destinations,
        name_table,
        archive_entries,
        audio_warnings: Vec::new(),
    }
}

/// `.jpeg` et `.jpg` désignent le même format : un nom d'auteur en `.jpeg` sur
/// des octets JPEG n'a rien été « renommé ».
fn extensions_agree(source: &str, output: &str) -> bool {
    let normalize = |value: &str| {
        match value {
            "jpeg" => "jpg",
            other => other,
        }
        .to_string()
    };
    normalize(source) == normalize(output)
}

fn reason_for(item: &InventoriedMedia, plan: &ConversionPlan) -> String {
    match plan {
        ConversionPlan::AudioVerbatim => {
            "format réel conforme et aucune option demandée".to_string()
        }
        ConversionPlan::AudioEncode { .. } => match item.mpeg_header {
            Some(header) if header.is_studio_conform() => {
                "options d'harmonisation ou de silences demandées".to_string()
            }
            Some(header) => format!("audio non conforme : {}", header.label()),
            None => format!("audio non conforme : {}", item.detected_source_format),
        },
        ConversionPlan::ImageVerbatim { .. } => {
            "image déjà en 320×240 dans un format accepté".to_string()
        }
        ConversionPlan::ImageResizePng => match item.image_facts {
            Some(facts) if facts.width != 320 || facts.height != 240 => {
                format!("image {}×{} hors 320×240", facts.width, facts.height)
            }
            // Une extension hors liste fait disparaître le média en
            // silence chez STUdio. Le format est refait, pas le cadrage.
            _ => format!(
                "format image hors liste acceptée : {}",
                item.detected_source_format
            ),
        },
    }
}

fn stage_ids_of(destinations: &[inventory::MediaDestination], asset_ref: &str) -> Vec<String> {
    destinations
        .iter()
        .filter(|destination| destination.asset_ref == asset_ref)
        .map(|destination| destination.stage_uuid.clone())
        .collect()
}

fn inventory_refusal(error: InventoryError) -> AssetPreparationError {
    match error {
        InventoryError::Unavailable(entries) => AssetPreparationError::MediaUnavailable(entries),
        InventoryError::Write(error) => AssetPreparationError::OutputWrite(error),
        InventoryError::Disagreement(destinations) => AssetPreparationError::MediaOracle(
            destinations
                .into_iter()
                .map(|destination| OracleDisagreement {
                    asset_ref: destination.asset_ref,
                    stage_uuid: Some(destination.stage_uuid),
                    kind: Some(destination.kind),
                    expected: "une seule nature de destination".to_string(),
                    observed: format!(
                        "la référence occupe aussi une place {}",
                        match destination.kind {
                            MediaKind::Audio => MediaKind::Image.label(),
                            MediaKind::Image => MediaKind::Audio.label(),
                        }
                    ),
                })
                .collect(),
        ),
    }
}

fn execution_refusal(
    failure: ExecutionFailure,
    task: &ConversionTask,
    media: &[InventoriedMedia],
    destinations: &[inventory::MediaDestination],
) -> AssetPreparationError {
    match failure {
        ExecutionFailure::Media(plan_failure) => {
            let owner = media
                .iter()
                .find(|item| item.snapshot_sha256 == task.snapshot_sha256());
            AssetPreparationError::MediaUnavailable(vec![MediaUnavailable {
                asset_ref: owner.map(|item| item.asset_ref.clone()).unwrap_or_default(),
                kind: owner.map(|item| item.kind).unwrap_or(MediaKind::Audio),
                stage_ids: owner
                    .map(|item| stage_ids_of(destinations, &item.asset_ref))
                    .unwrap_or_default(),
                last_known_path: owner.map(|item| item.source_path.clone()),
                cause: plan_failure.cause,
                detail: plan_failure.detail,
            }])
        }
        other => execution_refusal_without_media(other),
    }
}

fn execution_refusal_without_media(failure: ExecutionFailure) -> AssetPreparationError {
    match failure {
        ExecutionFailure::Write(error) => AssetPreparationError::OutputWrite(error),
        ExecutionFailure::Oracle(message) => {
            AssetPreparationError::MediaOracle(vec![OracleDisagreement {
                asset_ref: String::new(),
                stage_uuid: None,
                kind: None,
                expected: "une sortie produite par cette préparation".to_string(),
                observed: message,
            }])
        }
        ExecutionFailure::Media(plan_failure) => {
            AssetPreparationError::MediaUnavailable(vec![MediaUnavailable {
                asset_ref: String::new(),
                kind: MediaKind::Audio,
                stage_ids: Vec::new(),
                last_known_path: None,
                cause: plan_failure.cause,
                detail: plan_failure.detail,
            }])
        }
    }
}
