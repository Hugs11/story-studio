//! Registry of the application's own writes.
//!
//! Every write the application performs in a place a catalogue source may
//! cover (project saves, pack generation, conversions, corrected archives) is
//! declared here **before** the first mutation, by the command or service that
//! writes. The watcher then recognises the resulting file-system events:
//!
//! - while an operation is active, events on its paths are deferred, never
//!   analysed against a half-written file; other paths are processed normally;
//! - a successful operation records the final state of each written file and
//!   publishes it at once (a targeted refresh), even if no native event ever
//!   arrives; the native events that follow are absorbed only while the file
//!   still has exactly that recorded state;
//! - a failed, abandoned or expired operation is released and its paths are
//!   reconciled: nothing stays masked indefinitely.
//!
//! The registry lives in memory: after a crash, the startup reconciliation
//! compares every source with the index again.
use crate::support::paths::{path_for_frontend, path_key};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant, SystemTime},
};

/// A finished operation stays recognisable this long (initial value).
pub const RETENTION: Duration = Duration::from_secs(30);
/// An operation never confirmed is released after this delay.
pub const EXPIRY: Duration = Duration::from_secs(30 * 60);

/// What the writer is about to touch. Every path is absolute; a renaming
/// writer declares both sides, a rotation declares its directory as subtree.
#[derive(Clone, Debug, Default)]
pub struct Declaration {
    pub kind: String,
    pub exact: Vec<PathBuf>,
    pub subtrees: Vec<PathBuf>,
    pub temporaries: Vec<PathBuf>,
    /// Shorter release delay for quick writers (a project save).
    pub expiry: Option<Duration>,
}

impl Declaration {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            ..Self::default()
        }
    }
    pub fn exact(mut self, path: impl Into<PathBuf>) -> Self {
        self.exact.push(path.into());
        self
    }
    pub fn subtree(mut self, path: impl Into<PathBuf>) -> Self {
        self.subtrees.push(path.into());
        self
    }
    pub fn temporary(mut self, path: impl Into<PathBuf>) -> Self {
        self.temporaries.push(path.into());
        self
    }
    pub fn expiring_after(mut self, delay: Duration) -> Self {
        self.expiry = Some(delay);
        self
    }
}

/// Size, modification time and file identity observed after the write. Size
/// and date are filters, not a proof of origin: the file identity changes when
/// another program replaces the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileState {
    size: u64,
    modified: Option<SystemTime>,
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_token: Option<String>,
}

impl FileState {
    pub fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            id: file_id(path),
            content_token: None,
        })
    }
    fn matches(&self, path: &Path) -> bool {
        let Some(mut actual) = Self::of(path) else {
            return false;
        };
        actual.content_token = self
            .content_token
            .as_ref()
            .and_then(|_| super::files::strong_token(path));
        &actual == self
    }
}

#[cfg(test)]
thread_local! {
    // FAT-style directory-entry identity: stable at a path, changes on move.
    pub(crate) static PATH_FILE_IDS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    // Only files holding data change identity on move (cluster-derived ids).
    pub(crate) static DATA_PATH_FILE_IDS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    // Remount: every native identity of the volume changes (Unix st_dev of a
    // replugged drive, FAT/exFAT inode renumbering), whatever the path.
    pub(crate) static REMOUNT_EPOCH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Portable file identity (inode, or volume serial and file index).
pub fn file_id(path: &Path) -> Option<String> {
    notify_debouncer_full::file_id::get_file_id(path)
        .ok()
        .map(|id| simulated(format!("{id:?}"), path))
}
#[cfg(not(test))]
fn simulated(id: String, _: &Path) -> String {
    id
}
#[cfg(test)]
fn simulated(id: String, path: &Path) -> String {
    let id = match REMOUNT_EPOCH.with(|v| v.get()) {
        0 => id,
        epoch => format!("{id}#remount{epoch}"),
    };
    if PATH_FILE_IDS.with(|v| v.get())
        || (DATA_PATH_FILE_IDS.with(|v| v.get())
            && std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0))
    {
        return format!("{id}@{:?}", super::path_identity::key(path));
    }
    id
}

/// Pre-write evidence that must match the catalogue's verified exemplar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavePrestate {
    pub token: String,
    pub file_id: Option<String>,
}
impl SavePrestate {
    fn of(path: &Path) -> Option<Self> {
        Some(Self {
            token: super::scan::token(path).ok()?.0,
            file_id: file_id(path),
        })
    }
}

