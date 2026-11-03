//! Display covers of the catalogue grid: one JPEG per fiche, whatever its
//! provenance (exemplar, cover correction, retained official image), made once
//! by `thumbnails` and then read back directly.
//!
//! Layout: `<cache>/catalogue/covers/<fiche dir>/<content>-<signature>.jpg`.
//! The fiche directory is a digest of the fiche id and of `ENCODER`, so an
//! address never names a path and a new encoder version leaves the previous
//! images as orphans that the next reconciliation removes. `signature` is the listed `coverSignature` (the address key);
//! `content` is the same inputs without the supplier's availability, so an
//! offline supplier keeps its image under its new signature (a rename, no
//! source read). A fiche keeps at most one image: writing a new one removes
//! the others; no size budget and no eviction. Forgotten fiches lose their
//! directory (`reconcile_cover_store`).
//!
//! Priority: an interactive request counts itself in `Runtime::interactive`
//! for its whole slow path; the background prefabrication waits between two
//! fiches while that count is non-zero. Fabrication reuses
//! `Store::fiche_thumbnail` unchanged: same light-read budget, bounded source
//! reads, single decoder. It never downloads: a pending official image is
//! left to `download_lunii_covers` (consented flow) and the pass skips the
//! fiche until its retention changes the signature.
//!
//! Conclusive failures (too large; unreadable correction or official image)
//! are remembered for the session by fiche and signature and not retried
//! until the signature changes. An unreadable exemplar records its own
//! marker, which changes the signature; a transient one stays retryable.
//!
//! A fiche forgotten between the key read and the write may leave a
//! directory behind: the next reconciliation (erasure, prefabrication pass)
//! removes it as an orphan; it is never served (the fiche is unknown).
use super::{
    store::{error, Store},
    thumbnails::{self, CoverKeys},
    Result,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

/// Interactive fabrications running at once; a few others wait their turn.
const INTERACTIVE_FABRICATIONS: usize = 4;
/// Beyond these waiting requests, or after this wait, the answer is `Busy`.
const WAITING_FABRICATIONS: usize = 16;
const FABRICATION_WAIT: Duration = Duration::from_secs(1);
/// Encoder version: part of the address (`/v1/…`) and of the fiche directory,
/// so an `immutable` answer never outlives a change of size or quality.
pub const ENCODER: &str = "v1";
/// Fiche ids are database keys; a longer address segment is refused.
const ID_BYTES: usize = 512;

/// Outcome of one cover address.
#[derive(Debug, PartialEq)]
pub enum Served {
    Ready(Vec<u8>),
    /// The fiche has no cover (none found, or a cleared correction).
    Absent,
    /// The address signature is not the fiche's current one.
    Stale,
    UnknownFiche,
    BadAddress,
    Unreadable,
    TooLarge,
    /// Retry shortly: a bounded read or the time budget is exhausted.
    Busy,
    /// The supplying source is not available; its return changes the signature.
    Offline,
}
impl Served {
    pub fn state(&self) -> &'static str {
        match self {
            Self::Ready(_) => "ready",
            Self::Absent => "absent",
            Self::Stale => "stale",
            Self::UnknownFiche => "unknownFiche",
            Self::BadAddress => "badAddress",
            Self::Unreadable => "unreadable",
            Self::TooLarge => "tooLarge",
            Self::Busy => "busy",
            Self::Offline => "offline",
        }
    }
}

#[derive(Default)]
pub struct Runtime {
    interactive: AtomicUsize,
    /// (fabricating, waiting) interactive requests.
    fabricating: Mutex<(usize, usize)>,
    freed: Condvar,
    /// Incremented by each cancellation: a pass stops at its next fiche.
    generation: AtomicU64,
    /// Set by cancellation: no pass is started or resumed afterwards.
    closed: AtomicBool,
    /// (pass running, another pass requested)
    pass: Mutex<(bool, bool)>,
    /// Conclusive failures of this session: fiche → (signature, outcome).
    failures: Mutex<HashMap<String, (String, Failure)>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    TooLarge,
    Unreadable,
}
impl Runtime {
    fn failure(&self, id: &str, signature: &str) -> Option<Served> {
        let failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        match failures.get(id) {
            Some((known, Failure::TooLarge)) if known == signature => Some(Served::TooLarge),
            Some((known, Failure::Unreadable)) if known == signature => Some(Served::Unreadable),
            _ => None,
        }
    }
    fn remember(&self, id: &str, signature: &str, failure: Failure) {
        self.failures
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned(), (signature.to_owned(), failure));
    }
}

