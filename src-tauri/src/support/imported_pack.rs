use crate::support::user_message;
use crate::support::user_message::codes;
#[cfg(test)]
use crate::support::user_message::MessageTransportAssertions as _;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use crate::native_pack::{StoryDocument, StoryDocumentContext};
use crate::services::project_files::{validate_existing_dir_path, validate_existing_file_path};
use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};
use crate::support::ffmpeg::{apply_no_window, now_millis};
use crate::support::tool_resolver::{
    path_dirs, push_candidate, push_development_candidates, push_path_candidates,
    push_resource_candidates, resolve_regular_file, resource_dir,
};

mod bundle;
pub(crate) mod cancellation;
mod source_tree;
mod studio_folder;

pub(crate) use bundle::portable_key as archive_portable_key;
pub use bundle::BundleChildEntry;
use bundle::{collect_bundle_children, has_annex_archives, BUNDLE_CONTAINER_FINGERPRINT_VERSION};
use source_tree::{
    archive_entry_name, cache_key_for_source as source_cache_key, is_link_or_reparse,
    revalidate_regular_entry,
};
pub(crate) use studio_folder::StudioFolder;

pub(crate) const IMPORTED_PACK_CACHE_DIR: &str = "story_studio_imported_pack_cache";
// Incrémenter à chaque évolution du story.json produit par la conversion (voir
// cache_key_for_source) pour ignorer les zips convertis par une version antérieure.
// Le prédicat Python corrigé peut changer la présence du uuid racine projeté.
const CONVERSION_FORMAT_VERSION: &str = "v5-studio-v1-python-uuid-provenance";
const MAX_TOTAL_EXTRACTED_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Ce qu'une conversion sait du pack source et que le ZIP produit ne porte plus.
///
/// Une projection FS efface l'origine du pack : son `story.json` est un document
/// STUdio ordinaire. Sans cette provenance, la relecture du ZIP converti le
/// classe `imported-studio`, perd le quadrillage d'éditeur, les provenances
/// natives et la qualification `UNTESTED` de `version:256`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "conversion", rename_all = "kebab-case")]
pub(crate) enum PackConversionProvenance {
    /// Dossier Studio zippé tel quel : le décodeur du `story.json` suffit.
    StudioDirectory,
    /// Projection d'un pack filesystem natif, identifiée par le nom de son
    /// dossier source.
    #[serde(rename_all = "camelCase")]
    FsProjection { directory_identity: String },
}

/// Le ZIP Studio d'un import et la provenance de sa conversion, rendus
/// disponibles ensemble à la frontière d'import.
#[derive(Debug, Clone)]
pub(crate) struct ImportedStudioPack {
    pub(crate) zip_path: PathBuf,
    pub(crate) provenance: Option<PackConversionProvenance>,
}

impl ImportedStudioPack {
    /// Un ZIP Studio conforme, utilisé sans conversion ni cache.
    fn untouched(zip_path: PathBuf) -> Self {
        Self {
            zip_path,
            provenance: None,
        }
    }

    /// Le contexte de la conversion, reconstruit par la projection elle-même
    /// sur le document réellement relu.
    ///
    /// Le contexte n'est pas sérialisé à côté du ZIP : deux conversions
    /// concurrentes de la même source tirent des UUID de Stage différents, donc
    /// un instantané pourrait se retrouver apparié au ZIP publié par l'autre.
    /// Seule la provenance, identique pour toute conversion d'une même source,
    /// est mise en cache ; `imported_fs` en redéduit le contexte complet, y
    /// compris le quadrillage d'éditeur, à partir du document relu.
    pub(crate) fn conversion_context(
        &self,
        document: &StoryDocument,
    ) -> Option<StoryDocumentContext> {
        match self.provenance.as_ref()? {
            PackConversionProvenance::StudioDirectory => None,
            PackConversionProvenance::FsProjection { directory_identity } => Some(
                StoryDocumentContext::imported_fs(document, directory_identity),
            ),
        }
    }
}

/// Enveloppe du fichier de provenance publié à côté du ZIP mis en cache.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversionSidecar {
    conversion_format_version: String,
    #[serde(flatten)]
    provenance: PackConversionProvenance,
}

pub(crate) fn validate_existing_pack_path(path: &str) -> Result<PathBuf, String> {
    let canonical = validate_existing_file_path(path, codes::FILES_IMPORTED_ARCHIVE_TRANSPORT)?;
    let extension = pack_extension(&canonical);
    if !matches!(extension.as_deref(), Some("zip" | "7z")) {
        return Err({
            let _msg_canonical = (canonical.display()).to_string();
            user_message::UserMessage::new(codes::IMPORT_ARCHIVE_EXTENSION_INVALID)
                .param(
                    "canonical",
                    user_message::transport_param(_msg_canonical.clone()),
                )
                .with_detail(format!(
                    "Le fichier n'est ni un ZIP ni un 7z : {_msg_canonical}",
                    _msg_canonical = user_message::transport_detail(&_msg_canonical)
                ))
                .into_transport()
        });
    }
    Ok(canonical)
}

/// Ce qu'une archive importée s'est révélée être : un pack, ou une enveloppe
/// qui en contient plusieurs.
///
/// La distinction ne duplique aucune reconnaissance de pack : elle n'existe
/// qu'après l'échec de `locate_pack_root`, qui reste la seule vérité sur la
/// présence d'un pack dans un arbre extrait.
pub enum ImportedPackSource {
    Pack(ImportedStudioPack),
    Bundle(BundleInventory),
}

/// L'inventaire d'une enveloppe, et la session temporaire qui le rend lisible.
///
/// Les fichiers des enfants vivent dans cette session : elle est supprimée dès
/// que l'inventaire est relâché, au succès comme à l'erreur comme à l'abandon.
pub struct BundleInventory {
    children: Vec<BundleChildEntry>,
    workspace: ImportWorkspace,
}

impl BundleInventory {
    pub fn children(&self) -> &[BundleChildEntry] {
        &self.children
    }

    /// La racine de la session temporaire, pour prouver qu'elle disparaît avec
    /// l'inventaire. Aucune autre lecture n'en a besoin.
    #[cfg(test)]
    fn workspace_root(&self) -> PathBuf {
        self.workspace.root().to_path_buf()
    }

    /// Le fichier d'un enfant dans la session, revalidé au plus près de son
    /// ouverture : un enfant désigné par un identifiant inconnu n'existe pas.
    fn child_file(&self, child_id: &str) -> Result<PathBuf, String> {
        let child = self
            .children
            .iter()
            .find(|child| child.child_id == child_id)
            .ok_or_else(|| {
                user_message::UserMessage::new(codes::IMPORT_BUNDLE_SELECTION_STALE)
                    .with_detail(
                        "Ce pack ne fait pas partie de l'archive ouverte. Rouvrez l'archive pour \
                    rafraîchir sa liste."
                            .to_string(),
                    )
                    .into_transport()
            })?;
        let metadata = fs::symlink_metadata(&child.absolute).map_err(|e| {
            let _msg_e = (e).to_string();
            user_message::UserMessage::new(codes::FILES_CHOSEN_PACK_BECAME_UNREADABLE)
                .param("error", user_message::transport_param(_msg_e.clone()))
                .with_detail(format!(
                    "Le pack choisi est devenu illisible : {_msg_e}",
                    _msg_e = user_message::transport_detail(&_msg_e)
                ))
                .into_transport()
        })?;
        if is_link_or_reparse(&metadata) || !metadata.is_file() {
            return Err(
                user_message::UserMessage::new(codes::IMPORT_CHOSEN_PACK_IRREGULAR)
                    .with_detail("Le pack choisi n'est pas un fichier régulier.".to_string())
                    .into_transport(),
            );
        }
        let canonical = fs::canonicalize(&child.absolute).map_err(|e| {
            let _msg_e = (e).to_string();
            user_message::UserMessage::new(codes::FILES_CHOSEN_PACK_BECAME_UNREADABLE)
                .param("error", user_message::transport_param(_msg_e.clone()))
                .with_detail(format!(
                    "Le pack choisi est devenu illisible : {_msg_e}",
                    _msg_e = user_message::transport_detail(&_msg_e)
                ))
                .into_transport()
        })?;
        let canonical_workspace = fs::canonicalize(self.workspace.root()).map_err(|e| {
            let _msg_e = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_CHOSEN_TEMP_FOLDER_UNREADABLE)
                .param("error", user_message::transport_param(_msg_e.clone()))
                .with_detail(format!(
                    "Le dossier temporaire du pack choisi est devenu illisible : {_msg_e}",
                    _msg_e = user_message::transport_detail(&_msg_e),
                ))
                .into_transport()
        })?;
        if !canonical.starts_with(&canonical_workspace) {
            return Err(
                user_message::UserMessage::new(codes::IMPORT_CHOSEN_PACK_OUTSIDE)
                    .with_detail("Le pack choisi est sorti de son dossier temporaire.".to_string())
                    .into_transport(),
            );
        }
        Ok(canonical)
    }
}

/// Session temporaire d'import supprimée dès qu'elle n'est plus tenue — succès,
/// erreur, abandon ou retour anticipé. Aucun chemin de sortie ne peut l'oublier.
struct ImportWorkspace {
    root: PathBuf,
}

impl ImportWorkspace {
    fn create_in(parent: &Path, cache_key: &str) -> Result<Self, String> {
        let root = unique_import_workspace_in(parent, cache_key);
        fs::create_dir_all(&root).map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_TEMP_FOLDER_PREPARE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de preparer le dossier temporaire d'import : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
        })?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for ImportWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) fn ensure_studio_pack_zip(path: &str) -> Result<ImportedStudioPack, String> {
    ensure_studio_pack_zip_cancellable(path, &AtomicBool::new(false))
}
pub(crate) fn ensure_studio_pack_zip_cancellable(
    path: &str,
    cancel: &AtomicBool,
) -> Result<ImportedStudioPack, String> {
    match ensure_studio_pack_source_cancellable(path, cancel)? {
        ImportedPackSource::Pack(pack) => Ok(pack),
        ImportedPackSource::Bundle(inventory) => {
            Err(bundle_rejection_message(inventory.children.len()))
        }
    }
}

/// Existing archive conversion with an explicitly owned local cache. Both
/// extraction workspace and published conversion stay under this directory.
pub(crate) fn ensure_studio_pack_zip_in_cancellable(
    path: &str,
    cache_dir: &Path,
    cancel: &AtomicBool,
) -> Result<ImportedStudioPack, String> {
    let result = ensure_studio_pack_source_inner(path, cancel, Some(cache_dir));
    cancellation::check(cancel)?;
    match result? {
        ImportedPackSource::Pack(pack) => Ok(pack),
        ImportedPackSource::Bundle(inventory) => {
            Err(bundle_rejection_message(inventory.children.len()))
        }
    }
}

/// Le message rendu aux appels qui attendent un pack et reçoivent une
/// enveloppe. Il remplace « aucun pack reconnu », qui décrivait un symptôme
/// plutôt que la situation, et il nomme la porte d'entrée qui sait la traiter.
fn bundle_rejection_message(children: usize) -> String {
    {
        let _msg_children = (children).to_string();
        user_message::UserMessage::new(
            codes::IMPORT_BUNDLE_SELECTION_REQUIRED,
        )
            .param("children", user_message::transport_param(_msg_children.clone()))
            .with_detail(format!(
                "Cette archive n'est pas un pack : elle contient {_msg_children} packs. Ouvrez-la depuis « Modifier un pack » pour choisir lequel ouvrir.",
                _msg_children = user_message::transport_detail(&_msg_children),
            ))
            .into_transport()
    }
}

/// L'empreinte de contenu du conteneur, rendue au frontend avec l'inventaire et
/// exigée en retour à la sélection : une archive remplacée entre les deux ne
/// peut pas voir son ancien inventaire appliqué à son nouveau contenu.
pub fn bundle_container_fingerprint(path: &str) -> Result<String, String> {
    let source = validate_existing_pack_path(path)?;
    source_cache_key(&source, BUNDLE_CONTAINER_FINGERPRINT_VERSION)
}

