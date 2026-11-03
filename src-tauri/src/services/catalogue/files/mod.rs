//! Controlled copies, conversions and removals. Plans are opaque, bounded and short lived.
pub mod checker;
mod convert;
pub mod duplicates;
mod formats;
pub mod identical;
mod identity;
pub mod models;
mod patch;
mod plan;
pub mod project_access;
pub(crate) mod publish;
mod recovery;
pub mod trash;
mod trash_native;
mod trash_retention;
use super::{
    scan,
    store::{error, Store},
    writes, Result,
};
use crate::support::user_message::{codes, UserMessage};
use models::*;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
pub(crate) use trash_retention::{retained_exemplars, retains as retained_in_trash};
pub(super) fn fail(code: &str) -> UserMessage {
    UserMessage::new(code)
}
pub(super) fn io_error(e: std::io::Error) -> UserMessage {
    let code = match e.kind() {
        std::io::ErrorKind::StorageFull => codes::CATALOG_FILE_NO_SPACE,
        std::io::ErrorKind::AlreadyExists => codes::CATALOG_FILE_NAME_CONFLICT,
        _ => codes::CATALOG_FILE_WRITE_FAILED,
    };
    fail(code).with_detail(e.to_string())
}
impl Store {
    pub(crate) fn file_root(&self) -> std::path::PathBuf {
        self.images_root().parent().unwrap().to_path_buf()
    }
    pub fn start_file_operation(
        self: &Arc<Self>,
        plan_id: String,
        decisions: Decisions,
        request_id: String,
        sink: scan::Sink,
        cache: std::path::PathBuf,
        data: std::path::PathBuf,
    ) -> Result<Value> {
        use rusqlite::OptionalExtension;
        if !decisions.summary_validated || request_id.is_empty() || request_id.len() > 200 {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let signature = json!({"planId":plan_id,"decisions":decisions}).to_string();
        // Serializes concurrent launches as well as request-key replay.
        let mut plans = self.file_plans.lock().map_err(error)?;
        let replay: Option<(String, String)> = self.read(|c| {
            c.query_row(
                "SELECT signature,receipt_json FROM file_operation WHERE request_id=?1",
                [&request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
        })?;
        if let Some((old, receipt)) = replay {
            if old != signature {
                return Err(fail(codes::CATALOG_MUTATION_INVALID));
            }
            return serde_json::from_str(&receipt).map_err(error);
        }
        let plan = plans
            .get(&plan_id)
            .cloned()
            .filter(|p| p.dto.expires_at > plan::stamp())
            .ok_or_else(|| fail(codes::CATALOG_FILE_PLAN_EXPIRED))?;
        if plan.removal.is_some() {
            self.require_unshared_archive(&plan)?;
        }
        if self.list_sources()?.catalogue_revision != plan.dto.catalogue_revision {
            return Err(fail(codes::CATALOG_REVISION_CONFLICT));
        }
        if decisions
            .skip_exemplar_ids
            .iter()
            .any(|id| !plan.dto.targets.iter().any(|t| &t.exemplar_id == id))
        {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        for t in plan.dto.targets.iter() {
            if decisions.skip_exemplar_ids.contains(&t.exemplar_id) {
                continue;
            }
            if t.capability.state != "available" {
                return Err(fail(codes::CATALOG_FILE_FORMAT_NOT_WRITABLE));
            }
            if !t.conflicts.is_empty() {
                return Err(fail(codes::CATALOG_FILE_NAME_CONFLICT));
            }
        }
        if plan.removal.is_some() {
            self.validate_removal_launch(&plan, &decisions)?;
        } else if !decisions.removal_confirmations.is_empty() {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let (receipt, op) = self.begin_file_report(
            &request_id,
            &plan.dto.action,
            plan.dto.targets.len(),
            sink.clone(),
        )?;
        let dto = json!({"operationId":receipt.operation_id,"requestId":receipt.request_id,"catalogueRevision":receipt.catalogue_revision,"sourcesRevision":receipt.sources_revision,"state":"queued"});
        self.write(|tx| {
            tx.execute(
                "INSERT INTO file_operation VALUES (?1,?2,?3,'running',?4)",
                rusqlite::params![receipt.operation_id, request_id, signature, dto.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })?;
        plans.remove(&plan_id);
        drop(plans);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let _heavy = match store.scans.heavy.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            // Reject results from a scan that started before this publication.
            store.scans.generation.fetch_add(1, Ordering::SeqCst);
            let (stop_heartbeat, heartbeat) = std::sync::mpsc::channel::<()>();
            let beat_op = Arc::clone(&op);
            let beat_sink = Arc::clone(&sink);
            let beat = std::thread::spawn(move || {
                while heartbeat.recv_timeout(Duration::from_millis(500))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    beat_op.emit(&beat_sink, false);
                }
            });
            let mut revision = plan.dto.catalogue_revision;
            let result = (|| {
                for t in plan.dto.targets.iter() {
                    patch::check(&op.cancel)?;
                    if decisions.skip_exemplar_ids.contains(&t.exemplar_id) {
                        store.update_file_report(&op, &sink, |p| {
                            p.outcomes.ignored += 1;
                            p.candidates.processed += 1;
                        });
                        continue;
                    }
                    store.update_file_report(&op, &sink, |p| {
                        p.status = "running".into();
                        p.phase = "analysis".into();
                        p.current_directory = Some(t.source_path.clone());
                    });
                    store.apply_file_target(
                        &plan,
                        &receipt.operation_id,
                        &op.cancel,
                        &mut revision,
                        &cache,
                        &data,
                        |phase| store.update_file_report(&op, &sink, |p| p.phase = phase.into()),
                    )?;
                    store.update_file_report(&op, &sink, |p| {
                        p.candidates.processed += 1;
                        p.outcomes.updated += 1;
                        p.report.push(super::events::ReportItem {
                            path: t.destination_path.clone(),
                            member: None,
                            outcome: "updated".into(),
                            reason: None,
                            detail: None,
                        });
                    });
                }
                Ok(())
            })();
            let cancelled = op.cancel.load(Ordering::Relaxed) && result.is_err();
            let state = if cancelled {
                "cancelled"
            } else if result.is_err() {
                "failed"
            } else {
                "success"
            };
            let _ = store.write(|tx| {
                tx.execute(
                    "UPDATE file_operation SET state=?2 WHERE id=?1",
                    rusqlite::params![receipt.operation_id, state],
                )
                .map_err(error)?;
                Ok(())
            });
            if let Err(reason) = store.reconcile_trash_retention() {
                log::warn!("Catalogue trash retention: {reason}");
            }
            store.retry_removal_purges();
            if let Ok(sources) = store.list_sources() {
                revision = sources.catalogue_revision;
            }
            let _ = stop_heartbeat.send(());
            let _ = beat.join();
            drop(_heavy);
            drop(store);
            Store::finish_file_report(&op, &sink, result, revision, cancelled);
        });
        Ok(dto)
    }
    #[allow(clippy::too_many_arguments)]
    fn apply_file_target(
        &self,
        plan: &StoredPlan,
        operation: &str,
        cancel: &AtomicBool,
        revision: &mut i64,
        cache: &Path,
        data: &Path,
        phase: impl Fn(&str),
    ) -> Result<()> {
        if plan.removal.is_some() {
            return self.apply_removal(plan, operation, cancel, revision, cache, data, phase);
        }
        Err(fail(codes::CATALOG_MUTATION_INVALID))
    }
}
#[cfg(test)]
mod tests;

/// Verifies the publication against the bytes and identities still on disk.
pub(super) fn publication_matches(path: &Path, token: &str) -> bool {
    patch::snapshot(path, &AtomicBool::new(false)).is_ok_and(|s| patch::token(&s) == token)
}

pub(super) fn strong_token(path: &Path) -> Option<String> {
    patch::snapshot(path, &AtomicBool::new(false))
        .ok()
        .map(|s| patch::token(&s))
}

/// Targets of the unfinished file operations; the production query, also
/// planned by the index test.
pub(super) const PENDING_TARGETS_SQL: &str = "SELECT json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.ficheId'),json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.identityTargetFicheId') FROM file_journal WHERE json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.stage') NOT IN ('complete','failed','rolledBack')";

/// Association changes must wait for durable publication or rollback. The
/// reservation is derived from the journal, so it survives a process restart.
pub(crate) fn require_associations_available(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
) -> Result<()> {
    let ids: std::collections::HashSet<_> = ids.iter().map(String::as_str).collect();
    if ids.is_empty() {
        return Ok(());
    }
    // Partial indexes exclude completed history. One query serves the whole batch.
    let mut statement = tx
        .prepare(PENDING_TARGETS_SQL)
        .map_err(super::store::error)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(super::store::error)?;
    for row in rows {
        let (source, target) = row.map_err(super::store::error)?;
        if source
            .iter()
            .chain(target.iter())
            .any(|id| ids.contains(id.as_str()))
        {
            return Err(fail(codes::CATALOG_FILE_RECOVERY_REQUIRED));
        }
    }
    Ok(())
}

pub(crate) fn require_mutation_available(
    tx: &rusqlite::Transaction<'_>,
    mutation: &super::data::journal::Mutation,
) -> Result<()> {
    // Only the cards a mutation designates are reserved; labels, metadata and request keys are not.
    let ids: Vec<String> = mutation
        .reserved_fiche_ids()
        .into_iter()
        .map(str::to_owned)
        .collect();
    require_associations_available(tx, &ids)
}

// Read-only bridge to the shared conversion and source proof implementation.
pub(crate) use patch::Snapshot as AssemblySnapshot;
pub(crate) fn assembly_snapshot(path: &Path, cancel: &AtomicBool) -> Result<AssemblySnapshot> {
    patch::snapshot(path, cancel)
}
pub(crate) fn assembly_unchanged(
    path: &Path,
    snapshot: &AssemblySnapshot,
    cancel: &AtomicBool,
) -> Result<()> {
    patch::unchanged(path, snapshot, cancel)
}
pub(crate) fn assembly_check(cancel: &AtomicBool) -> Result<()> {
    patch::check(cancel)
}
pub(crate) fn assembly_convert(
    catalogue: &Store,
    source: &Path,
    format: &str,
    chain: &[Value],
    output: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    convert::prepare(Some(catalogue), source, format, chain, output, cancel)
}
pub(crate) fn assembly_identity(store: &Store, id: &str, path: &Path) -> Result<()> {
    use rusqlite::OptionalExtension;
    let indexed = store
        .read(|c| {
            c.query_row(
                "SELECT file_id FROM exemplar_file_state WHERE exemplar_id=?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
        })?
        .flatten();
    if indexed.is_none() || indexed != writes::file_id(path) {
        return Err(fail(codes::CATALOG_ASSEMBLY_SOURCE_CHANGED));
    }
    Ok(())
}