/// Messages for the watcher, which publishes or reconciles the paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveAttestation {
    pub path: PathBuf,
    pub previous: SavePrestate,
    final_state: FileState,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Notice {
    /// Final files of a successful operation, to publish without waiting.
    Committed(Vec<PathBuf>),
    /// A project save carries its pre-write token and verified final state.
    Saved {
        paths: Vec<PathBuf>,
        attestations: Vec<SaveAttestation>,
    },
    /// Paths of a failed or expired operation, to reconcile.
    Released(Vec<PathBuf>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Not ours (or no longer identical to what we wrote): process normally.
    External,
    /// An active operation owns the path: retry once it is finished.
    Deferred,
    /// The event reflects our own committed write: nothing to do.
    Absorbed,
}

#[derive(Clone)]
enum State {
    Active,
    Committed {
        at: Instant,
        finals: Vec<(String, Option<FileState>)>,
    },
}

#[derive(Clone)]
struct Operation {
    previous: Vec<(String, Option<SavePrestate>)>,
    exact: Vec<String>,
    subtrees: Vec<String>,
    temporaries: Vec<String>,
    native_exact: Vec<PathBuf>,
    native_subtrees: Vec<PathBuf>,
    started: Instant,
    expiry: Duration,
    state: State,
}

impl Operation {
    fn owns(&self, key: &str) -> bool {
        self.exact.iter().any(|path| path == key)
            || self.temporaries.iter().any(|path| path == key)
            || self.subtrees.iter().any(|root| within(key, root))
    }
    fn released_paths(&self) -> Vec<PathBuf> {
        self.native_exact
            .iter()
            .chain(&self.native_subtrees)
            .cloned()
            .collect()
    }
}

pub type Listener = Box<dyn Fn(Notice) + Send>;

#[derive(Default)]
struct Inner {
    operations: HashMap<String, Operation>,
    saves: HashMap<String, SaveAttestation>,
    receipt_store: std::sync::Weak<super::store::Store>,
    listener: Option<Listener>,
}

pub struct Registry {
    inner: Mutex<Inner>,
    analysis: Mutex<()>,
    available: Condvar,
    retention: Duration,
    expiry: Duration,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new(RETENTION, EXPIRY)
    }
}

/// Comparison form shared with the front end (`pathKey`): portable
/// separators, case folded only for Windows paths. The existing part of the
/// path is resolved first, so a link or a relative segment gives the same key
/// as the canonical path the scanner stores.
pub fn comparison_key(path: &Path) -> String {
    #[cfg(test)]
    COMPARISON_KEY_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(path);
        }
    });
    let resolved = std::fs::canonicalize(path).ok().or_else(|| {
        let parent = std::fs::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    });
    let key = path_key(&path_for_frontend(resolved.as_deref().unwrap_or(path)));
    key.trim_end_matches('/').to_owned()
}

#[cfg(test)]
type ComparisonKeyHook = Box<dyn FnMut(&Path)>;
#[cfg(test)]
thread_local! {
    pub(super) static COMPARISON_KEY_HOOK: std::cell::RefCell<Option<ComparisonKeyHook>> = const { std::cell::RefCell::new(None) };
}

