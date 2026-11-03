//! Stream into a sibling temporary, verify, then publish via native adapters.
use super::{
    format::{Decisions, Payload, MAX_JSON, MAX_TOTAL},
    *,
};
use crate::services::catalogue::{scan, writes};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
pub(super) fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(UserMessage::new(codes::GENERATION_CANCELLED))
    } else {
        Ok(())
    }
}
pub(super) fn destination(store: &Store, path: &Path) -> Result<(PathBuf, String)> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(conflict());
    }
    let parent = path.parent().ok_or_else(conflict)?;
    // Canonical parent anchors publication even when its spelling contains links.
    let parent = fs::canonicalize(parent).map_err(io_error)?;
    let data = fs::canonicalize(store.images_root().parent().unwrap()).map_err(io_error)?;
    let cache = fs::canonicalize(store.staging_root().parent().unwrap()).map_err(io_error)?;
    if parent.starts_with(data) || parent.starts_with(cache) {
        return Err(conflict());
    }
    let id = writes::file_id(&parent).ok_or_else(conflict)?;
    Ok((parent.join(path.file_name().unwrap()), id))
}
pub(super) fn existing(path: &Path) -> Result<Option<Payload>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
        Ok(m) => {
            if !m.is_file() || m.len() > MAX_TOTAL + MAX_JSON {
                return Err(conflict());
            }
            Ok(Some(digest(path, &AtomicBool::new(false))?))
        }
    }
}
pub(super) fn digest(path: &Path, cancel: &AtomicBool) -> Result<Payload> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        check(cancel)?;
        let n = file.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > MAX_TOTAL + MAX_JSON {
            return Err(failed());
        }
        hash.update(&buffer[..n]);
    }
    Ok(Payload {
        byte_size: count,
        sha256: format!("{:x}", hash.finalize()),
    })
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
impl Store {
    pub fn start_catalogue_export(
        self: &Arc<Self>,
        plan_id: String,
        decisions: Decisions,
        request: String,
        sink: scan::Sink,
    ) -> Result<Value> {
        if !decisions.summary_validated || request.is_empty() || request.len() > 200 {
            return Err(failed());
        }
        let signature = json!({"planId":plan_id,"decisions":decisions}).to_string();
        let mut registry = self.backup_exports.lock().map_err(error)?;
        if let Some((before, receipt)) = registry.requests.get(&request) {
            return if *before == signature {
                Ok(receipt.clone())
            } else {
                Err(failed())
            };
        }
        if registry.requests.len() >= 128 {
            let operations = self.scans.operations.lock().map_err(error)?;
            registry.requests.retain(|_, (_, receipt)| {
                receipt["operationId"]
                    .as_str()
                    .is_some_and(|id| operations.contains_key(id))
            });
        }
        let planned = registry.plans.get(&plan_id).ok_or_else(changed)?;
        if planned.created.elapsed().as_secs() >= 900
            || self.list_sources()?.catalogue_revision != planned.plan.catalogue_revision
        {
            registry.plans.remove(&plan_id);
            return Err(changed());
        }
        if planned.previous.is_some() && !decisions.replace_existing {
            return Err(conflict());
        }
        if existing(&planned.destination)? != planned.previous {
            return Err(conflict());
        }
        let (mut receipt, operation) =
            self.begin_file_report(&request, "catalogueExport", 1, sink.clone())?;
        if receipt.catalogue_revision != planned.plan.catalogue_revision {
            Store::finish_file_report(
                &operation,
                &sink,
                Err(changed()),
                receipt.catalogue_revision,
                false,
            );
            return Err(changed());
        }
        receipt.catalogue_revision = planned.plan.catalogue_revision;
        let planned = registry.plans.remove(&plan_id).unwrap();
        let dto = serde_json::to_value(&receipt).map_err(error)?;
        registry.requests.insert(request, (signature, dto.clone()));
        drop(registry);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let (stop, heartbeat) = std::sync::mpsc::channel::<()>();
            let op = Arc::clone(&operation);
            let beat_sink = Arc::clone(&sink);
            let beat = std::thread::spawn(move || {
                while heartbeat.recv_timeout(Duration::from_millis(500))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    op.emit(&beat_sink, false);
                }
            });
            let result = (|| {
                let _heavy = store.scans.heavy.lock().map_err(error)?;
                store.export_archive(&planned, &operation, &sink)
            })();
            let _ = stop.send(());
            let _ = beat.join();
            let cancelled = result.is_err() && operation.cancel.load(Ordering::Relaxed);
            Store::finish_file_report(
                &operation,
                &sink,
                result,
                receipt.catalogue_revision,
                cancelled,
            );
        });
        Ok(dto)
    }
    fn export_archive(
        &self,
        planned: &Planned,
        operation: &scan::Operation,
        sink: &scan::Sink,
    ) -> Result<()> {
        let result = write_archive(
            self,
            planned,
            &operation.cancel,
            |phase| {
                self.update_file_report(operation, sink, |p| {
                    p.status = "running".into();
                    p.phase = phase.into();
                    p.current_directory = Some(planned.plan.destination_path.clone());
                })
            },
            || {
                let _progress = operation.progress.lock().map_err(error)?;
                check(&operation.cancel)?;
                operation.published.store(true, Ordering::SeqCst);
                Ok(())
            },
        )?;
        self.update_file_report(operation, sink, |p| {
            p.result = Some(result);
            p.record(
                planned.plan.destination_path.clone(),
                None,
                "unchanged",
                None,
            );
        });
        Ok(())
    }
}
pub(super) fn write_archive(
    store: &Store,
    planned: &Planned,
    cancel: &AtomicBool,
    phase: impl Fn(&str),
    publishing: impl Fn() -> Result<()>,
) -> Result<Value> {
    check(cancel)?;
    let parent = planned.destination.parent().unwrap();
    if destination(store, &planned.destination)?.1 != planned.parent_id {
        return Err(conflict());
    }
    let temporary = Temporary(parent.join(format!(".catalogue-{}.partial", uuid::Uuid::new_v4())));
    let recovery = parent.join(format!(".catalogue-{}.previous", uuid::Uuid::new_v4()));
    let _own = writes::OwnWrite::begin(
        writes::Declaration::new("catalogueBackup")
            .temporary(&temporary.0)
            .temporary(&recovery)
            .exact(&planned.destination),
    );
    phase("writing");
    crate::services::catalogue::files::publish::require_space(
        parent,
        planned.plan.estimated_bytes,
    )?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.0)
        .map_err(io_error)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o600);
    zip.start_file("manifest.json", options)
        .map_err(|_| failed())?;
    zip.write_all(&serde_json::to_vec(&planned.snapshot.manifest).map_err(error)?)
        .map_err(io_error)?;
    zip.start_file("catalogue.json", options)
        .map_err(|_| failed())?;
    for bytes in planned.snapshot.catalogue.chunks(64 * 1024) {
        check(cancel)?;
        zip.write_all(bytes).map_err(io_error)?;
    }
    for name in planned
        .snapshot
        .manifest
        .entries
        .keys()
        .filter(|n| n.starts_with("images/"))
    {
        check(cancel)?;
        zip.start_file(name, options).map_err(|_| failed())?;
        let mut file = File::open(planned.snapshot.root.join(&name[7..])).map_err(io_error)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            check(cancel)?;
            let n = file.read(&mut buffer).map_err(io_error)?;
            if n == 0 {
                break;
            }
            zip.write_all(&buffer[..n]).map_err(io_error)?;
        }
    }
    let file = zip.finish().map_err(|_| failed())?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    phase("verification");
    validate::archive_cancel(&temporary.0, cancel)?;
    let archive = digest(&temporary.0, cancel)?;
    phase("publication");
    check(cancel)?;
    if destination(store, &planned.destination)?.1 != planned.parent_id
        || existing(&planned.destination)? != planned.previous
    {
        return Err(conflict());
    }
    check(cancel)?;
    // Cancellation stops at this indivisible publication boundary.
    publishing()?;
    publish_exclusive(store, planned, &temporary.0, &recovery)?;
    serde_json::to_value(format::ExportResult {
        path: planned.plan.destination_path.clone(),
        format_version: format::VERSION,
        catalogue_revision: planned.plan.catalogue_revision,
        counts: planned.plan.counts.clone(),
        byte_size: archive.byte_size,
        digest: archive.sha256,
        missing_lunii_images: planned.snapshot.missing_lunii_images,
    })
    .map_err(error)
}