pub fn ensure_studio_pack_source(path: &str) -> Result<ImportedPackSource, String> {
    ensure_studio_pack_source_cancellable(path, &AtomicBool::new(false))
}
fn ensure_studio_pack_source_cancellable(
    path: &str,
    cancel: &AtomicBool,
) -> Result<ImportedPackSource, String> {
    let result = ensure_studio_pack_source_inner(path, cancel, None);
    cancellation::check(cancel)?;
    result
}
fn ensure_studio_pack_source_inner(
    path: &str,
    cancel: &AtomicBool,
    cache_dir: Option<&Path>,
) -> Result<ImportedPackSource, String> {
    cancellation::check(cancel)?;
    let source = validate_existing_pack_path(path)?;
    let extension = pack_extension(&source);
    if extension.as_deref() == Some("zip") && zip_contains_story_json(&source)? {
        // L'interface conserve le chemin du ZIP converti, pas la structure Rust.
        // Lorsqu'elle le rouvre, la provenance doit traverser cette frontière.
        // Ne pas interpréter un fichier compagnon d'une archive utilisateur.
        if is_conversion_cache_zip(&source) {
            let provenance = read_conversion_sidecar(&source).ok_or_else(|| {
                user_message::UserMessage::new(
                    codes::IMPORT_CONVERSION_PROVENANCE_STALE,
                )
                    .with_detail("Provenance du pack en cache absente ou périmée. Rouvrez le dossier ou l'archive d'origine pour renouveler sa conversion.".to_string())
                    .into_transport()
            })?;
            return Ok(ImportedPackSource::Pack(ImportedStudioPack {
                zip_path: source,
                provenance: Some(provenance),
            }));
        }
        return Ok(ImportedPackSource::Pack(ImportedStudioPack::untouched(
            source,
        )));
    }

    let cache_dir = cache_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join(IMPORTED_PACK_CACHE_DIR));
    fs::create_dir_all(&cache_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_ARCHIVE_CACHE_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le cache des archives importees : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let cache_key = cache_key_for_source_cancellable(&source, cancel)?;
    let cached_zip = cache_dir.join(format!("{}.zip", cache_key));
    if let Some(cached) = cached_conversion(&cached_zip) {
        return Ok(ImportedPackSource::Pack(cached));
    }

    let workspace = ImportWorkspace::create_in(&cache_dir, &cache_key)?;
    let extracted_dir = workspace.root().join("extracted");
    let converted_zip = workspace.root().join("converted.zip");
    fs::create_dir_all(&extracted_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_TEMP_FOLDER_PREPARE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de preparer le dossier temporaire d'import : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
            ))
            .into_transport()
    })?;

    match extension.as_deref() {
        Some("zip") => extract_zip_archive_cancellable(&source, &extracted_dir, cancel)?,
        Some("7z") => extract_7z_archive_cancellable(&source, &extracted_dir, cancel)?,
        _ => {
            return Err({
                let _msg_source = (source.display()).to_string();
                user_message::UserMessage::new(codes::FILES_UNSUPPORTED_ARCHIVE_FORMAT)
                    .param("source", user_message::transport_param(_msg_source.clone()))
                    .with_detail(format!(
                        "Format d'archive non pris en charge : {_msg_source}",
                        _msg_source = user_message::transport_detail(&_msg_source)
                    ))
                    .into_transport()
            })
        }
    }

    // L'enveloppe ne se cherche qu'ici : après l'échec de la reconnaissance de
    // pack, et jamais avant. Une archive qui porte un pack suit donc exactement
    // le chemin qu'elle suivait, sans qu'aucune détection ne s'interpose.
    let pack_root = match locate_pack_root(&extracted_dir) {
        Ok(pack_root) => pack_root,
        Err(no_pack_error) => {
            let children = collect_bundle_children(&extracted_dir)?;
            if !children.is_empty() {
                log::info!(
                    target: "pack",
                    "archive enveloppe reconnue : {} packs enfants",
                    children.len()
                );
                return Ok(ImportedPackSource::Bundle(BundleInventory {
                    children,
                    workspace,
                }));
            }
            return Err(no_pack_error);
        }
    };
    if has_annex_archives(&extracted_dir) {
        // Le pack direct l'emporte : l'annexe est signalée, jamais présentée
        // comme une enveloppe.
        log::info!(
            target: "pack",
            "archives annexes ignorees a cote du pack reconnu"
        );
    }
    let provenance = convert_pack_root_to_zip(
        &pack_root,
        &converted_zip,
        &fallback_pack_title(&source),
        cancel,
    )?;

    if cache_key_for_source_cancellable(&source, cancel)? != cache_key {
        return Err({
            let _msg_source = (source.display()).to_string();
            user_message::UserMessage::new(codes::IMPORT_CONVERSION_SOURCE_CHANGED)
                .param("source", user_message::transport_param(_msg_source.clone()))
                .with_detail(format!(
                    "La source importee a change pendant sa conversion : {_msg_source}",
                    _msg_source = user_message::transport_detail(&_msg_source),
                ))
                .into_transport()
        });
    }

    publish_cached_conversion_cancellable(&converted_zip, &cached_zip, &provenance, cancel)?;

    Ok(ImportedPackSource::Pack(ImportedStudioPack {
        zip_path: cached_zip,
        provenance: Some(provenance),
    }))
}

/// Sous-dossier du cache d'import où atterrit l'unique enfant choisi dans une
/// enveloppe. Il est distinct de la racine du cache : un ZIP déposé à la racine
/// serait pris pour une conversion mise en cache et exigerait une provenance.
const BUNDLE_CHILD_CACHE_DIR: &str = "bundle-children";

/// Extrait **un seul** enfant d'une enveloppe, après avoir revérifié que
/// l'archive n'a pas changé depuis l'affichage de sa liste et que l'enfant
/// appartient bien à l'inventaire que Rust vient de recalculer.
///
/// L'inventaire est refait plutôt que mémorisé : le frontend ne rend qu'un
/// identifiant opaque, jamais un chemin, donc rien de ce qu'il renvoie ne
/// désigne une entrée d'archive.
pub fn extract_bundle_child(
    container_path: &str,
    container_fingerprint: &str,
    child_id: &str,
    cache_dir: &Path,
) -> Result<PathBuf, String> {
    let observed = bundle_container_fingerprint(container_path)?;
    if observed != container_fingerprint {
        return Err(
            user_message::UserMessage::new(codes::IMPORT_BUNDLE_ARCHIVE_CHANGED)
                .with_detail(
                    "Cette archive a changé depuis l'affichage de sa liste. Rouvrez-la pour \
                rafraîchir les packs qu'elle contient."
                        .to_string(),
                )
                .into_transport(),
        );
    }

    let ImportedPackSource::Bundle(inventory) = ensure_studio_pack_source(container_path)? else {
        return Err(
        user_message::UserMessage::new(
            codes::IMPORT_BUNDLE_PACK_COUNT_CHANGED,
        )
            .with_detail("Cette archive ne contient plus plusieurs packs. Rouvrez-la pour repartir de son \
                contenu réel.".to_string())
            .into_transport(),
        );
    };
    let child_file = inventory.child_file(child_id)?;

    let destination_dir = cache_dir.join(BUNDLE_CHILD_CACHE_DIR).join(&observed);
    fs::create_dir_all(&destination_dir).map_err(|e| {
        let _msg_e = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_CHILD_CACHE_PREPARE_FAILED)
            .param("error", user_message::transport_param(_msg_e.clone()))
            .with_detail(format!(
                "Impossible de preparer le cache des packs enfants : {_msg_e}",
                _msg_e = user_message::transport_detail(&_msg_e)
            ))
            .into_transport()
    })?;
    let extension = pack_extension(&child_file).unwrap_or_else(|| "zip".to_string());
    let destination = destination_dir.join(format!("{child_id}.{extension}"));

    let staged = destination_dir.join(format!(".{child_id}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = fs::copy(&child_file, &staged) {
        let _ = fs::remove_file(&staged);
        return Err({
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::IMPORT_CHOSEN_PACK_PREPARE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de preparer le pack choisi : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        });
    }
    if let Err(error) = fs::rename(&staged, &destination) {
        let _ = fs::remove_file(&destination);
        if let Err(second) = fs::rename(&staged, &destination) {
            let _ = fs::remove_file(&staged);
            return Err({
                let _msg_error = (error).to_string();
                let _msg_second = (second).to_string();
                user_message::UserMessage::new(
                    codes::IMPORT_CHOSEN_PACK_PUBLISH_FAILED,
                )
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .param("second", user_message::transport_param(_msg_second.clone()))
                    .with_detail(format!(
                        "Impossible de publier le pack choisi : {_msg_error}; nouvelle tentative : {_msg_second}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_second = user_message::transport_detail(&_msg_second),
                    ))
                    .into_transport()
            });
        }
    }

    // L'inventaire — donc la session temporaire de l'enveloppe — est relâché
    // ici : seul l'enfant choisi survit.
    drop(inventory);
    Ok(destination)
}

/// Convertit un **dossier brut** de pack Lunii (pris directement sur la carte SD :
/// pack filesystem `ri/si/li/ni/...` ou pack Studio `story.json + assets/`) en un
/// ZIP Studio mis en cache dans le dossier applicatif fourni, et renvoie son chemin.
/// Les fichiers de travail restent dans le temporaire système car ils ne quittent
/// jamais le backend.
pub(crate) fn ensure_studio_pack_zip_from_dir(
    dir: &str,
    cache_dir: &Path,
) -> Result<ImportedStudioPack, String> {
    ensure_studio_pack_zip_from_dir_cancellable(dir, cache_dir, &AtomicBool::new(false))
}
pub(crate) fn ensure_studio_pack_zip_from_dir_cancellable(
    dir: &str,
    cache_dir: &Path,
    cancel: &AtomicBool,
) -> Result<ImportedStudioPack, String> {
    let result = ensure_studio_pack_zip_from_dir_inner(dir, cache_dir, cancel);
    cancellation::check(cancel)?;
    result
}
fn ensure_studio_pack_zip_from_dir_inner(
    dir: &str,
    cache_dir: &Path,
    cancel: &AtomicBool,
) -> Result<ImportedStudioPack, String> {
    cancellation::check(cancel)?;
    let source = validate_existing_dir_path(dir, codes::FILES_IMPORTED_PACK_FOLDER_TRANSPORT)?;

    fs::create_dir_all(cache_dir).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_ARCHIVE_CACHE_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de creer le cache des archives importees : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    // La racine du pack est localisée avant la clé : pour un pack Studio, la clé
    // ne couvre que ce que l'archive contiendra (voir `directory_cache_key`).
    let pack_root = locate_pack_root(&source)?;
    let cache_key = directory_cache_key(&source, &pack_root, cancel)?;
    let cached_zip = cache_dir.join(format!("{}.zip", cache_key));
    if let Some(cached) = cached_conversion(&cached_zip) {
        return Ok(cached);
    }

    let workspace = ImportWorkspace::create_in(cache_dir, &cache_key)?;
    let converted_zip = workspace.root().join("converted.zip");
    let provenance = convert_pack_root_to_zip(
        &pack_root,
        &converted_zip,
        &fallback_pack_title(&source),
        cancel,
    )?;

    if directory_cache_key(&source, &pack_root, cancel)? != cache_key {
        return Err(folder_changed(&source));
    }

    let publish_result =
        publish_cached_conversion_cancellable(&converted_zip, &cached_zip, &provenance, cancel);
    publish_result?;

    Ok(ImportedStudioPack {
        zip_path: cached_zip,
        provenance: Some(provenance),
    })
}

#[cfg(test)]
fn unique_import_workspace(cache_key: &str) -> PathBuf {
    unique_import_workspace_in(&std::env::temp_dir(), cache_key)
}
fn unique_import_workspace_in(parent: &Path, cache_key: &str) -> PathBuf {
    parent.join(format!(
        "story_studio_imported_pack_{}_{}_{}",
        now_millis(),
        cache_key,
        uuid::Uuid::new_v4()
    ))
}

/// Le chemin du fichier de provenance publié à côté d'un ZIP mis en cache.
fn conversion_sidecar_path(cached_zip: &Path) -> PathBuf {
    cached_zip.with_extension("context.json")
}

