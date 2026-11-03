//! Serialized scan worker, cancellable snapshots and generation validation.
use super::{
    events::*,
    grouping::Scanned,
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Default)]
pub struct Manager {
    pub heavy: Mutex<()>,
    /// Separate from `heavy`: a running scan never delays a light read.
    pub light: LightReads,
    sink: Mutex<Option<Sink>>,
    pub generation: AtomicU64,
    pub operations: Mutex<HashMap<String, Arc<Operation>>>,
}
/// Budget of simultaneous light reads (thumbnails), shared by every caller.
pub const LIGHT_READS: usize = 2;
#[derive(Default)]
pub struct LightReads {
    active: Mutex<usize>,
    freed: Condvar,
}
impl LightReads {
    /// Waits only for another light read, never for the heavy job.
    pub fn acquire(&self) -> Result<LightRead<'_>> {
        let mut active = self.active.lock().map_err(error)?;
        while *active >= LIGHT_READS {
            active = self.freed.wait(active).map_err(error)?;
        }
        *active += 1;
        Ok(LightRead(self))
    }
}
pub struct LightRead<'a>(&'a LightReads);
impl Drop for LightRead<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active -= 1;
        }
        self.0.freed.notify_one();
    }
}
pub struct Operation {
    source_ids: Vec<String>,
    pub cancel: Arc<AtomicBool>,
    pub published: AtomicBool,
    pub(crate) started: AtomicBool,
    pub generation: u64,
    pub progress: Mutex<Progress>,
    last_emit: Mutex<Option<Instant>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub operation_id: String,
    pub request_id: String,
    pub sources_revision: i64,
    pub catalogue_revision: i64,
}
pub type Sink = Arc<dyn Fn(&str, &Progress) + Send + Sync>;
const STABILITY_INTERVAL: Duration = Duration::from_millis(20);
/// Per-directory discovery snapshots are coalesced (a tree may hold many
/// thousands of folders); each publication, phase change, heartbeat and the
/// terminal snapshot are always sent.
const EMIT_INTERVAL: Duration = Duration::from_millis(100);

fn unstable_reason(after: &std::io::Result<(String, i64, u64)>) -> String {
    match after {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "fileDisappeared",
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => "accessDenied",
        _ => "fileUnstable",
    }
    .into()
}

