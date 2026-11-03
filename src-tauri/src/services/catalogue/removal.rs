//! Confirmed catalogue erasure; source pack files are never changed.
use super::{
    data::{journal, mutate::forget},
    sources::{native, SourceOutcome},
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPreview {
    pub catalogue_revision: i64,
    pub sources_revision: i64,
    pub count: usize,
    pub remaining: usize,
    pub available: usize,
    pub fiche_ids: Vec<String>,
}

// Coverage is durable path membership, including after a cache rebuild. A
// parent/child source overlap must keep the same physical exemplar alive.
fn scope(
    c: &Connection,
    removed: &str,
) -> rusqlite::Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let roots = c
        .prepare("SELECT id,path,coalesce(resolved_path,path) FROM source WHERE status='active'")?
        .query_map([], |r| {
            let frontend = |raw| {
                std::path::PathBuf::from(crate::support::paths::path_for_frontend(native(raw)))
            };
            Ok((
                r.get::<_, String>(0)?,
                (frontend(r.get(1)?), frontend(r.get(2)?)),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let target = roots.iter().find(|(id, _)| id == removed).map(|(_, p)| p);
    let mut exemplars = Vec::new();
    let mut affected = BTreeSet::new();
    let mut retained = BTreeSet::new();
    let trashed = super::files::retained_exemplars(c)?;
    for row in c
        .prepare("SELECT id,fiche_id,json_extract(anchor_json,'$.path'),retired FROM exemplar")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
    {
        let (eid, fid, path, retired) = row?;
        let restorable = trashed.contains(&eid);
        let path = path.map(std::path::PathBuf::from);
        let membership = |sid: &str,
                          root: &(std::path::PathBuf, std::path::PathBuf)|
         -> rusqlite::Result<bool> {
            Ok(path.as_ref().is_some_and(|p|p.starts_with(&root.0) || p.starts_with(&root.1)) || c.query_row("SELECT EXISTS(SELECT 1 FROM cache.coverage WHERE source_id=?1 AND exemplar_id=?2)",rusqlite::params![sid,eid],|r|r.get::<_,bool>(0))?)
        };
        let belongs = target
            .map(|p| membership(removed, p))
            .transpose()?
            .unwrap_or(false);
        let mut elsewhere = false;
        for (sid, root) in &roots {
            if sid != removed && membership(sid, root)? {
                elsewhere = true;
            }
        }
        if belongs {
            affected.insert(fid.clone());
            if !elsewhere {
                exemplars.push(eid);
            }
        }
        // A retired copy in another registered source still carries the fiche
        // while the native trash can restore it, even without cached coverage.
        if elsewhere && (!retired || restorable) {
            retained.insert(fid);
        }
    }
    let erased = affected.difference(&retained).cloned().collect();
    let kept = affected.intersection(&retained).cloned().collect();
    Ok((exemplars, erased, kept))
}

// Use the same evidence and terminal-state rules for previews and erasure.
const HISTORY: &[(&str, &str, &str, &str)] = &[
    ("file_operation", "id", "json_array(receipt_json,signature)", "state IN ('success','failed','cancelled','interrupted')"),
    ("file_journal", "id", "evidence_json", "coalesce(json_extract(evidence_json,'$.stage') IN ('complete','failed','rolledBack'),0)"),
    ("project_metadata_operation", "id", "json_array(evidence_json,receipt_json)", "state IN ('complete','aborted')"),
    ("file_identity_receipt", "journal_id", "result_json", "NOT EXISTS(SELECT 1 FROM file_journal j WHERE j.id=file_identity_receipt.journal_id AND coalesce(json_extract(j.evidence_json,'$.stage') IN ('complete','failed','rolledBack'),0)=0)"),
    ("file_removal", "id", "evidence_json", "state IN ('complete','purgePending')"),
];

pub(crate) fn require_recovery_available(c: &Connection, ids: &[String]) -> Result<()> {
    require_recovery_except(c, ids, None)
}

fn require_recovery_except(
    c: &Connection,
    ids: &[String],
    own_removal: Option<&str>,
) -> Result<()> {
    let mut all: BTreeSet<String> = ids.iter().cloned().collect();
    loop {
        let before = all.len();
        for row in c
            .prepare("SELECT fiche_id,target_id FROM fiche_grouping")
            .map_err(error)?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(error)?
        {
            let (member, target) = row.map_err(error)?;
            if all.contains(&target) {
                all.insert(member);
            }
        }
        if all.len() == before {
            break;
        }
    }
    let mut evidence = all.clone();
    for id in all {
        evidence.extend(
            c.prepare("SELECT id FROM exemplar WHERE fiche_id=?1")
                .map_err(error)?
                .query_map([id], |r| r.get::<_, String>(0))
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?,
        );
    }
    let evidence = evidence.iter().map(String::as_str).collect();
    for (table, key, columns, finished) in HISTORY {
        let mut stmt = c
            .prepare(&format!(
                "SELECT {columns} FROM {table} WHERE NOT ({finished}) AND NOT (?1 IS NOT NULL AND {key}=?1 AND '{table}'='file_operation')"
            ))
            .map_err(error)?;
        for row in stmt
            .query_map([own_removal], |r| r.get::<_, String>(0))
            .map_err(error)?
        {
            let raw = row.map_err(error)?;
            if forget::mentions(&serde_json::from_str(&raw).map_err(error)?, &evidence) {
                return Err(UserMessage::new(codes::CATALOG_FILE_RECOVERY_REQUIRED));
            }
        }
    }
    Ok(())
}

fn preview(c: &Connection, source: &str) -> Result<RemovalPreview> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM source WHERE id=?1 AND origin<>'repatriated' AND status IN ('active','hint'))",
            [source],
            |r| r.get(0),
        )
        .map_err(error)?;
    if !exists {
        return Err(UserMessage::new(codes::CATALOG_SOURCE_NOT_FOUND));
    }
    let (_, ids, kept) = scope(c, source).map_err(error)?;
    require_recovery_available(c, &ids.iter().chain(&kept).cloned().collect::<Vec<_>>())?;
    let (revision, sources) = c
        .query_row("SELECT revision,sources_revision FROM catalogue", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(error)?;
    Ok(RemovalPreview {
        catalogue_revision: revision,
        sources_revision: sources,
        count: ids.len(),
        remaining: kept.len(),
        available: 0,
        fiche_ids: ids,
    })
}

fn validate_cards(c: &Connection, ids: &[String]) -> Result<()> {
    if ids.is_empty() || ids.len() != ids.iter().collect::<BTreeSet<_>>().len() {
        return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
    }
    for id in ids {
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM fiche WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(error)?;
        if !exists {
            return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
        }
    }
    require_recovery_available(c, ids)
}

fn delete_exemplars(tx: &rusqlite::Transaction<'_>, ids: &[String]) -> Result<()> {
    for id in ids {
        // References and their saved values of a surviving fiche remain. Its
        // chosen reference becomes unavailable; the FK points to no deleted row.
        let refs = tx
            .prepare(
                "SELECT fiche_id,selected_at,revision FROM reference_source WHERE exemplar_id=?1",
            )
            .map_err(error)?
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        for (fid, selected_at, revision) in refs {
            tx.execute(
                "INSERT OR REPLACE INTO import_reference VALUES (?1,?2)",
                rusqlite::params![fid, json!({"ficheId":fid,"exemplarId":id,"selectedAt":selected_at,"revision":revision}).to_string()],
            )
            .map_err(error)?;
        }
        tx.execute("DELETE FROM reference_source WHERE exemplar_id=?1", [id])
            .map_err(error)?;
        // Keep provenance used by other exemplars' fiches, without the locator
        // of the deleted exemplar being a live foreign key.
        tx.execute(
            "UPDATE provenance SET exemplar_id=NULL WHERE exemplar_id=?1",
            [id],
        )
        .map_err(error)?;
        tx.execute(
            "DELETE FROM generation_receipt WHERE project_exemplar_id=?1 OR output_exemplar_id=?1",
            [id],
        )
        .map_err(error)?;
        for (table, column) in [
            ("identity_convergence", "exemplar_id"),
            ("exemplar_file_state", "exemplar_id"),
            ("cache.coverage", "exemplar_id"),
            ("cache.extracted_value", "exemplar_id"),
            ("cache.observation", "exemplar_id"),
            ("exemplar", "id"),
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE {column}=?1"), [id])
                .map_err(error)?;
        }
    }
    tx.execute("DELETE FROM container WHERE NOT EXISTS(SELECT 1 FROM exemplar WHERE container_id=container.id)",[]).map_err(error)?;
    Ok(())
}

pub(crate) fn purge(tx: &rusqlite::Transaction<'_>, ids: &[String]) -> Result<()> {
    purge_except(tx, ids, None)
}

// Only the completing file operation is exempted. Removal rows with pending
// native evidence always block erasure; purgePending rows have no native work left.
pub(crate) fn purge_after_file_removal(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
    operation: &str,
) -> Result<()> {
    purge_except(tx, ids, Some(operation))
}
fn purge_except(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
    own_removal: Option<&str>,
) -> Result<()> {
    require_recovery_except(tx, ids, own_removal)?;
    super::files::require_associations_available(tx, ids)?;
    // Include hidden members: grouping history must never resurrect erased data.
    let mut all: BTreeSet<String> = ids.iter().cloned().collect();
    loop {
        let before = all.len();
        let links = tx
            .prepare("SELECT fiche_id,target_id FROM fiche_grouping")
            .map_err(error)?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        for (member, target) in links {
            if all.contains(&target) {
                all.insert(member);
            }
        }
        if all.len() == before {
            break;
        }
    }
    let ids: Vec<_> = all.into_iter().collect();
    super::files::require_associations_available(tx, &ids)?;
    let mut owned_provenances = BTreeSet::new();
    for id in &ids {
        owned_provenances.extend(tx.prepare("SELECT provenance_id FROM correction WHERE fiche_id=?1 UNION SELECT provenance_id FROM reference_value WHERE fiche_id=?1 UNION SELECT id FROM provenance WHERE exemplar_id IN (SELECT id FROM exemplar WHERE fiche_id=?1)").map_err(error)?.query_map([id],|r|r.get::<_,String>(0)).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?);
    }
    // Completed file receipts may contain metadata snapshots too. Reservations
    // above protect unfinished work; completed recovery history must not retain
    // erased personal data.
    let mut evidence_ids = ids.clone();
    for id in &ids {
        evidence_ids.extend(
            tx.prepare("SELECT id FROM exemplar WHERE fiche_id=?1")
                .map_err(error)?
                .query_map([id], |r| r.get::<_, String>(0))
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?,
        );
    }
    let evidence_ids: BTreeSet<_> = evidence_ids.iter().map(String::as_str).collect();
    for (table, key, columns, finished) in HISTORY {
        let rows = tx
            .prepare(&format!(
                "SELECT {key},{columns} FROM {table} WHERE ({finished}) OR (?1 IS NOT NULL AND {key}=?1 AND '{table}'='file_operation')"
            ))
            .map_err(error)?
            .query_map([own_removal], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        for (key_value, raw) in rows {
            if serde_json::from_str(&raw)
                .ok()
                .is_some_and(|v| forget::mentions(&v, &evidence_ids))
            {
                tx.execute(&format!("DELETE FROM {table} WHERE {key}=?1"), [key_value])
                    .map_err(error)?;
            }
        }
    }
    forget::purge_personal(tx, &ids)?;
    for id in &ids {
        tx.execute(
            "DELETE FROM fiche_grouping WHERE fiche_id=?1 OR target_id=?1",
            [id],
        )
        .map_err(error)?;
    }
    for id in &ids {
        let exemplars = tx
            .prepare("SELECT id FROM exemplar WHERE fiche_id=?1")
            .map_err(error)?
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        delete_exemplars(tx, &exemplars)?;
        for (table, column) in [
            ("fiche_grouping", "fiche_id"),
            ("fiche_forgotten", "fiche_id"),
            ("pack_identity", "fiche_id"),
            ("saved_pack_identity", "fiche_id"),
            ("file_publication", "fiche_id"),
            ("fiche", "id"),
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE {column}=?1"), [id])
                .map_err(error)?;
        }
    }
    for provenance in owned_provenances {
        // Unrelated unused provenance can still belong to a surviving undo.
        tx.execute("DELETE FROM provenance WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM correction WHERE provenance_id=?1) AND NOT EXISTS(SELECT 1 FROM reference_value WHERE provenance_id=?1) AND NOT EXISTS(SELECT 1 FROM operation_change WHERE instr(before_json,?1)>0 OR instr(after_json,?1)>0)",[provenance]).map_err(error)?;
    }
    Ok(())
}

impl Store {
    pub(crate) fn finish_erasure_cleanup(&self) {
        if let Err(reason) = self.clean_erased_thumbnails() {
            log::warn!("Catalogue thumbnail cleanup after removal: {}", reason.code);
        }
        if let Ok(mut exports) = self.backup_exports.lock() {
            exports.discard_export_plans();
        }
        if let Err(reason) = self.clean_orphan_images() {
            log::warn!("Catalogue image cleanup after removal: {}", reason.code);
        }
    }
    pub(crate) fn clean_erased_thumbnails(&self) -> Result<()> {
        // Keys intentionally contain no readable identity. Clear this disposable
        // cache so previous revisions of an erased exemplar cannot remain hidden.
        for entry in std::fs::read_dir(self.thumbnail_root()).map_err(error)? {
            let path = entry.map_err(error)?.path();
            if path.is_file() {
                std::fs::remove_file(path).map_err(error)?;
            }
        }
        // Fiche covers are kept by fiche: only forgotten fiches and replaced
        // covers are removed, the others stay ready for the grid.
        self.reconcile_cover_store()
    }
    pub fn preview_remove_source(&self, id: &str) -> Result<RemovalPreview> {
        self.read_snapshot(|c| Ok(preview(c, id)))?
    }
    pub fn remove_source_confirmed(
        &self,
        id: &str,
        expected_sources: i64,
        expected: i64,
    ) -> Result<SourceOutcome> {
        let result = self.write(|tx| {
            let p = preview(tx, id)?;
            if p.catalogue_revision != expected || p.sources_revision != expected_sources {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            let active = tx
                .query_row(
                    "SELECT id FROM source WHERE id=?1 AND origin<>'repatriated' AND status IN ('active','hint')",
                    [id],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(error)?;
            if active.is_none() {
                return Err(UserMessage::new(codes::CATALOG_SOURCE_NOT_FOUND));
            }
            let (exemplars, erased, kept) = scope(tx, id).map_err(error)?;
            let affected: Vec<_> = erased.iter().chain(&kept).cloned().collect();
            super::files::require_associations_available(tx, &affected)?;
            // This row is only a path refusal setting, with no retained pack data.
            tx.execute(
                "UPDATE source SET status='removed',revision=revision+1 WHERE id=?1",
                [id],
            )
            .map_err(error)?;
            tx.execute("DELETE FROM source_health WHERE source_id=?1", [id])
                .map_err(error)?;
            purge(tx, &erased)?;
            delete_exemplars(tx, &exemplars)?;
            tx.execute("DELETE FROM cache.coverage WHERE source_id=?1", [id])
                .map_err(error)?;
            tx.execute("DELETE FROM cache.file_state WHERE source_id=?1", [id])
                .map_err(error)?;
            tx.execute(
                "UPDATE catalogue SET revision=revision+1,sources_revision=sources_revision+1",
                [],
            )
            .map_err(error)?;
            let payload = json!({"sourceId":id});
            journal::record(
                tx,
                &uuid::Uuid::new_v4().to_string(),
                "removeSource",
                expected,
                &payload,
                &json!({"catalogueRevision":expected+1}),
            )?;
            Ok(SourceOutcome {
                catalogue_revision: expected + 1,
                sources_revision: expected_sources + 1,
                source_id: id.into(),
                affected_card_ids: affected,
                warnings: self.all_warnings(),
            })
        })?;
        self.finish_erasure_cleanup();
        Ok(result)
    }
}

impl Store {
    pub fn preview_remove_cards(&self, ids: &[String]) -> Result<RemovalPreview> {
        self.read_snapshot(|c| {
            Ok((|| {
                validate_cards(c, ids)?;
                let (revision, sources) = c
                    .query_row("SELECT revision,sources_revision FROM catalogue", [], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .map_err(error)?;
                let mut available = 0;
                for id in ids {
                    if super::grouping::entry_for_card(c, id)
                        .map_err(error)?
                        .is_some_and(|e| e["offlineReason"].is_null())
                    {
                        available += 1;
                    }
                }
                Ok(RemovalPreview {
                    catalogue_revision: revision,
                    sources_revision: sources,
                    count: ids.len(),
                    remaining: 0,
                    available,
                    fiche_ids: ids.to_vec(),
                })
            })())
        })?
    }
    pub fn remove_missing_exemplar(&self, id: &str, expected: i64) -> Result<serde_json::Value> {
        let result = self.write(|tx| {
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            if revision != expected {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            let fiche: Option<String> = tx
                .query_row(
                    "SELECT fiche_id FROM exemplar WHERE id=?1 AND retired=0",
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error)?;
            let fiche =
                fiche.ok_or_else(|| UserMessage::new(codes::CATALOG_EXEMPLAR_NOT_MISSING))?;
            // Use the UI's effective state: a disconnected source overrides a
            // cached missing observation and must never authorize this gesture.
            let card = super::grouping::entry_for_card(tx, &fiche)
                .map_err(error)?
                .ok_or_else(|| UserMessage::new(codes::CATALOG_EXEMPLAR_NOT_MISSING))?;
            let exemplars = card["exemplars"]
                .as_array()
                .ok_or_else(|| UserMessage::new(codes::CATALOG_EXEMPLAR_NOT_MISSING))?;
            if !exemplars
                .iter()
                .any(|e| e["id"] == id && e["state"] == "missing")
            {
                return Err(UserMessage::new(codes::CATALOG_EXEMPLAR_NOT_MISSING));
            }
            let ids = [fiche];
            if exemplars.iter().filter(|e| e["retired"] != true).count() == 1
                && !super::files::retained_in_trash(tx, &ids[0])?
            {
                return remove_cards(tx, &ids, expected).map(|result| (result, true));
            }
            require_recovery_available(tx, &ids)?;
            super::files::require_associations_available(tx, &ids)?;
            delete_exemplars(tx, &[id.to_owned()])?;
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            journal::record(
                tx,
                &uuid::Uuid::new_v4().to_string(),
                "removeExemplar",
                expected,
                &json!({"count":1}),
                &json!({"count":1}),
            )?;
            Ok((
                json!({"catalogueRevision":expected+1,"affectedCardIds":ids}),
                false,
            ))
        })?;
        if result.1 {
            self.finish_erasure_cleanup();
        }
        Ok(result.0)
    }

    pub fn remove_cards_confirmed(
        &self,
        ids: &[String],
        expected: i64,
    ) -> Result<serde_json::Value> {
        if ids.is_empty() || ids.len() != ids.iter().collect::<BTreeSet<_>>().len() {
            return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
        }
        let result = self.write(|tx| {
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            if revision != expected {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            for id in ids {
                let exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM fiche WHERE id=?1)",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(error)?;
                if !exists {
                    return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
                }
            }
            remove_cards(tx, ids, expected)
        })?;
        self.finish_erasure_cleanup();
        Ok(result)
    }
}

fn remove_cards(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
    expected: i64,
) -> Result<serde_json::Value> {
    purge(tx, ids)?;
    tx.execute("UPDATE catalogue SET revision=revision+1", [])
        .map_err(error)?;
    let result = json!({"catalogueRevision":expected+1,"affectedCardIds":ids});
    journal::record(
        tx,
        &uuid::Uuid::new_v4().to_string(),
        "removeCards",
        expected,
        &json!({"count":ids.len()}),
        &json!({"count":ids.len()}),
    )?;
    Ok(result)
}
