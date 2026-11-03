//! On-demand diagnostics; no fingerprints or conformance results enter the index.
use super::{fail, formats, patch, Result};
use crate::services::catalogue::{
    scan,
    store::{error, Store},
};
use crate::support::user_message::codes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub fiche_id: Option<String>,
}
#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub exact_groups: Vec<ExactGroup>,
    pub older_versions: Vec<OlderVersion>,
    pub issues: Vec<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactGroup {
    pub digest: String,
    pub exemplar_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OlderVersion {
    pub uuid: String,
    pub format: String,
    pub exemplar_ids: Vec<String>,
}
#[derive(Default)]
pub(crate) struct Registry {
    requests: HashMap<String, (Scope, Value)>,
    results: HashMap<String, Results>,
    completed: HashMap<String, Instant>,
    release_requested: std::collections::HashSet<String>,
}
const RETENTION_SECONDS: u64 = 15 * 60;
impl Registry {
    fn expire(&mut self, now: Instant) {
        let expired = self
            .completed
            .iter()
            .filter(|(_, finished)| {
                now.saturating_duration_since(**finished) >= Duration::from_secs(RETENTION_SECONDS)
            })
            .map(|(id, _)| id.clone())
            .collect::<std::collections::HashSet<_>>();
        self.completed.retain(|id, _| !expired.contains(id));
        self.release_requested.retain(|id| !expired.contains(id));
        self.results.retain(|id, _| !expired.contains(id));
        self.requests.retain(|_, (_, receipt)| {
            !receipt["operationId"]
                .as_str()
                .is_some_and(|id| expired.contains(id))
        });
    }
}
type VersionGroups = BTreeMap<(String, String), Vec<(String, String, Option<u64>)>>;

struct Candidate {
    id: String,
    uuid: Option<String>,
}

/// File hashes cover their actual bytes. Folder hashes cover a sorted manifest
/// of relative paths, directory markers and the SHA-256 of every file's bytes.
/// Neither identities nor modification dates participate in exact equality.
pub(super) fn digest(path: &Path, cancel: &AtomicBool) -> Result<String> {
    let before = patch::snapshot(path, cancel)?;
    let digest = if path.is_dir() {
        let mut manifest = Vec::new();
        fn walk(
            path: &Path,
            relative: Vec<String>,
            rows: &mut Vec<(Vec<String>, String)>,
            cancel: &AtomicBool,
            depth: usize,
        ) -> Result<()> {
            patch::check(cancel)?;
            if depth > 64 || rows.len() >= 100000 {
                return Err(fail(codes::CATALOG_DUPLICATE_HASH_FAILED));
            }
            let metadata = patch::regular(path)?;
            if metadata.is_dir() {
                rows.push((relative.clone(), "directory".into()));
                for child in std::fs::read_dir(path).map_err(error)? {
                    let child = child.map_err(error)?;
                    let mut next = relative.clone();
                    next.push(
                        child
                            .file_name()
                            .to_str()
                            .ok_or_else(|| fail(codes::CATALOG_DUPLICATE_HASH_FAILED))?
                            .to_owned(),
                    );
                    walk(&child.path(), next, rows, cancel, depth + 1)?;
                }
            } else {
                let (hash, _) =
                    patch::hash(&mut std::fs::File::open(path).map_err(error)?, cancel)?;
                rows.push((relative, hash));
            }
            Ok(())
        }
        walk(path, vec![], &mut manifest, cancel, 0)?;
        manifest.sort_by(|a, b| a.0.cmp(&b.0));
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&manifest).map_err(error)?)
        )
    } else {
        before
            .content
            .get("")
            .cloned()
            .ok_or_else(|| fail(codes::CATALOG_DUPLICATE_HASH_FAILED))?
    };
    patch::unchanged(path, &before, cancel)?;
    Ok(digest)
}
fn older(candidates: &[(String, String, Option<u64>)]) -> Vec<String> {
    let maximum = candidates
        .iter()
        .filter_map(|(_, _, version)| *version)
        .max();
    candidates
        .iter()
        .filter(|(_, _, version)| version.zip(maximum).is_some_and(|(a, b)| a < b))
        .map(|(id, _, _)| id.clone())
        .collect()
}
impl Store {
    pub fn find_duplicates(
        self: &Arc<Self>,
        scope: Scope,
        request_id: String,
        sink: scan::Sink,
    ) -> Result<Value> {
        if request_id.is_empty() || request_id.len() > 200 {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let mut registry = self.duplicate_results.lock().map_err(error)?;
        registry.expire(Instant::now());
        if let Some((old, receipt)) = registry.requests.get(&request_id) {
            return if old == &scope {
                Ok(receipt.clone())
            } else {
                Err(fail(codes::CATALOG_MUTATION_INVALID))
            };
        }
        // Active results are never evicted. Completed results may be explicitly
        // released; their small receipts retain idempotence until expiry.
        if registry.results.len() >= 32 || registry.requests.len() >= 1024 {
            return Err(fail(codes::CATALOG_OPERATION_LIMIT));
        }
        let revision = self.list_sources()?.catalogue_revision;
        let candidates: Vec<Candidate> = self.read(|c| {
            let mut q=c.prepare("SELECT e.id,e.verified_uuid,o.format,o.raw_observation_json FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.retired=0 AND o.state='available' AND o.format NOT IN ('project','fsZip') AND (?1 IS NULL OR e.fiche_id=?1) ORDER BY e.id")?;
            let rows=q.query_map([&scope.fiche_id], |r| Ok((Candidate{id:r.get(0)?,uuid:r.get(1)?},r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            // A device pack read from a 7z is excluded like a device ZIP: both
            // are only readable through a conversion whose bytes and stage
            // UUIDs change at each run, so neither an exact digest nor a
            // version comparison would be meaningful.
            Ok(rows
                .into_iter()
                .filter(|(_, format, raw)| {
                    format != "7z"
                        || !raw
                            .as_deref()
                            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                            .is_some_and(|raw| crate::services::catalogue::analyze::is_device_pack(format, &raw))
                })
                .map(|(candidate, _, _)| candidate)
                .collect())
        })?;
        let (receipt, op) =
            self.begin_file_report(&request_id, "duplicates", candidates.len(), sink.clone())?;
        let dto = json!({"operationId":receipt.operation_id,"requestId":request_id,"state":"queued","catalogueRevision":revision,"sourcesRevision":receipt.sources_revision,"retentionSeconds":RETENTION_SECONDS});
        registry.requests.insert(request_id, (scope, dto.clone()));
        registry
            .results
            .insert(receipt.operation_id.clone(), Results::default());
        drop(registry);
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let operation_id = receipt.operation_id.clone();
            let (stop, heartbeat) = std::sync::mpsc::channel::<()>();
            let beat_op = Arc::clone(&op);
            let beat_sink = Arc::clone(&sink);
            let beat = std::thread::spawn(move || {
                while heartbeat.recv_timeout(std::time::Duration::from_millis(500))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    beat_op.emit(&beat_sink, false);
                }
            });
            let run = (|| {
                let _heavy = store.scans.heavy.lock().map_err(error)?;
                let mut exact: BTreeMap<String, Vec<String>> = BTreeMap::new();
                let mut versions = VersionGroups::new();
                let mut results = Results::default();
                for c in candidates {
                    patch::check(&op.cancel)?;
                    store.update_file_report(&op, &sink, |p| {
                        p.status = "running".into();
                        p.current_directory = Some(c.id.clone());
                    });
                    let read: Result<(String, String, Option<u64>)> = (|| {
                        let target = store.resolve_target(&c.id, revision)?;
                        store.update_file_report(&op, &sink, |p| {
                            p.current_directory = Some(target.display_path())
                        });
                        target.require_unchanged(std::time::Duration::from_secs(2))?;
                        let observed = target
                            .observation
                            .as_ref()
                            .ok_or_else(|| fail(codes::CATALOG_DUPLICATE_HASH_FAILED))?;
                        let before = patch::snapshot(&target.path, &op.cancel)?;
                        let scratch = formats::Scratch::new()?;
                        let chain = observed.raw["chain"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        let input = if chain.is_empty() {
                            target.path.clone()
                        } else {
                            formats::view(
                                &target.path,
                                &observed.format,
                                &chain,
                                &scratch.path,
                                &op.cancel,
                            )?
                        };
                        let hash = digest(&input, &op.cancel)?;
                        patch::unchanged(&target.path, &before, &op.cancel)?;
                        let version = if observed.format == "fsDirectory" {
                            None
                        } else {
                            let metadata_input = if !chain.is_empty() || observed.format != "7z" {
                                input.clone()
                            } else {
                                formats::view(
                                    &target.path,
                                    &observed.format,
                                    &chain,
                                    &scratch.path,
                                    &op.cancel,
                                )?
                            };
                            let story = patch::read_story(&metadata_input)?;
                            if c.uuid
                                != super::identity::source_identity(&store, &target.path, &story)
                            {
                                return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
                            }
                            story["version"].as_u64().filter(|v| *v > 0)
                        };
                        patch::unchanged(&target.path, &before, &op.cancel)?;
                        Ok((hash, observed.format.clone(), version))
                    })();
                    let readable = read.is_ok();
                    match read {
                        Ok((hash, format, version)) => {
                            exact.entry(hash).or_default().push(c.id.clone());
                            if let Some(uuid) = c.uuid { versions.entry((uuid,format.clone())).or_default().push((c.id,format,version)); }
                        }
                        Err(e) if op.cancel.load(Ordering::Relaxed) => return Err(e),
                        Err(e) => results.issues.push(json!({"exemplarId":c.id,"code":codes::CATALOG_DUPLICATE_HASH_FAILED,"detail":e.to_string()})),
                    }
                    store.update_file_report(&op, &sink, |p| {
                        p.candidates.processed += 1;
                        if readable {
                            p.outcomes.unchanged += 1;
                        } else {
                            p.outcomes.error += 1;
                        }
                    });
                }
                for (digest, exemplar_ids) in exact {
                    if exemplar_ids.len() > 1 {
                        results.exact_groups.push(ExactGroup {
                            digest,
                            exemplar_ids,
                        });
                    }
                }
                for ((uuid, format), candidates) in versions {
                    let exemplar_ids = older(&candidates);
                    if !exemplar_ids.is_empty() {
                        results.older_versions.push(OlderVersion {
                            uuid,
                            format,
                            exemplar_ids,
                        });
                    }
                }
                patch::check(&op.cancel)?;
                store
                    .duplicate_results
                    .lock()
                    .map_err(error)?
                    .results
                    .insert(receipt.operation_id, results);
                Ok(())
            })();
            let _ = stop.send(());
            let _ = beat.join();
            let cancelled = op.cancel.load(Ordering::Relaxed);
            if let Ok(mut registry) = store.duplicate_results.lock() {
                if registry.release_requested.remove(&operation_id) {
                    registry.results.remove(&operation_id);
                }
                registry.completed.insert(operation_id, Instant::now());
            }
            Store::finish_file_report(&op, &sink, run, revision, cancelled);
        });
        Ok(dto)
    }
    pub fn release_duplicate_results(&self, operation_id: &str) -> Result<Value> {
        let mut registry = self.duplicate_results.lock().map_err(error)?;
        registry.expire(Instant::now());
        let active = registry.results.contains_key(operation_id)
            && !registry.completed.contains_key(operation_id);
        if active {
            // Closing an owner does not discard or cancel a running diagnostic.
            // Its results are released only once the operation has finished.
            registry.release_requested.insert(operation_id.into());
        } else {
            registry.results.remove(operation_id);
        }
        Ok(json!({"released":!active}))
    }
    pub fn duplicate_results(
        &self,
        operation_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Value> {
        if !(1..=200).contains(&limit) {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let mut registry = self.duplicate_results.lock().map_err(error)?;
        registry.expire(Instant::now());
        let result = registry
            .results
            .get(operation_id)
            .ok_or_else(|| fail(codes::CATALOG_OPERATION_EXPIRED))?;
        let total = result.exact_groups.len() + result.older_versions.len() + result.issues.len();
        if offset > total {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        let end = offset.saturating_add(limit).min(total);
        let mut page = Results::default();
        for index in offset..end {
            if index < result.exact_groups.len() {
                page.exact_groups.push(result.exact_groups[index].clone());
            } else if index < result.exact_groups.len() + result.older_versions.len() {
                page.older_versions
                    .push(result.older_versions[index - result.exact_groups.len()].clone());
            } else {
                page.issues.push(
                    result.issues[index - result.exact_groups.len() - result.older_versions.len()]
                        .clone(),
                );
            }
        }
        let mut value = serde_json::to_value(page).map_err(error)?;
        value["cursor"] = if end < total { json!(end) } else { Value::Null };
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn expiry_removes_completed_results_and_receipts_but_preserves_active_requests() {
        let mut registry = Registry::default();
        let now = Instant::now();
        for id in ["finished", "active"] {
            registry.requests.insert(
                id.into(),
                (Scope { fiche_id: None }, json!({"operationId":id})),
            );
            registry.results.insert(id.into(), Results::default());
        }
        registry.completed.insert("finished".into(), now);
        registry.expire(now + Duration::from_secs(899));
        assert_eq!(registry.requests.len(), 2);
        assert_eq!(registry.results.len(), 2);
        registry.expire(now + Duration::from_secs(900));
        assert!(!registry.requests.contains_key("finished"));
        assert!(!registry.results.contains_key("finished"));
        assert!(registry.requests.contains_key("active"));
        assert!(registry.results.contains_key("active"));
    }
    #[test]
    fn versions_must_be_declared_comparable_and_strictly_lower() {
        let candidates = vec![
            ("old".into(), "zip".into(), Some(1)),
            ("new".into(), "zip".into(), Some(2)),
            ("same".into(), "zip".into(), Some(2)),
            ("unknown".into(), "zip".into(), None),
        ];
        assert_eq!(older(&candidates), vec!["old"]);
        assert!(older(&candidates[1..]).is_empty());
    }
    #[test]
    fn folder_order_identity_and_dates_do_not_define_equality() {
        let root =
            crate::support::paths::canonical_temp_dir().join(uuid::Uuid::new_v4().to_string());
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        for name in ["one", "two"] {
            fs::write(a.join(name), name).unwrap();
        }
        for name in ["two", "one"] {
            fs::write(b.join(name), name).unwrap();
        }
        let cancel = AtomicBool::new(false);
        assert_eq!(digest(&a, &cancel).unwrap(), digest(&b, &cancel).unwrap());
        fs::write(b.join("one"), b"eno").unwrap();
        assert_ne!(digest(&a, &cancel).unwrap(), digest(&b, &cancel).unwrap());
        assert!(digest(&a, &AtomicBool::new(true)).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
