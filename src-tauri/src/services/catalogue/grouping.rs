//! Durable identity and reference reconciliation, only after a validated scan.
//!
//! Rules applied to every observed exemplar (archive children included):
//! - the same reliable UUID joins the same card, whatever the format;
//! - without a reliable UUID, an exemplar keeps its card only while its content
//!   token is unchanged; a changed or replaced file becomes a new card, with
//!   no automatic transfer of personal data; an
//!   attested save of a legacy project can acquire its first reliable UUID;
//! - an unreadable file keeps its last known data with an explicit state;
//! - absence is concluded only for a scope that was visited completely.
use super::{
    analyze::Observation,
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scanned {
    pub source_id: String,
    pub path: String,
    pub path_key: Vec<u8>,
    pub token: String,
    pub modified: i64,
    pub size: u64,
    /// Portable file identity, when the platform gives one.
    #[serde(default)]
    pub file_id: Option<String>,
    #[serde(default)]
    pub save_prestate: Option<super::writes::SavePrestate>,
    pub observation: Observation,
}

#[derive(Default)]
pub struct Published {
    pub outcomes: Vec<String>,
    pub cards_created: u64,
    pub cards_updated: u64,
    pub revision: i64,
    /// Exemplars confirmed absent by a targeted publication.
    pub missing: u64,
    /// Whether the index changed (a no-op refresh keeps entry cursors valid).
    pub changed: bool,
}

/// Content-determined refusals; anything else that prevents indexing is an error.
pub fn failure_outcome(state: &str) -> &'static str {
    match state {
        "unsupportedFormat"
        | "invalidStructure"
        | "corruptArchive"
        | "protectedArchive"
        | "encryptedUnknownKey"
        | "readLimitExceeded" => "refused",
        _ => "error",
    }
}

pub(super) const SELECT_CURRENT_ANCHOR: &str = "SELECT id,fiche_id,verified_uuid,proof_json,
       (SELECT state FROM cache.observation WHERE exemplar_id=exemplar.id),
       (SELECT raw_observation_json FROM cache.observation WHERE exemplar_id=exemplar.id),anchor_json,
       (SELECT file_id FROM exemplar_file_state WHERE exemplar_id=exemplar.id) FROM exemplar
     WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?1,'$.pathKey')
       AND json_extract(anchor_json,'$.memberKey') IS json_extract(?1,'$.memberKey')
       AND retired=0";
pub(super) const MARK_FAILED_MEMBER: &str = "UPDATE cache.observation SET state=?1,scan_id=?3,
     raw_observation_json=json_set(raw_observation_json,
       '$.listeningToken',json_extract(?4,'$.listeningToken'),
       '$.listeningVersion',json_extract(?4,'$.listeningVersion'),
       '$.listeningPending',json(CASE WHEN json_extract(?4,'$.listeningPending') THEN 'true' ELSE 'false' END),
       '$.listeningDependencies',json(COALESCE(json_extract(?4,'$.listeningDependencies'),'[]')))
     WHERE exemplar_id IN (SELECT id FROM exemplar
       WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?2,'$.pathKey')
         AND json_extract(anchor_json,'$.memberKey') IS json_extract(?2,'$.memberKey')
         AND retired=0)";
// A whole-file failure (unreadable archive, file being copied) keeps every
// child exemplar of that file with an explicit state instead of a false absence.
pub(super) const MARK_FAILED_FILE: &str = "UPDATE cache.observation SET state=?1,scan_id=?3,
     raw_observation_json=json_set(raw_observation_json,
       '$.listeningToken',json_extract(?4,'$.listeningToken'),
       '$.listeningVersion',json_extract(?4,'$.listeningVersion'),
       '$.listeningPending',json(CASE WHEN json_extract(?4,'$.listeningPending') THEN 'true' ELSE 'false' END),
       '$.listeningDependencies',json(COALESCE(json_extract(?4,'$.listeningDependencies'),'[]')))
     WHERE exemplar_id IN (SELECT id FROM exemplar
       WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?2,'$.pathKey')
         AND retired=0)";
pub(super) const RETIRE_OBSERVATION: &str = "UPDATE cache.observation
     SET locator_key=CAST('retired:' || exemplar_id AS BLOB),state='unavailable'
     WHERE exemplar_id=?1";
pub(super) const SELECT_CONTAINER: &str = "SELECT id FROM container
     WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?1,'$.pathKey') AND retired=0";
const UPSERT_CONTAINER: &str = "INSERT INTO container VALUES (?1,?2,?3,1,0)
     ON CONFLICT(id) DO UPDATE SET proof_json=excluded.proof_json,
       content_revision=container.content_revision
         + CASE WHEN container.proof_json!=excluded.proof_json THEN 1 ELSE 0 END";
const UPSERT_EXEMPLAR: &str = "INSERT INTO exemplar
       (id,fiche_id,container_id,anchor_json,verified_uuid,proof_json,
        content_revision,retired,created_at)
     VALUES (?1,?2,?6,?3,?4,?5,1,0,unixepoch())
     ON CONFLICT(id) DO UPDATE SET anchor_json=excluded.anchor_json,
       proof_json=excluded.proof_json,verified_uuid=excluded.verified_uuid,
       content_revision=exemplar.content_revision
         + CASE WHEN exemplar.proof_json!=excluded.proof_json THEN 1 ELSE 0 END";
const UPSERT_OBSERVATION: &str =
    "INSERT INTO cache.observation VALUES (?1,?10,?2,?3,1,?4,?5,NULL,?6,?7,'{}',?8,?9)
     ON CONFLICT(exemplar_id) DO UPDATE SET content_token=excluded.content_token,
       state=excluded.state,modified_at=excluded.modified_at,byte_size=excluded.byte_size,
       raw_observation_json=excluded.raw_observation_json,scan_id=excluded.scan_id,
       content_revision=observation.content_revision
         + CASE WHEN observation.content_token!=excluded.content_token THEN 1 ELSE 0 END";
const INSERT_EXTRACTED: &str =
    "INSERT INTO cache.extracted_value VALUES (?1,?2,'',?3,?4,?5,?6,NULL,?7)";
const MARK_UNSEEN: &str = "UPDATE cache.observation SET state=?3
     WHERE exemplar_id IN (SELECT exemplar_id FROM cache.coverage WHERE source_id=?1)
       AND instr(scan_id,?2 || ':')!=1 AND state!=?3";
