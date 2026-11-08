//! Targeted refresh and reconciliation.
//!
//! Only the files a watcher event, an own write or a reconciliation pointed at
//! are analysed again; a series of project saves never rescans a source. A
//! reconciliation lists a source (paths, sizes, dates, file identities) and
//! reanalyses only what differs from the last conclusive state recorded in the
//! index. Absence is confirmed only for a file that no longer exists while its
//! source root is reachable; an inventory cut short concludes nothing.
use super::{
    grouping::{Published, Scanned},
    probe,
    sources::Exclusions,
    store::{error, Store},
    walk, Result,
};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

// CROSS JOIN keeps lookup order explicit: source/UUID first, then primary-key
// and fiche-index probes. Never scan the catalogue once per new file.
pub(super) const RELATED_FILE_IDS: &str = "SELECT f.file_id,json_extract(e.anchor_json,'$.pathKey')
     FROM cache.coverage v
     CROSS JOIN exemplar e ON e.id=v.exemplar_id
     CROSS JOIN exemplar_file_state f ON f.exemplar_id=e.id
     WHERE v.source_id=?1 AND e.retired=0 AND f.file_id IS NOT NULL
       AND json_type(e.anchor_json,'$.pathKey')='array'
       AND json_type(e.anchor_json,'$.path')='text'";

pub(super) const RELATED_UUID_KEYS: &str = "SELECT DISTINCT json_extract(e.anchor_json,'$.pathKey')
     FROM json_each(?1) u
     CROSS JOIN pack_identity p ON p.pack_uuid=u.value
     CROSS JOIN exemplar e ON e.fiche_id=p.fiche_id
     WHERE e.retired=0
       AND json_type(e.anchor_json,'$.pathKey')='array'
       AND json_type(e.anchor_json,'$.path')='text'";

/// Counters of the work actually done, for diagnostics and tests: a series
/// of saves must show targeted analyses only, never a full scan.
#[derive(Default)]
pub struct Activity {
    /// Pack analyses (full scans and targeted refreshes together).
    pub analyses: AtomicU64,
    /// Explicit full scans started.
    pub full_scans: AtomicU64,
    /// Complete listings of a source (reconciliations).
    pub inventories: AtomicU64,
    /// Targeted refreshes run for touched paths.
    pub targeted: AtomicU64,
    /// Reconciliations run (startup, wake-up, lost events, periodic).
    pub reconciliations: AtomicU64,
    /// Watcher events recognised as the application's own committed writes.
    pub absorbed: AtomicU64,
    /// Targeted publications that changed the index.
    pub publications: AtomicU64,
    /// Listening measurements (story count and sound headers) of a file.
    /// Internal: not part of the published snapshot.
    pub measurements: AtomicU64,
    /// Solid-archive listening passes (one 7-Zip extraction each). Internal.
    pub solid_passes: AtomicU64,
    /// Test-only: every solid pass fails on the tool (`Retry`).
    #[cfg(test)]
    pub solid_pass_tool_fails: AtomicBool,
    /// Test-only: fail the supplementary identity lookup, not publication.
    #[cfg(test)]
    pub related_path_lookup_fails: AtomicBool,
    #[cfg(test)]
    pub related_file_map_loads: AtomicU64,
    #[cfg(test)]
    pub related_uuid_queries: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub analyses: u64,
    pub full_scans: u64,
    pub inventories: u64,
    pub targeted: u64,
    pub reconciliations: u64,
    pub absorbed: u64,
    pub publications: u64,
}

impl Activity {
    pub fn snapshot(&self) -> ActivitySnapshot {
        let get = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        ActivitySnapshot {
            analyses: get(&self.analyses),
            full_scans: get(&self.full_scans),
            inventories: get(&self.inventories),
            targeted: get(&self.targeted),
            reconciliations: get(&self.reconciliations),
            absorbed: get(&self.absorbed),
            publications: get(&self.publications),
        }
    }
}

/// A watched source root, already resolved (see [`resolve_existing`]).
#[derive(Clone, Debug)]
pub struct Root {
    pub source_id: String,
    pub path: PathBuf,
}

/// One touched path. `settled` marks a file whose final state an own write
/// already verified: no stability wait. `structural` marks a creation,
/// removal or rename, the only events that make a directory worth listing.
#[derive(Clone, Debug)]
pub struct Change {
    pub path: PathBuf,
    pub settled: bool,
    pub structural: bool,
}

