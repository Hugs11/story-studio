//! Writer de production d'un projet avancé.
//!
//! Il conduit le payload d'auteur jusqu'à une archive STUdio publiée, et refuse
//! avant d'écrire tout ce qui doit l'être. Les treize étapes, dans
//! l'ordre où elles se refusent :
//!
//! ```text
//!   ── PORTES SANS AUCUNE ÉCRITURE ────────────────────────────────
//!   1. decode_authoring_payload            → document + contexte
//!   2. porte readiness                     → refus précoce, résultat jamais transmis
//!   3. porte d'identité                    → refus AVANT tout effet sur les assets
//!   4. préflight du dossier de sortie      → écrit une sonde, ne publie rien
//!   ── ESPACE DE TRAVAIL LOCAL ────────────────────────────────────
//!   5-8. préparation des médias            → inventaire, conversion, registre, table
//!   9.  préparation de la copie + table    → readiness RECALCULÉE, règles de préparation
//!   10. sérialisation standard             → story.json
//!   11. écriture du ZIP local
//!   12. relecture réelle + contrôle exact d'archive
//!   ── PUBLICATION ────────────────────────────────────────────────
//!   13. transfert atomique                 → point unique
//! ```
//!
//! ## Ce que ce module ne fait pas
//!
//! Il ne mute **rien** de ce que l'auteur a enregistré : ni le document, ni son
//! contexte, ni son identité, ni ses liaisons, ni son fichier. Il reçoit une
//! chaîne de payload, en dérive une copie, et jette son espace de travail. Il
//! n'ouvre aucun écran, aucun funnel, aucune entrée de menu, et ne monte aucun
//! arbre hiérarchique : `hierarchicalProjectType` reste `null` pour un projet
//! avancé, qui ne traverse ni `projectToRustExport` ni le générateur
//! hiérarchique.
//!
//! ## Les deux points de publication
//!
//! Le préflight (étape 4) est la seule écriture hors espace de travail avant la
//! publication, et il ne publie pas : il crée le dossier de destination, y
//! dépose puis retire une sonde. `transfer_completed_zip` (étape 13) est le
//! **point de publication unique**, postérieur à toutes les validations
//! bloquantes — placer le renommage `.partial → .zip` avant le contrôle
//! d'archive ouvrirait une fenêtre pendant laquelle un autre outil peut ouvrir
//! une archive non validée.

use crate::native_pack::NativeGenerationWarning;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use super::assets::advanced::naming::ArchiveNameConflict;
use super::assets::advanced::oracle::OracleDisagreement;
pub(crate) use super::assets::advanced::plan::AdvancedAudioOptions;
use super::assets::advanced::report::{
    AdvancedAssetPreparation, AssetConversionRecord, PreparedDestination,
};
use super::assets::advanced::{
    prepare_advanced_assets, AssetPreparationError, MediaKind, MediaUnavailable,
};
use super::pack_zip::{write_pack_zip, ArchiveAsset, ArchiveContents, ZipWriteError};
use super::persistence::{decode_authoring_payload, AdvancedMediaBinding, PersistenceError};
use super::preparation::{
    pack_identity_for_export, prepare_graph_document_for_export_with_asset_names,
    refusal_from_readiness, serialize_prepared_graph_document, ExportPreparationError,
};
use super::readiness::assess_graph_document_export_readiness;
use super::writer::{
    encode_thumbnail_png, export_zip_path, preflight_output_directory, sanitized_project_name,
    transfer_completed_zip, TransferError,
};
use super::{DecodedStoryDocument, StoryDocument};
use crate::support::ffmpeg::{get_ffmpeg_path, now_millis};
use crate::support::paths::path_for_frontend;

mod archive;
mod workspace;

#[cfg(test)]
mod tests;

use archive::{verify_written_archive, ArchiveVerification};
use workspace::ExportWorkspace;

