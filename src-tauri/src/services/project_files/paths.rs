use std::fs;
use std::path::{Path, PathBuf};

use crate::support::imported_pack::validate_existing_pack_path as validate_supported_pack_path;

pub(crate) const MANAGED_PROJECT_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "images-generees",
    "fichiers-importes",
];

pub(crate) fn project_dir_from_save_path(save_path: &str) -> Result<PathBuf, String> {
    let save_path = PathBuf::from(save_path);
    save_path
        .parent()
        .map(|dir| dir.to_path_buf())
        .ok_or_else(|| {
            format!(
                "Impossible de determiner le dossier du projet depuis {}",
                save_path.display()
            )
        })
}

pub(crate) fn ensure_managed_project_file(
    path: &str,
    save_path: Option<&str>,
) -> Result<PathBuf, String> {
    let save_path = save_path.ok_or_else(|| {
        "Suppression disque reservee aux fichiers d'un projet sauvegarde.".to_string()
    })?;
    let target = fs::canonicalize(path)
        .map_err(|e| format!("Fichier a supprimer introuvable ou inaccessible : {}", e))?;
    let project_dir = project_dir_from_save_path(save_path)?;

    for dir_name in MANAGED_PROJECT_DIRS {
        let managed_dir = project_dir.join(dir_name);
        if !managed_dir.exists() {
            continue;
        }
        let managed_dir = fs::canonicalize(&managed_dir).map_err(|e| {
            format!(
                "Impossible de verifier le dossier gere {} : {}",
                dir_name, e
            )
        })?;
        if target.starts_with(&managed_dir) {
            return Ok(target);
        }
    }

    Err(format!(
        "Refus de supprimer un fichier hors dossiers geres par Story Studio ({}) : {}",
        MANAGED_PROJECT_DIRS.join(", "),
        target.display()
    ))
}

/// Valide que `dest_dir` est situé directement sous `<workspace_dir>/zips-extraits/`.
/// Retourne le chemin canonique sûr, construit depuis la base validée + le seul
/// composant nom de `dest_dir` (toute tentative de traversée est neutralisée).
pub(crate) fn validate_unpack_dest_dir(
    dest_dir: &str,
    workspace_dir: &str,
) -> Result<PathBuf, String> {
    let zips_base = PathBuf::from(workspace_dir).join("zips-extraits");
    fs::create_dir_all(&zips_base)
        .map_err(|e| format!("Impossible de créer zips-extraits : {}", e))?;
    let zips_base_canonical = fs::canonicalize(&zips_base)
        .map_err(|e| format!("Dossier zips-extraits inaccessible : {}", e))?;

    let subdir_name = Path::new(dest_dir)
        .file_name()
        .ok_or_else(|| "Nom de sous-dossier d'extraction invalide.".to_string())?;
    let subdir_str = subdir_name.to_string_lossy();
    if subdir_str == ".."
        || subdir_str == "."
        || subdir_str.contains('/')
        || subdir_str.contains('\\')
    {
        return Err("Nom de sous-dossier d'extraction invalide.".to_string());
    }

    Ok(zips_base_canonical.join(subdir_name))
}

pub(crate) fn validate_existing_file_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} vide.", label));
    }
    let canonical = fs::canonicalize(trimmed)
        .map_err(|e| format!("{} introuvable ou inaccessible : {}", label, e))?;
    let metadata =
        fs::metadata(&canonical).map_err(|e| format!("{} inaccessible : {}", label, e))?;
    if !metadata.is_file() {
        return Err(format!("{} invalide : {}", label, canonical.display()));
    }
    Ok(canonical)
}

pub(crate) fn validate_existing_dir_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} vide.", label));
    }
    let canonical = fs::canonicalize(trimmed)
        .map_err(|e| format!("{} introuvable ou inaccessible : {}", label, e))?;
    let metadata =
        fs::metadata(&canonical).map_err(|e| format!("{} inaccessible : {}", label, e))?;
    if !metadata.is_dir() {
        return Err(format!("{} invalide : {}", label, canonical.display()));
    }
    Ok(canonical)
}

pub(crate) fn validate_existing_pack_path(path: &str) -> Result<PathBuf, String> {
    validate_supported_pack_path(path)
}
