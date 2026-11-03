//! One-time fiche fill in the existing durable reference-value store.
use super::*;
use rusqlite::{params, Transaction};
/// Lunii slots have an origin namespace so pack-language slots can coexist.
/// The actual locale is stored in provenance, never inferred from this key.
pub(crate) fn missing(tx: &Transaction<'_>) -> Result<usize> {
    fill(tx, true)
}

/// The enclosing mutation owns the single catalogue revision and its receipt.
pub(crate) fn missing_in_mutation(tx: &Transaction<'_>) -> Result<usize> {
    fill(tx, false)
}

fn fill(tx: &Transaction<'_>, publish_revision: bool) -> Result<usize> {
    let allowed: Option<bool> = tx
        .query_row("SELECT allowed FROM lunii_permission WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    if allowed != Some(true) {
        return Ok(0);
    }
    let locale: String = tx
        .query_row("SELECT locale FROM lunii_context WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    if locale.is_empty() {
        return Ok(0);
    }
    let rows=tx.prepare("SELECT DISTINCT p.fiche_id,l.document_json,l.uuid FROM pack_identity p JOIN lunii_pack l ON l.uuid=lower(p.pack_uuid) WHERE NOT EXISTS(SELECT 1 FROM fiche_forgotten x WHERE x.fiche_id=p.fiche_id) AND NOT EXISTS(SELECT 1 FROM fiche_grouping g WHERE g.fiche_id=p.fiche_id) AND NOT EXISTS(SELECT 1 FROM lunii_filled f WHERE f.fiche_id=p.fiche_id) AND NOT EXISTS(SELECT 1 FROM reference_value v JOIN provenance o ON o.id=v.provenance_id WHERE v.fiche_id=p.fiche_id AND o.kind='lunii') ORDER BY p.fiche_id,l.uuid").map_err(error)?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
    let mut filled = 0;
    for (id, raw, uuid) in rows {
        // The exact same effective identity governs fill and association invalidation.
        if effective_uuid(tx, &id)?.as_deref() != Some(uuid.as_str()) {
            continue;
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM lunii_filled WHERE fiche_id=?1)",
                [&id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(error)?
        {
            continue;
        }
        let Ok(pack) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some((language, _data)) = parse::localized(&pack, &locale) else {
            continue;
        };
        let selected = language;
        let Some(infos) = pack["localized_infos"].as_object() else {
            continue;
        };
        for (language, data) in infos {
            let Some(data) = data.as_object() else {
                continue;
            };
            let mut values = data.clone();
            values.remove("imagePath");
            for field in ["ageMin", "keywords", "author", "language"] {
                if !pack[field].is_null() && pack[field] != json!([]) {
                    values.insert(field.into(), pack[field].clone());
                }
            }
            if *language == selected {
                if let Some(path) = image_path(&pack, language) {
                    values.insert(
                        "cover".into(),
                        json!({"kind":"lunii","key":image_key(&path),"imagePath":path}),
                    );
                }
            }
            // Resolve the existing maximum through the common precedence rules,
            // including manual clears and localized corrections.
            let effective = super::super::data::card::resolution(tx, &id, &[]).map_err(error)?;
            if values
                .get("ageMin")
                .and_then(Value::as_u64)
                .is_some_and(|min| {
                    effective
                        .values
                        .get("ageMax")
                        .and_then(Value::as_u64)
                        .is_some_and(|max| min > max)
                })
            {
                values.remove("ageMin");
            }
            let provenance = format!("lunii-{}", uuid::Uuid::new_v4());
            tx.execute("INSERT INTO provenance(id,kind,language,retrieved_at) VALUES (?1,'lunii',?2,unixepoch())",params![provenance,language]).map_err(error)?;
            for (field, value) in values {
                let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM correction WHERE fiche_id=?1 AND field=?2 AND state='cleared')",params![id,field],|r|r.get(0)).map_err(error)?;
                if occupied {
                    continue;
                }
                tx.execute(
                    "INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,NULL)",
                    params![
                        id,
                        field,
                        format!("@lunii:{language}"),
                        value.to_string(),
                        provenance
                    ],
                )
                .map_err(error)?;
                filled += 1;
            }
        }
        tx.execute("INSERT INTO lunii_filled(fiche_id) VALUES (?1)", [&id])
            .map_err(error)?;
        tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [id])
            .map_err(error)?;
    }
    filled += fill_fields(tx, &locale)?;
    restore_pending_covers(tx)?;
    if filled > 0 && publish_revision {
        tx.execute("UPDATE catalogue SET revision=revision+1", [])
            .map_err(error)?;
    }
    Ok(filled)
}

