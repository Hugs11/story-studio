//! Native trash holds personal data, including after an item's disappearance.
//! Receipts live in the existing durable removal journal, not in a cache.
use super::{patch, trash::absence_confirmed};
use crate::services::catalogue::{
    probe,
    store::{error, Store},
    writes, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Receipt {
    payload: PathBuf,
    parent_id: String,
}
impl Receipt {
    pub(super) fn capture(payload: PathBuf) -> Option<Self> {
        if !payload.is_absolute() {
            return None;
        }
        let parent_id = writes::file_id(payload.parent()?)?;
        Some(Self { payload, parent_id })
    }
    fn gone(&self) -> bool {
        absence_confirmed(&self.payload, Some(&self.parent_id))
    }
}

pub(crate) const RETAINED: &str = "state='complete' AND CASE WHEN json_valid(evidence_json) THEN coalesce(json_extract(evidence_json,'$.retainedInTrash'),0)=1 ELSE 0 END";

pub(crate) fn retained_exemplars(c: &Connection) -> rusqlite::Result<HashSet<String>> {
    c.prepare(&format!("SELECT json_extract(evidence_json,'$.plan.targets[0].exemplarId') FROM file_removal WHERE {RETAINED}"))?
        .query_map([], |r| r.get(0))?.collect()
}

pub(crate) fn retains(c: &Connection, fiche: &str) -> Result<bool> {
    c.query_row(&format!("SELECT EXISTS(SELECT 1 FROM file_removal WHERE {RETAINED} AND json_extract(evidence_json,'$.plan.targets[0].exemplarId') IN (SELECT id FROM exemplar WHERE fiche_id=?1))"), [fiche], |r| r.get(0)).map_err(error)
}

/// A released trash receipt is not destruction evidence. A retired exemplar
/// keeps its fiche safe independently of retainedInTrash, unless a completed
/// permanent deletion proves destruction of that exact exemplar.
pub(super) fn has_unresolved_exemplar(c: &Connection, fiche: &str) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM exemplar e WHERE e.fiche_id=?1 AND e.retired=1
         AND EXISTS(SELECT 1 FROM file_removal t WHERE t.state IN ('complete','purgePending')
           AND CASE WHEN json_valid(t.evidence_json) THEN
             json_extract(t.evidence_json,'$.plan.action')='trash'
             AND json_extract(t.evidence_json,'$.plan.targets[0].exemplarId')=e.id ELSE 0 END)
         AND NOT EXISTS(SELECT 1 FROM file_removal d WHERE d.state IN ('complete','purgePending')
           AND (d.state='purgePending' OR EXISTS(
             SELECT 1 FROM file_operation o WHERE o.id=d.id AND o.state='success'))
           AND CASE WHEN json_valid(d.evidence_json) THEN
             json_extract(d.evidence_json,'$.plan.action')='deletePermanently'
             AND json_extract(d.evidence_json,'$.plan.targets[0].exemplarId')=e.id ELSE 0 END
           AND NOT EXISTS(SELECT 1 FROM file_operation o WHERE o.id=d.id AND o.state='running')))",
        [fiche],
        |r| r.get(0),
    )
    .map_err(error)
}

enum Observation {
    Unknown,
    Restored,
    Missing,
}
fn observe(evidence: &Value) -> Observation {
    let Some(source) = evidence["plan"]["targets"][0]["sourcePath"].as_str() else {
        return Observation::Unknown;
    };
    let source = Path::new(source);
    if !source.is_absolute() || source.parent().is_none() {
        return Observation::Unknown;
    }
    let receipt = serde_json::from_value::<Receipt>(evidence["trashReceipt"].clone()).ok();
    // A missing receipt is never proof of emptying. Still allow a verified
    // restoration after interruption between the native move and its receipt.
    if receipt.as_ref().is_some_and(|r| !r.gone()) {
        return Observation::Unknown;
    }
    match std::fs::symlink_metadata(source) {
        Ok(_) => {
            let Ok(before) =
                serde_json::from_value::<patch::Snapshot>(evidence["snapshot"].clone())
            else {
                return Observation::Unknown;
            };
            if before
                .identities
                .get("")
                .is_some_and(|id| writes::file_id(source).as_ref() == Some(id))
            {
                return Observation::Restored;
            }
            let Ok(now) = patch::snapshot(source, &AtomicBool::new(false)) else {
                return Observation::Unknown;
            };
            if before.content == now.content {
                Observation::Restored
            } else if receipt.as_ref().is_some_and(Receipt::gone) {
                Observation::Missing
            } else {
                Observation::Unknown
            }
        }
        Err(_)
            if receipt.as_ref().is_some_and(Receipt::gone)
                && absence_confirmed(source, evidence["parentId"].as_str()) =>
        {
            // The pack may have been restored and renamed or moved while the
            // app was closed. Two absent paths never prove permanent deletion.
            Observation::Missing
        }
        _ => Observation::Unknown,
    }
}

