//! Fiche-scoped, cancellable byte equality. Only metadata is read before size grouping.
//! Fingerprints live for the Store's lifetime; no durable schema change is needed.
use super::{duplicates, error, fail, formats, patch, Result, Store};
use crate::support::user_message::codes;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

#[derive(Default)]
pub(crate) struct Registry {
    worker: Arc<Mutex<()>>,
    hashes: HashMap<(PathBuf, String), (String, String)>,
    // Only cancellation tombstones expire; a long-running hash must remain cancellable.
    requests: HashMap<String, (Option<Instant>, Arc<AtomicBool>)>,
}

const REQUEST_LIMIT: usize = 1024;
const TOMBSTONE_LIFETIME: Duration = Duration::from_secs(900);

impl Registry {
    /// Makes room for `request`. Expired tombstones go first, then the oldest
    /// live ones: a tombstone only guards against a late start of a closed
    /// request and must never refuse a new one. Only running requests count
    /// against the limit.
    fn admit(&mut self, request: &str) -> Result<()> {
        self.requests
            .retain(|_, (time, _)| time.is_none_or(|time| time.elapsed() < TOMBSTONE_LIFETIME));
        if self.requests.contains_key(request) {
            return Ok(());
        }
        while self.requests.len() >= REQUEST_LIMIT {
            let oldest = self
                .requests
                .iter()
                .filter_map(|(key, (time, _))| time.map(|time| (time, key)))
                .min()
                .map(|(_, key)| key.clone());
            let Some(oldest) = oldest else {
                return Err(fail(codes::CATALOG_OPERATION_LIMIT));
            };
            self.requests.remove(&oldest);
        }
        Ok(())
    }
}

// A directory's own mtime does not track edits to its children. Include every
// relative path, size and nanosecond timestamp, without reading file contents.
fn metadata_token(path: &Path, cancel: &AtomicBool) -> Result<(u64, String)> {
    fn walk(
        path: &Path,
        relative: PathBuf,
        rows: &mut Vec<(PathBuf, u64, u128)>,
        size: &mut u64,
        cancel: &AtomicBool,
        depth: usize,
    ) -> Result<()> {
        patch::check(cancel)?;
        if depth > 64 || rows.len() >= 100000 {
            return Err(fail(codes::CATALOG_DUPLICATE_HASH_FAILED));
        }
        let metadata = patch::regular(path)?;
        let time = metadata
            .modified()
            .map_err(error)?
            .duration_since(UNIX_EPOCH)
            .map_err(error)?
            .as_nanos();
        rows.push((relative.clone(), metadata.len(), time));
        if metadata.is_dir() {
            for child in std::fs::read_dir(path).map_err(error)? {
                let child = child.map_err(error)?;
                walk(
                    &child.path(),
                    relative.join(child.file_name()),
                    rows,
                    size,
                    cancel,
                    depth + 1,
                )?;
            }
        } else {
            *size = size.saturating_add(metadata.len());
        }
        Ok(())
    }
    let mut rows = Vec::new();
    let mut size = 0;
    walk(path, PathBuf::new(), &mut rows, &mut size, cancel, 0)?;
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((size, serde_json::to_string(&rows).map_err(error)?))
}

struct Candidate {
    id: String,
    path: PathBuf,
    format: String,
    chain: Vec<Value>,
    token: String,
    size: u64,
    modified: i64,
}

fn copies(
    candidates: Vec<Candidate>,
    cancel: &AtomicBool,
    mut hash: impl FnMut(&Candidate) -> Result<String>,
) -> Result<Vec<String>> {
    let mut sizes: BTreeMap<u64, Vec<Candidate>> = BTreeMap::new();
    for candidate in candidates {
        sizes.entry(candidate.size).or_default().push(candidate);
    }
    let mut identical = Vec::new();
    for mut group in sizes.into_values().filter(|group| group.len() > 1) {
        // Stable tie break: one implicit reference even with equal timestamps.
        group.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        let mut seen = std::collections::HashSet::new();
        for candidate in group {
            patch::check(cancel)?;
            if let Ok(digest) = hash(&candidate) {
                if !seen.insert(digest) {
                    identical.push(candidate.id);
                }
            }
        }
    }
    patch::check(cancel)?;
    Ok(identical)
}

fn cached_hash(
    registry: &Mutex<Registry>,
    candidate: &Candidate,
    cancel: &AtomicBool,
    read: impl FnOnce() -> Result<String>,
) -> Result<String> {
    let worker = Arc::clone(&registry.lock().map_err(error)?.worker);
    let _worker = worker.lock().map_err(error)?;
    patch::check(cancel)?;
    let key = (
        candidate.path.clone(),
        serde_json::to_string(&candidate.chain).map_err(error)?,
    );
    if let Some((token, hash)) = registry.lock().map_err(error)?.hashes.get(&key) {
        if token == &candidate.token {
            return Ok(hash.clone());
        }
    }
    let hash = read()?;
    patch::check(cancel)?;
    registry
        .lock()
        .map_err(error)?
        .hashes
        .insert(key, (candidate.token.clone(), hash.clone()));
    Ok(hash)
}

