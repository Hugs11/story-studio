//! Identity-only matching and a deterministic, reviewable merge plan.
use super::{
    import::{invalid, Conflict, ImportPreview, Unresolved},
    staging::Staged,
    Result,
};
use crate::services::catalogue::{
    data::{mutate::names, resolver::FIELDS},
    store::error,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn rows<'a>(doc: &'a Value, key: &str) -> &'a [Value] {
    doc[key].as_array().unwrap().as_slice()
}
/// Historical grouped cards cannot be assigned to any one of their UUIDs.
pub(super) fn mixed_uuid_cards(doc: &Value) -> BTreeSet<String> {
    let mut identities = BTreeMap::<&str, BTreeSet<&str>>::new();
    for row in rows(doc, "identities") {
        if let (Some(card), Some(uuid)) = (row["ficheId"].as_str(), row["packUuid"].as_str()) {
            identities.entry(card).or_default().insert(uuid);
        }
    }
    identities
        .into_iter()
        .filter(|(_, uuids)| uuids.len() > 1)
        .map(|(card, _)| card.to_owned())
        .collect()
}
/// Borrowed indexes built once for all card-related tables.
pub(super) struct Index<'a> {
    tables: BTreeMap<&'static str, BTreeMap<&'a str, Vec<&'a Value>>>,
    pub provenances: BTreeMap<&'a str, &'a Value>,
}
impl<'a> Index<'a> {
    pub fn new(doc: &'a Value) -> Self {
        let mut tables = BTreeMap::new();
        for table in [
            "identities",
            "associations",
            "corrections",
            "referenceValues",
            "references",
            "tagMembers",
        ] {
            let mut grouped = BTreeMap::<&str, Vec<&Value>>::new();
            for row in rows(doc, table) {
                if let Some(id) = row["ficheId"].as_str() {
                    grouped.entry(id).or_default().push(row);
                }
            }
            tables.insert(table, grouped);
        }
        Self {
            tables,
            provenances: rows(doc, "provenances")
                .iter()
                .filter_map(|p| Some((p["id"].as_str()?, p)))
                .collect(),
        }
    }
    pub fn card(&self, table: &str, id: &str) -> &[&'a Value] {
        self.tables
            .get(table)
            .and_then(|t| t.get(id))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn is_official(&self, row: &Value) -> bool {
        row["provenanceId"]
            .as_str()
            .and_then(|id| self.provenances.get(id))
            .is_some_and(|p| {
                p["kind"] == "lunii"
                    && p["language"]
                        .as_str()
                        .is_some_and(|l| row["language"] == format!("@lunii:{l}"))
            })
    }
}
pub(super) fn normalized_bundle(bundle: &Value) -> Value {
    let mut values = bundle["values"].as_array().into_iter().flatten().map(|r|
        json!({"field":r["field"],"language":r["language"],"value":r["value"],"imageSha256":r["imageSha256"]})).collect::<Vec<_>>();
    values.sort_by(|a, b| {
        (a["field"].as_str(), a["language"].as_str())
            .cmp(&(b["field"].as_str(), b["language"].as_str()))
    });
    let source = &bundle["source"];
    json!({"source":source.as_str().map(Value::from).unwrap_or_else(|| source["exemplarId"].clone()),"values":values})
}
pub(super) fn text<'a>(row: &'a Value, key: &str) -> Result<&'a str> {
    row[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)
}
pub(super) fn stable(parts: &[&str]) -> String {
    super::validate::payload(serde_json::to_string(parts).unwrap().as_bytes()).sha256
}
fn strings(v: &Value, level: usize, cancel: &std::sync::atomic::AtomicBool) -> Result<()> {
    super::export::check(cancel)?;
    if level > super::format::MAX_DEPTH {
        return Err(super::staging::limit());
    }
    match v {
        Value::String(s) if s.len() > 1024 * 1024 => return Err(super::staging::limit()),
        Value::Array(a) => {
            for v in a {
                strings(v, level + 1, cancel)?;
            }
        }
        Value::Object(o) => {
            for (k, v) in o {
                if k.len() > 4096 {
                    return Err(invalid());
                }
                strings(v, level + 1, cancel)?;
            }
        }
        _ => (),
    }
    Ok(())
}
#[cfg(test)]
pub(super) fn validate_document(doc: &Value) -> Result<()> {
    validate_cancellable(doc, &std::sync::atomic::AtomicBool::new(false))
}
pub(super) fn validate_cancellable(
    doc: &Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    text(doc, "originCatalogueId")?;
    strings(doc, 0, cancel)?;
    if let Some(retained) = doc.get("retainedImports").and_then(Value::as_array) {
        for document in retained {
            validate_cancellable(document, cancel)?;
        }
    }
    super::validate::document(doc).map_err(|e| {
        if e.code == crate::support::user_message::codes::CATALOG_BACKUP_ROW_LIMIT_EXCEEDED {
            super::staging::limit()
        } else {
            invalid()
        }
    })?;
    let index = Index::new(doc);
    let mut ids = BTreeMap::new();
    for table in ["cards", "tags", "provenances", "exemplarHints"] {
        let mut seen = BTreeSet::new();
        for row in rows(doc, table) {
            super::export::check(cancel)?;
            let id = text(row, "id")?;
            if !seen.insert(id.to_string()) {
                return Err(invalid());
            }
            if table == "tags" {
                names::label(text(row, "label")?).map_err(|_| invalid())?;
            }
            if table == "cards"
                && (!matches!(row["favorite"].as_i64(), Some(0 | 1))
                    || row["createdAt"].as_i64().is_none())
            {
                return Err(invalid());
            }
            if table == "cards" {
                if let Some(reference) = row.get("importedReference").filter(|v| !v.is_null()) {
                    text(reference, "ficheId")?;
                    text(reference, "exemplarId")?;
                    if reference["selectedAt"].as_i64().is_none()
                        || reference["revision"].as_i64().is_none()
                    {
                        return Err(invalid());
                    }
                }
            }
            if table == "provenances"
                && !matches!(
                    row["kind"].as_str(),
                    Some("file" | "project" | "filename" | "manual" | "web" | "import" | "lunii")
                )
            {
                return Err(invalid());
            }
        }
        ids.insert(table, seen);
    }
    for (table, fields) in [
        ("identities", vec!["packUuid"]),
        ("references", vec!["ficheId"]),
        ("corrections", vec!["ficheId", "field", "language"]),
        ("referenceValues", vec!["ficheId", "field", "language"]),
        ("tagMembers", vec!["tagId", "ficheId"]),
        ("associations", vec!["ficheId"]),
        ("forgottenCards", vec!["ficheId"]),
        ("suggestionDecisions", vec!["key"]),
        ("pendingAssociations", vec!["exemplarId"]),
    ] {
        let mut seen = BTreeSet::new();
        for row in rows(doc, table) {
            super::export::check(cancel)?;
            let mut key = Vec::new();
            for field in &fields {
                key.push(row[*field].as_str().ok_or_else(invalid)?);
            }
            if !seen.insert(key) {
                return Err(invalid());
            }
        }
    }
    for table in [
        "identities",
        "references",
        "corrections",
        "referenceValues",
        "tagMembers",
        "associations",
        "forgottenCards",
        "exemplarHints",
    ] {
        for row in rows(doc, table) {
            super::export::check(cancel)?;
            if !ids["cards"].contains(text(row, "ficheId")?) {
                return Err(invalid());
            }
            if table == "identities" {
                let uuid = text(row, "packUuid")?;
                if uuid::Uuid::parse_str(uuid)
                    .map_err(|_| invalid())?
                    .to_string()
                    != uuid
                {
                    return Err(invalid());
                }
            }
            if table == "associations" && !ids["cards"].contains(text(row, "targetId")?) {
                return Err(invalid());
            }
            if table == "tagMembers" && !ids["tags"].contains(text(row, "tagId")?) {
                return Err(invalid());
            }
            if table == "references" && !ids["exemplarHints"].contains(text(row, "exemplarId")?) {
                return Err(invalid());
            }
            if ["corrections", "referenceValues"].contains(&table) {
                if !FIELDS.contains(&text(row, "field")?)
                    || !ids["provenances"].contains(text(row, "provenanceId")?)
                {
                    return Err(invalid());
                }
                let language = row["language"].as_str().ok_or_else(invalid)?;
                if language.len() > 64 || language.chars().any(char::is_control) {
                    return Err(invalid());
                }
                let field = text(row, "field")?;
                let lunii = table == "referenceValues" && index.is_official(row);
                let official_provenance =
                    index.provenances[text(row, "provenanceId")?]["kind"] == "lunii";
                if (language.starts_with("@lunii:") || official_provenance) && !lunii {
                    return Err(invalid());
                }
                if field != "cover" {
                    let state = if table == "corrections" {
                        text(row, "state")?
                    } else {
                        "defined"
                    };
                    let change = crate::services::catalogue::data::mutate::metadata::Change {
                        field: field.into(),
                        language: if lunii
                            || language.is_empty()
                            || !matches!(field, "title" | "description" | "keywords" | "bonus")
                        {
                            None
                        } else {
                            Some(language.into())
                        },
                        state: state.into(),
                        value: if row["value"].is_null() {
                            None
                        } else {
                            Some(row["value"].clone())
                        },
                        cover_staging_id: None,
                    };
                    crate::services::catalogue::data::mutate::metadata::validate(&change)
                        .map_err(|_| invalid())?;
                } else if (table == "referenceValues" || row["state"] == "defined")
                    && row["imageSha256"].as_str().is_none()
                    && !(lunii && crate::services::catalogue::lunii_db::valid_cover(&row["value"]))
                {
                    return Err(invalid());
                }
                if let Some(sha) = row["imageSha256"].as_str() {
                    if !super::validate::hash(sha) {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    Ok(())
}
#[derive(Clone)]
pub(super) struct Action {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub incoming: Value,
    pub local: Option<Value>,
}
pub(super) struct ForgetIntent {
    pub target: String,
    pub conflict_id: Option<String>,
}
pub(super) struct Plan {
    pub cards: BTreeMap<String, String>,
    pub labels: BTreeMap<(String, String), String>,
    pub actions: Vec<Action>,
    pub forget_intents: Vec<ForgetIntent>,
    pub preview: ImportPreview,
    pub pending: BTreeMap<String, String>,

    pub titles: BTreeMap<String, String>,
}
fn imported(c: &Connection, origin: &str, kind: &str, id: &str) -> Result<Option<String>> {
    c.query_row("SELECT local_entity_id FROM import_identity WHERE origin_catalogue_id=?1 AND entity_type=?2 AND origin_entity_id=?3",[origin,kind,id],|r|r.get(0)).optional().map_err(error)
}
/// Local forgetting refuses covered fiches and never accepts group members:
/// such a conflict must not follow the global choice.
pub(super) fn forgettable(covered: &BTreeSet<String>, target: &str, data_target: &str) -> bool {
    target == data_target && !covered.contains(data_target)
}
impl Plan {
    /// Title used to name a fiche in a refusal, or its local identifier.
    pub(super) fn label(&self, target: &str) -> String {
        self.titles
            .get(target)
            .cloned()
            .unwrap_or_else(|| target.to_owned())
    }
    pub(super) fn action(
        &mut self,
        kind: &str,
        target: &str,
        incoming: Value,
        local: Option<Value>,
        key: &str,
    ) {
        let id = stable(&[kind, target, key]);
        if matches!(kind, "forgotten" | "pendingForgotten") {
            // An unchanged marker still requires purging any data merged later.
            self.forget_intents.push(ForgetIntent {
                target: target.into(),
                conflict_id: local
                    .as_ref()
                    .filter(|value| *value != &incoming)
                    .map(|_| id.clone()),
            });
        }
        if local.as_ref() == Some(&incoming)
            || (kind.ends_with("ReferenceBundle") || kind == "referenceBundle")
                && local
                    .as_ref()
                    .is_some_and(|v| normalized_bundle(v) == normalized_bundle(&incoming))
        {
            return;
        }
        let view = json!({"id":id,"target":target,"kind":kind,"incoming":incoming});
        if let Some(ref local) = local {
            self.preview.changes.push(view);
            self.preview.conflicts.push(Conflict {
                id: id.clone(),
                target: json!({"kind":kind,"id":target,"key":key}),
                local: local.clone(),
                incoming: incoming.clone(),
                default_choice: "local".into(),
            });
        } else {
            self.preview.additions.push(view);
        }
        self.actions.push(Action {
            id,
            kind: kind.into(),
            target: target.into(),
            incoming,
            local,
        });
    }
}
#[cfg(test)]
pub(super) fn plan(
    c: &Connection,
    staged: &Staged,
    preview_id: &str,
    associations: &BTreeMap<String, String>,
) -> Result<Plan> {
    plan_cancellable(
        c,
        staged,
        preview_id,
        associations,
        &std::sync::atomic::AtomicBool::new(false),
    )
}
pub(super) fn plan_cancellable(
    c: &Connection,
    staged: &Staged,
    preview_id: &str,
    associations: &BTreeMap<String, String>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Plan> {
    let doc = &staged.document;
    let origin = text(doc, "originCatalogueId")?;
    let index = Index::new(doc);
    let revision = c
        .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
        .map_err(error)?;
    let mut plan = Plan {
        cards: BTreeMap::new(),
        labels: BTreeMap::new(),
        actions: Vec::new(),
        forget_intents: Vec::new(),
        pending: BTreeMap::new(),

        titles: BTreeMap::new(),
        preview: ImportPreview {
            preview_id: preview_id.into(),
            format_version: super::format::VERSION,
            backup_digest: staged.digest.clone(),
            expected_catalogue_revision: revision,
            additions: vec![],
            changes: vec![],
            conflicts: vec![],
            unresolved: vec![],
            counts: staged.manifest.counts.clone(),
            issues: vec![],
        },
    };
    let mut used_targets = BTreeSet::new();
    for card in rows(doc, "cards") {
        super::export::check(cancel)?;
        let id = text(card, "id")?;
        let mut uuids: Vec<_> = index
            .card("identities", id)
            .iter()
            .map(|i| text(i, "packUuid"))
            .collect::<Result<_>>()?;
        let mut matches = BTreeSet::new();
        // Keep mixed historical cards source-less and independent. Their
        // identities remain portable evidence, never an automatic association.
        let mixed = uuids.len() > 1;
        if mixed {
            if associations.contains_key(id) {
                return Err(super::import::association_invalid());
            }
            uuids.clear();
        }
        for uuid in &uuids {
            let found: Option<String> = c
                .query_row(
                    "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
                    [uuid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error)?;
            if let Some(found) = found {
                matches.insert(found);
            }
        }
        let mut previous = imported(c, origin, "card", id)?;
        if previous.is_none() && matches.is_empty() {
            let mut saved = BTreeSet::new();
            for uuid in &uuids {
                if let Some(id) = c
                    .query_row(
                        "SELECT fiche_id FROM saved_pack_identity WHERE pack_uuid=?1",
                        [uuid],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(error)?
                {
                    saved.insert(id);
                }
            }
            if saved.len() == 1 {
                previous = saved.first().cloned();
            }
        }
        if !index.card("associations", id).is_empty() {
            if let Some(member) = imported(c, origin, "groupMember", id)? {
                let valid: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM fiche_grouping WHERE fiche_id=?1)",
                        [&member],
                        |r| r.get(0),
                    )
                    .map_err(error)?;
                if valid {
                    previous = Some(member);
                }
            }
        }
        let associated = associations.get(id);
        if let Some(target) = associated {
            let exists: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM fiche WHERE id=?1)",
                    [target],
                    |r| r.get(0),
                )
                .map_err(error)?;
            let mut identities = uuids
                .iter()
                .map(|uuid| uuid.to_string())
                .collect::<BTreeSet<_>>();
            let local = c.prepare("SELECT pack_uuid FROM pack_identity WHERE fiche_id=?1 UNION SELECT pack_uuid FROM saved_pack_identity WHERE fiche_id=?1 UNION SELECT verified_uuid FROM exemplar WHERE fiche_id=?1 AND verified_uuid IS NOT NULL").map_err(error)?.query_map([target], |r| r.get::<_,String>(0)).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
            identities.extend(local);
            if !exists
                || identities.len() > 1
                || super::relations::canonical(c, target)? != *target
                || matches.len() == 1 && !matches.contains(target)
            {
                return Err(super::import::association_invalid());
            }
        }
        let previous_is_group = if let Some(member) = previous.as_ref() {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM fiche_grouping WHERE fiche_id=?1)",
                [member],
                |r| r.get::<_, bool>(0),
            )
            .map_err(error)?
        } else {
            false
        };
        let target = if let Some(target) = associated {
            target.clone()
        } else if previous_is_group {
            previous.clone().unwrap()
        } else if matches.len() == 1 {
            matches.first().unwrap().clone()
        } else if matches.is_empty() {
            previous
                .clone()
                .unwrap_or_else(|| format!("import-{}", stable(&[origin, "card", id])))
        } else {
            format!("import-{}", stable(&[origin, "card", id]))
        };
        if let Some(old) = previous.filter(|old| old != &target) {
            if c.query_row("SELECT EXISTS(SELECT 1 FROM exemplar WHERE fiche_id=?1 UNION SELECT 1 FROM pack_identity WHERE fiche_id=?1 UNION SELECT 1 FROM fiche_grouping WHERE fiche_id=?1)",[&old],|r|r.get::<_,bool>(0)).map_err(error)? {return Err(super::import::association_invalid());}
            plan.pending.insert(old, target.clone());
        }
        let title = index
            .card("corrections", id)
            .iter()
            .chain(index.card("referenceValues", id))
            .find(|r| r["field"] == "title" && r["value"].is_string())
            .and_then(|r| r["value"].as_str())
            .map(String::from);
        if let Some(title) = title {
            plan.titles.insert(target.clone(), title);
        }
        if matches.len() != 1 && associated.is_none() && !previous_is_group {
            plan.preview.unresolved.push(Unresolved {
                id: id.into(),
                label: plan.titles.get(&target).cloned(),
                identity: uuids.first().map(|s| s.to_string()),
                reason: if mixed || matches.len() > 1 {
                    "ambiguousIdentity"
                } else if uuids.is_empty() {
                    "missingIdentity"
                } else {
                    "identityNotFound"
                }
                .into(),
                reference: None,
            });
        }
        let data_target = super::relations::canonical(c, &target)?;
        let local: Option<i64> = c
            .query_row(
                "SELECT favorite FROM fiche WHERE id=?1",
                [&data_target],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        plan.action(
            "favorite",
            &target,
            card["favorite"].clone(),
            local.map(|v| json!(v)),
            "",
        );
        if !used_targets.insert(target.clone()) {
            return Err(super::import::association_invalid());
        }
        plan.cards.insert(id.into(), target);
    }
    if associations.keys().any(|id| !plan.cards.contains_key(id))
        || associations.values().collect::<BTreeSet<_>>().len() != associations.len()
    {
        return Err(super::import::association_invalid());
    }
    let mut incoming_labels = BTreeMap::<(String, String), String>::new();
    let (table, singular) = ("tags", "tag");
    for row in rows(doc, table) {
        super::export::check(cancel)?;
        let id = text(row, "id")?;
        let (label, key) = names::label(text(row, "label")?)?;
        let existing: Option<String> = c
            .query_row(
                "SELECT id FROM tag WHERE normalized_label=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if let Some(target) = incoming_labels.get(&(singular.into(), key.clone())) {
            plan.labels
                .insert((singular.into(), id.into()), target.clone());
            continue;
        }
        let previous = imported(c, origin, singular, id)?;
        let target = previous
            .or(existing)
            .unwrap_or_else(|| format!("import-{}", stable(&[origin, singular, id])));
        incoming_labels.insert((singular.into(), key.clone()), target.clone());
        let local: Option<String> = c
            .query_row("SELECT label FROM tag WHERE id=?1", [&target], |r| r.get(0))
            .optional()
            .map_err(error)?;
        plan.titles.insert(target.clone(), label.clone());
        plan.action(
            singular,
            &target,
            json!(label),
            local.map(|v| json!(v)),
            &key,
        );
        plan.labels.insert((singular.into(), id.into()), target);
    }

    for table in ["corrections"] {
        for row in rows(doc, table) {
            super::export::check(cancel)?;
            let target = plan.cards[text(row, "ficheId")?].clone();
            let field = text(row, "field")?;
            let language = row["language"].as_str().unwrap();
            let sql = if table == "corrections" {
                "SELECT json_object('field',field,'language',language,'state',state,'value',json(value_json),'imageSha256',image_sha256) FROM correction WHERE fiche_id=?1 AND field=?2 AND language=?3"
            } else {
                "SELECT json_object('field',field,'language',language,'value',json(value_json),'imageSha256',image_sha256) FROM reference_value WHERE fiche_id=?1 AND field=?2 AND language=?3"
            };
            let data_target = super::relations::canonical(c, &target)?;
            let raw: Option<String> = c
                .query_row(sql, [&data_target, field, language], |r| r.get(0))
                .optional()
                .map_err(error)?;
            let local = raw
                .map(|s| serde_json::from_str::<Value>(&s))
                .transpose()
                .map_err(error)?;
            let mut incoming = json!({"field":field,"language":language,"value":row["value"],"imageSha256":row["imageSha256"]});
            if table == "corrections" {
                incoming["state"] = row["state"].clone();
            }
            // Provenance is kept with the operation but excluded from value equality.
            plan.action(
                table,
                &target,
                incoming,
                local,
                &format!("{field}:{language}"),
            );
        }
    }
    let mut equivalent_references = BTreeSet::new();
    let local_origin: String = c
        .query_row("SELECT id FROM catalogue", [], |r| r.get(0))
        .map_err(error)?;
    for card in rows(doc, "cards") {
        super::export::check(cancel)?;
        let id = text(card, "id")?;
        let target = plan.cards[id].clone();
        let data_target = super::relations::canonical(c, &target)?;
        let mut values = index
            .card("referenceValues", id)
            .iter()
            .map(|r| (*r).clone())
            .collect::<Vec<_>>();
        let is_lunii = |row: &Value| index.is_official(row);
        let official = values
            .iter()
            .filter(|r| is_lunii(r))
            .cloned()
            .collect::<Vec<_>>();
        if !official.is_empty() {
            let existing: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii')", [&data_target], |r| r.get(0)).map_err(error)?;
            if !existing {
                for row in official {
                    let key = format!(
                        "{}:{}",
                        row["field"].as_str().unwrap(),
                        row["language"].as_str().unwrap()
                    );
                    plan.action("referenceValues", &target, row, None, &key);
                }
            }
            values.retain(|r| !is_lunii(r));
        }
        let source = index
            .card("references", id)
            .first()
            .map(|r| (*r).clone())
            .or_else(|| card.get("importedReference").cloned());
        if !values.is_empty() || source.is_some() {
            let mut statement=c.prepare("SELECT field,language,value_json,provenance_id,image_sha256 FROM reference_value WHERE fiche_id=?1 AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.id=reference_value.provenance_id AND p.kind='lunii') ORDER BY field,language").map_err(error)?;
            let local_values=statement.query_map([&data_target],|r|Ok(json!({"field":r.get::<_,String>(0)?,"language":r.get::<_,String>(1)?,"value":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"provenanceId":r.get::<_,String>(3)?,"imageSha256":r.get::<_,Option<String>>(4)?}))).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
            let local_source: Option<String> = c
                .query_row(
                    "SELECT exemplar_id FROM reference_source WHERE fiche_id=?1",
                    [&data_target],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error)?;
            let imported_source: Option<String> = c
                .query_row(
                    "SELECT reference_json FROM import_reference WHERE fiche_id=?1",
                    [&data_target],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error)?;
            let source_value = imported_source
                .as_ref()
                .map(|raw| serde_json::from_str::<Value>(raw).map_err(error))
                .transpose()?
                .or_else(|| local_source.clone().map(Value::String));
            let local =
                if local_values.is_empty() && local_source.is_none() && imported_source.is_none() {
                    None
                } else {
                    Some(json!({"source":source_value,"values":local_values}))
                };
            let incoming_exemplar = source.as_ref().and_then(|s| s["exemplarId"].as_str());
            let available = origin == local_origin
                && incoming_exemplar.is_some_and(|ex| {
                    c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM exemplar WHERE id=?1 AND fiche_id=?2)",
                        [ex, &data_target],
                        |r| r.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
                });
            let incoming = json!({"source":source.clone(),"values":values});
            // Exemplar identifiers are per catalogue: after a reinstall and a new
            // scan, the active local reference with the same values is the same
            // reference. Only another available local exemplar is a real choice.
            let equivalent = local_source.is_some()
                && imported_source.is_none()
                && (!available || incoming_exemplar == local_source.as_deref())
                && local.as_ref().is_some_and(|local| {
                    normalized_bundle(local)["values"] == normalized_bundle(&incoming)["values"]
                });
            if equivalent {
                equivalent_references.insert(id.to_owned());
                continue;
            }
            let before = plan.preview.conflicts.len();
            plan.action("referenceBundle", &target, incoming, local, "");
            if plan.preview.conflicts.len() > before && local_source.is_some() && !available {
                plan.preview.conflicts.last_mut().unwrap().target["requiresIndividualChoice"] =
                    json!(true);
            }
        }
    }
    let covered = if rows(doc, "forgottenCards").is_empty() && plan.pending.is_empty() {
        BTreeSet::new()
    } else {
        crate::services::catalogue::data::mutate::forget::covered(c).map_err(error)?
    };
    for row in rows(doc, "forgottenCards") {
        let target = plan.cards[text(row, "ficheId")?].clone();
        let data_target = super::relations::canonical(c, &target)?;
        let local:Option<bool>=c.query_row("SELECT EXISTS(SELECT 1 FROM fiche_forgotten WHERE fiche_id=?1) FROM fiche WHERE id=?1",[&data_target],|r|r.get(0)).optional().map_err(error)?;
        let before = plan.preview.conflicts.len();
        plan.action(
            "forgotten",
            &target,
            json!(true),
            local.map(|v| json!(v)),
            "",
        );
        if plan.preview.conflicts.len() > before && !forgettable(&covered, &target, &data_target) {
            plan.preview.conflicts.last_mut().unwrap().target["requiresIndividualChoice"] =
                json!(true);
            plan.preview.conflicts.last_mut().unwrap().target["individualChoiceReason"] =
                json!("forgetRefused");
        }
    }
    let imported_references = rows(doc, "cards")
        .iter()
        .filter_map(|card| {
            card.get("importedReference")
                .map(|reference| json!({"ficheId":card["id"],"source":reference}))
        })
        .collect::<Vec<_>>();
    for reference in rows(doc, "references")
        .iter()
        .chain(imported_references.iter())
    {
        if equivalent_references.contains(text(reference, "ficheId")?) {
            continue;
        }
        plan.preview.unresolved.push(Unresolved {
            id: format!("reference:{}", text(reference, "ficheId")?),
            label: plan
                .titles
                .get(&plan.cards[text(reference, "ficheId")?])
                .cloned(),
            identity: None,
            reason: "referenceUnavailable".into(),
            reference: Some(reference.clone()),
        });
    }
    let mut memberships = BTreeMap::<(String, String), BTreeSet<String>>::new();
    let (table, kind) = ("tagMembers", "tag");
    for row in rows(doc, table) {
        super::export::check(cancel)?;
        let target = super::relations::canonical(c, &plan.cards[text(row, "ficheId")?])?;
        let label = &plan.labels[&(kind.into(), text(row, "tagId")?.into())];
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tag_member WHERE tag_id=?1 AND fiche_id=?2)",
                [label, &target],
                |r| r.get(0),
            )
            .map_err(error)?;
        if !exists {
            memberships
                .entry((kind.into(), label.clone()))
                .or_default()
                .insert(target);
        }
    }

    for ((kind, label), cards) in memberships {
        plan.preview.additions.push(json!({"id":stable(&["membership",&kind,&label]),"kind":"membership","target":label,"incoming":{"kind":kind,"id":label,"label":plan.titles.get(&label),"count":cards.len(),"ficheIds":cards}}));
    }
    for (old, target) in &plan.pending {
        plan.preview.changes.push(json!({"id":stable(&["reconcile",old,target]),"kind":"reconcile","target":target,"incoming":{"from":old,"to":target}}));
    }
    super::reconcile::prepare(c, &mut plan, &covered, cancel)?;
    super::relations::prepare(c, doc, &mut plan, cancel)?;
    for target in plan.cards.values() {
        if !plan.titles.contains_key(target) {
            let canonical = super::relations::canonical(c, target)?;
            let raw:Option<String>=c.query_row("SELECT value_json FROM correction WHERE fiche_id=?1 AND field='title' AND state='defined' UNION ALL SELECT value_json FROM reference_value WHERE fiche_id=?1 AND field='title' LIMIT 1",[&canonical],|r|r.get(0)).optional().map_err(error)?;
            if let Some(title) = raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.as_str().map(String::from))
            {
                plan.titles.insert(target.clone(), title);
            }
        }
    }
    super::ages::prepare(c, doc, &mut plan, cancel)?;
    for view in plan
        .preview
        .additions
        .iter_mut()
        .chain(&mut plan.preview.changes)
    {
        if let Some(title) = view["target"].as_str().and_then(|id| plan.titles.get(id)) {
            view["label"] = json!(title);
        }
    }
    let mut target_identities = BTreeMap::new();
    for row in rows(doc, "identities") {
        target_identities
            .entry(plan.cards[text(row, "ficheId")?].clone())
            .or_insert(row["packUuid"].clone());
    }
    for conflict in &mut plan.preview.conflicts {
        if let Some(id) = conflict.target["id"].as_str() {
            if let Some(uuid) = target_identities.get(id) {
                conflict.target["identity"] = uuid.clone();
            }
        }
        if let Some(id) = conflict.target["id"].as_str().map(String::from) {
            if let Some(title) = plan.titles.get(&id) {
                conflict.target["label"] = json!(title);
            }
            let current = super::relations::canonical(c, &id)?;
            let locator:Option<String>=c.query_row("SELECT json_extract(anchor_json,'$.path') FROM exemplar WHERE fiche_id=?1 ORDER BY id LIMIT 1",[&current],|r|r.get(0)).optional().map_err(error)?.flatten();
            if let Some(path) = locator {
                conflict.target["locator"] = json!(path);
            }
        }
    }
    if doc.get("retainedImports").is_some() {
        plan.preview.issues.push("retained:imports".into());
    }
    Ok(plan)
}
