//! Watching of the active sources.
//!
//! - Native notifications (inotify, FSEvents, ReadDirectoryChanges) through the
//!   full debouncer, which merges bursts and pairs renames; network volumes,
//!   unavailable or failing native watchers fall back to periodic polling.
//! - Touched paths are grouped per source (`batch`), checked against the
//!   registry of the application's own writes (`super::writes`), then only
//!   their units are refreshed (`super::refresh`): no full rescan.
//! - Lost events are never trusted away: a queue overflow, a rescan request
//!   from the native layer, a watcher failure, a wake-up after suspension, a
//!   returning volume and a periodic safety net all trigger a reconciliation of
//!   the source concerned (listing compared with sizes, dates, file identities).
//! - Background refreshes publish silently: no operation report, only a
//!   `catalogue-changed` notification when the index actually changed.
mod batch;
mod volume;

use super::{
    probe,
    refresh::{resolve_existing, ActivitySnapshot, Change, Root},
    sources::Exclusions,
    store::Store,
    writes::{Notice, Registry, Verdict},
};
use notify_debouncer_full::{
    new_debouncer_opt,
    notify::{self, event::ModifyKind, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer, NoCache, RecommendedCache,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Initial, unmeasured parameters; the debouncer delay plus the quiet interval
/// stay within the 750 ms processing target.
#[derive(Clone, Debug)]
pub struct Config {
    pub debounce: Duration,
    pub quiet: Duration,
    pub max_delay: Duration,
    pub stability: Duration,
    pub poll_interval: Duration,
    pub reconcile_local: Duration,
    pub reconcile_degraded: Duration,
    pub capacity: usize,
    pub tick: Duration,
    pub wake_gap: Duration,
    pub max_attempts: u32,
    /// Watch every source by polling (a user choice for unreliable volumes).
    pub force_polling: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(400),
            quiet: Duration::from_millis(350),
            max_delay: Duration::from_secs(5),
            stability: Duration::from_secs(1),
            poll_interval: Duration::from_secs(10),
            reconcile_local: Duration::from_secs(15 * 60),
            reconcile_degraded: Duration::from_secs(5 * 60),
            capacity: 4096,
            tick: Duration::from_millis(200),
            wake_gap: Duration::from_secs(60),
            max_attempts: 20,
            force_polling: false,
        }
    }
}

/// Called with the new catalogue revision after a background change.
pub type ChangeSink = Arc<dyn Fn(i64) + Send + Sync>;

enum Input {
    Events {
        source: String,
        changes: Vec<(PathBuf, bool)>,
    },
    Rescan(String),
    Failure {
        source: String,
        degrade: bool,
        detail: String,
    },
    Own(Notice),
    SourcesChanged,
    #[cfg(test)]
    Wake,
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Native,
    Polling,
    Unavailable,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::Native => "native",
            Mode::Polling => "polling",
            Mode::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWatch {
    pub source_id: String,
    pub path: String,
    pub mode: String,
    pub reason: Option<String>,
    pub pending: usize,
    pub last_reconciled_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub running: bool,
    pub sources: Vec<SourceWatch>,
    pub activity: ActivitySnapshot,
}

/// The native handle; dropping it stops the notifications of its source.
#[allow(dead_code)] // Held for its lifetime only.
enum Handle {
    Native(Debouncer<RecommendedWatcher, RecommendedCache>),
    Polling(Debouncer<PollWatcher, NoCache>),
}

struct Watched {
    root: Root,
    native_path: PathBuf,
    handle: Option<Handle>,
    mode: Mode,
    reason: Option<&'static str>,
    reconcile: bool,
    next_reconcile: Instant,
    next_probe: Instant,
    last_reconciled: Option<u64>,
}

pub struct Service {
    sender: Sender<Input>,
    worker: Option<JoinHandle<()>>,
    status: Arc<Mutex<Vec<SourceWatch>>>,
    store: Arc<Store>,
    stopped: Arc<AtomicBool>,
}

impl Service {
    /// Installs the watchers of the active sources, then reconciles them
    /// (events arriving meanwhile are retained and replayed).
    pub fn start(
        store: Arc<Store>,
        registry: &'static Registry,
        cache: PathBuf,
        data: PathBuf,
        config: Config,
        sink: ChangeSink,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = channel();
        registry.bind_store(&store);
        let own = sender.clone();
        let receipt_store = Arc::clone(&store);
        registry.set_listener(Some(Box::new(move |notice| {
            if let Notice::Saved { attestations, .. } = &notice {
                if let Err(error) = receipt_store.record_save_receipts(attestations) {
                    log::warn!(target: "catalogue_watch", "cannot persist save receipt: {error}");
                }
            }
            let _ = own.send(Input::Own(notice));
        })));
        let status = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            grouper: batch::Grouper::new(config.quiet, config.max_delay, config.capacity),
            store: Arc::clone(&store),
            registry,
            cache,
            data,
            sender: sender.clone(),
            sink,
            next_trash_check: Instant::now(),
            watched: Vec::new(),
            own: Vec::new(),
            status: Arc::clone(&status),
            stopped: Arc::clone(&stopped),
            config,
        };
        let worker = std::thread::Builder::new()
            .name("catalogue-watch".into())
            .spawn(move || worker.run(receiver))?;
        Ok(Self {
            sender,
            worker: Some(worker),
            status,
            store,
            stopped,
        })
    }

