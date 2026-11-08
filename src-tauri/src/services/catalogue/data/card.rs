//! Snapshot reads. Observations are cache-only; a read never starts analysis.
use super::resolver::{self, Correction, Corrections, References, Resolution};
use crate::services::catalogue::{
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

pub fn resolution(c: &Connection, id: &str, names: &[String]) -> rusqlite::Result<Resolution> {
    let corrections = corrections(c, id)?;
    let (lunii, locale) = super::super::lunii_db::values(c, id)?;
    let reference = source_references(c, id, &corrections, &lunii, locale.clone(), names)?;
    // Names only derive title and age values: the cover reference is the one
    // `cover_exemplar` computes without names.
    let cover_provenance = reference
        .get(&("cover".into(), String::new()))
        .map(|(_, provenance)| provenance.clone());
    let mut out = resolver::resolve_with_lunii(reference, corrections, names, lunii, locale);
    out.cover_provenance = cover_provenance;
    let saved=c.prepare("SELECT v.field,v.value_json,v.provenance_id,p.language FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii' ORDER BY v.field,v.language")?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (field, raw, provenance, language) in saved {
        if let Some(f) = out.fields.iter_mut().find(|f| {
            f.field == field
                && f.effective["origin"] == "lunii"
                && (field == "cover" || f.effective["language"].as_str() == language.as_deref())
        }) {
            f.reference_value =
                Some(json!({"value":parse(raw),"provenanceId":provenance,"language":language}));
        }
    }
    Ok(out)
}
fn corrections(c: &Connection, id: &str) -> rusqlite::Result<Corrections> {
    c.prepare("SELECT field,language,state,value_json FROM correction WHERE fiche_id=?1")?
        .query_map([id], |r| {
            let raw: Option<String> = r.get(3)?;
            Ok((
                (r.get(0)?, r.get(1)?),
                Correction {
                    state: r.get(2)?,
                    value: raw.map(parse),
                },
            ))
        })?
        .collect::<rusqlite::Result<Corrections>>()
}
fn source_references(
    c: &Connection,
    id: &str,
    corrections: &Corrections,
    lunii: &Map<String, Value>,
    locale: Option<String>,
    names: &[String],
) -> rusqlite::Result<References> {
    let mut reference = c
        .prepare(
            "SELECT v.field,v.language,v.value_json,v.provenance_id FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind!='lunii'",
        )?
        .query_map([id], |r| {
            Ok(((r.get(0)?, r.get(1)?), (parse(r.get(2)?), r.get(3)?)))
        })?
        .collect::<rusqlite::Result<References>>()?;
    complete_references(c, id, &mut reference, (corrections, lunii, locale, names))?;
    Ok(reference)
}

/// Compose source slots at read time: durable reference first, then available
/// siblings by modification time and stable id, except explicitly chosen project
/// thumbnails (nonempty thumbnailImage with sameImage != true), which precede
/// file references. rootImage and entry-screen fallbacks are not choices.
/// Nothing becomes a correction or
/// a portable reference value. No source I/O is performed here.
fn complete_references(
    c: &Connection,
    card: &str,
    reference: &mut References,
    context: (&Corrections, &Map<String, Value>, Option<String>, &[String]),
) -> rusqlite::Result<()> {
    let (corrections, lunii, locale, names) = context;
    let unreadable_reference: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM reference_source r JOIN cache.observation o ON o.exemplar_id=r.exemplar_id JOIN cache.extracted_value v ON v.exemplar_id=o.exemplar_id WHERE r.fiche_id=?1 AND v.field='cover' AND v.candidate_key='@unreadable:' || o.content_revision)",
        [card], |r| r.get(0))?;
    if unreadable_reference {
        reference.retain(|(field, _), _| field != "cover");
    }
    let ids = available_exemplars(c, card)?;
    // A project cover explicitly stored by the author precedes durable file
    // references. Keep its observed value and supplier together for assembly.
    for id in chosen_cover_projects(c, card)? {
        let unreadable: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM cache.extracted_value v JOIN cache.observation o ON o.exemplar_id=v.exemplar_id WHERE v.exemplar_id=?1 AND v.field='cover' AND v.candidate_key='@unreadable:' || o.content_revision)",
            [&id], |r| r.get(0))?;
        if unreadable {
            continue;
        }
        if let Some(candidate) = cached_candidates(c, &id)?
            .unwrap_or_default()
            .get(&("cover".into(), String::new()))
            .filter(|v| v["validity"] == "valid" && !v["value"].is_null())
        {
            reference.insert(
                ("cover".into(), String::new()),
                (candidate["value"].clone(), format!("observed:{id}")),
            );
            break;
        }
    }
    let mut ages = Vec::new();
    for id in ids {
        let unreadable: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM cache.extracted_value v JOIN cache.observation o ON o.exemplar_id=v.exemplar_id WHERE v.exemplar_id=?1 AND v.field='cover' AND v.candidate_key='@unreadable:' || o.content_revision)",
            [&id], |r| r.get(0))?;
        for (key, candidate) in cached_candidates(c, &id)?.unwrap_or_default() {
            if candidate["validity"] == "valid"
                && !candidate["value"].is_null()
                && !(key.0 == "cover" && (unreadable || candidate["value"]["available"] == false))
            {
                if key.0 == "ageMin" {
                    ages.push((key, candidate["value"].clone(), format!("observed:{id}")));
                    continue;
                }
                reference
                    .entry(key)
                    .or_insert_with(|| (candidate["value"].clone(), format!("observed:{id}")));
            }
        }
    }
    let maximum = resolver::resolve_with_lunii(
        reference.clone(),
        corrections.clone(),
        names,
        lunii.clone(),
        locale,
    )
    .values
    .get("ageMax")
    .and_then(Value::as_u64);
    for (key, value, provenance) in ages {
        if value
            .as_u64()
            .is_none_or(|min| maximum.is_none_or(|max| min <= max))
        {
            reference.entry(key).or_insert((value, provenance));
        }
    }
    Ok(())
}