const UPSERT_FILE_STATE: &str =
    "INSERT OR REPLACE INTO cache.file_state VALUES (?1,?2,?3,?4,?5,?6)";
const PRUNE_FILE_STATES: &str = "DELETE FROM cache.file_state WHERE source_id=?1 AND scan_id!=?2";
const MARK_REMOVED_FILE: &str = "UPDATE cache.observation SET state='missing',scan_id=?2
     WHERE state!='missing' AND exemplar_id IN (SELECT id FROM exemplar
       WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?1,'$.pathKey')
         AND retired=0)";
const PRUNE_SCANS: &str = "DELETE FROM cache.scan WHERE source_id=?1 AND id!=?2
     AND id NOT IN (SELECT scan_id FROM cache.observation)";

fn scope_scan_id(scan: &str, source: &str) -> String {
    format!("{scan}:{source}")
}

fn check_sources_revision(tx: &Transaction<'_>, expected: i64) -> Result<i64> {
    let current: i64 = tx
        .query_row("SELECT sources_revision FROM catalogue", [], |r| r.get(0))
        .map_err(error)?;
    if current != expected {
        return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
    }
    Ok(current)
}

fn bump_revision(tx: &Transaction<'_>) -> Result<i64> {
    tx.execute("UPDATE catalogue SET revision=revision+1", [])
        .map_err(error)?;
    tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
        .map_err(error)
}

struct Anchor {
    exemplar: String,
    card: String,
    uuid: Option<String>,
    token: String,
    state: String,
    raw: Option<String>,
    locator: String,
    file_id: Option<String>,
}

/// A conclusive inventory describes all the live members of this file.
fn reconcile_members(
    tx: &Transaction<'_>,
    scan: &str,
    items: &[Scanned],
    result: &mut Published,
) -> Result<()> {
    let mut files = std::collections::BTreeMap::<&[u8], Vec<&Scanned>>::new();
    for item in items {
        files.entry(&item.path_key).or_default().push(item);
    }
    for (key, members) in files {
        // A whole-file failure cannot prove that any child disappeared. Member
        // failures are located, and therefore remain part of the inventory.
        if members
            .iter()
            .any(|item| item.observation.member.is_none() && item.observation.state != "available")
        {
            continue;
        }
        let observed: std::collections::HashSet<_> = members
            .iter()
            .map(|item| item.observation.member_key())
            .collect();
        let failures: std::collections::HashMap<_, _> = members
            .iter()
            .filter(|item| {
                item.observation.state != "available" && !item.observation.chain.is_empty()
            })
            .map(|item| (item.observation.member_key(), *item))
            .collect();
        let locator = json!({"pathKey": key}).to_string();
        let mut statement = tx
            .prepare(
                "SELECT e.id,json_extract(e.anchor_json,'$.memberKey'),o.raw_observation_json
            FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id
            WHERE json_extract(e.anchor_json,'$.pathKey')=json_extract(?1,'$.pathKey')
            AND e.retired=0 AND o.state!='missing'",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([locator], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        for (exemplar, member, raw) in rows {
            let mut previous: Observation = serde_json::from_str(&raw).map_err(error)?;
            // Only the bounded archive-chain prefixes are queried. A large
            // multipack never compares every old child with every observation.
            let failed_branch = loop {
                if let Some(failure) = failures.get(&previous.member_key()) {
                    break Some(*failure);
                }
                if previous.chain.pop().is_none() {
                    break None;
                }
            };
            if let Some(failure) = failed_branch {
                tx.execute(
                    "UPDATE cache.observation SET state=?1,scan_id=?2 WHERE exemplar_id=?3",
                    params![
                        failure.observation.state,
                        scope_scan_id(scan, &failure.source_id),
                        exemplar
                    ],
                )
                .map_err(error)?;
                result.changed = true;
            } else if !observed.contains(&member) {
                result.missing += tx
                    .execute(
                        "UPDATE cache.observation SET state='missing' WHERE exemplar_id=?1",
                        [exemplar],
                    )
                    .map_err(error)? as u64;
                result.changed = true;
            }
        }
    }
    Ok(())
}