fn within(key: &str, root: &str) -> bool {
    key == root
        || key
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Registry {
    pub fn new(retention: Duration, expiry: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            analysis: Mutex::new(()),
            available: Condvar::new(),
            retention,
            expiry,
        }
    }

    pub fn bind_store(&self, store: &std::sync::Arc<super::store::Store>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.receipt_store = std::sync::Arc::downgrade(store);
        }
    }

    /// The watcher subscribes while it runs; without it, nothing is lost: the
    /// next startup reconciliation compares the sources with the index.
    pub fn set_listener(&self, listener: Option<Listener>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.listener = listener;
        }
    }

    /// Records the operation before any mutation and returns its identifier.
    pub fn begin(&self, declaration: Declaration) -> String {
        let quick = declaration.kind == "projectSave";
        let deadline = Instant::now() + Duration::from_millis(25);
        let keys = |paths: &[PathBuf]| -> Vec<String> {
            paths
                .iter()
                .filter(|path| path.is_absolute())
                .map(|path| comparison_key(path))
                .collect()
        };
        let mut operation = Operation {
            previous: if declaration.kind == "projectSave" {
                declaration
                    .exact
                    .iter()
                    .map(|path| (comparison_key(path), SavePrestate::of(path)))
                    .collect()
            } else {
                Vec::new()
            },
            exact: keys(&declaration.exact),
            subtrees: keys(&declaration.subtrees),
            temporaries: keys(&declaration.temporaries),
            native_exact: declaration.exact,
            native_subtrees: declaration.subtrees,
            started: Instant::now(),
            expiry: declaration
                .expiry
                .unwrap_or(if quick {
                    Duration::from_secs(5)
                } else {
                    self.expiry
                })
                .min(if quick {
                    Duration::from_secs(5).min(self.expiry)
                } else {
                    self.expiry
                }),
            state: State::Active,
        };
        let id = uuid::Uuid::new_v4().to_string();
        // Old traces are also dropped here, so the registry stays bounded
        // even while no watcher runs.
        self.sweep(Instant::now());
        loop {
            // Saves fall back to external-write reconciliation instead of waiting
            // for a slow analyser or an abandoned overlapping declaration.
            let gate = if quick {
                loop {
                    match self.analysis.try_lock() {
                        Ok(gate) => break gate,
                        Err(_) if Instant::now() >= deadline => return String::new(),
                        Err(_) => std::thread::sleep(Duration::from_millis(1)),
                    }
                }
            } else {
                self.analysis.lock().unwrap()
            };
            let mut inner = self.inner.lock().unwrap();
            let overlap = inner.operations.values().any(|other| {
                matches!(other.state, State::Active)
                    && operation
                        .exact
                        .iter()
                        .chain(&operation.temporaries)
                        .chain(&operation.subtrees)
                        .any(|key| {
                            other.owns(key)
                                || other
                                    .exact
                                    .iter()
                                    .chain(&other.subtrees)
                                    .chain(&other.temporaries)
                                    .any(|path| within(path, key))
                        })
            });
            if !overlap {
                for (key, previous) in &mut operation.previous {
                    let current_previous = operation
                        .native_exact
                        .iter()
                        .find(|path| comparison_key(path) == *key)
                        .and_then(|path| SavePrestate::of(path));
                    *previous = inner
                        .saves
                        .get(key)
                        .filter(|save| {
                            FileState::of(&save.path).as_ref() == Some(&save.final_state)
                        })
                        .map(|save| save.previous.clone())
                        .or_else(|| {
                            inner.receipt_store.upgrade().and_then(|store| {
                                operation
                                    .native_exact
                                    .iter()
                                    .find(|path| comparison_key(path) == *key)
                                    .and_then(|path| store.saved_prestate(path).ok().flatten())
                            })
                        })
                        .or(current_previous);
                }
                operation.started = Instant::now();
                inner.operations.insert(id.clone(), operation);
                break;
            }
            drop(gate);
            if quick && Instant::now() >= deadline {
                return String::new();
            }
            let _ = self.available.wait_timeout(
                inner,
                if quick {
                    Duration::from_millis(1)
                } else {
                    Duration::from_millis(100)
                },
            );
            self.sweep(Instant::now());
        }
        log::debug!(target: "catalogue_watch", "own write {id} started: {}", declaration.kind);
        id
    }

    /// Closes an operation. On success, `finals` adds the files whose name was
    /// only known at the end (a generated archive); their state is recorded
    /// and they are published at once. On failure, every declared path is
    /// released for reconciliation. Unknown or expired identifiers are ignored:
    /// finishing is idempotent.
    pub fn finish(&self, id: &str, succeeded: bool, finals: Vec<PathBuf>) {
        if id.is_empty() {
            return;
        }
        // Keep the active reservation visible while observing final paths. A
        // disconnected volume must not hold either global mutex during I/O.
        let Some(mut operation) = self.inner.lock().ok().and_then(|inner| {
            inner
                .operations
                .get(id)
                .filter(|op| matches!(op.state, State::Active))
                .cloned()
        }) else {
            return;
        };
        let mut save_keys = Vec::new();
        let notice = if succeeded {
            let mut written: Vec<PathBuf> = operation.native_exact.clone();
            for path in finals {
                if path.is_absolute() && !written.contains(&path) {
                    operation.exact.push(comparison_key(&path));
                    written.push(path);
                }
            }
            operation.state = State::Committed {
                at: Instant::now(),
                finals: written
                    .iter()
                    .map(|path| (comparison_key(path), FileState::of(path)))
                    .collect(),
            };
            let saves: Vec<_> = written
                .iter()
                .filter_map(|path| {
                    let key = comparison_key(path);
                    let previous = operation
                        .previous
                        .iter()
                        .find(|(k, _)| *k == key)?
                        .1
                        .clone()?;
                    Some(SaveAttestation {
                        path: path.clone(),
                        previous,
                        final_state: FileState::of(path)?,
                    })
                })
                .collect();
            for save in &saves {
                save_keys.push((comparison_key(&save.path), save.clone()));
            }
            if saves.is_empty() {
                Notice::Committed(written)
            } else {
                Notice::Saved {
                    paths: written,
                    attestations: saves,
                }
            }
        } else {
            Notice::Released(operation.released_paths())
        };
        let deadline = Instant::now() + Duration::from_millis(25);
        let gate = loop {
            match self.analysis.try_lock() {
                Ok(gate) => break Some(gate),
                Err(_) if Instant::now() >= deadline => break None,
                Err(_) => std::thread::sleep(Duration::from_millis(1)),
            }
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner
            .operations
            .get(id)
            .is_some_and(|op| matches!(op.state, State::Active))
        {
            return;
        }
        inner.operations.remove(id);
        let notice = if gate.is_none() {
            Notice::Released(operation.released_paths())
        } else {
            if succeeded {
                inner.operations.insert(id.to_owned(), operation);
                inner.saves.extend(save_keys);
            }
            notice
        };
        self.available.notify_all();
        if let Some(listener) = &inner.listener {
            listener(notice);
        }
    }

    /// Excludes writer starts/finishes throughout analysis and publication.
    pub fn analysis_guard(&self) -> MutexGuard<'_, ()> {
        self.analysis.lock().unwrap()
    }

    /// A successful project save at this exact path, still identical to its
    /// recorded final file, attests the pre-write content token.
    pub fn save_prestate(&self, path: &Path) -> Option<SavePrestate> {
        let key = comparison_key(path);
        let inner = self.inner.lock().ok()?;
        let save = inner.saves.get(&key)?;
        (FileState::of(path).as_ref() == Some(&save.final_state)).then(|| save.previous.clone())
    }

    /// Release consumed attestations; queued saves survive event retention.
    pub fn acknowledge_save(&self, path: &Path) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.saves.remove(&comparison_key(path));
        }
    }

    /// Decides what an event on `path` means for the catalogue.
    pub fn classify(&self, path: &Path, now: Instant) -> Verdict {
        let key = comparison_key(path);
        let Ok(inner) = self.inner.lock() else {
            return Verdict::External;
        };
        let mut verdict = Verdict::External;
        for operation in inner.operations.values() {
            let owns = operation.owns(&key);
            let active_descendant = matches!(operation.state, State::Active)
                && operation
                    .exact
                    .iter()
                    .chain(&operation.temporaries)
                    .chain(&operation.subtrees)
                    .any(|path| within(path, &key));
            if !owns && !active_descendant {
                continue;
            }
            match &operation.state {
                State::Active if now.duration_since(operation.started) < operation.expiry => {
                    return Verdict::Deferred;
                }
                State::Active => {}
                State::Committed { at, finals } => {
                    if now.duration_since(*at) >= self.retention {
                        continue;
                    }
                    if let Some((_, recorded)) =
                        finals.iter().find(|(final_key, _)| *final_key == key)
                    {
                        // Identical to what we wrote: absorbed. Anything else
                        // (an external change in the window) is processed.
                        if match recorded {
                            Some(state) => state.matches(path),
                            None => FileState::of(path).is_none(),
                        } {
                            verdict = Verdict::Absorbed;
                        }
                    } else if operation.temporaries.contains(&key) && !path.exists() {
                        verdict = Verdict::Absorbed;
                    }
                }
            }
        }
        verdict
    }

    /// Forgets finished traces after the retention delay and releases the
    /// operations never confirmed (a crashed or abandoned writer).
    pub fn sweep(&self, now: Instant) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let mut released = Vec::new();
        inner
            .operations
            .retain(|_, operation| match &operation.state {
                State::Committed { at, .. } => now.duration_since(*at) < self.retention,
                State::Active if now.duration_since(operation.started) >= operation.expiry => {
                    released.extend(operation.released_paths());
                    false
                }
                State::Active => true,
            });
        if !released.is_empty() {
            if let Some(listener) = &inner.listener {
                listener(Notice::Released(released));
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.operations.len()).unwrap_or(0)
    }
}