/// Ce qu'un export réussi rend à son appelant.
///
/// `conversions` s'affiche — c'est le rapport fichier par fichier ;
/// `destinations` se vérifie — c'est la carte qui dit quel contenu arrive
/// à quelle place du graphe. Les deux sont volontairement distincts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancedExportResult {
    pub(crate) zip_path: String,
    pub(crate) conversions: Vec<AssetConversionRecord>,
    pub(crate) destinations: Vec<PreparedDestination>,
    pub(crate) warnings: Vec<String>,
    /// Les avertissements d'harmonisation, de même forme que ceux de la
    /// génération par menus.
    pub(crate) audio_warnings: Vec<NativeGenerationWarning>,
    pub(crate) pack_identity: String,
    pub(crate) stage_id_map: BTreeMap<String, String>,
    pub(crate) asset_name_map: BTreeMap<String, String>,
    /// L'archive porte une couverture. Fausse quand l'écran d'entrée n'a pas
    /// d'image : c'est un succès sans couverture, jamais un refus.
    pub(crate) has_thumbnail: bool,
}

/// Les refus typés de l'export, avec de quoi les afficher plus tard.
///
/// Aucun n'est reconstruit depuis du texte, et aucun n'a de valeur par défaut
/// permettant de continuer : il n'existe ni substitution, ni saut d'entrée, ni
/// poursuite « au mieux ». Les cinq variantes d'`ExportPreparationError` sont
/// reprises telles quelles, sous le `kind` `preparation` — la porte d'identité
/// de l'étape 3 n'en ajoute aucune.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum AdvancedExportError {
    PayloadDecode {
        error: PersistenceError,
    },
    Preparation {
        error: ExportPreparationError,
    },
    MediaUnavailable {
        entries: Vec<MediaUnavailable>,
    },
    ArchiveNameCollision {
        conflicts: Vec<ArchiveNameConflict>,
    },
    MediaOracle {
        disagreements: Vec<OracleDisagreement>,
    },
    ExportCancelled,
    OutputWrite {
        path: String,
        message: String,
    },
}

impl std::fmt::Display for AdvancedExportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PayloadDecode { error } => write!(formatter, "Payload illisible : {error}"),
            Self::Preparation { error } => error.fmt(formatter),
            Self::MediaUnavailable { entries } => write!(
                formatter,
                "{} média(s) indisponible(s) : l'export est arrêté avant toute écriture d'archive.",
                entries.len()
            ),
            Self::ArchiveNameCollision { conflicts } => write!(
                formatter,
                "Collision de nom d'archive sur {} référence(s).",
                conflicts.len()
            ),
            Self::MediaOracle { disagreements } => write!(
                formatter,
                "Rattachement des médias en désaccord sur {} destination(s) : aucune archive n'est publiée.",
                disagreements.len()
            ),
            Self::ExportCancelled => formatter.write_str("Export annulé."),
            Self::OutputWrite { path, message } => {
                write!(formatter, "Écriture impossible dans '{path}' : {message}")
            }
        }
    }
}

impl From<ExportPreparationError> for AdvancedExportError {
    fn from(error: ExportPreparationError) -> Self {
        Self::Preparation { error }
    }
}

impl From<AssetPreparationError> for AdvancedExportError {
    fn from(error: AssetPreparationError) -> Self {
        match error {
            AssetPreparationError::MediaUnavailable(entries) => Self::MediaUnavailable { entries },
            AssetPreparationError::ArchiveNameCollision(conflicts) => {
                Self::ArchiveNameCollision { conflicts }
            }
            AssetPreparationError::MediaOracle(disagreements) => {
                Self::MediaOracle { disagreements }
            }
            AssetPreparationError::OutputWrite(error) => Self::OutputWrite {
                path: error.path,
                message: error.message,
            },
        }
    }
}