/// The saved legacy card survives identity acquisition. If the UUID already
/// exists, unite nonconflicting personal data and exemplars on that card.
/// Conflicting personal data leave both cards and their identities attached
/// until an explicit resolution completes the pending convergence.
fn acquire_identity(
    tx: &Transaction<'_>,
    old: &Anchor,
    uuid: &str,
    observation: &Observation,
) -> Result<bool> {
    let known: Option<String> = tx
        .query_row(
            "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
            [uuid],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if let Some(known) = known.filter(|id| id != &old.card) {
        if super::data::mutate::association::corrections_conflict(tx, &old.card, &known)? {
            let evidence = json!({"reason":"personalConflict", "requiresConfirmation":true});
            tx.execute(
                "INSERT OR REPLACE INTO identity_convergence VALUES (?1,?2,?3,?4)",
                params![old.exemplar, known, uuid, evidence.to_string()],
            )
            .map_err(error)?;
            return Ok(false);
        }
        tx.execute_batch("SAVEPOINT identity_grouping")
            .map_err(error)?;
        let grouped = super::data::mutate::association::group(
            tx,
            &[old.card.clone(), known.clone()],
            &old.card,
            &[],
            true,
        );
        match grouped {
            Ok(()) => tx
                .execute_batch("RELEASE identity_grouping")
                .map_err(error)?,
            Err(refusal) => {
                tx.execute_batch("ROLLBACK TO identity_grouping; RELEASE identity_grouping")
                    .map_err(error)?;
                let evidence = json!({"reason":"groupingRefused","refusal":refusal,"requiresConfirmation":true});
                tx.execute(
                    "INSERT OR REPLACE INTO identity_convergence VALUES (?1,?2,?3,?4)",
                    params![old.exemplar, known, uuid, evidence.to_string()],
                )
                .map_err(error)?;
                return Ok(false);
            }
        }
    } else {
        tx.execute(
            "INSERT OR IGNORE INTO pack_identity VALUES (?1,?2,?3)",
            params![
                uuid,
                old.card,
                serde_json::to_string(&observation.identity).map_err(error)?
            ],
        )
        .map_err(error)?;
    }
    tx.execute(
        "UPDATE fiche SET revision=revision+1 WHERE id=?1",
        [&old.card],
    )
    .map_err(error)?;
    Ok(true)
}

/// Traversal deduplication does not remove the coverage of nested sources.
fn coverage_roots(tx: &Transaction<'_>) -> Result<Vec<(String, std::path::PathBuf)>> {
    let mut statement = tx
        .prepare("SELECT id,path FROM source WHERE status='active'")
        .map_err(error)?;
    let records = statement
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    Ok(records
        .into_iter()
        .map(|(id, raw)| {
            let root = super::refresh::resolve_existing(&super::sources::native(raw));
            (
                id,
                std::path::PathBuf::from(crate::support::paths::path_for_frontend(root)),
            )
        })
        .collect())
}

fn cover_sources(
    tx: &Transaction<'_>,
    roots: &[(String, std::path::PathBuf)],
    exemplar: &str,
    path: &str,
) -> Result<bool> {
    let mut changed = false;
    for (id, root) in roots {
        if std::path::Path::new(path).starts_with(root) {
            changed |= tx
                .execute(
                    "INSERT OR IGNORE INTO cache.coverage VALUES (?1,?2)",
                    params![id, exemplar],
                )
                .map_err(error)?
                > 0;
        }
    }
    Ok(changed)
}

impl Store {
    /// Called only after the caller has explicitly resolved personal conflicts.
    /// An ordinary scan never completes a pending convergence on its own.
    pub fn resolve_identity_convergence(
        &self,
        exemplar: &str,
        expected_revision: i64,
    ) -> Result<bool> {
        let _analysis = super::writes::shared().analysis_guard();
        self.write(|tx| {
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            if revision != expected_revision {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            let pending: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT e.anchor_json,p.known_fiche_id,p.pack_uuid
                     FROM identity_convergence p JOIN exemplar e ON e.id=p.exemplar_id
                     WHERE p.exemplar_id=?1 AND e.retired=0",
                    [exemplar],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(error)?;
            let Some((locator, known, uuid)) = pending else {
                return Ok(false);
            };
            let Some(old) = current_anchor(tx, &locator)? else {
                return Ok(false);
            };
            super::files::require_associations_available(tx, &[old.card.clone(), known.clone()])?;
            if super::data::mutate::association::corrections_conflict(tx, &old.card, &known)?
                || old.state != "available"
            {
                return Ok(false);
            }
            let parsed: Value = serde_json::from_str(&locator).map_err(error)?;
            let Some(path) = parsed["path"].as_str() else {
                return Ok(false);
            };
            let path = std::path::Path::new(path);
            if super::writes::shared().classify(path, std::time::Instant::now())
                == super::writes::Verdict::Deferred
                || super::scan::token(path)
                    .ok()
                    .is_none_or(|state| state.0 != old.token)
                || old.file_id.is_none()
                || super::writes::file_id(path) != old.file_id
            {
                return Ok(false);
            }
            let observation: Observation =
                serde_json::from_str(old.raw.as_deref().unwrap_or("null")).map_err(error)?;
            if observation.uuid() != Some(&uuid)
                || !acquire_identity(tx, &old, &uuid, &observation)?
            {
                return Ok(false);
            }
            tx.execute(
                "UPDATE exemplar SET verified_uuid=?1 WHERE id=?2",
                params![uuid, exemplar],
            )
            .map_err(error)?;
            tx.execute(
                "DELETE FROM identity_convergence WHERE exemplar_id=?1",
                [exemplar],
            )
            .map_err(error)?;
            bump_revision(tx)?;
            Ok(true)
        })
    }

    pub(super) fn preserve_deferred(
        &self,
        id: &str,
        expected: i64,
        source: &str,
        path: &std::path::Path,
    ) -> Result<()> {
        self.write(|tx| {
            check_sources_revision(tx, expected)?;
            let scan_id = scope_scan_id(id, source);
            tx.execute("INSERT OR IGNORE INTO cache.scan VALUES (?1,?2,?3,'incomplete','[]')", params![scan_id,source,expected]).map_err(error)?;
            let locator = json!({"pathKey":super::path_identity::key(path)}).to_string();
            tx.execute("UPDATE cache.observation SET scan_id=?1 WHERE exemplar_id IN
                (SELECT id FROM exemplar WHERE json_extract(anchor_json,'$.pathKey')=json_extract(?2,'$.pathKey') AND retired=0)", params![scan_id,locator]).map_err(error)?;
            Ok(())
        })
    }

    /// Publishes one bounded batch of analysed exemplars in one transaction.
    pub fn publish_scan(
        &self,
        id: &str,
        expected_sources: i64,
        items: &[Scanned],
        scopes: &[(String, bool)],
    ) -> Result<Published> {
        self.restore_trashed_items(items)?;
        self.write(|tx| {
            let current = check_sources_revision(tx, expected_sources)?;
            for (source, complete) in scopes {
                let status = if *complete { "complete" } else { "incomplete" };
                tx.execute(
                    "INSERT OR REPLACE INTO cache.scan VALUES (?1,?2,?3,?4,'[]')",
                    params![scope_scan_id(id, source), source, current, status],
                )
                .map_err(error)?;
            }
            let roots = coverage_roots(tx)?;
            let mut result = Published::default();
            let mut sorted: Vec<_> = items.iter().collect();
            sorted.sort_by(|a, b| {
                b.modified
                    .cmp(&a.modified)
                    .then_with(|| a.path.cmp(&b.path))
                    .then_with(|| a.observation.member.cmp(&b.observation.member))
            });
            for item in sorted {
                let outcome = publish_item(tx, &roots, id, item, &mut result)?;
                record_file_state(tx, id, item)?;
                result.changed |= outcome != "unchanged";
                result.outcomes.push(outcome.into());
            }
            reconcile_members(tx, id, items, &mut result)?;
            result.changed |= tx.execute("DELETE FROM fiche_forgotten WHERE fiche_id IN (SELECT e.fiche_id FROM exemplar e JOIN cache.coverage v ON v.exemplar_id=e.id JOIN source s ON s.id=v.source_id WHERE s.status='active')",[]).map_err(error)? > 0;
            result.changed |= super::lunii_db::fill_missing(tx)? > 0;
            result.revision = if result.changed { bump_revision(tx)? } else { tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)).map_err(error)? };
            Ok(result)
        })
    }

    /// Publishes the files a watcher event, an own write or a reconciliation
    /// touched, and confirms the absence of `removed` files, in one
    /// transaction. Nothing else in the source is read or changed; the
    /// revision advances only if the index changed.
    pub fn publish_targeted(
        &self,
        id: &str,
        expected_sources: i64,
        source: &str,
        items: &[Scanned],
        removed: &[Vec<u8>],
    ) -> Result<Published> {
        self.restore_trashed_items(items)?;
        self.write(|tx| {
            let current = check_sources_revision(tx, expected_sources)?;
            publish_targeted_tx(tx, id, current, source, items, removed)
        })
    }

    pub(crate) fn publish_repatriated_items(
        &self,
        directory: &std::path::Path,
        source: &str,
        items: &[Scanned],
    ) -> Result<Published> {
        self.restore_trashed_items(items)?;
        self.write(|tx| {
            let stored = super::sources::bytes(directory);
            let inserted = tx.execute("INSERT INTO source(id,path,path_key,origin,status,revision,resolved_path) VALUES (?1,?2,?3,'repatriated','active',(SELECT sources_revision+1 FROM catalogue),?2) ON CONFLICT(id) DO NOTHING", params![source, stored, super::path_identity::key(directory)]).map_err(error)?;
            if inserted > 0 {
                tx.execute("UPDATE catalogue SET sources_revision=sources_revision+1", []).map_err(error)?;
            }
            let current = tx.query_row("SELECT sources_revision FROM catalogue", [], |r| r.get(0)).map_err(error)?;
            publish_targeted_tx(tx, &uuid::Uuid::new_v4().to_string(), current, source, items, &[])
        })
    }

    /// Closes each scope. A failed or cut root only makes unseen observations
    /// unavailable: it never retires anchors nor deletes personal information.
    pub fn finalize_scan(
        &self,
        id: &str,
        expected_sources: i64,
        scopes: &[(String, bool)],
    ) -> Result<i64> {
        // An empty mount point cannot prove that known packs were deleted.
        let mut empty_roots = std::collections::BTreeSet::new();
        for (source, complete) in scopes {
            if *complete && self.empty_known_source(source)? {
                empty_roots.insert(source.clone());
            }
        }
        self.write(|tx| {
            let current = check_sources_revision(tx, expected_sources)?;
            let mut changed = false;
            for (source, complete) in scopes {
                let scan_id = scope_scan_id(id, source);
                let status = if *complete { "complete" } else { "incomplete" };
                tx.execute(
                    "INSERT OR REPLACE INTO cache.scan VALUES (?1,?2,?3,?4,'[]')",
                    params![scan_id, source, current, status],
                )
                .map_err(error)?;
                let mut statement = tx.prepare("SELECT DISTINCT e.anchor_json FROM exemplar e JOIN cache.coverage v ON v.exemplar_id=e.id WHERE v.source_id=?1 AND e.retired=0").map_err(error)?;
                let anchors = statement.query_map([source], |r| r.get::<_, String>(0)).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
                for anchor in anchors {
                    let parsed: Value = serde_json::from_str(&anchor).map_err(error)?;
                    if parsed["path"].as_str().is_some_and(|path| super::writes::shared().classify(std::path::Path::new(path), std::time::Instant::now()) == super::writes::Verdict::Deferred) {
                        tx.execute("UPDATE cache.observation SET scan_id=?1 WHERE exemplar_id IN (SELECT id FROM exemplar WHERE anchor_json=?2)", params![scan_id,anchor]).map_err(error)?;
                    }
                }
                let state = if *complete && !empty_roots.contains(source) { "missing" } else { "unavailable" };
                changed |= tx.execute(MARK_UNSEEN, params![source, id, state])
                    .map_err(error)? > 0;
                if *complete && !empty_roots.contains(source) {
                    tx.execute(PRUNE_FILE_STATES, params![source, id])
                        .map_err(error)?;
                }
                tx.execute(PRUNE_SCANS, params![source, scan_id])
                    .map_err(error)?;
            }
            if changed { bump_revision(tx) } else { tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)).map_err(error) }
        })
    }
}

