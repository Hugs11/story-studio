//! Explicit label creation or identity reuse; collisions never merge implicitly.
use super::names;
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, Transaction};
pub fn change(
    tx: &Transaction<'_>,
    cards: &[String],
    labels: &[String],
    add: &[String],
    remove: &[String],
) -> Result<Vec<String>> {
    if add.iter().any(|id| remove.contains(id)) {
        return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
    }
    for card in cards {
        names::require(tx, "fiche", card)?;
    }
    for id in add.iter().chain(remove) {
        names::require(tx, "tag", id)?;
    }
    let mut ids = add.to_vec();
    let mut created = Vec::new();
    for raw in labels {
        let (label, key) = names::label(raw)?;
        names::unique(tx, "tag", &label, &key, "")?;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO tag VALUES (?1,?2,?3,1)",
            params![id, label, key],
        )
        .map_err(error)?;
        ids.push(id.clone());
        created.push(id);
    }
    for card in cards {
        for tag in &ids {
            tx.execute(
                "INSERT OR IGNORE INTO tag_member VALUES (?1,?2)",
                params![tag, card],
            )
            .map_err(error)?;
        }
        for tag in remove {
            tx.execute(
                "DELETE FROM tag_member WHERE tag_id=?1 AND fiche_id=?2",
                params![tag, card],
            )
            .map_err(error)?;
        }
    }
    for id in add
        .iter()
        .chain(remove)
        .collect::<std::collections::BTreeSet<_>>()
    {
        tx.execute("UPDATE tag SET revision=revision+1 WHERE id=?1", [id])
            .map_err(error)?;
    }
    crate::services::catalogue::store::prune_unused_tags(tx)?;
    Ok(created)
}