    /// Sources were added, removed or changed: install or drop watchers.
    pub fn sources_changed(&self) {
        let _ = self.sender.send(Input::SourcesChanged);
    }

    /// Same effect as a detected wake-up: reconcile every source.
    #[cfg(test)]
    pub fn wake(&self) {
        let _ = self.sender.send(Input::Wake);
    }

    pub fn status(&self) -> WatchStatus {
        WatchStatus {
            running: !self.stopped.load(Ordering::Relaxed),
            sources: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
            activity: self.store.activity.snapshot(),
        }
    }

    /// Stops the watchers and waits for the current refresh to end.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.sender.send(Input::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// `Some(structural)` for events that matter; access events are ignored.
fn relevance(kind: &EventKind) -> Option<bool> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Modify(ModifyKind::Name(_)) => Some(true),
        EventKind::Modify(_) => Some(false),
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any | EventKind::Other => {
            Some(true)
        }
    }
}

fn handler(sender: Sender<Input>, source: String) -> impl FnMut(DebounceEventResult) + Send {
    move |result| match result {
        Ok(events) => {
            if events.iter().any(|event| event.need_rescan()) {
                let _ = sender.send(Input::Rescan(source.clone()));
            }
            let changes: Vec<(PathBuf, bool)> = events
                .iter()
                .filter_map(|event| relevance(&event.kind).map(|s| (event, s)))
                .flat_map(|(event, structural)| {
                    event
                        .paths
                        .iter()
                        .map(move |path| (path.clone(), structural))
                })
                .collect();
            if !changes.is_empty() {
                let _ = sender.send(Input::Events {
                    source: source.clone(),
                    changes,
                });
            }
        }
        Err(errors) => {
            let degrade = errors.iter().any(|error| {
                matches!(
                    error.kind,
                    notify::ErrorKind::MaxFilesWatch | notify::ErrorKind::WatchNotFound
                )
            });
            let detail = errors
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ");
            let _ = sender.send(Input::Failure {
                source: source.clone(),
                degrade,
                detail,
            });
        }
    }
}

struct Worker {
    store: Arc<Store>,
    registry: &'static Registry,
    cache: PathBuf,
    data: PathBuf,
    sender: Sender<Input>,
    sink: ChangeSink,
    config: Config,
    grouper: batch::Grouper,
    next_trash_check: Instant,
    watched: Vec<Watched>,
    own: Vec<PathBuf>,
    status: Arc<Mutex<Vec<SourceWatch>>>,
    stopped: Arc<AtomicBool>,
}

impl Worker {
    fn run(mut self, receiver: Receiver<Input>) {
        self.sync_sources();
        let mut last_wall = SystemTime::now();
        let mut last_instant = Instant::now();
        'main: loop {
            let mut inputs = Vec::new();
            match receiver.recv_timeout(self.config.tick) {
                Ok(input) => inputs.push(input),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            inputs.extend(receiver.try_iter());
            let now = Instant::now();
            for input in inputs {
                if !self.accept(input, now) {
                    break 'main;
                }
            }
            // A wall-clock jump much larger than the monotonic one means the
            // machine slept: notifications may have been lost meanwhile.
            let wall = SystemTime::now();
            let wall_gap = wall.duration_since(last_wall).unwrap_or_default();
            if wall_gap > now.duration_since(last_instant) + self.config.wake_gap {
                log::info!(target: "catalogue_watch", "wake-up detected, reconciling");
                self.watched.iter_mut().for_each(|w| w.reconcile = true);
            }
            last_wall = wall;
            last_instant = now;
            self.registry.sweep(now);
            self.process(now);
            self.publish_status();
        }
        self.registry.set_listener(None);
        self.watched.clear();
        self.stopped.store(true, Ordering::SeqCst);
        self.publish_status();
    }