/// Remembers the last conclusive state of an analysed file; a file still
/// being written or unreachable is examined again next time.
fn record_file_state(tx: &Transaction<'_>, scan: &str, item: &Scanned) -> Result<()> {
    let state = item.observation.state.as_str();
    if state != "available" && failure_outcome(state) != "refused" {
        return Ok(());
    }
    tx.execute(
        UPSERT_FILE_STATE,
        params![
            item.path_key,
            item.source_id,
            item.path,
            item.observation
                .listening_token
                .as_deref()
                .unwrap_or(&item.token),
            item.file_id,
            scan
        ],
    )
    .map_err(error)?;
    Ok(())
}

fn current_anchor(tx: &Transaction<'_>, locator: &str) -> Result<Option<Anchor>> {
    tx.query_row(SELECT_CURRENT_ANCHOR, [locator], |r| {
        Ok(Anchor {
            exemplar: r.get(0)?,
            card: r.get(1)?,
            uuid: r.get(2)?,
            token: r.get(3)?,
            state: r
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| "unavailable".into()),
            raw: r.get(5)?,
            locator: r.get(6)?,
            file_id: r.get(7)?,
        })
    })
    .optional()
    .map_err(error)
}

fn publish_item(
    tx: &Transaction<'_>,
    roots: &[(String, std::path::PathBuf)],
    scan: &str,
    item: &Scanned,
    result: &mut Published,
) -> Result<&'static str> {
    let conversion: Option<(String, String)> = tx
        .query_row(
            "SELECT source_token,provenance_json FROM file_conversion WHERE path_key=?1",
            [super::writes::comparison_key(std::path::Path::new(
                &item.path,
            ))],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(error)?;
    let mut converted = item.observation.clone();
    if let Some((token, provenance)) = conversion.filter(|(token, _)| {
        super::files::publication_matches(std::path::Path::new(&item.path), token)
    }) {
        let provenance: Value = serde_json::from_str(&provenance).map_err(error)?;
        if provenance["format"] == "fsDirectory" {
            converted.identity = serde_json::from_value(provenance["identity"].clone()).ok();
            if let Some(identity) = converted.identity.as_mut() {
                identity.reliable = false;
            }
        }
        converted.conversion_provenance = Some(provenance);
        let _ = token;
    }
    let observation = &converted;
    let scan_id = scope_scan_id(scan, &item.source_id);
    let member_key = observation.member_key();
    let locator = json!({
        "path": item.path,
        "pathKey": item.path_key,
        "memberKey": member_key,
        "member": observation.member,
    })
    .to_string();
    let locator_key = json!({
        "pathKey": item.path_key,
        "memberKey": member_key,
        "member": observation.member,
    })
    .to_string();

    if observation.state != "available" {
        let statement = if member_key.is_some() {
            MARK_FAILED_MEMBER
        } else {
            MARK_FAILED_FILE
        };
        // Preserve the last readable metadata, but settle this completed failure
        // with its new listening token so unchanged containers can be reused.
        tx.execute(
            statement,
            params![
                observation.state,
                locator,
                scan_id,
                serde_json::to_string(observation).map_err(error)?
            ],
        )
        .map_err(error)?;
        return Ok(failure_outcome(&observation.state));
    }

    let uuid = observation.uuid();
    let old = current_anchor(tx, &locator)?;
    // A verified save at the same path may give a legacy project its first
    // UUID. Archive children still require unchanged content or the same UUID.
    let attested = member_key.is_none()
        && observation.format == "project"
        && uuid.is_some()
        && old.as_ref().is_some_and(|old| {
            old.uuid.is_none()
                && item.save_prestate.as_ref().is_some_and(|before| {
                    before.token == old.token
                        && before.file_id.is_some()
                        && before.file_id == old.file_id
                })
        });
    let mut pending = if let (Some(old), Some(uuid)) = (&old, uuid) {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM identity_convergence WHERE exemplar_id=?1 AND pack_uuid=?2)",
            params![old.exemplar,uuid], |r| r.get::<_, bool>(0)).map_err(error)?
            && old.file_id.is_some() && old.file_id == item.file_id
    } else {
        false
    };
    if attested && !pending {
        pending = !acquire_identity(tx, old.as_ref().unwrap(), uuid.unwrap(), observation)?;
    }
    let same = attested
        || pending
        || old.as_ref().is_some_and(|old| match uuid {
            Some(uuid) => old.uuid.as_deref() == Some(uuid),
            None => old.uuid.is_none() && old.token == item.token,
        });
    let publication: Option<(String, String, String, String)> = if member_key.is_none() {
        tx.query_row(
            "SELECT source_token,fiche_id,exemplar_id,mode FROM file_publication WHERE path_key=?1",
            [super::writes::comparison_key(std::path::Path::new(
                &item.path,
            ))],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(error)?
    } else {
        None
    };
    let publication = publication.filter(|(token, _, _, _)| {
        super::files::publication_matches(std::path::Path::new(&item.path), token)
    });
    let (exemplar, card, outcome) = if let Some((_, card, exemplar, mode)) = publication {
        tx.execute(
            "DELETE FROM file_publication WHERE path_key=?1",
            [super::writes::comparison_key(std::path::Path::new(
                &item.path,
            ))],
        )
        .map_err(error)?;
        (
            exemplar,
            card,
            if mode == "replace" {
                "updated"
            } else {
                "indexedNew"
            },
        )
    } else {
        match old.as_ref().filter(|_| same) {
            Some(old) => {
                let outcome = if old.token == item.token
                    && old.state == observation.state
                    && old.locator == locator
                    && old.raw.as_deref()
                        == Some(serde_json::to_string(observation).map_err(error)?.as_str())
                {
                    "unchanged"
                } else {
                    "updated"
                };
                (old.exemplar.clone(), old.card.clone(), outcome)
            }
            None => {
                if let Some(old) = &old {
                    tx.execute("UPDATE exemplar SET retired=1 WHERE id=?1", [&old.exemplar])
                        .map_err(error)?;
                    tx.execute(RETIRE_OBSERVATION, [&old.exemplar])
                        .map_err(error)?;
                }
                let card = card_for(tx, observation, result)?;
                let exemplar = uuid::Uuid::new_v4().to_string();
                (exemplar, card, "indexedNew")
            }
        }
    };

    let container_id = if observation.member.is_some() {
        Some(upsert_container(tx, item)?)
    } else {
        None
    };
    tx.execute(
        UPSERT_EXEMPLAR,
        params![
            exemplar,
            card,
            locator,
            if pending { None } else { uuid },
            item.token,
            container_id
        ],
    )
    .map_err(error)?;
    tx.execute(
        "INSERT OR REPLACE INTO exemplar_file_state VALUES (?1,?2)",
        params![exemplar, item.file_id],
    )
    .map_err(error)?;
    let raw = serde_json::to_string(observation).map_err(error)?;
    tx.execute(
        UPSERT_OBSERVATION,
        params![
            exemplar,
            locator_key.as_bytes(),
            item.token,
            observation.state,
            observation.format,
            item.modified,
            item.size as i64,
            raw,
            scan_id,
            container_id
        ],
    )
    .map_err(error)?;
    result.changed |= tx
        .execute(
            "INSERT OR IGNORE INTO cache.coverage VALUES (?1,?2)",
            params![item.source_id, exemplar],
        )
        .map_err(error)?
        > 0;
    result.changed |= cover_sources(tx, roots, &exemplar, &item.path)?;
    record_extracted_values(tx, &exemplar, item)?;
    super::data::card::publish_candidates(tx, &exemplar, observation)?;
    update_reference(tx, &card, &exemplar, outcome, observation, &raw)?;
    if outcome == "updated" {
        result.cards_updated += 1;
    }
    tx.execute(
        "DELETE FROM save_receipt WHERE path_key=?1",
        [&item.path_key],
    )
    .map_err(error)?;
    Ok(outcome)
}