/// Previously filled fiches receive one pass per new field, including absent
/// values. Only current projections can complete a pass. Legacy author markers
/// remain authoritative; checked_fields extends this mechanism for newer fields.
fn fill_fields(tx: &Transaction<'_>, locale: &str) -> Result<usize> {
    let mut filled = 0;
    // Projections before v4 could not read Lunii's locale map: their language
    // is never considered checked.
    for (field, version) in [("author", 2), ("language", 4)] {
        let rows = tx.prepare("SELECT DISTINCT p.fiche_id,l.uuid,l.document_json FROM pack_identity p JOIN lunii_pack l ON l.uuid=lower(p.pack_uuid) JOIN lunii_filled f ON f.fiche_id=p.fiche_id WHERE NOT EXISTS(SELECT 1 FROM fiche_forgotten x WHERE x.fiche_id=p.fiche_id) AND NOT EXISTS(SELECT 1 FROM fiche_grouping g WHERE g.fiche_id=p.fiche_id) AND CASE WHEN ?1='author' THEN f.author_checked=0 ELSE NOT EXISTS(SELECT 1 FROM json_each(f.checked_fields) WHERE value=?1) END ORDER BY p.fiche_id,l.uuid").map_err(error)?.query_map([field], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        for (id, uuid, raw) in rows {
            if effective_uuid(tx, &id)?.as_deref() != Some(uuid.as_str()) {
                continue;
            }
            let Ok(pack) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if pack["projectionVersion"].as_u64().unwrap_or(1) < version
                || parse::localized(&pack, locale).is_none()
            {
                continue;
            }
            let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM correction WHERE fiche_id=?1 AND field=?2 AND state IN ('defined','cleared')) OR EXISTS(SELECT 1 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND v.field=?2 AND p.kind='lunii')", params![id,field], |r|r.get(0)).map_err(error)?;
            if !occupied {
                if let Some(value) = pack[field].as_str().filter(|s| !s.trim().is_empty()) {
                    for language in pack["localized_infos"]
                        .as_object()
                        .into_iter()
                        .flat_map(|infos| infos.keys())
                    {
                        let provenance = format!("lunii-{}", uuid::Uuid::new_v4());
                        tx.execute("INSERT INTO provenance(id,kind,language,retrieved_at) VALUES (?1,'lunii',?2,unixepoch())",params![provenance,language]).map_err(error)?;
                        tx.execute(
                            "INSERT INTO reference_value VALUES (?1,?2,?3,?4,?5,NULL)",
                            params![
                                id,
                                field,
                                format!("@lunii:{language}"),
                                json!(value).to_string(),
                                provenance
                            ],
                        )
                        .map_err(error)?;
                    }
                    tx.execute("UPDATE fiche SET revision=revision+1 WHERE id=?1", [&id])
                        .map_err(error)?;
                    filled += 1;
                }
            }
            if field == "author" {
                tx.execute(
                    "UPDATE lunii_filled SET author_checked=1 WHERE fiche_id=?1",
                    [&id],
                )
                .map_err(error)?;
            } else {
                tx.execute("UPDATE lunii_filled SET checked_fields=json_insert(checked_fields,'$[#]',?2) WHERE fiche_id=?1", params![id,field]).map_err(error)?;
            }
        }
    }
    Ok(filled)
}