/// La publication distingue l'arrêt demandé de la panne subie.
///
/// `transfer_completed_zip` ne rend pas une simple chaîne, dont tout deviendrait
/// `output-write` : une annulation arrivée à l'entrée du transfert ou au milieu
/// de la copie serait rapportée comme une erreur d'écriture, alors qu'elle doit
/// rester `export-cancelled` à **toute** étape. On ne reconstruit jamais un type
/// depuis un message.
impl From<TransferError> for AdvancedExportError {
    fn from(error: TransferError) -> Self {
        match error {
            TransferError::Cancelled => Self::ExportCancelled,
            TransferError::Write { path, message } => Self::OutputWrite { path, message },
        }
    }
}

impl From<ZipWriteError> for AdvancedExportError {
    fn from(error: ZipWriteError) -> Self {
        Self::OutputWrite {
            path: error.path,
            message: match error.entry {
                Some(entry) => format!("écriture de '{entry}' : {}", error.message),
                None => error.message,
            },
        }
    }
}

/// Le même export, avec le geste de progression et d'annulation **déjà en
/// place** côté génération : le même canal d'événements et le même drapeau
/// partagé, sans en créer un second.
///
/// L'annulation est éprouvée avant publication : chaque étape la reteste, et un
/// abandon détruit l'espace de travail sans avoir rien publié.
#[allow(clippy::too_many_arguments)]
pub(crate) fn export_advanced_pack_with_cancel(
    payload: &str,
    bindings: &[AdvancedMediaBinding],
    output_folder: &Path,
    options: &AdvancedAudioOptions,
    archive_name: Option<&str>,
    story_title: Option<&str>,
    project_name: Option<&str>,
    cover_image: Option<&Path>,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<AdvancedExportResult, AdvancedExportError> {
    export_advanced_pack_inner(
        payload,
        bindings,
        output_folder,
        options,
        archive_name,
        story_title,
        project_name,
        cover_image,
        emit,
        should_cancel,
        None,
    )
}

/// Le même export, sur une racine d'espace de travail **imposée**.
///
/// Réservé aux bancs : un test qui prétend que l'export détruit son espace de
/// travail doit pouvoir nommer celui qu'il observe, sinon il lit le dossier
/// temporaire de la machine et se met à dépendre des autres tests.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn export_advanced_pack_within(
    payload: &str,
    bindings: &[AdvancedMediaBinding],
    output_folder: &Path,
    options: &AdvancedAudioOptions,
    archive_name: Option<&str>,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
    workspace_root: PathBuf,
) -> Result<AdvancedExportResult, AdvancedExportError> {
    export_advanced_pack_inner(
        payload,
        bindings,
        output_folder,
        options,
        archive_name,
        None,
        None,
        None,
        emit,
        should_cancel,
        Some(workspace_root),
    )
}