/// Reliable UUID: the card already holding it, else a new card owning it.
/// Without one, always a new card.
fn card_for(
    tx: &Transaction<'_>,
    observation: &Observation,
    result: &mut Published,
) -> Result<String> {
    let uuid = observation.uuid();
    if let Some(uuid) = uuid {
        let known: Option<String> = tx
            .query_row(
                "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
                [uuid],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if let Some(card) = known {
            return Ok(card);
        }
    }
    let card = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO fiche VALUES (?1,unixepoch(),0,0)", [&card])
        .map_err(error)?;
    result.cards_created += 1;
    if let Some(uuid) = uuid {
        let provenance = serde_json::to_string(&observation.identity).map_err(error)?;
        tx.execute(
            "INSERT INTO pack_identity VALUES (?1,?2,?3)",
            params![uuid, card, provenance],
        )
        .map_err(error)?;
    }
    Ok(card)
}

/// The container is the real file; its durable id never depends on the
/// archive digest, so children keep their own continuity rules.
fn upsert_container(tx: &Transaction<'_>, item: &Scanned) -> Result<String> {
    let anchor = json!({"path": item.path, "pathKey": item.path_key}).to_string();
    let known: Option<String> = tx
        .query_row(SELECT_CONTAINER, [&anchor], |r| r.get(0))
        .optional()
        .map_err(error)?;
    let container = known.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    tx.execute(UPSERT_CONTAINER, params![container, anchor, item.token])
        .map_err(error)?;
    Ok(container)
}

fn record_extracted_values(tx: &Transaction<'_>, exemplar: &str, item: &Scanned) -> Result<()> {
    tx.execute(
        "DELETE FROM cache.extracted_value WHERE exemplar_id=?1 AND candidate_key != (SELECT '@unreadable:' || content_revision FROM cache.observation WHERE exemplar_id=?1)",
        [exemplar],
    )
    .map_err(error)?;
    for (pointer, field) in &item.observation.fields {
        let raw = field.raw_value.as_ref().map(Value::to_string);
        let name = pointer.rsplit('/').next().unwrap_or(pointer);
        let provenance = json!({"jsonPointer": field.source, "contentToken": item.token});
        tx.execute(
            INSERT_EXTRACTED,
            params![
                exemplar,
                name,
                pointer,
                field.presence,
                field.validity,
                raw,
                provenance.to_string()
            ],
        )
        .map_err(error)?;
    }
    Ok(())
}

/// The first published exemplar of a card becomes its reference; the scan
/// publishes the most recently modified files first. The reference then
/// stays put: only its own changes refresh the card values.
fn update_reference(
    tx: &Transaction<'_>,
    card: &str,
    exemplar: &str,
    outcome: &str,
    observation: &Observation,
    raw: &str,
) -> Result<()> {
    // An imported chosen source has no local attestation. Only explicit
    // reference selection may replace it after a source is rescanned.
    if tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM import_reference WHERE fiche_id=?1)",
            [card],
            |r| r.get::<_, bool>(0),
        )
        .map_err(error)?
    {
        return Ok(());
    }
    let reference: Option<String> = tx
        .query_row(
            "SELECT exemplar_id FROM reference_source WHERE fiche_id=?1",
            [card],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if reference.is_none() {
        tx.execute(
            "INSERT INTO reference_source VALUES (?1,?2,unixepoch(),0)",
            params![card, exemplar],
        )
        .map_err(error)?;
    }
    let refresh =
        reference.is_none() || (reference.as_deref() == Some(exemplar) && outcome != "unchanged");
    if !refresh {
        return Ok(());
    }
    let _ = (observation, raw);
    super::data::mutate::reference::refresh_values(tx, card, exemplar)?;
    if reference.is_some() {
        tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [card])
            .map_err(error)?;
    }
    Ok(())
}