impl super::store::Store {
    /// Commit successful-save evidence before its asynchronous publication.
    /// Only a known legacy anchor needs a durable receipt.
    pub fn record_save_receipts(&self, saves: &[SaveAttestation]) -> super::Result<()> {
        use super::store::error;
        self.try_write(|tx| {
            for save in saves {
                let path_key = super::path_identity::key(&save.path);
                let anchor = serde_json::json!({"pathKey":path_key}).to_string();
                tx.execute("INSERT OR REPLACE INTO save_receipt SELECT ?1,?2 WHERE EXISTS
                    (SELECT 1 FROM exemplar WHERE retired=0 AND verified_uuid IS NULL
                     AND proof_json=?3 AND json_extract(anchor_json,'$.pathKey')=json_extract(?4,'$.pathKey')
                     AND json_extract(anchor_json,'$.memberKey') IS NULL
                     AND EXISTS(SELECT 1 FROM exemplar_file_state f WHERE f.exemplar_id=exemplar.id AND f.file_id=?5 AND f.file_id IS NOT NULL))",
                    rusqlite::params![path_key,serde_json::to_string(save).map_err(error)?,save.previous.token,anchor,save.previous.file_id]).map_err(error)?;
            }
            Ok(())
        })
    }

    pub fn attested_prestate(
        &self,
        registry: &Registry,
        path: &Path,
    ) -> super::Result<Option<SavePrestate>> {
        match registry.save_prestate(path) {
            Some(token) => Ok(Some(token)),
            None => self.saved_prestate(path),
        }
    }

