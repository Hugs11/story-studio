//! Personal-data allowlist captured from a coherent read snapshot.
use super::{failed, format::*, validate, Result};
use crate::services::catalogue::{
    backup::changed,
    store::{error, Store},
};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::PathBuf};

pub struct Snapshot {
    pub catalogue: Vec<u8>,
    pub manifest: Manifest,
    pub root: PathBuf,
    pub missing_lunii_images: usize,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
// lunii_pack/lunii_state/lunii_automatic/lunii_context are internal tools and
// deliberately absent from this portable allowlist. Fiche-owned Lunii values
// travel through referenceValues and their regular provenance/image assets.
// Explicit columns prevent a new technical column from silently becoming public.
// JSON-valued columns are decoded; proof, diagnostic and execution history never
// cross this boundary. Exemplars are hints, not usable file attestations.
const TABLES: &[(&str, &str)] = &[
    ("cards", "SELECT id,created_at AS createdAt,favorite,revision FROM fiche ORDER BY id"),
    ("forgottenCards", "SELECT fiche_id AS ficheId FROM fiche_forgotten ORDER BY fiche_id"),
    ("associations", "SELECT fiche_id AS ficheId,target_id AS targetId FROM fiche_grouping ORDER BY fiche_id"),
    ("identities", "SELECT pack_uuid AS packUuid,fiche_id AS ficheId,provenance_json AS provenance FROM pack_identity UNION ALL SELECT pack_uuid AS packUuid,fiche_id AS ficheId,provenance_json AS provenance FROM saved_pack_identity WHERE pack_uuid NOT IN (SELECT pack_uuid FROM pack_identity) ORDER BY packUuid"),
    ("exemplarHints", "SELECT id,fiche_id AS ficheId,verified_uuid AS verifiedUuid,anchor_json AS locator,retired,created_at AS createdAt FROM exemplar ORDER BY id"),
    ("provenances", "SELECT id,kind,exemplar_id AS exemplarId,locator_json AS locator,url,language,retrieved_at AS retrievedAt FROM provenance WHERE id IN (SELECT provenance_id FROM correction UNION SELECT provenance_id FROM reference_value) ORDER BY id"),
    ("references", "SELECT fiche_id AS ficheId,exemplar_id AS exemplarId,selected_at AS selectedAt,revision FROM reference_source ORDER BY fiche_id"),
    ("referenceValues", "SELECT fiche_id AS ficheId,field,language,value_json AS value,provenance_id AS provenanceId,image_sha256 AS imageSha256 FROM reference_value ORDER BY fiche_id,field,language"),
    ("corrections", "SELECT fiche_id AS ficheId,field,language,state,value_json AS value,provenance_id AS provenanceId,image_sha256 AS imageSha256,revision FROM correction ORDER BY fiche_id,field,language"),
    ("tags", "SELECT id,label,revision FROM tag ORDER BY id"),
    ("tagMembers", "SELECT m.tag_id AS tagId,m.fiche_id AS ficheId,o.provenance_json AS provenance FROM tag_member m LEFT JOIN enrichment_tag_origin o ON o.tag_id=m.tag_id AND o.fiche_id=m.fiche_id ORDER BY m.tag_id,m.fiche_id"),
    ("suggestionDecisions", "SELECT key,participants_json AS participants,evidence_json AS evidence,decision FROM suggestion_decision ORDER BY key"),
    ("pendingAssociations", "SELECT exemplar_id AS exemplarId,known_fiche_id AS knownFicheId,pack_uuid AS packUuid FROM identity_convergence ORDER BY exemplar_id"),
];
fn rows(c: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut statement = c.prepare(sql).map_err(error)?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut query = statement.query([]).map_err(error)?;
    let mut output = Vec::new();
    while let Some(row) = query.next().map_err(error)? {
        if output.len() >= MAX_ROWS {
            return Err(super::row_limit());
        }
        let mut item = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i).map_err(error)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Text(t) => {
                    let text = std::str::from_utf8(t).map_err(error)?;
                    if matches!(
                        name.as_str(),
                        "value" | "provenance" | "locator" | "participants" | "evidence"
                    ) {
                        serde_json::from_str(text).map_err(error)?
                    } else {
                        json!(text)
                    }
                }
                _ => return Err(failed()),
            };
            item.insert(name.clone(), value);
        }
        output.push(Value::Object(item));
    }
    Ok(output)
}
impl Store {
    pub(super) fn pin_snapshot_image(&self, sha: &str, expected: i64) -> Result<std::fs::File> {
        self.write(|tx| {
            std::fs::File::open(self.images_root().join(sha)).map_err(|_| {
                // The read snapshot can still reference an image collected after
                // a concurrent edit. Report the stale source, not a corrupt backup.
                match tx.query_row("SELECT revision FROM catalogue", [], |r| r.get::<_, i64>(0)) {
                    Ok(revision) if revision != expected => changed(),
                    Ok(_) => super::image_missing(sha),
                    Err(reason) => error(reason),
                }
            })
        })
    }

