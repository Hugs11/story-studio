//! One durable transaction: expected revisions, changes and replay receipt.
use super::{
    card,
    mutate::{
        metadata::{self, Change},
        reference,
    },
};
use crate::services::catalogue::{
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Mutation {
    ForgetUnreferencedCards {
        request_key: String,
        fiche_ids: Vec<String>,
        expected_fiche_revisions: std::collections::BTreeMap<String, i64>,
    },
    BulkSetMetadata {
        request_key: String,
        fiche_ids: Vec<String>,
        changes: std::collections::BTreeMap<String, super::mutate::bulk::BulkValue>,
        expected_fiche_revisions: std::collections::BTreeMap<String, i64>,
    },
    #[serde(rename = "undoMutation")]
    Undo {
        request_key: String,
        undo_token: String,
    },
    #[serde(rename = "setMetadata")]
    Metadata {
        request_key: String,
        fiche_id: String,
        expected_fiche_revision: i64,
        #[serde(flatten)]
        change: Change,
    },
    #[serde(rename = "setMetadataBatch")]
    MetadataBatch {
        request_key: String,
        fiche_id: String,
        expected_fiche_revision: i64,
        changes: Vec<Change>,
    },
    #[serde(rename = "setReferenceExemplar")]
    ReferenceExemplar {
        request_key: String,
        fiche_id: String,
        expected_fiche_revision: i64,
        exemplar_id: String,
    },
    SetFavorite {
        request_key: String,
        fiche_ids: Vec<String>,
        value: bool,
        expected_fiche_revisions: std::collections::BTreeMap<String, i64>,
    },
    ChangeTags {
        request_key: String,
        fiche_ids: Vec<String>,
        add_labels: Vec<String>,
        add_tag_ids: Vec<String>,
        remove_tag_ids: Vec<String>,
    },
}
impl Mutation {
    /// Cards this mutation touches, for the reservation against file
    /// operations in flight. The `match` has no wildcard: a new variant does
    /// not compile until it states which cards it designates.
    pub(crate) fn reserved_fiche_ids(&self) -> Vec<&str> {
        match self {
            Self::ForgetUnreferencedCards { fiche_ids, .. }
            | Self::BulkSetMetadata { fiche_ids, .. }
            | Self::SetFavorite { fiche_ids, .. }
            | Self::ChangeTags { fiche_ids, .. } => fiche_ids.iter().map(String::as_str).collect(),
            Self::Metadata { fiche_id, .. }
            | Self::MetadataBatch { fiche_id, .. }
            | Self::ReferenceExemplar { fiche_id, .. } => vec![fiche_id.as_str()],
            Self::Undo { .. } => Vec::new(),
        }
    }
}
impl Store {
    pub fn mutate(&self, mutation: Mutation, expected: i64) -> Result<Value> {
        if matches!(&mutation, Mutation::ForgetUnreferencedCards { .. }) {
            return super::mutate::forget::mutate(self, mutation, expected);
        }
        if matches!(
            &mutation,
            Mutation::BulkSetMetadata { .. } | Mutation::Undo { .. }
        ) {
            return super::mutate::bulk::mutate(self, mutation, expected);
        }
        if !matches!(
            &mutation,
            Mutation::Metadata { .. }
                | Mutation::MetadataBatch { .. }
                | Mutation::ReferenceExemplar { .. }
        ) {
            return super::organization::mutate(self, mutation, expected);
        }
        let (request, card_id, expected_fiche, kind) = match &mutation {
            Mutation::Metadata {
                request_key,
                fiche_id,
                expected_fiche_revision,
                ..
            } => (
                request_key,
                fiche_id,
                *expected_fiche_revision,
                "setMetadata",
            ),
            Mutation::MetadataBatch {
                request_key,
                fiche_id,
                expected_fiche_revision,
                ..
            } => (
                request_key,
                fiche_id,
                *expected_fiche_revision,
                "setMetadataBatch",
            ),
            Mutation::ReferenceExemplar {
                request_key,
                fiche_id,
                expected_fiche_revision,
                ..
            } => (
                request_key,
                fiche_id,
                *expected_fiche_revision,
                "setReferenceExemplar",
            ),
            _ => unreachable!("organization mutation dispatched above"),
        };
        if request.is_empty() || request.len() > 200 {
            return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
        }
        let payload = serde_json::to_value(&mutation).map_err(error)?;
        self.write(|tx| {
            crate::services::catalogue::files::require_mutation_available(tx, &mutation)?;
            if let Some(outcome) = replay(tx, request, &payload)? {
                return Ok(outcome);
            }
            let revision: i64 = tx
                .query_row("SELECT revision FROM catalogue", [], |r| r.get(0))
                .map_err(error)?;
            let fiche: Option<i64> = tx
                .query_row("SELECT revision FROM fiche WHERE id=?1", [card_id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(error)?;
            let fiche = fiche.ok_or_else(|| UserMessage::new(codes::CATALOG_ENTITY_NOT_FOUND))?;
            // Only the fiche itself is guarded, like favorites: scans, Lunii
            // synchronisation and official cover retention bump the global
            // revision for unrelated cards at any time. A fiche grouped into
            // another or forgotten after the read is hidden without a fiche
            // revision change, so its visibility is checked too.
            if fiche != expected_fiche {
                return Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT));
            }
            super::organization::require_visible_card(tx, card_id)?;
            let before = card::snapshot(tx, card_id).map_err(error)?;
            match &mutation {
                Mutation::Metadata { change, .. } => {
                    if matches!(change.field.as_str(), "ageMin" | "ageMax") {
                        return Err(metadata::invalid(&change.field, "batchRequired"));
                    }
                    metadata::apply(self, tx, card_id, std::slice::from_ref(change))?;
                }
                Mutation::MetadataBatch { changes, .. } => {
                    metadata::apply(self, tx, card_id, changes)?
                }
                Mutation::ReferenceExemplar { exemplar_id, .. } => {
                    reference::select(tx, card_id, exemplar_id)?;
                    if !metadata::age_interval_valid(tx, card_id).map_err(error)? {
                        return Err(UserMessage::new(codes::CATALOG_VALUE_INVALID)
                            .param("field", "ageMin")
                            .param("rule", "interval"));
                    }
                }
                _ => unreachable!("organization mutation dispatched above"),
            }
            tx.execute(
                "UPDATE fiche SET revision=revision+1 WHERE id=?1",
                [card_id],
            )
            .map_err(error)?;
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            let outcome = json!({"catalogueRevision":revision+1,"affectedCardIds":[card_id]});
            let after = card::snapshot(tx, card_id).map_err(error)?;
            let operation = record(tx, request, kind, expected, &payload, &outcome)?;
            tx.execute(
                "INSERT INTO operation_change VALUES (?1,'fiche',?2,?3,?4,?5)",
                params![
                    operation,
                    card_id,
                    serde_json::to_string(&before).map_err(error)?,
                    serde_json::to_string(&after).map_err(error)?,
                    fiche + 1
                ],
            )
            .map_err(error)?;
            tx.execute(
                "DELETE FROM cache.search_projection WHERE fiche_id=?1",
                [card_id],
            )
            .map_err(error)?;
            Ok(outcome)
        })
    }
}

/// Replay is checked before revisions, including for a lost IPC response.
pub(crate) fn replay(
    tx: &rusqlite::Transaction<'_>,
    request: &str,
    payload: &Value,
) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT recovery_json FROM operation WHERE request_key=?1",
            [request],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if let Some(raw) = raw {
        let receipt: Value = serde_json::from_str(&raw).map_err(error)?;
        if receipt["mutation"] != *payload {
            return Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID));
        }
        return Ok(Some(receipt["outcome"].clone()));
    }
    Ok(None)
}
pub(crate) fn record(
    tx: &rusqlite::Transaction<'_>,
    request: &str,
    kind: &str,
    expected: i64,
    payload: &Value,
    outcome: &Value,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO operation VALUES (?1,?2,'committed',?3,?4,unixepoch(),?5)",
        params![
            id,
            kind,
            request,
            expected,
            json!({"mutation":payload,"outcome":outcome}).to_string()
        ],
    )
    .map_err(error)?;
    if matches!(kind, "bulkSetMetadata") {
        tx.execute("INSERT OR REPLACE INTO undo_head VALUES (1,?1)", [&id])
            .map_err(error)?;
    }
    Ok(id)
}

impl Store {
    pub fn last_undo(&self) -> Result<Value> {
        self.read_snapshot(|c| {
            let receipt:Option<String>=c.query_row("SELECT recovery_json FROM operation WHERE id=(SELECT operation_id FROM undo_head WHERE singleton=1) AND status='committed'",[],|r|r.get(0)).optional()?;
            Ok(receipt.and_then(|r|serde_json::from_str::<Value>(&r).ok()).map(|r|json!({"undoToken":r["outcome"]["undoToken"]})).unwrap_or(json!({"undoToken":null})))
        })
    }
}
