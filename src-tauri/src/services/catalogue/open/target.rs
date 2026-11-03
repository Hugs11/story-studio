//! Revalidation of an exemplar designated by the interface.
//!
//! Every action on a file starts from `{exemplarId, expectedRevision}` exactly
//! as `catalogue_list_entries` published them: the exemplar must still be in
//! the index at that catalogue revision, never retired. Any change asks the
//! interface for a fresh target; no other exemplar is ever chosen instead.
use super::super::{probe, store::Store, Result};
use crate::support::user_message::{codes, UserMessage};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

/// What the index says about a revalidated exemplar.
#[derive(Debug, Clone)]
pub struct Target {
    /// The file or folder on disk; the archive itself for an archive child.
    pub path: PathBuf,
    /// Last observation of the analyzer, when one exists.
    pub observation: Option<Observed>,
}

#[derive(Debug, Clone)]
pub struct Observed {
    pub format: String,
    pub state: String,
    /// Content token of `path` when it was observed (see `scan::token`).
    pub token: String,
    pub raw: Value,
}

pub(crate) fn changed(path: &str) -> UserMessage {
    if path.is_empty() {
        UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE)
    } else {
        UserMessage::new(codes::CATALOG_TARGET_REVISION_CHANGED).param("path", path.to_owned())
    }
}

pub(crate) fn disappeared(path: &Path) -> UserMessage {
    UserMessage::new(codes::CATALOG_FILE_DISAPPEARED)
        .param("path", crate::support::paths::path_for_frontend(path))
}

type Row = (String, bool, Option<(String, String, String, String)>);

impl Store {
    /// Revalidates `exemplar` at `expected_revision` (catalogue revision).
    pub fn resolve_target(&self, exemplar: &str, expected_revision: i64) -> Result<Target> {
        let (revision, row) = self.read_snapshot(|c| {
            let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            let row: Option<Row> = c
                .query_row(
                    "SELECT e.anchor_json,e.retired,o.format,o.state,o.content_token,o.raw_observation_json
                     FROM exemplar e LEFT JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1",
                    [exemplar],
                    |r| {
                        let format: Option<String> = r.get(2)?;
                        let observed = match format {
                            Some(format) => Some((format, r.get(3)?, r.get(4)?, r.get(5)?)),
                            None => None,
                        };
                        Ok((r.get(0)?, r.get(1)?, observed))
                    },
                )
                .optional()?;
            Ok((revision, row))
        })?;
        let Some((anchor, retired, observed)) = row else {
            return Err(changed(""));
        };
        let anchor: Value = serde_json::from_str(&anchor).unwrap_or(Value::Null);
        let path = anchor["path"].as_str().unwrap_or_default().to_owned();
        if retired || path.is_empty() {
            return Err(changed(&path));
        }
        // Any revision change requires a fresh target from the interface.
        if revision != expected_revision {
            return Err(changed(&path));
        }
        let observation = observed.map(|(format, state, token, raw)| Observed {
            format,
            state,
            token,
            raw: serde_json::from_str(&raw).unwrap_or(Value::Null),
        });
        Ok(Target {
            path: PathBuf::from(path),
            observation,
        })
    }
}

/// Current content token of `path`, read by a bounded probe: `None` when the
/// element is gone or its volume does not answer.
pub(crate) fn current_token(path: &Path, timeout: Duration) -> Option<String> {
    let owned = path.to_owned();
    probe::bounded(path, timeout, move || {
        super::super::scan::token(&owned).ok().map(|token| token.0)
    })
    .flatten()
}

impl Target {
    pub fn display_path(&self) -> String {
        crate::support::paths::path_for_frontend(&self.path)
    }

    /// The element must still exist and hold the content that was indexed:
    /// a replaced file is a different target, never read in its place.
    pub fn require_unchanged(&self, timeout: Duration) -> Result<String> {
        let Some(observed) = self.observation.as_ref() else {
            return Err(changed(&self.display_path()));
        };
        match current_token(&self.path, timeout) {
            None => Err(disappeared(&self.path)),
            Some(token) if token == observed.token => Ok(token),
            Some(_) => Err(changed(&self.display_path())),
        }
    }
}
