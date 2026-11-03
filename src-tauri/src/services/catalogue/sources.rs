//! Durable source registry and role exclusions, shared with future walkers.
use super::{
    probe,
    store::{error, Store},
    Result,
};
use crate::support::{
    paths::path_for_frontend,
    user_message::{codes, UserMessage},
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(skip)]
    pub(crate) native_path: PathBuf,
    /// Persisted resolution of `native_path` (the stored path until resolved).
    #[serde(skip)]
    pub(crate) resolved_path: PathBuf,
    pub id: String,
    pub path: String,
    pub origin: String,
    pub status: String,
    pub revision: i64,
    pub included_in: Option<String>,
    pub availability: String,
    pub last_scan_at: Option<i64>,
    pub last_scan_status: Option<String>,
    pub exemplar_count: u64,
    pub scanning: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceList {
    pub total_matching: usize,
    pub exemplar_count: i64,
    pub scanning: bool,
    pub catalogue_revision: i64,
    pub sources_revision: i64,
    pub items: Vec<Source>,
    pub warnings: Vec<UserMessage>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOutcome {
    pub catalogue_revision: i64,
    pub sources_revision: i64,
    pub source_id: String,
    pub affected_card_ids: Vec<String>,
    pub warnings: Vec<UserMessage>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    #[serde(skip)]
    native_path: PathBuf,
    #[serde(skip)]
    resolved_path: Option<PathBuf>,
    pub path: String,
    pub role: String,
    pub reason: UserMessage,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusions {
    #[serde(skip)]
    pub(super) workspace_shapes: Mutex<HashMap<PathBuf, Option<bool>>>,
    pub items: Vec<Exclusion>,
    pub included_roles: Vec<String>,
    pub warnings: Vec<UserMessage>,
}

// OS representation is a native constraint: preserve Unix bytes and Windows UTF-16.
#[cfg(unix)]
pub(crate) fn bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}
#[cfg(unix)]
pub(crate) fn native(value: Vec<u8>) -> PathBuf {
    use std::os::unix::ffi::OsStringExt;
    PathBuf::from(std::ffi::OsString::from_vec(value))
}
#[cfg(windows)]
pub(crate) fn bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}
#[cfg(windows)]
pub(crate) fn native(value: Vec<u8>) -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    PathBuf::from(std::ffi::OsString::from_wide(
        &value
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    ))
}
fn key(path: &Path) -> Vec<u8> {
    super::path_identity::key(path)
}
fn normalize(path: &Path) -> Result<PathBuf> {
    normalize_with_links(path, 0)
}

#[cfg(test)]
#[test]
fn normalization_preserves_existing_roots_and_missing_suffix_identity() {
    let root = std::env::temp_dir();
    let canonical = root.canonicalize().unwrap();
    assert_eq!(normalize(&root).unwrap(), canonical);
    assert_eq!(normalize(&canonical).unwrap(), canonical);
    let missing = format!("source-missing-{}", uuid::Uuid::new_v4());
    assert_eq!(
        normalize(&root.join(&missing).join("child")).unwrap(),
        canonical.join(missing).join("child")
    );
}

fn normalize_with_links(path: &Path, followed_links: usize) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(UserMessage::new(codes::CATALOG_SOURCE_INVALID));
    }
    if followed_links > 40 {
        return Err(error("Too many symbolic links in source path"));
    }
    // Resolve each existing ancestor before appending a missing suffix. In
    // particular, /alias/new must have the same identity before and after mkdir.
    // Resolve the longest existing prefix first. Traversal permission on a
    // directory does not imply permission to open each of its ancestors (NTFS
    // ACLs in particular); opening the complete path is sufficient.
    let components: Vec<_> = path.components().collect();
    let mut existing = components.len();
    let mut resolved = loop {
        let prefix: PathBuf = components[..existing].iter().collect();
        if !prefix.has_root() {
            return Err(unavailable());
        }
        match std::fs::canonicalize(&prefix) {
            Ok(canonical) => break canonical,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => existing -= 1,
            Err(e) => return Err(error(e)),
        }
    };
    for component in &components[existing..] {
        match component {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::CurDir => {}
            other => {
                resolved.push(other.as_os_str());
                match std::fs::canonicalize(&resolved) {
                    Ok(canonical) => resolved = canonical,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // A dangling directory link still identifies its target;
                        // temporary disappearance must not change a refusal key.
                        if let Ok(target) = std::fs::read_link(&resolved) {
                            let target = if target.is_absolute() {
                                target
                            } else {
                                resolved.parent().unwrap().join(target)
                            };
                            resolved = normalize_with_links(&target, followed_links + 1)?;
                        }
                    }
                    Err(e) => return Err(error(e)),
                }
            }
        }
    }
    Ok(resolved)
}