    pub fn saved_prestate(&self, path: &Path) -> super::Result<Option<SavePrestate>> {
        use rusqlite::OptionalExtension;
        let saved: Option<String> = self.read(|c| {
            c.busy_timeout(Duration::from_millis(25))?;
            c.query_row(
                "SELECT receipt_json FROM save_receipt WHERE path_key=?1",
                [super::path_identity::key(path)],
                |r| r.get(0),
            )
            .optional()
        })?;
        let Some(saved) = saved else {
            return Ok(None);
        };
        let save: SaveAttestation = serde_json::from_str(&saved).map_err(super::store::error)?;
        Ok((comparison_key(&save.path) == comparison_key(path)
            && FileState::of(path).as_ref() == Some(&save.final_state))
        .then_some(save.previous))
    }
}

/// The process-wide registry used by commands and services.
pub fn shared() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// Scoped declaration for Rust writers: finishing explicitly publishes the
/// written files; dropping it unfinished (an early return, an error, a panic)
/// releases the operation for reconciliation.
pub struct OwnWrite {
    registry: &'static Registry,
    id: Option<String>,
}

impl OwnWrite {
    pub fn begin(declaration: Declaration) -> Self {
        let registry = shared();
        Self {
            id: Some(registry.begin(declaration)),
            registry,
        }
    }
    /// Success with the final files (possibly named only now).
    pub fn succeeded(mut self, finals: Vec<PathBuf>) {
        if let Some(id) = self.id.take() {
            self.registry.finish(&id, true, finals);
        }
    }
    /// Closes the declaration according to the writer's result.
    pub fn finish<T, E>(self, result: &Result<T, E>, finals: impl FnOnce(&T) -> Vec<PathBuf>) {
        match result {
            Ok(value) => self.succeeded(finals(value)),
            Err(_) => drop(self),
        }
    }
}