/// Carry only validated official image identities across an explicit association.
/// The asset itself remains durable and undo snapshots keep it reachable.
pub(crate) fn retained_covers(
    c: &rusqlite::Connection,
    ids: &[String],
) -> Result<Vec<(Value, String)>> {
    let mut covers = Vec::new();
    for id in ids {
        let rows = c.prepare("SELECT v.value_json,v.image_sha256 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND v.field='cover' AND p.kind='lunii' AND v.image_sha256 IS NOT NULL UNION SELECT json_object('kind','lunii','key',cover_key,'imagePath',image_path),image_sha256 FROM lunii_pending_cover WHERE fiche_id=?1").map_err(error)?.query_map([id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        for (raw, sha) in rows {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                if valid_cover(&value) {
                    covers.push((value, sha));
                }
            }
        }
    }
    Ok(covers)
}

/// Reattach only matching official paths/keys, never corrections or a new cover.
/// Its caller owns revision publication together with the fill transaction.
pub(crate) fn restore_covers(
    tx: &Transaction<'_>,
    ids: &[String],
    covers: &[(Value, String)],
) -> Result<()> {
    for id in ids {
        let identity = effective_uuid(tx, id)?;
        for (cover, sha) in covers {
            if !valid_cover(cover) {
                continue;
            }
            // Portable backups can restore a known official reference without
            // any verified local exemplar. Its exact path/key is sufficient for
            // immediate reattachment; only deferred fill needs a reliable UUID.
            tx.execute("UPDATE reference_value SET image_sha256=?1 WHERE fiche_id=?2 AND field='cover' AND image_sha256 IS NULL AND provenance_id IN (SELECT id FROM provenance WHERE kind='lunii') AND json_extract(value_json,'$.kind')='lunii' AND json_extract(value_json,'$.key')=?3 AND json_extract(value_json,'$.imagePath')=?4", params![sha,id,cover["key"].as_str(),cover["imagePath"].as_str()]).map_err(error)?;
            let Some(identity) = identity.as_ref() else {
                continue;
            };
            tx.execute(
                "INSERT OR REPLACE INTO lunii_pending_cover VALUES (?1,?2,?3,?4,?5)",
                params![
                    id,
                    identity,
                    cover["key"].as_str(),
                    cover["imagePath"].as_str(),
                    sha
                ],
            )
            .map_err(error)?;
        }
    }
    restore_pending_covers(tx)
}

/// Deferred links own their assets even while consent prevents the local fill.
/// Only a matching identity, official key and path may regain the retained bytes.
fn restore_pending_covers(tx: &Transaction<'_>) -> Result<()> {
    let ids = tx
        .prepare("SELECT DISTINCT fiche_id FROM lunii_pending_cover")
        .map_err(error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for id in ids {
        let identity = effective_uuid(tx, &id)?;
        tx.execute("UPDATE reference_value AS v SET image_sha256=(SELECT p.image_sha256 FROM lunii_pending_cover p WHERE p.fiche_id=v.fiche_id AND p.pack_uuid=?2 AND p.cover_key=json_extract(v.value_json,'$.key') AND p.image_path=json_extract(v.value_json,'$.imagePath')) WHERE v.fiche_id=?1 AND v.field='cover' AND v.image_sha256 IS NULL AND v.provenance_id IN (SELECT id FROM provenance WHERE kind='lunii') AND json_extract(v.value_json,'$.kind')='lunii' AND EXISTS(SELECT 1 FROM lunii_pending_cover p WHERE p.fiche_id=v.fiche_id AND p.pack_uuid=?2 AND p.cover_key=json_extract(v.value_json,'$.key') AND p.image_path=json_extract(v.value_json,'$.imagePath'))", params![id,identity]).map_err(error)?;
        // A completed fill also discards mismatching candidates; a changed UUID
        // cannot inherit a deferred attachment from an earlier identity.
        tx.execute("DELETE FROM lunii_pending_cover WHERE fiche_id=?1 AND (pack_uuid IS NOT ?2 OR EXISTS(SELECT 1 FROM lunii_filled WHERE fiche_id=?1))", params![id,identity]).map_err(error)?;
    }
    Ok(())
}

/// Selected principal UUID, or the sole reliable identity of its card.
/// Ambiguous and UUID-less cards cannot receive official metadata.
pub(crate) fn effective_uuid(c: &rusqlite::Connection, id: &str) -> Result<Option<String>> {
    if let Some(Some(uuid)) = principal_uuid(c, id)? {
        return Ok(Some(uuid.to_ascii_lowercase()));
    }
    let identities = c
        .prepare("SELECT pack_uuid FROM pack_identity WHERE fiche_id=?1 ORDER BY pack_uuid")
        .map_err(error)?
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    Ok(if identities.len() == 1 {
        Some(identities[0].to_ascii_lowercase())
    } else {
        None
    })
}

/// Principal identity shared by official fill and explicit separation.
fn principal_uuid(c: &rusqlite::Connection, id: &str) -> Result<Option<Option<String>>> {
    c.query_row("SELECT e.verified_uuid FROM exemplar e LEFT JOIN cache.observation o ON o.exemplar_id=e.id LEFT JOIN reference_source r ON r.fiche_id=e.fiche_id AND r.exemplar_id=e.id WHERE e.fiche_id=?1 AND e.retired=0 ORDER BY (r.exemplar_id IS NULL), CASE o.format WHEN 'project' THEN 0 WHEN 'zip' THEN 1 WHEN '7z' THEN 2 WHEN 'studioDirectory' THEN 3 WHEN 'fsDirectory' THEN 3 WHEN 'fsZip' THEN 3 ELSE 4 END,o.modified_at DESC,json_extract(e.anchor_json,'$.path'),json_extract(e.anchor_json,'$.member'),e.id LIMIT 1", [id], |r| r.get(0)).optional().map_err(error)
}