impl Operation {
    fn emit_throttled(&self, sink: &Sink) {
        let due = self
            .last_emit
            .lock()
            .is_ok_and(|last| last.is_none_or(|last| last.elapsed() >= EMIT_INTERVAL));
        if due {
            self.emit(sink, false);
        }
    }
    pub(crate) fn emit(&self, sink: &Sink, terminal: bool) {
        if let Ok(mut last) = self.last_emit.lock() {
            *last = Some(Instant::now());
        }
        if let Ok(mut p) = self.progress.lock() {
            p.sequence += 1;
            p.timestamp = stamp();
            let snapshot = p.clone();
            drop(p);
            sink(
                if terminal {
                    "catalogue-operation-finished"
                } else {
                    "catalogue-operation-progress"
                },
                &snapshot,
            );
        }
    }
}
fn stamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn token(path: &Path) -> std::io::Result<(String, i64, u64)> {
    let m = std::fs::metadata(path)?;
    let time = m.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
    let mut token = format!("{}:{}:{}", m.len(), time.as_secs(), time.subsec_nanos());
    if m.is_dir() {
        for name in [
            "story.json",
            "thumbnail.png",
            "ni",
            "ri",
            "si",
            "li",
            "ri.plain",
            "si.plain",
            "li.plain",
        ] {
            if let Ok(meta) = std::fs::metadata(path.join(name)) {
                let modified = meta
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                token.push_str(&format!(
                    ":{name}:{}:{}:{}",
                    meta.len(),
                    modified.as_secs(),
                    modified.subsec_nanos()
                ));
            }
        }
    }
    Ok((token, time.as_millis() as i64, m.len()))
}
fn dependency_token(mut base: String, paths: &[String]) -> String {
    base.push_str("|listening:v1");
    for path in paths {
        base.push_str(&serde_json::to_string(path).unwrap());
        match std::fs::metadata(path).and_then(|m| Ok((m.len(), m.modified()?))) {
            Ok((size, date)) => {
                let time = date.duration_since(UNIX_EPOCH).unwrap_or_default();
                base.push_str(&format!(
                    ":{size}:{}:{}",
                    time.as_secs(),
                    time.subsec_nanos()
                ));
            }
            Err(_) => base.push_str(":missing"),
        }
    }
    base
}
/// Listening values stored for one exemplar of a file. Only these values
/// are carried over from a previous scan; metadata is always analysed again.
struct StoredListening {
    member_key: Option<String>,
    listening_token: Option<String>,
    version: Option<i64>,
    pending: bool,
    dependencies: Vec<String>,
    fields: Vec<(String, super::analyze::ObservedField)>,
}
const STORED_LISTENING_SQL: &str = "SELECT json_extract(e.anchor_json,'$.memberKey'),json_extract(o.raw_observation_json,'$.listeningToken'),json_extract(o.raw_observation_json,'$.listeningVersion'),json_extract(o.raw_observation_json,'$.listeningPending'),json_extract(o.raw_observation_json,'$.listeningDependencies'),json_extract(o.raw_observation_json,'$.fields.\"/packMetadata/storyCount\"'),json_extract(o.raw_observation_json,'$.fields.\"/packMetadata/durationSeconds\"'),json_extract(o.raw_observation_json,'$.fields.\"/packMetadata/damagedMedia\"') FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE json_extract(e.anchor_json,'$.pathKey')=json(?1) AND e.retired=0 ORDER BY e.id";
pub(super) struct ContentState {
    pub token: (String, i64, u64),
    pub analysis_stale: bool,
}
impl Store {
    fn stored_listening(&self, path: &Path) -> Result<Vec<StoredListening>> {
        let key = serde_json::to_string(&super::path_identity::key(path)).map_err(error)?;
        self.read(|c| {
            let mut q = c.prepare(STORED_LISTENING_SQL)?;
            let rows = q
                .query_map([key], |r| {
                    let mut fields = Vec::new();
                    for (index, key) in [
                        (5, "storyCount"),
                        (6, "durationSeconds"),
                        (7, "damagedMedia"),
                    ] {
                        if let Some(field) = r
                            .get::<_, Option<String>>(index)?
                            .and_then(|f| serde_json::from_str(&f).ok())
                        {
                            fields.push((format!("/packMetadata/{key}"), field));
                        }
                    }
                    Ok(StoredListening {
                        member_key: r.get(0)?,
                        listening_token: r.get(1)?,
                        version: r.get(2)?,
                        pending: r.get::<_, Option<bool>>(3)?.unwrap_or(false),
                        dependencies: r
                            .get::<_, Option<String>>(4)?
                            .and_then(|d| serde_json::from_str(&d).ok())
                            .unwrap_or_default(),
                        fields,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }
    /// File token extended with the size and date of the sounds the stored
    /// listening values depend on. No content is read.
    pub(super) fn content_token(&self, path: &Path) -> std::io::Result<(String, i64, u64)> {
        self.content_state(path).map(|state| state.token)
    }
    /// One database read for both dependency stats and analysis validity.
    pub(super) fn content_state(&self, path: &Path) -> std::io::Result<ContentState> {
        let (base, date, size) = token(path)?;
        let stored = self
            .stored_listening(path)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        // Extend this validity check when another versioned analysis is added.
        let analysis_stale = stored
            .iter()
            .any(|s| s.pending || s.version != Some(i64::from(super::analyze::LISTENING_VERSION)));
        let paths = stored
            .into_iter()
            .flat_map(|s| s.dependencies)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        Ok(ContentState {
            token: (dependency_token(base, &paths), date, size),
            analysis_stale,
        })
    }
    /// Metadata is analysed as before. Listening values are measured only when
    /// the file or one of its sounds changed (or the listening version did);
    /// otherwise the stored values, and a still pending solid pass, are kept.
    pub(super) fn observe_listening(
        &self,
        source_id: &str,
        path: &Path,
        initial: &std::io::Result<(String, i64, u64)>,
        cancel: &AtomicBool,
    ) -> Vec<Scanned> {
        let stored = self.stored_listening(path).unwrap_or_default();
        let current = self.content_token(path).ok().map(|t| t.0);
        let reuse = current.is_some()
            && !stored.is_empty()
            && stored.iter().all(|s| {
                s.listening_token == current
                    && s.version == Some(i64::from(super::analyze::LISTENING_VERSION))
            });
        let mut values = observe(source_id, path, initial, cancel, &self.activity, !reuse);
        if reuse {
            for item in &mut values {
                let observation = &mut item.observation;
                observation.listening_pending = false;
                let key = observation.member_key();
                if let Some(previous) = stored.iter().find(|s| s.member_key == key) {
                    if observation.state == "available" {
                        super::analyze::clear_listening(observation);
                        observation.fields.extend(previous.fields.iter().cloned());
                    }
                    observation.listening_pending = previous.pending;
                    observation.listening_dependencies = previous.dependencies.clone();
                    observation.listening_token = previous.listening_token.clone();
                }
            }
            return values;
        }
        let paths = values
            .iter()
            .flat_map(|v| v.observation.listening_dependencies.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let interrupted = cancel.load(Ordering::Relaxed);
        for item in &mut values {
            let observation = &mut item.observation;
            if interrupted || observation.listening_incomplete {
                // Nothing partial is published as a stable listening value:
                // without a token, the next scan measures again.
                super::analyze::clear_listening(observation);
                observation.listening_pending = false;
                observation.listening_dependencies.clear();
                observation.listening_token = None;
            } else if observation.state != "available"
                && super::grouping::failure_outcome(&observation.state) == "error"
            {
                // A transient failure (access denied, file being copied…) says
                // nothing about the current content: settling a token here would
                // let the next scan reuse the previous content's values.
                observation.listening_token = None;
            } else {
                // Failed children also belong to this completed observation:
                // they must not invalidate an unchanged multipack on every scan.
                observation.listening_token = Some(dependency_token(item.token.clone(), &paths));
            }
        }
        values
    }
}
/// Outcome of the separate listening pass of a solid archive.
pub(super) enum SolidPass {
    /// The items to publish: measured, or settled without values.
    Publish(Vec<Scanned>),
    /// The tool failed: the stored pending state is kept and retried.
    Keep,
    /// Cancelled: nothing is published.
    Cancelled,
}
impl Store {
    /// Runs without any catalogue lock; the caller publishes under its guard.
    pub(super) fn solid_pass(
        &self,
        path: &Path,
        items: &[Scanned],
        cancel: &AtomicBool,
    ) -> SolidPass {
        use super::analyze::ListeningFailure;
        let mut observations: Vec<_> = items.iter().map(|i| i.observation.clone()).collect();
        self.activity.solid_passes.fetch_add(1, Ordering::Relaxed);
        #[cfg(test)]
        if self.activity.solid_pass_tool_fails.load(Ordering::Relaxed) {
            return SolidPass::Keep;
        }
        match super::analyze::enrich_7z(path, &mut observations, cancel) {
            Ok(()) => {}
            Err(ListeningFailure::Cancelled) => return SolidPass::Cancelled,
            Err(ListeningFailure::Retry(_)) => return SolidPass::Keep,
            Err(ListeningFailure::Settled(_)) => observations
                .iter_mut()
                .for_each(super::analyze::clear_listening),
        }
        if cancel.load(Ordering::Relaxed) {
            return SolidPass::Cancelled;
        }
        SolidPass::Publish(
            items
                .iter()
                .cloned()
                .zip(observations)
                .map(|(mut item, mut observation)| {
                    observation.listening_pending = false;
                    item.observation = observation;
                    item
                })
                .collect(),
        )
    }
    /// Checked under the analysis guard before a listening publication: the
    /// file is not being written, and its listening token is still the one
    /// taken when it was analysed (same size, date and sounds).
    pub(super) fn listening_publishable(
        &self,
        registry: &super::writes::Registry,
        path: &Path,
        items: &[Scanned],
    ) -> Result<bool> {
        if registry.classify(path, Instant::now()) == super::writes::Verdict::Deferred
            || self
                .pending_file_paths()?
                .iter()
                .any(|p| path.starts_with(p) || p.starts_with(path))
        {
            return Ok(false);
        }
        let analysed = items
            .iter()
            .find_map(|i| i.observation.listening_token.clone());
        Ok(analysed.is_some() && analysed == self.content_token(path).ok().map(|t| t.0))
    }
}
/// Analyses one discovered unit. A file that changed since `initial` was
/// taken, or while it was read, keeps its last known data with an explicit
/// reason; it is never analysed half-written.
pub(super) fn observe(
    source_id: &str,
    path: &Path,
    initial: &std::io::Result<(String, i64, u64)>,
    cancel: &AtomicBool,
    activity: &super::refresh::Activity,
    measure: bool,
) -> Vec<Scanned> {
    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("directory")
        .to_owned();
    let after = token(path);
    let stable = matches!((initial, &after), (Ok(a), Ok(b)) if a == b);
    let observations = if !stable {
        vec![super::analyze::Observation::failure(
            &format,
            unstable_reason(&after),
            None,
        )]
    } else {
        activity.analyses.fetch_add(1, Ordering::Relaxed);
        if measure {
            activity.measurements.fetch_add(1, Ordering::Relaxed);
        }
        let analyzed =
            super::analyze::analyze_with(path, cancel, measure).unwrap_or_else(|reason| {
                vec![super::analyze::Observation::failure(&format, reason, None)]
            });
        if token(path).ok() == after.as_ref().ok().cloned() {
            analyzed
        } else {
            vec![super::analyze::Observation::failure(
                &format,
                "fileUnstable".into(),
                None,
            )]
        }
    };
    let (token, modified, size) = after.unwrap_or_else(|_| (String::new(), 0, 0));
    // Canonical Windows paths are verbatim (`\\?\`); stored and reported
    // paths use the display form. One key per file.
    let display = crate::support::paths::path_for_frontend(path);
    let path_key = super::path_identity::key(path);
    let file_id = super::writes::file_id(path);
    observations
        .into_iter()
        .map(|observation| Scanned {
            source_id: source_id.to_owned(),
            path: display.clone(),
            path_key: path_key.clone(),
            token: token.clone(),
            modified,
            size,
            file_id: file_id.clone(),
            save_prestate: None,
            observation,
        })
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationList {
    pub items: Vec<Progress>,
    pub retained_operation_ids: Vec<String>,
}

impl Store {
    pub fn scanning_sources(&self) -> Result<std::collections::HashSet<String>> {
        let operations = self.scans.operations.lock().map_err(error)?;
        let mut ids = std::collections::HashSet::new();
        for op in operations.values() {
            if matches!(
                op.progress.lock().map_err(error)?.status.as_str(),
                "queued" | "running" | "cancelling"
            ) {
                ids.extend(op.source_ids.clone());
            }
        }
        Ok(ids)
    }
    pub fn list_operations(&self, limit: usize) -> Result<OperationList> {
        let operations = self.scans.operations.lock().map_err(error)?;
        let mut items = operations
            .values()
            .map(|op| op.progress.lock().map(|p| p.clone()).map_err(error))
            .collect::<Result<Vec<_>>>()?;
        items.retain(|p| !p.request_id.starts_with("lunii-auto-"));
        items.sort_by(|a, b| {
            b.timestamp
                .cmp(&a.timestamp)
                .then_with(|| b.operation_id.cmp(&a.operation_id))
        });
        items.truncate(limit.clamp(1, 20));
        Ok(OperationList {
            items,
            // Unlike the twenty presented results, this is the complete bounded
            // registry. The UI can forget tombstones only after engine expiry.
            retained_operation_ids: operations.keys().cloned().collect(),
        })
    }
    #[cfg(test)]
    pub fn start_scan(
        self: &Arc<Self>,
        source_ids: Option<Vec<String>>,
        request_id: String,
        expected: i64,
        cache: PathBuf,
        data: PathBuf,
        sink: Sink,
    ) -> Result<Receipt> {
        self.start_scan_paths(source_ids, None, request_id, expected, cache, data, sink)
    }
    #[allow(clippy::too_many_arguments)] // Additive IPC filter; existing callers retain start_scan.
    pub fn start_scan_paths(
        self: &Arc<Self>,
        source_ids: Option<Vec<String>>,
        paths: Option<Vec<String>>,
        request_id: String,
        expected: i64,
        cache: PathBuf,
        data: PathBuf,
        sink: Sink,
    ) -> Result<Receipt> {
        self.set_operation_sink(Arc::clone(&sink))?;
        self.prepare_lunii_scan(sink.clone());
        let list = self.all_sources()?;
        if list.sources_revision != expected {
            return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
        }
        let mut roots: Vec<_> = list
            .items
            .into_iter()
            .filter(|s| {
                s.status == "active" && source_ids.as_ref().is_none_or(|ids| ids.contains(&s.id))
            })
            .collect();
        let retry_paths = paths
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|path| {
                        let raw = PathBuf::from(path);
                        let resolved = super::refresh::resolve_existing(&raw);
                        let source = roots
                            .iter()
                            .find(|s| {
                                raw.is_absolute()
                                    && resolved.starts_with(super::refresh::resolve_existing(
                                        &s.native_path,
                                    ))
                            })
                            .ok_or_else(|| UserMessage::new(codes::CATALOG_SOURCE_UNAVAILABLE))?;
                        Ok((source.id.clone(), raw))
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;
        if let Some(paths) = &retry_paths {
            roots.retain(|s| paths.iter().any(|(id, _)| id == &s.id));
        }
        let health_sources = roots.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
        let all_roots = roots.clone();
        let selected: std::collections::HashSet<_> = roots.iter().map(|s| s.id.clone()).collect();
        roots.retain(|s| {
            retry_paths.is_some()
                || s.included_in
                    .as_ref()
                    .is_none_or(|parent| !selected.contains(parent))
        });
        let mut operations = self.scans.operations.lock().map_err(error)?;
        if let Some(op) = operations
            .values()
            .find(|op| op.progress.lock().is_ok_and(|p| p.request_id == request_id))
        {
            let p = op.progress.lock().map_err(error)?;
            return Ok(Receipt {
                operation_id: p.operation_id.clone(),
                request_id,
                sources_revision: expected,
                catalogue_revision: p.catalogue_revision,
            });
        }
        if operations.len() >= 32 {
            let oldest = operations
                .iter()
                .filter_map(|(id, op)| {
                    op.progress
                        .lock()
                        .ok()
                        .filter(|p| {
                            matches!(
                                p.status.as_str(),
                                "success" | "partial" | "failed" | "cancelled"
                            )
                        })
                        .map(|p| (p.timestamp, id.clone()))
                })
                .min();
            if let Some((_, id)) = oldest {
                operations.remove(&id);
            } else {
                return Err(UserMessage::new(codes::CATALOG_OPERATION_LIMIT));
            }
        }
        let generation = self.scans.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let id = uuid::Uuid::new_v4().to_string();
        let op = Arc::new(Operation {
            source_ids: health_sources.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            published: AtomicBool::new(false),
            started: AtomicBool::new(false),
            generation,
            last_emit: Mutex::new(None),
            progress: Mutex::new(Progress {
                operation_kind: None,
                download_bytes: None,
                result: None,
                operation_id: id.clone(),
                request_id: request_id.clone(),
                sequence: 0,
                sources_revision: expected,
                catalogue_revision: list.catalogue_revision,
                timestamp: stamp(),
                error: None,
                status: "queued".into(),
                phase: "discovery".into(),
                discovery_complete: false,
                scan_complete: false,
                unvisited_extent_unknown: true,
                current_source_id: None,
                current_directory: None,
                roots: Roots {
                    total: roots.len() as u64,
                    ..Default::default()
                },
                directories: Directories::default(),
                candidates: Candidates::default(),
                outcomes: Outcomes::default(),
                cards: Cards::default(),
                reasons: Vec::new(),
                report: Vec::new(),
                catalogue_changed: false,
            }),
        });
        operations.insert(id.clone(), Arc::clone(&op));
        drop(operations);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let source_health = Mutex::new(HashMap::<String, bool>::new());
            let source_access = Mutex::new(HashMap::<String, &str>::new());
            let (heartbeat_stop, heartbeat) = std::sync::mpsc::channel::<()>();
            let beat_op = Arc::clone(&op);
            let beat_sink = Arc::clone(&sink);
            let beat = std::thread::spawn(move || {
                while heartbeat.recv_timeout(std::time::Duration::from_millis(500))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    beat_op.emit(&beat_sink, false);
                }
            });
            let run = || -> Result<()> {
                let _heavy = loop {
                    match store.scans.heavy.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::WouldBlock) => {
                            if op.cancel.load(Ordering::Relaxed) {
                                return Ok(());
                            }
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                        Err(reason) => return Err(error(reason)),
                    }
                };
                op.progress.lock().map_err(error)?.status = "running".into();
                store.activity.full_scans.fetch_add(1, Ordering::Relaxed);
                op.emit(&sink, false);
                let exclusions = store.exclusions(&cache, &data)?;
                let mut work = Vec::new();
                let mut scopes = Vec::new();
                let mut scope_paths = Vec::new();
                for source in roots {
                    if op.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(revision) = store.retire_excluded(&source.id, &exclusions)? {
                        let mut p = op.progress.lock().map_err(error)?;
                        p.catalogue_revision = revision;
                        p.catalogue_changed = true;
                    }
                    op.progress.lock().map_err(error)?.current_source_id = Some(source.id.clone());
                    let directory_base = op.progress.lock().map_err(error)?.directories.visited;
                    let candidate_base = op.progress.lock().map_err(error)?.candidates.discovered;
                    let mut found = if let Some(paths) = &retry_paths {
                        let mut found = super::walk::Discovery {
                            complete: true,
                            ..Default::default()
                        };
                        for (_, path) in paths.iter().filter(|(id, _)| id == &source.id) {
                            let resolved = super::refresh::resolve_existing(path);
                            let classification = exclusions.classify(path, Some(&resolved));
                            if classification.is_err() {
                                found.complete = false;
                                found.errors.push(super::walk::ScopeError {
                                    path: path.clone(),
                                    reason: "unreadableUnknown",
                                    detail: "workspace structure probe inconclusive".into(),
                                });
                            } else if let Ok(Some(rule)) = classification {
                                found.excluded.push((path.clone(), rule.role.clone()));
                            } else if path.is_dir() {
                                let subtree = super::walk::discover(
                                    path,
                                    &exclusions,
                                    &op.cancel,
                                    |directory, discovered| {
                                        if let Ok(mut p) = op.progress.lock() {
                                            p.current_directory = Some(
                                                crate::support::paths::path_for_frontend(directory),
                                            );
                                            p.directories.visited = directory_base
                                                + found.directories
                                                + discovered.directories;
                                        }
                                        op.emit_throttled(&sink);
                                    },
                                );
                                found.complete &= subtree.complete;
                                found.directories += subtree.directories;
                                found.candidates.extend(subtree.candidates);
                                found.errors.extend(subtree.errors);
                                found.excluded.extend(subtree.excluded);
                            } else {
                                found.candidates.push(path.clone());
                            }
                        }
                        found
                    } else {
                        super::walk::discover(
                            &source.native_path,
                            &exclusions,
                            &op.cancel,
                            |path, found| {
                                if let Ok(mut p) = op.progress.lock() {
                                    p.current_directory = Some(path.to_string_lossy().into());
                                    p.directories.visited = directory_base + found.directories;
                                    p.candidates.discovered =
                                        candidate_base + found.candidates.len() as u64;
                                }
                                op.emit_throttled(&sink);
                            },
                        )
                    };
                    if retry_paths.is_none() {
                        for path in store.explicit_output_paths(&source.id)? {
                            if path.exists()
                                && !found.candidates.contains(&path)
                                && matches!(exclusions.classify(&path, Some(&path)), Ok(None))
                            {
                                found.candidates.push(path);
                            }
                        }
                    }
                    {
                        let mut p = op.progress.lock().map_err(error)?;
                        p.directories.errors += found.errors.len() as u64;
                        p.candidates.discovered = candidate_base + found.candidates.len() as u64;
                        for failure in &found.errors {
                            p.record_scope_error(
                                failure.path.to_string_lossy().into(),
                                failure.reason,
                                failure.detail.clone(),
                            );
                        }
                        for (path, role) in &found.excluded {
                            p.record_ignored(path.to_string_lossy().into(), role);
                        }
                        if found.complete {
                            p.roots.completed += 1;
                        } else {
                            p.roots.failed += 1;
                        }
                    }
                    source_access.lock().map_err(error)?.insert(
                        source.id.clone(),
                        if found
                            .errors
                            .iter()
                            .any(|failure| failure.path == source.native_path)
                        {
                            "unavailable"
                        } else {
                            "available"
                        },
                    );
                    scopes.push((source.id.clone(), found.complete));
                    scope_paths.push(source.native_path.clone());
                    for path in found.candidates {
                        let initial = token(&path);
                        work.push((source.id.clone(), path, initial));
                    }
                }
                for source in &all_roots {
                    if scopes.iter().any(|(id, _)| *id == source.id) {
                        continue;
                    }
                    if let Some(parent) = &source.included_in {
                        if let Some((_, complete)) = scopes.iter().find(|(id, _)| id == parent) {
                            let complete = *complete;
                            if complete {
                                source_access
                                    .lock()
                                    .map_err(error)?
                                    .insert(source.id.clone(), "available");
                            }
                            scopes.push((source.id.clone(), complete));
                            scope_paths.push(source.native_path.clone());
                        }
                    }
                }
                source_health
                    .lock()
                    .map_err(error)?
                    .extend(scopes.iter().cloned());
                let mut pending_inventories = work
                    .iter()
                    .filter(|(_, path, _)| {
                        path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                            e.eq_ignore_ascii_case("zip") || e.eq_ignore_ascii_case("7z")
                        })
                    })
                    .count();
                {
                    let mut p = op.progress.lock().map_err(error)?;
                    p.discovery_complete =
                        pending_inventories == 0 && !op.cancel.load(Ordering::Relaxed);
                    p.unvisited_extent_unknown = !p.discovery_complete || p.roots.failed > 0;
                    p.candidates.total = p.discovery_complete.then_some(p.candidates.discovered);
                    p.phase = "analysis".into();
                }
                op.emit(&sink, false);
                // The most recently modified files are published first, so a
                // new card takes its initial reference from the latest exemplar
                // of the whole discovered inventory.
                work.sort_by_cached_key(|(_, path, _)| {
                    (
                        std::cmp::Reverse(
                            std::fs::metadata(path)
                                .and_then(|m| m.modified())
                                .unwrap_or(UNIX_EPOCH),
                        ),
                        path.clone(),
                    )
                });
                // One shared stability interval avoids N sleeps for N packs.
                std::thread::sleep(STABILITY_INTERVAL);
                let mut listening_jobs = Vec::new();
                let pending = store.pending_file_paths()?;
                for (source_id, path, initial) in work {
                    {
                        // The walk is over: the item being analysed replaces
                        // the last folder it visited.
                        let mut p = op.progress.lock().map_err(error)?;
                        p.current_source_id = Some(source_id.clone());
                        p.current_directory = Some(crate::support::paths::path_for_frontend(&path));
                    }
                    op.emit_throttled(&sink);
                    if op.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let registry = super::writes::shared();
                    let _analysis = registry.analysis_guard();
                    if registry.classify(&path, std::time::Instant::now())
                        == super::writes::Verdict::Deferred
                        || pending
                            .iter()
                            .any(|p| path.starts_with(p) || p.starts_with(&path))
                    {
                        // The current content belongs to the writer. Preserve
                        // its prior observation, including availability, and
                        // prevent finalization from treating it as unseen.
                        source_health
                            .lock()
                            .map_err(error)?
                            .insert(source_id.clone(), false);
                        store.preserve_deferred(&id, expected, &source_id, &path)?;
                        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                            e.eq_ignore_ascii_case("zip") || e.eq_ignore_ascii_case("7z")
                        }) {
                            pending_inventories = pending_inventories.saturating_sub(1);
                        }
                        continue;
                    }
                    let mut analyzed =
                        store.observe_listening(&source_id, &path, &initial, &op.cancel);
                    if analyzed.iter().any(|i| i.observation.listening_pending) {
                        listening_jobs.push((source_id.clone(), path.clone(), analyzed.clone()));
                    }
                    for item in &mut analyzed {
                        if item.observation.member.is_none()
                            && item.observation.format == "project"
                            && item.observation.uuid().is_some()
                        {
                            item.save_prestate = store.attested_prestate(registry, &path)?;
                        }
                    }
                    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                        e.eq_ignore_ascii_case("zip") || e.eq_ignore_ascii_case("7z")
                    }) {
                        pending_inventories = pending_inventories.saturating_sub(1);
                    }
                    {
                        let mut p = op.progress.lock().map_err(error)?;
                        // Multipack children are counted; the container is the
                        // unit of inventory, not an extra exemplar.
                        p.candidates.discovered += analyzed.len() as u64 - 1;
                        p.discovery_complete = pending_inventories == 0;
                        p.candidates.total =
                            p.discovery_complete.then_some(p.candidates.discovered);
                    }
                    // Publish a bounded batch. Earlier committed batches remain
                    // valid if cancellation arrives later; stale in-flight reads
                    // are rejected before they can change either database.
                    {
                        let _operations = store.scans.operations.lock().map_err(error)?;
                        if store.scans.generation.load(Ordering::SeqCst) != op.generation {
                            return Err(UserMessage::new(codes::CATALOG_SCAN_SUPERSEDED));
                        }
                        if op.cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        analyzed.sort_by(|a, b| {
                            b.modified
                                .cmp(&a.modified)
                                .then_with(|| a.path.cmp(&b.path))
                                .then_with(|| a.observation.member.cmp(&b.observation.member))
                        });
                        let published = if retry_paths.is_some() {
                            store.publish_targeted(&id, expected, &source_id, &analyzed, &[])?
                        } else {
                            store.publish_scan(&id, expected, &analyzed, &scopes)?
                        };
                        if analyzed
                            .iter()
                            .all(|item| item.observation.state == "available")
                        {
                            registry.acknowledge_save(&path);
                        }
                        if published.outcomes.iter().any(|outcome| outcome == "error") {
                            source_health
                                .lock()
                                .map_err(error)?
                                .insert(source_id.clone(), false);
                        }
                        let mut p = op.progress.lock().map_err(error)?;
                        p.catalogue_revision = published.revision;
                        p.catalogue_changed |= published.changed;
                        p.cards.created += published.cards_created;
                        p.cards.updated += published.cards_updated;
                        for (item, outcome) in analyzed.into_iter().zip(published.outcomes) {
                            let reason = (item.observation.state != "available")
                                .then_some(item.observation.state.as_str());
                            p.record(item.path, item.observation.member, &outcome, reason);
                            if let Some(last) = p.report.last_mut() {
                                last.detail = (!item.observation.diagnostics.is_empty())
                                    .then(|| item.observation.diagnostics.join("\n"));
                            }
                        }
                    }
                    op.emit(&sink, false);
                }
                // Metadata is already visible for every file. Complete solid
                // archives serially in this existing background scan worker.
                for (source_id, path, items) in listening_jobs {
                    if op.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let items = match store.solid_pass(&path, &items, &op.cancel) {
                        SolidPass::Publish(items) => items,
                        SolidPass::Keep => continue,
                        SolidPass::Cancelled => break,
                    };
                    let registry = super::writes::shared();
                    let _analysis = registry.analysis_guard();
                    let _operations = store.scans.operations.lock().map_err(error)?;
                    // A cancelled scan, a newer generation or a source change
                    // ends the pass without failing the scan.
                    if op.cancel.load(Ordering::Relaxed)
                        || store.scans.generation.load(Ordering::SeqCst) != op.generation
                        || store.sources_revision()? != expected
                    {
                        break;
                    }
                    if !store.listening_publishable(registry, &path, &items)? {
                        continue;
                    }
                    let published =
                        store.publish_targeted(&id, expected, &source_id, &items, &[])?;
                    let mut p = op.progress.lock().map_err(error)?;
                    p.catalogue_revision = published.revision;
                    p.catalogue_changed |= published.changed;
                    drop(p);
                    op.emit(&sink, false);
                }
                {
                    let mut p = op.progress.lock().map_err(error)?;
                    p.phase = "finalization".into();
                    p.unvisited_extent_unknown = !p.discovery_complete || p.roots.failed > 0;
                    p.candidates.total = p.discovery_complete.then_some(p.candidates.discovered);
                }
                op.emit(&sink, false);
                // Keep start/generation changes out of the publication interval.
                let _operations = store.scans.operations.lock().map_err(error)?;
                if store.scans.generation.load(Ordering::SeqCst) != op.generation {
                    return Err(UserMessage::new(codes::CATALOG_SCAN_SUPERSEDED));
                }
                if op.cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let pending = store.pending_file_paths()?;
                for ((source, complete), path) in scopes.iter_mut().zip(scope_paths) {
                    let blocked = pending
                        .iter()
                        .any(|p| p.starts_with(&path) || path.starts_with(p));
                    if blocked {
                        for p in pending.iter().filter(|p| p.starts_with(&path)) {
                            store.preserve_deferred(&id, expected, source, p)?;
                        }
                    }
                    if *complete && (!path.is_dir() || blocked) {
                        *complete = false;
                        source_health
                            .lock()
                            .map_err(error)?
                            .insert(source.clone(), false);
                        let mut p = op.progress.lock().map_err(error)?;
                        p.roots.completed = p.roots.completed.saturating_sub(1);
                        p.roots.failed += 1;
                        p.unvisited_extent_unknown = true;
                    }
                }
                let _analysis = super::writes::shared().analysis_guard();
                let revision = if retry_paths.is_some() {
                    op.progress.lock().map_err(error)?.catalogue_revision
                } else {
                    store.finalize_scan(&id, expected, &scopes)?
                };
                let mut p = op.progress.lock().map_err(error)?;
                p.catalogue_changed |= revision != p.catalogue_revision;
                p.catalogue_revision = revision;
                p.scan_complete = p.discovery_complete
                    && p.roots.failed == 0
                    && p.candidates.processed == p.candidates.discovered;
                op.published.store(true, Ordering::SeqCst);
                Ok(())
            };
            let result = run();
            let completed_without_failure = result.is_ok();
            drop(heartbeat_stop);
            let _ = beat.join();
            if let Ok(mut p) = op.progress.lock() {
                p.status = if op.cancel.load(Ordering::Relaxed) {
                    "cancelled"
                } else if result.is_err() {
                    "failed"
                } else if p.scan_complete && p.outcomes.error == 0 {
                    "success"
                } else {
                    "partial"
                }
                .into();
                p.outcomes.not_processed = p
                    .candidates
                    .discovered
                    .saturating_sub(p.candidates.processed);
                if let Err(reason) = result {
                    let superseded = reason.code == codes::CATALOG_SCAN_SUPERSEDED;
                    p.error = Some(if superseded {
                        reason
                    } else {
                        UserMessage::new(codes::CATALOG_OPERATION_FAILED)
                            .with_detail(reason.to_string())
                    });
                    p.reasons.push(Reason {
                        reason: if superseded {
                            "scanSuperseded"
                        } else {
                            "operationFailed"
                        }
                        .into(),
                        outcome: "operation".into(),
                        count: 1,
                    });
                }
            }
            if retry_paths.is_none() {
                if let Ok(p) = op.progress.lock() {
                    let _ = store.write(|tx| {
                        let health = source_health.lock().map_err(error)?;
                        let access = source_access.lock().map_err(error)?;
                        for source in &health_sources {
                            let complete = completed_without_failure && op.published.load(Ordering::SeqCst) && !op.cancel.load(Ordering::Relaxed) && health.get(source) == Some(&true);
                            let status = if matches!(p.status.as_str(), "failed" | "cancelled") { p.status.as_str() } else if complete { "success" } else { "partial" };
                            tx.execute("INSERT INTO source_health(source_id,last_scan_at,last_scan_status,availability) VALUES (?1,?2,?3,?4) ON CONFLICT(source_id) DO UPDATE SET last_scan_at=coalesce(excluded.last_scan_at,source_health.last_scan_at),last_scan_status=excluded.last_scan_status,availability=CASE WHEN excluded.availability='unknown' THEN source_health.availability ELSE excluded.availability END",
                                rusqlite::params![source, complete.then_some(stamp() as i64), status, access.get(source).copied().unwrap_or("unknown")]).map_err(error)?;
                        }
                        Ok(())
                    });
                }
            }
            op.emit(&sink, true);
            store.download_lunii_covers(sink.clone());
        });
        Ok(Receipt {
            operation_id: op_id(self, &request_id)?,
            request_id,
            sources_revision: expected,
            catalogue_revision: list.catalogue_revision,
        })
    }
    pub fn get_operation(&self, id: &str) -> Result<Progress> {
        let operations = self.scans.operations.lock().map_err(error)?;
        let op = operations
            .get(id)
            .ok_or_else(|| UserMessage::new(codes::CATALOG_OPERATION_EXPIRED))?;
        let result = op.progress.lock().map_err(error)?.clone();
        Ok(result)
    }
    pub fn operation_page(
        &self,
        id: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<OperationPage> {
        self.filtered_operation_page(id, limit, cursor, false)
    }
    pub fn operation_issue_page(
        &self,
        id: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<OperationPage> {
        self.filtered_operation_page(id, limit, cursor, true)
    }
    fn filtered_operation_page(
        &self,
        id: &str,
        limit: usize,
        cursor: Option<&str>,
        issues_only: bool,
    ) -> Result<OperationPage> {
        let progress = self.get_operation(id)?;
        let offset = cursor
            .map(str::parse::<usize>)
            .transpose()
            .map_err(error)?
            .unwrap_or(0);
        let matches = |item: &&ReportItem| {
            !issues_only || matches!(item.outcome.as_str(), "refused" | "error" | "scopeError")
        };
        let total_matching = progress.report.iter().filter(matches).count();
        if offset > total_matching {
            return Err(error("invalidReportCursor"));
        }
        let items = progress
            .report
            .iter()
            .filter(matches)
            .skip(offset)
            .take(limit.clamp(1, 200))
            .cloned()
            .collect::<Vec<_>>();
        let next = offset + items.len();
        Ok(OperationPage {
            progress,
            items,
            total_matching,
            cursor: (next < total_matching).then(|| next.to_string()),
        })
    }
    pub fn cancel_operation(&self, id: &str) -> Result<Progress> {
        let operations = self.scans.operations.lock().map_err(error)?;
        let op = operations
            .get(id)
            .ok_or_else(|| UserMessage::new(codes::CATALOG_OPERATION_EXPIRED))?;
        let mut p = op.progress.lock().map_err(error)?;
        if matches!(p.status.as_str(), "queued" | "running") && !op.published.load(Ordering::SeqCst)
        {
            op.cancel.store(true, Ordering::SeqCst);
            p.status = "cancelling".into();
        }
        Ok(p.clone())
    }
}
fn op_id(store: &Store, request: &str) -> Result<String> {
    store
        .scans
        .operations
        .lock()
        .map_err(error)?
        .iter()
        .find_map(|(id, op)| {
            op.progress
                .lock()
                .ok()
                .filter(|p| p.request_id == request)
                .map(|_| id.clone())
        })
        .ok_or_else(|| UserMessage::new(codes::CATALOG_OPERATION_EXPIRED))
}

/// A watcher refresh uses the same session reports and cancellation contract.
/// Own, already-settled writes do not create these user-facing operations.
pub(crate) struct AutomaticRefresh {
    op: Arc<Operation>,
    sink: Sink,
}
impl AutomaticRefresh {
    pub fn cancelled(&self) -> bool {
        self.op.cancel.load(Ordering::Relaxed)
    }
    pub fn update(&self, update: impl FnOnce(&mut Progress)) {
        if let Ok(mut p) = self.op.progress.lock() {
            update(&mut p);
        }
        self.op.emit_throttled(&self.sink);
    }
    pub fn finish(&self, result: &super::Result<super::refresh::Refreshed>) {
        if let Ok(mut p) = self.op.progress.lock() {
            p.phase = "finalization".into();
            p.discovery_complete = result.as_ref().is_ok_and(|r| r.retry.is_empty())
                && !self.cancelled()
                && p.roots.failed == 0;
            p.candidates.total = p.discovery_complete.then_some(p.candidates.discovered);
            p.outcomes.not_processed = p
                .candidates
                .discovered
                .saturating_sub(p.candidates.processed);
            p.scan_complete = result.as_ref().is_ok_and(|r| r.retry.is_empty())
                && !self.cancelled()
                && p.roots.failed == 0;
            p.unvisited_extent_unknown = !p.discovery_complete;
            p.roots.completed = u64::from(p.scan_complete);
            p.status = if self.cancelled() {
                "cancelled"
            } else if result.is_err() {
                "failed"
            } else if !p.scan_complete || p.outcomes.error > 0 {
                "partial"
            } else {
                "success"
            }
            .into();
            match result {
                Ok(r) => {
                    p.catalogue_revision = r.revision;
                    p.catalogue_changed = r.changed;
                }
                Err(e) => {
                    p.error = Some(e.clone());
                }
            }
        }
        self.op.emit(&self.sink, true);
    }
}
impl Store {
    /// Installs reporting without creating a scan or doing any pack I/O.
    pub(super) fn set_operation_sink(&self, sink: Sink) -> Result<()> {
        *self.scans.sink.lock().map_err(error)? = Some(sink);
        Ok(())
    }
    pub(super) fn reports_automatic_refresh(&self) -> Result<bool> {
        Ok(self.scans.sink.lock().map_err(error)?.is_some())
    }
    pub(crate) fn begin_automatic_refresh(
        &self,
        source: &super::refresh::Root,
        total: usize,
    ) -> Result<Option<AutomaticRefresh>> {
        let Some(sink) = self.scans.sink.lock().map_err(error)?.clone() else {
            return Ok(None);
        };
        let revision =
            self.read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))?;
        let sources_revision = self.sources_revision()?;
        let id = uuid::Uuid::new_v4().to_string();
        let op = Arc::new(Operation {
            source_ids: vec![source.source_id.clone()],
            cancel: Arc::new(AtomicBool::new(false)),
            published: AtomicBool::new(false),
            started: AtomicBool::new(false),
            generation: 0,
            last_emit: Mutex::new(None),
            progress: Mutex::new(Progress {
                result: None,
                operation_id: id.clone(),
                request_id: format!("automatic-{id}"),
                sequence: 0,
                timestamp: stamp(),
                catalogue_revision: revision,
                sources_revision,
                status: "running".into(),
                phase: "analysis".into(),
                current_source_id: Some(source.source_id.clone()),
                current_directory: Some(crate::support::paths::path_for_frontend(&source.path)),
                roots: Roots {
                    total: 1,
                    ..Default::default()
                },
                candidates: Candidates {
                    discovered: total as u64,
                    ..Default::default()
                },
                ..Default::default()
            }),
        });
        let mut operations = self.scans.operations.lock().map_err(error)?;
        if operations.len() >= 32 {
            let oldest = operations
                .iter()
                .filter_map(|(id, op)| {
                    op.progress
                        .lock()
                        .ok()
                        .filter(|p| {
                            matches!(
                                p.status.as_str(),
                                "success" | "partial" | "failed" | "cancelled"
                            )
                        })
                        .map(|p| (p.timestamp, id.clone()))
                })
                .min();
            if let Some((_, id)) = oldest {
                operations.remove(&id);
            } else {
                return Ok(None);
            }
        }
        operations.insert(id, Arc::clone(&op));
        drop(operations);
        op.emit(&sink, false);
        Ok(Some(AutomaticRefresh { op, sink }))
    }
}