    fn accept(&mut self, input: Input, now: Instant) -> bool {
        match input {
            Input::Events { source, changes } => {
                for (path, structural) in changes {
                    if structural {
                        if let Some(watched) = self.watched.iter_mut().find(|w| {
                            w.root.source_id == source
                                && (path == w.native_path || resolve_existing(&path) == w.root.path)
                        }) {
                            // Removal/replacement of the watched root invalidates
                            // native handles even if it already exists again.
                            watched.handle = None;
                            watched.mode = Mode::Unavailable;
                            watched.reason = Some("volumeUnavailable");
                            watched.reconcile = true;
                            watched.next_probe = now;
                        }
                    }
                    self.grouper.push(&source, path, structural, now);
                }
            }
            Input::Rescan(source) => self.request_reconcile(&source),
            Input::Failure {
                source,
                degrade,
                detail,
            } => {
                log::warn!(target: "catalogue_watch", "watcher error on {source}: {detail}");
                self.request_reconcile(&source);
                if degrade {
                    if let Some(index) =
                        self.watched.iter().position(|w| w.root.source_id == source)
                    {
                        if self.watched[index].mode == Mode::Native {
                            self.install(index, Some("nativeFailed"));
                        }
                    }
                }
            }
            Input::Own(Notice::Committed(paths)) => self.own.extend(paths),
            Input::Own(Notice::Saved { paths, .. }) => self.own.extend(paths),
            Input::Own(Notice::Released(paths)) => {
                for path in paths {
                    if let Some(index) = self.locate(&path) {
                        let source = self.watched[index].root.source_id.clone();
                        self.grouper.push(&source, path, true, now);
                    }
                }
            }
            Input::SourcesChanged => self.sync_sources(),
            #[cfg(test)]
            Input::Wake => self.watched.iter_mut().for_each(|w| w.reconcile = true),
            Input::Stop => return false,
        }
        true
    }

    fn request_reconcile(&mut self, source: &str) {
        if let Some(watched) = self.watched.iter_mut().find(|w| w.root.source_id == source) {
            watched.reconcile = true;
        }
    }

    /// The watched source containing a path (the deepest root).
    fn locate(&self, path: &std::path::Path) -> Option<usize> {
        let resolved = resolve_existing(path);
        self.watched
            .iter()
            .enumerate()
            .filter(|(_, w)| resolved.starts_with(&w.root.path) || path.starts_with(&w.native_path))
            .max_by_key(|(_, w)| w.root.path.components().count())
            .map(|(index, _)| index)
    }

    /// Watches the outermost active sources; a nested source is covered by
    /// its parent, exactly as for a scan.
    fn sync_sources(&mut self) {
        let list = match self.store.all_sources() {
            Ok(list) => list,
            Err(error) => {
                log::warn!(target: "catalogue_watch", "sources unavailable: {error}");
                return;
            }
        };
        let roots: Vec<_> = list
            .items
            .into_iter()
            .filter(|s| s.status == "active" && s.included_in.is_none())
            .collect();
        self.watched.retain(|w| {
            roots
                .iter()
                .any(|s| s.id == w.root.source_id && s.native_path == w.native_path)
        });
        for source in roots {
            if self.watched.iter().any(|w| w.root.source_id == source.id) {
                continue;
            }
            let now = Instant::now();
            self.watched.push(Watched {
                root: Root {
                    source_id: source.id.clone(),
                    // Persisted resolution; `install` refreshes it (bounded).
                    path: source.resolved_path.clone(),
                },
                native_path: source.native_path.clone(),
                handle: None,
                mode: Mode::Unavailable,
                reason: None,
                reconcile: true,
                next_reconcile: now + self.config.reconcile_local,
                next_probe: now,
                last_reconciled: None,
            });
            let index = self.watched.len() - 1;
            self.install(index, None);
        }
    }