/// A path resolved through its links, with its comparison key. Both touch the
/// disk (links, and case or Unicode probes on macOS and Windows).
pub(crate) type Resolution = (PathBuf, Vec<u8>);
/// Resolves a source path; replaced in tests by a probe that never answers.
pub(crate) type Resolver = Arc<dyn Fn(&Path) -> Option<Resolution> + Send + Sync>;

fn resolve_now(path: &Path) -> Option<Resolution> {
    normalize(path).ok().map(|resolved| {
        let path_key = key(&resolved);
        (resolved, path_key)
    })
}

fn default_resolver() -> Resolver {
    Arc::new(resolve_now)
}

/// Resolution of `path` within `timeout`; `None` when it failed or hung.
fn resolve_bounded(resolver: &Resolver, path: &Path, timeout: Duration) -> Option<Resolution> {
    let resolver = Arc::clone(resolver);
    let owned = path.to_owned();
    probe::bounded(path, timeout, move || resolver(&owned)).flatten()
}

struct Record {
    id: String,
    path: PathBuf,
    path_key: Vec<u8>,
    status: String,
    revision: i64,
    resolved_path: Option<Vec<u8>>,
}

fn read_records(connection: &rusqlite::Connection) -> rusqlite::Result<Vec<Record>> {
    let mut statement = connection
        .prepare("SELECT id,path,path_key,status,revision,resolved_path FROM source WHERE origin<>'repatriated' ORDER BY id")?;
    let rows = statement.query_map([], |r| {
        Ok(Record {
            id: r.get(0)?,
            path: native(r.get(1)?),
            path_key: r.get(2)?,
            status: r.get(3)?,
            revision: r.get(4)?,
            resolved_path: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Resolutions computed off any lock, by source id, with the stored path and
/// revision they were computed from.
#[derive(Default)]
pub(crate) struct Plan(HashMap<String, (Vec<u8>, i64, Resolution)>);

/// What a reconciliation changed: repaired keys advance the sources revision;
/// refreshed resolutions only change nesting.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reconciled {
    pub repaired: bool,
    pub resolved: bool,
}

impl Reconciled {
    pub fn changed(self) -> bool {
        self.repaired || self.resolved
    }
}

/// Repair paths saved by the initial normalizer, preserving explicit refusals
/// and withdrawals when two previously distinct aliases converge. Only the
/// planned resolutions of records unchanged since the plan are applied; any
/// other record keeps its stored key (an inaccessible or hung volume is not
/// permission to forget its source).
fn apply_reconciliation(tx: &rusqlite::Transaction<'_>, plan: &Plan) -> Result<Reconciled> {
    let records = read_records(tx).map_err(error)?;
    let mut temporary_key_length = records
        .iter()
        .map(|record| record.path_key.len())
        .max()
        .unwrap_or(0)
        + 1;
    let mut groups = std::collections::BTreeMap::new();
    let mut resolutions = Vec::new();
    for record in records {
        let fresh = plan
            .0
            .get(&record.id)
            .filter(|(path, revision, _)| {
                *path == bytes(&record.path) && *revision == record.revision
            })
            .map(|(_, _, resolution)| resolution);
        let path_key = fresh.map_or_else(|| record.path_key.clone(), |r| r.1.clone());
        if let Some((resolved, _)) = fresh {
            let resolved = bytes(resolved);
            if record.resolved_path.as_ref() != Some(&resolved) {
                resolutions.push((record.id.clone(), resolved));
            }
        }
        temporary_key_length = temporary_key_length.max(path_key.len() + 1);
        groups.entry(path_key).or_insert_with(Vec::new).push(record);
    }
    let mut repairs = Vec::new();
    for (path_key, mut aliases) in groups {
        aliases.sort_by_key(|record| {
            (
                std::cmp::Reverse(record.revision),
                match record.status.as_str() {
                    "declined" => 0,
                    "removed" => 1,
                    "active" => 2,
                    _ => 3,
                },
            )
        });
        let survivor = &aliases[0];
        let needs_repair = aliases.len() > 1 || survivor.path_key != path_key;
        if !needs_repair {
            continue;
        }
        let next_revision = aliases
            .iter()
            .map(|record| record.revision)
            .max()
            .unwrap_or(survivor.revision)
            + 1;
        for duplicate in &aliases[1..] {
            tx.execute("DELETE FROM source WHERE id=?1", [&duplicate.id])
                .map_err(error)?;
        }
        repairs.push((
            survivor.id.clone(),
            bytes(&survivor.path),
            path_key,
            next_revision,
        ));
    }
    // Vacate every changing key before assigning final keys: links may move in
    // chains or swap targets. Longer blobs cannot collide with any old or final
    // key, and the index makes each temporary key unique within this transaction.
    for (index, (id, _, _, _)) in repairs.iter().enumerate() {
        let mut temporary_key = vec![0; temporary_key_length];
        temporary_key.extend_from_slice(&index.to_le_bytes());
        tx.execute(
            "UPDATE source SET path_key=?1 WHERE id=?2 AND origin<>'repatriated'",
            params![temporary_key, id],
        )
        .map_err(error)?;
    }
    for (id, path, path_key, revision) in &repairs {
        tx.execute(
            "UPDATE source SET path=?1,path_key=?2,revision=?3 WHERE id=?4",
            params![path, path_key, revision, id],
        )
        .map_err(error)?;
    }
    let mut resolved = false;
    for (id, path) in &resolutions {
        // A duplicate deleted above updates nothing.
        resolved |= tx
            .execute(
                "UPDATE source SET resolved_path=?1 WHERE id=?2 AND origin<>'repatriated'",
                params![path, id],
            )
            .map_err(error)?
            > 0;
    }
    Ok(Reconciled {
        repaired: !repairs.is_empty(),
        resolved,
    })
}

fn advance_sources_revision(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute(
        "UPDATE catalogue SET revision=revision+1,sources_revision=sources_revision+1",
        [],
    )
    .map_err(error)?;
    Ok(())
}

fn unavailable() -> UserMessage {
    UserMessage::new(codes::CATALOG_SOURCE_UNAVAILABLE)
}

impl Store {
    /// Resolves every source in parallel, each probe bounded, without any
    /// lock or transaction held.
    fn plan_reconciliation(&self, resolver: &Resolver, timeout: Duration) -> Result<Plan> {
        let records = self.read(read_records)?;
        let resolved = std::thread::scope(|scope| {
            let probes = records
                .iter()
                .map(|record| scope.spawn(|| resolve_bounded(resolver, &record.path, timeout)))
                .collect::<Vec<_>>();
            probes
                .into_iter()
                .map(|probe| probe.join().ok().flatten())
                .collect::<Vec<_>>()
        });
        Ok(Plan(
            records
                .into_iter()
                .zip(resolved)
                .filter_map(|(record, resolution)| {
                    resolution.map(|r| (record.id, (bytes(&record.path), record.revision, r)))
                })
                .collect(),
        ))
    }

    /// Background maintenance: repairs source keys and refreshes the persisted
    /// resolved paths. Never called by a listing.
    pub fn reconcile_sources(&self) -> Result<Reconciled> {
        self.reconcile_sources_with(&default_resolver(), probe::PROBE_TIMEOUT)
    }

    pub(crate) fn reconcile_sources_with(
        &self,
        resolver: &Resolver,
        timeout: Duration,
    ) -> Result<Reconciled> {
        let plan = self.plan_reconciliation(resolver, timeout)?;
        self.write(|tx| {
            let reconciled = apply_reconciliation(tx, &plan)?;
            if reconciled.repaired {
                advance_sources_revision(tx)?;
            }
            Ok(reconciled)
        })
    }

    /// Records the current workspace and its included roles. Probes the disk
    /// (bounded): background passes only. True when the sources changed.
    pub fn remember_workspace(&self, workspace: Option<&str>) -> Result<bool> {
        let Some(workspace) = workspace.filter(|value| !value.trim().is_empty()) else {
            return Ok(false);
        };
        let workspace = Path::new(workspace);
        if !workspace.is_absolute() {
            return Err(UserMessage::new(codes::CATALOG_SOURCE_INVALID));
        }
        let candidate = workspace.to_owned();
        if probe::bounded(workspace, probe::PROBE_TIMEOUT, move || candidate.is_dir()) != Some(true)
        {
            return Ok(false);
        }
        let resolver = default_resolver();
        let (root, root_key) =
            resolve_bounded(&resolver, workspace, probe::PROBE_TIMEOUT).ok_or_else(unavailable)?;
        let roles = ["exports", "sauvegardes"]
            .into_iter()
            .map(|role| resolve_bounded(&resolver, &root.join(role), probe::PROBE_TIMEOUT))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(unavailable)?;
        let reconciled = self.reconcile_sources()?;
        let inserted = self.write(|tx| {
            let first_workspace: bool = tx
                .query_row("SELECT count(*)=0 FROM workspace_root", [], |r| r.get(0))
                .map_err(error)?;
            let status = if first_workspace { "active" } else { "hint" };
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let root_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO workspace_root VALUES (?1,?2,?4,?3,?3)
                 ON CONFLICT(path_key) DO UPDATE SET last_current_at=excluded.last_current_at",
                params![root_id, bytes(&root), stamp, root_key],
            )
            .map_err(error)?;
            let mut inserted = false;
            for (path, path_key) in &roles {
                let source_id = uuid::Uuid::new_v4().to_string();
                inserted |= tx
                    .execute(
                        "INSERT OR IGNORE INTO source(id,path,path_key,origin,status,revision,resolved_path)
                         VALUES (?1,?2,?3,'workspace',?4,0,?2)",
                        params![source_id, bytes(path), path_key, status],
                    )
                    .map_err(error)?
                    > 0;
            }
            if inserted {
                advance_sources_revision(tx)?;
            }
            Ok(inserted)
        })?;
        Ok(inserted || reconciled.changed())
    }
    /// Reads the database only: never probes a source, so a dead mount
    /// cannot delay the listing nor hold the writer.
    pub fn list_sources(&self) -> Result<SourceList> {
        self.source_list(false)
    }
    pub(crate) fn all_sources(&self) -> Result<SourceList> {
        self.source_list(true)
    }
    fn source_list(&self, internal: bool) -> Result<SourceList> {
        let scanning = self.scanning_sources()?;
        self.read(|connection| {
            let tx = connection.unchecked_transaction()?;
            let revision = tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            let sources_revision =
                tx.query_row("SELECT sources_revision FROM catalogue", [], |r| r.get(0))?;
            let mut statement = tx.prepare(
                "SELECT id,path,origin,status,revision,coalesce(resolved_path,path) FROM source WHERE (?1 OR origin<>'repatriated') ORDER BY path_key",
            )?;
            let records = statement
                .query_map([internal], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        native(r.get(1)?),
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        native(r.get(5)?),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let resolved_paths = records
                .iter()
                .map(|(id, _, _, _, _, resolved)| (id.clone(), resolved.clone()))
                .collect::<HashMap<_, _>>();
            let records = records
                .into_iter()
                .map(|(id, path, origin, status, revision, _)| (id, path, origin, status, revision))
                .collect::<Vec<_>>();
            let health = records.iter().map(|(id, ..)| {
                let scan = tx.query_row("SELECT last_scan_at,last_scan_status,availability FROM source_health WHERE source_id=?1", [id], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?))).optional()?;
                let count = tx.query_row("SELECT count(DISTINCT c.exemplar_id) FROM cache.coverage c JOIN exemplar e ON e.id=c.exemplar_id WHERE c.source_id=?1 AND e.retired=0", [id], |r| r.get::<_, i64>(0))?;
                Ok((id.clone(), (scan.unwrap_or_default(), count)))
            }).collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?;
            let items: Vec<Source> = records
                .iter()
                .map(|(id, path, origin, status, revision)| Source {
                    native_path: path.clone(),
                    resolved_path: resolved_paths[id].clone(),
                    id: id.clone(),
                    path: path_for_frontend(path),
                    origin: origin.clone(),
                    status: status.clone(),
                    revision: *revision,
                    // Last recorded access only: a dead mount must never block
                    // this listing. Scans and the watcher probe in the background.
                    availability: if health[id].0.2.is_empty() {
                        "unknown".into()
                    } else {
                        health[id].0.2.clone()
                    },
                    last_scan_at: health[id].0.0,
                    last_scan_status: health[id].0.1.clone(),
                    exemplar_count: health[id].1 as u64,
                    scanning: status == "active" && records.iter().any(|(other, _, _, other_status, _)| other_status == "active" && scanning.contains(other) && (resolved_paths[id].starts_with(&resolved_paths[other]) || resolved_paths[other].starts_with(&resolved_paths[id]))),
                    included_in: if status == "active" {
                        records
                            .iter()
                            .filter(|(other, _, _, status, _)| {
                                other != id
                                    && status == "active"
                                    && resolved_paths[id].starts_with(&resolved_paths[other])
                            })
                            .min_by_key(|(other, _, _, _, _)| resolved_paths[other].components().count())
                            .map(|r| r.0.clone())
                    } else {
                        None
                    },
                })
                .collect();
            Ok(SourceList {
                total_matching: items.len(),
                exemplar_count: tx.query_row("SELECT count(DISTINCT c.exemplar_id) FROM cache.coverage c JOIN source s ON s.id=c.source_id JOIN exemplar e ON e.id=c.exemplar_id WHERE s.status='active' AND e.retired=0", [], |r| r.get(0))?,
                scanning: !scanning.is_empty(),
                catalogue_revision: revision,
                sources_revision,
                items,
                warnings: self.all_warnings(),
            })
        })
    }
    /// Every disk probe (resolution, directory check, reconciliation of the
    /// other sources) is bounded and runs before the transaction.
    pub fn add_source(&self, path: &Path, expected: i64, declined: bool) -> Result<SourceOutcome> {
        if !path.is_absolute() {
            return Err(UserMessage::new(codes::CATALOG_SOURCE_INVALID));
        }
        let owned = path.to_path_buf();
        let (resolution, is_dir) = probe::bounded(path, probe::PROBE_TIMEOUT, move || {
            let resolution = normalize(&owned).map(|resolved| {
                let path_key = key(&resolved);
                (resolved, path_key)
            });
            (resolution, owned.is_dir())
        })
        .ok_or_else(unavailable)?;
        let resolution = resolution?;
        if !declined && !is_dir {
            return Err(UserMessage::new(codes::CATALOG_SOURCE_INVALID));
        }
        let plan = self.plan_reconciliation(&default_resolver(), probe::PROBE_TIMEOUT)?;
        self.mutate_source(
            Some((path, &resolution, &plan)),
            None,
            expected,
            if declined { "declined" } else { "active" },
        )
    }
    #[cfg(test)]
    pub fn remove_source(&self, id: &str, expected: i64) -> Result<SourceOutcome> {
        let preview = self.preview_remove_source(id)?;
        self.remove_source_confirmed(id, expected, preview.catalogue_revision)
    }
    fn mutate_source(
        &self,
        added: Option<(&Path, &Resolution, &Plan)>,
        id: Option<&str>,
        expected: i64,
        status: &str,
    ) -> Result<SourceOutcome> {
        self.write(|tx| {
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            let sources_revision: i64 = tx
                .query_row("SELECT sources_revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            if sources_revision != expected {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            let source_id = if let Some((path, (resolved, path_key), plan)) = added {
                let technical: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM source WHERE path_key=?1 AND origin='repatriated')", [path_key], |r| r.get(0)).map_err(error)?;
                if technical {
                    return Err(UserMessage::new(codes::CATALOG_SOURCE_NOT_FOUND));
                }
                apply_reconciliation(tx, plan)?;
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM source WHERE path_key=?1",
                        [&path_key],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(error)?;
                let source_id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let stored_path = bytes(path);
                let upsert_source =
                    "INSERT INTO source(id,path,path_key,origin,status,revision,resolved_path)
                     VALUES (?1,?2,?4,'manual',?3,?5,?6)
                     ON CONFLICT(path_key) DO UPDATE SET
                         path=excluded.path,
                         status=excluded.status,
                         revision=excluded.revision,
                         resolved_path=excluded.resolved_path";
                tx.execute(
                    upsert_source,
                    params![
                        source_id,
                        stored_path,
                        status,
                        path_key,
                        sources_revision + 1,
                        bytes(resolved)
                    ],
                )
                .map_err(error)?;
                if status == "active" {
                    // add_source has just verified that the directory exists.
                    tx.execute(
                        "INSERT INTO source_health(source_id,availability) VALUES (?1,'available')
                         ON CONFLICT(source_id) DO UPDATE SET availability='available'",
                        [&source_id],
                    )
                    .map_err(error)?;
                }
                source_id
            } else {
                let source_id = id.unwrap();
                let updated = tx
                    .execute(
                        "UPDATE source SET status=?1,revision=?3 WHERE id=?2 AND origin<>'repatriated'",
                        params![status, source_id, sources_revision + 1],
                    )
                    .map_err(error)?;
                if updated == 0 {
                    return Err(UserMessage::new(codes::CATALOG_SOURCE_NOT_FOUND));
                }
                source_id.to_owned()
            };
            advance_sources_revision(tx)?;
            Ok(SourceOutcome {
                catalogue_revision: revision + 1,
                sources_revision: sources_revision + 1,
                source_id,
                affected_card_ids: Vec::new(),
                warnings: self.all_warnings(),
            })
        })
    }
    /// Withdraw technical exemplars using the existing retired-anchor state.
    /// Keep cards and personal metadata; never delete the underlying files.
    pub(crate) fn retire_excluded(
        &self,
        source: &str,
        exclusions: &Exclusions,
    ) -> Result<Option<i64>> {
        let anchors = self.read(|c| {
            c.prepare("SELECT e.id,json_extract(e.anchor_json,'$.path') FROM exemplar e JOIN cache.coverage v ON v.exemplar_id=e.id WHERE v.source_id=?1 AND e.retired=0")?
                .query_map([source], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        let ids = anchors
            .into_iter()
            .filter_map(|(id, path)| {
                exclusions
                    .reason_for_resolved(Path::new(&path), None)
                    .map(|_| id)
            })
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(None);
        }
        self.write(|tx| {
            for id in ids {
                tx.execute("UPDATE exemplar SET retired=1 WHERE id=?1", [&id])
                    .map_err(error)?;
                tx.execute(super::grouping::RETIRE_OBSERVATION, [&id])
                    .map_err(error)?;
            }
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            Ok(Some(
                tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                    .map_err(error)?,
            ))
        })
    }
    /// Rules with their resolved roots (bounded probe), for scans and watching.
    pub fn exclusions(&self, cache: &Path, data: &Path) -> Result<Exclusions> {
        self.build_exclusions(cache, data, true)
    }
    /// Rules as stored, without any disk access: what the interface lists
    /// (resolved roots are never serialized).
    pub(crate) fn exclusions_raw(&self, cache: &Path, data: &Path) -> Result<Exclusions> {
        self.build_exclusions(cache, data, false)
    }
    /// Every workspace the catalogue has recorded, as stored (no disk access).
    pub(crate) fn workspace_roots(&self) -> Result<Vec<PathBuf>> {
        self.read(|c| {
            c.prepare("SELECT path FROM workspace_root")?
                .query_map([], |r| Ok(native(r.get(0)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
    }
    fn build_exclusions(&self, cache: &Path, data: &Path, resolve: bool) -> Result<Exclusions> {
        let workspaces = self.workspace_roots()?;
        let mut items = Vec::new();
        let mut add = |path: PathBuf, role: &str| {
            items.push(Exclusion {
                resolved_path: None,
                native_path: path.clone(),
                path: path_for_frontend(path),
                role: role.into(),
                reason: UserMessage::new(codes::CATALOG_SOURCE_EXCLUDED).param("role", role),
            })
        };
        for root in workspaces {
            for role in [
                "fichiers-importes",
                "enregistrements",
                "voix-generees",
                "images-generees",
                "zips-extraits",
                "sauvegardes/versions-securite",
            ] {
                add(root.join(role), role);
            }
        }
        for role in [
            crate::support::temp::SESSION_WORKSPACES_DIR,
            crate::support::temp::TEMP_IMAGES_DIR,
            crate::support::temp::AUDIO_PREVIEWS_DIR,
            crate::support::temp::PODCAST_MEDIA_DIR,
            crate::support::temp::YOUTUBE_MEDIA_DIR,
            crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR,
            crate::services::advanced_view_cache::CACHE_DIR_NAME,
            "catalogue",
        ] {
            add(cache.join(role), role);
        }
        add(cache.to_owned(), "applicationCache");
        for role in ["recovery", "operations"] {
            add(data.join("catalogue").join(role), role);
        }
        add(data.join("catalogue"), "catalogueData");
        for role in [
            "story_studio_catalogue",
            "story_studio_images",
            "luniipack_images",
            "story_studio_imported_pack_cache",
        ] {
            add(std::env::temp_dir().join(role), role);
        }
        for role in WORKSPACE_MEDIA_ROLES {
            add(PathBuf::from(role), role);
        }
        add(
            PathBuf::from("sauvegardes/versions-securite"),
            "sauvegardes/versions-securite",
        );
        for role in [
            ".story-studio-backups",
            ".story-studio-image-edits",
            ".story-studio-audio-edits",
            ".story-studio-dossier.json",
            ".story-studio-write-*",
            "*.mbah.tmp-*",
            "*.zip.<uuid>.partial",
            ".story-studio-write-test-*.tmp",
        ] {
            add(PathBuf::from(role), role);
        }
        if resolve {
            resolve_exclusions(&mut items);
        }
        Ok(Exclusions {
            workspace_shapes: Mutex::default(),
            items,
            warnings: self.all_warnings(),
            included_roles: vec![
                "exports".into(),
                "sauvegardes".into(),
                "sauvegardes/**/*.mbah".into(),
            ],
        })
    }
}

/// One bounded probe for the whole set: a hung volume under a workspace
/// delays a scan or a watcher pass by one delay at most, and the rules then
/// match on the stored paths only.
fn resolve_exclusions(items: &mut [Exclusion]) {
    let paths = items
        .iter()
        .map(|item| item.native_path.clone())
        .collect::<Vec<_>>();
    let resolved = probe::bounded(
        Path::new("<catalogue-exclusions>"),
        probe::PROBE_TIMEOUT,
        move || {
            paths
                .iter()
                .map(|path| path.is_absolute().then(|| normalize(path).ok()).flatten())
                .collect::<Vec<_>>()
        },
    );
    if let Some(resolved) = resolved {
        for (item, resolved) in items.iter_mut().zip(resolved) {
            item.resolved_path = resolved;
        }
    }
}

const WORKSPACE_MEDIA_ROLES: [&str; 5] = [
    "fichiers-importes",
    "enregistrements",
    "voix-generees",
    "images-generees",
    "zips-extraits",
];

impl Exclusions {
    /// Only the distinctive backup layout identifies an unregistered workspace.
    /// An isolated media directory is never enough. Cache per rule set/pass;
    /// a dead volume cannot hold a scan or a path explanation indefinitely.
    fn has_workspace_shape(&self, root: &Path) -> Option<bool> {
        if let Some(found) = self
            .workspace_shapes
            .lock()
            .ok()
            .and_then(|m| m.get(root).copied())
        {
            return found;
        }
        let signature = root.join("sauvegardes/versions-securite");
        let owned = signature.clone();
        let found = probe::bounded(
            &signature,
            probe::PROBE_TIMEOUT,
            move || match std::fs::metadata(owned) {
                Ok(metadata) => Some(metadata.is_dir()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
            },
        )
        .flatten();
        if let Ok(mut shapes) = self.workspace_shapes.lock() {
            shapes.insert(root.to_owned(), found);
        }
        found
    }

    /// Raw-path form used by tests: resolves the path once, then delegates.
    #[cfg(test)]
    pub fn reason_for(&self, path: &Path) -> Option<&Exclusion> {
        let resolved = normalize(path).ok();
        self.reason_for_resolved(path, resolved.as_deref())
    }
    /// Predicate over the raw path and its already resolved form; performs no
    /// pack content access. Workspace shape probes are bounded and cached.
    /// Reserved names are checked on both, so neither a
    /// technical link nor an alias into it may bypass the rules.
    pub fn reason_for_resolved(&self, raw: &Path, resolved: Option<&Path>) -> Option<&Exclusion> {
        self.classify(raw, resolved).ok().flatten()
    }

    /// Unknown structure is neither inclusion nor exclusion. Discovery must
    /// leave that scope incomplete; retirement requires a confirmed rule.
    pub(crate) fn classify(
        &self,
        raw: &Path,
        resolved: Option<&Path>,
    ) -> std::result::Result<Option<&Exclusion>, ()> {
        let matched = self.items.iter().find(|item| {
            std::iter::once(raw)
                .chain(resolved)
                .any(|candidate| self.matches(item, candidate))
        });
        if matched.is_some() {
            return Ok(matched);
        }
        for candidate in std::iter::once(raw).chain(resolved) {
            for path in candidate.ancestors() {
                if path
                    .file_name()
                    .is_some_and(|name| WORKSPACE_MEDIA_ROLES.iter().any(|role| name == *role))
                    && path
                        .parent()
                        .is_some_and(|root| self.has_workspace_shape(root).is_none())
                {
                    return Err(());
                }
            }
        }
        Ok(None)
    }
    fn matches(&self, item: &Exclusion, candidate: &Path) -> bool {
        let root = &item.native_path;
        if root.is_absolute() {
            return candidate.starts_with(root)
                || item
                    .resolved_path
                    .as_ref()
                    .is_some_and(|root| candidate.starts_with(root));
        }
        let name = candidate.file_name().and_then(|n| n.to_str()).unwrap_or("");
        match item.role.as_str() {
            "sauvegardes/versions-securite" => candidate
                .ancestors()
                .any(|path| path.ends_with(Path::new("sauvegardes/versions-securite"))),
            role if WORKSPACE_MEDIA_ROLES.contains(&role) => candidate.ancestors().any(|path| {
                path.file_name().is_some_and(|name| name == role)
                    && path
                        .parent()
                        .is_some_and(|root| self.has_workspace_shape(root) == Some(true))
            }),
            "*.mbah.tmp-*" => name
                .split_once(".mbah.tmp-")
                .is_some_and(|(_, tail)| !tail.is_empty()),
            "*.zip.<uuid>.partial" => name
                .strip_suffix(".partial")
                .and_then(|n| n.rsplit_once(".zip."))
                .is_some_and(|(_, id)| uuid::Uuid::parse_str(id).is_ok()),
            ".story-studio-write-test-*.tmp" => {
                name.starts_with(".story-studio-write-test-") && name.ends_with(".tmp")
            }
            ".story-studio-write-*" => name
                .strip_prefix(".story-studio-write-")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()),
            role => candidate.components().any(|c| c.as_os_str() == role),
        }
    }
}
