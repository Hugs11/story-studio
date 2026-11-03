//! Opening exemplars from the catalogue: revalidation of the target and
//! consultation sessions for the simulator.
pub mod consultation;
pub mod declared_media;
pub mod editor_entry;
pub mod editor_extractions;
pub mod generation;
pub mod materialize;
pub mod target;

#[cfg(test)]
mod tests;

use super::{store::error, CatalogueState, Result};
use consultation::Registry;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};

fn canonical_cache_dir(cache: &Path) -> Result<PathBuf> {
    // Tauri's cache may not exist yet, or may traverse a system/user link.
    // Resolve the cache before creating owned subdirectories; links inside
    // those subdirectories remain subject to the ordinary path guards.
    std::fs::create_dir_all(cache).map_err(error)?;
    let cache = cache.canonicalize().map_err(error)?;
    Ok(crate::support::paths::without_verbatim_prefix(cache))
}

/// Releasing an absent registry must not initialize or touch the cache.
pub fn release_editor_extractions<R: tauri::Runtime>(
    app: &AppHandle<R>,
    owner: &str,
) -> Result<()> {
    release_editor_extractions_in(&app.state::<CatalogueState>(), owner)
}

pub(super) fn release_editor_extractions_in(state: &CatalogueState, owner: &str) -> Result<()> {
    match state.editor_extractions.get() {
        Some(registry) => registry.release(owner),
        None => Ok(()),
    }
}

/// The application's consultations, created on first use; creating the
/// registry removes the consultations left by a previous run.
pub fn consultations(app: &AppHandle) -> Result<Arc<Registry>> {
    let state = app.state::<CatalogueState>();
    state.ensure_available()?;
    if let Some(registry) = state.consultations.get() {
        return Ok(Arc::clone(registry));
    }
    let cache = canonical_cache_dir(&app.path().app_cache_dir().map_err(error)?)?;
    let registry = state
        .consultations
        .get_or_init(|| Arc::new(Registry::new(consultation::consultations_root(&cache))));
    Ok(Arc::clone(registry))
}

pub fn editor_extractions<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Arc<editor_extractions::Registry>> {
    let cache = app.path().app_cache_dir().map_err(error)?;
    editor_extractions_in(&app.state::<CatalogueState>(), &cache)
}

/// Shared temporary inputs also serve ordinary imports without a catalogue.
pub(super) fn editor_extractions_in(
    state: &CatalogueState,
    cache: &std::path::Path,
) -> Result<Arc<editor_extractions::Registry>> {
    if let Some(registry) = state.editor_extractions.get() {
        return Ok(Arc::clone(registry));
    }
    let cache = canonical_cache_dir(cache)?;
    Ok(Arc::clone(state.editor_extractions.get_or_init(|| {
        let root = editor_extractions::root(&cache);
        let registry = if state.ensure_available().is_ok() {
            editor_extractions::clean_legacy(&cache);
            editor_extractions::Registry::new(root)
        } else {
            log::warn!("Catalogue unavailable: editor extraction orphan cleanup skipped");
            editor_extractions::Registry::without_cleanup(root)
        };
        Arc::new(registry)
    })))
}

/// Startup: removes orphan consultations in the background (a crash leaves
/// their folders behind). Session folders and recoveries are not touched.
pub fn clean_at_startup(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("catalogue-consultations".into())
        .spawn(move || {
            if let Err(reason) = editor_extractions(&app) {
                log::warn!("Editor extraction initialization: {reason}");
            }
            if let Err(reason) = consultations(&app) {
                log::warn!(target: "catalogue_consultation", "consultations unavailable: {reason}");
            }
        });
    if let Err(error) = spawned {
        log::warn!(target: "catalogue_consultation", "startup cleanup not started: {error}");
    }
}