fn available_exemplars(c: &Connection, card: &str) -> rusqlite::Result<Vec<String>> {
    let ids = c.prepare(
        "SELECT e.id FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id
         WHERE e.fiche_id=?1 AND e.retired=0 AND o.state='available'
         AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=e.id AND s.status='active' AND coalesce(h.availability,'available')!='unavailable')
         ORDER BY NOT EXISTS(SELECT 1 FROM reference_source r WHERE r.fiche_id=?1 AND r.exemplar_id=e.id),o.modified_at DESC,e.id ASC")?
        .query_map([card], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Read only cached project fields: the entry-screen fallback is not a choice.
fn chosen_cover_projects(c: &Connection, card: &str) -> rusqlite::Result<Vec<String>> {
    c.prepare(
        "SELECT e.id FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id
         WHERE e.fiche_id=?1 AND e.retired=0 AND o.state='available' AND o.format='project'
         AND json_type(o.raw_observation_json,'$.raw.thumbnailImage')='text'
         AND json_extract(o.raw_observation_json,'$.raw.thumbnailImage')!=''
         AND coalesce(json_type(o.raw_observation_json,'$.raw.sameImage'),'null')!='true'
         AND coalesce(json_type(o.raw_observation_json,'$.cover.available'),'null')!='false'
         AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=e.id AND s.status='active' AND coalesce(h.availability,'available')!='unavailable')
         ORDER BY o.modified_at DESC,e.id ASC",
    )?.query_map([card], |r| r.get::<_, String>(0))?
        .collect()
}

/// Resolve once per thumbnail request, then try the ordered covers without
/// recalculating all fields after each negative readability observation.
pub(crate) fn cover_exemplars(c: &Connection, card: &str) -> rusqlite::Result<Vec<String>> {
    let provenance = cover_provenance(c, card)?;
    cover_exemplars_from(c, card, provenance.as_deref())
}

/// `cover_exemplars` from an already resolved cover provenance
/// (`Resolution::cover_provenance`), without resolving the fiche again.
pub(crate) fn cover_exemplars_from(
    c: &Connection,
    card: &str,
    provenance: Option<&str>,
) -> rusqlite::Result<Vec<String>> {
    let mut ids = Vec::new();
    if let Some(id) = cover_exemplar_from(c, card, provenance)? {
        // Durable metadata may retain its original provenance after removal,
        // but a retired exemplar can no longer supply thumbnail bytes.
        let retained: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM exemplar WHERE id=?1 AND retired=0)",
            [&id],
            |r| r.get(0),
        )?;
        if retained {
            ids.push(id);
        }
    }
    for id in chosen_cover_projects(c, card)?
        .into_iter()
        .chain(available_exemplars(c, card)?)
    {
        if ids.contains(&id) {
            continue;
        }
        let unreadable: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM cache.extracted_value v JOIN cache.observation o ON o.exemplar_id=v.exemplar_id WHERE v.exemplar_id=?1 AND v.candidate_key='@unreadable:' || o.content_revision)", [&id], |r| r.get(0))?;
        if !unreadable
            && cached_candidates(c, &id)?
                .unwrap_or_default()
                .iter()
                .any(|((field, _), v)| {
                    field == "cover"
                        && v["validity"] == "valid"
                        && !v["value"].is_null()
                        && v["value"]["available"] != false
                })
        {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// Origin of the effective file cover, including a sibling supplying a hole.
pub(crate) fn cover_exemplar(c: &Connection, card: &str) -> rusqlite::Result<Option<String>> {
    let provenance = cover_provenance(c, card)?;
    cover_exemplar_from(c, card, provenance.as_deref())
}

fn cover_provenance(c: &Connection, card: &str) -> rusqlite::Result<Option<String>> {
    let corrections = corrections(c, card)?;
    let (lunii, locale) = super::super::lunii_db::values(c, card)?;
    let references = source_references(c, card, &corrections, &lunii, locale, &[])?;
    Ok(references
        .get(&("cover".into(), String::new()))
        .map(|(_, provenance)| provenance.clone()))
}

fn cover_exemplar_from(
    c: &Connection,
    card: &str,
    provenance: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let Some(provenance) = provenance else {
        return Ok(None);
    };
    if let Some(id) = provenance.strip_prefix("observed:") {
        return Ok(Some(id.to_owned()));
    }
    let supplier = c
        .query_row(
            "SELECT exemplar_id FROM provenance WHERE id=?1",
            [provenance],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if supplier.is_some() {
        return Ok(supplier);
    }
    // Portable imports retain provenance without a local exemplar link.
    c.query_row(
        "SELECT exemplar_id FROM reference_source WHERE fiche_id=?1",
        [card],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

fn parse(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

/// Cache readers accept both the raw 1b candidates and the canonical projection.
/// A cache purge returns None; it never triggers a disk analysis.
pub fn cached_candidates(
    c: &Connection,
    id: &str,
) -> rusqlite::Result<Option<std::collections::BTreeMap<resolver::Key, Value>>> {
    let canonical:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM cache.extracted_value WHERE exemplar_id=?1 AND candidate_key='@card')",[id],|r|r.get(0))?;
    let rows=c.prepare("SELECT field,language,presence,validity,value_json,raw_json,provenance_json FROM cache.extracted_value WHERE exemplar_id=?1 AND (?2=0 OR candidate_key='@card') ORDER BY field,language,candidate_key")?
        .query_map(rusqlite::params![id,canonical],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut fields = std::collections::BTreeMap::new();
    for (field, language, presence, validity, value, raw, provenance) in rows {
        let name = match field.as_str() {
            "projectName" | "name" => "title",
            "minAge" | "packMinAge" => "ageMin",
            "packDescription" => "description",
            "packVersion" | "version" => "versionDeclared",
            name => name,
        };
        if !resolver::FIELDS.contains(&name) {
            continue;
        }
        let effective = value
            .or_else(|| (validity == "valid").then(|| raw.clone()).flatten())
            .map(parse);
        let candidate = json!({"presence":presence,"validity":validity,"value":effective,"raw":raw.map(parse),"provenanceId":format!("observed:{id}"),"diagnostic":parse(provenance)});
        let entry = fields
            .entry((name.to_owned(), language))
            .or_insert_with(|| candidate.clone());
        if entry["validity"] != "valid" && validity == "valid" {
            *entry = candidate;
        }
    }
    Ok(Some(fields))
}
pub fn cached_fields(c: &Connection, id: &str) -> rusqlite::Result<Option<Map<String, Value>>> {
    Ok(cached_candidates(c, id)?.map(|candidates| {
        let mut fields = Map::new();
        for ((field, language), mut value) in candidates {
            value["field"] = json!(field);
            value["language"] = json!(language);
            let key = if language.is_empty() {
                field
            } else {
                json!([field, language]).to_string()
            };
            fields.insert(key, value);
        }
        fields
    }))
}

pub fn snapshot(c: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    let Some(entry) = super::super::grouping::entry_for_card(c, id)? else {
        return Ok(None);
    };
    let names = super::super::lunii_db::ordered_names(entry["exemplars"].as_array().unwrap());
    let mut resolved = resolution(c, id, &names)?;
    let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
    let reference=c.query_row("SELECT r.exemplar_id,r.selected_at,e.retired,o.state,EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id WHERE v.exemplar_id=e.id AND s.status='active') FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id LEFT JOIN cache.observation o ON o.exemplar_id=e.id WHERE r.fiche_id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,bool>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,bool>(4)?))).optional()?;
    let reference: Option<(String, i64, bool, Option<String>, bool)> = reference;
    let mut exemplars = Vec::new();
    let mut provenance = Vec::new();
    for e in entry["exemplars"].as_array().unwrap() {
        let eid = e["id"].as_str().unwrap();
        let fields = cached_fields(c, eid)?;
        provenance.push(json!({"id":format!("observed:{eid}"),"kind":"file","exemplarId":eid}));
        if let Some(fields) = &fields {
            if Some(eid) == entry["referenceExemplarId"].as_str() {
                // Observed languages also need a slot when no durable value exists.
                for v in fields.values() {
                    let field = v["field"].as_str().unwrap();
                    let language = v["language"].as_str().unwrap_or("");
                    if !resolved
                        .fields
                        .iter()
                        .any(|f| f.field == field && f.language == language)
                    {
                        let mut empty = resolver::resolve_fields(
                            Default::default(),
                            [(
                                (field.to_owned(), language.to_owned()),
                                Correction {
                                    state: "none".into(),
                                    value: None,
                                },
                            )]
                            .into(),
                            &[],
                        );
                        resolved.fields.push(
                            empty.fields.remove(
                                empty
                                    .fields
                                    .iter()
                                    .position(|f| f.field == field && f.language == language)
                                    .unwrap(),
                            ),
                        );
                    }
                }
                for f in &mut resolved.fields {
                    let key = if f.language.is_empty() {
                        f.field.clone()
                    } else {
                        json!([f.field, f.language]).to_string()
                    };
                    if let Some(v) = fields.get(&key) {
                        if v["validity"] == "invalid" {
                            f.invalid
                                .push(json!({"raw":v["raw"],"diagnostic":v["diagnostic"]}));
                        }
                    }
                }
            }
        }
        let listening = fields
            .as_ref()
            .map(|f| (f.get("storyCount"), f.get("durationSeconds")));
        exemplars.push(json!({"id":eid,"format":e["format"],"path":e["locator"]["path"],"member":e["locator"]["member"],"archiveRemoval":e["archiveRemoval"],"state":e["state"],"availability":e["availability"],"modifiedAt":e["modifiedAt"],"declaredVersion":e["versionDeclared"],"fields":fields,"stale":fields.is_none()}));
        if let Some((count, duration)) = listening {
            let row = exemplars.last_mut().unwrap();
            for (key, field) in [("storyCount", count), ("durationSeconds", duration)] {
                if let Some(value) = field
                    .filter(|f| f["validity"] == "valid")
                    .and_then(|f| f.get("value"))
                    .filter(|v| v.is_number())
                {
                    row[key] = value.clone();
                }
            }
        }
    }
    let rows=c.prepare("SELECT DISTINCT p.id,p.kind,p.exemplar_id,p.url,p.language,p.retrieved_at,COALESCE(p.diagnostic_json,p.locator_json) FROM provenance p WHERE p.id IN (SELECT provenance_id FROM reference_value WHERE fiche_id=?1 UNION SELECT provenance_id FROM correction WHERE fiche_id=?1)")?
        .query_map([id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"exemplarId":r.get::<_,Option<String>>(2)?,"url":r.get::<_,Option<String>>(3)?,"language":r.get::<_,Option<String>>(4)?,"retrievedAt":r.get::<_,Option<i64>>(5)?,"diagnostic":r.get::<_,Option<String>>(6)?.map(parse)})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    provenance.extend(rows);
    let correction_provenances = c
        .prepare("SELECT field,language,provenance_id FROM correction WHERE fiche_id=?1")?
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut fields = serde_json::to_value(&resolved.fields).expect("serializable fields");
    for (field, language, provenance) in correction_provenances {
        if let Some(f) = fields.as_array_mut().and_then(|a| {
            a.iter_mut()
                .find(|f| f["field"] == field && f["language"].as_str().unwrap_or("") == language)
        }) {
            f["correction"]["provenanceId"] = json!(provenance);
        }
    }

    let tag_origins = c
        .prepare("SELECT tag_id,provenance_json FROM enrichment_tag_origin WHERE fiche_id=?1")?
        .query_map([id], |r| {
            Ok(json!({"tagId":r.get::<_,String>(0)?,"origin":parse(r.get(1)?)}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let uuid = c
        .query_row(
            "SELECT pack_uuid,provenance_json FROM pack_identity WHERE fiche_id=?1 LIMIT 1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let imported_reference = c
        .query_row(
            "SELECT reference_json FROM import_reference WHERE fiche_id=?1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(parse);
    Ok(Some(
        json!({"ficheId":id,"offlineReason":entry["offlineReason"],"ficheRevision":entry["ficheRevision"],"catalogueRevision":revision,"sourcesRevision":c.query_row("SELECT sources_revision FROM catalogue",[],|r|r.get::<_,i64>(0))?,"favorite":entry["favorite"],"tagIds":entry["tagIds"],"tags":entry["tags"],"tagOrigins":tag_origins,"uuid":uuid.as_ref().map(|u|&u.0),"uuidProvenance":uuid.map(|u|parse(u.1)),"reference":reference.map(|(eid,at,retired,state,covered)|json!({"exemplarId":eid,"selectedAt":at,"state":if retired || !covered {"unavailable"} else if state.is_none(){"unknown"} else if state.as_deref()==Some("available"){"available"}else{"unavailable"}})).unwrap_or(json!({"exemplarId":imported_reference.as_ref().and_then(|v|v.get("exemplarId")),"selectedAt":imported_reference.as_ref().and_then(|v|v.get("selectedAt")),"state":if c.query_row("SELECT EXISTS(SELECT 1 FROM import_reference WHERE fiche_id=?1)",[id],|r|r.get::<_,bool>(0))? {"unavailable"}else{"unknown"}})),"fields":fields,"provenance":provenance,"exemplars":exemplars}),
    ))
}
impl Store {
    pub fn get_card(&self, id: &str) -> Result<Value> {
        self.read_snapshot(|c| snapshot(c, id))?
            .ok_or_else(|| UserMessage::new(codes::CATALOG_ENTITY_NOT_FOUND))
    }
}

/// Accepted candidates: preserves raw/absent/null/invalid alongside effective values.
pub fn publish_candidates(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    obs: &super::super::analyze::Observation,
) -> Result<()> {
    let pointers: &[(&str, &[&str])] = &[
        ("title", &["/packMetadata/title", "/packTitle", "/title"]),
        ("subtitle", &["/packMetadata/subtitle", "/subtitle"]),
        (
            "description",
            &[
                "/authoring/payload#/document/description",
                "/packMetadata/description",
                "/packDescription",
                "/description",
            ],
        ),
        (
            "ageMin",
            &["/packMetadata/minAge", "/packMinAge", "/minAge", "/ageMin"],
        ),
        (
            "versionDeclared",
            &[
                "/authoring/payload#/document/version",
                "/packMetadata/version",
                "/packVersion",
                "/version",
            ],
        ),
        ("author", &["/packMetadata/author"]),
        ("language", &["/packMetadata/language", "/language"]),
        ("producer", &["/packMetadata/producer"]),
        ("bonus", &["/packMetadata/bonus"]),
        ("keywords", &["/packMetadata/keywords", "/keywords"]),
        ("durationSeconds", &["/packMetadata/durationSeconds"]),
        ("storyCount", &["/packMetadata/storyCount"]),
    ];
    for field in resolver::FIELDS {
        let observed = pointers
            .iter()
            .find(|(f, _)| f == field)
            .and_then(|(_, ps)| {
                ps.iter()
                    .filter_map(|p| obs.fields.get(*p))
                    .find(|v| v.presence != "absent")
            });
        let special = match *field {
            "title" => obs.title.as_ref().map(|v| json!(v)),
            "description" => obs
                .text(&[
                    "/packMetadata/description",
                    "/packDescription",
                    "/description",
                ])
                .map(|v| json!(v)),
            "ageMin" => obs
                .age_min
                .or_else(|| {
                    observed
                        .filter(|f| f.validity == "valid")
                        .and_then(|f| f.raw_value.as_ref())
                        .and_then(super::super::analyze::age)
                })
                .map(|v| json!(v)),
            "cover" => obs.cover.clone(),
            _ => None,
        };
        let value = special.or_else(|| {
            observed
                .filter(|f| f.validity == "valid")
                .and_then(|f| f.raw_value.clone())
        });
        let presence = observed
            .map(|f| f.presence.as_str())
            .unwrap_or(if value.is_some() { "present" } else { "absent" });
        let validity = if value.is_some() {
            "valid"
        } else {
            observed.map(|f| f.validity.as_str()).unwrap_or("unknown")
        };
        let raw = observed
            .and_then(|f| f.raw_value.as_ref())
            .or(value.as_ref())
            .map(Value::to_string);
        tx.execute(
            "INSERT OR REPLACE INTO cache.extracted_value VALUES (?1,?2,'','@card',?3,?4,?5,?6,?7)",
            rusqlite::params![
                id,
                field,
                presence,
                validity,
                raw,
                value.map(|v| v.to_string()),
                json!({"source":observed.map(|f|&f.source)}).to_string()
            ],
        )
        .map_err(error)?;
    }
    Ok(())
}
