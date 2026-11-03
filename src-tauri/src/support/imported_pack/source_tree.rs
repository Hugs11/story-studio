use super::cancellation;
use crate::support::user_message;
use crate::support::user_message::codes;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

const SOURCE_FINGERPRINT_VERSION: &str = "v2-sha256-content-tree";
const MAX_TOTAL_SOURCE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct ValidatedDirectoryEntry {
    pub(super) absolute: PathBuf,
    pub(super) relative: PathBuf,
    pub(super) is_dir: bool,
    pub(super) len: u64,
}

pub(super) fn cache_key_for_source(
    path: &Path,
    conversion_format_version: &str,
) -> Result<String, String> {
    cache_key_for_source_cancellable(path, conversion_format_version, &AtomicBool::new(false))
}
pub(super) fn cache_key_for_source_cancellable(
    path: &Path,
    conversion_format_version: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    cancellation::check(cancel)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_SOURCE_METADATA_READ_FAILED)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lire les metadonnees de {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    reject_link_or_reparse(path, &metadata)?;
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        b"conversion",
        conversion_format_version.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"fingerprint",
        SOURCE_FINGERPRINT_VERSION.as_bytes(),
    );
    hash_path_field(&mut hasher, b"source", path)?;

    if metadata.is_file() {
        hash_field(&mut hasher, b"type", b"file");
        hash_regular_file(&mut hasher, path, &metadata, cancel)?;
    } else if metadata.is_dir() {
        hash_field(&mut hasher, b"type", b"directory");
        let entries = validated_directory_tree_cancellable(path, cancel)?;
        hash_tree_entries(&mut hasher, path, entries, cancel)?;
    } else {
        return Err({
            let _msg_path = (path.display()).to_string();
            user_message::UserMessage::new(codes::FILES_IRREGULAR_IMPORTED_SOURCE_REFUSED)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .with_detail(format!(
                    "Source importee non reguliere refusee : {_msg_path}",
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        });
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Clé de cache d'un dossier dont la racine de pack est un pack Studio. Même
/// empreinte de contenu que [`cache_key_for_source`], mais sur le seul périmètre
/// de l'archive produite ([`validated_studio_pack_tree_cancellable`]) : un
/// fichier étranger ajouté ou modifié à côté du pack ne change ni l'archive ni
/// la clé. `pack_root` est `source` ou un de ses sous-dossiers ; chaque
/// dossier intermédiaire est refusé s'il est un lien, comme l'aurait fait le
/// parcours complet de `source`.
pub(super) fn studio_pack_cache_key_cancellable(
    source: &Path,
    pack_root: &Path,
    conversion_format_version: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    cancellation::check(cancel)?;
    let relative_root = reject_linked_pack_root_ancestors(source, pack_root)?;
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        b"conversion",
        conversion_format_version.as_bytes(),
    );
    hash_field(
        &mut hasher,
        b"fingerprint",
        SOURCE_FINGERPRINT_VERSION.as_bytes(),
    );
    hash_path_field(&mut hasher, b"source", source)?;
    hash_field(&mut hasher, b"type", b"studio-pack-directory");
    hash_path_field(&mut hasher, b"pack-root", relative_root)?;
    let entries = validated_studio_pack_tree_cancellable(pack_root, cancel)?;
    hash_tree_entries(&mut hasher, pack_root, entries, cancel)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// `pack_root` relatif à `source`, chaque dossier de `pack_root` jusqu'à `source`
/// inclus refusé s'il est un lien, comme l'aurait fait le parcours complet.
pub(super) fn reject_linked_pack_root_ancestors<'a>(
    source: &Path,
    pack_root: &'a Path,
) -> Result<&'a Path, String> {
    let relative_root = pack_root.strip_prefix(source).map_err(|e| {
        let _msg_canonical = (pack_root.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_INVALID_RELATIVE_PATH)
            .param(
                "canonical",
                user_message::transport_param(_msg_canonical.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Chemin relatif invalide {_msg_canonical} : {_msg_error}",
                _msg_canonical = user_message::transport_detail(&_msg_canonical),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    for dir in pack_root
        .ancestors()
        .take(relative_root.components().count() + 1)
    {
        let metadata = fs::symlink_metadata(dir).map_err(|e| {
            let _msg_path = (dir.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_SOURCE_METADATA_READ_FAILED)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de lire les metadonnees de {_msg_path} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        })?;
        reject_link_or_reparse(dir, &metadata)?;
    }
    Ok(relative_root)
}

fn hash_tree_entries(
    hasher: &mut Sha256,
    root: &Path,
    entries: Vec<ValidatedDirectoryEntry>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    for entry in entries {
        cancellation::check(cancel)?;
        hash_path_field(hasher, b"path", &entry.relative)?;
        hash_field(
            hasher,
            b"entry-type",
            if entry.is_dir { b"directory" } else { b"file" },
        );
        if !entry.is_dir {
            let metadata = revalidate_regular_entry(root, &entry)?;
            hash_regular_file(hasher, &entry.absolute, &metadata, cancel)?;
        }
    }
    Ok(())
}

pub(super) fn validated_directory_tree(
    root: &Path,
) -> Result<Vec<ValidatedDirectoryEntry>, String> {
    validated_directory_tree_cancellable(root, &AtomicBool::new(false))
}
pub(super) fn validated_directory_tree_cancellable(
    root: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<ValidatedDirectoryEntry>, String> {
    validated_tree_cancellable(root, TreeScope::Whole, cancel)
}

/// Arbre d'un dossier de pack Studio, réduit au pack : `story.json`, la vignette
/// `thumbnail.png` et tout `assets/`. Les autres entrées de la racine (archive
/// posée à côté, `.DS_Store`, notes…) ne sont ni parcourues, ni comptées, ni
/// validées : elles n'entrent ni dans l'archive produite ni dans la clé de cache.
/// Rien n'est filtré à l'intérieur d'`assets/`.
pub(super) fn validated_studio_pack_tree_cancellable(
    root: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<ValidatedDirectoryEntry>, String> {
    validated_tree_cancellable(root, TreeScope::StudioPack, cancel)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TreeScope {
    Whole,
    StudioPack,
}

/// Noms admis à la racine d'un pack Studio. La comparaison ignore la casse
/// ASCII : un système de fichiers insensible à la casse peut rendre
/// `Story.json` là où la détection a vu `story.json`, et le filtre ne doit
/// jamais retirer ce que l'archive contenait jusqu'ici sous ces noms.
const STUDIO_PACK_ROOT_ENTRIES: [&str; 3] = ["story.json", "thumbnail.png", "assets"];

fn is_studio_pack_root_entry(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        STUDIO_PACK_ROOT_ENTRIES
            .iter()
            .any(|kept| kept.eq_ignore_ascii_case(name))
    })
}

fn validated_tree_cancellable(
    root: &Path,
    scope: TreeScope,
    cancel: &AtomicBool,
) -> Result<Vec<ValidatedDirectoryEntry>, String> {
    cancellation::check(cancel)?;
    let root_metadata = fs::symlink_metadata(root).map_err(|e| {
        let _msg_root = (root.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_SOURCE_METADATA_INACCESSIBLE)
            .param("root", user_message::transport_param(_msg_root.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Metadonnees inaccessibles {_msg_root} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_root = user_message::transport_detail(&_msg_root)
            ))
            .into_transport()
    })?;
    reject_link_or_reparse(root, &root_metadata)?;
    if !root_metadata.is_dir() {
        return Err({
            let _msg_root = (root.display()).to_string();
            user_message::UserMessage::new(codes::FILES_INVALID_IMPORTED_FOLDER)
                .param("root", user_message::transport_param(_msg_root.clone()))
                .with_detail(format!(
                    "Dossier importe invalide : {_msg_root}",
                    _msg_root = user_message::transport_detail(&_msg_root)
                ))
                .into_transport()
        });
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| {
        let _msg_root = (root.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_ROOT_CANONICALIZE_FAILED)
            .param("root", user_message::transport_param(_msg_root.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de canoniser {_msg_root} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_root = user_message::transport_detail(&_msg_root)
            ))
            .into_transport()
    })?;
    let mut stack = vec![canonical_root.clone()];
    let mut validated = Vec::new();
    let mut entry_count = 0_usize;
    let mut total_bytes = 0_u64;

    while let Some(dir) = stack.pop() {
        cancellation::check(cancel)?;
        for entry in fs::read_dir(&dir).map_err(|e| {
            let _msg_dir = (dir.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_PATH_READ_FAILED)
                .param("dir", user_message::transport_param(_msg_dir.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de lire {_msg_dir} : {_msg_error}",
                    _msg_dir = user_message::transport_detail(&_msg_dir),
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })? {
            cancellation::check(cancel)?;
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
            if scope == TreeScope::StudioPack
                && dir == canonical_root
                && !is_studio_pack_root_entry(&entry.file_name())
            {
                continue;
            }
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
            reject_link_or_reparse(&path, &metadata)?;
            entry_count = checked_source_entry_count(entry_count)?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err({
                    let _msg_path = (path.display()).to_string();
                    user_message::UserMessage::new(codes::IMPORT_FOLDER_ENTRY_IRREGULAR)
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .with_detail(format!(
                            "Dossier importe refuse : entree non reguliere ({_msg_path})",
                            _msg_path = user_message::transport_detail(&_msg_path),
                        ))
                        .into_transport()
                });
            }
            let canonical = fs::canonicalize(&path).map_err(|e| {
                let _msg_path = (path.display()).to_string();
                let _msg_error = (e).to_string();
                user_message::UserMessage::new(codes::IMPORT_ENTRY_CANONICALIZE_FAILED)
                    .param("path", user_message::transport_param(_msg_path.clone()))
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Impossible de canoniser {_msg_path} : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error),
                        _msg_path = user_message::transport_detail(&_msg_path)
                    ))
                    .into_transport()
            })?;
            if !canonical.starts_with(&canonical_root) {
                return Err({
                    let _msg_path = (path.display()).to_string();
                    user_message::UserMessage::new(codes::IMPORT_FOLDER_ENTRY_OUTSIDE)
                        .param("path", user_message::transport_param(_msg_path.clone()))
                        .with_detail(format!(
                            "Dossier importe refuse : entree hors de la racine ({_msg_path})",
                            _msg_path = user_message::transport_detail(&_msg_path),
                        ))
                        .into_transport()
                });
            }
            let relative = canonical
                .strip_prefix(&canonical_root)
                .map_err(|e| {
                    let _msg_canonical = (canonical.display()).to_string();
                    let _msg_error = (e).to_string();
                    user_message::UserMessage::new(codes::FILES_INVALID_RELATIVE_PATH)
                        .param(
                            "canonical",
                            user_message::transport_param(_msg_canonical.clone()),
                        )
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Chemin relatif invalide {_msg_canonical} : {_msg_error}",
                            _msg_canonical = user_message::transport_detail(&_msg_canonical),
                            _msg_error = user_message::transport_detail(&_msg_error)
                        ))
                        .into_transport()
                })?
                .to_path_buf();

            if metadata.is_dir() {
                stack.push(canonical.clone());
            } else {
                ensure_source_entry_size(&relative, metadata.len())?;
                total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
                    user_message::UserMessage::new(codes::IMPORT_FOLDER_TOTAL_SIZE_LIMIT)
                        .with_detail(
                            "Taille totale du dossier importe trop volumineuse.".to_string(),
                        )
                        .into_transport()
                })?;
                if total_bytes > MAX_TOTAL_SOURCE_BYTES {
                    return Err({
                        let source_size_mb = (total_bytes / 1024 / 1024).to_string();
                        let source_size_limit_mb =
                            (MAX_TOTAL_SOURCE_BYTES / 1024 / 1024).to_string();
                        user_message::UserMessage::new(
                            codes::IMPORT_FOLDER_MEASURED_SIZE_LIMIT,
                        )
                            .param(
                                "totalMb",
                                user_message::transport_param(source_size_mb.clone()),
                            )
                            .param(
                                "maxSourceMb",
                                user_message::transport_param(source_size_limit_mb.clone()),
                            )
                            .with_detail(format!(
                                "Dossier importe trop volumineux : {source_size_mb} Mo (maximum {source_size_limit_mb} Mo).",
                                source_size_limit_mb = user_message::transport_detail(&source_size_limit_mb),
                                source_size_mb = user_message::transport_detail(&source_size_mb),
                            ))
                            .into_transport()
                    });
                }
            }
            validated.push(ValidatedDirectoryEntry {
                absolute: canonical,
                relative,
                is_dir: metadata.is_dir(),
                len: metadata.len(),
            });
        }
    }

    for entry in &validated {
        archive_entry_name(&entry.relative)?;
    }
    validated.sort_by(|left, right| {
        archive_entry_name(&left.relative)
            .expect("validated archive path")
            .cmp(&archive_entry_name(&right.relative).expect("validated archive path"))
    });
    Ok(validated)
}

