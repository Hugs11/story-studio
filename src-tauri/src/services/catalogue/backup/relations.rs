//! Restore only relations whose current members and evidence can be verified.
use super::{
    matching::{rows, text, Plan},
    Result,
};
use crate::services::catalogue::{data::mutate::association, store::error};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::BTreeSet;
fn ready(c: &Connection, id: &str) -> Result<bool> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id JOIN cache.observation o ON o.exemplar_id=e.id WHERE r.fiche_id=?1 AND e.fiche_id=?1 AND e.retired=0 AND o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id WHERE v.exemplar_id=e.id AND s.status='active'))",[id],|r|r.get(0)).map_err(error)
}
fn groupable(c: &Connection, ids: &[String]) -> Result<bool> {
    if ids.len() < 2 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Ok(false);
    }
    let mut uuids = BTreeSet::new();
    for id in ids {
        if !ready(c, id)? {
            return Ok(false);
        }
        for uuid in c.prepare("SELECT pack_uuid FROM pack_identity WHERE fiche_id=?1 UNION SELECT verified_uuid FROM exemplar WHERE fiche_id=?1 AND verified_uuid IS NOT NULL UNION SELECT pack_uuid FROM saved_pack_identity WHERE fiche_id=?1").map_err(error)?.query_map([id],|r|r.get::<_,String>(0)).map_err(error)?{uuids.insert(uuid.map_err(error)?);}
    }
    for a in ids {
        for b in ids {
            if a < b && association::corrections_conflict(c, a, b)? {
                return Ok(false);
            }
        }
    }
    // Every member must prove the same UUID; unidentified files stay independent.
    if uuids.len() != 1 {
        return Ok(false);
    }
    for id in ids {
        let invalid: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 AND verified_uuid IS NULL)",
                [id],
                |r| r.get(0),
            )
            .map_err(error)?;
        let identified: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 AND verified_uuid IS NOT NULL)", [id], |r| r.get(0)).map_err(error)?;
        if invalid || !identified {
            return Ok(false);
        }
    }
    Ok(true)
}
fn proof_signature(value: &Value) -> Option<Vec<Value>> {
    let mut proofs = value
        .as_array()?
        .iter()
        .map(|row| Some(json!([row.as_array()?.get(1)?, row.as_array()?.get(2)?])))
        .collect::<Option<Vec<_>>>()?;
    if proofs.is_empty() {
        return None;
    }
    proofs.sort_by_key(Value::to_string);
    Some(proofs)
}
fn members_verified(c: &Connection, plan: &Plan, relations: &[&Value]) -> Result<bool> {
    let mut by_card = std::collections::BTreeMap::<String, BTreeSet<String>>::new();
    for row in relations {
        let Some(members) = row["members"].as_array() else {
            return Ok(false);
        };
        for key in ["ficheId", "targetId"] {
            let id = text(row, key)?;
            let Some(member) = members.iter().find(|m| m["ficheId"] == id) else {
                return Ok(false);
            };
            let Some(proofs) = member["proofs"].as_array().filter(|p| !p.is_empty()) else {
                return Ok(false);
            };
            let target = canonical(c, &plan.cards[id])?;
            for proof in proofs {
                by_card
                    .entry(target.clone())
                    .or_default()
                    .insert(proof.to_string());
            }
        }
    }
    for (target, proofs) in by_card {
        let actual=c.prepare("SELECT proof_json,verified_uuid FROM exemplar e WHERE fiche_id=?1 AND retired=0 AND EXISTS(SELECT 1 FROM cache.observation WHERE exemplar_id=e.id AND state='available')").map_err(error)?.query_map([&target],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let total: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM exemplar WHERE fiche_id=?1",
                [&target],
                |r| r.get(0),
            )
            .map_err(error)?;
        if total as usize != proofs.len() || actual.len() != proofs.len() {
            return Ok(false);
        }
        for proof in proofs {
            let proof: Value = serde_json::from_str(&proof).map_err(error)?;
            if actual
                .iter()
                .filter(|(raw, uuid)| {
                    super::validate::payload(raw.as_bytes()).sha256 == proof["digest"]
                        && json!(uuid) == proof["uuid"]
                })
                .count()
                != 1
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn incoming_compatible(
    c: &Connection,
    index: &super::matching::Index<'_>,
    plan: &Plan,
    ids: &[&str],
) -> Result<bool> {
    // A group cannot hide unresolved competing metadata from its members.

    let mut values = std::collections::BTreeMap::<(String, String), Value>::new();
    for &id in ids {
        let target = canonical(c, &plan.cards[id])?;
        let candidates=c.prepare("SELECT field,language,state,value_json,image_sha256 FROM correction WHERE fiche_id=?1").map_err(error)?.query_map([&target],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,json!([r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?])))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let incoming = index.card("corrections", id).iter().map(|r| {
            (
                r["field"].as_str().unwrap().into(),
                r["language"].as_str().unwrap().into(),
                json!([
                    r["state"],
                    if r["value"].is_null() {
                        None
                    } else {
                        Some(r["value"].to_string())
                    },
                    r["imageSha256"]
                ]),
            )
        });
        for (field, language, value) in candidates.into_iter().chain(incoming) {
            if values
                .insert((field, language), value.clone())
                .is_some_and(|old| old != value)
            {
                return Ok(false);
            }
        }
    }
    Ok(ids
        .iter()
        .filter(|id| !index.card("referenceValues", id).is_empty())
        .take(2)
        .count()
        <= 1)
}
pub(super) fn canonical(c: &Connection, id: &str) -> Result<String> {
    let mut current = id.to_string();
    let mut seen = BTreeSet::new();
    while seen.insert(current.clone()) {
        let next = c
            .query_row(
                "SELECT target_id FROM fiche_grouping WHERE fiche_id=?1",
                [&current],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?;
        match next {
            Some(next) => current = next,
            None => return Ok(current),
        }
    }
    Err(super::import::invalid())
}
pub(super) fn prepare(
    c: &Connection,
    doc: &Value,
    plan: &mut Plan,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let index = super::matching::Index::new(doc);
    let mut adjacency = std::collections::BTreeMap::<&str, Vec<&str>>::new();
    for row in rows(doc, "associations") {
        let a = text(row, "ficheId")?;
        let b = text(row, "targetId")?;
        adjacency.entry(a).or_default().push(b);
        adjacency.entry(b).or_default().push(a);
    }
    let mut visited = BTreeSet::new();
    for seed in rows(doc, "associations") {
        super::export::check(cancel)?;
        let seed_id = text(seed, "ficheId")?;
        if visited.contains(seed_id) {
            continue;
        }
        let mut members = BTreeSet::new();
        let mut queue = vec![seed_id];
        while let Some(id) = queue.pop() {
            super::export::check(cancel)?;
            if members.insert(id.to_string()) {
                if let Some(neighbors) = adjacency.get(id) {
                    queue.extend(neighbors);
                }
            }
        }
        visited.extend(members.iter().cloned());
        let relations = members
            .iter()
            .flat_map(|id| index.card("associations", id).iter().copied())
            .collect::<Vec<_>>();
        let local = members
            .iter()
            .map(|id| canonical(c, &plan.cards[id]))
            .collect::<Result<BTreeSet<_>>>()?
            .into_iter()
            .collect::<Vec<_>>();
        if local.len() == 1 {
            continue;
        }
        let mut sources = BTreeSet::new();
        for row in &relations {
            super::export::check(cancel)?;
            #[cfg(test)]
            super::import_tests::record_review_work(1);
            sources.insert(text(row, "ficheId")?);
        }
        let mut sinks = vec![];
        for id in &members {
            super::export::check(cancel)?;
            #[cfg(test)]
            super::import_tests::record_review_work(1);
            if !sources.contains(id.as_str()) {
                sinks.push(id);
            }
        }
        let compatible = sinks.len() == 1
            && members_verified(c, plan, &relations)?
            && groupable(c, &local)?
            && incoming_compatible(
                c,
                &index,
                plan,
                &members.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
        if compatible {
            let target = canonical(c, &plan.cards[sinks[0]])?;
            let source_ids = relations
                .iter()
                .map(|r| r["ficheId"].clone())
                .collect::<Vec<_>>();
            let value = json!({"members":local,"target":target,"originFicheIds":source_ids});
            plan.action("group", &target, value, Some(json!(false)), seed_id);
        } else {
            plan.preview.issues.push("retained:associations".into());
        }
    }
    for row in rows(doc, "pendingAssociations") {
        let Some(uuid) = row["packUuid"].as_str() else {
            return Err(super::import::invalid());
        };
        let Some(known) = row["knownFicheId"]
            .as_str()
            .and_then(|id| plan.cards.get(id))
        else {
            plan.preview
                .issues
                .push("retained:pendingAssociations".into());
            continue;
        };
        let hint = rows(doc, "exemplarHints")
            .iter()
            .find(|h| h["id"] == row["exemplarId"]);
        let source = hint
            .and_then(|h| h["ficheId"].as_str())
            .and_then(|id| plan.cards.get(id));
        let mut matches = vec![];
        if let Some(source) = source {
            let mut statement=c.prepare("SELECT e.id,e.proof_json FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.fiche_id=?1 AND e.retired=0 AND e.verified_uuid IS NULL AND o.state='available' AND json_extract(o.raw_observation_json,'$.identity.value')=?2 AND json_extract(o.raw_observation_json,'$.identity.reliable')=1 AND EXISTS(SELECT 1 FROM pack_identity WHERE pack_uuid=?2 AND fiche_id=?3)").map_err(error)?;
            matches = statement
                .query_map(params![source, uuid, known], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
        }
        if matches.len() == 1 {
            let (id, proof) = &matches[0];
            let value = json!({"exemplarId":id,"knownFicheId":known,"packUuid":uuid,"proof":proof,"originExemplarId":row["exemplarId"]});
            plan.action("convergence", id, value.clone(), None, "");
        } else {
            plan.preview
                .issues
                .push("retained:pendingAssociations".into());
        }
    }
    Ok(())
}
pub(super) fn apply(
    tx: &Transaction<'_>,
    kind: &str,
    value: &Value,
    operation: &str,
) -> Result<()> {
    match kind {
        "group" => {
            let original =
                serde_json::from_value::<Vec<String>>(value["members"].clone()).map_err(error)?;
            let ids = original
                .iter()
                .map(|id| canonical(tx, id))
                .collect::<Result<BTreeSet<_>>>()?
                .into_iter()
                .collect::<Vec<_>>();
            if ids.len() < 2 {
                return Ok(());
            }
            let before = association::snapshot(tx, &ids)?;
            let target = canonical(tx, text(value, "target")?)?;
            association::group(tx, &ids, &target, &[], false)?;
            tx.execute(
                "INSERT INTO association_event VALUES (?1,?2,'importGroup',?3,?4,?5)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    operation,
                    value.to_string(),
                    serde_json::to_string(&before).map_err(error)?,
                    serde_json::to_string(&association::snapshot(tx, &ids)?).map_err(error)?
                ],
            )
            .map_err(error)?;
        }
        "convergence" => {
            tx.execute(
                "INSERT OR REPLACE INTO identity_convergence VALUES (?1,?2,?3,?4)",
                params![
                    text(value, "exemplarId")?,
                    text(value, "knownFicheId")?,
                    text(value, "packUuid")?,
                    json!({"reason":"personalConflict","proof":value["proof"]}).to_string()
                ],
            )
            .map_err(error)?;
        }
        _ => return Err(super::import::invalid()),
    }
    Ok(())
}
/// Group membership evidence is portable data, never a file access permission.
pub(super) fn export_members(c: &Connection, source: &str, target: &str) -> Result<Value> {
    let mut owners = std::collections::BTreeMap::<String, String>::new();
    let snapshots = c
        .prepare("SELECT before_json FROM association_event ORDER BY rowid")
        .map_err(error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for raw in snapshots {
        if let Ok(Value::Object(before)) = serde_json::from_str::<Value>(&raw) {
            for (key, value) in before {
                if let (Some(card), Ok(Value::Array(key))) =
                    (value.as_str(), serde_json::from_str::<Value>(&key))
                {
                    if key.first().and_then(Value::as_str) == Some("exemplar") {
                        if let Some(id) = key.get(1).and_then(Value::as_str) {
                            owners.entry(id.into()).or_insert_with(|| card.into());
                        }
                    }
                }
            }
        }
    }
    let mut original = vec![];
    let mut retained = vec![];
    let current = canonical(c, target)?;
    let rows = c
        .prepare("SELECT id,proof_json,verified_uuid FROM exemplar WHERE fiche_id=?1 ORDER BY id")
        .map_err(error)?
        .query_map([&current], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for (id, proof, uuid) in rows {
        let proof = json!({"digest":super::validate::payload(proof.as_bytes()).sha256,"uuid":uuid});
        let owner = owners.get(&id).map(String::as_str).unwrap_or(target);
        if owner == source {
            original.push(proof);
        } else if owner == target {
            retained.push(proof);
        }
    }
    Ok(json!([{"ficheId":source,"proofs":original},{"ficheId":target,"proofs":retained}]))
}
fn decision_recorded(
    c: &Connection,
    row: &Value,
    mapping: &std::collections::BTreeMap<String, String>,
) -> Result<bool> {
    let Some(participants) = row["participants"].as_array() else {
        return Ok(false);
    };
    let Some(mut mapped) = participants
        .iter()
        .map(|id| id.as_str().and_then(|id| mapping.get(id)).cloned())
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(false);
    };
    mapped.sort();
    mapped.dedup();
    let stored = c
        .prepare(
            "SELECT participants_json,evidence_json FROM suggestion_decision WHERE decision=?1",
        )
        .map_err(error)?
        .query_map([row["decision"].as_str().unwrap_or("")], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for (ids, signature) in stored {
        let mut ids: Vec<String> = serde_json::from_str(&ids).map_err(error)?;
        ids.sort();
        let signature: Value = serde_json::from_str(&signature).map_err(error)?;
        if ids != mapped || signature["algorithm"] != row["evidence"]["algorithm"] {
            continue;
        }
        let mut expected = std::collections::BTreeMap::<String, BTreeSet<String>>::new();
        let mut valid = true;
        for id in participants {
            let id = id.as_str().unwrap();
            let local = &mapping[id];
            let old = row["evidence"]["participants"]
                .as_array()
                .and_then(|a| a.iter().find(|r| r[0] == id));
            let stored = signature["participants"]
                .as_array()
                .and_then(|a| a.iter().find(|r| r[0] == *local));
            if let (Some(old), Some(stored)) = (old, stored) {
                if proof_signature(&old[1]).is_none()
                    || proof_signature(&old[1]) != proof_signature(&stored[1])
                {
                    valid = false;
                    break;
                }
                let target = canonical(c, local)?;
                for value in proof_signature(&old[1]).unwrap() {
                    expected
                        .entry(target.clone())
                        .or_default()
                        .insert(value.to_string());
                }
            } else {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }
        for (id, expected) in expected {
            let actual = c
                .prepare("SELECT proof_json,verified_uuid FROM exemplar WHERE fiche_id=?1")
                .map_err(error)?
                .query_map([id], |r| {
                    Ok(json!([r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?]).to_string())
                })
                .map_err(error)?
                .collect::<rusqlite::Result<BTreeSet<_>>>()
                .map_err(error)?;
            if actual != expected {
                valid = false;
                break;
            }
        }
        if valid {
            return Ok(true);
        }
    }
    Ok(false)
}
/// Remove fulfilled requests from both current and older retained documents.
pub(super) fn trim_retained(
    c: &Connection,
    doc: &mut Value,
    selected: &[&super::matching::Action],
    operation_origin: &str,
) -> Result<()> {
    let origin = text(doc, "originCatalogueId")?.to_string();
    let mut mapping = std::collections::BTreeMap::new();
    for row in rows(doc, "cards") {
        let id = text(row, "id")?;
        let saved=c.query_row("SELECT local_entity_id FROM import_identity WHERE origin_catalogue_id=?1 AND origin_entity_id=?2 AND entity_type IN ('card','groupMember') ORDER BY CASE entity_type WHEN 'groupMember' THEN 0 ELSE 1 END LIMIT 1",params![origin,id],|r|r.get::<_,String>(0)).optional().map_err(error)?;
        if let Some(id_local) = saved {
            mapping.insert(id.to_string(), id_local);
        }
    }
    let mut remaining = vec![];
    for row in rows(doc, "associations") {
        let left = row["ficheId"].as_str().and_then(|id| mapping.get(id));
        let right = row["targetId"].as_str().and_then(|id| mapping.get(id));
        let restored = match (left, right) {
            (Some(a), Some(b)) => a != b && canonical(c, a)? == canonical(c, b)?,
            _ => false,
        };
        if !restored {
            remaining.push(row.clone());
        }
    }
    doc["associations"] = json!(remaining);
    let mut remaining = vec![];
    for row in rows(doc, "suggestionDecisions") {
        if !decision_recorded(c, row, &mapping)? {
            remaining.push(row.clone());
        }
    }
    doc["suggestionDecisions"] = json!(remaining);
    if origin == operation_origin {
        doc["pendingAssociations"]
            .as_array_mut()
            .unwrap()
            .retain(|row| {
                !selected.iter().any(|a| {
                    a.kind == "convergence" && a.incoming["originExemplarId"] == row["exemplarId"]
                })
            });
    }
    let mixed = super::matching::mixed_uuid_cards(doc);
    // Keep rejected incoming corrections only while their value differs from
    // the live record. Accepted data already has a durable representation.
    for key in ["corrections", "referenceValues"] {
        let mut pending = vec![];
        for row in rows(doc, key) {
            if row["ficheId"].as_str().is_some_and(|id| mixed.contains(id)) {
                pending.push(row.clone());
                continue;
            }
            let target = row["ficheId"].as_str().and_then(|id| mapping.get(id));
            let table = if key == "corrections" {
                "correction"
            } else {
                "reference_value"
            };
            let state = if key == "corrections" {
                "state"
            } else {
                "'defined'"
            };
            let local = if let Some(id) = target {
                c.query_row(&format!("SELECT {state},value_json,image_sha256 FROM {table} WHERE fiche_id=?1 AND field=?2 AND language=?3"),params![canonical(c,id)?,text(row,"field")?,row["language"].as_str().unwrap()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))).optional().map_err(error)?
            } else {
                None
            };
            let same = local.is_some_and(|(state, value, image)| {
                (key != "corrections" || row["state"] == state)
                    && value
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .unwrap_or(Value::Null)
                        == row["value"]
                    && image.as_deref() == row["imageSha256"].as_str()
            });
            if !same {
                pending.push(row.clone());
            }
        }
        doc[key] = json!(pending);
    }
    compact_retained(doc);
    Ok(())
}
/// Only unresolved evidence needs a second portable representation.
/// Integrated corrections, images and memberships are exported from live tables.
fn compact_retained(doc: &mut Value) {
    let evidence = ["associations", "suggestionDecisions", "pendingAssociations"];
    let mixed = super::matching::mixed_uuid_cards(doc);
    let mut needed = mixed.clone();
    let mixed_tags = rows(doc, "tagMembers")
        .iter()
        .filter(|r| r["ficheId"].as_str().is_some_and(|id| mixed.contains(id)))
        .filter_map(|r| r["tagId"].as_str().map(str::to_owned))
        .collect::<BTreeSet<_>>();
    for key in ["corrections", "referenceValues", "associations"] {
        for row in rows(doc, key) {
            for field in ["ficheId", "targetId"] {
                if let Some(id) = row[field].as_str() {
                    needed.insert(id.into());
                }
            }
            for member in row["members"].as_array().into_iter().flatten() {
                if let Some(id) = member["ficheId"].as_str() {
                    needed.insert(id.into());
                }
            }
        }
    }
    for row in rows(doc, "suggestionDecisions") {
        for id in row["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            needed.insert(id.into());
        }
    }
    for row in rows(doc, "pendingAssociations") {
        if let Some(id) = row["knownFicheId"].as_str() {
            needed.insert(id.into());
        }
        for hint in rows(doc, "exemplarHints")
            .iter()
            .filter(|h| h["id"] == row["exemplarId"])
        {
            if let Some(id) = hint["ficheId"].as_str() {
                needed.insert(id.into());
            }
        }
    }
    for key in super::validate::ARRAYS {
        if evidence.contains(key) || ["corrections", "referenceValues"].contains(key) {
            continue;
        }
        let kept = match *key {
            "cards" => rows(doc, key)
                .iter()
                .filter(|r| needed.contains(r["id"].as_str().unwrap()))
                .map(|r| {
                    if mixed.contains(r["id"].as_str().unwrap()) {
                        r.clone()
                    } else {
                        json!({"id":r["id"],"createdAt":r["createdAt"],"favorite":0,"revision":0})
                    }
                })
                .collect::<Vec<_>>(),
            "provenances" => {
                let needed = rows(doc, "corrections")
                    .iter()
                    .chain(rows(doc, "referenceValues"))
                    .filter_map(|r| r["provenanceId"].as_str())
                    .collect::<BTreeSet<_>>();
                rows(doc, key)
                    .iter()
                    .filter(|r| needed.contains(r["id"].as_str().unwrap()))
                    .cloned()
                    .collect()
            }
            "references" | "tagMembers" | "forgottenCards" => rows(doc, key)
                .iter()
                .filter(|r| r["ficheId"].as_str().is_some_and(|id| mixed.contains(id)))
                .cloned()
                .collect(),
            "tags" => rows(doc, key)
                .iter()
                .filter(|r| r["id"].as_str().is_some_and(|id| mixed_tags.contains(id)))
                .cloned()
                .collect(),
            "identities" | "exemplarHints" => rows(doc, key)
                .iter()
                .filter(|r| needed.contains(r["ficheId"].as_str().unwrap()))
                .cloned()
                .collect(),
            _ => vec![],
        };
        doc[*key] = json!(kept);
    }
    doc["catalogueRevision"] = json!(0);
}
pub(super) fn has_retained(doc: &Value) -> bool {
    !super::matching::mixed_uuid_cards(doc).is_empty()
        || [
            "associations",
            "suggestionDecisions",
            "pendingAssociations",
            "corrections",
            "referenceValues",
        ]
        .iter()
        .any(|key| !rows(doc, key).is_empty())
}
/// Remove evidence involving forgotten cards before their import mappings vanish.
pub(crate) fn forget_retained(tx: &Transaction<'_>, local_id: &str) -> Result<()> {
    let documents = tx
        .prepare("SELECT archive_digest,document_json FROM pending_import")
        .map_err(error)?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for (digest, raw) in documents {
        let mut doc: Value = serde_json::from_str(&raw).map_err(error)?;
        let origin = text(&doc, "originCatalogueId")?;
        let mut ids=tx.prepare("SELECT origin_entity_id FROM import_identity WHERE origin_catalogue_id=?1 AND local_entity_id=?2 AND entity_type IN ('card','groupMember')").map_err(error)?.query_map(params![origin,local_id],|r|r.get::<_,String>(0)).map_err(error)?.collect::<rusqlite::Result<BTreeSet<_>>>().map_err(error)?;
        ids.insert(local_id.into());
        let hints = rows(&doc, "exemplarHints")
            .iter()
            .filter(|h| h["ficheId"].as_str().is_some_and(|id| ids.contains(id)))
            .filter_map(|h| h["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let forgotten_hints = hints.into_iter().collect::<BTreeSet<_>>();
        for key in super::validate::ARRAYS {
            doc[*key].as_array_mut().unwrap().retain(|row| {
                let card = if *key == "cards" {
                    &row["id"]
                } else {
                    &row["ficheId"]
                };
                if card.as_str().is_some_and(|id| ids.contains(id)) {
                    return false;
                }
                match *key {
                    "associations" => {
                        !row["targetId"].as_str().is_some_and(|id| ids.contains(id))
                            && !row["members"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|m| m["ficheId"].as_str().is_some_and(|id| ids.contains(id)))
                    }
                    "suggestionDecisions" => !row["participants"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|id| id.as_str().is_some_and(|id| ids.contains(id))),
                    "pendingAssociations" => {
                        !row["knownFicheId"]
                            .as_str()
                            .is_some_and(|id| ids.contains(id))
                            && !row["exemplarId"]
                                .as_str()
                                .is_some_and(|id| forgotten_hints.contains(id))
                    }
                    _ => true,
                }
            });
        }
        compact_retained(&mut doc);
        tx.execute(
            "DELETE FROM pending_import WHERE archive_digest=?1",
            [digest],
        )
        .map_err(error)?;
        if has_retained(&doc) {
            let bytes = doc.to_string();
            let digest = super::validate::payload(bytes.as_bytes()).sha256;
            tx.execute(
                "INSERT OR IGNORE INTO pending_import VALUES (?1,?2,?3)",
                params![text(&doc, "originCatalogueId")?, digest, bytes],
            )
            .map_err(error)?;
        }
    }
    Ok(())
}
pub(super) fn refresh_retained(
    tx: &Transaction<'_>,
    selected: &[&super::matching::Action],
    origin: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    // Hold only one bounded JSON document at a time, regardless of how many
    // older imports the catalogue retains.
    let ids = tx
        .prepare("SELECT archive_digest FROM pending_import ORDER BY archive_digest")
        .map_err(error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for id in ids {
        super::export::check(cancel)?;
        let raw = tx
            .query_row(
                "SELECT document_json FROM pending_import WHERE archive_digest=?1",
                [&id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?;
        let Some(raw) = raw else {
            continue;
        };
        let mut doc: Value = serde_json::from_str(&raw).map_err(error)?;
        trim_retained(tx, &mut doc, selected, origin)?;
        let bytes = doc.to_string();
        let digest = super::validate::payload(bytes.as_bytes()).sha256;
        tx.execute("DELETE FROM pending_import WHERE archive_digest=?1", [id])
            .map_err(error)?;
        if !has_retained(&doc) {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO pending_import VALUES (?1,?2,?3)",
            params![text(&doc, "originCatalogueId")?, digest, bytes],
        )
        .map_err(error)?;
    }
    Ok(())
}