#[derive(Debug, Default)]
pub struct Refreshed {
    pub changed: bool,
    pub revision: i64,
    /// Files still changing: to examine again later, never analysed half-written.
    pub retry: Vec<PathBuf>,
    pub analysed: usize,
    pub missing: u64,
    /// Files owned by an active own write: neither analysed nor concluded
    /// absent, to be handed back once the write is finished.
    pub deferred: Vec<PathBuf>,
    /// The targeted work was published, but related paths could not be read.
    /// The watcher must use its existing reconciliation path to catch up.
    pub reconcile: bool,
}

/// Stable fingerprint of a reconciliation's scope errors: path and reason
/// only, never the detail. A walk limit keeps only its reason, since the entry
/// where it stopped and the count depend on read_dir order and non-pack files.
pub(super) fn scope_errors_fingerprint(errors: &[walk::ScopeError]) -> String {
    let set: BTreeSet<(String, &str)> = errors
        .iter()
        .map(|e| {
            let path = if matches!(e.reason, "depthLimitExceeded" | "itemLimitExceeded") {
                String::new()
            } else {
                crate::support::paths::path_for_frontend(&e.path)
            };
            (path, e.reason)
        })
        .collect();
    serde_json::to_string(&set).unwrap_or_default()
}

struct Known {
    path: PathBuf,
    token: Option<String>,
    file_id: Option<String>,
}

struct AnalysisContext<'a> {
    known: &'a HashMap<Vec<u8>, Known>,
    // Reconciliations already confirm absence from inventory completeness.
    // Only targeted refreshes extend their scope to related old paths.
    related_paths: Option<&'a Exclusions>,
    stability: Duration,
    cancel: &'a AtomicBool,
    registry: &'a super::writes::Registry,
    scope_errors: &'a [walk::ScopeError],
    scope_errors_changed: bool,
}

enum Unit {
    Candidate(PathBuf),
    Subtree(PathBuf),
    Removed(PathBuf),
}

fn is_pack_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mbah" | "zip" | "7z"))
}