fn is_conversion_cache_zip(path: &Path) -> bool {
    path.parent().and_then(Path::file_name) == Some(OsStr::new(IMPORTED_PACK_CACHE_DIR))
        && path
            .file_stem()
            .and_then(OsStr::to_str)
            .is_some_and(|stem| {
                stem.len() == 64 && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

/// Un ZIP mis en cache n'est réutilisable qu'avec sa provenance : sans elle, la
/// conversion d'un pack FS reviendrait relue comme un import Studio ordinaire.
/// Une entrée dépareillée — cache d'une version antérieure, fichier supprimé
/// séparément — est donc traitée comme incomplète et reconvertie.
fn cached_conversion(cached_zip: &Path) -> Option<ImportedStudioPack> {
    if !cached_zip.exists() {
        return None;
    }
    let provenance = zip_contains_story_json(cached_zip)
        .unwrap_or(false)
        .then(|| read_conversion_sidecar(cached_zip))
        .flatten();
    match provenance {
        Some(provenance) => Some(ImportedStudioPack {
            zip_path: cached_zip.to_path_buf(),
            provenance: Some(provenance),
        }),
        None => {
            let _ = fs::remove_file(cached_zip);
            let _ = fs::remove_file(conversion_sidecar_path(cached_zip));
            None
        }
    }
}

fn read_conversion_sidecar(cached_zip: &Path) -> Option<PackConversionProvenance> {
    let raw = fs::read(conversion_sidecar_path(cached_zip)).ok()?;
    let sidecar: ConversionSidecar = serde_json::from_slice(&raw).ok()?;
    (sidecar.conversion_format_version == CONVERSION_FORMAT_VERSION).then_some(sidecar.provenance)
}

/// Publie la provenance **avant** le ZIP : un ZIP visible dans le cache a donc
/// toujours sa provenance. Son contenu ne dépend que de la source, donc deux
/// conversions concurrentes de la même archive écrivent les mêmes octets et
/// restent appariées quel que soit le gagnant de la publication.
fn publish_cached_conversion_cancellable(
    converted_zip: &Path,
    cached_zip: &Path,
    provenance: &PackConversionProvenance,
    cancel: &AtomicBool,
) -> Result<(), String> {
    cancellation::check(cancel)?;
    publish_conversion_sidecar(cached_zip, provenance)?;
    publish_cached_zip(converted_zip, cached_zip, cancel)
}

fn publish_conversion_sidecar(
    cached_zip: &Path,
    provenance: &PackConversionProvenance,
) -> Result<(), String> {
    let sidecar_path = conversion_sidecar_path(cached_zip);
    let parent = sidecar_path.parent().ok_or_else(|| {
        let _msg_cached_zip = (cached_zip.display()).to_string();
        user_message::UserMessage::new(codes::FILES_INVALID_CACHE_PATH)
            .param(
                "cachedZip",
                user_message::transport_param(_msg_cached_zip.clone()),
            )
            .with_detail(format!(
                "Chemin de cache invalide : {_msg_cached_zip}",
                _msg_cached_zip = user_message::transport_detail(&_msg_cached_zip)
            ))
            .into_transport()
    })?;
    fs::create_dir_all(parent).map_err(|e| {
        let _msg_e = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_CACHE_FINALIZE_FAILED)
            .param("error", user_message::transport_param(_msg_e.clone()))
            .with_detail(format!(
                "Impossible de finaliser le cache d'import : {_msg_e}",
                _msg_e = user_message::transport_detail(&_msg_e)
            ))
            .into_transport()
    })?;

    let bytes = serde_json::to_vec_pretty(&ConversionSidecar {
        conversion_format_version: CONVERSION_FORMAT_VERSION.to_string(),
        provenance: provenance.clone(),
    })
    .map_err(|e| {
        let _msg_e = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_PROVENANCE_ENCODE_FAILED)
            .param("error", user_message::transport_param(_msg_e.clone()))
            .with_detail(format!(
                "Provenance de conversion non serialisable : {_msg_e}",
                _msg_e = user_message::transport_detail(&_msg_e)
            ))
            .into_transport()
    })?;

    let staged = parent.join(format!(
        ".{}.{}.tmp",
        sidecar_path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("pack.context.json"),
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::write(&staged, &bytes) {
        let _ = fs::remove_file(&staged);
        return Err({
            let _msg_sidecar_path = (sidecar_path.display()).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_PROVENANCE_PREPARE_FAILED,
            )
                .param(
                    "sidecarPath",
                    user_message::transport_param(_msg_sidecar_path.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de preparer la provenance de conversion {_msg_sidecar_path} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_sidecar_path = user_message::transport_detail(&_msg_sidecar_path),
                ))
                .into_transport()
        });
    }
    if let Err(error) = fs::rename(&staged, &sidecar_path) {
        let _ = fs::remove_file(&staged);
        return Err({
            let _msg_sidecar_path = (sidecar_path.display()).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_PROVENANCE_PUBLISH_FAILED,
            )
                .param(
                    "sidecarPath",
                    user_message::transport_param(_msg_sidecar_path.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de publier la provenance de conversion {_msg_sidecar_path} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_sidecar_path = user_message::transport_detail(&_msg_sidecar_path),
                ))
                .into_transport()
        });
    }
    Ok(())
}

fn publish_cached_zip(
    converted_zip: &Path,
    cached_zip: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let parent = cached_zip.parent().ok_or_else(|| {
        let _msg_cached_zip = (cached_zip.display()).to_string();
        user_message::UserMessage::new(codes::FILES_INVALID_CACHE_PATH)
            .param(
                "cachedZip",
                user_message::transport_param(_msg_cached_zip.clone()),
            )
            .with_detail(format!(
                "Chemin de cache invalide : {_msg_cached_zip}",
                _msg_cached_zip = user_message::transport_detail(&_msg_cached_zip)
            ))
            .into_transport()
    })?;
    fs::create_dir_all(parent).map_err(|e| {
        let _msg_e = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_CACHE_FINALIZE_FAILED)
            .param("error", user_message::transport_param(_msg_e.clone()))
            .with_detail(format!(
                "Impossible de finaliser le cache d'import : {_msg_e}",
                _msg_e = user_message::transport_detail(&_msg_e)
            ))
            .into_transport()
    })?;

    if cached_zip.is_file() && zip_contains_story_json(cached_zip).unwrap_or(false) {
        return Ok(());
    }

    let cached_name = cached_zip
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("pack.zip");
    let staged_zip = parent.join(format!(".{cached_name}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(error) = (|| {
        cancellation::copy(
            &mut fs::File::open(converted_zip)?,
            &mut fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_zip)?,
            cancel,
        )
    })() {
        let _ = fs::remove_file(&staged_zip);
        return Err({
            let _msg_cached_zip = (cached_zip.display()).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_CONVERTED_CACHE_PREPARE_FAILED,
            )
                .param("cachedZip", user_message::transport_param(_msg_cached_zip.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de preparer le cache de l'archive convertie {_msg_cached_zip} : {_msg_error}",
                    _msg_cached_zip = user_message::transport_detail(&_msg_cached_zip),
                    _msg_error = user_message::transport_detail(&_msg_error),
                ))
                .into_transport()
        });
    }

    if let Err(error) = cancellation::check(cancel) {
        let _ = fs::remove_file(&staged_zip);
        return Err(error);
    }
    if let Err(first_error) = fs::rename(&staged_zip, cached_zip) {
        if cached_zip.is_file() && zip_contains_story_json(cached_zip).unwrap_or(false) {
            let _ = fs::remove_file(&staged_zip);
            return Ok(());
        }
        let _ = fs::remove_file(cached_zip);
        if let Err(second_error) = fs::rename(&staged_zip, cached_zip) {
            let _ = fs::remove_file(&staged_zip);
            return Err({
                let _msg_cached_zip = (cached_zip.display()).to_string();
                let _msg_first_error = (first_error).to_string();
                let _msg_second_error = (second_error).to_string();
                user_message::UserMessage::new(
                    codes::IMPORT_CONVERTED_CACHE_PUBLISH_FAILED,
                )
                    .param(
                        "cachedZip",
                        user_message::transport_param(_msg_cached_zip.clone()),
                    )
                    .param(
                        "firstError",
                        user_message::transport_param(_msg_first_error.clone()),
                    )
                    .param(
                        "secondError",
                        user_message::transport_param(_msg_second_error.clone()),
                    )
                    .with_detail(format!(
                        "Impossible de publier le cache de l'archive convertie {_msg_cached_zip} : {_msg_first_error}; nouvelle tentative : {_msg_second_error}",
                        _msg_cached_zip = user_message::transport_detail(&_msg_cached_zip),
                        _msg_first_error = user_message::transport_detail(&_msg_first_error),
                        _msg_second_error = user_message::transport_detail(&_msg_second_error),
                    ))
                    .into_transport()
            });
        }
    }

    Ok(())
}

/// Le `story.json` qu'une conversion de dossier Studio écrit dans son archive :
/// la décision d'identité de toute réécriture, sans catalogue (celle de
/// l'usage suit, sur ce texte).
fn authorize_studio_story_text(
    text: &str,
) -> Result<crate::native_pack::output_identity::AuthorizedStory, String> {
    let value = serde_json::from_str(text)
        .map_err(|e| crate::native_pack::output_identity::invalid_story(e).into_transport())?;
    let identity = crate::native_pack::output_identity::for_story(
        &value,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        None,
    )
    .map_err(user_message::UserMessage::into_transport)?;
    identity.serialize(text)
}

fn folder_changed(source: &Path) -> String {
    let _msg_source = (source.display()).to_string();
    user_message::UserMessage::new(codes::IMPORT_CONVERSION_FOLDER_CHANGED)
        .param("source", user_message::transport_param(_msg_source.clone()))
        .with_detail(format!(
            "Le dossier importe a change pendant sa conversion : {_msg_source}",
            _msg_source = user_message::transport_detail(&_msg_source),
        ))
        .into_transport()
}

/// Convertit une racine de pack déjà localisée (Studio ou filesystem) en ZIP Studio.
fn convert_pack_root_to_zip(
    pack_root: &Path,
    output_zip: &Path,
    fallback_title: &str,
    cancel: &AtomicBool,
) -> Result<PackConversionProvenance, String> {
    cancellation::check(cancel)?;
    if looks_like_studio_pack_directory(pack_root) {
        let text = crate::native_pack::output_identity::read_story_text(pack_root)
            .map_err(user_message::UserMessage::into_transport)?;
        let authorized = authorize_studio_story_text(&text)?;
        zip_directory_to_file_cancellable(&authorized, pack_root, output_zip, cancel)
            .map(|()| PackConversionProvenance::StudioDirectory)
    } else if looks_like_fs_pack_directory(pack_root) {
        convert_fs_pack_directory_to_zip(pack_root, output_zip, fallback_title, cancel)
    } else {
        Err({
            let _msg_pack_root = (pack_root.display()).to_string();
            user_message::UserMessage::new(codes::FILES_IMPORTED_ARCHIVE_NOT_RECOGNIZED)
                .param(
                    "packRoot",
                    user_message::transport_param(_msg_pack_root.clone()),
                )
                .with_detail(format!(
                    "Archive importee non reconnue : {_msg_pack_root}",
                    _msg_pack_root = user_message::transport_detail(&_msg_pack_root)
                ))
                .into_transport()
        })
    }
}

fn pack_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase())
}

#[cfg(test)]
fn cache_key_for_source(path: &Path) -> Result<String, String> {
    source_cache_key(path, CONVERSION_FORMAT_VERSION)
}
fn cache_key_for_source_cancellable(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    source_tree::cache_key_for_source_cancellable(path, CONVERSION_FORMAT_VERSION, cancel)
}

/// Clé de cache d'un dossier source. Un pack Studio n'est archivé que pour
/// `story.json`, `thumbnail.png` et `assets/` : sa clé porte sur ce même
/// périmètre. Un pack filesystem garde l'empreinte du dossier entier.
fn directory_cache_key(
    source: &Path,
    pack_root: &Path,
    cancel: &AtomicBool,
) -> Result<String, String> {
    if looks_like_studio_pack_directory(pack_root) {
        source_tree::studio_pack_cache_key_cancellable(
            source,
            pack_root,
            CONVERSION_FORMAT_VERSION,
            cancel,
        )
    } else {
        cache_key_for_source_cancellable(source, cancel)
    }
}

fn fallback_pack_title(source: &Path) -> String {
    source
        .file_stem()
        .and_then(OsStr::to_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            user_message::UserMessage::new(codes::FILES_IMPORTED_ARCHIVE)
                .with_detail("Archive importee".to_string())
                .into_transport()
        })
}

fn zip_contains_story_json(path: &Path) -> Result<bool, String> {
    let file = fs::File::open(path).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ARCHIVE_OPEN_FAILED)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible d'ouvrir l'archive {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        archive_zip_error(&e, {
            let _msg_path = (path.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_ARCHIVE_ZIP_INVALID)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "ZIP invalide {_msg_path} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        })
    })?;
    ensure_archive_entry_count(archive.len(), path)?;
    let has_story_json = archive.by_name("story.json").is_ok();
    Ok(has_story_json)
}

fn ensure_archive_entry_count(len: usize, source: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err({
            let _msg_len = (len).to_string();
            let _msg_source = (source.display()).to_string();
            let _msg_archive_max_entries = (ARCHIVE_MAX_ENTRIES).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_ARCHIVE_ENTRIES_LIMIT,
            )
                .param("count", user_message::transport_param(_msg_len.clone()))
                .param("source", user_message::transport_param(_msg_source.clone()))
                .param(
                    "maxEntries",
                    user_message::transport_param(_msg_archive_max_entries.clone()),
                )
                .with_detail(format!(
                    "Archive trop volumineuse : {_msg_len} entrees dans {_msg_source} (maximum {_msg_archive_max_entries}).",
                    _msg_archive_max_entries = user_message::transport_detail(&_msg_archive_max_entries),
                    _msg_len = user_message::transport_detail(&_msg_len),
                    _msg_source = user_message::transport_detail(&_msg_source),
                ))
                .into_transport()
        });
    }
    Ok(())
}

fn ensure_extracted_entry_size(name: &str, size: u64) -> Result<(), String> {
    if size > ARCHIVE_MAX_FILE_BYTES {
        return Err({
            let _msg_name = (name).to_string();
            let _msg_size_1024_1024 = (size / 1024 / 1024).to_string();
            let file_size_limit_mb = (ARCHIVE_MAX_FILE_BYTES / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_ARCHIVE_MEMBER_SIZE_LIMIT,
            )
                .param("name", user_message::transport_param(_msg_name.clone()))
                .param("sizeMb", user_message::transport_param(_msg_size_1024_1024.clone()))
                .param(
                    "maxFileMb",
                    user_message::transport_param(file_size_limit_mb.clone()),
                )
                .with_detail(format!(
                    "Fichier trop volumineux dans l'archive : {_msg_name} fait {_msg_size_1024_1024} Mo (maximum {file_size_limit_mb} Mo).",
                    file_size_limit_mb = user_message::transport_detail(&file_size_limit_mb),
                    _msg_name = user_message::transport_detail(&_msg_name),
                    _msg_size_1024_1024 = user_message::transport_detail(&_msg_size_1024_1024),
                ))
                .into_transport()
        });
    }
    Ok(())
}

/// Le refus d'une entrée illisible, dit à l'auteur : l'archive d'origine par son
/// nom, la compression quand c'est elle qui est en cause, puis le détail
/// technique pour un rapport. Jamais le chemin temporaire d'extraction.
pub(crate) fn unreadable_zip_entry_message(
    source: &Path,
    entry_name: &str,
    compression: zip::CompressionMethod,
    error: &std::io::Error,
) -> String {
    let archive = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| source.display().to_string());
    let method = match compression {
        zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated => None,
        zip::CompressionMethod::Lzma => Some("LZMA".to_string()),
        other => Some(format!("{other:?}")),
    };
    let detail = match &method {
        Some(method) => user_message::UserMessage::new(
            codes::FILES_ARCHIVE_COMPRESSION_UNSUPPORTED,
        )
            .param("archive", archive.as_str())
            .param("method", method.as_str())
            .param("entryName", entry_name)
            .param("error", error.to_string())
            .with_detail(format!(
                "L'archive « {archive} » utilise une compression ({method}) que Story Studio ne sait pas lire. Recompressez-la en ZIP standard avant de l'ouvrir. (Détail : {entry_name} : {error})",
            ))
            .into_transport(),
        None => user_message::UserMessage::new(
            codes::FILES_ARCHIVE_DAMAGED_ENTRY_DETAILS,
        )
            .param("archive", archive.as_str())
            .param("entryName", entry_name)
            .param("error", error.to_string())
            .with_detail(format!(
                "L'archive « {archive} » est endommagée : le fichier {entry_name} ne peut pas être extrait. (Détail : {error})",
            ))
            .into_transport(),
    };
    crate::support::user_message::coded_error(
        if method.is_some() {
            codes::IMPORT_UNSUPPORTED_COMPRESSION
        } else {
            codes::IMPORT_INVALID_ARCHIVE
        },
        detail,
    )
}

