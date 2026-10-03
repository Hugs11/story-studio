//! Frontière IPC du cache de vue de l'éditeur avancé.
//!
//! Les trois commandes ne touchent **que** le cache applicatif : aucune n'ouvre
//! un projet, n'écrit un `.mbah`, ne promeut une session ni ne marque le pack
//! modifié. C'est la traduction de trois interdits explicites :
//! mémoriser un zoom ne doit jamais promouvoir une session éphémère, réécrire
//! le `.mbah` de l'auteur, ni déclencher la garde de sauvegarde.
//!
//! Une panne de cache n'est pas une panne de sauvegarde : la lecture rend
//! `null` et l'écriture rend son motif, que l'appelant journalise une fois par
//! session avant de se désarmer. Aucune n'affiche de dialogue.

use crate::services::advanced_view_cache::{
    read_entry, rename_entry, write_entry, ViewCacheProject, ViewCacheRead, ViewState,
    CACHE_DIR_NAME,
};
use crate::support::temp::app_cache_subdir;

#[tauri::command]
pub(crate) fn read_advanced_view_state(
    app: tauri::AppHandle,
    project: ViewCacheProject,
    fingerprint: String,
) -> Result<Option<ViewCacheRead>, String> {
    let root = app_cache_subdir(&app, CACHE_DIR_NAME)?;
    read_entry(&root, &project, &fingerprint)
}

#[tauri::command]
pub(crate) fn write_advanced_view_state(
    app: tauri::AppHandle,
    project: ViewCacheProject,
    fingerprint: String,
    view: ViewState,
) -> Result<String, String> {
    let root = app_cache_subdir(&app, CACHE_DIR_NAME)?;
    write_entry(&root, &project, &fingerprint, &view)
}

/// Renomme l'entrée d'une session éphémère vers la clé du projet enregistré.
///
/// Appelée dans la transaction de promotion, **après** la publication de la
/// sauvegarde et **avant** la suppression du dossier de session. Un échec fait
/// abandonner l'entrée : la vue est reconstruite, rien d'autre n'est perdu.
#[tauri::command]
pub(crate) fn rename_advanced_view_state(
    app: tauri::AppHandle,
    from: ViewCacheProject,
    to: ViewCacheProject,
) -> Result<Option<String>, String> {
    let root = app_cache_subdir(&app, CACHE_DIR_NAME)?;
    rename_entry(&root, &from, &to)
}