#[allow(clippy::too_many_arguments)]
fn export_advanced_pack_inner(
    payload: &str,
    bindings: &[AdvancedMediaBinding],
    output_folder: &Path,
    options: &AdvancedAudioOptions,
    archive_name: Option<&str>,
    story_title: Option<&str>,
    project_name: Option<&str>,
    cover_image: Option<&Path>,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
    workspace_root: Option<PathBuf>,
) -> Result<AdvancedExportResult, AdvancedExportError> {
    // ── Étape 1 : décodage. Aucune écriture. ────────────────────────────────
    let decoded = decode_authoring_payload(payload)
        .map_err(|error| AdvancedExportError::PayloadDecode { error })?;
    check_cancelled(should_cancel)?;

    // ── Étape 2 : porte readiness. Son résultat n'est transmis à personne :
    // l'étape 9 recalcule la sienne, et le raccord reste à sens unique. ──────
    let readiness = assess_graph_document_export_readiness(Ok(&decoded));
    if readiness.blocked {
        return Err(refusal_from_readiness(&readiness).into());
    }

    // ── Étape 3 : porte d'identité, sur le prédicat **partagé** avec la
    // préparation. La readiness ne bloque pas sur une identité non résolue ;
    // sans cette porte, un média manquant masquerait le défaut d'identité. ───
    let pack_identity = pack_identity_for_export(&decoded.context.pack_identity)?.to_string();
    check_cancelled(should_cancel)?;

    // ── Étape 4 : préflight. Il écrit une sonde et ne publie aucune archive.
    // Il est ici pour éviter de convertir une heure de son avant de découvrir
    // un dossier non inscriptible. ──────────────────────────────────────────
    emit("🔍 Contrôle du dossier de destination...");
    preflight_output_directory(output_folder).map_err(|message| {
        AdvancedExportError::OutputWrite {
            path: output_folder.to_string_lossy().to_string(),
            message,
        }
    })?;
    check_cancelled(should_cancel)?;

    // À partir d'ici, l'export écrit dans **son propre** espace de travail, et
    // nulle part ailleurs. Il est détruit sur tous les chemins de sortie.
    let workspace = ExportWorkspace::at(workspace_root.unwrap_or_else(unique_workspace_root))?;
    let outcome = run_within_workspace(
        &decoded,
        &pack_identity,
        bindings,
        output_folder,
        options,
        archive_name,
        story_title,
        project_name,
        cover_image,
        &workspace,
        emit,
        should_cancel,
    );
    let cleanup = workspace.destroy();

    match (outcome, cleanup) {
        (Ok(mut result), Err(warning)) => {
            // L'échec de nettoyage est **rapporté**, jamais masqué.
            result.warnings.push(warning);
            Ok(result)
        }
        (outcome, _) => outcome,
    }
}