#[cfg(test)]
fn extract_zip_archive(source: &Path, output_dir: &Path) -> Result<(), String> {
    extract_zip_archive_cancellable(source, output_dir, &AtomicBool::new(false))
}
fn extract_zip_archive_cancellable(
    source: &Path,
    output_dir: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    cancellation::check(cancel)?;
    let file = fs::File::open(source).map_err(|e| {
        let _msg_source = (source.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ZIP_OPEN_FAILED)
            .param("source", user_message::transport_param(_msg_source.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible d'ouvrir le ZIP {_msg_source} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_source = user_message::transport_detail(&_msg_source)
            ))
            .into_transport()
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        archive_zip_error(&e, {
            let _msg_source = (source.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_EXTRACTION_ZIP_INVALID)
                .param("source", user_message::transport_param(_msg_source.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "ZIP invalide {_msg_source} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_source = user_message::transport_detail(&_msg_source)
                ))
                .into_transport()
        })
    })?;
    ensure_archive_entry_count(archive.len(), source)?;
    let mut total_extracted_bytes = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| {
            archive_zip_error(&e, {
                let _msg_source = (source.display()).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::FILES_ZIP_READ_FAILED)
                    .param("source", user_message::transport_param(_msg_source.clone()))
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Lecture ZIP impossible {_msg_source} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_source = user_message::transport_detail(&_msg_source)
                    ))
                    .into_transport()
            })
        })?;
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            let _msg_source = (source.display()).to_string();
            let _msg_entry_name = (entry.name()).to_string();
            user_message::UserMessage::new(codes::FILES_INVALID_DANGEROUS_ZIP_ENTRY)
                .param("source", user_message::transport_param(_msg_source.clone()))
                .param(
                    "entryName",
                    user_message::transport_param(_msg_entry_name.clone()),
                )
                .with_detail(format!(
                    "Entree ZIP invalide ou dangereuse dans {_msg_source} : {_msg_entry_name}",
                    _msg_entry_name = user_message::transport_detail(&_msg_entry_name),
                    _msg_source = user_message::transport_detail(&_msg_source)
                ))
                .into_transport()
        })?;
        let target = output_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| {
                let _msg_target = (target.display()).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::IMPORT_EXTRACTED_FOLDER_CREATE_FAILED)
                    .param("target", user_message::transport_param(_msg_target.clone()))
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Impossible de creer le dossier extrait {_msg_target} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_target = user_message::transport_detail(&_msg_target)
                    ))
                    .into_transport()
            })?;
            continue;
        }
        ensure_extracted_entry_size(entry.name(), entry.size())?;
        total_extracted_bytes =
            total_extracted_bytes
                .checked_add(entry.size())
                .ok_or_else(|| {
                    user_message::UserMessage::new(codes::IMPORT_EXTRACTION_TOTAL_SIZE_LIMIT)
                        .with_detail("Taille totale extraite trop volumineuse.".to_string())
                        .into_transport()
                })?;
        if total_extracted_bytes > MAX_TOTAL_EXTRACTED_BYTES {
            return Err({
                let extracted_size_mb = (total_extracted_bytes / 1024 / 1024).to_string();
                let extracted_size_limit_mb = (MAX_TOTAL_EXTRACTED_BYTES / 1024 / 1024).to_string();
                user_message::UserMessage::new(
                    codes::IMPORT_EXTRACTION_MEASURED_SIZE_LIMIT,
                )
                    .param(
                        "totalExtractedMb",
                        user_message::transport_param(extracted_size_mb.clone()),
                    )
                    .param(
                        "maxExtractedMb",
                        user_message::transport_param(extracted_size_limit_mb.clone()),
                    )
                    .with_detail(format!(
                        "Archive trop volumineuse : {extracted_size_mb} Mo a extraire (maximum {extracted_size_limit_mb} Mo).",
                        extracted_size_limit_mb = user_message::transport_detail(&extracted_size_limit_mb),
                        extracted_size_mb = user_message::transport_detail(&extracted_size_mb),
                    ))
                    .into_transport()
            });
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                let _msg_parent = (parent.display()).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(
                    codes::IMPORT_EXTRACTION_FOLDER_PREPARE_FAILED,
                )
                    .param(
                        "parent",
                        user_message::transport_param(_msg_parent.clone()),
                    )
                    .param(
                        "error",
                        user_message::transport_param(_msg_error.clone()),
                    )
                    .with_detail(format!(
                        "Impossible de preparer le dossier d'extraction {_msg_parent} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_parent = user_message::transport_detail(&_msg_parent)
                    ))
                    .into_transport()
            })?;
        }

        let mut out = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err({
                    let _msg_source = (source.display()).to_string();
                    let _msg_target = (target.display()).to_string();
                    user_message::UserMessage::new(
                        codes::IMPORT_EXTRACTION_NAME_COLLISION,
                    )
                        .param("source", user_message::transport_param(_msg_source.clone()))
                        .param("target", user_message::transport_param(_msg_target.clone()))
                        .with_detail(format!(
                            "Collision de nom pendant l'extraction de {_msg_source} : {_msg_target} existe deja sur ce volume.",
                            _msg_source = user_message::transport_detail(&_msg_source),
                            _msg_target = user_message::transport_detail(&_msg_target),
                        ))
                        .into_transport()
                });
            }
            Err(error) => {
                return Err({
                    let _msg_target = (target.display()).to_string();
                    let _msg_error = (error).to_string();
                    user_message::UserMessage::new(codes::IMPORT_EXTRACTED_FILE_CREATE_FAILED)
                        .param("target", user_message::transport_param(_msg_target.clone()))
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Impossible de creer le fichier extrait {_msg_target} : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                            _msg_target = user_message::transport_detail(&_msg_target)
                        ))
                        .into_transport()
                });
            }
        };
        let compression = entry.compression();
        let entry_name = entry.name().to_string();
        cancellation::copy(&mut entry, &mut out, cancel)
            .map_err(|e| unreadable_zip_entry_message(source, &entry_name, compression, &e))?;
    }

    Ok(())
}

#[cfg(test)]
fn extract_7z_archive(source: &Path, output_dir: &Path) -> Result<(), String> {
    extract_7z_archive_cancellable(source, output_dir, &AtomicBool::new(false))
}
fn extract_7z_archive_cancellable(
    source: &Path,
    output_dir: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    cancellation::check(cancel)?;
    let seven_zip = resolve_7z_path()?;
    let mut cmd = Command::new(&seven_zip);
    apply_no_window(&mut cmd);
    cmd.arg("x")
        .arg("-y")
        .arg(format!("-o{}", output_dir.display()))
        .arg(source);
    let output = cancellation::run(cmd, cancel).map_err(|e| {
        let _msg_source = (source.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_7Z_PROCESS_START_FAILED)
            .param("source", user_message::transport_param(_msg_source.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lancer 7z pour extraire {_msg_source} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_source = user_message::transport_detail(&_msg_source)
            ))
            .into_transport()
    })?;

    if output.status.success() {
        validate_extracted_tree_limits(output_dir)?;
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    // La sortie de l’outil externe est une donnée technique, pas une phrase de l’application.
    let raw = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    let code = if raw.contains("password") {
        codes::IMPORT_PASSWORD_REQUIRED
    } else if raw.contains("unsupported method")
        || raw.contains("compression")
        || raw.contains("lzma")
    {
        codes::IMPORT_UNSUPPORTED_COMPRESSION
    } else {
        codes::IMPORT_INVALID_ARCHIVE
    };
    Err(crate::support::user_message::coded_error(code, {
        let _msg_source = (source.display()).to_string();
        let _msg_stdout = (stdout.trim()).to_string();
        let _msg_stderr = (stderr.trim()).to_string();
        user_message::UserMessage::new(codes::IMPORT_7Z_EXTRACTION_FAILED)
            .param("source", user_message::transport_param(_msg_source.clone()))
            .param("stdout", user_message::transport_param(_msg_stdout.clone()))
            .param("stderr", user_message::transport_param(_msg_stderr.clone()))
            .with_detail(format!(
                "Extraction 7z impossible pour {_msg_source}.\n{_msg_stdout}\n{_msg_stderr}",
                _msg_source = user_message::transport_detail(&_msg_source),
                _msg_stderr = user_message::transport_detail(&_msg_stderr),
                _msg_stdout = user_message::transport_detail(&_msg_stdout)
            ))
            .into_transport()
    }))
}

fn validate_extracted_tree_limits(root: &Path) -> Result<(), String> {
    let mut stack = vec![root.to_path_buf()];
    let mut entry_count = 0_usize;
    let mut total_bytes = 0_u64;

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| {
            let _msg_dir = (dir.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_EXTRACTED_PATH_CHECK_FAILED)
                .param("dir", user_message::transport_param(_msg_dir.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de verifier {_msg_dir} : {_msg_error}",
                    _msg_dir = user_message::transport_detail(&_msg_dir),
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })? {
            let entry = entry.map_err(|e| {
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::FILES_FOLDER_READ_FAILED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Lecture dossier impossible : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|e| {
                let _msg_path = (path.display()).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::IMPORT_ENTRY_METADATA_INACCESSIBLE)
                    .param("path", user_message::transport_param(_msg_path.clone()))
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Metadonnees inaccessibles {_msg_path} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_path = user_message::transport_detail(&_msg_path)
                    ))
                    .into_transport()
            })?;
            if is_link_or_reparse(&metadata) {
                return Err({
                    let _msg_path = (path.display()).to_string();
                    user_message::UserMessage::new(
                        codes::IMPORT_EXTRACTION_SYMLINK_FORBIDDEN,
                    )
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .with_detail(format!(
                            "Archive refusee : lien symbolique ou point de reanalyse extrait interdit ({_msg_path})",
                            _msg_path = user_message::transport_detail(&_msg_path),
                        ))
                        .into_transport()
                });
            }
            entry_count += 1;
            if entry_count > ARCHIVE_MAX_ENTRIES {
                return Err({
                    let _msg_archive_max_entries = (ARCHIVE_MAX_ENTRIES).to_string();
                    user_message::UserMessage::new(
                        codes::IMPORT_EXTRACTION_ENTRY_COUNT_LIMIT,
                    )
                        .param(
                            "maxEntries",
                            user_message::transport_param(_msg_archive_max_entries.clone()),
                        )
                        .with_detail(format!(
                            "Archive trop volumineuse apres extraction : plus de {_msg_archive_max_entries} entrees.",
                            _msg_archive_max_entries = user_message::transport_detail(&_msg_archive_max_entries),
                        ))
                        .into_transport()
                });
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err({
                    let _msg_path = (path.display()).to_string();
                    user_message::UserMessage::new(codes::IMPORT_EXTRACTION_ENTRY_IRREGULAR)
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .with_detail(format!(
                            "Archive refusee : entree extraite non reguliere ({_msg_path})",
                            _msg_path = user_message::transport_detail(&_msg_path),
                        ))
                        .into_transport()
                });
            }
            ensure_extracted_entry_size(&path.to_string_lossy(), metadata.len())?;
            total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
                user_message::UserMessage::new(codes::IMPORT_EXTRACTION_TOTAL_SIZE_LIMIT)
                    .with_detail("Taille totale extraite trop volumineuse.".to_string())
                    .into_transport()
            })?;
            if total_bytes > MAX_TOTAL_EXTRACTED_BYTES {
                return Err({
                    let source_size_mb = (total_bytes / 1024 / 1024).to_string();
                    let extracted_size_limit_mb =
                        (MAX_TOTAL_EXTRACTED_BYTES / 1024 / 1024).to_string();
                    user_message::UserMessage::new(
                        codes::IMPORT_EXTRACTION_FINAL_SIZE_LIMIT,
                    )
                        .param(
                            "totalMb",
                            user_message::transport_param(source_size_mb.clone()),
                        )
                        .param(
                            "maxExtractedMb",
                            user_message::transport_param(extracted_size_limit_mb.clone()),
                        )
                        .with_detail(format!(
                            "Archive trop volumineuse apres extraction : {source_size_mb} Mo (maximum {extracted_size_limit_mb} Mo).",
                            extracted_size_limit_mb = user_message::transport_detail(&extracted_size_limit_mb),
                            source_size_mb = user_message::transport_detail(&source_size_mb),
                        ))
                        .into_transport()
                });
            }
        }
    }

    Ok(())
}

fn seven_zip_binary_names(platform: &str) -> &'static [&'static str] {
    if platform == "windows" {
        &["7z.exe"]
    } else {
        &["7zz", "7z"]
    }
}

struct SevenZipResolutionContext<'a> {
    platform: &'a str,
    architecture: &'a str,
    debug: bool,
    override_path: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    current_exe: Option<PathBuf>,
    cwd: Option<PathBuf>,
    path_dirs: Vec<PathBuf>,
}