struct Interactive<'a>(&'a Runtime);
impl<'a> Interactive<'a> {
    fn enter(runtime: &'a Runtime) -> Self {
        runtime.interactive.fetch_add(1, Ordering::AcqRel);
        Self(runtime)
    }
    /// A fabrication turn, or `None` (answered `Busy`) when too many requests
    /// already wait or the bounded wait elapses: a blocking-pool thread is
    /// never held indefinitely.
    fn fabricate(&self) -> Option<Fabricating<'a>> {
        let runtime = self.0;
        let mut state = runtime
            .fabricating
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if state.0 >= INTERACTIVE_FABRICATIONS {
            if state.1 >= WAITING_FABRICATIONS {
                return None;
            }
            state.1 += 1;
            let deadline = std::time::Instant::now() + FABRICATION_WAIT;
            while state.0 >= INTERACTIVE_FABRICATIONS {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    state.1 -= 1;
                    return None;
                }
                state = runtime
                    .freed
                    .wait_timeout(state, left)
                    .unwrap_or_else(|p| p.into_inner())
                    .0;
            }
            state.1 -= 1;
        }
        state.0 += 1;
        Some(Fabricating(runtime))
    }
}
impl Drop for Interactive<'_> {
    fn drop(&mut self) {
        self.0.interactive.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Fabricating<'a>(&'a Runtime);
impl Drop for Fabricating<'_> {
    fn drop(&mut self) {
        // Released even after a panic elsewhere poisoned the lock.
        let mut state = self.0.fabricating.lock().unwrap_or_else(|p| p.into_inner());
        state.0 -= 1;
        drop(state);
        self.0.freed.notify_one();
    }
}

/// Counts of one prefabrication pass (diagnostics and tests).
#[derive(Debug, Default, PartialEq)]
pub struct PassReport {
    pub fabricated: usize,
    pub kept: usize,
    pub skipped: usize,
    pub cancelled: bool,
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `/v1/<percent-encoded fiche id>/<signature>.jpg` → (fiche id, signature).
/// Anything else, including another encoder version, dot segments,
/// separators or control characters inside the id, is refused; the id never
/// becomes a path.
pub fn parse_address(path: &str) -> Option<(String, String)> {
    let rest = path
        .strip_prefix('/')?
        .strip_prefix(ENCODER)?
        .strip_prefix('/')?;
    let (id, file) = rest.split_once('/')?;
    let signature = file.strip_suffix(".jpg")?;
    if !hex64(signature) || id.is_empty() || id.len() > ID_BYTES * 3 {
        return None;
    }
    let id = percent_decode(id)?;
    if id.is_empty()
        || id.len() > ID_BYTES
        || id == "."
        || id == ".."
        || id.chars().any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return None;
    }
    Some((id, signature.to_owned()))
}

fn fiche_dir_name(id: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("fiche-cover:{ENCODER}:{id}").as_bytes())
    );
    digest[..32].to_owned()
}

fn file_name(keys: &CoverKeys) -> String {
    format!("{}-{}.jpg", keys.content, keys.signature)
}

/// Stored images of one fiche directory: (name, path).
fn stored(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (name.len() == 64 + 1 + 64 + 4 && name.ends_with(".jpg")).then(|| (name, entry.path()))
        })
        .collect()
}

/// A complete JPEG within the thumbnail budget: start and end markers.
fn complete_jpeg(bytes: &[u8]) -> bool {
    bytes.len() <= thumbnails::TARGET
        && bytes.starts_with(&[0xff, 0xd8])
        && bytes.ends_with(&[0xff, 0xd9])
}