    pub(super) fn backup_snapshot(&self, expected: i64) -> Result<Snapshot> {
        self.read_snapshot(|tx| {
            Ok((|| -> Result<Snapshot> {
                let (origin, revision): (String, i64) = tx
                    .query_row("SELECT id,revision FROM catalogue", [], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .map_err(error)?;
                if revision != expected {
                    return Err(changed());
                }
                let id = uuid::Uuid::new_v4().to_string();
                let root = self.backup_root().join(&id);
                std::fs::create_dir_all(&root).map_err(error)?;
                let mut snapshot = Snapshot {
                    root,
                    missing_lunii_images: 0,
                    catalogue: Vec::new(),
                    manifest: Manifest {
                        format: FORMAT.into(),
                        format_version: VERSION,
                        schema: SCHEMA.into(),
                        backup_id: id,
                        origin_catalogue_id: origin.clone(),
                        catalogue_revision: revision,
                        counts: Counts::default(),
                        entries: BTreeMap::new(),
                    },
                };
                let mut document = json!({"originCatalogueId":origin,"catalogueRevision":revision});
                for (name, sql) in TABLES {
                    document[*name] = json!(rows(tx, sql)?);
                }
                for row in document["cards"].as_array_mut().unwrap() {
                    use rusqlite::OptionalExtension;
                    let filled: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM lunii_filled WHERE fiche_id=?1)",
                            [row["id"].as_str().unwrap()],
                            |r| r.get(0),
                        )
                        .map_err(error)?;
                    if filled {
                        row["luniiFilled"] = json!(true);
                    }
                    let reference: Option<String> = tx
                        .query_row(
                            "SELECT reference_json FROM import_reference WHERE fiche_id=?1",
                            [row["id"].as_str().unwrap()],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(error)?;
                    if let Some(reference) = reference {
                        row["importedReference"] =
                            serde_json::from_str(&reference).map_err(error)?;
                    }
                }
                for row in document["associations"].as_array_mut().unwrap() {
                    row["members"] = super::relations::export_members(
                        tx,
                        row["ficheId"].as_str().unwrap(),
                        row["targetId"].as_str().unwrap(),
                    )?;
                }
                document["rootHints"] = json!(tx
                    .prepare(
                        "SELECT path FROM source WHERE status IN ('active','hint') ORDER BY id"
                    )
                    .map_err(error)?
                    .query_map([], |r| r.get::<_, Vec<u8>>(0))
                    .map_err(error)?
                    .map(|r| r.map(|b| crate::support::paths::path_for_frontend(
                        crate::services::catalogue::sources::native(b)
                    )))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(error)?);
                // Compact reserves written by earlier imports too, before applying
                // the portable row/JSON limits to the combined snapshot.
                let mut retained = vec![];
                for row in rows(
                    tx,
                    "SELECT document_json AS value FROM pending_import ORDER BY archive_digest",
                )? {
                    let mut doc = row["value"].clone();
                    super::relations::trim_retained(tx, &mut doc, &[], &origin)?;
                    if super::relations::has_retained(&doc) {
                        retained.push(doc);
                    }
                }
                if !retained.is_empty() {
                    document["retainedImports"] = json!(retained);
                }
                // Keyed official covers share one retained payload, including when
                // one fiche still has only the legacy reference.
                snapshot.missing_lunii_images = prepare_covers(self, &mut document)?;
                validate::ignore_collections(&mut document);
                validate::document(&document)?;
                snapshot.catalogue = serde_json::to_vec(&document).map_err(error)?;
                within(snapshot.catalogue.len() as u64, MAX_JSON)?;
                snapshot.manifest.counts = Counts {
                    cards: document["cards"].as_array().unwrap().len(),
                    tags: document["tags"].as_array().unwrap().len(),
                    images: 0,
                };
                snapshot.manifest.entries.insert(
                    "catalogue.json".into(),
                    validate::payload(&snapshot.catalogue),
                );
                let mut total = snapshot.catalogue.len() as u64;
                let mut hashes = std::collections::BTreeSet::new();
                image_hashes(&document, &mut hashes);
                within(hashes.len() as u64, MAX_IMAGES as u64)?;
                for sha in hashes {
                    // Pin one file against GC under the writer, then copy outside
                    // the lock. One open handle also respects native descriptor limits.
                    let file = self.pin_snapshot_image(&sha, expected)?;
                    if !validate::hash(&sha) {
                        return Err(super::image_missing(&sha));
                    }
                    let size: i64 = tx
                        .query_row(
                            "SELECT byte_size FROM image_asset WHERE sha256=?1",
                            [&sha],
                            |r| r.get(0),
                        )
                        .map_err(|_| super::image_missing(&sha))?;
                    let size = u64::try_from(size).map_err(|_| super::image_missing(&sha))?;
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    if size > MAX_IMAGE {
                        return Err(super::image_missing(&sha));
                    }
                    file.take(MAX_IMAGE + 1)
                        .read_to_end(&mut bytes)
                        .map_err(error)?;
                    if bytes.len() as u64 != size || validate::payload(&bytes).sha256 != sha {
                        return Err(super::image_missing(&sha));
                    }
                    total += size;
                    within(total, MAX_TOTAL)?;
                    std::fs::write(snapshot.root.join(&sha), &bytes).map_err(error)?;
                    snapshot
                        .manifest
                        .entries
                        .insert(format!("images/{sha}"), validate::payload(&bytes));
                }
                snapshot.manifest.counts.images = snapshot.manifest.entries.len() - 1;
                Ok(snapshot)
            })())
        })?
    }
}