fn seven_zip_candidates(context: &SevenZipResolutionContext<'_>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = seven_zip_binary_names(context.platform);

    if context.debug {
        if let Some(path) = &context.override_path {
            push_candidate(&mut candidates, path.clone());
        }
    }

    push_resource_candidates(&mut candidates, context.resource_dir.as_deref(), names);

    if context.platform == "windows" {
        if let Some(exe_dir) = context.current_exe.as_deref().and_then(Path::parent) {
            for name in names {
                push_candidate(&mut candidates, exe_dir.join("tools").join(name));
                push_candidate(&mut candidates, exe_dir.join(name));
            }
        }
    }

    if context.debug {
        push_development_candidates(
            &mut candidates,
            context.cwd.as_deref(),
            context.platform,
            context.architecture,
            names,
        );
        if context.platform == "windows" {
            for candidate in [
                PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
                PathBuf::from(r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe"),
            ] {
                push_candidate(&mut candidates, candidate);
            }
        }
        let filtered_path_dirs = context
            .path_dirs
            .iter()
            .filter(|dir| !dir.to_string_lossy().contains("WindowsApps"))
            .cloned()
            .collect::<Vec<_>>();
        push_path_candidates(&mut candidates, &filtered_path_dirs, names);
    }

    candidates
}

pub(crate) fn resolve_7z_path() -> Result<PathBuf, String> {
    let context = SevenZipResolutionContext {
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
        override_path: std::env::var_os("STORY_STUDIO_7Z_PATH").map(PathBuf::from),
        resource_dir: resource_dir(),
        current_exe: std::env::current_exe().ok(),
        cwd: std::env::current_dir().ok(),
        path_dirs: path_dirs(std::env::var_os("PATH")),
    };
    resolve_regular_file("7-Zip", seven_zip_candidates(&context))
}

fn locate_pack_root(extracted_dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    collect_pack_candidates(extracted_dir, 3, &mut candidates)?;
    candidates.sort_by_key(|path| path.components().count());
    candidates.dedup();

    match candidates.len() {
        0 => Err({
            let _msg_extracted_dir = (extracted_dir.display()).to_string();
            user_message::UserMessage::new(codes::IMPORT_EXTRACTED_LUNII_PACK_MISSING)
                .param(
                    "extractedDir",
                    user_message::transport_param(_msg_extracted_dir.clone()),
                )
                .with_detail(format!(
                    "Aucun pack Lunii reconnu apres extraction dans {_msg_extracted_dir}",
                    _msg_extracted_dir = user_message::transport_detail(&_msg_extracted_dir),
                ))
                .into_transport()
        }),
        1 => Ok(candidates.remove(0)),
        _ => Err({
            let _msg_extracted_dir = (extracted_dir.display()).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_SINGLE_PACK_REQUIRED,
            )
                .param(
                    "extractedDir",
                    user_message::transport_param(_msg_extracted_dir.clone()),
                )
                .with_detail(format!(
                    "Plusieurs packs ont ete detectes dans la meme archive ({_msg_extracted_dir}). Une seule histoire par archive est prise en charge.",
                    _msg_extracted_dir = user_message::transport_detail(&_msg_extracted_dir),
                ))
                .into_transport()
        }),
    }
}

