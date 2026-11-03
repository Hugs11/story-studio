use crate::support::user_message;
use crate::support::user_message::codes;
use crate::support::user_message::{transport_detail, MessageLabel, UserMessage};
use std::fs;
use std::path::{Path, PathBuf};

use crate::support::imported_pack::validate_existing_pack_path as validate_supported_pack_path;

pub(crate) const MANAGED_PROJECT_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "images-generees",
    "fichiers-importes",
];

// Legacy string boundary retained for native_pack and technical callers.
pub(crate) fn absolute_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let label = match serde_json::from_str::<UserMessage>(label) {
        Ok(message) => MessageLabel::new(transport_detail(label), message),
        Err(_) => MessageLabel::data(label),
    };
    absolute_path_with_label(path, &label)
}

pub(crate) fn absolute_path_with_label(
    path: &str,
    label: &MessageLabel,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err({
            let _msg_label = (label).to_string();
            user_message::UserMessage::new(codes::LABEL_VALUE_EMPTY)
                .param("label", label.value())
                .with_detail(format!(
                    "{_msg_label} vide.",
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err({
            let _msg_label = (label).to_string();
            user_message::UserMessage::new(codes::FILES_ABSOLUTE_PATH_REQUIRED)
                .param("label", label.value())
                .with_detail(format!(
                    "{_msg_label} doit être un chemin absolu.",
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    Ok(path)
}

pub(crate) fn project_dir_from_save_path(save_path: &str) -> Result<PathBuf, String> {
    let save_path = absolute_path(save_path, codes::FILES_PROJECT_PATH_TRANSPORT)?;
    save_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.to_path_buf())
        .ok_or_else(|| {
            let _msg_save_path = (save_path.display()).to_string();
            user_message::UserMessage::new(codes::FILES_PROJECT_FOLDER_RESOLUTION_FAILED)
                .param(
                    "savePath",
                    user_message::transport_param(_msg_save_path.clone()),
                )
                .with_detail(format!(
                    "Impossible de determiner le dossier du projet depuis {_msg_save_path}",
                    _msg_save_path = user_message::transport_detail(&_msg_save_path),
                ))
                .into_transport()
        })
}

/// Racine où un outil écrit un média produit (micro, voix, découpe, assemblage,
/// édition d'un fichier externe) : le dossier de session tant que le projet
/// n'est pas enregistré, puis l'emplacement de travail. Le dossier du `.mbah`
/// n'est jamais un repli, sans quoi un projet rangé hors de l'emplacement de
/// travail ferait pousser une seconde arborescence gérée à côté de son fichier.
pub(crate) fn media_output_root(
    workspace_dir: Option<&str>,
    missing_message: &str,
) -> Result<PathBuf, String> {
    match workspace_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(workspace_dir) => {
            absolute_path(workspace_dir, codes::FILES_WORKSPACE_LOCATION_TRANSPORT)
        }
        None => Err(missing_message.to_string()),
    }
}

pub(crate) fn ensure_managed_project_file(
    path: &str,
    save_path: Option<&str>,
) -> Result<PathBuf, String> {
    let save_path = save_path.ok_or_else(|| {
        user_message::UserMessage::new(codes::FILES_DELETE_SAVED_PROJECT_REQUIRED)
            .with_detail(
                "Suppression disque reservee aux fichiers d'un projet sauvegarde.".to_string(),
            )
            .into_transport()
    })?;
    let target = fs::canonicalize(path).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_PROJECT_DELETE_TARGET_MISSING)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Fichier a supprimer introuvable ou inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
            ))
            .into_transport()
    })?;
    let project_dir = project_dir_from_save_path(save_path)?;

    for dir_name in MANAGED_PROJECT_DIRS {
        let managed_dir = project_dir.join(dir_name);
        if !managed_dir.exists() {
            continue;
        }
        let managed_dir = fs::canonicalize(&managed_dir).map_err(|e| {
            let _msg_dir_name = (dir_name).to_string();
            let _msg_error = (e).to_string();
            user_message::UserMessage::new(codes::FILES_MANAGED_FOLDER_CHECK_FAILED)
                .param(
                    "dirName",
                    user_message::transport_param(_msg_dir_name.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Impossible de verifier le dossier gere {_msg_dir_name} : {_msg_error}",
                    _msg_dir_name = user_message::transport_detail(&_msg_dir_name),
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
        if target.starts_with(&managed_dir) {
            return Ok(target);
        }
    }

    Err({
        let _msg_managed_project_dirs_join = (MANAGED_PROJECT_DIRS.join(", ")).to_string();
        let _msg_target = (target.display()).to_string();
        user_message::UserMessage::new(
            codes::FILES_DELETE_MANAGED_PATH_REQUIRED,
        )
            .param(
                "managedDirectories",
                user_message::transport_param(_msg_managed_project_dirs_join.clone()),
            )
            .param("target", user_message::transport_param(_msg_target.clone()))
            .with_detail(format!(
                "Refus de supprimer un fichier hors dossiers geres par Story Studio ({_msg_managed_project_dirs_join}) : {_msg_target}",
                _msg_managed_project_dirs_join = user_message::transport_detail(&_msg_managed_project_dirs_join),
                _msg_target = user_message::transport_detail(&_msg_target),
            ))
            .into_transport()
    })
}

/// Réserve un nouveau dossier d'extraction directement sous
/// `<workspace_dir>/zips-extraits/`. Le workspace doit être absolu ; seule la
/// dernière composante de `dest_dir` sert de nom. Un suffixe est ajouté si le
/// nom existe déjà, afin de ne jamais réutiliser des assets d'une extraction
/// précédente ni suivre un lien symbolique préexistant.
pub(crate) fn validate_unpack_dest_dir(
    dest_dir: &str,
    workspace_dir: &str,
    project_destination: Option<&super::ProjectMediaDestination>,
) -> Result<PathBuf, String> {
    let workspace_dir = workspace_dir.trim();
    if workspace_dir.is_empty() {
        return Err(
            user_message::UserMessage::new(codes::FILES_EXTRACT_WORKSPACE_REQUIRED)
                .with_detail("Emplacement de travail requis pour extraire un pack.".to_string())
                .into_transport(),
        );
    }
    let workspace_path = absolute_path(workspace_dir, codes::FILES_WORKSPACE_ROOT_LABEL_TRANSPORT)?;

    let zips_base = super::project_media_dir(
        workspace_path
            .to_str()
            .ok_or(codes::FILES_INVALID_UTF_8_PATH_TRANSPORT)?,
        "zips-extraits",
        project_destination,
    )?;
    fs::create_dir_all(&zips_base).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_EXTRACTION_ROOT_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de créer zips-extraits : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let zips_base_canonical = fs::canonicalize(&zips_base).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_EXTRACTION_ROOT_INACCESSIBLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Dossier zips-extraits inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let subdir_name = Path::new(dest_dir).file_name().ok_or_else(|| {
        user_message::UserMessage::new(codes::FILES_INVALID_EXTRACTION_SUBFOLDER_NAME)
            .with_detail("Nom de sous-dossier d'extraction invalide.".to_string())
            .into_transport()
    })?;
    let subdir_str = subdir_name.to_string_lossy();
    if subdir_str == ".."
        || subdir_str == "."
        || subdir_str.contains('/')
        || subdir_str.contains('\\')
    {
        return Err(
            user_message::UserMessage::new(codes::FILES_INVALID_EXTRACTION_SUBFOLDER_NAME)
                .with_detail("Nom de sous-dossier d'extraction invalide.".to_string())
                .into_transport(),
        );
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
                    let _msg_error = (e).to_string();
                    user_message::UserMessage::new(codes::FILES_NEW_EXTRACTION_INACCESSIBLE)
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Dossier d'extraction nouvellement créé inaccessible : {_msg_error}",
                            _msg_error = user_message::transport_detail(&_msg_error),
                        ))
                        .into_transport()
                })?;
                if canonical.parent() != Some(zips_base_canonical.as_path()) {
                    let _ = fs::remove_dir_all(&candidate);
                    return Err(user_message::UserMessage::new(
                        codes::FILES_EXTRACTION_PATH_OUTSIDE,
                    )
                    .with_detail("Dossier d'extraction hors de zips-extraits.".to_string())
                    .into_transport());
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err({
                    let _msg_candidate = (candidate.display()).to_string();
                    let _msg_error = (error).to_string();
                    user_message::UserMessage::new(
                        codes::FILES_EXTRACTION_FOLDER_RESERVE_FAILED,
                    )
                        .param(
                            "candidate",
                            user_message::transport_param(_msg_candidate.clone()),
                        )
                        .param("error", user_message::transport_param(_msg_error.clone()))
                        .with_detail(format!(
                            "Impossible de réserver le dossier d'extraction {_msg_candidate} : {_msg_error}",
                            _msg_candidate = user_message::transport_detail(&_msg_candidate),
                            _msg_error = user_message::transport_detail(&_msg_error),
                        ))
                        .into_transport()
                })
            }
        }
    }

    Err(
        user_message::UserMessage::new(codes::FILES_EXTRACTION_NAME_EXHAUSTED)
            .with_detail(
                "Impossible de réserver un nom de dossier d'extraction unique.".to_string(),
            )
            .into_transport(),
    )
}

