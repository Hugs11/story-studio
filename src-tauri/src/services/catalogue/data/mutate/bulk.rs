//! Atomic catalogue-only metadata batches and durable, field-sensitive undo.
use super::{
    metadata::{self, Change},
    names,
};
use crate::services::catalogue::{
    data::journal::{self, Mutation},
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkValue {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

fn corrections(c: &Connection, id: &str) -> Result<BTreeMap<String, Value>> {
    c.prepare("SELECT field,state,value_json,provenance_id,image_sha256,revision FROM correction WHERE fiche_id=?1 AND language='' AND field IN ('ageMin','ageMax','language','author','producer','bonus') ORDER BY field")
        .map_err(error)?.query_map([id], |r| Ok((r.get::<_,String>(0)?, json!({"state":r.get::<_,String>(1)?,"value":r.get::<_,Option<String>>(2)?,"provenance":r.get::<_,String>(3)?,"image":r.get::<_,Option<String>>(4)?,"revision":r.get::<_,i64>(5)?}))))
        .map_err(error)?.collect::<rusqlite::Result<_>>().map_err(error)
}
fn invalid() -> UserMessage {
    UserMessage::new(codes::CATALOG_MUTATION_INVALID)
}

pub fn mutate(store: &Store, mutation: Mutation, expected: i64) -> Result<Value> {
    let payload = serde_json::to_value(&mutation).map_err(error)?;
    let request = payload["requestKey"].as_str().unwrap_or("");
    if request.is_empty() || request.len() > 200 {
        return Err(invalid());
    }
    store.write(|tx| {
        crate::services::catalogue::files::require_mutation_available(tx,&mutation)?;
        if let Some(outcome) = journal::replay(tx, request, &payload)? { return Ok(outcome); }
        let revision:i64 = tx.query_row("SELECT revision FROM catalogue", [], |r|r.get(0)).map_err(error)?;
        // No global guard: each fiche revision and visibility is checked below
        // (background scans, Lunii synchronisation and official covers bump the
        // catalogue revision for unrelated cards); undo compares field values.
        match &mutation {
            Mutation::BulkSetMetadata { fiche_ids, changes, expected_fiche_revisions, .. } => {
                let ids:std::collections::BTreeSet<_> = fiche_ids.iter().collect();
                if ids.is_empty() || ids.len()!=fiche_ids.len() || changes.is_empty() { return Err(invalid()); }
                let mut edits=Vec::new();
                for (field, change) in changes {
                    if !matches!(field.as_str(), "ageMin"|"ageMax"|"language"|"author"|"producer"|"bonus") || !matches!(change.state.as_str(), "defined"|"cleared") { return Err(invalid()); }
                    let edit=Change {field:field.clone(),language:None,state:change.state.clone(),value:change.value.clone(),cover_staging_id:None};
                    metadata::validate(&edit)?;
                    edits.push(edit);
                }
                let mut snapshots=Vec::new();
                let mut rejected=Vec::new();
                // Savepoints let validation inspect the same resolver as ordinary
                // edits while retaining an all-or-nothing operation across cards.
                for id in &ids {
                    names::revision(tx,"fiche",id,*expected_fiche_revisions.get(*id).ok_or_else(invalid)?)?;
                    crate::services::catalogue::data::organization::require_visible_card(tx,id)?;
                    let before=corrections(tx,id)?;
                    let mut card_edits=edits.clone();
                    if changes.contains_key("ageMin") != changes.contains_key("ageMax") {
                        let field=if changes.contains_key("ageMin") {"ageMax"} else {"ageMin"};
                        let retained=before.get(field);
                        card_edits.push(Change {field:field.into(),language:None,state:retained.map_or("source",|v|v["state"].as_str().unwrap()).into(),value:retained.and_then(|v|v["value"].as_str()).map(|s|serde_json::from_str(s).map_err(error)).transpose()?,cover_staging_id:None});
                    }
                    tx.execute_batch("SAVEPOINT bulk_validation").map_err(error)?;
                    let result=metadata::apply(store,tx,id,&card_edits);
                    match result {
                        Ok(()) => {

                            // Untouched bounds are retained byte for byte, including provenance.
                            snapshots.push(((*id).clone(),before,card_edits));
                        }
                        Err(message) => rejected.push(json!({"ficheId":id,"error":message})),
                    }
                    tx.execute_batch("ROLLBACK TO bulk_validation; RELEASE bulk_validation").map_err(error)?;
                }
                if !rejected.is_empty() {
                    return Ok(json!({"catalogueRevision":revision,"affectedCardIds":[],"report":{"rejected":rejected}}));
                }
                let token=uuid::Uuid::new_v4().to_string();
                let outcome=json!({"catalogueRevision":revision+1,"affectedCardIds":fiche_ids,"undoToken":token});
                let op=journal::record(tx,request,"bulkSetMetadata",expected,&payload,&outcome)?;
                for (id,before,card_edits) in snapshots {
                    metadata::apply(store,tx,&id,&card_edits)?;
                    let after=corrections(tx,&id)?;
                    let untouched:BTreeMap<_,_>=["ageMin","ageMax"].into_iter().filter(|f|!changes.contains_key(*f)).map(|f|(f.to_owned(),before.get(f).cloned().unwrap_or(Value::Null))).collect();
                    restore(tx,&id,&untouched)?;
                    // Only requested fields enter the undo snapshot. Unrelated
                    // corrections, tag merges and rescans cannot block undo.
                    let before: BTreeMap<_,_>=changes.keys().map(|f|(f.clone(),before.get(f).cloned().unwrap_or(Value::Null))).collect();
                    let after: BTreeMap<_,_>=changes.keys().map(|f|(f.clone(),after.get(f).cloned().unwrap_or(Value::Null))).collect();

                    bump(tx,&id)?;
                    tx.execute("INSERT INTO operation_change VALUES (?1,'bulkMetadata',?2,?3,?4,?5)",params![op,id,serde_json::to_string(&before).map_err(error)?,serde_json::to_string(&after).map_err(error)?,expected_fiche_revisions[&id]+1]).map_err(error)?;
                }
                tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;
                Ok(outcome)
            }
            Mutation::Undo {undo_token,..} => {
                let latest:Option<(String,String,String)>=tx.query_row("SELECT id,status,recovery_json FROM operation WHERE id=(SELECT operation_id FROM undo_head WHERE singleton=1)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(error)?;
                let (op,status,receipt)=latest.ok_or_else(||UserMessage::new(codes::CATALOG_UNDO_EXPIRED))?;
                let receipt:Value=serde_json::from_str(&receipt).map_err(error)?;
                if status!="committed" || receipt["outcome"]["undoToken"]!=*undo_token {return Err(UserMessage::new(codes::CATALOG_UNDO_EXPIRED));}
                let rows=tx.prepare("SELECT entity_id,before_json,after_json FROM operation_change WHERE operation_id=?1 AND entity_type='bulkMetadata'").map_err(error)?.query_map([&op],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
                let mut conflicts=Vec::new();
                let mut restore_rows=Vec::new();
                for (id,before,after) in rows {
                    let before:BTreeMap<String,Value>=serde_json::from_str(&before).map_err(error)?;
                    let after:BTreeMap<String,Value>=serde_json::from_str(&after).map_err(error)?;
                    let current=corrections(tx,&id)?;
                    for (field,value) in &after {
                        if correction_value(current.get(field).unwrap_or(&Value::Null))!=correction_value(value) {conflicts.push(json!({"ficheId":id,"field":field}));}
                    }
                    restore_rows.push((id,before));
                }
                if !conflicts.is_empty() {return Err(UserMessage::new(codes::CATALOG_UNDO_CONFLICT).param("conflicts",json!(conflicts)));}
                let ids:Vec<_>=restore_rows.iter().map(|(id,_)|id.clone()).collect();
                crate::services::catalogue::files::require_associations_available(tx,&ids)?;
                for (id,before) in restore_rows {restore(tx,&id,&before)?;bump(tx,&id)?;}
                // Restores are provisional until every final interval is valid.
                // A newer edit to the other bound can make an otherwise
                // value-compatible undo invalid. Returning an error rolls back
                // all cards, revisions, projections and the undo receipt.
                for id in &ids {
                    if !metadata::age_interval_valid(tx,id).map_err(error)? {
                        for field in ["ageMin","ageMax"] {conflicts.push(json!({"ficheId":id,"field":field,"rule":"interval"}));}
                    }
                }
                if !conflicts.is_empty() {return Err(UserMessage::new(codes::CATALOG_UNDO_CONFLICT).param("conflicts",json!(conflicts)));}
                tx.execute("UPDATE operation SET status='undone' WHERE id=?1",[op]).map_err(error)?;
                tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;
                let outcome=json!({"catalogueRevision":revision+1,"affectedCardIds":ids});
                journal::record(tx,request,"undoMutation",expected,&payload,&outcome)?;
                Ok(outcome)
            }
            _=>Err(invalid()),
        }
    })
}
fn bump(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<()> {
    tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [id])
        .map_err(error)?;
    tx.execute(
        "DELETE FROM cache.search_projection WHERE fiche_id=?1",
        [id],
    )
    .map_err(error)?;
    Ok(())
}
fn restore(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    values: &BTreeMap<String, Value>,
) -> Result<()> {
    for (field, v) in values {
        tx.execute(
            "DELETE FROM correction WHERE fiche_id=?1 AND field=?2 AND language=''",
            params![id, field],
        )
        .map_err(error)?;
        if !v.is_null() {
            tx.execute(
                "INSERT INTO correction VALUES (?1,?2,'',?3,?4,?5,?6,?7)",
                params![
                    id,
                    field,
                    v["state"].as_str(),
                    v["value"].as_str(),
                    v["provenance"].as_str(),
                    v["image"].as_str(),
                    v["revision"].as_i64()
                ],
            )
            .map_err(error)?;
        }
    }
    Ok(())
}

fn correction_value(value: &Value) -> Value {
    if value.is_null() {
        Value::Null
    } else {
        json!([value["state"], value["value"], value["image"]])
    }
}