fn checked_source_entry_count(current: usize) -> Result<usize, String> {
    let next = current.checked_add(1).ok_or_else(|| {
        user_message::UserMessage::new(codes::IMPORT_FOLDER_ENTRY_COUNT_LIMIT)
            .with_detail("Dossier importe trop volumineux : trop d'entrees.".to_string())
            .into_transport()
    })?;
    if next > ARCHIVE_MAX_ENTRIES {
        return Err({
            let _msg_archive_max_entries = (ARCHIVE_MAX_ENTRIES).to_string();
            user_message::UserMessage::new(codes::IMPORT_FOLDER_ENTRY_SCAN_LIMIT)
                .param(
                    "maxEntries",
                    user_message::transport_param(_msg_archive_max_entries.clone()),
                )
                .with_detail(format!(
                    "Dossier importe trop volumineux : plus de {_msg_archive_max_entries} entrees.",
                    _msg_archive_max_entries =
                        user_message::transport_detail(&_msg_archive_max_entries),
                ))
                .into_transport()
        });
    }
    Ok(next)
}

pub(super) fn revalidate_regular_entry(
    root: &Path,
    entry: &ValidatedDirectoryEntry,
) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(&entry.absolute).map_err(|e| {
        let _msg_entry_relative = (entry.relative.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(
            codes::IMPORT_ENTRY_DISAPPEARED,
        )
            .param(
                "entryRelative",
                user_message::transport_param(_msg_entry_relative.clone()),
            )
            .param(
                "error",
                user_message::transport_param(_msg_error.clone()),
            )
            .with_detail(format!(
                "L'entree importee a disparu pendant sa lecture {_msg_entry_relative} : {_msg_error}",
                _msg_entry_relative =
                user_message::transport_detail(&_msg_entry_relative),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    reject_link_or_reparse(&entry.absolute, &metadata)?;
    if !metadata.is_file() || metadata.len() != entry.len {
        return Err({
            let _msg_entry_relative = (entry.relative.display()).to_string();
            user_message::UserMessage::new(codes::IMPORT_ENTRY_CHANGED)
                .param(
                    "entryRelative",
                    user_message::transport_param(_msg_entry_relative.clone()),
                )
                .with_detail(format!(
                    "L'entree importee a change pendant sa lecture : {_msg_entry_relative}",
                    _msg_entry_relative = user_message::transport_detail(&_msg_entry_relative)
                ))
                .into_transport()
        });
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| {
        let _msg_root = (root.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_ROOT_CANONICALIZE_FAILED)
            .param("root", user_message::transport_param(_msg_root.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de canoniser {_msg_root} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_root = user_message::transport_detail(&_msg_root)
            ))
            .into_transport()
    })?;
    let canonical_entry = fs::canonicalize(&entry.absolute).map_err(|e| {
        let _msg_entry_absolute = (entry.absolute.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_RECHECK_CANONICALIZE_FAILED)
            .param(
                "entryAbsolute",
                user_message::transport_param(_msg_entry_absolute.clone()),
            )
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de canoniser {_msg_entry_absolute} : {_msg_error}",
                _msg_entry_absolute = user_message::transport_detail(&_msg_entry_absolute),
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if canonical_entry != entry.absolute || !canonical_entry.starts_with(canonical_root) {
        return Err({
            let _msg_entry_relative = (entry.relative.display()).to_string();
            user_message::UserMessage::new(codes::IMPORT_ENTRY_ROOT_CHANGED)
                .param(
                    "entryRelative",
                    user_message::transport_param(_msg_entry_relative.clone()),
                )
                .with_detail(format!(
                    "L'entree importee n'appartient plus a la racine : {_msg_entry_relative}",
                    _msg_entry_relative = user_message::transport_detail(&_msg_entry_relative)
                ))
                .into_transport()
        });
    }
    Ok(metadata)
}

pub(super) fn archive_entry_name(relative: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in relative.components() {
        let part = component_to_archive_part(component).ok_or_else(|| {
            let _msg_relative = (relative.display()).to_string();
            user_message::UserMessage::new(codes::FILES_INVALID_ARCHIVE_PATH)
                .param(
                    "relative",
                    user_message::transport_param(_msg_relative.clone()),
                )
                .with_detail(format!(
                    "Chemin archive invalide : {_msg_relative}",
                    _msg_relative = user_message::transport_detail(&_msg_relative)
                ))
                .into_transport()
        })?;
        if part.is_empty() || part == "." || part == ".." || part.contains('/') {
            return Err({
                let _msg_relative = (relative.display()).to_string();
                user_message::UserMessage::new(codes::FILES_INVALID_ARCHIVE_PATH)
                    .param(
                        "relative",
                        user_message::transport_param(_msg_relative.clone()),
                    )
                    .with_detail(format!(
                        "Chemin archive invalide : {_msg_relative}",
                        _msg_relative = user_message::transport_detail(&_msg_relative)
                    ))
                    .into_transport()
            });
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::FILES_EMPTY_ARCHIVE_PATH_FORBIDDEN)
                .with_detail("Chemin archive vide interdit.".to_string())
                .into_transport(),
        );
    }
    Ok(parts.join("/"))
}

fn component_to_archive_part(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(value) => value.to_str().map(ToOwned::to_owned),
        _ => None,
    }
}

fn ensure_source_entry_size(path: &Path, size: u64) -> Result<(), String> {
    if size > ARCHIVE_MAX_FILE_BYTES {
        return Err({
            let _msg_path = (path.display()).to_string();
            let _msg_size_1024_1024 = (size / 1024 / 1024).to_string();
            let file_size_limit_mb = (ARCHIVE_MAX_FILE_BYTES / 1024 / 1024).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_FOLDER_FILE_SIZE_LIMIT,
            )
                .param("path", user_message::transport_param(_msg_path.clone()))
                .param("sizeMb", user_message::transport_param(_msg_size_1024_1024.clone()))
                .param(
                    "maxFileMb",
                    user_message::transport_param(file_size_limit_mb.clone()),
                )
                .with_detail(format!(
                    "Fichier trop volumineux dans le dossier importe : {_msg_path} fait {_msg_size_1024_1024} Mo (maximum {file_size_limit_mb} Mo).",
                    file_size_limit_mb = user_message::transport_detail(&file_size_limit_mb),
                    _msg_path = user_message::transport_detail(&_msg_path),
                    _msg_size_1024_1024 = user_message::transport_detail(&_msg_size_1024_1024),
                ))
                .into_transport()
        });
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if is_link_or_reparse(metadata) {
        return Err({
            let _msg_path = (path.display()).to_string();
            user_message::UserMessage::new(
                codes::IMPORT_FOLDER_SYMLINK_FORBIDDEN,
            )
                .param("path", user_message::transport_param(_msg_path.clone()))
                .with_detail(format!(
                    "Dossier importe refuse : lien symbolique ou point de reanalyse interdit ({_msg_path})",
                    _msg_path = user_message::transport_detail(&_msg_path),
                ))
                .into_transport()
        });
    }
    Ok(())
}

pub(super) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_reparse_point(metadata)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn hash_field(hasher: &mut Sha256, label: &[u8], value: &[u8]) {
    hasher.update((label.len() as u64).to_be_bytes());
    hasher.update(label);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn hash_path_field(hasher: &mut Sha256, label: &[u8], path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or_else(|| {
        let _msg_path = (path.display()).to_string();
        user_message::UserMessage::new(codes::IMPORT_PACK_PATH_NONUNICODE)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .with_detail(format!(
                "Chemin non Unicode impossible a representer dans un pack : {_msg_path}",
                _msg_path = user_message::transport_detail(&_msg_path),
            ))
            .into_transport()
    })?;
    hash_field(hasher, label, value.as_bytes());
    Ok(())
}

fn hash_regular_file(
    hasher: &mut Sha256,
    path: &Path,
    metadata: &fs::Metadata,
    cancel: &AtomicBool,
) -> Result<(), String> {
    hash_field(hasher, b"length", &metadata.len().to_be_bytes());
    let mut file = fs::File::open(path).map_err(|e| {
        let _msg_path = (path.display()).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::IMPORT_ARCHIVE_SOURCE_READ_FAILED)
            .param("path", user_message::transport_param(_msg_path.clone()))
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de lire {_msg_path} : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_path = user_message::transport_detail(&_msg_path)
            ))
            .into_transport()
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        cancellation::check(cancel)?;
        let count = file.read(&mut buffer).map_err(|e| {
            let _msg_path = (path.display()).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::IMPORT_ARCHIVE_SOURCE_READ_FAILED)
                .param("path", user_message::transport_param(_msg_path.clone()))
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de lire {_msg_path} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_path = user_message::transport_detail(&_msg_path)
                ))
                .into_transport()
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::user_message::MessageTransportAssertions as _;

    #[test]
    fn source_entry_limit_counts_directories_as_well_as_files() {
        assert_eq!(
            checked_source_entry_count(ARCHIVE_MAX_ENTRIES - 1).expect("last allowed entry"),
            ARCHIVE_MAX_ENTRIES
        );
        let error = checked_source_entry_count(ARCHIVE_MAX_ENTRIES)
            .expect_err("directory beyond entry limit must be rejected");
        assert!(error.contains_any_code(&[codes::IMPORT_FOLDER_ENTRY_SCAN_LIMIT]));
    }
}
