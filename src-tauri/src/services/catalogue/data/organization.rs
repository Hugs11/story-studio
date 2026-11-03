//! Organization mutations use the 4a journal, one transaction for a whole selection.
use super::{
    journal::{self, Mutation},
    mutate::{favorite, names, tags},
};
use crate::services::catalogue::{
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn members(c: &Connection, table: &str, id: &str) -> Result<Vec<String>> {
    c.prepare(&format!(
        "SELECT fiche_id FROM {table}_member WHERE {table}_id=?1 ORDER BY fiche_id"
    ))
    .map_err(error)?
    .query_map([id], |r| r.get(0))
    .map_err(error)?
    .collect::<rusqlite::Result<_>>()
    .map_err(error)
}
fn entity(c: &Connection, table: &str, id: &str) -> Result<Value> {
    use rusqlite::OptionalExtension;
    let row = c
        .query_row(
            &format!("SELECT label,revision FROM {table} WHERE id=?1"),
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(error)?;
    Ok(match row {
        Some((label, revision)) => {
            json!({"id":id,"label":label,"revision":revision,"members":members(c,table,id)?})
        }
        None => Value::Null,
    })
}
fn fiche(c: &Connection, id: &str) -> Result<Value> {
    let (favorite, revision) = c
        .query_row(
            "SELECT favorite,revision FROM fiche WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, bool>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(error)?;
    Ok(
        json!({"id":id,"favorite":favorite,"revision":revision,"tagIds":membership_ids(c,"tag",id).map_err(error)?}),
    )
}
pub fn membership_ids(c: &Connection, table: &str, id: &str) -> rusqlite::Result<Vec<String>> {
    c.prepare(&format!(
        "SELECT {table}_id FROM {table}_member WHERE fiche_id=?1 ORDER BY {table}_id"
    ))?
    .query_map([id], |r| r.get(0))?
    .collect()
}
/// A grouping or a forget hides a fiche without bumping its revision: its
/// favorite and tags were moved or cleared and must stay so. A gesture read
/// from a list where the card was still visible is a stale read, answered as a
/// revision conflict so that the client reads the list again (a not-found
/// error would be shown without reloading). A client replay ends here too.
pub(crate) fn require_visible_card(c: &Connection, id: &str) -> Result<()> {
    let hidden: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM fiche_grouping WHERE fiche_id=?1)
                 OR EXISTS(SELECT 1 FROM fiche_forgotten WHERE fiche_id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(error)?;
    if hidden {
        return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
    }
    Ok(())
}
pub fn mutate(store: &Store, mutation: Mutation, expected: i64) -> Result<Value> {
    let payload = serde_json::to_value(&mutation).map_err(error)?;
    let request = payload["requestKey"].as_str().unwrap_or("");
    if request.is_empty() || request.len() > 200 {
        return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
    }
    store.write(|tx| {
        crate::services::catalogue::files::require_mutation_available(tx, &mutation)?;
        if let Some(outcome) = journal::replay(tx, request, &payload)? {
            return Ok(outcome);
        }
        let revision: i64 = tx
            .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
            .map_err(error)?;
        let mut cards = BTreeSet::new();
        let mut entities = BTreeSet::new();
        match &mutation {
            Mutation::SetFavorite { fiche_ids, .. } | Mutation::ChangeTags { fiche_ids, .. } => {
                cards.extend(fiche_ids.iter().cloned());
            }
            _ => {}
        }
        if matches!(
            &mutation,
            Mutation::SetFavorite { .. } | Mutation::ChangeTags { .. }
        ) && cards.is_empty()
        {
            return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
        }
        if let Mutation::ChangeTags {
            add_tag_ids,
            remove_tag_ids,
            ..
        } = &mutation
        {
            for id in add_tag_ids.iter().chain(remove_tag_ids) {
                entities.insert(("tag", id.clone()));
            }
        }
        for id in &cards {
            names::require(tx, "fiche", id)?;
        }
        if matches!(
            &mutation,
            Mutation::SetFavorite { .. } | Mutation::ChangeTags { .. }
        ) {
            for id in &cards {
                require_visible_card(tx, id)?;
            }
        }
        let mut changes = Vec::new();
        for id in &cards {
            changes.push(("fiche", id.clone(), fiche(tx, id)?));
        }
        for (table, id) in &entities {
            changes.push((*table, id.clone(), entity(tx, table, id)?));
        }
        let mut report = Value::Null;
        match &mutation {
            Mutation::SetFavorite {
                fiche_ids,
                value,
                expected_fiche_revisions,
                ..
            } => favorite::apply(tx, fiche_ids, *value, expected_fiche_revisions)?,
            Mutation::ChangeTags {
                fiche_ids,
                add_labels,
                add_tag_ids,
                remove_tag_ids,
                ..
            } => {
                let ids = tags::change(tx, fiche_ids, add_labels, add_tag_ids, remove_tag_ids)?;
                for id in &ids {
                    changes.push(("tag", id.clone(), Value::Null));
                }
                report = json!({"createdTagIds":ids});
            }
            _ => return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID)),
        }
        for id in &cards {
            tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [id])
                .map_err(error)?;
            tx.execute(
                "DELETE FROM cache.search_projection WHERE fiche_id=?1",
                [id],
            )
            .map_err(error)?;
        }
        tx.execute("UPDATE catalogue SET revision=revision+1", [])
            .map_err(error)?;
        let outcome =
            json!({"catalogueRevision":revision+1,"affectedCardIds":cards,"report":report});
        let op = journal::record(
            tx,
            request,
            payload["kind"].as_str().unwrap(),
            expected,
            &payload,
            &outcome,
        )?;
        for (table, id, before) in changes {
            let after = if table == "fiche" {
                fiche(tx, &id)?
            } else {
                entity(tx, table, &id)?
            };
            let post = after["revision"]
                .as_i64()
                .unwrap_or_else(|| before["revision"].as_i64().unwrap_or(0) + 1);
            tx.execute(
                "INSERT INTO operation_change VALUES (?1,?2,?3,?4,?5,?6)",
                params![op, table, id, before.to_string(), after.to_string(), post],
            )
            .map_err(error)?;
        }
        Ok(outcome)
    })
}
impl Store {
    pub fn list_tags(&self) -> Result<Value> {
        self.list_organization("tag")
    }
    fn list_organization(&self, table: &str) -> Result<Value> {
        self.read_snapshot(|c| {
            let revision:i64=c.query_row("SELECT revision FROM catalogue",[],|r|r.get(0))?;
            // Source health is irrelevant. Fall back to durable anchors after
            // a cache purge, using the same lexical path containment as scans.
            // No filesystem probe is allowed during a list read.
            let roots=c.prepare("SELECT coalesce(resolved_path,path) FROM source WHERE status='active'")?.query_map([],|r|r.get::<_,Vec<u8>>(0))?.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().map(|raw|std::path::PathBuf::from(crate::support::paths::path_for_frontend(super::super::sources::native(raw)))).collect::<Vec<_>>();
            let mut covered=c.prepare("SELECT DISTINCT e.fiche_id FROM exemplar e JOIN cache.coverage v ON v.exemplar_id=e.id JOIN source s ON s.id=v.source_id WHERE e.retired=0 AND s.status='active'")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
            let mut statement=c.prepare("SELECT fiche_id,json_extract(anchor_json,'$.path') FROM exemplar WHERE retired=0")?;
            for row in statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))? {
                let (id,path)=row?;
                if path.is_some_and(|path|roots.iter().any(|root|std::path::Path::new(&path).starts_with(root))) {covered.insert(id);}
            }
            let mut counts=std::collections::BTreeMap::<String,(i64,i64)>::new();
            let mut statement=c.prepare(&format!("SELECT {table}_id,fiche_id FROM {table}_member"))?;
            for row in statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
                let (id,card)=row?;let count=counts.entry(id).or_default();count.0+=1;if !covered.contains(&card) {count.1+=1;}
            }
            let sql=format!("SELECT id,label,revision FROM {table} ORDER BY normalized_label,id");
            let items=c.prepare(&sql)?.query_map([],|r|{
                let id=r.get::<_,String>(0)?;let (count,unreferenced)=counts.get(&id).copied().unwrap_or_default();
                Ok(json!({"id":id,"label":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"count":count,"countUnreferenced":unreferenced}))
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"revision":revision,"items":items}))
        })
    }
}