const VERSION_FIELDS: &[&str] = &["/packMetadata/version", "/packVersion", "/version"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPage {
    pub catalogue_revision: i64,
    pub items: Vec<Value>,
    pub total_matching: usize,
    pub cursor: Option<String>,
}

const AVAILABLE_CARD: &str = "EXISTS (SELECT 1 FROM exemplar e
     JOIN cache.observation o ON o.exemplar_id=e.id
     JOIN cache.coverage v ON v.exemplar_id=e.id
     JOIN source s ON s.id=v.source_id
     WHERE e.fiche_id=f.id AND e.retired=0 AND s.status='active' AND o.state='available')";

impl Store {
    #[cfg(test)]
    pub fn list_entries(&self, limit: usize, cursor: Option<&str>) -> Result<EntryPage> {
        self.query_entries(limit, cursor, true)
    }

    /// Paged index read. A cursor is bound to the catalogue revision, the
    /// filter and the page size; any change makes it invalid and the read is
    /// refused with `CATALOG_ENTRIES_CURSOR_EXPIRED` (the caller restarts).
    pub fn query_entries(
        &self,
        limit: usize,
        cursor: Option<&str>,
        include_unavailable: bool,
    ) -> Result<EntryPage> {
        self.query_entries_after_revision(limit, cursor, include_unavailable, || {})
    }