impl Store {
    pub(crate) fn reconcile_trash_retention(&self) -> Result<Option<i64>> {
        self.reconcile_trash_paths(None)
    }
    pub(crate) fn restore_trashed_items(
        &self,
        items: &[super::super::grouping::Scanned],
    ) -> Result<()> {
        self.restore_trashed_paths(
            &items
                .iter()
                .map(|item| PathBuf::from(&item.path))
                .collect::<Vec<_>>(),
        )
    }
    pub(crate) fn restore_trashed_paths(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.reconcile_trash_paths(Some(paths))?;
        Ok(())
    }
    fn reconcile_trash_paths(&self, paths: Option<&[PathBuf]>) -> Result<Option<i64>> {
        let rows = self.read(|c| c.prepare(&format!("SELECT id,evidence_json FROM file_removal WHERE {RETAINED} AND NOT EXISTS(SELECT 1 FROM file_operation o WHERE o.id=file_removal.id AND o.state='running')"))?
            .query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>())?;
        let mut revision = None;
        for (id, raw) in rows {
            let mut evidence: Value = serde_json::from_str(&raw).map_err(error)?;
            let Some(source) = evidence["plan"]["targets"][0]["sourcePath"].as_str() else {
                continue;
            };
            // Compare aliases outside the DB lock, before the observation probe.
            // Mutual containment uses bounded native identity confirmation for
            // case/Unicode aliases and retains Linux's byte-sensitive policy.
            if paths.is_some_and(|paths| {
                !paths.iter().any(|path| {
                    super::super::path_identity::contains(Path::new(source), path)
                        && super::super::path_identity::contains(path, Path::new(source))
                })
            }) {
                continue;
            }
            let target = PathBuf::from(source);
            let captured = evidence.clone();
            // No native IO, including an inaccessible trash volume, holds a DB lock.
            let observed =
                probe::bounded(&target, probe::PROBE_TIMEOUT, move || observe(&captured));
            let Some(observed) = observed.filter(|o| !matches!(o, Observation::Unknown)) else {
                continue;
            };
            let exemplar = evidence["plan"]["targets"][0]["exemplarId"]
                .as_str()
                .ok_or_else(|| error("missing trashed exemplar"))?
                .to_owned();
            evidence["retainedInTrash"] = Value::Bool(false);
            let changed = self.write(|tx| {
                // A user erasure or another reconciliation may have consumed it.
                let unchanged: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM file_removal WHERE id=?1 AND evidence_json=?2 AND state='complete')", params![id,raw], |r| r.get(0)).map_err(error)?;
                if !unchanged { return Ok(false); }
                let fiche: Option<String> = tx.query_row("SELECT fiche_id FROM exemplar WHERE id=?1", [&exemplar], |r|r.get(0)).optional().map_err(error)?;
                let Some(fiche) = fiche else { return Ok(false); };
                if matches!(observed, Observation::Restored) {
                    let anchor: Option<String> = tx.query_row("SELECT anchor_json FROM exemplar WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM exemplar e WHERE e.id!=?1 AND e.retired=0 AND json_extract(e.anchor_json,'$.pathKey')=json_extract(exemplar.anchor_json,'$.pathKey') AND json_extract(e.anchor_json,'$.memberKey') IS json_extract(exemplar.anchor_json,'$.memberKey'))", [&exemplar], |r| r.get(0)).optional().map_err(error)?;
                    let Some(anchor) = anchor else { return Ok(false); };
                    {
                        tx.execute("UPDATE exemplar SET retired=0 WHERE id=?1", [&exemplar]).map_err(error)?;
                        tx.execute("UPDATE cache.observation SET locator_key=CAST(json_remove(?2,'$.path') AS BLOB) WHERE exemplar_id=?1", params![exemplar,anchor]).map_err(error)?;
                    }
                }
                evidence["retentionFicheId"] = Value::String(fiche.clone());
                tx.execute("UPDATE file_removal SET evidence_json=?2 WHERE id=?1", params![id,evidence.to_string()]).map_err(error)?;
                // Releasing trash retention exposes the existing unavailable
                // fiche when no active copy remains. Its identities, corrections,
                // favorite and tags survive for later reconciliation.
                tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [&fiche]).map_err(error)?;
                tx.execute("DELETE FROM cache.search_projection WHERE fiche_id=?1", [&fiche]).map_err(error)?;
                tx.execute("UPDATE catalogue SET revision=revision+1", []).map_err(error)?;
                Ok(true)
            })?;
            if !changed {
                continue;
            }
            revision = Some(
                self.read(|c| c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0)))?,
            );
        }
        Ok(revision)
    }
}