    /// Native watching for a local volume, polling for a network volume, a
    /// forced choice or a native failure; nothing while the root is absent.
    fn install(&mut self, index: usize, failure: Option<&'static str>) {
        let sender = self.sender.clone();
        let config = self.config.clone();
        let watched = &mut self.watched[index];
        watched.handle = None;
        let native_path = watched.native_path.clone();
        if let Some(resolved) =
            probe::bounded(&watched.native_path, probe::PROBE_TIMEOUT, move || {
                resolve_existing(&native_path)
            })
        {
            watched.root.path = resolved;
        }
        if probe::is_dir(&watched.native_path) != Some(true) {
            watched.mode = Mode::Unavailable;
            watched.reason = Some("volumeUnavailable");
            return;
        }
        let source = watched.root.source_id.clone();
        // A volume that does not answer is treated as a network one.
        let network = |root: &std::path::Path| {
            let owned = root.to_owned();
            probe::bounded(root, probe::PROBE_TIMEOUT, move || {
                volume::is_network(&owned)
            })
            .unwrap_or(true)
        };
        let polling_reason = if failure.is_some() {
            failure
        } else if config.force_polling {
            Some("pollingChosen")
        } else if network(&watched.root.path) {
            Some("networkVolume")
        } else {
            None
        };
        if polling_reason.is_none() {
            let native = new_debouncer_opt::<_, RecommendedWatcher, RecommendedCache>(
                config.debounce,
                None,
                handler(sender.clone(), source.clone()),
                RecommendedCache::new(),
                notify::Config::default(),
            )
            .and_then(|mut debouncer| {
                debouncer.watch(&watched.native_path, RecursiveMode::Recursive)?;
                Ok(debouncer)
            });
            match native {
                Ok(debouncer) => {
                    watched.handle = Some(Handle::Native(debouncer));
                    watched.mode = Mode::Native;
                    watched.reason = None;
                    return;
                }
                Err(error) => {
                    log::warn!(target: "catalogue_watch",
                        "native watching unavailable for {source}, polling instead: {error}");
                }
            }
        }
        let polling = new_debouncer_opt::<_, PollWatcher, NoCache>(
            config.debounce,
            None,
            handler(sender, source.clone()),
            NoCache::new(),
            notify::Config::default().with_poll_interval(config.poll_interval),
        )
        .and_then(|mut debouncer| {
            debouncer.watch(&watched.native_path, RecursiveMode::Recursive)?;
            Ok(debouncer)
        });
        match polling {
            Ok(debouncer) => {
                watched.handle = Some(Handle::Polling(debouncer));
                watched.mode = Mode::Polling;
                watched.reason = polling_reason.or(Some("nativeUnavailable"));
                watched.next_reconcile = watched
                    .next_reconcile
                    .min(Instant::now() + config.reconcile_degraded);
            }
            Err(error) => {
                log::warn!(target: "catalogue_watch", "cannot watch {source}: {error}");
                watched.mode = Mode::Unavailable;
                watched.reason = Some("watchFailed");
            }
        }
    }

    fn interval(&self, mode: Mode) -> Duration {
        if mode == Mode::Native {
            self.config.reconcile_local
        } else {
            self.config.reconcile_degraded
        }
    }

