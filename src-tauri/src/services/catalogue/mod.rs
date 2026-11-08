//! Catalogue service: durable store, scans, watching of the sources and
//! recognition of the application's own writes.
pub mod removal;
pub mod sources;
pub mod store;
use crate::support::user_message::UserMessage;
use std::sync::{Arc, Mutex};
pub type Result<T> = std::result::Result<T, UserMessage>;

/// Startup admission owns the writer, or latches an unavailable catalogue until
/// restart. Editing remains usable without catalogue operations in the latter case.
#[derive(Default)]
pub struct CatalogueState {
    store: Mutex<Option<Result<Arc<store::Store>>>>,
    watch: Mutex<Option<watch::Service>>,
    /// Background source maintenance: whether a pass runs, and the workspace
    /// to record next (the latest request wins).
    maintenance: Mutex<(bool, Option<Option<String>>)>,
    /// Consultation sessions of the simulator (see `open::consultation`).
    consultations: std::sync::OnceLock<Arc<open::consultation::Registry>>,
    editor_extractions: std::sync::OnceLock<Arc<open::editor_extractions::Registry>>,
    import_sources: open::import_metadata::Sources,
}

impl CatalogueState {
    #[cfg(test)]
    pub fn store(
        &self,
        data: &std::path::Path,
        cache: &std::path::Path,
    ) -> Result<Arc<store::Store>> {
        self.admit_once(|| lifecycle::admit_store(data, cache, None))
    }

    pub fn ensure_available(&self) -> Result<()> {
        let slot = self.store.lock().map_err(store::error)?;
        match slot.as_ref() {
            Some(Ok(_)) => Ok(()),
            _ => Err(UserMessage::new(
                crate::support::user_message::codes::CATALOG_STORE_UNAVAILABLE,
            )),
        }
    }

    fn admit_once(
        &self,
        admit: impl FnOnce() -> Result<Arc<store::Store>>,
    ) -> Result<Arc<store::Store>> {
        let mut slot = self.store.lock().map_err(store::error)?;
        slot.get_or_insert_with(|| {
            admit().map_err(|cause| {
                log::error!(target: "catalogue", "Catalogue startup admission failed: {cause:?}");
                if cause.code == crate::support::user_message::codes::CATALOG_ALREADY_OPEN {
                    cause
                } else {
                    UserMessage::new(crate::support::user_message::codes::CATALOG_STORE_UNAVAILABLE)
                }
            })
        })
        .clone()
    }
}

#[cfg(test)]
mod tests;

pub mod age_prefix;
pub mod analyze;
pub mod events;
pub mod grouping;
mod lifecycle;
pub mod open;
mod path_identity;
mod probe;
pub mod refresh;
pub mod reveal;
pub mod scan;
pub mod walk;
pub mod watch;
pub mod writes;

pub use lifecycle::{
    initialize, maintain_sources, open_store, operation_sink, sources_changed, start_watching,
    watch_status,
};

#[cfg(test)]
mod entries_tests;
#[cfg(test)]
mod scan_tests;
#[cfg(test)]
mod watch_tests;

pub mod path_explanation;

#[cfg(test)]
mod surface_tests;

pub mod thumbnails;

pub mod cover_store;

pub mod data;

pub mod files;

pub mod assembly;

pub mod backup;

mod device_cards;
pub(crate) use device_cards::RepatriationTarget;
pub mod lunii_db;
mod official_packs;
pub(crate) use official_packs::observed_official;