// Moving the old archive aside makes the final publication exclusive even
// during replacement. A rival is never overwritten; the old complete archive
// is restored, or retained beside the destination with a recovery diagnostic.
#[derive(serde::Serialize, serde::Deserialize)]
struct Publication {
    destination: PathBuf,
    recovery: PathBuf,
    parent_id: String,
    previous: Payload,
    previous_id: String,
    prepared: Payload,
    prepared_id: String,
}
fn file_id(path: &Path) -> Result<String> {
    writes::file_id(path).ok_or_else(conflict)
}
fn matches(path: &Path, payload: &Payload, id: &str) -> bool {
    file_id(path).is_ok_and(|current| current == id)
        && existing(path).is_ok_and(|current| current.as_ref() == Some(payload))
}
fn publication_done(store: &Store, id: &str) -> Result<()> {
    store.write(|tx| {
        tx.execute("DELETE FROM backup_publication WHERE id=?1", [id])
            .map_err(error)?;
        Ok(())
    })
}
fn recover_publication(store: &Store, id: &str, intent: &Publication) -> Result<()> {
    use crate::services::catalogue::files::publish;
    if destination(store, &intent.destination)?.1 != intent.parent_id
        || intent.recovery.parent() != intent.destination.parent()
    {
        return Err(conflict());
    }
    let old = matches(&intent.recovery, &intent.previous, &intent.previous_id);
    if existing(&intent.destination)?.is_none() && old {
        // Restore only the complete original identified before the first move.
        publish::no_replace(&intent.recovery, &intent.destination)?;
    } else if matches(&intent.destination, &intent.prepared, &intent.prepared_id) {
        if old {
            fs::remove_file(&intent.recovery).map_err(io_error)?;
            publish::sync_directory(intent.destination.parent().unwrap())?;
        } else if fs::symlink_metadata(&intent.recovery).is_ok() {
            return Err(conflict());
        }
    } else if !matches(&intent.destination, &intent.previous, &intent.previous_id)
        || fs::symlink_metadata(&intent.recovery).is_ok()
    {
        return Err(conflict());
    }
    publication_done(store, id)
}
impl Store {
    pub(super) fn require_backup_destination_available(&self, path: &Path) -> Result<()> {
        let pending: Vec<String> = self.read(|c| {
            c.prepare("SELECT evidence_json FROM backup_publication")?
                .query_map([], |row| row.get(0))?
                .collect()
        })?;
        for json in pending {
            let intent: Publication = serde_json::from_str(&json).map_err(error)?;
            if super::super::store::startup_paths_overlap(&intent.destination, path)
                || super::super::store::startup_paths_overlap(&intent.recovery, path)
            {
                return Err(conflict().with_detail(json));
            }
        }
        Ok(())
    }
    pub(crate) fn pending_backup_paths(&self) -> Result<Vec<PathBuf>> {
        let pending: Vec<String> = self.read(|c| {
            c.prepare("SELECT evidence_json FROM backup_publication")?
                .query_map([], |row| row.get(0))?
                .collect()
        })?;
        let mut paths = Vec::new();
        for json in pending {
            let intent: Publication = serde_json::from_str(&json).map_err(error)?;
            paths.extend([intent.destination, intent.recovery]);
        }
        Ok(paths)
    }
    pub(crate) fn recover_backup_publications(&self) -> Result<Vec<UserMessage>> {
        let intents: Vec<(String, String)> = self.read(|c| {
            c.prepare("SELECT id,evidence_json FROM backup_publication")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })?;
        self.recover_backup_publications_from(intents)
    }
    pub(crate) fn recover_backup_publications_from(
        &self,
        intents: Vec<(String, String)>,
    ) -> Result<Vec<UserMessage>> {
        let mut warnings = Vec::new();
        for (id, json) in intents {
            let result = serde_json::from_str::<Publication>(&json)
                .map_err(error)
                .and_then(|intent| {
                    let _own = writes::OwnWrite::begin(
                        writes::Declaration::new("catalogueBackupRecovery")
                            .exact(&intent.destination)
                            .temporary(&intent.recovery),
                    );
                    recover_publication(self, &id, &intent)
                });
            if let Err(reason) = result {
                warnings.push(reason.with_detail(json));
            }
        }
        Ok(warnings)
    }
}
#[cfg(test)]
thread_local! {
    pub(super) static INTERRUPT_AFTER_MOVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn publish_exclusive(
    store: &Store,
    planned: &Planned,
    temporary: &Path,
    recovery: &Path,
) -> Result<()> {
    use crate::services::catalogue::files::publish;
    store.require_backup_destination_available(&planned.destination)?;
    let Some(previous) = &planned.previous else {
        return publish::no_replace(temporary, &planned.destination)
            .map_err(|e| conflict().with_detail(e.to_string()));
    };
    if existing(&planned.destination)?.as_ref() != Some(previous) {
        return Err(conflict());
    }
    let intent = Publication {
        destination: planned.destination.clone(),
        recovery: recovery.into(),
        parent_id: planned.parent_id.clone(),
        previous: previous.clone(),
        previous_id: file_id(&planned.destination)?,
        prepared: digest(temporary, &AtomicBool::new(false))?,
        prepared_id: file_id(temporary)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let evidence = serde_json::to_string(&intent).map_err(error)?;
    // SQLite's durable commit precedes either rename; startup can always find
    // the original, including when the destination is momentarily absent.
    store.write(|tx| {
        tx.execute(
            "INSERT INTO backup_publication VALUES (?1,?2)",
            rusqlite::params![id, evidence],
        )
        .map_err(error)?;
        Ok(())
    })?;
    let result = (|| {
        publish::no_replace(&planned.destination, recovery)?;
        #[cfg(test)]
        if INTERRUPT_AFTER_MOVE.with(|flag| flag.replace(false)) {
            return Err(failed().with_detail("Interrupted publication"));
        }
        if !matches(recovery, previous, &intent.previous_id) {
            return Err(conflict());
        }
        publish::no_replace(temporary, &planned.destination)?;
        Ok(())
    })();
    #[cfg(test)]
    if result
        .as_ref()
        .is_err_and(|e| e.detail.as_deref() == Some("Interrupted publication"))
    {
        return result;
    }
    if let Err(e) = result {
        if recovery.exists() && publish::no_replace(recovery, &planned.destination).is_err() {
            return Err(e.with_detail(format!(
                "Previous archive retained at {}",
                crate::support::paths::path_for_frontend(recovery)
            )));
        }
        recover_publication(store, &id, &intent)?;
        return Err(e);
    }
    recover_publication(store, &id, &intent)
}
