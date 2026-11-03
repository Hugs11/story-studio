//! One selection, one operation; no source access.
use super::names;
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Transaction};
use std::collections::BTreeMap;
pub fn apply(
    tx: &Transaction<'_>,
    ids: &[String],
    value: bool,
    expected: &BTreeMap<String, i64>,
) -> Result<()> {
    for id in ids {
        let revision = expected
            .get(id)
            .ok_or_else(|| UserMessage::new(codes::CATALOG_MUTATION_INVALID))?;
        names::revision(tx, "fiche", id, *revision)?;
    }
    for id in ids {
        tx.execute(
            "UPDATE fiche SET favorite=?2 WHERE id=?1",
            params![id, value],
        )
        .map_err(error)?;
    }
    Ok(())
}