// File mutations share cancellation, paged reports and events with scans.
impl Store {
    pub(crate) fn begin_file_report(
        &self,
        request: &str,
        kind: &str,
        total: usize,
        sink: Sink,
    ) -> Result<(Receipt, Arc<Operation>)> {
        self.begin_named_file_report(uuid::Uuid::new_v4().to_string(), request, kind, total, sink)
    }
    fn begin_named_file_report(
        &self,
        id: String,
        request: &str,
        kind: &str,
        total: usize,
        sink: Sink,
    ) -> Result<(Receipt, Arc<Operation>)> {
        let sources = self.all_sources()?;
        let op = Arc::new(Operation {
            source_ids: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            published: AtomicBool::new(false),
            started: AtomicBool::new(false),
            generation: 0,
            last_emit: Mutex::new(None),
            progress: Mutex::new(Progress {
                result: None,
                operation_kind: Some(kind.into()),
                operation_id: id.clone(),
                request_id: request.into(),
                catalogue_revision: sources.catalogue_revision,
                sources_revision: sources.sources_revision,
                status: "queued".into(),
                phase: "analysis".into(),
                discovery_complete: true,
                unvisited_extent_unknown: false,
                candidates: Candidates {
                    discovered: total as u64,
                    total: Some(total as u64),
                    ..Default::default()
                },
                ..Default::default()
            }),
        });
        let mut operations = self.scans.operations.lock().map_err(error)?;
        if operations.len() >= 32 {
            let oldest = operations
                .iter()
                .filter_map(|(id, o)| {
                    o.progress
                        .lock()
                        .ok()
                        .filter(|p| {
                            matches!(
                                p.status.as_str(),
                                "success" | "failed" | "partial" | "cancelled"
                            )
                        })
                        .map(|p| (p.timestamp, id.clone()))
                })
                .min();
            if let Some((_, id)) = oldest {
                operations.remove(&id);
            } else {
                return Err(UserMessage::new(codes::CATALOG_STORE_ERROR));
            }
        }
        operations.insert(id.clone(), Arc::clone(&op));
        drop(operations);
        op.emit(&sink, false);
        Ok((
            Receipt {
                operation_id: id,
                request_id: request.into(),
                sources_revision: sources.sources_revision,
                catalogue_revision: sources.catalogue_revision,
            },
            op,
        ))
    }
    pub(crate) fn update_file_report(
        &self,
        op: &Operation,
        sink: &Sink,
        f: impl FnOnce(&mut Progress),
    ) {
        if let Ok(mut p) = op.progress.lock() {
            f(&mut p);
        }
        op.emit(sink, false);
    }
    pub(crate) fn finish_file_report(
        op: &Operation,
        sink: &Sink,
        result: Result<()>,
        revision: i64,
        cancelled: bool,
    ) {
        if let Ok(mut p) = op.progress.lock() {
            p.phase = "finalization".into();
            p.catalogue_changed = revision != p.catalogue_revision;
            p.catalogue_revision = revision;
            p.scan_complete = result.is_ok();
            p.status = if cancelled {
                "cancelled"
            } else if result.is_err() && p.outcomes.updated > 0 {
                "partial"
            } else if result.is_err() {
                "failed"
            } else {
                "success"
            }
            .into();
            if let Err(e) = result {
                p.error = Some(e.clone());
                if p.outcomes.error == 0 {
                    p.outcomes.error += 1;
                    let path = p.current_directory.clone().unwrap_or_default();
                    p.report.push(ReportItem {
                        path,
                        member: None,
                        outcome: "error".into(),
                        reason: Some(e.code.clone()),
                        detail: serde_json::to_string(&e).ok(),
                    });
                    p.candidates.processed += 1;
                }
            }
            p.outcomes.not_processed = p
                .candidates
                .discovered
                .saturating_sub(p.candidates.processed);
        }
        op.emit(sink, true);
    }
}