fn collect_pack_candidates(
    dir: &Path,
    depth: usize,
    candidates: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if (looks_like_studio_pack_directory(dir) && dir.join("assets").is_dir())
        || looks_like_fs_pack_directory(dir)
    {
        candidates.push(dir.to_path_buf());
        return Ok(());
    }
    // Un `story.json` sans `assets/` (pack sans média) est un pack, mais le plus
    // faible des candidats : un vrai pack plus bas dans l'arbre l'emporte, et ce
    // fichier n'est alors qu'un parasite du dossier parent.
    let bare_story = looks_like_studio_pack_directory(dir);

    if depth == 0 {
        if bare_story {
            candidates.push(dir.to_path_buf());
        }
        return Ok(());
    }
    let found_before = candidates.len();

    for entry in fs::read_dir(dir).map_err(|e| {
        let _msg_dir = (dir.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_EXTRACTED_FOLDER_BROWSE_FAILED)
            .param("dir", user_message::transport_param(_msg_dir.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de parcourir {_msg_dir} : {_msg_error}",
                _msg_dir = user_message::transport_detail(&_msg_dir),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })? {
        let entry = entry.map_err(|e| {
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_FOLDER_READ_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Lecture dossier impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        let path = entry.path();
        if path.is_dir() {
            collect_pack_candidates(&path, depth - 1, candidates)?;
        }
    }
    if bare_story && candidates.len() == found_before {
        candidates.push(dir.to_path_buf());
    }

    Ok(())
}

/// Dossier Studio : `story.json` à la racine. `assets/` est facultatif, un pack
/// sans média n'en a pas (une archive ne conserve pas les dossiers vides).
fn looks_like_studio_pack_directory(dir: &Path) -> bool {
    dir.join("story.json").is_file()
}

fn looks_like_fs_pack_directory(dir: &Path) -> bool {
    crate::support::fs_pack_reader::detect_fs_pack_variant(dir).is_some()
}

fn zip_directory_to_file_cancellable(
    authorized: &crate::native_pack::output_identity::AuthorizedStory,
    source_dir: &Path,
    output_zip: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let entries = source_tree::validated_studio_pack_tree_cancellable(source_dir, cancel)?;
    let out_file = fs::File::create(output_zip).map_err(|e| {
        user_message::UserMessage::new(codes::FILES_ARCHIVE_CREATE_FAILED)
            .param("outputZip", output_zip.display().to_string())
            .param("error", e.to_string())
            .with_detail(format!(
                "Impossible de creer {} : {}",
                output_zip.display(),
                e
            ))
            .into_transport()
    })?;
    let mut writer = zip::ZipWriter::new(cancellation::Writer {
        inner: out_file,
        cancel,
        stage: "zipWrite",
    });
    let options = zip::write::SimpleFileOptions::default()
        // Conversion preserves source bytes; the ZIP container must not depend
        // on when a preview, copy or replacement happens to rebuild it.
        .last_modified_time(zip::DateTime::default())
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in entries.into_iter().filter(|entry| !entry.is_dir) {
        // Les API standard ne permettent pas une ouverture relative sans suivi de lien sur les
        // trois plateformes. On revalide donc type, taille, canonique et confinement au plus pres
        // de l'ouverture, puis l'empreinte est recalculee avant publication pour detecter une
        // divergence restante.
        revalidate_regular_entry(source_dir, &entry)?;
        let entry_name = archive_entry_name(&entry.relative)?;
        let mut input = fs::File::open(&entry.absolute).map_err(|e| {
            let _msg_entry_absolute = (entry.absolute.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_ARCHIVE_ENTRY_READ_FAILED)
                .param(
                    "entryAbsolute",
                    user_message::transport_param(_msg_entry_absolute.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de lire {_msg_entry_absolute} : {_msg_error}",
                    _msg_entry_absolute = user_message::transport_detail(&_msg_entry_absolute),
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        let is_story = entry_name == "story.json";
        writer.start_file(entry_name, options).map_err(|e| {
            let _msg_output_zip = (output_zip.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_ZIP_WRITE_FAILED)
                .param(
                    "outputZip",
                    user_message::transport_param(_msg_output_zip.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible d'ecrire ZIP {_msg_output_zip} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_output_zip = user_message::transport_detail(&_msg_output_zip)
                ))
                .into_transport()
        })?;
        let written = if is_story {
            authorized.copy_to(&mut writer, cancel)
        } else {
            cancellation::copy(&mut input, &mut writer, cancel)
        };
        written.map_err(|e| {
            let _msg_output_zip = (output_zip.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_ZIP_WRITE_FAILED)
                .param(
                    "outputZip",
                    user_message::transport_param(_msg_output_zip.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible d'ecrire ZIP {_msg_output_zip} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_output_zip = user_message::transport_detail(&_msg_output_zip)
                ))
                .into_transport()
        })?;
    }

    writer.finish().map_err(|e| {
        let _msg_output_zip = (output_zip.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_ZIP_FINALIZE_FAILED)
            .param(
                "outputZip",
                user_message::transport_param(_msg_output_zip.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Finalisation ZIP impossible {_msg_output_zip} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_output_zip = user_message::transport_detail(&_msg_output_zip)
            ))
            .into_transport()
    })?;
    Ok(())
}

fn convert_fs_pack_directory_to_zip(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
    cancel: &AtomicBool,
) -> Result<PackConversionProvenance, String> {
    crate::support::fs_pack_reader::read_fs_pack_to_studio_zip_cancellable(
        pack_dir,
        output_zip,
        fallback_title,
        cancel,
    )?;
    Ok(PackConversionProvenance::FsProjection {
        directory_identity: crate::support::fs_pack_reader::fs_pack_directory_identity(pack_dir),
    })
}

pub(crate) fn archive_zip_error(error: &zip::result::ZipError, detail: String) -> String {
    use crate::support::user_message::{coded_error, codes};
    // La crate rapporte ces causes natives via UnsupportedArchive. Seule sa
    // raison externe en anglais est examinée, jamais les phrases de l’application.
    let code = match error {
        zip::result::ZipError::UnsupportedArchive(reason)
            if reason.to_ascii_lowercase().contains("password") =>
        {
            codes::IMPORT_PASSWORD_REQUIRED
        }
        zip::result::ZipError::UnsupportedArchive(reason)
        | zip::result::ZipError::InvalidArchive(reason)
            if reason.to_ascii_lowercase().contains("encrypted")
                || reason.to_ascii_lowercase().contains("utf-8") =>
        {
            codes::IMPORT_UNSUPPORTED_VARIANT
        }
        zip::result::ZipError::UnsupportedArchive(_) => codes::IMPORT_UNSUPPORTED_COMPRESSION,
        _ => codes::IMPORT_INVALID_ARCHIVE,
    };
    coded_error(code, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Arc, Barrier};

    #[test]
    fn an_unreadable_entry_names_the_archive_and_its_compression_never_the_temp_path() {
        let source = Path::new("/corpus/5+ Le quiz (installation Quizz).zip");
        let error = std::io::Error::other("LZ distance 840524 is beyond output size 0");
        let lzma =
            unreadable_zip_entry_message(source, "abc/li", zip::CompressionMethod::Lzma, &error);
        let lzma: user_message::UserMessage = serde_json::from_str(&lzma).unwrap();
        assert_eq!(lzma.code, codes::IMPORT_UNSUPPORTED_COMPRESSION);
        let lzma: user_message::UserMessage = serde_json::from_str(&lzma.detail.unwrap()).unwrap();
        assert_eq!(lzma.code, codes::FILES_ARCHIVE_COMPRESSION_UNSUPPORTED);
        assert_eq!(
            lzma.params["archive"],
            "5+ Le quiz (installation Quizz).zip"
        );
        assert_eq!(lzma.params["method"], "LZMA");
        assert_eq!(lzma.params["entryName"], "abc/li");
        assert_eq!(lzma.params["error"], error.to_string());
        let lzma = lzma.detail.unwrap();
        assert!(lzma.starts_with(
            "L'archive « 5+ Le quiz (installation Quizz).zip » utilise une compression (LZMA)"
        ));
        assert!(lzma.contains("Recompressez-la en ZIP standard"));
        assert!(!lzma.contains("  "), "une phrase, sans blanc parasite");
        assert!(
            !lzma.contains("/corpus/"),
            "le chemin complet reste hors du message"
        );
        let deflated = unreadable_zip_entry_message(
            source,
            "abc/li",
            zip::CompressionMethod::Deflated,
            &error,
        );
        let deflated: user_message::UserMessage = serde_json::from_str(&deflated).unwrap();
        assert_eq!(deflated.code, codes::IMPORT_INVALID_ARCHIVE);
        let deflated: user_message::UserMessage =
            serde_json::from_str(&deflated.detail.unwrap()).unwrap();
        assert_eq!(deflated.code, codes::FILES_ARCHIVE_DAMAGED_ENTRY_DETAILS);
        assert_eq!(
            deflated.params["archive"],
            "5+ Le quiz (installation Quizz).zip"
        );
        assert_eq!(deflated.params["entryName"], "abc/li");
        assert_eq!(deflated.params["error"], error.to_string());
        assert!(deflated.detail.unwrap().contains("est endommagée"));
    }

    fn temp_import_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_imported_pack_test_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ))
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create zip parent");
        }
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start zip file");
            writer.write_all(bytes).expect("write zip file");
        }
        writer.finish().expect("finish zip");
    }

    fn read_zip_entry(path: &Path, name: &str) -> Vec<u8> {
        let file = fs::File::open(path).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");
        let mut entry = archive.by_name(name).expect("find zip entry");
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("read zip entry");
        bytes
    }

    /// The files of a pack folder as ZIP entries under `<folder name>/`.
    fn folder_entries(pack_dir: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).expect("read fixture folder") {
                let path = entry.expect("fixture entry").path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    let name = path.strip_prefix(root).unwrap().to_str().unwrap();
                    out.push((name.replace('\\', "/"), fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(pack_dir.parent().unwrap(), pack_dir, &mut out);
        out
    }

    fn converted_assets(zip_path: &Path) -> Vec<Vec<u8>> {
        let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
        (0..archive.len())
            .filter_map(|index| {
                let mut entry = archive.by_index(index).unwrap();
                entry.name().starts_with("assets/").then(|| {
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).unwrap();
                    bytes
                })
            })
            .collect()
    }

    /// Les packs `.cleartext` (index sans suffixe, en clair) s'importent par
    /// la même règle que le catalogue, depuis un ZIP comme depuis un dossier,
    /// sans que leurs médias soient déchiffrés ; une clé inconnue est nommée.
    #[test]
    fn cleartext_device_packs_import_without_deciphering_and_unknown_keys_are_named() {
        use crate::support::fs_pack_reader::fs_fixtures::{
            write_cleartext_pack, write_unknown_key_pack, CLEARTEXT_AUDIO, CLEARTEXT_IMAGE,
            DIALECT_PACK_UUID,
        };
        let dir = temp_import_dir("cleartext_import");
        let pack_dir = dir.join("folder").join(DIALECT_PACK_UUID);
        write_cleartext_pack(&pack_dir, true);
        let entries = folder_entries(&pack_dir);
        let zip_path = dir.join("3+ Clear pack.zip");
        write_zip(
            &zip_path,
            &entries
                .iter()
                .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
                .collect::<Vec<_>>(),
        );
        let from_zip = ensure_studio_pack_zip(zip_path.to_str().unwrap())
            .expect("import du ZIP en clair")
            .zip_path;
        let from_folder = ensure_studio_pack_zip_from_dir(
            pack_dir.to_str().unwrap(),
            &dir.join(IMPORTED_PACK_CACHE_DIR),
        )
        .expect("import du dossier en clair")
        .zip_path;
        for converted in [&from_zip, &from_folder] {
            let assets = converted_assets(converted);
            assert!(assets.iter().any(|a| a == CLEARTEXT_IMAGE), "{converted:?}");
            assert!(assets.iter().any(|a| a == CLEARTEXT_AUDIO), "{converted:?}");
        }

        let locked_dir = dir.join("locked").join(DIALECT_PACK_UUID);
        write_unknown_key_pack(&locked_dir, true);
        let locked_entries = folder_entries(&locked_dir);
        let locked_zip = dir.join("Locked.zip");
        write_zip(
            &locked_zip,
            &locked_entries
                .iter()
                .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
                .collect::<Vec<_>>(),
        );
        let error = ensure_studio_pack_zip(locked_zip.to_str().unwrap()).expect_err("clé inconnue");
        assert!(
            error.contains_any_code(&[codes::IMPORT_FS_ENCRYPTED_UNKNOWN_KEY]),
            "{error}"
        );
        let _ = fs::remove_file(&from_zip);
        fs::remove_dir_all(dir).expect("cleanup cleartext import fixture");
    }

    fn minimal_plain_node_index() -> Vec<u8> {
        let mut ni = vec![0_u8; 512 + 44];
        ni[2..4].copy_from_slice(&1_i16.to_le_bytes());
        ni[8..12].copy_from_slice(&44_u32.to_le_bytes());
        ni[12..16].copy_from_slice(&1_u32.to_le_bytes());
        let stage = &mut ni[512..];
        for offset in [0, 4, 8, 12, 16, 20, 24, 28] {
            stage[offset..offset + 4].copy_from_slice(&(-1_i32).to_le_bytes());
        }
        ni
    }

    fn seven_zip_context(platform: &'static str) -> SevenZipResolutionContext<'static> {
        SevenZipResolutionContext {
            platform,
            architecture: "x86_64",
            debug: true,
            override_path: None,
            resource_dir: None,
            current_exe: None,
            cwd: None,
            path_dirs: Vec::new(),
        }
    }

    #[cfg(windows)]
    fn create_windows_junction(link: &Path, target: &Path) {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& { param($link, $target) New-Item -ItemType Junction -Path $link -Target $target | Out-Null }",
            ])
            .arg(link)
            .arg(target)
            .output()
            .expect("launch PowerShell junction creation");
        assert!(
            output.status.success(),
            "create Windows junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn seven_zip_names_match_platform() {
        assert_eq!(seven_zip_binary_names("windows"), &["7z.exe"]);
        assert_eq!(seven_zip_binary_names("linux"), &["7zz", "7z"]);
        assert_eq!(seven_zip_binary_names("macos"), &["7zz", "7z"]);
    }

    #[test]
    fn import_workspaces_are_unique_for_the_same_cache_key() {
        let first = unique_import_workspace("same-source");
        let second = unique_import_workspace("same-source");
        assert_ne!(first, second);
    }

    #[test]
    fn concurrent_plain_archive_conversion_shares_only_complete_cache_files() {
        let dir = temp_import_dir("concurrent_plain_archive");
        let archive = dir.join("plain.zip");
        let ni = minimal_plain_node_index();
        write_zip(
            &archive,
            &[
                ("ni", &ni),
                ("ri.plain", b""),
                ("si.plain", b""),
                ("li.plain", b""),
                ("rf/", b""),
                ("sf/", b""),
            ],
        );

        let worker_count = 8;
        let barrier = Arc::new(Barrier::new(worker_count));
        let archive_path = Arc::new(
            archive
                .to_str()
                .expect("concurrent archive path utf8")
                .to_string(),
        );
        let handles = (0..worker_count)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let archive_path = Arc::clone(&archive_path);
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_studio_pack_zip(&archive_path).map(|imported| imported.zip_path)
                })
            })
            .collect::<Vec<_>>();

        let converted = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .expect("conversion worker panicked")
                    .expect("concurrent conversion succeeds")
            })
            .collect::<Vec<_>>();
        assert!(converted.windows(2).all(|paths| paths[0] == paths[1]));
        assert!(zip_contains_story_json(&converted[0]).expect("complete shared cache zip"));

        let _ = fs::remove_file(&converted[0]);
        fs::remove_dir_all(dir).expect("cleanup concurrent import fixture");
    }

    #[test]
    #[ignore = "requires STORY_STUDIO_PACK_ARCHIVE"]
    fn concurrent_external_pack_conversion_when_configured() {
        let archive = std::env::var_os("STORY_STUDIO_PACK_ARCHIVE")
            .expect("STORY_STUDIO_PACK_ARCHIVE must point to an external pack archive");
        let archive = fs::canonicalize(archive).expect("canonical external archive");
        let cache_key = cache_key_for_source(&archive).expect("external archive cache key");
        let cached_zip = std::env::temp_dir()
            .join(IMPORTED_PACK_CACHE_DIR)
            .join(format!("{cache_key}.zip"));
        let _ = fs::remove_file(&cached_zip);

        let worker_count = 8;
        let barrier = Arc::new(Barrier::new(worker_count));
        let archive_path = Arc::new(
            archive
                .to_str()
                .expect("external archive path utf8")
                .to_string(),
        );
        let handles = (0..worker_count)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let archive_path = Arc::clone(&archive_path);
                std::thread::spawn(move || {
                    barrier.wait();
                    crate::services::pack_reader::load_pack_zip(&archive_path)
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            let story_json = handle
                .join()
                .expect("external conversion worker panicked")
                .expect("external concurrent pack loading succeeds");
            let document: serde_json::Value =
                serde_json::from_str(&story_json).expect("external story document json");
            assert!(document.get("stageNodes").is_some());
        }
        assert!(zip_contains_story_json(&cached_zip).expect("complete external cache zip"));

        let _ = fs::remove_file(cached_zip);
    }

    #[test]
    fn seven_zip_override_precedes_packaged_resource() {
        let dir = temp_import_dir("seven_zip_override");
        let override_path = dir.join("custom 7z");
        let resource_path = dir.join("resources/tools/7z");
        fs::create_dir_all(resource_path.parent().expect("resource parent"))
            .expect("create resource dir");
        fs::write(&override_path, b"override").expect("write override");
        fs::write(&resource_path, b"resource").expect("write resource");

        let mut context = seven_zip_context("linux");
        context.override_path = Some(override_path.clone());
        context.resource_dir = Some(dir.join("resources"));
        let resolved = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect("resolve override");
        assert_eq!(resolved, override_path);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn seven_zip_packaged_resource_precedes_development_and_path() {
        let dir = temp_import_dir("seven_zip_resource");
        let resource_path = dir.join("resources/tools/7z");
        let dev_path = dir.join("src-tauri/tools/linux/7z");
        let path_binary = dir.join("bin/7z");
        for path in [&resource_path, &dev_path, &path_binary] {
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, b"tool").expect("write tool");
        }

        let mut context = seven_zip_context("linux");
        context.resource_dir = Some(dir.join("resources"));
        context.cwd = Some(dir.clone());
        context.path_dirs = vec![dir.join("bin")];
        let resolved = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect("resolve resource");
        assert_eq!(resolved, resource_path);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn seven_zip_missing_error_lists_candidates() {
        let dir = temp_import_dir("seven_zip_missing");
        let mut context = seven_zip_context("linux");
        context.resource_dir = Some(dir.join("resources"));
        let error = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect_err("missing tool");
        assert!(error.contains_any_code(&[codes::FILES_TOOL_CANDIDATES_EXHAUSTED]));
        let message: user_message::UserMessage = serde_json::from_str(&error).unwrap();
        let error = message.params["searched"].as_str().unwrap();
        assert!(error.contains(
            &dir.join("resources")
                .join("tools")
                .join("7zz")
                .display()
                .to_string()
        ));
        assert!(error.contains(
            &dir.join("resources")
                .join("tools")
                .join("7z")
                .display()
                .to_string()
        ));
    }

    #[test]
    #[ignore = "requires a bundled or installed 7-Zip executable"]
    fn extracts_small_seven_zip_fixture_when_tool_is_available() {
        let seven_zip =
            resolve_7z_path().expect("7-Zip is required for this local integration test");
        let dir = temp_import_dir("seven_zip_fixture").join("Dossier Été");
        let source_dir = dir.join("source avec espaces");
        let archive = dir.join("Pack Été.7z");
        let extracted = dir.join("extrait avec espaces");
        fs::create_dir_all(source_dir.join("assets/Médias été")).expect("create fixture source");
        fs::write(
            source_dir.join("story.json"),
            br#"{"title":"Fixture 7z","stageNodes":[]}"#,
        )
        .expect("write fixture story");
        fs::write(source_dir.join("assets/Médias été/A.txt"), b"upper")
            .expect("write uppercase fixture asset");
        fs::write(source_dir.join("assets/Médias été/a.txt"), b"lower")
            .expect("write lowercase fixture asset");
        let supports_case_distinct_files = fs::read(source_dir.join("assets/Médias été/A.txt"))
            .expect("read source case probe")
            == b"upper";
        fs::create_dir_all(&extracted).expect("create extraction dir");

        let mut create = Command::new(&seven_zip);
        apply_no_window(&mut create);
        let output = create
            .current_dir(&source_dir)
            .args(["a", "-y"])
            .arg(&archive)
            .arg("story.json")
            .arg("assets")
            .output()
            .expect("launch 7-Zip fixture creation");
        assert!(
            output.status.success(),
            "7-Zip fixture creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        extract_7z_archive(&archive, &extracted).expect("extract fixture");
        assert!(extracted.join("story.json").is_file());
        if supports_case_distinct_files {
            assert_eq!(
                fs::read(extracted.join("assets/Médias été/A.txt")).expect("read uppercase asset"),
                b"upper"
            );
        }
        assert_eq!(
            fs::read(extracted.join("assets/Médias été/a.txt")).expect("read lowercase asset"),
            b"lower"
        );

        fs::remove_dir_all(dir.parent().expect("temp import parent"))
            .expect("cleanup temp import dir");
    }

    #[cfg(unix)]
    #[test]
    fn extracted_tree_validation_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let dir = temp_import_dir("seven_zip_symlink");
        let extracted = dir.join("extracted");
        let outside = dir.join("outside");
        fs::create_dir_all(&extracted).expect("create extracted");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, extracted.join("linked")).expect("create symlink");

        let error = validate_extracted_tree_limits(&extracted).expect_err("reject symlink");
        assert!(error.contains_any_code(&[codes::IMPORT_EXTRACTION_SYMLINK_FORBIDDEN]));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn extracts_zip_with_spaces_accents_and_case_distinct_entries() {
        let dir = temp_import_dir("zip_unicode_case").join("Dossier Été");
        let archive = dir.join("Pack Été.zip");
        let extracted = dir.join("extrait avec espaces");
        write_zip(
            &archive,
            &[
                ("story.json", br#"{"title":"Fixture ZIP","stageNodes":[]}"#),
                ("assets/Médias été/A.txt", b"upper"),
                ("assets/Médias été/a.txt", b"lower"),
            ],
        );
        fs::create_dir_all(&extracted).expect("create zip extraction dir");

        match extract_zip_archive(&archive, &extracted) {
            Ok(()) => {
                assert_eq!(
                    fs::read(extracted.join("assets/Médias été/A.txt"))
                        .expect("read uppercase zip asset"),
                    b"upper"
                );
                assert_eq!(
                    fs::read(extracted.join("assets/Médias été/a.txt"))
                        .expect("read lowercase zip asset"),
                    b"lower"
                );
            }
            Err(error) => assert!(
                error.contains_any_code(&[codes::IMPORT_EXTRACTION_NAME_COLLISION]),
                "unexpected extraction error: {error}"
            ),
        }

        fs::remove_dir_all(dir.parent().expect("temp import parent"))
            .expect("cleanup temp import dir");
    }

    #[test]
    fn duplicate_zip_targets_are_rejected_instead_of_overwritten() {
        let dir = temp_import_dir("zip_duplicate_target");
        let archive = dir.join("duplicate.zip");
        let extracted = dir.join("extracted");
        write_zip(
            &archive,
            &[("story.json", br#"{"title":"Archive","stageNodes":[]}"#)],
        );
        fs::create_dir_all(&extracted).expect("create zip extraction dir");
        fs::write(extracted.join("story.json"), b"existing")
            .expect("write existing extraction target");

        let error = extract_zip_archive(&archive, &extracted)
            .expect_err("reject duplicate extraction target");
        assert!(error.contains_any_code(&[codes::IMPORT_EXTRACTION_NAME_COLLISION]));
        assert_eq!(
            fs::read(extracted.join("story.json")).expect("read preserved extraction target"),
            b"existing"
        );

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(windows)]
    #[test]
    fn extracted_tree_validation_rejects_windows_junctions() {
        let dir = temp_import_dir("seven_zip_junction");
        let extracted = dir.join("extracted");
        let target = dir.join("target");
        fs::create_dir_all(&extracted).expect("create extracted tree");
        fs::create_dir_all(&target).expect("create junction target");
        create_windows_junction(&extracted.join("linked"), &target);

        let error = validate_extracted_tree_limits(&extracted).expect_err("reject junction");
        assert!(error.contains_any_code(&[codes::IMPORT_EXTRACTION_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_returns_valid_studio_zip_source() {
        let dir = temp_import_dir("studio_zip");
        let zip_path = dir.join("pack.zip");
        write_zip(
            &zip_path,
            &[
                ("story.json", br#"{"title":"Pack test","stageNodes":[]}"#),
                ("assets/image.png", b"png"),
            ],
        );

        let resolved = ensure_studio_pack_zip(zip_path.to_str().expect("zip path utf8"))
            .expect("valid zip")
            .zip_path;
        assert_eq!(
            resolved,
            fs::canonicalize(&zip_path).expect("canonical zip")
        );

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn conforming_studio_zip_is_returned_untouched_and_never_reconverted() {
        let dir = temp_import_dir("studio_zip_untouched");
        let zip_path = dir.join("pack.zip");
        let story =
            br#"{"format":"v1","title":"Pack STUdio","version":1,"actionNodes":[],"stageNodes":[]}"#;
        write_zip(
            &zip_path,
            &[("story.json", story), ("assets/image.png", b"png")],
        );
        let before = fs::read(&zip_path).expect("read source zip");
        let canonical = fs::canonicalize(&zip_path).expect("canonical zip");

        let resolved = ensure_studio_pack_zip(zip_path.to_str().expect("zip path utf8"))
            .expect("studio zip")
            .zip_path;

        assert_eq!(resolved, canonical);
        assert_eq!(fs::read(&resolved).expect("read resolved zip"), before);
        assert_eq!(read_zip_entry(&resolved, "story.json"), story.to_vec());

        // Aucune archive de conversion n'est publiée : une source déjà conforme
        // n'est pas réécrite dans le dialecte d'import.
        let cache_key = cache_key_for_source(&canonical).expect("cache key");
        let cached = std::env::temp_dir()
            .join(IMPORTED_PACK_CACHE_DIR)
            .join(format!("{cache_key}.zip"));
        assert!(
            !cached.exists(),
            "un ZIP STUdio conforme ne doit pas être reconverti : {}",
            cached.display()
        );

        fs::remove_dir_all(dir).expect("cleanup studio zip fixture");
    }

    #[test]
    fn conversion_format_version_invalidates_zips_cached_by_a_previous_dialect() {
        let dir = temp_import_dir("conversion_format_version");
        let archive = dir.join("plain.zip");
        let ni = minimal_plain_node_index();
        write_zip(
            &archive,
            &[
                ("ni", &ni),
                ("ri.plain", b""),
                ("si.plain", b""),
                ("li.plain", b""),
                ("rf/", b""),
                ("sf/", b""),
            ],
        );
        let canonical = fs::canonicalize(&archive).expect("canonical archive");

        // « v2-root-uuid » est la version qui produisait `format: "studio-import"`.
        let legacy_key = source_cache_key(&canonical, "v2-root-uuid").expect("legacy cache key");
        let current_key = cache_key_for_source(&canonical).expect("current cache key");
        assert_ne!(
            current_key,
            source_cache_key(&canonical, "v4-studio-v1-editor-layout-separated")
                .expect("cache avant correction du parseur Python"),
            "le correctif d'identité ne doit pas réutiliser une projection v4"
        );
        assert_ne!(
            legacy_key, current_key,
            "changer le dialecte doit changer la clé de cache"
        );

        let cache_dir = std::env::temp_dir().join(IMPORTED_PACK_CACHE_DIR);
        fs::create_dir_all(&cache_dir).expect("create cache dir");
        let legacy_zip = cache_dir.join(format!("{legacy_key}.zip"));
        write_zip(
            &legacy_zip,
            &[(
                "story.json",
                br#"{"format":"studio-import","stageNodes":[]}"#,
            )],
        );

        let resolved = ensure_studio_pack_zip(archive.to_str().expect("archive path utf8"))
            .expect("conversion du pack filesystem")
            .zip_path;

        assert_ne!(resolved, legacy_zip, "le ZIP obsolète a été réutilisé");
        assert_eq!(resolved, cache_dir.join(format!("{current_key}.zip")));
        let story: serde_json::Value =
            serde_json::from_slice(&read_zip_entry(&resolved, "story.json"))
                .expect("story.json converti");
        assert_eq!(story["format"], serde_json::json!("v1"));

        let _ = fs::remove_file(&legacy_zip);
        let _ = fs::remove_file(&resolved);
        fs::remove_dir_all(dir).expect("cleanup conversion format fixture");
    }

    /// La session d'extraction d'une enveloppe disparaît avec l'inventaire, et
    /// elle emporte les enfants qu'elle avait sortis. Rien ne survit à l'écran
    /// de choix que l'auteur n'a pas validé.
    #[test]
    fn a_bundle_session_and_its_children_vanish_with_the_inventory() {
        let dir = temp_import_dir("bundle_session");
        let child = dir.join("child.zip");
        write_zip(&child, &[("story.json", b"{}"), ("assets/a.mp3", b"a")]);
        let child_bytes = fs::read(&child).expect("relire l'enfant");
        let envelope = dir.join("envelope.zip");
        write_zip(
            &envelope,
            &[
                ("Premier.zip", child_bytes.as_slice()),
                ("Second.zip", child_bytes.as_slice()),
            ],
        );

        let source =
            ensure_studio_pack_source(envelope.to_str().expect("utf8")).expect("inspection");
        let ImportedPackSource::Bundle(inventory) = source else {
            panic!("enveloppe attendue");
        };
        let workspace = inventory.workspace_root();
        assert!(workspace.is_dir(), "la session existe pendant le choix");
        for child in inventory.children() {
            assert!(
                child.absolute.is_file(),
                "l'enfant est lisible pendant le choix"
            );
            assert_eq!(
                inventory
                    .child_file(&child.child_id)
                    .expect("enfant confine"),
                fs::canonicalize(&child.absolute).expect("enfant canonique")
            );
        }
        let children: Vec<PathBuf> = inventory
            .children()
            .iter()
            .map(|child| child.absolute.clone())
            .collect();

        drop(inventory);
        assert!(
            !workspace.exists(),
            "la session ne survit pas a l'inventaire"
        );
        for child in children {
            assert!(!child.exists(), "aucun enfant ne reste sur le disque");
        }

        fs::remove_dir_all(dir).expect("nettoyage");
    }

    /// Sous Windows, `canonicalize` ajoute normalement le préfixe de chemin
    /// étendu à l'enfant. La racine doit passer par la même représentation :
    /// ce test cible la régression A-01 sans introduire de branche de produit.
    #[cfg(windows)]
    #[test]
    fn a_bundle_child_is_accepted_with_windows_canonical_paths() {
        let dir = temp_import_dir("bundle_windows_canonical");
        let child = dir.join("child.zip");
        write_zip(&child, &[("story.json", b"{}"), ("assets/a.mp3", b"a")]);
        let bytes = fs::read(&child).expect("relire l'enfant");
        let envelope = dir.join("envelope.zip");
        write_zip(
            &envelope,
            &[
                ("Premier.zip", bytes.as_slice()),
                ("Second.zip", bytes.as_slice()),
            ],
        );

        let ImportedPackSource::Bundle(inventory) =
            ensure_studio_pack_source(envelope.to_str().expect("utf8")).expect("inspection")
        else {
            panic!("enveloppe attendue");
        };
        let selected = inventory.children().first().expect("premier enfant");
        let canonical = inventory
            .child_file(&selected.child_id)
            .expect("l'enfant canonique reste dans sa session");
        assert!(canonical
            .starts_with(fs::canonicalize(inventory.workspace.root()).expect("racine canonique")));

        drop(inventory);
        fs::remove_dir_all(dir).expect("nettoyage");
    }

    #[test]
    fn ensure_studio_pack_zip_rejects_non_archive_file() {
        let dir = temp_import_dir("non_archive");
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("pack.txt");
        fs::write(&path, b"not an archive").expect("write file");

        let err =
            ensure_studio_pack_zip(path.to_str().expect("path utf8")).expect_err("reject txt");
        assert!(err.contains_any_code(&[codes::IMPORT_ARCHIVE_EXTENSION_INVALID]));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn validate_existing_pack_path_accepts_7z_extension_before_conversion() {
        let dir = temp_import_dir("seven_zip_extension");
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("pack.7z");
        fs::write(&path, b"not a real 7z").expect("write fake 7z");

        let resolved = validate_existing_pack_path(path.to_str().expect("path utf8"))
            .expect("7z extension accepted before conversion");
        assert_eq!(resolved, fs::canonicalize(&path).expect("canonical 7z"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_rejects_zip_without_pack_shape() {
        let dir = temp_import_dir("zip_without_story");
        let zip_path = dir.join("pack.zip");
        write_zip(&zip_path, &[("readme.txt", b"not a story pack")]);

        let err = ensure_studio_pack_zip(zip_path.to_str().expect("zip path utf8"))
            .expect_err("reject unrecognized zip");
        assert!(
            err.contains_any_code(&[codes::FILES_IMPORTED_ARCHIVE_NOT_RECOGNIZED])
                || err.contains_any_code(&[codes::IMPORT_EXTRACTED_LUNII_PACK_MISSING])
        );

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn explicit_archive_cache_owns_conversion_workspace_and_provenance() {
        let dir = temp_import_dir("explicit_archive_cache");
        let archive = dir.join("wrapped.zip");
        write_zip(
            &archive,
            &[
                ("pack/story.json", br#"{"title":"Cache","stageNodes":[]}"#),
                ("pack/assets/a.png", b"png"),
            ],
        );
        let cache = dir.join("local").join(IMPORTED_PACK_CACHE_DIR);
        let converted = ensure_studio_pack_zip_in_cancellable(
            archive.to_str().unwrap(),
            &cache,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(converted.zip_path.parent(), Some(cache.as_path()));
        assert!(converted.provenance.is_some());
        let reread = ensure_studio_pack_zip_in_cancellable(
            converted.zip_path.to_str().unwrap(),
            &cache,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(reread.provenance, converted.provenance);
        assert!(fs::read_dir(&cache)
            .unwrap()
            .all(|e| !e.unwrap().file_type().unwrap().is_dir()));
        let workspace = ImportWorkspace::create_in(&cache, "owned").unwrap();
        assert!(workspace.root().starts_with(&cache));
        let path = workspace.root().to_path_buf();
        drop(workspace);
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ensure_studio_pack_zip_from_dir_converts_studio_directory() {
        let dir = temp_import_dir("studio_dir");
        let pack_dir = dir.join("pack");
        let cache_dir = dir.join("cache applicatif");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Dir pack","stageNodes":[]}"#,
        )
        .expect("write story.json");
        fs::write(pack_dir.join("assets").join("a.png"), b"png").expect("write asset");

        let zip =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"), &cache_dir)
                .expect("convert studio directory")
                .zip_path;
        assert_eq!(zip.parent(), Some(cache_dir.as_path()));
        assert!(zip_contains_story_json(&zip).expect("converted zip has story.json"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn studio_directory_without_assets_converts_to_a_valid_zip_without_assets_entry() {
        let dir = temp_import_dir("studio_dir_no_assets");
        let pack_dir = dir.join("pack");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Sans media","stageNodes":[],"actionNodes":[]}"#,
        )
        .expect("write story.json");

        let zip =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"), &cache_dir)
                .expect("convert directory without assets")
                .zip_path;
        assert!(zip_contains_story_json(&zip).expect("converted zip has story.json"));
        assert!(converted_assets(&zip).is_empty());
        let reloaded = crate::services::pack_reader::load_pack_zip(zip.to_str().expect("zip utf8"))
            .expect("the converted zip is readable");
        assert!(reloaded.contains("Sans media"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    fn zip_entry_names(zip_path: &Path) -> Vec<String> {
        let archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
        let mut names = archive.file_names().map(str::to_string).collect::<Vec<_>>();
        names.sort();
        names
    }

    /// Un dossier de pack Studio n'est archivé que pour son pack : `story.json`,
    /// `thumbnail.png` et tout `assets/`. Une archive posée à côté, un
    /// `.DS_Store` ou un dossier de notes n'entrent ni dans l'archive ni dans
    /// la clé de cache.
    #[test]
    fn studio_directory_archive_holds_only_the_pack_and_ignores_foreign_root_entries() {
        let dir = temp_import_dir("studio_dir_foreign_root_entries");
        let pack_dir = dir.join("pack");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(pack_dir.join("assets").join("sous")).expect("create assets");
        fs::create_dir_all(pack_dir.join("notes").join("brouillons")).expect("create notes");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack propre","stageNodes":[]}"#,
        )
        .expect("write story");
        fs::write(pack_dir.join("thumbnail.png"), b"thumb").expect("write thumbnail");
        fs::write(pack_dir.join("assets").join("a.png"), b"png").expect("write asset");
        fs::write(pack_dir.join("assets").join("sous").join("b.mp3"), b"mp3")
            .expect("write nested asset");
        // Rien n'est trié à l'intérieur d'assets/.
        fs::write(pack_dir.join("assets").join("Archive.zip"), b"kept").expect("write asset zip");
        write_zip(
            &pack_dir.join("Archive.zip"),
            &[("story.json", b"{}"), ("assets/x.png", b"x")],
        );
        fs::write(pack_dir.join(".DS_Store"), b"ds").expect("write DS_Store");
        fs::write(
            pack_dir.join("notes").join("brouillons").join("n.txt"),
            b"note",
        )
        .expect("write note");

        let first =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"), &cache_dir)
                .expect("convert studio directory with foreign entries")
                .zip_path;
        assert_eq!(
            zip_entry_names(&first),
            [
                "assets/Archive.zip",
                "assets/a.png",
                "assets/sous/b.mp3",
                "story.json",
                "thumbnail.png",
            ]
        );
        assert_eq!(read_zip_entry(&first, "thumbnail.png"), b"thumb");

        // Un fichier étranger modifié ou ajouté ne change pas la clé de cache.
        fs::write(pack_dir.join(".DS_Store"), b"autre contenu").expect("mutate DS_Store");
        fs::write(pack_dir.join("lisez-moi.txt"), b"nouveau").expect("add foreign file");
        let again =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"), &cache_dir)
                .expect("cached conversion")
                .zip_path;
        assert_eq!(again, first, "un fichier étranger n'invalide pas le cache");

        // Un média du pack, lui, l'invalide.
        fs::write(pack_dir.join("assets").join("a.png"), b"PNG").expect("mutate asset");
        let changed =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"), &cache_dir)
                .expect("reconversion")
                .zip_path;
        assert_ne!(changed, first);

        // Pack sans assets/ : seul story.json, même avec des étrangers.
        let bare = dir.join("bare");
        fs::create_dir_all(bare.join("divers")).expect("create bare pack");
        fs::write(
            bare.join("story.json"),
            br#"{"title":"Nu","stageNodes":[]}"#,
        )
        .expect("write bare story");
        fs::write(bare.join("Archive.zip"), b"zip").expect("write bare archive");
        fs::write(bare.join("divers").join("x.txt"), b"x").expect("write bare note");
        let bare_zip =
            ensure_studio_pack_zip_from_dir(bare.to_str().expect("path utf8"), &cache_dir)
                .expect("convert bare studio directory")
                .zip_path;
        assert_eq!(zip_entry_names(&bare_zip), ["story.json"]);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn stray_story_json_in_a_parent_does_not_hide_the_real_pack_below() {
        let dir = temp_import_dir("studio_dir_stray_parent");
        let parent = dir.join("parent");
        let real = parent.join("sous").join("vrai");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(real.join("assets")).expect("create real pack");
        fs::write(parent.join("story.json"), br#"{"title":"Parasite"}"#).expect("write stray");
        let real_story = br#"{"title":"Vrai pack","stageNodes":[]}"#;
        fs::write(real.join("story.json"), real_story).expect("write real story");
        fs::write(real.join("assets").join("a.png"), b"png").expect("write asset");

        let zip = ensure_studio_pack_zip_from_dir(parent.to_str().expect("path utf8"), &cache_dir)
            .expect("the real pack wins over the stray parent")
            .zip_path;
        assert_eq!(read_zip_entry(&zip, "story.json"), real_story);
        assert_eq!(converted_assets(&zip).len(), 1);

        // Sans pack plus bas, le parent nu reste un pack sans média.
        let alone = dir.join("alone");
        fs::create_dir_all(alone.join("vide")).expect("create empty child");
        fs::write(
            alone.join("story.json"),
            br#"{"title":"Seul","stageNodes":[]}"#,
        )
        .expect("write alone");
        let zip = ensure_studio_pack_zip_from_dir(alone.to_str().expect("path utf8"), &cache_dir)
            .expect("bare parent alone is a pack")
            .zip_path;
        assert!(zip_contains_story_json(&zip).expect("story.json present"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn directory_cache_reconversion_uses_same_size_mutated_content() {
        let dir = temp_import_dir("directory_cache_reconversion");
        let pack_dir = dir.join("pack");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack dir");
        let story = pack_dir.join("story.json");
        let first_story = br#"{"title":"AAAA","stageNodes":[]}"#;
        let second_story = br#"{"title":"BBBB","stageNodes":[]}"#;
        fs::write(&story, first_story).expect("write first story");

        let first =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("pack path utf8"), &cache_dir)
                .expect("first conversion")
                .zip_path;
        assert_eq!(read_zip_entry(&first, "story.json"), first_story);

        fs::write(&story, second_story).expect("mutate story");
        let second =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("pack path utf8"), &cache_dir)
                .expect("second conversion")
                .zip_path;
        assert_ne!(first, second);
        assert_eq!(read_zip_entry(&second, "story.json"), second_story);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn twenty_five_concurrent_directory_conversions_publish_one_complete_zip() {
        let dir = temp_import_dir("directory_concurrency_25");
        let pack_dir = dir.join("pack");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Concurrent","stageNodes":[]}"#,
        )
        .expect("write story");

        let worker_count = 25;
        let barrier = Arc::new(Barrier::new(worker_count));
        let pack_path = Arc::new(pack_dir.to_str().expect("pack path utf8").to_string());
        let cache_path = Arc::new(cache_dir);
        let handles = (0..worker_count)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let pack_path = Arc::clone(&pack_path);
                let cache_path = Arc::clone(&cache_path);
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_studio_pack_zip_from_dir(&pack_path, &cache_path)
                        .map(|imported| imported.zip_path)
                })
            })
            .collect::<Vec<_>>();

        let converted = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .expect("conversion worker panicked")
                    .expect("concurrent conversion succeeds")
            })
            .collect::<Vec<_>>();
        assert!(converted.windows(2).all(|paths| paths[0] == paths[1]));
        assert!(zip_contains_story_json(&converted[0]).expect("complete shared cache zip"));
        assert!(fs::read_dir(cache_path.as_ref())
            .expect("read cache")
            .all(|entry| !entry
                .expect("cache entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    /// Un ZIP mis en cache n'est réutilisable qu'avec la provenance de
    /// sa conversion : sans elle, un pack filesystem reviendrait relu comme un
    /// import Studio, sans son quadrillage ni ses qualifications d'export. Une
    /// entrée dépareillée est donc reconvertie plutôt que servie amputée.
    #[test]
    fn a_cached_conversion_keeps_its_provenance_and_is_redone_without_it() {
        use crate::support::fs_pack_reader::fs_fixtures::{
            write_dialect_fixture_pack, DIALECT_PACK_UUID,
        };

        let dir = temp_import_dir("conversion_provenance");
        let pack_dir = dir.join(DIALECT_PACK_UUID);
        let cache_dir = dir.join(IMPORTED_PACK_CACHE_DIR);
        write_dialect_fixture_pack(&pack_dir);
        let expected = PackConversionProvenance::FsProjection {
            directory_identity: DIALECT_PACK_UUID.to_string(),
        };

        let converted =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("pack path utf8"), &cache_dir)
                .expect("première conversion");
        assert_eq!(converted.provenance.as_ref(), Some(&expected));
        let sidecar = conversion_sidecar_path(&converted.zip_path);
        assert!(sidecar.is_file(), "la provenance est publiée avec le ZIP");
        let first_story = read_zip_entry(&converted.zip_path, "story.json");

        let cached =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("pack path utf8"), &cache_dir)
                .expect("relecture depuis le cache");
        assert_eq!(cached.zip_path, converted.zip_path);
        assert_eq!(cached.provenance.as_ref(), Some(&expected));
        assert_eq!(
            read_zip_entry(&cached.zip_path, "story.json"),
            first_story,
            "le cache ne reconvertit pas"
        );

        fs::remove_file(&sidecar).expect("retirer la provenance publiée");
        let error = ensure_studio_pack_zip(converted.zip_path.to_str().expect("zip path utf8"))
            .expect_err("un chemin de cache orphelin ne devient pas un import Studio");
        assert!(
            error.contains_any_code(&[codes::IMPORT_CONVERSION_PROVENANCE_STALE]),
            "{error}"
        );
        assert!(
            converted.zip_path.is_file(),
            "la lecture ne détruit pas le cache"
        );
        let repaired =
            ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("pack path utf8"), &cache_dir)
                .expect("reconversion après perte de la provenance");
        assert_eq!(repaired.provenance.as_ref(), Some(&expected));
        assert!(conversion_sidecar_path(&repaired.zip_path).is_file());
        assert_ne!(
            read_zip_entry(&repaired.zip_path, "story.json"),
            first_story,
            "les UUID de Stage sont retirés à chaque conversion réelle"
        );

        fs::remove_dir_all(dir).expect("cleanup provenance fixture");
    }

    #[test]
    fn directory_cache_key_changes_after_same_size_internal_mutation() {
        let dir = temp_import_dir("directory_fingerprint_mutation");
        let pack_dir = dir.join("pack");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack dir");
        let story = pack_dir.join("story.json");
        fs::write(&story, br#"{"title":"AAAA","stageNodes":[]}"#).expect("write first story");

        let first = cache_key_for_source(&pack_dir).expect("first directory key");
        fs::write(&story, br#"{"title":"BBBB","stageNodes":[]}"#).expect("mutate story");
        let second = cache_key_for_source(&pack_dir).expect("second directory key");

        assert_ne!(
            first, second,
            "same-size content mutation must invalidate cache"
        );
        assert_eq!(second.len(), 64, "cache fingerprint must be SHA-256");
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn archive_cache_key_changes_after_same_size_content_mutation() {
        let dir = temp_import_dir("archive_fingerprint_mutation");
        fs::create_dir_all(&dir).expect("create temp dir");
        let archive = dir.join("pack.7z");
        fs::write(&archive, b"archive-AAAA").expect("write first archive");
        let first = cache_key_for_source(&archive).expect("first archive key");
        fs::write(&archive, b"archive-BBBB").expect("mutate archive");
        let second = cache_key_for_source(&archive).expect("second archive key");

        assert_ne!(
            first, second,
            "same-size archive mutation must invalidate cache"
        );
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(unix)]
    #[test]
    fn studio_directory_zip_rejects_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = temp_import_dir("studio_directory_symlinks");
        let pack_dir = dir.join("pack");
        let outside_dir = dir.join("outside");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack assets");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack","stageNodes":[]}"#,
        )
        .expect("write story");
        fs::write(outside_dir.join("secret.txt"), b"outside").expect("write outside file");
        symlink(
            outside_dir.join("secret.txt"),
            pack_dir.join("assets/file-link.txt"),
        )
        .expect("create file symlink");
        symlink(&outside_dir, pack_dir.join("assets/dir-link")).expect("create dir symlink");

        let error = cache_key_for_source(&pack_dir).expect_err("reject source symlinks");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(unix)]
    #[test]
    fn studio_directory_zip_rejects_symlink_loop_without_recursing() {
        use std::os::unix::fs::symlink;

        let dir = temp_import_dir("studio_directory_symlink_loop");
        let pack_dir = dir.join("pack");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack assets");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack","stageNodes":[]}"#,
        )
        .expect("write story");
        symlink(&pack_dir, pack_dir.join("assets/loop")).expect("create loop symlink");

        let error = cache_key_for_source(&pack_dir).expect_err("reject symlink loop");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(unix)]
    #[test]
    fn studio_directory_zip_rejects_broken_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_import_dir("studio_directory_broken_symlink");
        let pack_dir = dir.join("pack");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack assets");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack","stageNodes":[]}"#,
        )
        .expect("write story");
        symlink(
            dir.join("missing-target"),
            pack_dir.join("assets/broken-link"),
        )
        .expect("create broken symlink");

        let error = cache_key_for_source(&pack_dir).expect_err("reject broken symlink");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires Windows symbolic-link creation privilege"]
    fn studio_directory_zip_rejects_windows_reparse_links_when_creatable() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let dir = temp_import_dir("studio_directory_windows_reparse");
        let pack_dir = dir.join("pack");
        let outside_dir = dir.join("outside");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack assets");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack","stageNodes":[]}"#,
        )
        .expect("write story");
        let outside_file = outside_dir.join("secret.txt");
        fs::write(&outside_file, b"outside").expect("write outside file");

        let file_link = pack_dir.join("assets/file-link.txt");
        let dir_link = pack_dir.join("assets/dir-link");
        symlink_file(&outside_file, &file_link)
            .expect("Windows symbolic-link privilege is required for the file link");
        symlink_dir(&outside_dir, &dir_link)
            .expect("Windows symbolic-link privilege is required for the directory link");

        let error = cache_key_for_source(&pack_dir).expect_err("reject Windows reparse link");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[cfg(windows)]
    #[test]
    fn studio_directory_zip_rejects_windows_directory_junction() {
        let dir = temp_import_dir("studio_directory_windows_junction");
        let pack_dir = dir.join("pack");
        let target_dir = pack_dir.join("real-directory");
        let junction = pack_dir.join("assets/junction");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack assets");
        fs::create_dir_all(&target_dir).expect("create junction target");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Pack","stageNodes":[]}"#,
        )
        .expect("write story");

        create_windows_junction(&junction, &target_dir);

        let error = cache_key_for_source(&pack_dir).expect_err("reject Windows junction");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN]));
        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_from_dir_rejects_non_pack_directory() {
        let dir = temp_import_dir("non_pack_dir");
        let cache_dir = dir.join("cache");
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::write(dir.join("readme.txt"), b"not a pack").expect("write file");

        let err = ensure_studio_pack_zip_from_dir(dir.to_str().expect("path utf8"), &cache_dir)
            .expect_err("reject non-pack directory");
        assert!(
            err.contains_any_code(&[codes::IMPORT_EXTRACTED_LUNII_PACK_MISSING])
                || err.contains_any_code(&[codes::FILES_IMPORTED_ARCHIVE_NOT_RECOGNIZED])
        );

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn archive_limits_report_explicit_errors() {
        let err = ensure_archive_entry_count(ARCHIVE_MAX_ENTRIES + 1, Path::new("large.zip"))
            .unwrap_err();
        assert!(err.contains_any_code(&[codes::IMPORT_ARCHIVE_ENTRIES_LIMIT]));

        let err = ensure_extracted_entry_size("assets/audio.mp3", ARCHIVE_MAX_FILE_BYTES + 1)
            .unwrap_err();
        assert!(err.contains_any_code(&[codes::IMPORT_ARCHIVE_MEMBER_SIZE_LIMIT]));
    }
}
