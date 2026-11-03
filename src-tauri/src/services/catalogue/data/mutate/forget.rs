//! Source coverage is a lexical durable fact, not a probe of disk availability.
//! Forgetting removes personal data and recovery material, never source files.
use crate::services::catalogue::data::journal::{self, Mutation};
use crate::services::catalogue::{
    grouping::EntryPage,
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub fn covered(c: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    let roots = c
        .prepare("SELECT coalesce(resolved_path,path) FROM source WHERE status='active'")?
        .query_map([], |r| r.get::<_, Vec<u8>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|raw| {
            std::path::PathBuf::from(crate::support::paths::path_for_frontend(
                crate::services::catalogue::sources::native(raw),
            ))
        })
        .collect::<Vec<_>>();
    let mut covered=c.prepare("SELECT DISTINCT e.fiche_id FROM exemplar e JOIN cache.coverage v ON v.exemplar_id=e.id JOIN source s ON s.id=v.source_id WHERE s.status='active' AND e.retired=0")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let mut statement = c.prepare(
        "SELECT fiche_id,json_extract(anchor_json,'$.path') FROM exemplar WHERE retired=0",
    )?;
    for row in statement.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })? {
        let (id, path) = row?;
        if path.is_some_and(|path| {
            roots
                .iter()
                .any(|root| std::path::Path::new(&path).starts_with(root))
        }) {
            covered.insert(id);
        }
    }
    Ok(covered)
}
fn unreferenced(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let covered = covered(c)?;
    Ok(c.prepare("SELECT id FROM fiche f WHERE NOT EXISTS(SELECT 1 FROM fiche_grouping g WHERE g.fiche_id=f.id) AND NOT EXISTS(SELECT 1 FROM fiche_forgotten x WHERE x.fiche_id=f.id) ORDER BY id")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter(|id|!covered.contains(id)).collect())
}
fn preview(c: &Connection, ids: &[String]) -> rusqlite::Result<Value> {
    let mut items = Vec::new();
    for id in ids {
        let title = crate::services::catalogue::grouping::entry_for_card(c, id)?
            .map(|entry| entry["displayTitle"].clone())
            .unwrap_or(Value::Null);
        let count = |sql: &str| c.query_row(sql, [id], |r| r.get::<_, i64>(0));
        items.push(json!({"ficheId":id,"title":title,"counts":{
            "corrections":count("SELECT count(*) FROM correction WHERE fiche_id=?1")?,
            "favorite":count("SELECT favorite FROM fiche WHERE id=?1")?,
            "tags":count("SELECT count(*) FROM tag_member WHERE fiche_id=?1")?,
            "images":count("SELECT count(DISTINCT image_sha256) FROM (SELECT image_sha256 FROM correction WHERE fiche_id=?1 UNION SELECT image_sha256 FROM reference_value WHERE fiche_id=?1 UNION SELECT image_sha256 FROM lunii_pending_cover WHERE fiche_id=?1)")?
        }}));
    }
    Ok(
        json!({"items":items,"totalFiches":ids.len(),"catalogueRevision":c.query_row("SELECT revision FROM catalogue", [], |r|r.get::<_,i64>(0))?}),
    )
}
impl Store {
    pub fn list_unreferenced(&self, limit: usize, cursor: Option<&str>) -> Result<EntryPage> {
        let limit = limit.clamp(1, 200);
        self.read_snapshot(|c| {
            let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            let prefix = format!("unreferenced:{revision}:");
            let offset = match cursor {
                None => 0,
                Some(cursor) => match cursor
                    .strip_prefix(&prefix)
                    .and_then(|s| s.parse::<usize>().ok())
                {
                    Some(offset) => offset,
                    None => return Ok(None),
                },
            };
            let ids = unreferenced(c)?;
            let total = ids.len();
            let mut items = Vec::new();
            for id in ids.into_iter().skip(offset).take(limit) {
                if let Some(entry) = crate::services::catalogue::grouping::entry_for_card(c, &id)? {
                    items.push(entry);
                }
            }
            let next = offset + items.len();
            Ok(Some(EntryPage {
                catalogue_revision: revision,
                items,
                total_matching: total,
                cursor: (next < total).then(|| format!("{prefix}{next}")),
            }))
        })?
        .ok_or_else(|| UserMessage::new(codes::CATALOG_ENTRIES_CURSOR_EXPIRED))
    }
    pub fn preview_forget(&self, ids: &[String]) -> Result<Value> {
        self.read_snapshot(|c| {
            Ok((|| {
                crate::services::catalogue::removal::require_recovery_available(c, ids)?;
                preview(c, ids).map_err(error)
            })())
        })?
    }
}
pub fn mutate(store: &Store, mutation: Mutation, expected: i64) -> Result<Value> {
    let Mutation::ForgetUnreferencedCards {
        request_key,
        fiche_ids,
        expected_fiche_revisions,
    } = &mutation
    else {
        unreachable!()
    };
    if request_key.is_empty()
        || request_key.len() > 200
        || fiche_ids.is_empty()
        || fiche_ids.iter().collect::<BTreeSet<_>>().len() != fiche_ids.len()
    {
        return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
    }
    let payload = json!({"count":fiche_ids.len()});
    let outcome = store.write(|tx| {
        crate::services::catalogue::removal::require_recovery_available(tx, fiche_ids)?;
        crate::services::catalogue::files::require_mutation_available(tx, &mutation)?;
        if let Some(outcome) = journal::replay(tx, request_key, &payload)? {
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            return Ok(
                json!({"catalogueRevision":revision,"affectedCardIds":[],"count":outcome["count"]}),
            );
        }
        let revision: i64 = tx
            .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
            .map_err(error)?;
        let covered = covered(tx).map_err(error)?;
        for id in fiche_ids {
            if covered.contains(id) {
                return Err(UserMessage::new(codes::CATALOG_FORGET_REFUSED));
            }
        }
        if revision != expected {
            return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
        }
        for id in fiche_ids {
            super::names::revision(
                tx,
                "fiche",
                id,
                *expected_fiche_revisions
                    .get(id)
                    .ok_or_else(|| UserMessage::new(codes::CATALOG_MUTATION_INVALID))?,
            )?;
        }
        crate::services::catalogue::removal::purge(tx, fiche_ids)?;

        tx.execute("UPDATE catalogue SET revision=revision+1", [])
            .map_err(error)?;
        let outcome = json!({"catalogueRevision":revision+1,"affectedCardIds":fiche_ids});
        // Erasure receipts retain only a count, including on replay.
        journal::record(
            tx,
            request_key,
            "forgetUnreferencedCards",
            expected,
            &payload,
            &json!({"count":fiche_ids.len()}),
        )?;
        Ok(outcome)
    })?;
    if let Err(reason) = store.clean_erased_thumbnails() {
        log::warn!(
            "Catalogue thumbnail cleanup after forgetting: {}",
            reason.code
        );
    }
    if let Ok(mut exports) = store.backup_exports.lock() {
        exports.discard_export_plans();
    }
    if let Err(message) = store.clean_orphan_images() {
        log::warn!("Catalogue image cleanup after forgetting: {}", message.code);
    }
    Ok(outcome)
}