    fn process(&mut self, now: Instant) {
        for index in 0..self.watched.len() {
            let watched = &mut self.watched[index];
            // Bounded probes: a dead mount must not freeze the watcher.
            if watched.mode != Mode::Unavailable
                && probe::is_dir(&watched.native_path) != Some(true)
            {
                watched.handle = None;
                watched.mode = Mode::Unavailable;
                watched.reason = Some("volumeUnavailable");
                watched.reconcile = true;
                watched.next_probe = now;
            }
            if watched.mode == Mode::Unavailable && now >= watched.next_probe {
                watched.next_probe = now + self.config.poll_interval;
                if probe::is_dir(&watched.native_path) == Some(true) {
                    // The source came back: watch it again and reconcile.
                    watched.reconcile = true;
                    self.install(index, None);
                }
            }
            let watched = &mut self.watched[index];
            if now >= watched.next_reconcile {
                watched.reconcile = true;
            }
        }
        for source in self.grouper.take_overflowed() {
            log::info!(target: "catalogue_watch", "event queue overflow on {source}, reconciling");
            self.request_reconcile(&source);
        }
        let store = Arc::clone(&self.store);
        // One heavy job at a time: while an explicit scan runs, everything
        // stays queued and is replayed afterwards.
        let Ok(_heavy) = store.scans.heavy.try_lock() else {
            return;
        };
        let exclusions = match store.exclusions(&self.cache, &self.data) {
            Ok(exclusions) => exclusions,
            Err(error) => {
                log::warn!(target: "catalogue_watch", "exclusions unavailable: {error}");
                return;
            }
        };
        let mut revision = None;
        if now >= self.next_trash_check {
            self.next_trash_check = now + self.config.poll_interval;
            match store.reconcile_trash_retention() {
                Ok(changed) => revision = changed,
                Err(reason) => log::warn!(target: "catalogue_watch", "trash retention: {reason}"),
            }
            if store.retry_removal_purges() {
                match store
                    .read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))
                {
                    Ok(current) => revision = Some(current),
                    Err(reason) => {
                        log::warn!(target: "catalogue_watch", "trash purge revision: {reason}")
                    }
                }
            }
        }
        self.publish_own(&exclusions, &mut revision);
        self.reconcile_due(now, &exclusions, &mut revision);
        self.refresh_ready(now, &exclusions, &mut revision);
        if let Some(revision) = revision {
            (self.sink)(revision);
        }
    }

    /// Files of committed own writes: published at once, without waiting
    /// for (or depending on) a native event.
    fn publish_own(&mut self, exclusions: &Exclusions, revision: &mut Option<i64>) {
        let own = std::mem::take(&mut self.own);
        let mut groups: Vec<(usize, Vec<Change>)> = Vec::new();
        for path in own {
            let Some(index) = self.locate(&path) else {
                continue;
            };
            let change = Change {
                path,
                settled: true,
                structural: false,
            };
            match groups.iter_mut().find(|(i, _)| *i == index) {
                Some((_, changes)) => changes.push(change),
                None => groups.push((index, vec![change])),
            }
        }
        for (index, changes) in groups {
            let root = self.watched[index].root.clone();
            let cancel = &self.stopped;
            match self.store.refresh_paths(
                &root,
                &changes,
                exclusions,
                self.config.stability,
                cancel,
                self.registry,
            ) {
                Ok(result) => {
                    note(revision, &result);
                    self.watched[index].reconcile |= result.reconcile;
                    // Rewritten again meanwhile: examined like any change.
                    let source = self.watched[index].root.source_id.clone();
                    let now = Instant::now();
                    for path in result.retry {
                        self.grouper.push(&source, path, false, now);
                    }
                }
                Err(error) => {
                    log::warn!(target: "catalogue_watch", "own write publication failed: {error}");
                    self.watched[index].reconcile = true;
                }
            }
        }
    }

    fn reconcile_due(&mut self, now: Instant, exclusions: &Exclusions, revision: &mut Option<i64>) {
        for index in 0..self.watched.len() {
            if !self.watched[index].reconcile {
                continue;
            }
            let root = self.watched[index].root.clone();
            let registry = self.registry;
            let result = self.store.reconcile_source(
                &root,
                exclusions,
                self.config.stability,
                &self.stopped,
                &|path| registry.classify(path, now) == Verdict::Deferred,
                registry,
            );
            let interval = self.interval(self.watched[index].mode);
            let watched = &mut self.watched[index];
            watched.reconcile = false;
            match result {
                Ok(result) => {
                    self.grouper.clear(&root.source_id);
                    // Owned by a write still running: examined again once it
                    // is finished, like any other change.
                    for path in &result.deferred {
                        self.grouper.push(&root.source_id, path.clone(), false, now);
                    }
                    watched.next_reconcile = now + interval;
                    watched.last_reconciled = Some(now_ms());
                    note(revision, &result);
                }
                Err(error) => {
                    log::warn!(target: "catalogue_watch", "reconciliation failed: {error}");
                    watched.next_reconcile = now + interval.min(Duration::from_secs(30));
                }
            }
        }
    }

    fn refresh_ready(&mut self, now: Instant, exclusions: &Exclusions, revision: &mut Option<i64>) {
        for (source, pending) in self.grouper.take_ready(now) {
            let Some(index) = self.watched.iter().position(|w| w.root.source_id == source) else {
                continue;
            };
            let mut changes = Vec::new();
            for item in pending {
                let resolved = resolve_existing(&item.path);
                match exclusions.classify(&item.path, Some(&resolved)) {
                    Ok(Some(_)) => continue,
                    Err(()) => {
                        // An inconclusive probe is not an exclusion. Keep the
                        // event until a later pass can classify it.
                        self.grouper.retry(&source, item, now);
                        continue;
                    }
                    Ok(None) => {}
                }
                match self.registry.classify(&item.path, now) {
                    Verdict::Deferred => {
                        self.grouper.retry(&source, item, now);
                    }
                    Verdict::Absorbed => {
                        self.store.activity.absorbed.fetch_add(1, Ordering::Relaxed);
                    }
                    Verdict::External => changes.push(item),
                }
            }
            if changes.is_empty() {
                continue;
            }
            let root = self.watched[index].root.clone();
            let requests: Vec<Change> = changes
                .iter()
                .map(|item| Change {
                    path: item.path.clone(),
                    settled: false,
                    structural: item.structural,
                })
                .collect();
            let result = self.store.refresh_paths(
                &root,
                &requests,
                exclusions,
                self.config.stability,
                &self.stopped,
                self.registry,
            );
            match result {
                Ok(result) => {
                    note(revision, &result);
                    self.watched[index].reconcile |= result.reconcile;
                    for path in &result.retry {
                        let item = changes.iter().find(|item| {
                            &item.path == path || resolve_existing(&item.path) == *path
                        });
                        let attempts = item.map_or(0, |item| item.attempts) + 1;
                        if attempts <= self.config.max_attempts {
                            let retry = batch::Pending {
                                path: path.clone(),
                                structural: item.is_some_and(|item| item.structural),
                                attempts,
                            };
                            self.grouper.retry(&source, retry, now);
                        } else {
                            self.watched[index].reconcile = true;
                            // Still changing after every attempt: the last
                            // published data stays; the next reconciliation
                            // looks at it again.
                            log::info!(target: "catalogue_watch",
                                "file still unstable, left to reconciliation: {}", path.display());
                        }
                    }
                }
                Err(error) => {
                    log::warn!(target: "catalogue_watch", "targeted refresh failed: {error}");
                    self.watched[index].reconcile = true;
                }
            }
        }
    }

    fn publish_status(&self) {
        let sources = self
            .watched
            .iter()
            .map(|w| SourceWatch {
                source_id: w.root.source_id.clone(),
                path: crate::support::paths::path_for_frontend(&w.native_path),
                mode: w.mode.name().into(),
                reason: w.reason.map(str::to_owned),
                pending: self.grouper.pending(&w.root.source_id),
                last_reconciled_at: w.last_reconciled,
            })
            .collect();
        if let Ok(mut status) = self.status.lock() {
            *status = sources;
        }
    }
}

