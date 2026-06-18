use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use super::{
    ensure_managed_project_file, is_original_backup, project_dir_from_save_path, AUDIO_EDIT_DIR,
    MANAGED_PROJECT_DIRS,
};

#[derive(serde::Serialize)]
pub struct CleanupFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(serde::Serialize)]
pub struct CleanupScanResult {
    pub unused_files: Vec<CleanupFile>,
    pub total_size: u64,
}

pub fn scan_unused_files(
    save_path: &str,
    used_paths: &[String],
) -> Result<CleanupScanResult, String> {
    let project_dir = project_dir_from_save_path(save_path)?;
    let used_normalized: std::collections::HashSet<PathBuf> = used_paths
        .iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();

    let mut unused_files: Vec<CleanupFile> = Vec::new();
    let mut total_size = 0u64;

    for dir_name in MANAGED_PROJECT_DIRS {
        let dir = project_dir.join(dir_name);
        if !dir.is_dir() {
            continue;
        }
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Impossible de lire {} : {}", dir_name, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Erreur lecture {} : {}", dir_name, e))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Les backups visibles `{stem}.original{-N}.{ext}` sont des dérivés d'édition audio :
            // on ne les propose jamais à la suppression, même si aucune entrée projet ne les référence.
            if is_original_backup(&name) {
                continue;
            }
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !used_normalized.contains(&canonical) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total_size += size;
                unused_files.push(CleanupFile {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    size,
                });
            }
        }
    }

    unused_files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(CleanupScanResult {
        unused_files,
        total_size,
    })
}

pub fn delete_unused_files(paths: &[String], save_path: &str) -> Result<usize, String> {
    let mut count = 0;
    for path in paths {
        ensure_managed_project_file(path, Some(save_path))?;
        fs::remove_file(path).map_err(|e| format!("Suppression impossible : {}", e))?;
        count += 1;
    }
    Ok(count)
}

pub fn delete_file(path: &str, save_path: Option<&str>) -> Result<(), String> {
    let validated = ensure_managed_project_file(path, save_path)?;
    fs::remove_file(&validated).map_err(|e| format!("Suppression impossible : {}", e))
}

/// Sous-dossiers du workspace dans lesquels la suppression disque est autorisée.
/// `zips-extraits` est volontairement exclu : il contient des extractions de packs
/// importés que l'utilisateur ne doit pas pouvoir purger via la médiathèque.
pub(crate) const DELETABLE_WORKSPACE_DIRS: [&str; 4] = [
    "fichiers-importes",
    "enregistrements",
    "voix-generees",
    "images-generees",
];

pub fn delete_workspace_media_file(
    path: &str,
    workspace_dir: &str,
    preserve_paths: &[String],
) -> Result<(), String> {
    let workspace_dir = workspace_dir.trim();
    if workspace_dir.is_empty() {
        return Err("Workspace non défini : suppression disque refusée.".to_string());
    }
    let path_trimmed = path.trim();
    if path_trimmed.is_empty() {
        return Err("Chemin du fichier à supprimer vide.".to_string());
    }

    let workspace_canonical = fs::canonicalize(workspace_dir)
        .map_err(|e| format!("Workspace introuvable ou inaccessible : {}", e))?;
    let target_canonical = fs::canonicalize(path_trimmed)
        .map_err(|e| format!("Fichier à supprimer introuvable ou inaccessible : {}", e))?;

    let metadata = fs::metadata(&target_canonical)
        .map_err(|e| format!("Fichier à supprimer inaccessible : {}", e))?;
    if !metadata.is_file() {
        return Err(format!(
            "Suppression refusée : la cible n'est pas un fichier ({}).",
            target_canonical.display()
        ));
    }

    for dir_name in DELETABLE_WORKSPACE_DIRS {
        let managed_dir = workspace_canonical.join(dir_name);
        let managed_canonical = match fs::canonicalize(&managed_dir) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if target_canonical.starts_with(&managed_canonical) {
            fs::remove_file(&target_canonical)
                .map_err(|e| format!("Suppression impossible : {}", e))?;
            cascade_delete_audio_edit_artifacts(
                &target_canonical,
                &managed_canonical,
                preserve_paths,
            );
            return Ok(());
        }
    }

    Err(format!(
        "Suppression disque refusée : le fichier doit être sous workspace/{} (reçu : {}).",
        DELETABLE_WORKSPACE_DIRS.join(", workspace/"),
        target_canonical.display()
    ))
}