/// Shared destructive semantics for local forgetting and catalogue import.
pub(crate) fn apply(c: &rusqlite::Transaction<'_>, fiche_ids: &[String]) -> Result<()> {
    let covered = covered(c).map_err(error)?;
    if fiche_ids.iter().any(|id| covered.contains(id)) {
        return Err(UserMessage::new(codes::CATALOG_FORGET_REFUSED));
    }
    crate::services::catalogue::removal::purge(c, fiche_ids)
}

pub(crate) fn purge_personal(c: &rusqlite::Transaction<'_>, fiche_ids: &[String]) -> Result<()> {
    // Read each journal row once, matching complete JSON identifiers.
    let ids: BTreeSet<_> = fiche_ids.iter().map(String::as_str).collect();
    let ops = {
        let mut statement=c.prepare("SELECT id,coalesce(recovery_json,'{}') FROM operation UNION ALL SELECT operation_id,before_json FROM operation_change UNION ALL SELECT operation_id,after_json FROM operation_change UNION ALL SELECT operation_id,evidence_json FROM association_event UNION ALL SELECT operation_id,before_json FROM association_event UNION ALL SELECT operation_id,after_json FROM association_event UNION ALL SELECT operation_id,json_quote(entity_id) FROM operation_change").map_err(error)?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(error)?;
        let mut ops = BTreeSet::new();
        for row in rows {
            let (op, raw) = row.map_err(error)?;
            let value: Value = serde_json::from_str(&raw).map_err(error)?;
            if mentions(&value, &ids) {
                ops.insert(op);
            }
        }
        ops
    };
    // A decision is personal data of its own participants only. One operation
    // (an import) can record decisions about unrelated cards: keep those.
    let decisions = c
        .prepare("SELECT key,participants_json,evidence_json FROM suggestion_decision")
        .map_err(error)?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for (key, participants, evidence) in decisions {
        if [participants, evidence].iter().any(|raw| {
            serde_json::from_str(raw)
                .ok()
                .is_some_and(|v| mentions(&v, &ids))
        }) {
            c.execute("DELETE FROM suggestion_decision WHERE key=?1", [key])
                .map_err(error)?;
        }
    }
    for op in ops {
        for table in ["operation_change", "association_event", "import_receipt"] {
            c.execute(&format!("DELETE FROM {table} WHERE operation_id=?1"), [&op])
                .map_err(error)?;
        }
        let anchors: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM suggestion_decision WHERE operation_id=?1)",
                [&op],
                |r| r.get(0),
            )
            .map_err(error)?;
        if anchors {
            // Remaining decisions still reference this row. Drop its receipt so
            // it can neither be undone nor replayed, as if it had been deleted.
            c.execute(
                "UPDATE operation SET recovery_json='{}',request_key='forgotten:'||id WHERE id=?1",
                [&op],
            )
            .map_err(error)?;
        } else {
            c.execute("DELETE FROM operation WHERE id=?1", [op])
                .map_err(error)?;
        }
    }
    for id in fiche_ids {
        c.execute(
            "DELETE FROM identity_convergence WHERE known_fiche_id=?1",
            [id],
        )
        .map_err(error)?;
        crate::services::catalogue::backup::forget_retained(c, id)?;
        c.execute("DELETE FROM import_identity WHERE local_entity_id=?1 OR instr(last_imported_json,?1)>0",[id]).map_err(error)?;
        for table in [
            "correction",
            "tag_member",
            "reference_value",
            "reference_source",
            "import_reference",
            "lunii_filled",
            "lunii_image_attempt",
            "lunii_pending_cover",
        ] {
            c.execute(&format!("DELETE FROM {table} WHERE fiche_id=?1"), [id])
                .map_err(error)?;
        }
        c.execute(
            "UPDATE fiche SET favorite=0,revision=revision+1 WHERE id=?1",
            [id],
        )
        .map_err(error)?;
        c.execute("INSERT OR IGNORE INTO fiche_forgotten VALUES (?1)", [id])
            .map_err(error)?;
        c.execute(
            "DELETE FROM cache.search_projection WHERE fiche_id=?1",
            [id],
        )
        .map_err(error)?;
    }

    Ok(())
}

pub(crate) fn mentions(value: &Value, ids: &BTreeSet<&str>) -> bool {
    match value {
        Value::String(s) => {
            ids.contains(s.as_str())
                || serde_json::from_str::<Value>(s)
                    .ok()
                    .is_some_and(|v| v != *value && mentions(&v, ids))
        }
        Value::Array(a) => a.iter().any(|v| mentions(v, ids)),
        Value::Object(o) => o.iter().any(|(k, v)| {
            ids.contains(k.as_str()) || mentions(&Value::String(k.clone()), ids) || mentions(v, ids)
        }),
        _ => false,
    }
}
