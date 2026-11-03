//! Name normalization v1: shared semantics with normalizeSearchText (NFKD).
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::{Connection, OptionalExtension};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
pub fn normalize(label: &str) -> String {
    label
        .replace(['œ', 'Œ'], "oe")
        .replace(['æ', 'Æ'], "ae")
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}
pub fn label(raw: &str) -> Result<(String, String)> {
    let label = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() || label.chars().count() > 100 || label.chars().any(char::is_control) {
        return Err(UserMessage::new(codes::CATALOG_NAME_INVALID));
    }
    let normalized = normalize(&label);
    if normalized.trim().is_empty() {
        return Err(UserMessage::new(codes::CATALOG_NAME_INVALID));
    }
    Ok((label, normalized))
}
pub fn unique(
    c: &Connection,
    table: &str,
    label: &str,
    normalized: &str,
    except: &str,
) -> Result<()> {
    // table is an internal constant, never an IPC value.
    let existing: Option<String> = c
        .query_row(
            &format!("SELECT id FROM {table} WHERE normalized_label=?1 AND id!=?2"),
            [normalized, except],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if let Some(id) = existing {
        return Err(UserMessage::new(codes::CATALOG_NAME_DUPLICATE)
            .param("label", label)
            .param("existingId", id));
    }
    Ok(())
}
pub fn revision(c: &Connection, table: &str, id: &str, expected: i64) -> Result<()> {
    let revision: Option<i64> = c
        .query_row(
            &format!("SELECT revision FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    match revision {
        None => Err(UserMessage::new(codes::CATALOG_ENTITY_NOT_FOUND)),
        Some(r) if r != expected => Err(UserMessage::new(codes::CATALOG_REVISION_CONFLICT)),
        _ => Ok(()),
    }
}
pub fn require(c: &Connection, table: &str, id: &str) -> Result<()> {
    let exists: bool = c
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
            [id],
            |r| r.get(0),
        )
        .map_err(error)?;
    if exists {
        Ok(())
    } else {
        Err(UserMessage::new(codes::CATALOG_ENTITY_NOT_FOUND))
    }
}
