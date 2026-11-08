//! Live editor project leases, independent of catalogue file operations.
use super::{fail, Result};
use crate::{
    services::catalogue::{
        store::{error, Store},
        writes,
    },
    support::user_message::codes,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
struct Access {
    path: PathBuf,
    expires: u64,
    modified: bool,
}
/// Live project leases belong to their catalogue instance.
/// Keeping them process-global makes unrelated catalogues serialize their IO
/// and retains leases after the owning catalogue has closed.
#[derive(Default)]
pub(crate) struct ProjectAccesses(Mutex<HashMap<String, Access>>);
fn stamp() -> u64 {
    super::plan::stamp()
}
impl Store {
    /// Serialize send preparation with editor admission and normal saves.
    pub(crate) fn with_project_send<T>(
        &self,
        path: &Path,
        prepare: impl FnOnce(bool) -> Result<T>,
    ) -> Result<T> {
        let mut access = self.accesses().lock().map_err(error)?;
        access.retain(|_, a| a.expires > stamp());
        self.require_no_recovery(path)?;
        let matches = |a: &&Access| {
            writes::comparison_key(&a.path) == writes::comparison_key(path)
                || writes::file_id(path)
                    .is_some_and(|id| writes::file_id(&a.path).as_ref() == Some(&id))
        };
        if access.values().filter(matches).any(|a| a.modified) {
            return Err(fail(codes::STORYTELLER_PROJECT_SAVE_REQUIRED));
        }
        prepare(access.values().any(|a| matches(&a)))
    }
    fn accesses(&self) -> &Mutex<HashMap<String, Access>> {
        &self.project_accesses.0
    }
    pub(super) fn require_project_idle(&self, path: &Path) -> Result<()> {
        if self.project_in_use(path)? {
            return Err(fail(codes::CATALOG_PROJECT_IN_USE));
        }
        Ok(())
    }
    pub(super) fn reserve_removal<T>(
        &self,
        path: &Path,
        reserve: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let access = self.accesses().lock().map_err(error)?;
        if access.values().any(|a| {
            a.expires > stamp()
                && (writes::comparison_key(&a.path) == writes::comparison_key(path)
                    || writes::file_id(path)
                        .is_some_and(|id| writes::file_id(&a.path).as_ref() == Some(&id)))
        }) {
            return Err(fail(codes::CATALOG_PROJECT_IN_USE));
        }
        // project_access holds this same mutex while checking durable guards.
        // Publish removal evidence before another editor can obtain a lease.
        let result = reserve();
        drop(access);
        result
    }
    fn project_in_use(&self, path: &Path) -> Result<bool> {
        let mut access = self.accesses().lock().map_err(error)?;
        access.retain(|_, a| a.expires > stamp());
        Ok(access.values().any(|a| {
            writes::comparison_key(&a.path) == writes::comparison_key(path)
                || writes::file_id(path)
                    .is_some_and(|id| writes::file_id(&a.path).as_ref() == Some(&id))
        }))
    }
    pub fn project_access(
        &self,
        action: &str,
        path: Option<String>,
        token: Option<String>,
        work_id: Option<String>,
    ) -> Result<Value> {
        if action == "status" {
            let path = path.ok_or_else(|| fail(codes::CATALOG_MUTATION_INVALID))?;
            return Ok(json!({"inUse": self.project_in_use(Path::new(&path))?}));
        }
        // Durable guards must be checked before reading a project or waiting
        // for a recovery which may itself be blocked in native filesystem IO.
        if matches!(action, "open" | "save") {
            if let Some(path) = path.as_deref() {
                if self.pending_backup_paths()?.iter().any(|pending| {
                    super::super::store::startup_paths_overlap(Path::new(path), pending)
                }) {
                    return Err(fail(codes::CATALOG_FILE_RECOVERY_REQUIRED));
                }
            }
        }
        let mut access = self.accesses().lock().map_err(error)?;
        access.retain(|_, a| a.expires > stamp());
        if matches!(action, "modified" | "saved") {
            let a = access
                .get_mut(token.as_deref().unwrap_or(""))
                .ok_or_else(|| fail(codes::CATALOG_PROJECT_IN_USE))?;
            a.modified = action == "modified";
            return Ok(json!({"updated":true}));
        }
        if action == "bind" {
            let a = access
                .get_mut(token.as_deref().unwrap_or(""))
                .ok_or_else(|| fail(codes::CATALOG_PROJECT_IN_USE))?;
            let work = work_id
                .filter(|w| !w.is_empty() && w.len() < 200)
                .ok_or_else(|| fail(codes::CATALOG_MUTATION_INVALID))?;
            self.write(|tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO project_session_origin VALUES (?1,?2,?3)",
                    params![
                        work,
                        writes::comparison_key(&a.path),
                        writes::file_id(&a.path)
                    ],
                )
                .map_err(error)?;
                Ok(())
            })?;
            return Ok(json!({"bound":true}));
        }
        if action == "release" {
            if let Some(id) = token {
                access.remove(&id);
            }
            return Ok(json!({"released":true}));
        }
        let path = PathBuf::from(path.ok_or_else(|| fail(codes::CATALOG_MUTATION_INVALID))?);
        if !path.is_absolute() || !matches!(action, "open" | "save") {
            return Err(fail(codes::CATALOG_MUTATION_INVALID));
        }
        self.require_no_recovery(&path)?;
        let id = uuid::Uuid::new_v4().to_string();
        access.insert(
            id.clone(),
            Access {
                path,
                // Fail closed until the editor has synchronized its work state.
                modified: true,
                expires: if action == "open" {
                    u64::MAX
                } else {
                    stamp() + 600
                },
            },
        );
        Ok(json!({"token":id}))
    }
}

#[cfg(test)]
mod access_isolation_tests {
    use super::*;

    #[test]
    fn independent_catalogues_do_not_share_project_access_mutex() {
        let root =
            std::env::temp_dir().join(format!("project-access-isolation-{}", uuid::Uuid::new_v4()));
        let first = Store::open(&root.join("first/data"), &root.join("first/cache")).unwrap();
        let second = Store::open(&root.join("second/data"), &root.join("second/cache")).unwrap();
        let path = root.join("Independent.mbah").to_string_lossy().into_owned();
        let guard = first.accesses().lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                for action in ["open", "save"] {
                    let receipt = second.project_access(action, Some(path.clone()), None, None)?;
                    second.project_access(
                        "release",
                        None,
                        Some(receipt["token"].as_str().unwrap().into()),
                        None,
                    )?;
                }
                Ok(())
            })();
            send.send(result).unwrap();
        });
        let result = receive.recv_timeout(crate::test_support::timeout());
        drop(guard);
        worker.join().unwrap();
        assert!(
            result.is_ok(),
            "an independent catalogue retained the project access mutex"
        );
        result.unwrap().unwrap();
        drop(first);
        std::fs::remove_dir_all(root).unwrap();
    }
}