impl Drop for OwnWrite {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.registry.finish(&id, false, Vec::new());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("catalogue-writes-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn blocked_finish_observation_allows_real_local_save_declaration() {
        let dir = Dir::new();
        let remote = dir.0.join("remote.zip");
        let local = dir.0.join("local.mbah");
        std::fs::write(&remote, b"remote").unwrap();
        std::fs::write(&local, b"local").unwrap();
        let registry = std::sync::Arc::new(Registry::default());
        let id = registry.begin(Declaration::new("catalogueFiles").exact(&remote));
        let (blocked_tx, blocked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let finishing = registry.clone();
        let worker = std::thread::spawn(move || {
            COMPARISON_KEY_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move |_| {
                    let _ = blocked_tx.send(());
                    let _ = release_rx.recv();
                }))
            });
            // Block only the first observation, outside the filesystem itself.
            finishing.finish(&id, true, vec![]);
        });
        blocked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let saving = registry.clone();
        let save = std::thread::spawn(move || {
            let id = saving.begin(Declaration::new("projectSave").exact(local));
            let remote_verdict = saving.classify(&remote, Instant::now());
            done_tx.send((id, remote_verdict)).unwrap();
        });
        let result = done_rx.recv_timeout(Duration::from_millis(500));
        // Always release and join, including the expected regression failure.
        drop(release_tx);
        let _ = worker.join();
        save.join().unwrap();
        assert!(
            result.is_ok(),
            "remote final observation held a global write lock"
        );
        let (id, remote_verdict) = result.unwrap();
        assert!(!id.is_empty());
        assert_eq!(remote_verdict, Verdict::Deferred);
    }

    #[test]
    fn active_defers_committed_absorbs_only_identical_state() {
        let dir = Dir::new();
        let registry = Registry::new(Duration::from_secs(30), Duration::from_secs(60));
        let (sender, notices) = std::sync::mpsc::channel();
        registry.set_listener(Some(Box::new(move |notice| {
            let _ = sender.send(notice);
        })));
        let target = dir.0.join("projet.mbah");
        let temporary = dir.0.join("projet.mbah.tmp-1");
        let other = dir.0.join("autre.mbah");
        let id = registry.begin(
            Declaration::new("projectSave")
                .exact(&target)
                .temporary(&temporary),
        );
        let now = Instant::now();
        assert_eq!(registry.classify(&target, now), Verdict::Deferred);
        assert_eq!(registry.classify(&temporary, now), Verdict::Deferred);
        assert_eq!(registry.classify(&other, now), Verdict::External);
        std::fs::write(&temporary, b"v1").unwrap();
        std::fs::rename(&temporary, &target).unwrap();
        registry.finish(&id, true, Vec::new());
        assert_eq!(
            notices.try_recv().unwrap(),
            Notice::Committed(vec![target.clone()])
        );
        let now = Instant::now();
        assert_eq!(registry.classify(&target, now), Verdict::Absorbed);
        assert_eq!(registry.classify(&temporary, now), Verdict::Absorbed);
        // An external change inside the retention window is not absorbed.
        std::fs::write(&target, b"external and longer").unwrap();
        assert_eq!(registry.classify(&target, now), Verdict::External);
        // Finishing twice is harmless.
        registry.finish(&id, false, Vec::new());
        assert!(notices.try_recv().is_err());
    }

    #[test]
    fn retention_failure_expiry_and_scoped_guard() {
        let dir = Dir::new();
        let registry = Registry::new(Duration::from_millis(50), Duration::from_millis(80));
        let (sender, notices) = std::sync::mpsc::channel();
        registry.set_listener(Some(Box::new(move |notice| {
            let _ = sender.send(notice);
        })));
        let target = dir.0.join("a.zip");
        std::fs::write(&target, b"zip").unwrap();
        let id = registry.begin(Declaration::new("generation").subtree(&dir.0));
        registry.finish(&id, true, vec![target.clone()]);
        assert!(
            matches!(notices.try_recv(), Ok(Notice::Committed(p)) if p == vec![target.clone()])
        );
        let later = Instant::now() + Duration::from_millis(60);
        assert_eq!(registry.classify(&target, later), Verdict::External);
        registry.sweep(later);
        assert_eq!(registry.len(), 0);

        let failed = registry.begin(Declaration::new("checker").exact(dir.0.join("b.zip")));
        registry.finish(&failed, false, Vec::new());
        assert_eq!(
            notices.try_recv().unwrap(),
            Notice::Released(vec![dir.0.join("b.zip")])
        );

        let _abandoned = registry.begin(Declaration::new("conversion").subtree(&dir.0));
        let expired = Instant::now() + Duration::from_millis(100);
        assert_eq!(
            registry.classify(&dir.0.join("c.zip"), expired),
            Verdict::External
        );
        registry.sweep(expired);
        assert_eq!(
            notices.try_recv().unwrap(),
            Notice::Released(vec![dir.0.clone()])
        );
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn relative_and_aliased_paths_share_one_key() {
        let dir = Dir::new();
        std::fs::create_dir(dir.0.join("sub")).unwrap();
        let direct = dir.0.join("sub/x.mbah");
        let dotted = dir.0.join("sub/../sub/./x.mbah");
        assert_eq!(comparison_key(&direct), comparison_key(&dotted));
        assert!(within(
            &comparison_key(&direct),
            &comparison_key(&dir.0.join("sub"))
        ));
        assert!(!within(
            &comparison_key(&dir.0.join("subway/x.mbah")),
            &comparison_key(&dir.0.join("sub"))
        ));
    }
}

