//! Fold a source-less waiting card into its selected target without losing edits.
use super::{
    matching::{text, Plan},
    Result,
};
use crate::services::catalogue::store::error;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
fn corrections(c: &Connection, id: &str) -> Result<Vec<Value>> {
    let mut statement=c.prepare("SELECT field,language,state,value_json,image_sha256,provenance_id FROM correction WHERE fiche_id=?1 ORDER BY field,language").map_err(error)?;
    let result=statement.query_map([id],|r|Ok(json!({"field":r.get::<_,String>(0)?,"language":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?,"value":r.get::<_,Option<String>>(3)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"imageSha256":r.get::<_,Option<String>>(4)?,"provenanceId":r.get::<_,String>(5)?}))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error);
    result
}
pub(super) fn prepare(
    c: &Connection,
    plan: &mut Plan,
    covered: &std::collections::BTreeSet<String>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let pending = plan.pending.clone();
    let mut transfers = vec![];
    let mut by_target = std::collections::BTreeMap::<String, Vec<usize>>::new();
    for (i, action) in plan.actions.iter().enumerate() {
        by_target.entry(action.target.clone()).or_default().push(i);
    }
    let mut removed = std::collections::BTreeSet::new();
    let mut promoted = std::collections::BTreeSet::new();
    for (old, original_target) in &pending {
        super::export::check(cancel)?;
        let target = &super::relations::canonical(c, original_target)?;
        let indices = by_target.get(original_target).cloned().unwrap_or_default();
        let target_rows = corrections(c, target)?;
        for mut row in corrections(c, old)? {
            let field = text(&row, "field")?.to_string();
            let language = row["language"].as_str().unwrap().to_string();
            let local = target_rows
                .iter()
                .find(|r| r["field"] == field && r["language"] == language)
                .cloned();
            let provenance = row["provenanceId"].clone();
            row.as_object_mut().unwrap().remove("provenanceId");
            let local = local.map(|mut r| {
                r.as_object_mut().unwrap().remove("provenanceId");
                r
            });
            // A backup value must conflict with the waiting edit even when the target
            // had no value. Its default keeps the value transferred from the waiting card.
            for &i in &indices {
                let action = &mut plan.actions[i];
                if action.kind == "corrections"
                    && action.target == *target
                    && action.incoming["field"] == field
                    && action.incoming["language"] == language
                    && action.local.is_none()
                {
                    action.local = Some(row.clone());
                    promoted.insert(action.id.clone());
                    plan.preview.changes.push(json!({"id":action.id,"target":action.target,"kind":action.kind,"incoming":action.incoming}));
                    plan.preview.conflicts.push(super::import::Conflict{id:action.id.clone(),target:json!({"kind":"corrections","id":target,"key":format!("{field}:{language}")}),local:row.clone(),incoming:action.incoming.clone(),default_choice:"local".into()});
                }
            }
            let before = plan.actions.len();
            plan.action(
                "pendingCorrections",
                target,
                row,
                local,
                &format!("{field}:{language}"),
            );
            if plan.actions.len() > before {
                let mut action = plan.actions.pop().unwrap();
                action.incoming["provenanceId"] = provenance;
                transfers.push(action);
            }
        }
        let old_favorite: i64 = c
            .query_row("SELECT favorite FROM fiche WHERE id=?1", [old], |r| {
                r.get(0)
            })
            .map_err(error)?;
        let target_favorite: i64 = c
            .query_row("SELECT favorite FROM fiche WHERE id=?1", [target], |r| {
                r.get(0)
            })
            .map_err(error)?;
        let before = plan.actions.len();
        plan.action(
            "pendingFavorite",
            target,
            json!(old_favorite),
            Some(json!(target_favorite)),
            "",
        );
        if plan.actions.len() > before {
            transfers.push(plan.actions.pop().unwrap());
        }
        let forgotten: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM fiche_forgotten WHERE fiche_id=?1)",
                [old],
                |r| r.get(0),
            )
            .map_err(error)?;
        if forgotten {
            let before = plan.actions.len();
            let target_forgotten: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM fiche_forgotten WHERE fiche_id=?1)",
                    [target],
                    |r| r.get(0),
                )
                .map_err(error)?;
            let conflicts = plan.preview.conflicts.len();
            plan.action(
                "pendingForgotten",
                target,
                json!(true),
                Some(json!(target_forgotten)),
                "",
            );
            if plan.preview.conflicts.len() > conflicts
                && !super::matching::forgettable(covered, original_target, target)
            {
                plan.preview.conflicts.last_mut().unwrap().target["requiresIndividualChoice"] =
                    json!(true);
                plan.preview.conflicts.last_mut().unwrap().target["individualChoiceReason"] =
                    json!("forgetRefused");
            }
            if plan.actions.len() > before {
                transfers.push(plan.actions.pop().unwrap());
            }
        }
        let has_official: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii')", [target], |r| r.get(0)).map_err(error)?;
        if !has_official {
            // Transfer before archive actions so the current waiting fiche wins too.
            let official = c.prepare("SELECT field,language,value_json,provenance_id,image_sha256 FROM reference_value WHERE fiche_id=?1 AND EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii')").map_err(error)?.query_map([old], |r| Ok(json!({"field":r.get::<_,String>(0)?,"language":r.get::<_,String>(1)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"provenanceId":r.get::<_,String>(3)?,"imageSha256":r.get::<_,Option<String>>(4)?}))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
            if !official.is_empty() {
                let replaced: std::collections::BTreeSet<_> = indices
                    .iter()
                    .map(|&i| &plan.actions[i])
                    .filter(|a| a.kind == "referenceValues")
                    .map(|a| a.id.clone())
                    .collect();
                removed.extend(replaced.iter().cloned());

                for row in official {
                    let before = plan.actions.len();
                    let key = format!("{}:{}", row["field"], row["language"]);
                    plan.action("pendingLuniiValue", target, row, None, &key);
                    if plan.actions.len() > before {
                        transfers.push(plan.actions.pop().unwrap());
                    }
                }
            }
        }
        // Preserve fields absent in the incoming archive too.
        let values=c.prepare("SELECT field,language,value_json,provenance_id,image_sha256 FROM reference_value WHERE fiche_id=?1 AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii')").map_err(error)?.query_map([old],|r|Ok(json!({"field":r.get::<_,String>(0)?,"language":r.get::<_,String>(1)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"provenanceId":r.get::<_,String>(3)?,"imageSha256":r.get::<_,Option<String>>(4)?}))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let source: Option<String> = c
            .query_row(
                "SELECT reference_json FROM import_reference WHERE fiche_id=?1",
                [old],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if !values.is_empty() || source.is_some() {
            let existing:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM reference_value WHERE fiche_id=?1 AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii') UNION SELECT 1 FROM reference_source WHERE fiche_id=?1 UNION SELECT 1 FROM import_reference WHERE fiche_id=?1)",[target],|r|r.get(0)).map_err(error)?;
            let value = json!({"source":source.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(error)?.unwrap_or(Value::Null),"values":values});
            let before = plan.actions.len();
            plan.action(
                "pendingReferenceBundle",
                target,
                value.clone(),
                if existing {
                    Some(json!({"source":"local","values":c.prepare("SELECT field,language,value_json FROM reference_value WHERE fiche_id=?1 AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii')").map_err(error)?.query_map([target],|r|Ok(json!({"field":r.get::<_,String>(0)?,"language":r.get::<_,String>(1)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null)}))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?}))
                } else {
                    None
                },
                "",
            );
            if plan.actions.len() > before {
                let active: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM reference_source WHERE fiche_id=?1)",
                        [target],
                        |r| r.get(0),
                    )
                    .map_err(error)?;
                if active {
                    if let Some(conflict) = plan.preview.conflicts.last_mut() {
                        conflict.target["requiresIndividualChoice"] = json!(true);
                    }
                }
                transfers.push(plan.actions.pop().unwrap());
            }
            for &i in &indices {
                let action = &mut plan.actions[i];
                if action.kind == "referenceBundle"
                    && action.target == *target
                    && action.local.is_none()
                {
                    action.local = Some(value.clone());
                    plan.preview.conflicts.push(super::import::Conflict {
                        id: action.id.clone(),
                        target: json!({"kind":"referenceBundle","id":target,"key":""}),
                        local: value.clone(),
                        incoming: action.incoming.clone(),
                        default_choice: "local".into(),
                    });
                }
            }
        }
    }
    plan.preview.additions.retain(|v| {
        !v["id"]
            .as_str()
            .is_some_and(|id| removed.contains(id) || promoted.contains(id))
    });
    plan.actions.retain(|a| !removed.contains(&a.id));
    transfers.append(&mut plan.actions);
    plan.actions = transfers;
    Ok(())
}
pub(super) fn apply_correction(tx: &Transaction<'_>, target: &str, row: &Value) -> Result<()> {
    tx.execute("INSERT INTO correction VALUES (?1,?2,?3,?4,?5,?6,?7,1) ON CONFLICT(fiche_id,field,language) DO UPDATE SET state=excluded.state,value_json=excluded.value_json,provenance_id=excluded.provenance_id,image_sha256=excluded.image_sha256,revision=correction.revision+1",params![target,text(row,"field")?,row["language"].as_str().unwrap(),text(row,"state")?,if row["value"].is_null(){None}else{Some(row["value"].to_string())},text(row,"provenanceId")?,row["imageSha256"].as_str()]).map_err(error)?;
    Ok(())
}
pub(super) fn finish(tx: &Transaction<'_>, plan: &Plan) -> Result<()> {
    for (old, target) in &plan.pending {
        let target = &super::relations::canonical(tx, target)?;
        tx.execute(
            "INSERT OR IGNORE INTO lunii_filled(fiche_id,author_checked,checked_fields) SELECT ?2,author_checked,checked_fields FROM lunii_filled WHERE fiche_id=?1",
            params![old, target],
        )
        .map_err(error)?;

        tx.execute(
            "INSERT OR IGNORE INTO tag_member SELECT tag_id,?2 FROM tag_member WHERE fiche_id=?1",
            params![old, target],
        )
        .map_err(error)?;

        // Existing target evidence wins on collision; otherwise carry the
        // waiting membership's origin before its cascading deletion.
        tx.execute("INSERT OR IGNORE INTO enrichment_tag_origin SELECT tag_id,?2,provenance_json FROM enrichment_tag_origin WHERE fiche_id=?1",params![old,target]).map_err(error)?;
        tx.execute("UPDATE import_identity SET local_entity_id=?2 WHERE entity_type='card' AND local_entity_id=?1",params![old,target]).map_err(error)?;
        tx.execute(
            "UPDATE saved_pack_identity SET fiche_id=?2 WHERE fiche_id=?1",
            params![old, target],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE identity_convergence SET known_fiche_id=?2 WHERE known_fiche_id=?1",
            params![old, target],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE fiche_grouping SET target_id=?2 WHERE target_id=?1",
            params![old, target],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE file_publication SET fiche_id=?2 WHERE fiche_id=?1",
            params![old, target],
        )
        .map_err(error)?;
        for table in [
            "tag_member",
            "correction",
            "reference_value",
            "reference_source",
            "import_reference",
            "fiche_forgotten",
            "fiche_grouping",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE fiche_id=?1"), [old])
                .map_err(error)?;
        }
        tx.execute(
            "DELETE FROM cache.search_projection WHERE fiche_id=?1",
            [old],
        )
        .map_err(error)?;
        tx.execute("DELETE FROM fiche WHERE id=?1", [old])
            .map_err(error)?;
    }
    Ok(())
}
