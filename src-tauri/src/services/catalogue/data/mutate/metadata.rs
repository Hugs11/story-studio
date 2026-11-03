//! Rust is the authority for metadata validation.
use crate::services::catalogue::{
    data::{images, resolver},
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub field: String,
    pub language: Option<String>,
    pub state: String,
    pub value: Option<Value>,
    pub cover_staging_id: Option<String>,
}
pub fn invalid(field: &str, rule: &str) -> UserMessage {
    UserMessage::new(codes::CATALOG_VALUE_INVALID)
        .param("field", field)
        .param("rule", rule)
}
pub fn language_valid(s: &str) -> bool {
    (2..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase())
}
pub fn validate(change: &Change) -> Result<()> {
    let field = change.field.as_str();
    if !resolver::FIELDS.contains(&field) {
        return Err(invalid(field, "field"));
    }
    if change.language.as_ref().is_some_and(|s| {
        !language_valid(s) || !matches!(field, "title" | "description" | "keywords" | "bonus")
    }) {
        return Err(invalid(field, "language"));
    }
    if !matches!(change.state.as_str(), "defined" | "cleared" | "source") {
        return Err(invalid(field, "state"));
    }
    if change.state != "defined" {
        if change.value.is_some() || change.cover_staging_id.is_some() {
            return Err(invalid(field, "unexpectedValue"));
        }
        return Ok(());
    }
    if field == "cover" {
        return if change.value.is_none() && change.cover_staging_id.is_some() {
            Ok(())
        } else {
            Err(invalid(field, "staging"))
        };
    }
    if change.cover_staging_id.is_some() {
        return Err(invalid(field, "staging"));
    }
    let value = change
        .value
        .as_ref()
        .ok_or_else(|| invalid(field, "required"))?;
    let valid = match field {
        "ageMin" | "ageMax" => value.as_u64().is_some_and(|v| v <= i32::MAX as u64),
        "durationSeconds" | "storyCount" => value
            .as_u64()
            .is_some_and(|v| v > 0 && v <= i32::MAX as u64),
        "versionDeclared" => value.as_u64().is_some_and(|v| v <= i32::MAX as u64),
        "language" => value.as_str().is_some_and(language_valid),
        "keywords" => value.as_array().is_some_and(|a| {
            a.len() <= 100
                && a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 200)
                })
        }),
        _ => value.as_str().is_some_and(|s| {
            !s.trim().is_empty()
                && s.chars().count()
                    <= if field == "description" {
                        20_000
                    } else {
                        2_000
                    }
        }),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid(field, "value"))
    }
}
pub fn apply(store: &Store, tx: &Transaction<'_>, card: &str, changes: &[Change]) -> Result<()> {
    apply_inner(store, tx, card, changes, true)
}
fn apply_inner(
    store: &Store,
    tx: &Transaction<'_>,
    card: &str,
    changes: &[Change],
    interval: bool,
) -> Result<()> {
    if changes.is_empty() || changes.len() > 100 {
        return Err(invalid("changes", "length"));
    }
    let mut seen = std::collections::BTreeSet::new();
    let ages = changes
        .iter()
        .filter(|c| matches!(c.field.as_str(), "ageMin" | "ageMax"))
        .count();
    if interval && ages == 1 {
        return Err(invalid("ageMin", "batchRequired"));
    }
    for change in changes {
        validate(change)?;
        if !seen.insert((&change.field, &change.language)) {
            return Err(invalid(&change.field, "duplicate"));
        }
    }
    for change in changes {
        let language = change.language.as_deref().unwrap_or("");
        if change.state == "source" {
            tx.execute(
                "DELETE FROM correction WHERE fiche_id=?1 AND field=?2 AND language=?3",
                params![card, change.field, language],
            )
            .map_err(error)?;
            continue;
        }
        let image = change
            .cover_staging_id
            .as_ref()
            .map(|id| images::publish(store, tx, id))
            .transpose()?;
        let value = image
            .as_ref()
            .map(|sha| serde_json::json!({"sha256":sha}))
            .or(change.value.clone());
        let provenance = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO provenance(id,kind,language,retrieved_at) VALUES (?1,'manual',?2,unixepoch())",params![provenance,language]).map_err(error)?;
        tx.execute("INSERT INTO correction VALUES (?1,?2,?3,?4,?5,?6,?7,1) ON CONFLICT(fiche_id,field,language) DO UPDATE SET state=excluded.state,value_json=excluded.value_json,provenance_id=excluded.provenance_id,image_sha256=excluded.image_sha256,revision=correction.revision+1",params![card,change.field,language,change.state,value.map(|v|v.to_string()),provenance,image]).map_err(error)?;
    }
    if interval && !age_interval_valid(tx, card).map_err(error)? {
        return Err(invalid("ageMin", "interval"));
    }
    Ok(())
}

/// Shared final-state invariant, including restored values and reference fallback.
pub fn age_interval_valid(c: &rusqlite::Connection, card: &str) -> rusqlite::Result<bool> {
    let r = super::super::card::resolution(c, card, &[])?;
    Ok(
        match (
            r.values.get("ageMin").and_then(Value::as_u64),
            r.values.get("ageMax").and_then(Value::as_u64),
        ) {
            (Some(min), Some(max)) => min <= max,
            _ => true,
        },
    )
}
