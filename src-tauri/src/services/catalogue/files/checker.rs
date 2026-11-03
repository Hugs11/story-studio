//! The existing checker owns a preparation until its funnel and tasks close.
use super::{convert, fail, patch, Result};
use crate::services::catalogue::{open::editor_extractions, store::Store, writes};
use crate::support::{paths::path_for_frontend, user_message::codes};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub exemplar_id: String,
    pub path: String,
    pub child_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub preparation_id: String,
    pub zip_path: String,
    pub source: Source,
    pub temporary: bool,
    pub content_token: String,
}
impl Store {
    pub fn prepare_checker_entry(
        &self,
        registry: &Arc<editor_extractions::Registry>,
        exemplar_id: &str,
        expected_revision: i64,
    ) -> Result<Entry> {
        let owner = uuid::Uuid::new_v4().to_string();
        let result = (|| {
            let mut lease = registry.acquire(&owner)?;
            let target = self.resolve_target(exemplar_id, expected_revision)?;
            target.require_unchanged(Duration::from_secs(2))?;
            let observed = target
                .observation
                .as_ref()
                .ok_or_else(|| fail(codes::CATALOG_CHECKER_PREPARATION_FAILED))?;
            if observed.state != "available"
                || !matches!(
                    observed.format.as_str(),
                    "zip" | "7z" | "studioDirectory" | "fsDirectory" | "fsZip"
                )
            {
                return Err(fail(codes::CATALOG_CHECKER_PREPARATION_FAILED));
            }
            let indexed = self
                .read(|c| {
                    c.query_row(
                        "SELECT file_id FROM exemplar_file_state WHERE exemplar_id=?1",
                        [exemplar_id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()
                })?
                .flatten();
            if indexed.is_none() || indexed != writes::file_id(&target.path) {
                return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
            }
            let cancel = AtomicBool::new(false);
            let original = patch::snapshot(&target.path, &cancel)?;
            let chain = observed.raw["chain"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let temporary = observed.format != "zip" || !chain.is_empty();
            let zip = if temporary {
                let selected = chain
                    .last()
                    .and_then(|segment| segment["path"].as_str())
                    .map(std::path::Path::new)
                    .unwrap_or(&target.path);
                let stem = selected
                    .file_stem()
                    .unwrap_or_else(|| std::ffi::OsStr::new("pack"));
                let zip = lease.path().join(format!("{}.zip", stem.to_string_lossy()));
                let own = writes::OwnWrite::begin(
                    writes::Declaration::new("catalogueCheckerPreparation").temporary(lease.path()),
                );
                let result = convert::prepare(
                    Some(self),
                    &target.path,
                    &observed.format,
                    &chain,
                    &zip,
                    &cancel,
                );
                own.finish(&result, |_| vec![zip.clone()]);
                result?;
                zip
            } else {
                target.path.clone()
            };
            patch::unchanged(&target.path, &original, &cancel)?;
            if self.list_sources()?.catalogue_revision != expected_revision {
                return Err(fail(codes::CATALOG_REVISION_CONFLICT));
            }
            let content_token = patch::token(&patch::snapshot(&zip, &cancel)?);
            // Only the preparation's own directory is ever released, even for
            // direct ZIP input. The source pack never belongs to this registry.
            lease.publish()?;
            Ok(Entry {
                preparation_id: owner.clone(),
                zip_path: path_for_frontend(&zip),
                source: Source {
                    exemplar_id: exemplar_id.into(),
                    path: target.display_path(),
                    child_id: if chain.is_empty() {
                        None
                    } else {
                        Some(exemplar_id.into())
                    },
                },
                temporary,
                content_token,
            })
        })();
        if result.is_err() {
            registry.release(&owner)?;
        }
        result
            .map_err(|e| fail(codes::CATALOG_CHECKER_PREPARATION_FAILED).with_detail(e.to_string()))
    }
}

/// Recheck an input immediately before an existing checker task reads it.
pub(crate) fn require_content(path: &std::path::Path, token: &str) -> Result<()> {
    let actual = patch::snapshot(path, &AtomicBool::new(false))?;
    if patch::token(&actual) != token {
        return Err(fail(codes::CATALOG_CHECKER_PREPARATION_FAILED));
    }
    Ok(())
}
