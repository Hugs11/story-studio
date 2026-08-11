use sha1::{Digest, Sha1};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};

const SOURCE_FINGERPRINT_VERSION: &str = "v1-content-tree";
const MAX_TOTAL_SOURCE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct ValidatedDirectoryEntry {
    pub(super) absolute: PathBuf,
    pub(super) relative: PathBuf,
    pub(super) is_dir: bool,
    len: u64,
}

pub(super) fn cache_key_for_source(
    path: &Path,
    conversion_format_version: &str,
) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        format!(
            "Impossible de lire les metadonnees de {} : {}",
            path.display(),
            e
        )
    })?;
    reject_link_or_reparse(path, &metadata)?;
    let mut hasher = Sha1::new();
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
        hash_regular_file(&mut hasher, path, &metadata)?;
    } else if metadata.is_dir() {
        hash_field(&mut hasher, b"type", b"directory");
        for entry in validated_directory_tree(path)? {
            hash_path_field(&mut hasher, b"path", &entry.relative)?;
            hash_field(
                &mut hasher,
                b"entry-type",
                if entry.is_dir { b"directory" } else { b"file" },
            );
            if !entry.is_dir {
                let metadata = revalidate_regular_entry(path, &entry)?;
                hash_regular_file(&mut hasher, &entry.absolute, &metadata)?;
            }
        }
    } else {
        return Err(format!(
            "Source importee non reguliere refusee : {}",
            path.display()
        ));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn validated_directory_tree(
    root: &Path,
) -> Result<Vec<ValidatedDirectoryEntry>, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|e| format!("Metadonnees inaccessibles {} : {}", root.display(), e))?;
    reject_link_or_reparse(root, &root_metadata)?;
    if !root_metadata.is_dir() {
        return Err(format!("Dossier importe invalide : {}", root.display()));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("Impossible de canoniser {} : {}", root.display(), e))?;
    let mut stack = vec![canonical_root.clone()];
    let mut validated = Vec::new();
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)
            .map_err(|e| format!("Impossible de lire {} : {}", dir.display(), e))?
        {
            let entry = entry.map_err(|e| format!("Lecture dossier impossible : {}", e))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Metadonnees inaccessibles {} : {}", path.display(), e))?;
            reject_link_or_reparse(&path, &metadata)?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(format!(
                    "Dossier importe refuse : entree non reguliere ({})",
                    path.display()
                ));
            }
            let canonical = fs::canonicalize(&path)
                .map_err(|e| format!("Impossible de canoniser {} : {}", path.display(), e))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(format!(
                    "Dossier importe refuse : entree hors de la racine ({})",
                    path.display()
                ));
            }
            let relative = canonical
                .strip_prefix(&canonical_root)
                .map_err(|e| format!("Chemin relatif invalide {} : {}", canonical.display(), e))?
                .to_path_buf();

            if metadata.is_dir() {
                stack.push(canonical.clone());
            } else {
                file_count += 1;
                if file_count > ARCHIVE_MAX_ENTRIES {
                    return Err(format!(
                        "Dossier importe trop volumineux : plus de {} fichiers.",
                        ARCHIVE_MAX_ENTRIES
                    ));
                }
                ensure_source_entry_size(&relative, metadata.len())?;
                total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
                    "Taille totale du dossier importe trop volumineuse.".to_string()
                })?;
                if total_bytes > MAX_TOTAL_SOURCE_BYTES {
                    return Err(format!(
                        "Dossier importe trop volumineux : {} Mo (maximum {} Mo).",
                        total_bytes / 1024 / 1024,
                        MAX_TOTAL_SOURCE_BYTES / 1024 / 1024
                    ));
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

pub(super) fn revalidate_regular_entry(
    root: &Path,
    entry: &ValidatedDirectoryEntry,
) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(&entry.absolute).map_err(|e| {
        format!(
            "L'entree importee a disparu pendant sa lecture {} : {}",
            entry.relative.display(),
            e
        )
    })?;
    reject_link_or_reparse(&entry.absolute, &metadata)?;
    if !metadata.is_file() || metadata.len() != entry.len {
        return Err(format!(
            "L'entree importee a change pendant sa lecture : {}",
            entry.relative.display()
        ));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("Impossible de canoniser {} : {}", root.display(), e))?;
    let canonical_entry = fs::canonicalize(&entry.absolute).map_err(|e| {
        format!(
            "Impossible de canoniser {} : {}",
            entry.absolute.display(),
            e
        )
    })?;
    if canonical_entry != entry.absolute || !canonical_entry.starts_with(canonical_root) {
        return Err(format!(
            "L'entree importee n'appartient plus a la racine : {}",
            entry.relative.display()
        ));
    }
    Ok(metadata)
}

pub(super) fn archive_entry_name(relative: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in relative.components() {
        let part = component_to_archive_part(component)
            .ok_or_else(|| format!("Chemin archive invalide : {}", relative.display()))?;
        if part.is_empty() || part == "." || part == ".." || part.contains('/') {
            return Err(format!("Chemin archive invalide : {}", relative.display()));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err("Chemin archive vide interdit.".to_string());
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
        return Err(format!(
            "Fichier trop volumineux dans le dossier importe : {} fait {} Mo (maximum {} Mo).",
            path.display(),
            size / 1024 / 1024,
            ARCHIVE_MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || is_reparse_point(metadata) {
        return Err(format!(
            "Dossier importe refuse : lien symbolique ou point de reanalyse interdit ({})",
            path.display()
        ));
    }
    Ok(())
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

fn hash_field(hasher: &mut Sha1, label: &[u8], value: &[u8]) {
    hasher.update((label.len() as u64).to_be_bytes());
    hasher.update(label);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn hash_path_field(hasher: &mut Sha1, label: &[u8], path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or_else(|| {
        format!(
            "Chemin non Unicode impossible a representer dans un pack : {}",
            path.display()
        )
    })?;
    hash_field(hasher, label, value.as_bytes());
    Ok(())
}

fn hash_regular_file(
    hasher: &mut Sha1,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), String> {
    hash_field(hasher, b"length", &metadata.len().to_be_bytes());
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Impossible de lire {} : {}", path.display(), e))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("Impossible de lire {} : {}", path.display(), e))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(())
}