fn note(revision: &mut Option<i64>, result: &super::refresh::Refreshed) {
    if result.changed {
        *revision = Some(revision.map_or(result.revision, |r| r.max(result.revision)));
    }
}

/// Exercises the debouncer output through the real handler, queue and refresh,
/// without installing a native watcher or scheduling a reconciliation.
#[cfg(test)]
pub(super) fn inject_events(
    store: Arc<Store>,
    registry: &'static Registry,
    cache: PathBuf,
    data: PathBuf,
    batches: Vec<Vec<notify::Event>>,
) -> usize {
    let source = store.all_sources().unwrap().items.remove(0);
    let now = Instant::now();
    let config = Config {
        quiet: Duration::ZERO,
        stability: Duration::ZERO,
        ..Config::default()
    };
    let (sender, receiver) = channel();
    let mut handler = handler(sender.clone(), source.id.clone());
    let mut worker = Worker {
        store,
        registry,
        cache,
        data,
        sender,
        sink: Arc::new(|_| {}),
        grouper: batch::Grouper::new(config.quiet, config.max_delay, config.capacity),
        next_trash_check: now + config.poll_interval,
        watched: vec![Watched {
            root: Root {
                source_id: source.id,
                path: source.resolved_path,
            },
            native_path: source.native_path,
            handle: None,
            mode: Mode::Native,
            reason: None,
            reconcile: false,
            next_reconcile: now + config.reconcile_local,
            next_probe: now,
            last_reconciled: None,
        }],
        own: Vec::new(),
        status: Arc::default(),
        stopped: Arc::default(),
        config,
    };
    for events in batches {
        let now = Instant::now();
        handler(Ok(events
            .into_iter()
            .map(|event| notify_debouncer_full::DebouncedEvent::new(event, now))
            .collect()));
        for input in receiver.try_iter() {
            assert!(worker.accept(input, now));
        }
        worker.process(now);
    }
    worker.grouper.pending(&worker.watched[0].root.source_id)
}