#[cfg(test)]
mod serialization_tests {
    use super::*;
    #[test]
    fn overlapping_writers_wait_but_independent_writers_can_start() {
        let root =
            std::env::temp_dir().join(format!("catalogue-serialized-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let registry = std::sync::Arc::new(Registry::default());
        let first = registry.begin(Declaration::new("first").subtree(&root));
        let worker = std::sync::Arc::clone(&registry);
        let path = root.join("project.mbah");
        let (started, wait) = std::sync::mpsc::channel();
        let second = std::thread::spawn(move || {
            let id = worker.begin(Declaration::new("second").exact(&path));
            started.send(id).unwrap();
        });
        assert!(wait.recv_timeout(Duration::from_millis(100)).is_err());
        let independent =
            registry.begin(Declaration::new("other").exact(root.with_extension("elsewhere")));
        registry.finish(&independent, false, Vec::new());
        registry.finish(&first, false, Vec::new());
        let id = wait.recv_timeout(Duration::from_secs(2)).unwrap();
        second.join().unwrap();
        registry.finish(&id, false, Vec::new());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod temporary_serialization_tests {
    use super::*;
    #[test]
    fn temporary_and_containing_subtree_serialize_in_both_orders() {
        for temporary_first in [false, true] {
            let root =
                std::env::temp_dir().join(format!("catalogue-temporary-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let temporary = Declaration::new("temporary").temporary(root.join("project.tmp"));
            let subtree = Declaration::new("subtree").subtree(&root);
            let (a, b) = if temporary_first {
                (temporary, subtree)
            } else {
                (subtree, temporary)
            };
            let registry = std::sync::Arc::new(Registry::default());
            let first = registry.begin(a);
            let worker = std::sync::Arc::clone(&registry);
            let (sender, receiver) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || sender.send(worker.begin(b)).unwrap());
            assert!(
                receiver.recv_timeout(Duration::from_millis(150)).is_err(),
                "second write waits in either declaration order"
            );
            registry.finish(&first, false, Vec::new());
            let second = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
            thread.join().unwrap();
            registry.finish(&second, false, Vec::new());
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

#[cfg(test)]
mod bounded_save_tests {
    use super::*;
    #[test]
    fn save_does_not_wait_for_long_analysis_or_orphan() {
        let registry = Registry::default();
        let path = std::env::temp_dir().join("catalogue-bounded-project.mbah");
        let gate = registry.analysis_guard();
        let start = Instant::now();
        let id = registry.begin(Declaration::new("projectSave").exact(&path));
        assert!(id.is_empty(), "save falls back to an external write");
        assert!(start.elapsed() < Duration::from_millis(100));
        registry.finish(&id, true, Vec::new());
        drop(gate);
        let orphan = registry.begin(Declaration::new("projectSave").exact(&path));
        let start = Instant::now();
        assert!(registry
            .begin(Declaration::new("projectSave").exact(&path))
            .is_empty());
        assert!(start.elapsed() < Duration::from_millis(100));
        registry.sweep(Instant::now() + Duration::from_secs(6));
        assert_eq!(registry.len(), 0);
        registry.finish(&orphan, false, Vec::new());
    }
    #[test]
    fn finishing_a_save_does_not_wait_for_analysis() {
        let registry = Registry::default();
        let path = std::env::temp_dir().join("catalogue-bounded-finish.mbah");
        let id = registry.begin(Declaration::new("projectSave").exact(&path));
        let _gate = registry.analysis_guard();
        let start = Instant::now();
        registry.finish(&id, true, Vec::new());
        assert!(start.elapsed() < Duration::from_millis(100));
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.classify(&path, Instant::now()), Verdict::External);
    }
}
