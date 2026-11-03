//! Ownership proofs shared by removals, and startup handling of legacy file journals.
use super::{
    fail,
    patch::{self, Snapshot},
    publish, Result,
};
use crate::{
    services::catalogue::store::{error, Store},
    support::user_message::{codes, UserMessage},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
#[cfg(test)]
pub(super) fn matches(path: &Path, expected: &Snapshot) -> bool {
    patch::snapshot(path, &AtomicBool::new(false))
        .is_ok_and(|actual| actual.content == expected.content)
}
/// Check existence without following a symbolic link.
pub(super) fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(super::io_error(e)),
    }
}
#[cfg(test)]
thread_local! {pub(super) static FAIL_REMOVE_OWNED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };}
pub(super) fn remove_owned(path: &Path, expected: &Snapshot) -> Result<()> {
    #[cfg(test)]
    if FAIL_REMOVE_OWNED.with(|v| v.get()) {
        return Err(fail(codes::CATALOG_DELETE_FAILED));
    }
    remove_proven(path, expected, &expected.identities, true)
}
fn verify_owned(
    path: &Path,
    expected: &Snapshot,
    identities: &BTreeMap<String, String>,
    partial: bool,
) -> Result<Snapshot> {
    let actual = patch::snapshot(path, &AtomicBool::new(false))?;
    let physical = patch::physical_ids(path, &actual)?;
    let content_matches = if partial {
        actual
            .content
            .iter()
            .all(|(name, hash)| expected.content.get(name) == Some(hash))
    } else {
        actual.content == expected.content
    };
    if !content_matches
        || physical.get("") != identities.get("")
        || !physical
            .iter()
            .all(|(name, id)| identities.get(name) == Some(id))
    {
        return Err(fail(codes::CATALOG_FILE_RECOVERY_REQUIRED));
    }
    Ok(actual)
}
fn remove_proven(
    path: &Path,
    expected: &Snapshot,
    identities: &BTreeMap<String, String>,
    partial: bool,
) -> Result<()> {
    if !present(path)? {
        return Ok(());
    }
    verify_owned(path, expected, identities, partial)?;
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(super::io_error)?;
    } else {
        fs::remove_file(path).map_err(super::io_error)?;
    }
    publish::sync_directory(path.parent().unwrap())
}
/// After our own move on a volume whose identity follows the directory entry,
/// require every original byte, then return the new native identities.
pub(super) fn relearn_moved(path: &Path, expected: &Snapshot) -> Result<Snapshot> {
    let mut actual = patch::snapshot(path, &AtomicBool::new(false))?;
    if actual.content != expected.content {
        return Err(fail(codes::CATALOG_FILE_RECOVERY_REQUIRED));
    }
    actual.identities = patch::physical_ids(path, &actual)?;
    Ok(actual)
}
/// A file journal left by a removed operation (copy/convert) is never resumed:
/// it is logged and closed so that it no longer reserves any card.
const CLOSE_LEGACY_JOURNALS_SQL: &str = "UPDATE file_journal SET evidence_json=json_set(evidence_json,'$.stage','failed') WHERE json_valid(evidence_json) AND COALESCE(json_extract(evidence_json,'$.stage'),'') NOT IN ('complete','rolledBack','failed')";
impl Store {
    pub(crate) fn recover_file_operations(&self) -> Result<Vec<UserMessage>> {
        let rows = self.read(|c| {
            c.prepare("SELECT evidence_json FROM file_journal")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        let operations = self.read(|c| {
            c.prepare("SELECT id FROM file_operation WHERE state='running'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })?;
        self.recover_file_operations_from(rows, operations)
    }
    pub(crate) fn recover_file_operations_from(
        &self,
        rows: Vec<String>,
        operations: Vec<String>,
    ) -> Result<Vec<UserMessage>> {
        let legacy = rows
            .iter()
            .filter(|row| {
                serde_json::from_str::<serde_json::Value>(row).is_ok_and(|v| {
                    !matches!(
                        v["stage"].as_str().unwrap_or(""),
                        "complete" | "rolledBack" | "failed"
                    )
                })
            })
            .count();
        self.write(|tx| {
            if legacy > 0 {
                log::warn!(
                    "Ignoring {legacy} legacy catalogue file journal(s); closed without resuming"
                );
                tx.execute(CLOSE_LEGACY_JOURNALS_SQL, []).map_err(error)?;
            }
            for id in &operations {
                tx.execute(
                    "UPDATE file_operation SET state='interrupted' WHERE id=?1 AND state='running'",
                    [id],
                )
                .map_err(error)?;
            }
            Ok(())
        })?;
        Ok(Vec::new())
    }
    pub(crate) fn pending_file_paths(&self) -> Result<Vec<PathBuf>> {
        let mut paths = self.pending_backup_paths()?;
        let removals: Vec<String> = self.read(|c| c.prepare("SELECT json_extract(evidence_json,'$.plan.targets[0].sourcePath') FROM file_removal WHERE state NOT IN ('complete','purgePending') AND json_valid(evidence_json) AND json_type(evidence_json,'$.plan.targets[0].sourcePath')='text'")?.query_map([], |r| r.get(0))?.collect())?;
        paths.extend(removals.into_iter().map(PathBuf::from));
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
    pub(crate) fn file_recovery_pending(&self, path: &Path) -> Result<bool> {
        Ok(self
            .pending_file_paths()?
            .iter()
            .any(|p| super::super::store::startup_paths_overlap(path, p)))
    }
    pub(super) fn require_no_recovery(&self, path: &Path) -> Result<()> {
        if self.file_recovery_pending(path)? {
            Err(fail(codes::CATALOG_FILE_RECOVERY_REQUIRED))
        } else {
            Ok(())
        }
    }
}
