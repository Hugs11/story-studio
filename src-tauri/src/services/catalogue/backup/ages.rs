//! Age corrections are reviewed together, so mixed choices cannot invert bounds.
//! Bounds are simulated with the shared resolver: only an invalid default
//! refuses the preview; a risky alternative requires an individual choice.
use super::{
    matching::{rows, text, Action, Plan},
    Result,
};
use crate::services::catalogue::{
    data::resolver::{self, Correction, Corrections, References},
    store::error,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
const AGES: [&str; 2] = ["ageMin", "ageMax"];
pub(super) fn prepare(
    c: &Connection,
    doc: &Value,
    plan: &mut Plan,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let mut groups = BTreeMap::<(String, String), Vec<usize>>::new();
    let mut additions = BTreeMap::<String, BTreeMap<String, Value>>::new();
    for (i, a) in plan.actions.iter().enumerate() {
        super::export::check(cancel)?;
        if matches!(a.kind.as_str(), "corrections" | "pendingCorrections")
            && matches!(a.incoming["field"].as_str(), Some("ageMin" | "ageMax"))
        {
            if a.kind == "pendingCorrections" && a.local.is_none() {
                // This waiting value is an unconditional transfer, even if
                // the other bound already exists. Keep it before archive choices.
                let mut row = a.incoming.clone();
                row.as_object_mut().unwrap().remove("provenanceId");
                additions
                    .entry(a.target.clone())
                    .or_default()
                    .insert(a.incoming["field"].as_str().unwrap().into(), row);
            } else {
                groups
                    .entry((a.kind.clone(), a.target.clone()))
                    .or_default()
                    .push(i);
            }
        }
    }
    // Reconciliation transfers precede archive writes, including when the
    // user explicitly chooses an incoming archive value afterwards.
    let mut groups = groups.into_iter().collect::<Vec<_>>();
    groups.sort_by_key(|(_, indices)| indices[0]);
    let sources = rows(doc, "corrections")
        .iter()
        .filter(|r| matches!(r["field"].as_str(), Some("ageMin" | "ageMax")))
        .map(|r| {
            (
                (
                    plan.cards[text(r, "ficheId").unwrap()].clone(),
                    r["field"].as_str().unwrap(),
                ),
                r,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut removed = BTreeSet::new();
    let mut locals = BTreeMap::new();
    for ((kind, target), indices) in groups {
        super::export::check(cancel)?;
        let canonical = super::relations::canonical(c, &target)?;
        let mut local = json!({});
        for field in ["ageMin", "ageMax"] {
            let raw:Option<String>=c.query_row("SELECT json_object('field',field,'language',language,'state',state,'value',json(value_json),'imageSha256',image_sha256) FROM correction WHERE fiche_id=?1 AND field=?2 AND language=''",[&canonical,field],|r|r.get(0)).optional().map_err(error)?;
            local[field] = raw
                .map(|r| serde_json::from_str::<Value>(&r))
                .transpose()
                .map_err(error)?
                .unwrap_or(Value::Null);
        }
        if let Some(additions) = additions.get(&target) {
            for (field, row) in additions {
                local[field] = row.clone();
            }
        }
        let has_local = indices.iter().any(|&i| plan.actions[i].local.is_some());
        // Reconcile has already resolved the local side, possibly from a
        // waiting card. Reading the target alone would lose that local value.
        for &i in &indices {
            let action = &plan.actions[i];
            if let Some(row) = &action.local {
                local[action.incoming["field"].as_str().unwrap()] = row.clone();
            }
        }
        let mut incoming = local.clone();
        let mut writes = vec![];
        for i in indices {
            let a = &plan.actions[i];
            incoming[a.incoming["field"].as_str().unwrap()] = a.incoming.clone();
            removed.insert(a.id.clone());
            let mut row = a.incoming.clone();
            if kind == "corrections" {
                row["provenanceId"] = sources[&(target.clone(), row["field"].as_str().unwrap())]
                    ["provenanceId"]
                    .clone();
            }
            writes.push(row);
        }
        let before = plan.actions.len();
        plan.action(
            if kind == "corrections" {
                "ageRange"
            } else {
                "pendingAgeRange"
            },
            &target,
            incoming,
            has_local.then(|| local.clone()),
            "",
        );
        if plan.actions.len() > before {
            let action = plan.actions.last_mut().unwrap();
            action.incoming["writes"] = json!(writes);
            if !has_local {
                locals.insert(action.id.clone(), local);
            }
        }
    }
    plan.actions.retain(|a| !removed.contains(&a.id));
    plan.preview.conflicts.retain(|a| !removed.contains(&a.id));
    plan.preview
        .additions
        .retain(|a| !a["id"].as_str().is_some_and(|id| removed.contains(id)));
    plan.preview
        .changes
        .retain(|a| !a["id"].as_str().is_some_and(|id| removed.contains(id)));
    check(c, plan, &locals, cancel)
}

/// The inputs of the shared resolver that can produce an age bound.
#[derive(Clone)]
struct Ages {
    corrections: Corrections,
    references: References,
    /// Official rows: field, stored language, value and provenance language.
    lunii: Vec<(String, String, Value, Option<String>)>,
    locale: String,
}
impl Ages {
    fn load(c: &Connection, id: &str) -> Result<Self> {
        let corrections = c
            .prepare("SELECT field,language,state,value_json FROM correction WHERE fiche_id=?1 AND field IN ('ageMin','ageMax')")
            .map_err(error)?
            .query_map([id], |r| {
                let raw: Option<String> = r.get(3)?;
                Ok((
                    (r.get(0)?, r.get(1)?),
                    Correction {
                        state: r.get(2)?,
                        value: raw.map(|raw| serde_json::from_str(&raw).unwrap_or(Value::Null)),
                    },
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Corrections>>()
            .map_err(error)?;
        let references = c
            .prepare("SELECT v.field,v.language,v.value_json,v.provenance_id FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind!='lunii' AND v.field IN ('ageMin','ageMax')")
            .map_err(error)?
            .query_map([id], |r| {
                Ok((
                    (r.get(0)?, r.get(1)?),
                    (
                        serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
                        r.get(3)?,
                    ),
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<References>>()
            .map_err(error)?;
        let lunii = c
            .prepare("SELECT v.field,v.language,v.value_json,p.language FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND p.kind='lunii'")
            .map_err(error)?
            .query_map([id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
                    r.get(3)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        let locale = c
            .query_row("SELECT locale FROM lunii_context WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(error)?
            .unwrap_or_default();
        Ok(Self {
            corrections,
            references,
            lunii,
            locale,
        })
    }
    fn correct(&mut self, row: &Value) -> Result<()> {
        let field = text(row, "field")?;
        if AGES.contains(&field) {
            self.corrections.insert(
                (field.into(), row["language"].as_str().unwrap_or("").into()),
                Correction {
                    state: text(row, "state")?.into(),
                    value: (!row["value"].is_null()).then(|| row["value"].clone()),
                },
            );
        }
        Ok(())
    }
    /// Mirror of the writes in `merge::apply` for the same action.
    fn apply(&mut self, action: &Action) -> Result<()> {
        let value = &action.incoming;
        match action.kind.as_str() {
            "ageRange" | "pendingAgeRange" => {
                for row in value["writes"]
                    .as_array()
                    .ok_or_else(super::import::invalid)?
                {
                    self.correct(row)?;
                }
            }
            "pendingCorrections" => self.correct(value)?,
            // A bundle replaces every non-official reference value.
            "referenceBundle" | "pendingReferenceBundle" => {
                self.references = References::new();
                for row in value["values"].as_array().into_iter().flatten() {
                    let field = text(row, "field")?;
                    if AGES.contains(&field) {
                        self.references.insert(
                            (field.into(), row["language"].as_str().unwrap_or("").into()),
                            (
                                row["value"].clone(),
                                row["provenanceId"].as_str().unwrap_or("").into(),
                            ),
                        );
                    }
                }
            }
            "referenceValues" | "pendingLuniiValue" => {
                let language = text(value, "language")?;
                self.lunii.push((
                    text(value, "field")?.into(),
                    language.into(),
                    value["value"].clone(),
                    language.strip_prefix("@lunii:").map(String::from),
                ));
            }
            _ => {}
        }
        Ok(())
    }
    /// Same selection as `lunii_db::values`, then the shared resolver, then the
    /// same comparison as `metadata::age_interval_valid` at application.
    fn valid(&self) -> bool {
        let mut rows = self.lunii.iter().collect::<Vec<_>>();
        rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        let infos = rows
            .iter()
            .filter_map(|row| row.3.clone())
            .map(|language| (language, json!({})))
            .collect::<Map<_, _>>();
        let chosen = crate::services::catalogue::lunii_db::parse::localized(
            &json!({ "localized_infos": infos }),
            &self.locale,
        )
        .map(|v| v.0);
        let mut lunii = Map::new();
        for (field, _, value, language) in rows {
            if field != "cover" && *language != chosen {
                continue;
            }
            lunii.entry(field.clone()).or_insert(value.clone());
        }
        let r = resolver::resolve_with_lunii(
            self.references.clone(),
            self.corrections.clone(),
            &[],
            lunii,
            chosen,
        );
        !matches!(
            (
                r.values.get("ageMin").and_then(Value::as_u64),
                r.values.get("ageMax").and_then(Value::as_u64),
            ),
            (Some(min), Some(max)) if min > max
        )
    }
}
fn touches_ages(action: &Action) -> bool {
    match action.kind.as_str() {
        "ageRange" | "pendingAgeRange" => true,
        "pendingCorrections" | "referenceValues" | "pendingLuniiValue" => {
            AGES.contains(&action.incoming["field"].as_str().unwrap_or(""))
        }
        // Removing a bound never inverts an interval: only age values matter.
        "referenceBundle" | "pendingReferenceBundle" => action.incoming["values"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| AGES.contains(&row["field"].as_str().unwrap_or(""))),
        _ => false,
    }
}
/// Bounds after the default choices (additions applied, conflicts local) plus
/// the conflicts that `incoming` selects.
fn simulate(
    base: &Ages,
    plan: &Plan,
    indices: &[usize],
    incoming: &dyn Fn(&Action) -> bool,
) -> Result<bool> {
    let mut state = base.clone();
    for &i in indices {
        let action = &plan.actions[i];
        if action.local.is_none() || incoming(action) {
            state.apply(action)?;
        }
    }
    Ok(state.valid())
}
/// Turn an addition into a conflict whose default keeps `local`.
fn to_conflict(plan: &mut Plan, i: usize, local: Value) {
    let action = &mut plan.actions[i];
    action.local = Some(local.clone());
    let mut incoming = action.incoming.clone();
    if let Some(object) = incoming.as_object_mut() {
        object.remove("writes");
    }
    let id = action.id.clone();
    // Same key as `matching` gives a single official value.
    let key = match action.kind.as_str() {
        "referenceValues" | "pendingLuniiValue" => format!(
            "{}:{}",
            action.incoming["field"].as_str().unwrap_or(""),
            action.incoming["language"].as_str().unwrap_or("")
        ),
        _ => String::new(),
    };
    plan.preview.conflicts.push(super::import::Conflict {
        id: id.clone(),
        target: json!({"kind":action.kind,"id":action.target,"key":key}),
        local,
        incoming,
        default_choice: "local".into(),
    });
    if let Some(at) = plan.preview.additions.iter().position(|a| a["id"] == id) {
        let view = plan.preview.additions.remove(at);
        plan.preview.changes.push(view);
    }
}
fn check(
    c: &Connection,
    plan: &mut Plan,
    locals: &BTreeMap<String, Value>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let mut targets = BTreeMap::<String, (bool, Vec<usize>)>::new();
    for (i, action) in plan.actions.iter().enumerate() {
        super::export::check(cancel)?;
        if matches!(
            action.kind.as_str(),
            "ageRange"
                | "pendingAgeRange"
                | "pendingCorrections"
                | "referenceBundle"
                | "pendingReferenceBundle"
                | "referenceValues"
                | "pendingLuniiValue"
        ) {
            let canonical = super::relations::canonical(c, &action.target)?;
            let entry = targets.entry(canonical).or_default();
            entry.0 |= touches_ages(action);
            entry.1.push(i);
        }
    }
    for (canonical, (relevant, indices)) in targets {
        super::export::check(cancel)?;
        if !relevant {
            continue;
        }
        let base = Ages::load(c, &canonical)?;
        let label = plan.label(&plan.actions[indices[0]].target);
        if !simulate(&base, plan, &indices, &|_| false)? {
            // An incoming age addition against a local bound becomes a single
            // conflict that keeps the local bounds by default.
            for &i in &indices {
                if let Some(local) = locals.get(&plan.actions[i].id) {
                    to_conflict(plan, i, local.clone());
                }
            }
        }
        if !simulate(&base, plan, &indices, &|_| false)? {
            // So does a reference or official value added where the card has
            // none: the local side is the absence of that value.
            for &i in &indices {
                let action = &plan.actions[i];
                if action.local.is_none()
                    && matches!(
                        action.kind.as_str(),
                        "referenceBundle"
                            | "pendingReferenceBundle"
                            | "referenceValues"
                            | "pendingLuniiValue"
                    )
                    && touches_ages(action)
                {
                    to_conflict(plan, i, Value::Null);
                }
            }
            if !simulate(&base, plan, &indices, &|_| false)? {
                return Err(
                    UserMessage::new(codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT)
                        .param("title", label),
                );
            }
        }
        let conflicts = indices
            .iter()
            .filter(|&&i| plan.actions[i].local.is_some())
            .map(|&i| plan.actions[i].id.clone())
            .collect::<BTreeSet<_>>();
        let mut individual = plan
            .preview
            .conflicts
            .iter()
            .filter(|c| conflicts.contains(&c.id) && c.target["requiresIndividualChoice"] == true)
            .map(|c| c.id.clone())
            .collect::<BTreeSet<_>>();
        let mut risky = BTreeSet::new();
        for id in conflicts.difference(&individual) {
            super::export::check(cancel)?;
            if !simulate(&base, plan, &indices, &|a| a.id == *id)? {
                risky.insert(id.clone());
            }
        }
        individual.extend(risky.iter().cloned());
        // The global incoming choice skips individual conflicts only.
        if !simulate(&base, plan, &indices, &|a| !individual.contains(&a.id))? {
            risky.extend(conflicts.difference(&individual).cloned());
        }
        for conflict in plan
            .preview
            .conflicts
            .iter_mut()
            .filter(|c| risky.contains(&c.id))
        {
            conflict.target["requiresIndividualChoice"] = json!(true);
            conflict.target["individualChoiceReason"] = json!("ageInterval");
        }
    }
    Ok(())
}