// Legacy string boundary retained for native_pack and technical callers.
pub(crate) fn validate_existing_file_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let label = match serde_json::from_str::<UserMessage>(label) {
        Ok(message) => MessageLabel::new(transport_detail(label), message),
        Err(_) => MessageLabel::data(label),
    };
    validate_existing_file_path_with_label(path, &label)
}

pub(crate) fn validate_existing_file_path_with_label(
    path: &str,
    label: &MessageLabel,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err({
            let _msg_label = (label).to_string();
            user_message::UserMessage::new(codes::LABEL_VALUE_EMPTY)
                .param("label", label.value())
                .with_detail(format!(
                    "{_msg_label} vide.",
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    let canonical = fs::canonicalize(trimmed).map_err(|e| {
        let _msg_label = (label).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_NOT_FOUND_OR_INACCESSIBLE)
            .param("label", label.value())
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "{_msg_label} introuvable ou inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_label = user_message::transport_detail(&_msg_label)
            ))
            .into_transport()
    })?;
    let metadata = fs::metadata(&canonical).map_err(|e| {
        let _msg_label = (label).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::LABEL_VALUE_INACCESSIBLE)
            .param("label", label.value())
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "{_msg_label} inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_label = user_message::transport_detail(&_msg_label)
            ))
            .into_transport()
    })?;
    if !metadata.is_file() {
        return Err({
            let _msg_label = (label).to_string();
            let _msg_canonical = (canonical.display()).to_string();
            user_message::UserMessage::new(codes::LABEL_VALUE_INVALID)
                .param("label", label.value())
                .param(
                    "canonical",
                    user_message::transport_param(_msg_canonical.clone()),
                )
                .with_detail(format!(
                    "{_msg_label} invalide : {_msg_canonical}",
                    _msg_canonical = user_message::transport_detail(&_msg_canonical),
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    Ok(canonical)
}

// Legacy string boundary retained for native_pack and technical callers.
pub(crate) fn validate_existing_dir_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let label = match serde_json::from_str::<UserMessage>(label) {
        Ok(message) => MessageLabel::new(transport_detail(label), message),
        Err(_) => MessageLabel::data(label),
    };
    validate_existing_dir_path_with_label(path, &label)
}

pub(crate) fn validate_existing_dir_path_with_label(
    path: &str,
    label: &MessageLabel,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err({
            let _msg_label = (label).to_string();
            user_message::UserMessage::new(codes::LABEL_VALUE_EMPTY)
                .param("label", label.value())
                .with_detail(format!(
                    "{_msg_label} vide.",
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    let canonical = fs::canonicalize(trimmed).map_err(|e| {
        let _msg_label = (label).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::FILES_NOT_FOUND_OR_INACCESSIBLE)
            .param("label", label.value())
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "{_msg_label} introuvable ou inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_label = user_message::transport_detail(&_msg_label)
            ))
            .into_transport()
    })?;
    let metadata = fs::metadata(&canonical).map_err(|e| {
        let _msg_label = (label).to_string();
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::LABEL_VALUE_INACCESSIBLE)
            .param("label", label.value())
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "{_msg_label} inaccessible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error),
                _msg_label = user_message::transport_detail(&_msg_label)
            ))
            .into_transport()
    })?;
    if !metadata.is_dir() {
        return Err({
            let _msg_label = (label).to_string();
            let _msg_canonical = (canonical.display()).to_string();
            user_message::UserMessage::new(codes::LABEL_VALUE_INVALID)
                .param("label", label.value())
                .param(
                    "canonical",
                    user_message::transport_param(_msg_canonical.clone()),
                )
                .with_detail(format!(
                    "{_msg_label} invalide : {_msg_canonical}",
                    _msg_canonical = user_message::transport_detail(&_msg_canonical),
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        });
    }
    Ok(canonical)
}

pub(crate) fn validate_existing_pack_path(path: &str) -> Result<PathBuf, String> {
    validate_supported_pack_path(path)
}

pub(crate) fn media_output_dir(
    workspace_dir: Option<&str>,
    category: &str,
    destination: Option<&super::ProjectMediaDestination>,
    missing_message: &str,
) -> Result<PathBuf, String> {
    let root = media_output_root(workspace_dir, missing_message)?;
    super::project_media_dir(
        root.to_str()
            .ok_or(codes::FILES_INVALID_UTF_8_PATH_TRANSPORT)?,
        category,
        destination,
    )
}
