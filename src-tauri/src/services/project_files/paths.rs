use std::fs;
use std::path::{Path, PathBuf};

use crate::support::imported_pack::validate_existing_pack_path as validate_supported_pack_path;

pub(crate) const MANAGED_PROJECT_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "images-generees",
    "fichiers-importes",
];

pub(crate) fn absolute_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} vide.", label));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{} doit être un chemin absolu.", label));
    }
    Ok(path)
}

pub(crate) fn project_dir_from_save_path(save_path: &str) -> Result<PathBuf, String> {
    let save_path = absolute_path(save_path, "Chemin du projet")?;
    save_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.to_path_buf())
        .ok_or_else(|| {
            format!(
                "Impossible de determiner le dossier du projet depuis {}",
                save_path.display()
            )
        })
}

pub(crate) fn workspace_or_project_dir(
    workspace_dir: Option<&str>,
    save_path: Option<&str>,
    missing_message: &str,
) -> Result<PathBuf, String> {
    if let Some(workspace_dir) = workspace_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return absolute_path(workspace_dir, "Emplacement de travail");
    }
    if let Some(save_path) = save_path.map(str::trim).filter(|value| !value.is_empty()) {
        return project_dir_from_save_path(save_path);
    }
    Err(missing_message.to_string())
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

/// Réserve un nouveau dossier d'extraction directement sous
/// `<workspace_dir>/zips-extraits/`. Le workspace doit être absolu ; seule la
/// dernière composante de `dest_dir` sert de nom. Un suffixe est ajouté si le
/// nom existe déjà, afin de ne jamais réutiliser des assets d'une extraction
/// précédente ni suivre un lien symbolique préexistant.
pub(crate) fn validate_unpack_dest_dir(
    dest_dir: &str,
    workspace_dir: &str,
) -> Result<PathBuf, String> {
    let workspace_dir = workspace_dir.trim();
    if workspace_dir.is_empty() {
        return Err("Emplacement de travail requis pour extraire un pack.".to_string());
    }
    let workspace_path = absolute_path(workspace_dir, "L'emplacement de travail")?;

    let zips_base = workspace_path.join("zips-extraits");
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

    let stem = subdir_name.to_string_lossy();
    for index in 1..=1000_u16 {
        let name = if index == 1 {
            stem.to_string()
        } else {
            format!("{stem}-{index}")
        };
        let candidate = zips_base_canonical.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => {
                let canonical = fs::canonicalize(&candidate).map_err(|e| {
                    format!(
                        "Dossier d'extraction nouvellement créé inaccessible : {}",
                        e
                    )
                })?;
                if canonical.parent() != Some(zips_base_canonical.as_path()) {
                    let _ = fs::remove_dir_all(&candidate);
                    return Err("Dossier d'extraction hors de zips-extraits.".to_string());
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Impossible de réserver le dossier d'extraction {} : {}",
                    candidate.display(),
                    error
                ))
            }
        }
    }

    Err("Impossible de réserver un nom de dossier d'extraction unique.".to_string())
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