impl Store {
    pub fn cancel_identical_copies(&self, request: String) -> Result<()> {
        if request.is_empty() || request.len() > 200 {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let mut registry = self.identical_copies.lock().map_err(error)?;
        registry.admit(&request)?;
        // A tombstone also handles a close arriving before the worker starts.
        registry
            .requests
            .entry(request)
            .or_insert_with(|| (Some(Instant::now()), Arc::new(AtomicBool::new(false))))
            .1
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub fn identical_copies(&self, fiche: &str, request: String) -> Result<Vec<String>> {
        if fiche.is_empty() || request.is_empty() || request.len() > 200 {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let cancel = {
            let mut registry = self.identical_copies.lock().map_err(error)?;
            registry.admit(&request)?;
            let entry = registry
                .requests
                .entry(request.clone())
                .or_insert_with(|| (None, Arc::new(AtomicBool::new(false))));
            entry.0 = None;
            Arc::clone(&entry.1)
        };
        let result = (|| {
            patch::check(&cancel)?;
            let rows = self.read(|c| {
                let mut q = c.prepare("SELECT e.id,e.anchor_json,o.format,o.raw_observation_json,o.modified_at FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.fiche_id=?1 AND e.retired=0 AND o.state='available' AND EXISTS (SELECT 1 FROM cache.coverage cv JOIN source s ON s.id=cv.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE cv.exemplar_id=e.id AND s.status='active' AND COALESCE(h.availability,'available')!='unavailable') ORDER BY e.id")?;
                let rows = q.query_map([fiche], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<i64>>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
                Ok(rows)
            })?;
            let mut candidates = Vec::new();
            for (id, anchor, format, raw, modified) in rows {
                patch::check(&cancel)?;
                let anchor: Value = serde_json::from_str(&anchor).map_err(error)?;
                let raw: Value = serde_json::from_str(&raw).map_err(error)?;
                let Some(path) = anchor["path"]
                    .as_str()
                    .filter(|path| !path.is_empty())
                    .map(PathBuf::from)
                else {
                    continue;
                };
                let Ok((size, token)) = metadata_token(&path, &cancel) else {
                    continue;
                };
                let chain = raw["chain"].as_array().cloned().unwrap_or_default();
                // An archive child's size is its member's, read from the
                // container's index (the observation's byte size is the whole
                // archive's). A member that cannot be sized this way is not
                // compared: see `formats::member_size`.
                let size = if chain.is_empty() {
                    size
                } else {
                    match formats::member_size(&path, &format, &chain, &cancel) {
                        Ok(Some(size)) => size,
                        Ok(None) => continue,
                        Err(_) => {
                            patch::check(&cancel)?;
                            continue;
                        }
                    }
                };
                candidates.push(Candidate {
                    id,
                    path,
                    format,
                    chain,
                    token,
                    size,
                    modified: modified.unwrap_or(0),
                });
            }
            copies(candidates, &cancel, |candidate| {
                cached_hash(&self.identical_copies, candidate, &cancel, || {
                    let hash = if candidate.chain.is_empty() {
                        duplicates::digest(&candidate.path, &cancel)?
                    } else {
                        let scratch = formats::Scratch::new()?;
                        let input = formats::view(
                            &candidate.path,
                            &candidate.format,
                            &candidate.chain,
                            &scratch.path,
                            &cancel,
                        )?;
                        duplicates::digest(&input, &cancel)?
                    };
                    if metadata_token(&candidate.path, &cancel)?.1 != candidate.token {
                        return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
                    }
                    Ok(hash)
                })
            })
        })();
        self.identical_copies
            .lock()
            .map_err(error)?
            .requests
            .remove(&request);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(id: &str, size: u64, modified: i64) -> Candidate {
        Candidate {
            id: id.into(),
            path: id.into(),
            format: "zip".into(),
            chain: vec![],
            token: "size:mtime-ns".into(),
            size,
            modified,
        }
    }
    #[test]
    fn identical_marks_only_older_equal_content_and_never_reads_unique_sizes() {
        let cancel = AtomicBool::new(false);
        let mut reads = vec![];
        let result = copies(
            vec![
                candidate("old", 10, 1),
                candidate("new", 10, 3),
                candidate("different", 10, 2),
                candidate("unique", 11, 4),
            ],
            &cancel,
            |c| {
                reads.push(c.id.clone());
                Ok(if c.id == "different" { "other" } else { "same" }.into())
            },
        )
        .unwrap();
        assert_eq!(result, vec!["old"]);
        assert_eq!(reads, vec!["new", "different", "old"]);
        copies(
            vec![candidate("a", 1, 1), candidate("b", 2, 2)],
            &cancel,
            |_| panic!("different sizes must not read content"),
        )
        .unwrap();
    }
    #[test]
    fn unchanged_tokens_reuse_hashes_and_changed_tokens_read_again() {
        let registry = Mutex::new(Registry::default());
        let cancel = AtomicBool::new(false);
        let mut c = candidate("file", 10, 1);
        assert_eq!(
            cached_hash(&registry, &c, &cancel, || Ok("first".into())).unwrap(),
            "first"
        );
        assert_eq!(
            cached_hash(&registry, &c, &cancel, || panic!("unchanged file reread")).unwrap(),
            "first"
        );
        c.token = "same-size:new-nanoseconds".into();
        assert_eq!(
            cached_hash(&registry, &c, &cancel, || Ok("changed".into())).unwrap(),
            "changed"
        );
        assert!(
            cached_hash(&registry, &c, &AtomicBool::new(true), || panic!(
                "cancelled read"
            ))
            .is_err()
        );
    }
    #[test]
    fn folder_token_tracks_nested_edits_even_when_sizes_match() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let file = root.join("nested/audio");
        std::fs::write(&file, b"abc").unwrap();
        let cancel = AtomicBool::new(false);
        let before = metadata_token(&root, &cancel).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_nanos(1234567890))
            .unwrap();
        let after = metadata_token(&root, &cancel).unwrap();
        assert_eq!(before.0, after.0);
        assert_ne!(before.1, after.1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