fn read_image(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(thumbnails::TARGET as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    complete_jpeg(&bytes).then_some(bytes)
}

/// Removes every stored image of the directory except `keep`.
fn remove_others(dir: &Path, keep: Option<&str>) {
    for (name, path) in stored(dir) {
        if Some(name.as_str()) != keep {
            if let Err(reason) = std::fs::remove_file(&path) {
                if reason.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("Catalogue cover cleanup: {reason}");
                }
            }
        }
    }
}

impl Store {
    fn cover_dir(&self, id: &str) -> PathBuf {
        self.cover_root().join(fiche_dir_name(id))
    }

    /// Fast path: an image already made for this fiche and signature, read
    /// without any database access or decoding.
    fn stored_cover(&self, id: &str, signature: &str) -> Option<Vec<u8>> {
        let suffix = format!("-{signature}.jpg");
        stored(&self.cover_dir(id))
            .into_iter()
            .find(|(name, _)| name.ends_with(&suffix))
            .and_then(|(_, path)| read_image(&path))
    }

    fn current_cover_keys(&self, id: &str) -> Result<Option<CoverKeys>> {
        self.read_snapshot(|c| {
            let exists: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM fiche WHERE id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok(None);
            }
            thumbnails::fiche_cover_keys(c, id).map(Some)
        })
    }

    /// Serves the address `(fiche, signature)` for the interface. A stored
    /// image answers at once; otherwise the address is validated against the
    /// current signature and the image is made, ahead of any prefabrication.
    pub fn served_cover(&self, id: &str, signature: &str) -> Result<Served> {
        if !hex64(signature) {
            return Ok(Served::BadAddress);
        }
        if let Some(bytes) = self.stored_cover(id, signature) {
            return Ok(Served::Ready(bytes));
        }
        let interactive = Interactive::enter(&self.covers);
        let Some(keys) = self.current_cover_keys(id)? else {
            return Ok(Served::UnknownFiche);
        };
        if keys.signature != signature {
            return Ok(Served::Stale);
        }
        if let Some(failure) = self.covers.failure(id, signature) {
            return Ok(failure);
        }
        let Some(_turn) = interactive.fabricate() else {
            return Ok(Served::Busy);
        };
        // Made by another request while this one waited.
        if let Some(bytes) = self.stored_cover(id, signature) {
            return Ok(Served::Ready(bytes));
        }
        self.produce_cover(id, &keys)
    }

    /// Slow path for validated keys: reuse an image of the same content,
    /// otherwise make it from the current inputs.
    fn produce_cover(&self, id: &str, keys: &CoverKeys) -> Result<Served> {
        let dir = self.cover_dir(id);
        let name = file_name(keys);
        let target = dir.join(&name);
        let prefix = format!("{}-", keys.content);
        if let Some((_, path)) = stored(&dir)
            .into_iter()
            .find(|(other, _)| other.starts_with(&prefix))
        {
            if std::fs::rename(&path, &target).is_ok() {
                if let Some(bytes) = read_image(&target) {
                    remove_others(&dir, Some(&name));
                    return Ok(Served::Ready(bytes));
                }
            }
        }
        let thumbnail = match self.fiche_thumbnail(id, None) {
            Ok(thumbnail) => thumbnail,
            Err(reason)
                if reason.code
                    == crate::support::user_message::codes::CATALOG_TARGET_REVISION_STALE =>
            {
                return Ok(Served::Stale)
            }
            Err(reason) => return Err(reason),
        };
        if thumbnail.signature.as_deref() != Some(keys.signature.as_str()) {
            return Ok(Served::Stale);
        }
        Ok(match (thumbnail.state, thumbnail.bytes) {
            // An image without its end marker (an official JPEG kept as is)
            // is served but not stored: the fast path would refuse it.
            ("ready", Some(bytes)) if !complete_jpeg(&bytes) => Served::Ready(bytes),
            ("ready", Some(bytes)) => {
                std::fs::create_dir_all(&dir).map_err(error)?;
                // Written aside then renamed: a reader never sees a partial JPEG.
                let partial = dir.join(format!("{}.partial", uuid::Uuid::new_v4()));
                std::fs::write(&partial, &bytes).map_err(error)?;
                if let Err(reason) = std::fs::rename(&partial, &target) {
                    let _ = std::fs::remove_file(&partial);
                    return Err(error(reason));
                }
                remove_others(&dir, Some(&name));
                Served::Ready(bytes)
            }
            ("absent", _) => {
                remove_others(&dir, None);
                Served::Absent
            }
            ("tooLarge", _) => {
                self.covers.remember(id, &keys.signature, Failure::TooLarge);
                Served::TooLarge
            }
            ("busy", _) => Served::Busy,
            _ if keys.offline => Served::Offline,
            _ => {
                // Correction and official images are local: their failure is
                // conclusive. An exemplar's is either marked (new signature)
                // or transient, and stays retryable.
                if keys.supplier.is_none() {
                    self.covers
                        .remember(id, &keys.signature, Failure::Unreadable);
                }
                Served::Unreadable
            }
        })
    }

    /// Removes the directories of fiches that no longer exist and, for the
    /// others, images whose content is no longer the current one. Never makes
    /// an image. Run after every erasure so a forgotten cover cannot remain.
    pub(crate) fn reconcile_cover_store(&self) -> Result<()> {
        self.reconcile_with(&self.all_cover_keys()?)
    }

    /// Keys of every fiche, in one snapshot, ordered by fiche id.
    fn all_cover_keys(&self) -> Result<Vec<(String, CoverKeys)>> {
        self.read_snapshot(|c| {
            let ids = c
                .prepare("SELECT id FROM fiche ORDER BY id")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.into_iter()
                .map(|id| {
                    let keys = thumbnails::fiche_cover_keys(c, &id)?;
                    Ok((id, keys))
                })
                .collect()
        })
    }

    fn reconcile_with(&self, all: &[(String, CoverKeys)]) -> Result<()> {
        let root = self.cover_root();
        let keys: HashMap<_, _> = all
            .iter()
            .map(|(id, keys)| (fiche_dir_name(id), keys))
            .collect();
        let Ok(entries) = std::fs::read_dir(&root) else {
            return Ok(());
        };
        for entry in entries {
            let entry = entry.map_err(error)?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            match keys.get(&name) {
                Some(keys) if path.is_dir() => {
                    let prefix = format!("{}-", keys.content);
                    for (stored_name, stored_path) in stored(&path) {
                        if !stored_name.starts_with(&prefix) {
                            match std::fs::remove_file(stored_path) {
                                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                                    return Err(error(e))
                                }
                                _ => {}
                            }
                        }
                    }
                    remove_stale_partials(&path);
                }
                _ if path.is_dir() => std::fs::remove_dir_all(&path).map_err(error)?,
                _ => std::fs::remove_file(&path).map_err(error)?,
            }
        }
        Ok(())
    }

    /// Cancels the running prefabrication pass, if any, and any later
    /// request (the application is closing).
    pub fn cancel_cover_prefabrication(&self) {
        self.covers.closed.store(true, Ordering::Release);
        self.covers.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Requests a background prefabrication pass. Requests made while a pass
    /// runs are merged into one more pass. Invisible, without setting.
    pub fn request_cover_prefabrication(self: &Arc<Self>) {
        if self.covers.closed.load(Ordering::Acquire) {
            return;
        }
        {
            let Ok(mut pass) = self.covers.pass.lock() else {
                return;
            };
            if pass.0 {
                pass.1 = true;
                return;
            }
            *pass = (true, false);
        }
        let store = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("catalogue-cover-prefab".into())
            .spawn(move || loop {
                match store.prefabricate_covers() {
                    Ok(report) if report.fabricated > 0 => log::info!(
                        "Catalogue covers prepared: {} made, {} kept, {} skipped",
                        report.fabricated,
                        report.kept,
                        report.skipped
                    ),
                    Ok(_) => {}
                    Err(reason) => log::warn!("Catalogue cover preparation: {}", reason.code),
                }
                let Ok(mut pass) = store.covers.pass.lock() else {
                    return;
                };
                let again = std::mem::take(&mut pass.1);
                if !again || store.covers.closed.load(Ordering::Acquire) {
                    pass.0 = false;
                    return;
                }
            });
        if spawned.is_err() {
            if let Ok(mut pass) = self.covers.pass.lock() {
                *pass = (false, false);
            }
        }
    }

    /// One prefabrication pass over every fiche, synchronously. Yields to
    /// interactive requests between fiches, stops on cancellation, never
    /// reads an offline supplier nor downloads a pending official image,
    /// skips the rest of a source after a transient failure on it, and
    /// never stops on one fiche's error.
    pub fn prefabricate_covers(&self) -> Result<PassReport> {
        let generation = self.covers.generation.load(Ordering::Acquire);
        let cancelled = || self.covers.generation.load(Ordering::Acquire) != generation;
        let mut report = PassReport::default();
        let all = self.all_cover_keys()?;
        if let Err(reason) = self.reconcile_with(&all) {
            log::warn!("Catalogue cover reconciliation: {}", reason.code);
        }
        let mut failed_sources = std::collections::HashSet::<String>::new();
        for (id, keys) in all {
            while self.covers.interactive.load(Ordering::Acquire) > 0 && !cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            if cancelled() {
                report.cancelled = true;
                return Ok(report);
            }
            match self.prefabricate_one(&id, &keys, &mut failed_sources) {
                Ok(Some(true)) => report.fabricated += 1,
                Ok(Some(false)) => report.kept += 1,
                Ok(None) => report.skipped += 1,
                Err(reason) => {
                    // No identifier in the log: the code is enough to diagnose.
                    log::warn!("Catalogue cover preparation skipped: {}", reason.code);
                    report.skipped += 1;
                }
            }
        }
        Ok(report)
    }

    /// `Some(true)` made, `Some(false)` already stored, `None` skipped.
    fn prefabricate_one(
        &self,
        id: &str,
        keys: &CoverKeys,
        failed_sources: &mut std::collections::HashSet<String>,
    ) -> Result<Option<bool>> {
        if self.stored_cover(id, &keys.signature).is_some() {
            return Ok(Some(false));
        }
        if self.covers.failure(id, &keys.signature).is_some() {
            return Ok(None);
        }
        let supplier_source = match &keys.supplier {
            Some(exemplar) => self.read_snapshot(|c| {
                c.prepare("SELECT source_id FROM cache.coverage WHERE exemplar_id=?1")?
                    .query_map([exemplar], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?,
            None => Vec::new(),
        };
        let reusable = stored(&self.cover_dir(id))
            .iter()
            .any(|(name, _)| name.starts_with(&format!("{}-", keys.content)));
        if !reusable
            && (keys.offline
                || keys.official_pending
                || supplier_source.iter().any(|s| failed_sources.contains(s)))
        {
            return Ok(None);
        }
        Ok(match self.produce_cover(id, keys)? {
            Served::Ready(_) => Some(true),
            Served::Busy | Served::Offline | Served::Unreadable => {
                // A conclusive failure records a marker and changes the
                // signature; only a transient one blocks the source.
                let unchanged = self
                    .current_cover_keys(id)?
                    .is_some_and(|now| now.signature == keys.signature);
                if unchanged {
                    failed_sources.extend(supplier_source);
                }
                None
            }
            _ => None,
        })
    }
}

/// Partial writes left by an interrupted process; recent ones may belong to
/// a write in progress.
fn remove_stale_partials(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(60));
        if old && path.extension().is_some_and(|ext| ext == "partial") {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
impl Store {
    pub(crate) fn cover_store_dir(&self, id: &str) -> PathBuf {
        self.cover_dir(id)
    }
    pub(crate) fn hold_interactive_cover(&self) -> impl Drop + '_ {
        Interactive::enter(&self.covers)
    }
    /// Occupies every interactive fabrication turn.
    pub(crate) fn hold_cover_fabrications(&self) -> Vec<impl Drop + '_> {
        let interactive = Interactive::enter(&self.covers);
        (0..INTERACTIVE_FABRICATIONS)
            .map(|_| interactive.fabricate().unwrap())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_name_a_fiche_and_a_signature_only() {
        let sig = "a".repeat(64);
        assert_eq!(
            parse_address(&format!("/v1/card-1/{sig}.jpg")),
            Some(("card-1".into(), sig.clone()))
        );
        assert_eq!(
            parse_address(&format!("/v1/a%2Fb/{sig}.jpg")),
            None,
            "a separator inside the id is refused"
        );
        assert_eq!(
            parse_address(&format!("/v1/a%20c/{sig}.jpg")),
            Some(("a c".into(), sig.clone()))
        );
        for forged in [
            format!("/v1/../{sig}.jpg"),
            format!("/v1/%2E%2E/{sig}.jpg"),
            format!("/v1/card/../../etc/{sig}.jpg"),
            format!("/v1/card/{sig}"),
            format!("/v1/card/{}.jpg", "A".repeat(64)),
            format!("/v1/card/{}.jpg", "a".repeat(63)),
            format!("/v1//{sig}.jpg"),
            format!("/v1/card%00/{sig}.jpg"),
            format!("/v1/card%zz/{sig}.jpg"),
            format!("/v1/card%5C..%5C/{sig}.jpg"),
            format!("card/{sig}.jpg"),
            format!("/card/{sig}.jpg"),
            format!("/v2/card/{sig}.jpg"),
            format!("/v1/v1/card/{sig}.jpg"),
            format!("/v1/{}/{sig}.jpg", "x".repeat(ID_BYTES + 1)),
        ] {
            assert_eq!(parse_address(&forged), None, "{forged}");
        }
    }

    #[test]
    fn complete_jpegs_only() {
        assert!(complete_jpeg(&[0xff, 0xd8, 0, 0xff, 0xd9]));
        assert!(!complete_jpeg(&[0xff, 0xd8, 0, 0]));
        assert!(!complete_jpeg(&[0, 0xd8, 0xff, 0xd9]));
        assert!(!complete_jpeg(&[]));
    }

    #[test]
    fn interactive_fabrication_waits_are_bounded() {
        let runtime = Runtime::default();
        let interactive = Interactive::enter(&runtime);
        let turns: Vec<_> = (0..INTERACTIVE_FABRICATIONS)
            .map(|_| interactive.fabricate().unwrap())
            .collect();
        // Full queue of waiters: refused at once.
        runtime.fabricating.lock().unwrap().1 = WAITING_FABRICATIONS;
        let started = std::time::Instant::now();
        assert!(interactive.fabricate().is_none());
        assert!(started.elapsed() < FABRICATION_WAIT / 2);
        runtime.fabricating.lock().unwrap().1 = 0;
        // A waiter gives up after the bounded wait.
        let started = std::time::Instant::now();
        assert!(interactive.fabricate().is_none());
        assert!(started.elapsed() >= FABRICATION_WAIT);
        assert_eq!(runtime.fabricating.lock().unwrap().1, 0);
        // A released turn wakes a waiter.
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| Interactive::enter(&runtime).fabricate().is_some());
            std::thread::sleep(Duration::from_millis(50));
            drop(turns);
            assert!(waiter.join().unwrap());
        });
        assert_eq!(*runtime.fabricating.lock().unwrap(), (0, 0));
    }

    #[test]
    fn a_poisoned_lock_still_releases_turns() {
        let runtime = Runtime::default();
        let interactive = Interactive::enter(&runtime);
        let turn = interactive.fabricate().unwrap();
        let _ = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _guard = runtime.fabricating.lock().unwrap();
                    panic!("poison");
                })
                .join()
        });
        assert!(runtime.fabricating.is_poisoned());
        drop(turn);
        assert_eq!(
            runtime
                .fabricating
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .0,
            0
        );
    }

    #[test]
    fn fiche_directories_are_digests() {
        let name = fiche_dir_name("../../etc");
        assert_eq!(name.len(), 32);
        assert!(name.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(name, fiche_dir_name("../../etd"));
    }
}