    pub(super) fn query_entries_after_revision(
        &self,
        limit: usize,
        cursor: Option<&str>,
        include_unavailable: bool,
        after_revision: impl FnOnce(),
    ) -> Result<EntryPage> {
        let limit = limit.clamp(1, 200);
        let page = self.read_snapshot(|c| {
            let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            after_revision();
            let offset = match cursor {
                Some(cursor) => match parse_cursor(cursor, revision, include_unavailable, limit) {
                    Some(offset) => offset,
                    None => return Ok(None),
                },
                None => 0,
            };
            let predicate = if include_unavailable {
                "(EXISTS(SELECT 1 FROM exemplar e WHERE e.fiche_id=f.id AND e.retired=0) OR NOT EXISTS(SELECT 1 FROM file_removal WHERE state='complete' AND CASE WHEN json_valid(evidence_json) THEN coalesce(json_extract(evidence_json,'$.retainedInTrash'),0)=1 AND json_extract(evidence_json,'$.plan.targets[0].exemplarId') IN (SELECT te.id FROM exemplar te WHERE te.fiche_id=f.id) ELSE 0 END))"
            } else {
                AVAILABLE_CARD
            };
            let total_matching = c.query_row(
                &format!("SELECT count(*) FROM fiche f WHERE {predicate} AND NOT EXISTS(SELECT 1 FROM fiche_grouping g WHERE g.fiche_id=f.id)"),
                [],
                |r| r.get::<_, i64>(0).map(|v| v as usize),
            )?;
            let rows = {
                let mut statement = c.prepare(&format!(
                    "SELECT f.id,f.favorite,r.exemplar_id,f.created_at FROM fiche f
                     LEFT JOIN reference_source r ON r.fiche_id=f.id
                     WHERE {predicate} AND NOT EXISTS(SELECT 1 FROM fiche_grouping g WHERE g.fiche_id=f.id) ORDER BY f.id LIMIT ?1 OFFSET ?2"
                ))?;
                let rows = statement.query_map(params![limit as i64, offset as i64], |r| {
                    Ok(CardRow {
                        id: r.get(0)?,
                        favorite: r.get(1)?,
                        reference: r.get(2)?,
                        added_at: r.get(3)?,
                    })
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut items = Vec::new();
            for row in rows {
                items.push(entry_item(c, row, true)?);
            }
            let next = offset + items.len();
            Ok(Some(EntryPage {
                catalogue_revision: revision,
                items,
                total_matching,
                cursor: (next < total_matching)
                    .then(|| format!("{revision}:{include_unavailable}:{limit}:{next}")),
            }))
        })?;
        page.ok_or_else(|| UserMessage::new(codes::CATALOG_ENTRIES_CURSOR_EXPIRED))
    }
}

struct CardRow {
    id: String,
    favorite: bool,
    reference: Option<String>,
    added_at: i64,
}

/// Formats whose on-disk size is that of a folder entry, not of the pack.
const FOLDER_FORMATS: &[&str] = &["studioDirectory", "fsDirectory"];

/// Valid value of the first observed field among `pointers`, read from a
/// stored observation (same rule as `Observation::valid_field`).
fn observed_value<'a>(observation: &'a Value, pointers: &[&str]) -> Option<&'a Value> {
    pointers.iter().find_map(|pointer| {
        let field = observation.get("fields")?.get(*pointer)?;
        (field.get("validity")?.as_str()? == "valid")
            .then(|| field.get("rawValue"))
            .flatten()
    })
}

/// Active sources whose scans cover this exemplar, in a stable order.
fn covering_sources(c: &rusqlite::Connection, exemplar: &str) -> rusqlite::Result<Vec<String>> {
    c.prepare(
        "SELECT v.source_id FROM cache.coverage v JOIN source s ON s.id=v.source_id
         WHERE v.exemplar_id=?1 AND s.status='active' ORDER BY v.source_id",
    )?
    .query_map([exemplar], |r| r.get::<_, String>(0))?
    .collect()
}

pub(crate) fn entry_for_card(
    c: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<Value>> {
    let card=c.query_row("SELECT f.id,f.favorite,r.exemplar_id,f.created_at FROM fiche f LEFT JOIN reference_source r ON r.fiche_id=f.id WHERE f.id=?1",[id],|r|Ok(CardRow{id:r.get(0)?,favorite:r.get(1)?,reference:r.get(2)?,added_at:r.get(3)?})).optional()?;
    card.map(|card| entry_item(c, card, false)).transpose()
}

#[cfg(test)]
thread_local! {
    /// Measurement only: list without cover signatures (the pre-signature cost).
    pub(crate) static SKIP_COVER_SIGNATURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `cover_signature` is published by the entry list only: single-card reads
/// (fiche, removal preview, forget pages) do not key thumbnails.
fn entry_item(
    c: &rusqlite::Connection,
    card: CardRow,
    cover_signature: bool,
) -> rusqlite::Result<Value> {
    let CardRow {
        id,
        favorite,
        reference,
        added_at,
    } = card;
    let exemplars = c
        .prepare("SELECT id,anchor_json,retired,created_at FROM exemplar WHERE fiche_id=?1")?
        .query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut entries = Vec::new();
    let mut names = Vec::new();
    let mut reference_unavailable = true;
    for (exemplar, anchor, retired, exemplar_added_at) in exemplars {
        let anchor: Value = serde_json::from_str(&anchor).unwrap_or(Value::Null);
        // The read connection attaches the cache: one snapshot, no
        // connection opened per exemplar.
        let observation = c
            .prepare(
                "SELECT state,format,modified_at,raw_observation_json,byte_size
                 FROM cache.observation WHERE exemplar_id=?1",
            )?
            .query_row([&exemplar], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })
            .optional()?;
        let (mut state, format, modified, raw, byte_size) = observation.unwrap_or_else(|| {
            (
                "unavailable".into(),
                "unknown".into(),
                0,
                "null".into(),
                None,
            )
        });
        if reference.as_deref() == Some(&exemplar) {
            reference_unavailable = retired || state != "available";
        }
        if !retired && state != "missing" {
            let name = anchor
                .get("member")
                .and_then(Value::as_str)
                .or_else(|| anchor.get("path").and_then(Value::as_str));
            if let Some(name) = name {
                let file = std::path::Path::new(name)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                names.push(file.to_owned());
            }
        }
        let source_ids = covering_sources(c, &exemplar)?;
        let source_unavailable = !source_ids.is_empty()
            && source_ids.iter().all(|sid| {
                c.query_row(
                    "SELECT availability FROM source_health WHERE source_id=?1",
                    [sid],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
                .as_deref()
                    == Some("unavailable")
            });
        if source_unavailable {
            state = "unavailable".into();
        }
        let available = !retired && state == "available" && !source_ids.is_empty();
        let observation = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        // Stored observation and `lunii_pack` only: no file is read per card.
        let official = super::observed_official(&observation, Some(c));
        let child = anchor.get("member").is_some_and(|m| !m.is_null());
        // A child's bytes are those of its whole archive and a folder's
        // entry size is not the pack's: neither is published as a size.
        let size_bytes = byte_size.filter(|_| !child && !FOLDER_FORMATS.contains(&format.as_str()));
        let version_declared = observed_value(&observation, VERSION_FIELDS)
            .and_then(Value::as_i64)
            .map(Value::from);
        let container = child.then(|| json!({ "path": anchor.get("path") }));
        let generation = if format == "project" {
            Some(super::open::generation::state(c, &exemplar, &observation)?)
        } else {
            None
        };
        entries.push(json!({
            "id": exemplar,
            "locator": anchor,
            "archiveRemoval": if child { super::files::trash::archive_removal(c, &exemplar)? } else { Value::Null },
            "retired": retired,
            "state": state,
            "availability": if available { "available" } else { "unavailable" },
            "format": format,
            "modifiedAt": modified,
            "addedAt": exemplar_added_at,
            "sizeBytes": size_bytes,
            "versionDeclared": version_declared,
            "sourceIds": source_ids,
            "container": container,
            "official": official,
            "observation": observation,
        }));
        if let Some(generation) = generation {
            entries.last_mut().expect("just inserted")["generation"] = generation;
        }
    }
    // One line per format, most recently modified first, then by path.
    entries.sort_by(|a, b| {
        a["format"]
            .as_str()
            .cmp(&b["format"].as_str())
            .then_with(|| b["modifiedAt"].as_i64().cmp(&a["modifiedAt"].as_i64()))
            .then_with(|| {
                a["locator"]["path"]
                    .as_str()
                    .cmp(&b["locator"]["path"].as_str())
            })
    });
    // Filename fallback uses the principal exemplar, in the same order as the UI.
    names = super::lunii_db::ordered_names(&entries);
    let resolved = super::data::card::resolution(c, &id, &names)?;
    #[cfg(test)]
    let cover_signature = cover_signature && !SKIP_COVER_SIGNATURE.with(|skip| skip.get());
    let cover_signature = if cover_signature {
        Some(super::thumbnails::cover_signature(c, &id, &resolved)?)
    } else {
        None
    };
    let age_origin = resolved
        .fields
        .iter()
        .find(|f| {
            matches!(f.field.as_str(), "ageMin" | "ageMax") && !f.effective["value"].is_null()
        })
        .map(|f| f.effective["origin"].clone());
    let values = resolved.values;
    let age_from_name = resolved.age_from_name;
    let age_conflict = resolved.age_conflict;
    let fiche_revision: i64 =
        c.query_row("SELECT revision FROM fiche WHERE id=?1", [&id], |r| {
            r.get(0)
        })?;
    // List consumers read the same effective values as the complete card.
    let text = |field: &str| values.get(field).filter(|v| v.is_string()).cloned();
    let (description, author) = (text("description"), text("author"));
    // A reliable pack whose identity is already known elsewhere waits for an
    // explicit decision; the card exposes it instead of merging early.
    let pending = c
        .query_row(
            "SELECT p.pack_uuid,p.known_fiche_id FROM identity_convergence p
             JOIN exemplar e ON e.id=p.exemplar_id WHERE e.fiche_id=?1 AND e.retired=0",
            [&id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let offline_reason = if entries.iter().any(|e| e["availability"] == "available") {
        None
    } else if !entries.iter().any(|e| e["retired"] != true)
        || entries
            .iter()
            .filter(|e| e["retired"] != true)
            .any(|e| e["state"] != "missing")
    {
        Some("unavailable")
    } else {
        Some("missing")
    };
    // The same decision as the send gate, for any copy still listed.
    let official = entries
        .iter()
        .any(|e| e["retired"] != true && e["official"] == true);
    let mut item = json!({
        "offlineReason": offline_reason,
        "official": official,
        "id": id,
        "favorite": favorite,
        "tagIds": super::data::organization::membership_ids(c,"tag",&id)?,
        "tags": c.prepare("SELECT t.id,t.label FROM tag t JOIN tag_member m ON m.tag_id=t.id WHERE m.fiche_id=?1 ORDER BY t.normalized_label,t.id")?.query_map([&id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?})))?.collect::<rusqlite::Result<Vec<_>>>()?,
        "ficheRevision": fiche_revision,
        "corrections": resolved.corrections,
        "addedAt": added_at,
        "pendingConvergence": pending.map(|(uuid, known)| json!({"packUuid": uuid, "knownFicheId": known})),
        "referenceExemplarId": reference,
        "referenceUnavailable": reference_unavailable,
        "values": values,
        "displayTitle": values.get("title").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_owned).or_else(|| names.first().map(|name| super::lunii_db::clean(name))).or_else(|| entries.iter().filter(|e| e["retired"] != true).find_map(|e| e["locator"]["member"].as_str().or_else(|| e["locator"]["path"].as_str())).map(super::lunii_db::clean)),
        "ageFromName": age_from_name,
        "ageOrigin": age_origin,
        "ageConflict": age_conflict,
        "titleConflict": resolved.title_conflict,
        "subtitle": values.get("subtitle"),
        "language": values.get("language"),
        "description": description,
        "author": author,
        "durationSeconds": values.get("durationSeconds"),
        "storyCount": values.get("storyCount"),
        "keywords": values.get("keywords"),
        "exemplars": entries,
    });
    if let Some(signature) = cover_signature {
        item["coverSignature"] = json!(signature);
    }
    Ok(item)
}

fn parse_cursor(cursor: &str, revision: i64, include: bool, limit: usize) -> Option<usize> {
    let parts: Vec<_> = cursor.split(':').collect();
    if parts.len() != 4
        || parts[0].parse::<i64>().ok()? != revision
        || parts[1].parse::<bool>().ok()? != include
        || parts[2].parse::<usize>().ok()? != limit
    {
        return None;
    }
    parts[3].parse().ok()
}

fn publish_targeted_tx(
    tx: &Transaction<'_>,
    id: &str,
    current: i64,
    source: &str,
    items: &[Scanned],
    removed: &[Vec<u8>],
) -> Result<Published> {
    let scan_id = scope_scan_id(id, source);
    tx.execute(
        "INSERT OR REPLACE INTO cache.scan VALUES (?1,?2,?3,'targeted','[]')",
        params![scan_id, source, current],
    )
    .map_err(error)?;
    let roots = coverage_roots(tx)?;
    let mut result = Published::default();
    let mut sorted: Vec<_> = items.iter().collect();
    sorted.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.observation.member.cmp(&b.observation.member))
    });
    for item in sorted {
        let outcome = publish_item(tx, &roots, id, item, &mut result)?;
        record_file_state(tx, id, item)?;
        result.changed |= outcome != "unchanged";
        result.outcomes.push(outcome.into());
    }
    reconcile_members(tx, id, items, &mut result)?;
    for key in removed {
        let locator = json!({ "pathKey": key }).to_string();
        result.missing += tx
            .execute(MARK_REMOVED_FILE, params![locator, scan_id])
            .map_err(error)? as u64;
        tx.execute("DELETE FROM cache.file_state WHERE path_key=?1", [key])
            .map_err(error)?;
    }
    result.changed |= result.missing > 0;
    result.changed |= super::lunii_db::fill_missing(tx)? > 0;
    result.revision = if result.changed {
        bump_revision(tx)?
    } else {
        tx.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
            .map_err(error)?
    };
    Ok(result)
}