/// Only a file the system reports as not found is absent: an access failure
/// (permissions, an I/O error on a flaky volume) proves nothing.
fn confirmed_absent(path: &Path) -> bool {
    matches!(path.symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Resolves the deepest existing ancestor and appends the rest, so a removed
/// path and a path seen through a link compare with the canonical paths the
/// scanner stores.
pub fn resolve_existing(path: &Path) -> PathBuf {
    let mut suffix = Vec::new();
    let mut current = path;
    loop {
        if let Ok(resolved) = std::fs::canonicalize(current) {
            return suffix
                .iter()
                .rev()
                .fold(resolved, |acc, part| acc.join(part));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                suffix.push(name.to_owned());
                current = parent;
            }
            _ => return path.to_owned(),
        }
    }
}

/// The unit a touched path belongs to: the pack directory containing it, the
/// pack file itself, a directory to list, or a removal.
fn unit_for(root: &Path, path: &Path, structural: bool) -> Option<Unit> {
    let exists = path.symlink_metadata().is_ok();
    let first = if exists { 0 } else { 1 };
    for ancestor in path.ancestors().skip(first) {
        if !ancestor.starts_with(root) {
            break;
        }
        if ancestor.is_dir() && walk::is_pack_directory(ancestor) {
            return Some(Unit::Candidate(ancestor.to_owned()));
        }
    }
    if !exists {
        return Some(Unit::Removed(path.to_owned()));
    }
    if path.is_dir() {
        return structural.then(|| Unit::Subtree(path.to_owned()));
    }
    is_pack_file(path).then(|| Unit::Candidate(path.to_owned()))
}

impl Store {
    pub(crate) fn sources_revision(&self) -> Result<i64> {
        self.read(|c| c.query_row("SELECT sources_revision FROM catalogue", [], |r| r.get(0)))
    }

    /// Whether an explicit scan has already indexed this source. In production
    /// the watcher also performs first indexing of sources never scanned, with
    /// reporting installed at startup, so this guard does not block them.
    pub fn has_full_scan(&self, source_id: &str) -> Result<bool> {
        self.read(|c| {
            c.query_row(
                "SELECT count(*)>0 FROM cache.scan
                 WHERE source_id=?1 AND status IN ('complete','incomplete')",
                [source_id],
                |r| r.get(0),
            )
        })
    }

    /// Files of the source the index knows: last conclusive states, plus the
    /// anchors of exemplars still covered by the source.
    fn known_files(&self, source_id: &str) -> Result<HashMap<Vec<u8>, Known>> {
        self.read(|c| {
            let mut known = HashMap::new();
            let mut statement = c.prepare(
                "SELECT path_key,path,content_token,file_id FROM cache.file_state
                 WHERE source_id=?1",
            )?;
            let rows = statement.query_map([source_id], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            for row in rows {
                let (key, path, token, file_id) = row?;
                known.insert(
                    key,
                    Known {
                        path: PathBuf::from(path),
                        token: Some(token),
                        file_id,
                    },
                );
            }
            let mut statement = c.prepare(
                "SELECT DISTINCT e.anchor_json FROM exemplar e
                 JOIN cache.coverage v ON v.exemplar_id=e.id
                 JOIN cache.observation o ON o.exemplar_id=e.id
                 WHERE v.source_id=?1 AND e.retired=0 AND o.state!='missing'",
            )?;
            let rows = statement.query_map([source_id], |r| r.get::<_, String>(0))?;
            for row in rows {
                let anchor: serde_json::Value = serde_json::from_str(&row?).unwrap_or_default();
                let key: Option<Vec<u8>> = serde_json::from_value(anchor["pathKey"].clone()).ok();
                if let (Some(key), Some(path)) = (key, anchor["path"].as_str()) {
                    known.entry(key).or_insert_with(|| Known {
                        path: PathBuf::from(path),
                        token: None,
                        file_id: None,
                    });
                }
            }
            Ok(known)
        })
    }

    /// Selects paths to verify using the identities already recorded by
    /// publication. File identity never transfers a card or its personal data;
    /// UUID association remains owned by `pack_identity` and `publish_targeted`.
    fn associated_file_keys(
        &self,
        source: &str,
        items: &[Scanned],
        known: &HashMap<Vec<u8>, Known>,
    ) -> Result<BTreeSet<Vec<u8>>> {
        // Archive members share a filesystem path and file identity, but each
        // can have its own reliable UUID. Query their UUIDs together once.
        let mut files: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for item in items {
            if !known.contains_key(&item.path_key) && item.observation.state == "available" {
                files.entry(&item.path_key).or_default().push(item);
            }
        }
        if files.is_empty() {
            return Ok(BTreeSet::new());
        }
        #[cfg(test)]
        if self
            .activity
            .related_path_lookup_fails
            .load(Ordering::Relaxed)
        {
            return Err(error("related path lookup unavailable"));
        }
        self.read(|c| {
            // No index on file_id is needed: load only this source once, then
            // resolve each new file's native identity in memory.
            #[cfg(test)]
            self.activity
                .related_file_map_loads
                .fetch_add(1, Ordering::Relaxed);
            let mut by_file_id: HashMap<String, BTreeSet<Vec<u8>>> = HashMap::new();
            let mut statement = c.prepare(RELATED_FILE_IDS)?;
            let rows = statement.query_map([source], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            for row in rows {
                let (id, key) = row?;
                if let Some(key) = key.and_then(|key| serde_json::from_str(&key).ok()) {
                    by_file_id.entry(id).or_default().insert(key);
                }
            }
            let mut keys = BTreeSet::new();
            let mut uuid_statement = c.prepare(RELATED_UUID_KEYS)?;
            for members in files.values() {
                if let Some(old) = members
                    .iter()
                    .find_map(|item| item.file_id.as_ref())
                    .and_then(|id| by_file_id.get(id))
                {
                    keys.extend(old.iter().cloned());
                }
                let uuids: BTreeSet<_> = members
                    .iter()
                    .filter_map(|item| item.observation.uuid())
                    .collect();
                if uuids.is_empty() {
                    continue;
                }
                #[cfg(test)]
                self.activity
                    .related_uuid_queries
                    .fetch_add(1, Ordering::Relaxed);
                let rows = uuid_statement
                    .query_map([serde_json::json!(uuids).to_string()], |r| {
                        r.get::<_, Option<String>>(0)
                    })?;
                for row in rows {
                    if let Some(key) = row?.and_then(|key| serde_json::from_str(&key).ok()) {
                        keys.insert(key);
                    }
                }
            }
            Ok(keys)
        })
    }

    /// An unchanged file whose exemplars are marked unavailable or missing
    /// (its volume came back) must be published again.
    fn needs_restore(&self, key: &[u8]) -> Result<bool> {
        let locator = serde_json::json!({ "pathKey": key }).to_string();
        self.read(|c| {
            c.query_row(
                "SELECT count(*)>0 FROM cache.observation o JOIN exemplar e ON e.id=o.exemplar_id
                 WHERE json_extract(e.anchor_json,'$.pathKey')=json_extract(?1,'$.pathKey')
                   AND e.retired=0 AND o.state IN ('unavailable','missing')",
                [locator],
                |r| r.get(0),
            )
        })
    }

    /// Refreshes only the units the touched paths belong to.
    pub fn refresh_paths(
        &self,
        root: &Root,
        changes: &[Change],
        exclusions: &Exclusions,
        stability: Duration,
        cancel: &AtomicBool,
        registry: &super::writes::Registry,
    ) -> Result<Refreshed> {
        self.activity.targeted.fetch_add(1, Ordering::Relaxed);
        // A hung root (dead network mount) is left to the watcher, which marks
        // it unavailable and reconciles it when it answers again: probing each
        // touched path would hang this pass too.
        let Some(reachable) = probe::is_dir(&root.path) else {
            return Ok(Refreshed::default());
        };
        // Changed paths below are canonicalized. Put their boundary in the
        // same spelling too (Windows extended prefixes and source aliases).
        let resolved_root = Root {
            source_id: root.source_id.clone(),
            path: resolve_existing(&root.path),
        };
        let root = &resolved_root;
        // Restore durable anchors before unchanged-file detection: a native
        // restore can keep exactly the previous size, date and file identity.
        self.restore_trashed_paths(&changes.iter().map(|c| c.path.clone()).collect::<Vec<_>>())?;
        let retired = self.retire_excluded(&root.source_id, exclusions)?;
        let known = self.known_files(&root.source_id)?;
        let mut candidates: BTreeMap<PathBuf, bool> = BTreeMap::new();
        let mut removed: BTreeSet<Vec<u8>> = BTreeSet::new();
        let remove_under = |prefix: &Path, removed: &mut BTreeSet<Vec<u8>>| {
            // Stored paths use the display form (no Windows verbatim prefix).
            let prefix = PathBuf::from(crate::support::paths::path_for_frontend(prefix));
            for (key, file) in &known {
                if file.path.starts_with(&prefix)
                    && matches!(exclusions.classify(&file.path, None), Ok(None))
                    && confirmed_absent(&file.path)
                {
                    removed.insert(key.clone());
                }
            }
        };
        let mut retry = Vec::new();
        for change in changes {
            let path = resolve_existing(&change.path);
            if !walk::within_source(&root.path, &path) {
                continue;
            }
            match exclusions.classify(&change.path, Some(&path)) {
                Ok(Some(_)) => continue,
                Err(()) => {
                    retry.push(change.path.clone());
                    continue;
                }
                Ok(None) => {}
            }
            match unit_for(&root.path, &path, change.structural) {
                Some(Unit::Candidate(unit)) => match exclusions.classify(&unit, Some(&unit)) {
                    Ok(None) => {
                        let settled = candidates.entry(unit).or_insert(change.settled);
                        *settled &= change.settled;
                    }
                    Err(()) => retry.push(change.path.clone()),
                    Ok(Some(_)) => {}
                },
                Some(Unit::Subtree(directory)) => {
                    let found = walk::discover(&directory, exclusions, cancel, |_, _| {});
                    for candidate in &found.candidates {
                        candidates.entry(candidate.clone()).or_insert(false);
                    }
                    if found.complete {
                        remove_under(&directory, &mut removed);
                    } else {
                        retry.push(change.path.clone());
                    }
                }
                Some(Unit::Removed(gone)) if reachable => remove_under(&gone, &mut removed),
                Some(Unit::Removed(_)) | None => {}
            }
        }
        let mut result = self.analyse_and_publish(
            root,
            candidates.into_iter().collect(),
            removed.into_iter().collect(),
            AnalysisContext {
                known: &known,
                related_paths: Some(exclusions),
                stability,
                cancel,
                registry,
                scope_errors: &[],
                scope_errors_changed: false,
            },
        )?;
        result.retry.extend(retry);
        result.changed |= retired.is_some();
        Ok(result)
    }

    /// Compares the whole source with the index and reanalyses only what
    /// differs (size, date or file identity), then confirms the absences of a
    /// completely listed source. An unreachable root only marks its exemplars
    /// unavailable.
    pub fn reconcile_source(
        &self,
        root: &Root,
        exclusions: &Exclusions,
        stability: Duration,
        cancel: &AtomicBool,
        is_deferred: &dyn Fn(&Path) -> bool,
        registry: &super::writes::Registry,
    ) -> Result<Refreshed> {
        // The watcher performs first indexing even for a source never scanned.
        // Production installs reporting before starting it, so has_full_scan
        // does not block first indexing there; it guards silent callers only.
        if !self.has_full_scan(&root.source_id)? && !self.reports_automatic_refresh()? {
            return Ok(Refreshed::default());
        }
        self.activity
            .reconciliations
            .fetch_add(1, Ordering::Relaxed);
        if probe::is_dir(&root.path) != Some(true) {
            let access_changed = self.note_source_access(&root.source_id, "unavailable")?;
            let mut result = self.mark_source_unavailable(&root.source_id)?;
            result.changed |= access_changed;
            if access_changed {
                if let Some(auto) = self.begin_automatic_refresh(root, 0)? {
                    let probed = root.path.clone();
                    // A probe that does not answer is a hung volume.
                    let metadata_error =
                        probe::bounded(&root.path, probe::PROBE_TIMEOUT, move || {
                            std::fs::metadata(&probed).err().map(|e| e.kind())
                        })
                        .unwrap_or(Some(std::io::ErrorKind::NotFound));
                    let reason = match metadata_error {
                        Some(std::io::ErrorKind::NotFound) => "volumeUnavailable",
                        Some(std::io::ErrorKind::PermissionDenied) => "accessDenied",
                        _ => "unreadableUnknown",
                    };
                    auto.update(|p| {
                        p.roots.failed = 1;
                        p.record_scope_error(
                            crate::support::paths::path_for_frontend(&root.path),
                            reason,
                            metadata_error.map(|e| e.to_string()).unwrap_or_default(),
                        );
                    });
                    // The unreachable root makes the reported operation
                    // partial; the watcher itself gets no retry for it, as
                    // before (the root's return is detected separately).
                    let revision = result.revision;
                    result.retry.push(root.path.clone());
                    auto.finish(&Ok(result));
                    return Ok(Refreshed {
                        changed: true,
                        revision,
                        ..Default::default()
                    });
                }
            }
            return Ok(result);
        }
        let retired = self.retire_excluded(&root.source_id, exclusions)?;
        self.activity.inventories.fetch_add(1, Ordering::Relaxed);
        let mut found = walk::discover(&root.path, exclusions, cancel, |_, _| {});
        for path in self.explicit_output_paths(&root.source_id)? {
            if path.exists()
                && !found.candidates.contains(&path)
                && matches!(exclusions.classify(&path, Some(&path)), Ok(None))
            {
                found.candidates.push(path);
            }
        }
        // Scope errors are reported only when their fingerprint changes (new
        // or resolved), across restarts; a cut-short walk concludes nothing.
        let fingerprint = (self.reports_automatic_refresh()? && !cancel.load(Ordering::Relaxed))
            .then(|| scope_errors_fingerprint(&found.errors));
        let (access_changed, scope_errors_changed) = self.note_source_scan(
            &root.source_id,
            if found.errors.iter().any(|failure| failure.path == root.path) {
                "unavailable"
            } else {
                "available"
            },
            fingerprint.as_deref(),
            found.errors.is_empty(),
        )?;
        let known = self.known_files(&root.source_id)?;
        let mut removed = Vec::new();
        let (deferred, candidates): (Vec<_>, Vec<_>) = found
            .candidates
            .iter()
            .cloned()
            .partition(|path| is_deferred(path));
        if found.complete && !cancel.load(Ordering::Relaxed) {
            let seen: BTreeSet<Vec<u8>> = found
                .candidates
                .iter()
                .map(|path| super::path_identity::key(path))
                .collect();
            removed = known
                .iter()
                .filter(|(key, file)| {
                    !seen.contains(*key) && !is_deferred(&file.path) && confirmed_absent(&file.path)
                })
                .map(|(key, _)| key.clone())
                .collect();
        }
        let candidates = candidates.into_iter().map(|p| (p, false)).collect();
        let mut result = self.analyse_and_publish(
            root,
            candidates,
            removed,
            AnalysisContext {
                known: &known,
                related_paths: None,
                stability,
                cancel,
                registry,
                scope_errors: &found.errors,
                scope_errors_changed,
            },
        )?;
        result.deferred = deferred;
        result.changed |= access_changed || retired.is_some();
        Ok(result)
    }

    fn note_source_access(&self, source: &str, availability: &str) -> Result<bool> {
        Ok(self.note_source_scan(source, availability, None, true)?.0)
    }

    /// Records availability and, when given, the scope errors fingerprint in
    /// one transaction. Returns whether each changed. A fingerprint never
    /// recorded (NULL) counts as changed only when there are errors to show.
    fn note_source_scan(
        &self,
        source: &str,
        availability: &str,
        fingerprint: Option<&str>,
        no_errors: bool,
    ) -> Result<(bool, bool)> {
        self.write(|tx| {
            let previous: Option<(String, Option<String>)> = tx.query_row("SELECT availability,scope_errors_fingerprint FROM source_health WHERE source_id=?1", [source], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(error)?;
            let access_changed = previous.as_ref().map(|p| p.0.as_str()) != Some(availability);
            if access_changed {
                tx.execute("INSERT INTO source_health(source_id,availability) VALUES (?1,?2) ON CONFLICT(source_id) DO UPDATE SET availability=excluded.availability", rusqlite::params![source, availability]).map_err(error)?;
                tx.execute("UPDATE catalogue SET revision=revision+1", []).map_err(error)?;
            }
            let Some(fingerprint) = fingerprint else { return Ok((access_changed, false)) };
            let scope_changed = match previous.and_then(|p| p.1) {
                Some(stored) => stored != fingerprint,
                None => !no_errors,
            };
            // Internal bookkeeping: no catalogue revision for the fingerprint.
            tx.execute("UPDATE source_health SET scope_errors_fingerprint=?2 WHERE source_id=?1", rusqlite::params![source, fingerprint]).map_err(error)?;
            Ok((access_changed, scope_changed))
        })
    }

    fn mark_source_unavailable(&self, source_id: &str) -> Result<Refreshed> {
        self.write(|tx| {
            let changed = tx
                .execute(
                    "UPDATE cache.observation SET state='unavailable'
                     WHERE state!='unavailable' AND exemplar_id IN
                       (SELECT exemplar_id FROM cache.coverage WHERE source_id=?1)",
                    [source_id],
                )
                .map_err(error)?
                > 0;
            if changed {
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(error)?;
            }
            let revision = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            Ok(Refreshed {
                changed,
                revision,
                ..Refreshed::default()
            })
        })
    }

    fn analyse_and_publish(
        &self,
        root: &Root,
        candidates: Vec<(PathBuf, bool)>,
        mut removed: Vec<Vec<u8>>,
        context: AnalysisContext<'_>,
    ) -> Result<Refreshed> {
        // Decide the operation's scope before publishing it. Unchanged packs
        // need neither a stability wait nor an entry in a visible scan report.
        let mut changed = Vec::new();
        for (path, settled) in candidates {
            let key = super::path_identity::key(&path);
            let state = self.content_state(&path).ok();
            let unchanged = context.known.get(&key).is_some_and(|known| {
                known.token.as_deref() == state.as_ref().map(|state| state.token.0.as_str())
                    && (known.file_id.is_none() || known.file_id == super::writes::file_id(&path))
            });
            let mut analysis_stale = state.as_ref().is_some_and(|s| s.analysis_stale);
            let restore = self.needs_restore(&key)?;
            // A stale or pending analysis of unchanged content is retried at
            // most once per session (any analysis of that content counts): a
            // solid pass whose tool keeps failing would otherwise decompress
            // the archive and show an operation at every periodic pass.
            let token = state.as_ref().map(|s| s.token.0.clone());
            let mut retried = self.stale_retries.lock().map_err(error)?;
            if analysis_stale
                && unchanged
                && !settled
                && !restore
                && token.is_some()
                && retried.get(&key) == token.as_ref()
            {
                analysis_stale = false;
            }
            if settled || !unchanged || analysis_stale || restore {
                if let Some(token) = token {
                    retried.insert(key, token);
                }
                changed.push((path, settled, analysis_stale));
            }
        }
        // Removals owned by a write in progress are not concluded this pass;
        // drop them before counting the operation's candidates.
        let pending = self.pending_file_paths()?;
        removed.retain(|key| {
            context.known.get(key).is_none_or(|file| {
                context
                    .registry
                    .classify(&file.path, std::time::Instant::now())
                    != super::writes::Verdict::Deferred
                    && !pending
                        .iter()
                        .any(|p| file.path.starts_with(p) || p.starts_with(&file.path))
            })
        });
        let automatic = if changed.iter().any(|(_, settled, _)| !settled)
            || !removed.is_empty()
            || context.scope_errors_changed
        {
            self.begin_automatic_refresh(root, changed.len() + removed.len())?
        } else {
            None
        };
        if let Some(auto) = &automatic {
            if !context.scope_errors.is_empty() {
                auto.update(|p| {
                    p.roots.failed = 1;
                    p.directories.errors = context.scope_errors.len() as u64;
                    for failure in context.scope_errors {
                        p.record_scope_error(
                            crate::support::paths::path_for_frontend(&failure.path),
                            failure.reason,
                            failure.detail.clone(),
                        );
                    }
                });
            }
        }
        let result = (|| {
            let AnalysisContext {
                known,
                related_paths,
                stability,
                cancel,
                registry,
                scope_errors: _,
                scope_errors_changed: _,
            } = context;
            let analysis = registry.analysis_guard();
            let expected = self.sources_revision()?;
            let pending = self.pending_file_paths()?;
            let blocked = |path: &Path| {
                pending
                    .iter()
                    .any(|p| path.starts_with(p) || p.starts_with(path))
            };
            let first: Vec<_> = changed
                .into_iter()
                .map(|(path, settled, analysis_stale)| {
                    let initial = (!settled).then(|| self.content_token(&path).ok());
                    (path, initial, analysis_stale)
                })
                .collect();
            // One shared interval: two observations of size and date.
            if first.iter().any(|(_, initial, _)| initial.is_some()) {
                std::thread::sleep(stability);
            }
            let mut result = Refreshed::default();
            let mut items = Vec::new();
            for (path, initial, analysis_stale) in first {
                if registry.classify(&path, std::time::Instant::now())
                    == super::writes::Verdict::Deferred
                    || blocked(&path)
                {
                    result.retry.push(path);
                    continue;
                }
                if cancel.load(Ordering::Relaxed)
                    || automatic.as_ref().is_some_and(|a| a.cancelled())
                {
                    result.retry.push(path);
                    continue;
                }
                let key = super::path_identity::key(&path);
                let current = self.content_token(&path);
                if let Err(failure) = &current {
                    // A known pack confirmed absent becomes a removal, reported
                    // once with the other removals after publication.
                    let absent = failure.kind() == std::io::ErrorKind::NotFound
                        && probe::is_dir(&root.path) == Some(true);
                    let removal = absent && known.contains_key(&key);
                    if !removal {
                        if let Some(auto) = &automatic {
                            auto.update(|p| {
                                p.record(
                                    crate::support::paths::path_for_frontend(&path),
                                    None,
                                    "error",
                                    Some(match failure.kind() {
                                        std::io::ErrorKind::NotFound => "fileDisappeared",
                                        std::io::ErrorKind::PermissionDenied => "accessDenied",
                                        _ => "unreadableUnknown",
                                    }),
                                )
                            });
                        }
                    }
                    if removal {
                        removed.push(key);
                    } else if !absent {
                        result.retry.push(path);
                    }
                    continue;
                }
                if initial.is_some_and(|initial| initial.as_ref() != current.as_ref().ok()) {
                    result.retry.push(path);
                    continue;
                }
                let unchanged = known.get(&key).is_some_and(|file| {
                    file.token.as_deref() == current.as_ref().ok().map(|t| t.0.as_str())
                        && (file.file_id.is_none() || file.file_id == super::writes::file_id(&path))
                });
                if unchanged && !analysis_stale && !self.needs_restore(&key)? {
                    if let Some(auto) = &automatic {
                        auto.update(|p| {
                            p.record(
                                crate::support::paths::path_for_frontend(&path),
                                None,
                                "unchanged",
                                None,
                            )
                        });
                    }
                    continue;
                }
                // Change detection includes the stored sounds; the analysis
                // itself compares the file's own size and date, as before.
                let base = current
                    .as_ref()
                    .map(|(token, date, size)| {
                        (
                            token.split('|').next().unwrap_or(token).to_owned(),
                            *date,
                            *size,
                        )
                    })
                    .map_err(|e| std::io::Error::new(e.kind(), e.to_string()));
                let mut observed = self.observe_listening(&root.source_id, &path, &base, cancel);
                for item in &mut observed {
                    if item.observation.member.is_none()
                        && item.observation.format == "project"
                        && item.observation.uuid().is_some()
                    {
                        item.save_prestate = self.attested_prestate(registry, &path)?;
                    }
                }
                result.analysed += 1;
                if let Some(auto) = &automatic {
                    auto.update(|p| {
                        p.current_directory =
                            path.parent().map(crate::support::paths::path_for_frontend);
                        p.candidates.discovered += observed.len().saturating_sub(1) as u64;
                        p.candidates.processed += observed.len() as u64;
                    });
                }
                if observed
                    .iter()
                    .any(|item| item.observation.state == "fileUnstable")
                {
                    if let Some(auto) = &automatic {
                        auto.update(|p| {
                            p.candidates.processed =
                                p.candidates.processed.saturating_sub(observed.len() as u64);
                            p.record(
                                crate::support::paths::path_for_frontend(&path),
                                None,
                                "error",
                                Some("fileUnstable"),
                            );
                        });
                    }
                    result.retry.push(path);
                    continue;
                }
                items.extend(observed);
            }
            // A debouncer can deliver only the destination of a move, even
            // when it was discovered by listing a newly created directory.
            // Check associated old paths outside that directory as well; the
            // existing publication still decides card identity and continuity.
            let mut checked: BTreeSet<_> = removed.iter().cloned().collect();
            if let Some(exclusions) = related_paths.filter(|_| !cancel.load(Ordering::Relaxed)) {
                let keys = match self.associated_file_keys(&root.source_id, &items, known) {
                    Ok(keys) => keys,
                    Err(_) => {
                        // Related-path lookup is supplementary: never discard
                        // successfully analysed destination files on failure.
                        result.reconcile = true;
                        BTreeSet::new()
                    }
                };
                for key in keys {
                    let Some(file) = known.get(&key) else {
                        continue;
                    };
                    if !checked.insert(key.clone()) {
                        continue;
                    }
                    match exclusions.classify(&file.path, None) {
                        Ok(Some(_)) => continue,
                        Err(()) => {
                            result.retry.push(file.path.clone());
                            continue;
                        }
                        Ok(None) => {}
                    }
                    if registry.classify(&file.path, std::time::Instant::now())
                        == super::writes::Verdict::Deferred
                        || blocked(&file.path)
                        || probe::is_dir(&root.path) != Some(true)
                    {
                        result.retry.push(file.path.clone());
                    } else if confirmed_absent(&file.path) {
                        removed.push(key);
                        if let Some(auto) = &automatic {
                            auto.update(|p| p.candidates.discovered += 1);
                        }
                    }
                }
            }
            removed.retain(|key| {
                known.get(key).is_none_or(|file| {
                    registry.classify(&file.path, std::time::Instant::now())
                        != super::writes::Verdict::Deferred
                        && !blocked(&file.path)
                })
            });
            removed.sort();
            removed.dedup();
            if items.is_empty() && removed.is_empty() {
                result.revision =
                    self.read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))?;
                return Ok(result);
            }
            let id = format!("refresh-{}", uuid::Uuid::new_v4());
            let published: Published =
                self.publish_targeted(&id, expected, &root.source_id, &items, &removed)?;
            if let Some(auto) = &automatic {
                auto.update(|p| {
                    // Before publication only analysis progress is known; outcomes
                    // become definite with the committed batch.
                    p.candidates.processed = p.outcomes.unchanged + p.outcomes.error;
                    p.cards.created = published.cards_created;
                    p.cards.updated = published.cards_updated;
                    for key in &removed {
                        if let Some(file) = known.get(key) {
                            p.record(
                                crate::support::paths::path_for_frontend(&file.path),
                                None,
                                "removed",
                                Some("fileDisappeared"),
                            );
                        }
                    }
                    for (item, outcome) in items.iter().zip(&published.outcomes) {
                        p.record(
                            item.path.clone(),
                            item.observation.member.clone(),
                            outcome,
                            (item.observation.state != "available")
                                .then_some(item.observation.state.as_str()),
                        );
                        if let Some(last) = p.report.last_mut() {
                            last.detail = (!item.observation.diagnostics.is_empty())
                                .then(|| item.observation.diagnostics.join("\n"));
                        }
                    }
                });
            }
            for item in &items {
                if item.observation.state == "available" {
                    registry.acknowledge_save(Path::new(&item.path));
                }
            }
            if published.changed {
                self.activity.publications.fetch_add(1, Ordering::Relaxed);
            }
            result.changed = published.changed;
            result.revision = published.revision;
            // Publish metadata before the one-off solid-archive pass. All other
            // changed files have already been analysed and published. The pass
            // runs without the analysis guard, so writers are not held while an
            // archive is decompressed; publication takes the guard again.
            drop(analysis);
            let paths = items
                .iter()
                .filter(|i| i.observation.listening_pending)
                .map(|i| i.path.clone())
                .collect::<BTreeSet<_>>();
            for path in paths {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let pending_items = items
                    .iter()
                    .filter(|i| i.path == path)
                    .cloned()
                    .collect::<Vec<_>>();
                let completed = match self.solid_pass(Path::new(&path), &pending_items, cancel) {
                    super::scan::SolidPass::Publish(items) => items,
                    super::scan::SolidPass::Keep => continue,
                    super::scan::SolidPass::Cancelled => break,
                };
                let _analysis = registry.analysis_guard();
                if cancel.load(Ordering::Relaxed) || self.sources_revision()? != expected {
                    break;
                }
                if !self.listening_publishable(registry, Path::new(&path), &completed)? {
                    continue;
                }
                let enriched =
                    self.publish_targeted(&id, expected, &root.source_id, &completed, &[])?;
                result.changed |= enriched.changed;
                result.revision = enriched.revision;
            }

            result.missing = published.missing;
            Ok(result)
        })();
        if let Some(automatic) = automatic {
            automatic.finish(&result);
        }
        result
    }
}