/// Après suppression d'un média édité, nettoie les artefacts liés :
/// - les sauvegardes originales siblings (`{stem}.original{-N}.{ext}`) dans le même dossier ;
/// - le sidecar JSON `.story-studio-audio-edits/{filename}.edit.json` ;
/// - les anciennes sauvegardes legacy `.story-studio-audio-edits/{filename}.original*`;
/// - le dot-folder `.story-studio-audio-edits/` s'il devient vide.
///
/// Toutes les opérations sont strictement bornées au dossier managé (`managed_canonical`)
/// pour éviter toute fuite hors du workspace. Les erreurs sont best-effort : si un artefact
/// ne peut pas être supprimé, on continue silencieusement.
fn cascade_delete_audio_edit_artifacts(
    target: &Path,
    managed_canonical: &Path,
    preserve_paths: &[String],
) {
    let Some(parent) = target.parent() else {
        return;
    };
    // Garantie supplémentaire : le parent doit être à l'intérieur du dossier managé validé.
    if !parent.starts_with(managed_canonical) {
        return;
    }
    let Some(stem) = target.file_stem().and_then(OsStr::to_str) else {
        return;
    };
    let target_ext = target.extension().and_then(OsStr::to_str).unwrap_or("");
    let Some(file_name) = target.file_name().and_then(OsStr::to_str) else {
        return;
    };
    let preserved: std::collections::HashSet<PathBuf> = preserve_paths
        .iter()
        .filter_map(|path| fs::canonicalize(path).ok())
        .collect();

    // 1) Sauvegardes siblings `{stem}.original{-N}.{ext}` dans le même dossier.
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if !is_original_backup(name) {
                continue;
            }
            // Vérifie que le stem du backup correspond au stem du média supprimé,
            // et que l'extension est la même (évite de supprimer un backup d'un autre fichier).
            let backup_stem = match path.file_stem().and_then(OsStr::to_str) {
                Some(value) => value,
                None => continue,
            };
            let backup_base = backup_stem
                .rsplit_once('.')
                .map(|(base, _)| base)
                .unwrap_or(backup_stem);
            let backup_ext = path.extension().and_then(OsStr::to_str).unwrap_or("");
            if backup_base == stem && backup_ext.eq_ignore_ascii_case(target_ext) {
                if fs::canonicalize(&path)
                    .map(|canonical| preserved.contains(&canonical))
                    .unwrap_or(false)
                {
                    continue;
                }
                let _ = fs::remove_file(&path);
            }
        }
    }

    // 2) Sidecar `.story-studio-audio-edits/{filename}.edit.json` + sauvegardes legacy.
    let dot_folder = parent.join(AUDIO_EDIT_DIR);
    if let Ok(dot_canonical) = fs::canonicalize(&dot_folder) {
        if dot_canonical.starts_with(managed_canonical) {
            let sidecar = dot_canonical.join(format!("{}.edit.json", file_name));
            let _ = fs::remove_file(&sidecar);
            // Legacy : tout fichier `{file_name}.original*` dans le dot-folder.
            if let Ok(entries) = fs::read_dir(&dot_canonical) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                        continue;
                    };
                    if name.starts_with(&format!("{}.original", file_name)) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
            // Nettoyage best-effort : retirer le dot-folder s'il devient vide.
            let _ = fs::remove_dir(&dot_canonical);
        }
    }
}