impl Store {
    /// A send shares cancellation, snapshots and history with catalogue scans.
    pub(crate) fn begin_lunii_send(
        &self,
        request_id: String,
        total: usize,
        sink: Sink,
    ) -> Result<Arc<Operation>> {
        self.begin_lunii_transfer(request_id, total, sink, "luniiSend")
    }
    pub(crate) fn begin_lunii_transfer(
        &self,
        request_id: String,
        total: usize,
        sink: Sink,
        kind: &str,
    ) -> Result<Arc<Operation>> {
        let mut operations = self.scans.operations.lock().map_err(error)?;
        if let Some(op) = operations
            .values()
            .find(|op| op.progress.lock().is_ok_and(|p| p.request_id == request_id))
        {
            return Ok(Arc::clone(op));
        }
        let revision =
            self.read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))?;
        let op = Arc::new(Operation {
            source_ids: vec![],
            cancel: Arc::new(AtomicBool::new(false)),
            published: AtomicBool::new(false),
            started: AtomicBool::new(false),
            generation: 0,
            last_emit: Mutex::new(None),
            progress: Mutex::new(Progress {
                operation_kind: Some(kind.into()),
                operation_id: uuid::Uuid::new_v4().to_string(),
                request_id,
                timestamp: stamp(),
                catalogue_revision: revision,
                sources_revision: self.sources_revision()?,
                status: "running".into(),
                phase: "preparing".into(),
                discovery_complete: true,
                candidates: Candidates {
                    total: Some(total as u64),
                    discovered: total as u64,
                    ..Default::default()
                },
                ..Default::default()
            }),
        });
        let id = op.progress.lock().map_err(error)?.operation_id.clone();
        if operations.len() >= 32 {
            let oldest = operations
                .iter()
                .filter_map(|(id, o)| {
                    o.progress
                        .lock()
                        .ok()
                        .filter(|p| p.status != "running")
                        .map(|p| (id.clone(), p.timestamp))
                })
                .min_by_key(|(_, t)| *t);
            if let Some((id, _)) = oldest {
                operations.remove(&id);
            }
        }
        operations.insert(id, Arc::clone(&op));
        drop(operations);
        self.set_operation_sink(sink)?;
        Ok(op)
    }
}