#[cfg(test)]
mod exclusion_retry_tests {
    use super::*;

    #[test]
    fn unknown_addition_is_retried_but_confirmed_exclusion_is_never_indexed() {
        let temp = std::env::temp_dir().join(format!("catalogue-excl3-{}", uuid::Uuid::new_v4()));
        let source = temp.join("source");
        let allowed = source.join("ordinary/voix-generees/new.mbah");
        let excluded = source.join("workspace/voix-generees/hidden.mbah");
        std::fs::create_dir_all(allowed.parent().unwrap()).unwrap();
        std::fs::create_dir_all(excluded.parent().unwrap()).unwrap();
        std::fs::create_dir_all(source.join("workspace/sauvegardes/versions-securite")).unwrap();
        for path in [&allowed, &excluded] {
            std::fs::write(
                path,
                r#"{"projectName":"Addition","packMetadata":{"title":"Addition"}}"#,
            )
            .unwrap();
        }
        let source = std::fs::canonicalize(source).unwrap();
        let allowed = std::fs::canonicalize(allowed).unwrap();
        let excluded = std::fs::canonicalize(excluded).unwrap();
        let store = Arc::new(Store::open(&temp.join("data"), &temp.join("cache")).unwrap());
        let id = store.add_source(&source, 0, false).unwrap().source_id;
        let now = Instant::now();
        let config = Config {
            quiet: Duration::ZERO,
            stability: Duration::ZERO,
            ..Config::default()
        };
        let mut worker = Worker {
            store: Arc::clone(&store),
            registry: Box::leak(Box::default()),
            cache: temp.join("cache"),
            data: temp.join("data"),
            sender: channel().0,
            sink: Arc::new(|_| {}),
            grouper: batch::Grouper::new(config.quiet, config.max_delay, config.capacity),
            config,
            next_trash_check: now,
            watched: vec![Watched {
                root: Root {
                    source_id: id.clone(),
                    path: source.clone(),
                },
                native_path: source.clone(),
                handle: None,
                mode: Mode::Unavailable,
                reason: None,
                reconcile: false,
                next_reconcile: now,
                next_probe: now,
                last_reconciled: None,
            }],
            own: Vec::new(),
            status: Arc::default(),
            stopped: Arc::default(),
        };
        let rules = store.exclusions(&worker.cache, &worker.data).unwrap();
        // Force exactly the cached outcome of an expired structure probe,
        // isolated to this pass and fixture (no global timing hook).
        rules
            .workspace_shapes
            .lock()
            .unwrap()
            .insert(source.join("ordinary"), None);
        assert!(rules.classify(&allowed, Some(&allowed)).is_err());
        assert!(matches!(
            rules.classify(&excluded, Some(&excluded)),
            Ok(Some(_))
        ));
        for path in [&allowed, &excluded] {
            worker.grouper.push(&id, path.clone(), true, now);
        }
        let mut revision = None;
        worker.refresh_ready(now, &rules, &mut revision);
        assert_eq!(worker.grouper.pending(&id), 1);
        assert!(revision.is_none());
        // The targeted refresh must also return the original event for retry
        // when the probe expires after the watcher's preliminary check.
        let result = store
            .refresh_paths(
                &worker.watched[0].root,
                &[Change {
                    path: allowed.clone(),
                    settled: false,
                    structural: true,
                }],
                &rules,
                Duration::ZERO,
                &worker.stopped,
                worker.registry,
            )
            .unwrap();
        assert_eq!(result.retry, vec![allowed.clone()]);
        assert_eq!(result.analysed, 0);
        // The next pass probes successfully; only the retained event is sent.
        let rules = store.exclusions(&worker.cache, &worker.data).unwrap();
        worker.refresh_ready(now + Duration::from_secs(1), &rules, &mut revision);
        assert_eq!(worker.grouper.pending(&id), 0);
        assert!(revision.is_some());
        let paths = store
            .read(|c| {
                c.prepare("SELECT json_extract(anchor_json,'$.path') FROM exemplar")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        assert_eq!(
            paths,
            vec![crate::support::paths::path_for_frontend(&allowed)]
        );
        let activity = store.activity.snapshot();
        assert_eq!(activity.full_scans, 0);
        assert_eq!(activity.reconciliations, 0);
        drop(worker);
        drop(store);
        std::fs::remove_dir_all(temp).unwrap();
    }
}
