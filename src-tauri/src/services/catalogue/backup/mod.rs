//! Versioned portable backup planning and cancellable export.
mod ages;
mod export;
pub mod format;
pub mod import;
#[cfg(test)]
mod import_tests;
mod matching;
mod merge;
mod reconcile;
mod relations;
mod snapshot;
mod staging;
#[cfg(test)]
mod tests;
pub mod validate;
use crate::{
    services::catalogue::{
        store::{error, Store},
        Result,
    },
    support::user_message::{codes, UserMessage},
};
use format::ExportPlan;
use snapshot::Snapshot;
use std::{collections::HashMap, path::PathBuf, time::Instant};
#[derive(Default)]
pub(crate) struct Registry {
    plans: HashMap<String, Planned>,
    previews: HashMap<String, import::Prepared>,
    requests: HashMap<String, (String, serde_json::Value)>,
}
impl Registry {
    /// Catalogue erasure invalidates prepared snapshots, including their images.
    pub(crate) fn discard_export_plans(&mut self) {
        self.plans.clear();
    }
}
struct Planned {
    plan: ExportPlan,
    snapshot: Snapshot,
    destination: PathBuf,
    parent_id: String,
    previous: Option<format::Payload>,
    created: Instant,
}
fn row_limit() -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_ROW_LIMIT_EXCEEDED)
}
/// A portable format ceiling (JSON, image count or image volume) blocks the backup.
pub(super) fn size_limit() -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_SIZE_LIMIT_EXCEEDED)
}
fn failed() -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_EXPORT_FAILED)
}
fn changed() -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_EXPORT_SOURCE_CHANGED)
}
fn conflict() -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_DESTINATION_CONFLICT)
}
fn image_missing(sha: &str) -> UserMessage {
    UserMessage::new(codes::CATALOG_BACKUP_IMAGE_MISSING).param("sha256", sha)
}
fn io_error(e: std::io::Error) -> UserMessage {
    failed().with_detail(e.to_string())
}
impl Store {
    pub(crate) fn backup_root(&self) -> PathBuf {
        self.staging_root()
            .parent()
            .unwrap()
            .join("catalogue-backup")
    }
    pub fn plan_catalogue_export(&self, destination: PathBuf, revision: i64) -> Result<ExportPlan> {
        self.require_backup_destination_available(&destination)?;
        let mut registry = self.backup_exports.lock().map_err(error)?;
        registry
            .plans
            .retain(|_, p| p.created.elapsed().as_secs() < 900);
        if registry.plans.len() >= 2 {
            if let Some(oldest) = registry
                .plans
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(id, _)| id.clone())
            {
                registry.plans.remove(&oldest);
            }
        }
        drop(registry);
        let (destination, parent_id) = export::destination(self, &destination)?;
        self.require_backup_destination_available(&destination)?;
        let previous = export::existing(&destination)?;
        // Replacement is offered only for a verified catalogue backup, never a pack.
        if previous.is_some() {
            validate::archive(&destination).map_err(|_| conflict())?;
        }
        let snapshot = self.backup_snapshot(revision)?;
        let manifest = serde_json::to_vec(&snapshot.manifest).map_err(error)?;
        let plan = ExportPlan {
            plan_id: uuid::Uuid::new_v4().to_string(),
            catalogue_revision: revision,
            destination_path: crate::support::paths::path_for_frontend(&destination),
            counts: snapshot.manifest.counts.clone(),
            estimated_bytes: snapshot
                .manifest
                .entries
                .values()
                .map(|e| e.byte_size)
                .sum::<u64>()
                + manifest.len() as u64
                + (snapshot.manifest.entries.len() as u64 + 1) * 256,
            conflicts: if previous.is_some() {
                vec!["destinationExists".into()]
            } else {
                vec![]
            },
            issues: (0..snapshot.missing_lunii_images)
                .map(|_| "luniiImageMissing".into())
                .collect(),
        };
        let mut registry = self.backup_exports.lock().map_err(error)?;
        if registry.plans.len() >= 2 {
            if let Some(id) = registry
                .plans
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(id, _)| id.clone())
            {
                registry.plans.remove(&id);
            }
        }
        registry.plans.insert(
            plan.plan_id.clone(),
            Planned {
                plan: plan.clone(),
                snapshot,
                destination,
                parent_id,
                previous,
                created: Instant::now(),
            },
        );
        Ok(plan)
    }
}

pub(crate) use relations::forget_retained;
