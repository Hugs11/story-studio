//! Internal identity convergence and legacy association snapshots.
//! scans and edits to unrelated values remain independent of undo.
use super::names;
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Connection, Transaction};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub type Snapshot = BTreeMap<String, Value>;
fn refused(reason: &str) -> UserMessage {
    UserMessage::new(codes::CATALOG_GROUPING_REFUSED).param("reason", reason)
}
// Table and column names are exclusively internal constants.
const TABLES: &[(&str, &[&str], usize)] = &[
    (
        "lunii_filled",
        &["fiche_id", "author_checked", "checked_fields"],
        1,
    ),
    (
        "lunii_pending_cover",
        &[
            "fiche_id",
            "pack_uuid",
            "cover_key",
            "image_path",
            "image_sha256",
        ],
        4,
    ),
    ("lunii_image_attempt", &["fiche_id", "failures"], 1),
    (
        "correction",
        &[
            "fiche_id",
            "field",
            "language",
            "state",
            "value_json",
            "provenance_id",
            "image_sha256",
            "revision",
        ],
        3,
    ),
    ("tag_member", &["tag_id", "fiche_id"], 2),
    (
        "enrichment_tag_origin",
        &["tag_id", "fiche_id", "provenance_json"],
        2,
    ),
    (
        "reference_source",
        &["fiche_id", "exemplar_id", "selected_at", "revision"],
        1,
    ),
    (
        "reference_value",
        &[
            "fiche_id",
            "field",
            "language",
            "value_json",
            "provenance_id",
            "image_sha256",
        ],
        3,
    ),
    (
        "pack_identity",
        &["pack_uuid", "fiche_id", "provenance_json"],
        1,
    ),
    (
        "saved_pack_identity",
        &["pack_uuid", "fiche_id", "provenance_json"],
        1,
    ),
    (
        "import_identity",
        &[
            "origin_catalogue_id",
            "entity_type",
            "origin_entity_id",
            "local_entity_id",
            "last_imported_json",
        ],
        3,
    ),
    ("import_reference", &["fiche_id", "reference_json"], 1),
    ("fiche_grouping", &["fiche_id", "target_id"], 1),
    (
        "identity_convergence",
        &[
            "exemplar_id",
            "known_fiche_id",
            "pack_uuid",
            "evidence_json",
        ],
        1,
    ),
];
pub fn snapshot(c: &Connection, ids: &[String]) -> Result<Snapshot> {
    let mut values = BTreeMap::new();
    for id in ids {
        let favorite: i64 = c
            .query_row("SELECT favorite FROM fiche WHERE id=?1", [id], |r| r.get(0))
            .map_err(error)?;
        values.insert(json!(["favorite", id]).to_string(), json!(favorite));
        let exemplars = c
            .prepare("SELECT id,fiche_id,verified_uuid FROM exemplar WHERE fiche_id=?1 ORDER BY id")
            .map_err(error)?
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        for (eid, card, uuid) in exemplars {
            values.insert(json!(["exemplarUuid", eid]).to_string(), json!(uuid));
            values.insert(json!(["exemplar", eid]).to_string(), json!(card));
        }
        for (table, columns, pk) in TABLES {
            let condition = if *table == "identity_convergence" {
                "known_fiche_id=?1 OR exemplar_id IN (SELECT id FROM exemplar WHERE fiche_id=?1)"
            } else if *table == "import_identity" {
                "entity_type IN ('card','groupMember') AND local_entity_id=?1"
            } else {
                "fiche_id=?1"
            };
            let sql = format!(
                "SELECT {} FROM {table} WHERE {condition}",
                columns.join(",")
            );
            let rows = c
                .prepare(&sql)
                .map_err(error)?
                .query_map([id], |r| {
                    (0..columns.len())
                        .map(|i| {
                            use rusqlite::types::ValueRef;
                            Ok(match r.get_ref(i)? {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(v) => json!(v),
                                ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                                _ => unreachable!("association values are text or integers"),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
            for row in rows {
                values.insert(json!([table, &row[..*pk]]).to_string(), json!(row));
            }
        }
    }
    Ok(values)
}
pub fn restore(tx: &Transaction<'_>, values: &Snapshot) -> Result<()> {
    // Delete all affected rows first, then insert: keys can move between cards.
    for (key, value) in values {
        let key: Value = serde_json::from_str(key).map_err(error)?;
        match key[0].as_str().unwrap_or("") {
            "favorite" => {
                tx.execute(
                    "UPDATE fiche SET favorite=?2 WHERE id=?1",
                    params![key[1].as_str(), value.as_i64()],
                )
                .map_err(error)?;
            }
            "exemplarUuid" => {
                tx.execute(
                    "UPDATE exemplar SET verified_uuid=?2 WHERE id=?1",
                    params![key[1].as_str(), value.as_str()],
                )
                .map_err(error)?;
            }
            "exemplar" => {
                tx.execute(
                    "UPDATE exemplar SET fiche_id=?2 WHERE id=?1",
                    params![key[1].as_str(), value.as_str()],
                )
                .map_err(error)?;
            }
            table => {
                let Some((_, cols, pk)) = TABLES.iter().find(|(t, _, _)| *t == table) else {
                    continue;
                };
                let where_sql = cols[..*pk]
                    .iter()
                    .enumerate()
                    .map(|(i, col)| format!("{col}=?{}", i + 1))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let params = key[1]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(sql_value)
                    .collect::<Vec<_>>();
                tx.execute(
                    &format!("DELETE FROM {table} WHERE {where_sql}"),
                    rusqlite::params_from_iter(params),
                )
                .map_err(error)?;
            }
        }
    }
    for (key, value) in values {
        let key: Value = serde_json::from_str(key).map_err(error)?;
        let table = key[0].as_str().unwrap_or("");
        if value.is_null() || matches!(table, "favorite" | "exemplar" | "exemplarUuid") {
            continue;
        }
        let Some((_, cols, _)) = TABLES.iter().find(|(t, _, _)| *t == table) else {
            continue;
        };
        // Pre-v5/v6 undo snapshots omit newer marker columns.
        let cols =
            if table == "lunii_filled" && value.as_array().is_some_and(|v| v.len() < cols.len()) {
                &cols[..value.as_array().unwrap().len()]
            } else {
                cols
            };
        let marks = vec!["?"; cols.len()].join(",");
        tx.execute(
            &format!("INSERT INTO {table} ({}) VALUES ({marks})", cols.join(",")),
            rusqlite::params_from_iter(value.as_array().unwrap().iter().map(sql_value)),
        )
        .map_err(error)?;
    }
    Ok(())
}
fn sql_value(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        _ => unreachable!(),
    }
}

type CorrectionCandidates = BTreeMap<(String, String), Vec<(String, Value)>>;

fn correction_candidates(tx: &Connection, ids: &[String]) -> Result<CorrectionCandidates> {
    let mut corrections: CorrectionCandidates = BTreeMap::new();
    for id in ids {
        for (key, row) in snapshot(tx, std::slice::from_ref(id))? {
            let key: Value = serde_json::from_str(&key).map_err(error)?;
            if key[0] == "correction" {
                corrections
                    .entry((
                        row[1].as_str().unwrap().into(),
                        row[2].as_str().unwrap().into(),
                    ))
                    .or_default()
                    .push((id.clone(), row));
            }
        }
    }
    // Age corrections form a pair. Absence is an explicit candidate when
    // cards carry complementary bounds; never silently combine two cards.
    let age_pairs: Vec<_> = ids
        .iter()
        .map(|id| {
            ["ageMin", "ageMax"].map(|field| {
                corrections
                    .get(&(field.to_owned(), String::new()))
                    .and_then(|rows| rows.iter().find(|(card, _)| card == id))
                    .map(|(_, row)| json!([row[3], row[4]]))
                    .unwrap_or(Value::Null)
            })
        })
        .collect();
    if age_pairs.windows(2).any(|pair| pair[0] != pair[1]) {
        for field in ["ageMin", "ageMax"] {
            let rows = corrections
                .entry((field.to_owned(), String::new()))
                .or_default();
            for id in ids {
                if !rows.iter().any(|(card, _)| card == id) {
                    rows.push((
                        id.clone(),
                        json!([id, field, "", "source", null, null, null, 0]),
                    ));
                }
            }
        }
    }
    Ok(corrections)
}

fn rows_conflict(rows: &[(String, Value)]) -> bool {
    let first = &rows[0].1;
    rows.iter()
        .any(|(_, row)| row[3] != first[3] || row[4] != first[4] || row[6] != first[6])
}

/// D55 and explicit grouping use the same normalized age pairs and comparisons.
pub fn corrections_conflict(tx: &Connection, a: &str, b: &str) -> Result<bool> {
    Ok(correction_candidates(tx, &[a.to_owned(), b.to_owned()])?
        .values()
        .any(|rows| rows_conflict(rows)))
}

pub fn group(
    tx: &Transaction<'_>,
    ids: &[String],
    target: &str,
    resolutions: &[Value],
    allow_missing: bool,
) -> Result<()> {
    crate::services::catalogue::files::require_associations_available(tx, ids)?;
    group_for_file(tx, ids, target, resolutions, allow_missing)
}

pub(crate) fn group_for_file(
    tx: &Transaction<'_>,
    ids: &[String],
    target: &str,
    resolutions: &[Value],
    allow_missing: bool,
) -> Result<()> {
    let unique: BTreeSet<_> = ids.iter().collect();
    if unique.len() < 2 || unique.len() != ids.len() || !ids.iter().any(|s| s == target) {
        return Err(refused("selection"));
    }
    let mut uuids = BTreeSet::new();
    for id in ids {
        names::require(tx, "fiche", id)?;
        let ready:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id JOIN cache.observation o ON o.exemplar_id=e.id WHERE r.fiche_id=?1 AND e.fiche_id=?1 AND e.retired=0 AND o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id WHERE v.exemplar_id=e.id AND s.status='active'))",[id],|r|r.get(0)).map_err(error)?;
        let retained:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id WHERE r.fiche_id=?1 AND e.fiche_id=?1)",[id],|r|r.get(0)).map_err(error)?;
        if !(ready || allow_missing && retained) {
            return Err(refused("referenceNotReady"));
        }
        let identity=tx.prepare("SELECT pack_uuid FROM pack_identity WHERE fiche_id=?1 UNION SELECT verified_uuid FROM exemplar WHERE fiche_id=?1 AND verified_uuid IS NOT NULL UNION SELECT pack_uuid FROM saved_pack_identity WHERE fiche_id=?1").map_err(error)?.query_map([id],|r|r.get::<_,String>(0)).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        uuids.extend(identity);
    }
    if uuids.len() > 1 {
        return Err(refused("differentReliableUuids"));
    }
    let covers = crate::services::catalogue::lunii_db::retained_covers(tx, ids)?;
    let chosen = merge_corrections(tx, ids, target, resolutions)?;
    for id in ids.iter().filter(|id| id.as_str() != target) {
        tx.execute("UPDATE fiche SET favorite=max(favorite,(SELECT favorite FROM fiche WHERE id=?2)) WHERE id=?1",params![target,id]).map_err(error)?;
        tx.execute(
            "INSERT OR IGNORE INTO tag_member SELECT tag_id,?1 FROM tag_member WHERE fiche_id=?2",
            params![target, id],
        )
        .map_err(error)?;
        tx.execute("INSERT OR IGNORE INTO enrichment_tag_origin SELECT tag_id,?1,provenance_json FROM enrichment_tag_origin WHERE fiche_id=?2",params![target,id]).map_err(error)?;
        tx.execute("DELETE FROM tag_member WHERE fiche_id=?1", [id])
            .map_err(error)?;
        tx.execute(
            "INSERT OR IGNORE INTO lunii_filled(fiche_id,author_checked,checked_fields) SELECT ?1,author_checked,checked_fields FROM lunii_filled WHERE fiche_id=?2 AND EXISTS(SELECT 1 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii')",
            params![target, id],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE exemplar SET fiche_id=?1 WHERE fiche_id=?2",
            params![target, id],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE pack_identity SET fiche_id=?1 WHERE fiche_id=?2",
            params![target, id],
        )
        .map_err(error)?;
        tx.execute(
            "UPDATE saved_pack_identity SET fiche_id=?1 WHERE fiche_id=?2",
            params![target, id],
        )
        .map_err(error)?;
        tx.execute("INSERT INTO import_identity SELECT origin_catalogue_id,'groupMember',origin_entity_id,local_entity_id,last_imported_json FROM import_identity WHERE entity_type='card' AND local_entity_id=?1 ON CONFLICT(origin_catalogue_id,entity_type,origin_entity_id) DO NOTHING",[id]).map_err(error)?;
        tx.execute("UPDATE import_identity SET local_entity_id=?1 WHERE entity_type='card' AND local_entity_id=?2",params![target,id]).map_err(error)?;
        for table in [
            "correction",
            "reference_value",
            "lunii_pending_cover",
            "reference_source",
            "import_reference",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE fiche_id=?1"), [id])
                .map_err(error)?;
        }
        tx.execute("UPDATE fiche SET favorite=0 WHERE id=?1", [id])
            .map_err(error)?;
        tx.execute(
            "INSERT INTO fiche_grouping VALUES (?1,?2)",
            params![id, target],
        )
        .map_err(error)?;
    }
    tx.execute("DELETE FROM correction WHERE fiche_id=?1", [target])
        .map_err(error)?;
    restore(tx, &chosen)?;
    if !super::metadata::age_interval_valid(tx, target).map_err(error)? {
        return Err(refused("invalidAgeInterval"));
    }
    tx.execute("UPDATE exemplar SET verified_uuid=(SELECT pack_uuid FROM identity_convergence p WHERE p.exemplar_id=exemplar.id) WHERE fiche_id=?1 AND id IN (SELECT exemplar_id FROM identity_convergence)",[target]).map_err(error)?;
    tx.execute("DELETE FROM identity_convergence WHERE exemplar_id IN (SELECT id FROM exemplar WHERE fiche_id=?1)",[target]).map_err(error)?;
    crate::services::catalogue::lunii_db::fill_missing_in_mutation(tx)?;
    crate::services::catalogue::lunii_db::restore_covers(tx, &[target.to_owned()], &covers)?;
    Ok(())
}

pub(crate) fn merge_corrections(
    tx: &Transaction<'_>,
    ids: &[String],
    target: &str,
    resolutions: &[Value],
) -> Result<Snapshot> {
    let corrections = correction_candidates(tx, ids)?;
    if corrections.iter().any(|((field, _), rows)| {
        matches!(field.as_str(), "ageMin" | "ageMax") && rows_conflict(rows)
    }) {
        let chosen: BTreeSet<_> = resolutions
            .iter()
            .filter(|r| matches!(r["field"].as_str(), Some("ageMin" | "ageMax")))
            .filter_map(|r| r["ficheId"].as_str())
            .collect();
        if chosen.len() > 1 {
            return Err(refused("agePairRequired"));
        }
    }
    let mut conflicts = Vec::new();
    let mut chosen = Vec::new();
    for ((field, language), rows) in corrections {
        let first = &rows[0].1;
        let conflict = rows_conflict(&rows);
        let choice = resolutions
            .iter()
            .find(|r| r["field"] == field && r["language"].as_str().unwrap_or("") == language);
        let row = if conflict {
            match choice {
                Some(r) if r["decision"] == "cleared" => {
                    let mut row = first.clone();
                    row[3] = json!("cleared");
                    row[4] = Value::Null;
                    row[6] = Value::Null;
                    Some(row)
                }
                Some(r) => rows
                    .iter()
                    .find(|(id, _)| Some(id.as_str()) == r["ficheId"].as_str())
                    .map(|(_, r)| r.clone()),
                None => None,
            }
        } else {
            Some(first.clone())
        };
        if let Some(mut row) = row {
            if row[3] == "source" {
                continue;
            }
            row[0] = json!(target);
            chosen.push(row);
        } else {
            conflicts.push(json!({"field":field,"language":language,"candidates":rows.iter().map(|(id,r)|json!({"ficheId":id,"state":r[3],"value":r[4].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok())})).collect::<Vec<_>>()}));
        }
    }
    if !conflicts.is_empty() {
        return Err(refused("unresolvedConflicts").param("conflicts", json!(conflicts)));
    }
    let chosen: Snapshot = chosen
        .into_iter()
        .map(|r| (json!(["correction", [r[0], r[1], r[2]]]).to_string(), r))
        .collect();
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_ignores_unknown_tables() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE fiche(id TEXT PRIMARY KEY, favorite INTEGER); INSERT INTO fiche VALUES ('card',0);").unwrap();
        let tx = c.transaction().unwrap();
        let key = json!(["collection_member", ["old", "card"]]).to_string();
        let values = BTreeMap::from([
            (key.clone(), json!(["old", "card"])),
            (json!(["favorite", "card"]).to_string(), json!(1)),
        ]);
        restore(&tx, &values).unwrap();
        assert_eq!(
            tx.query_row("SELECT favorite FROM fiche", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        tx.commit().unwrap();
    }
}