#[allow(clippy::too_many_arguments)]
fn run_within_workspace(
    decoded: &DecodedStoryDocument,
    pack_identity: &str,
    bindings: &[AdvancedMediaBinding],
    output_folder: &Path,
    options: &AdvancedAudioOptions,
    archive_name: Option<&str>,
    story_title: Option<&str>,
    project_name: Option<&str>,
    cover_image: Option<&Path>,
    workspace: &ExportWorkspace,
    emit: &dyn Fn(&str),
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<AdvancedExportResult, AdvancedExportError> {
    // ── Étapes 5 à 8 : préparation des médias. L'inventaire est
    // complet avant la première conversion, et l'oracle de rattachement est
    // vérifié avant que le moindre nom entre dans la copie. ─────────────────
    emit("🧪 Préparation des médias du projet avancé...");
    let ffmpeg = resolve_ffmpeg(&decoded.document)?;
    let prepared_assets = prepare_advanced_assets(
        &decoded.document,
        bindings,
        &workspace.assets_root(),
        &ffmpeg,
        options,
    )?;
    emit(&format!(
        "  {} média(s) préparé(s), {} fichier(s) à écrire.",
        prepared_assets.assets.len(),
        prepared_assets.archive_entries.len()
    ));
    check_cancelled(should_cancel)?;

    // ── Étape 9 : préparation de la **copie**, portant la table de noms. La
    // readiness y est recalculée ; le document d'auteur n'est pas touché. ────
    let prepared = prepare_graph_document_for_export_with_asset_names(
        decoded,
        &prepared_assets.name_table,
        story_title,
        Some(project_name.unwrap_or("")),
    )?;
    check_cancelled(should_cancel)?;

    // ── Étape 10 : sérialisation standard de la copie. ──────────────────────
    let story_json = serialize_prepared_graph_document(&prepared)?;
    check_cancelled(should_cancel)?;

    // ── Étape 11 : ZIP **local**. Aucune archive n'est publiée ici. ─────────
    emit("📦 Assemblage du ZIP dans l'espace de travail...");
    let thumbnail_png = build_cover(&decoded.document, &prepared_assets, cover_image)?;
    let local_zip_path = write_local_archive(
        &story_json,
        &prepared_assets,
        thumbnail_png.clone(),
        workspace,
        &decoded.document,
        archive_name,
    )?;
    check_cancelled(should_cancel)?;

    // ── Étape 12 : relecture réelle et contrôle exact d'archive. Elle
    // n'emprunte pas la fonction qui vient d'écrire. ────────────────────────
    emit("🔎 Relecture de l'archive et contrôle des médias...");
    let ArchiveVerification { entry_names } = verify_written_archive(
        &local_zip_path,
        &story_json,
        &prepared_assets,
        thumbnail_png.is_some(),
    )?;
    emit(&format!(
        "  {} entrée(s) relue(s) et rattachée(s).",
        entry_names.len()
    ));
    check_cancelled(should_cancel)?;

    // ── Étape 13 : publication. Point unique, postérieur à tout. ────────────
    emit("📤 Transfert de l'archive vers le dossier choisi...");
    // Le transfert rend une issue **typée** : une annulation demandée pendant la
    // copie reste `export-cancelled`, elle ne devient pas une panne d'écriture.
    // Le motif rendu à l'interface ne doit pas dépendre de l'instant où
    // l'auteur a arrêté.
    let published = transfer_completed_zip(
        &local_zip_path,
        output_folder,
        &archive_base_name(&decoded.document, archive_name),
        should_cancel,
    )?;
    emit(&format!(
        "✅ Pack avancé exporté : {}",
        published.to_string_lossy()
    ));

    Ok(AdvancedExportResult {
        zip_path: path_for_frontend(&published),
        conversions: prepared_assets.assets.clone(),
        destinations: prepared_assets.destinations.clone(),
        warnings: Vec::new(),
        audio_warnings: prepared_assets.audio_warnings.clone(),
        pack_identity: pack_identity.to_string(),
        stage_id_map: prepared.stage_id_map.clone(),
        asset_name_map: prepared_assets
            .name_table
            .entries()
            .map(|(asset_ref, name)| (asset_ref.to_string(), name.to_string()))
            .collect(),
        has_thumbnail: thumbnail_png.is_some(),
    })
}

/// L'outil n'est exigé que si le document porte de l'audio, comme en mode
/// Libre : un projet sans son s'exporte sans FFmpeg résolu.
///
/// Le chemin vide rendu alors n'est jamais déréférencé : l'inventaire n'invoque
/// l'outil que sur sa branche audio, et un document sans référence audio n'y
/// entre pas. Refuser un export d'images faute d'un outil qu'on n'utilisera pas
/// serait un refus fabriqué.
///
/// Son absence, quand il est requis, est une panne d'outil de **notre** côté et
/// non un défaut du média : `output-write` sur l'outil, aucune référence
/// accusée, et le refus tombe avant qu'un seul instantané soit copié.
fn resolve_ffmpeg(document: &StoryDocument) -> Result<PathBuf, AdvancedExportError> {
    let needs_audio = document
        .stage_nodes
        .iter()
        .any(|stage| stage.audio.value().is_some_and(|v| !v.trim().is_empty()));
    if !needs_audio {
        return Ok(PathBuf::new());
    }
    get_ffmpeg_path().map_err(|message| AdvancedExportError::OutputWrite {
        path: "ffmpeg".to_string(),
        message,
    })
}

/// Couverture de l'archive.
///
/// Elle reprend l'**asset image préparé** de l'écran d'entrée — le Stage
/// `squareOne` du document d'auteur, identifié **avant** la permutation
/// des Stages —, pas une seconde lecture du fichier d'origine. Pas d'image
/// d'entrée, pas de couverture, et l'export réussit : jamais un refus, jamais
/// une image de remplacement, jamais l'image d'un autre écran.
///
/// Elle n'a donc aucun mode d'échec propre : le média dérive d'un asset déjà
/// validé et préparé, et tout défaut a été refusé en amont. Un échec de
/// ré-encodage PNG d'une image déjà décodée est un défaut interne, classé
/// `output-write`.
fn build_cover(
    document: &StoryDocument,
    prepared: &AdvancedAssetPreparation,
    preferred: Option<&Path>,
) -> Result<Option<Vec<u8>>, AdvancedExportError> {
    // Vignette catalogue déclarée par l'enveloppe : elle gagne, et elle est
    // encodée **telle quelle** — `encode_thumbnail_png` ré-encode sans
    // redimensionner, donc une vignette de taille libre le reste. C'est ce qui
    // la distingue de l'image d'entrée, qui est un asset déjà converti.
    //
    // Illisible, elle ne fait pas échouer l'export : la porte qui refuse un
    // média manquant est en amont, comme côté Libre, et ce module garde son
    // contrat de ne jamais refuser sur la couverture.
    if let Some(path) = preferred {
        if let Ok(bytes) = encode_thumbnail_png(path) {
            return Ok(Some(bytes));
        }
    }
    let Some(entry) = document
        .stage_nodes
        .iter()
        .find(|stage| stage.is_square_one())
    else {
        return Ok(None);
    };
    let Some(destination) = prepared.destinations.iter().find(|destination| {
        destination.stage_uuid == entry.uuid && destination.kind == MediaKind::Image
    }) else {
        return Ok(None);
    };
    let Some(source) = prepared
        .archive_entries
        .iter()
        .find(|candidate| candidate.archive_name == destination.archive_name)
    else {
        return Ok(None);
    };
    encode_thumbnail_png(&source.output_path)
        .map(Some)
        .map_err(|message| AdvancedExportError::OutputWrite {
            path: source.output_path.to_string_lossy().to_string(),
            message,
        })
}

fn write_local_archive(
    story_json: &str,
    prepared: &AdvancedAssetPreparation,
    thumbnail_png: Option<Vec<u8>>,
    workspace: &ExportWorkspace,
    document: &StoryDocument,
    archive_name: Option<&str>,
) -> Result<PathBuf, AdvancedExportError> {
    let local_dir = workspace.archive_root();
    fs::create_dir_all(&local_dir).map_err(|error| AdvancedExportError::OutputWrite {
        path: local_dir.to_string_lossy().to_string(),
        message: error.to_string(),
    })?;
    let zip_path = export_zip_path(&local_dir, &archive_base_name(document, archive_name));
    let assets = prepared
        .archive_entries
        .iter()
        .map(|entry| ArchiveAsset {
            archive_name: entry.archive_name.as_str(),
            source_path: entry.output_path.as_path(),
        })
        .collect();
    write_pack_zip(
        &ArchiveContents {
            story_json,
            assets,
            thumbnail_png,
        },
        &zip_path,
    )?;
    Ok(zip_path)
}

/// Le nom de l'archive.
///
/// Il vient de l'appelant quand celui-ci en a composé un — c'est exactement ce
/// que fait la chaîne Libre, qui transporte son nom de convention dans le nom
/// de projet et laisse le writer l'assainir. L'éditeur graphe le
/// compose aussi : l'auteur y choisit entre un nom de convention et un nom
/// libre, et la version qu'il a saisie y entre.
///
/// Sans nom demandé, c'est le titre du document. Un titre absent ou vide
/// retombe sur le nom neutre du writer.
///
/// L'assainissement reste ici, en un seul endroit : le laisser à l'appelant en
/// ferait deux règles, qui divergeraient au premier caractère interdit.
fn archive_base_name(document: &StoryDocument, requested: Option<&str>) -> String {
    let wanted = requested.map(str::trim).filter(|name| !name.is_empty());
    sanitized_project_name(wanted.unwrap_or_else(|| document.title.as_deref().unwrap_or("")))
}

fn check_cancelled(should_cancel: &(dyn Fn() -> bool + Sync)) -> Result<(), AdvancedExportError> {
    if should_cancel() {
        Err(AdvancedExportError::ExportCancelled)
    } else {
        Ok(())
    }
}

/// Racine d'un espace de travail d'export, unique par appel : deux exports
/// simultanés vers le même dossier de destination ne partagent aucun fichier
/// intermédiaire.
fn unique_workspace_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "story_studio_advanced_export_{}_{}",
        now_millis(),
        Uuid::new_v4()
    ))
}