fn image_hashes(doc: &Value, hashes: &mut std::collections::BTreeSet<String>) {
    for table in ["corrections", "referenceValues"] {
        for row in super::matching::rows(doc, table) {
            if let Some(sha) = row["imageSha256"].as_str() {
                hashes.insert(sha.to_owned());
            }
        }
    }
    if let Some(retained) = doc["retainedImports"].as_array() {
        for doc in retained {
            image_hashes(doc, hashes);
        }
    }
}
fn prepare_covers(store: &Store, doc: &mut Value) -> Result<usize> {
    fn visit(doc: &mut Value, f: &mut impl FnMut(&mut Value)) {
        let official = super::matching::rows(doc, "provenances")
            .iter()
            .filter(|p| p["kind"] == "lunii")
            .filter_map(|p| p["id"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>();
        for row in doc["referenceValues"].as_array_mut().unwrap() {
            if row["field"] == "cover"
                && official.contains(row["provenanceId"].as_str().unwrap_or(""))
                && crate::services::catalogue::lunii_db::valid_cover(&row["value"])
            {
                f(row);
            }
        }
        if let Some(retained) = doc.get_mut("retainedImports").and_then(Value::as_array_mut) {
            for doc in retained {
                visit(doc, f);
            }
        }
    }
    let mut available = BTreeMap::new();
    visit(doc, &mut |row| {
        if let Some(sha) = row["imageSha256"].as_str() {
            if validate::hash(sha) && store.images_root().join(sha).is_file() {
                available
                    .entry(row["value"]["key"].as_str().unwrap().to_owned())
                    .or_insert_with(|| sha.to_owned());
            }
        }
    });
    let mut missing = std::collections::BTreeSet::new();
    visit(doc, &mut |row| {
        let key = row["value"]["key"].as_str().unwrap();
        row["imageSha256"] = match available.get(key) {
            Some(sha) => json!(sha),
            None => {
                missing.insert(key.to_owned());
                Value::Null
            }
        };
    });
    Ok(missing.len())
}

/// Every portable ceiling reached while producing a backup has its own code.
pub(super) fn within(value: u64, max: u64) -> Result<()> {
    if value > max {
        return Err(super::size_limit());
    }
    Ok(())
}
