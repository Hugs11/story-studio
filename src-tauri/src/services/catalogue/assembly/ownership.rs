use super::failed;
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};

#[derive(Default)]
pub struct Registry {
    leases: HashMap<String, String>,
    transfers: HashMap<String, (String, String, Value)>,
    transfer_order: std::collections::VecDeque<String>,
    pub(super) requests: HashMap<String, (String, Value)>,
    pub(super) terminal_requests: std::collections::VecDeque<String>,
    pub(super) preparations: HashMap<String, Preparation>,
}
pub(super) struct Preparation {
    pub root: PathBuf,
    pub readers: usize,
    pub release_requested: bool,
}
impl Registry {
    // Replay the last 128 completed requests; active requests are never evicted.
    pub(super) fn complete_request(&mut self, id: String) {
        self.terminal_requests.push_back(id);
        while self.terminal_requests.len() > 128 {
            if let Some(old) = self.terminal_requests.pop_front() {
                self.requests.remove(&old);
            }
        }
    }
    pub fn retain_task(&mut self, id: &str) -> Result<String> {
        let preparation = self.preparations.get_mut(id).ok_or_else(failed)?;
        let token = uuid::Uuid::new_v4().to_string();
        preparation.readers += 1;
        self.leases.insert(token.clone(), id.into());
        Ok(token)
    }
    pub fn finish_task(&mut self, token: &str) -> Result<()> {
        if let Some(id) = self.leases.remove(token) {
            let cleanup = if let Some(preparation) = self.preparations.get_mut(&id) {
                preparation.readers -= 1;
                preparation.readers == 0 && preparation.release_requested
            } else {
                false
            };
            if cleanup {
                self.release(&id)?;
            }
        }
        Ok(())
    }
    pub fn release(&mut self, id: &str) -> Result<bool> {
        let Some(item) = self.preparations.get_mut(id) else {
            return Ok(false);
        };
        if item.readers != 0 {
            item.release_requested = true;
            return Err(UserMessage::new(codes::CATALOG_ASSEMBLY_PREPARATION_IN_USE));
        }
        match std::fs::remove_dir_all(&item.root) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(failed().with_detail(error(e).to_string())),
        }
        self.preparations.remove(id);
        Ok(true)
    }
}

impl crate::services::catalogue::store::Store {
    pub fn transfer_assembly(
        &self,
        sessions_root: &std::path::Path,
        preparation_id: &str,
        work_session_id: &str,
        request_id: &str,
    ) -> Result<Value> {
        let failure = || UserMessage::new(codes::CATALOG_ASSEMBLY_TRANSFER_FAILED);
        if request_id.is_empty() || request_id.len() > 200 {
            return Err(failure());
        }
        let mut registry = self.assemblies.lock().map_err(error)?;
        crate::support::temp::with_live_session(sessions_root, work_session_id, |session| {
            if let Some((before, owner, receipt)) = registry.transfers.get(request_id) {
                return if before == preparation_id && owner == work_session_id {
                    Ok(receipt.clone())
                } else {
                    Err(failure())
                };
            }
            let preparation = registry
                .preparations
                .get(preparation_id)
                .ok_or_else(failure)?;
            if preparation.release_requested {
                return Err(failure());
            }
            // The destination is constructed from server-owned identities only.
            let destination = session
                .join("fichiers-importes")
                .join(format!("assembly-{}", uuid::Uuid::new_v4()));
            let result = copy_preparation(&preparation.root, &destination).map(|assets| {
                serde_json::json!({
                    "preparationId": preparation_id,
                    "ownerSessionId": work_session_id,
                    "assets": assets,
                    "transferred": true,
                })
            });
            let receipt = result.map_err(|e| failure().with_detail(e.to_string()))?;
            // Bound replay memory; the session owns the copied files independently.
            if registry.transfers.len() >= 128 {
                if let Some(old) = registry.transfer_order.pop_front() {
                    registry.transfers.remove(&old);
                }
            }
            registry.transfer_order.push_back(request_id.into());
            registry.transfers.insert(
                request_id.into(),
                (
                    preparation_id.into(),
                    work_session_id.into(),
                    receipt.clone(),
                ),
            );
            Ok(receipt)
        })
    }
}

fn copy_preparation(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<Vec<Value>> {
    use crate::support::paths::path_for_frontend;
    std::fs::create_dir(destination)?;
    let result = (|| {
        let mut files = std::fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
        files.sort_by_key(|entry| entry.file_name());
        let mut assets = Vec::new();
        for entry in files {
            // Preparations contain only flat regular files produced by the service.
            if !entry.file_type()?.is_file() {
                return Err(std::io::Error::other("Unexpected preparation asset"));
            }
            let target = destination.join(entry.file_name());
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            std::io::copy(&mut std::fs::File::open(entry.path())?, &mut output)?;
            output.sync_all()?;
            assets.push(serde_json::json!({"sourcePath":path_for_frontend(entry.path()),"sessionPath":path_for_frontend(&target)}));
        }
        Ok(assets)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assembly_completed_requests_are_bounded_without_evicting_active_requests() {
        let mut registry = Registry::default();
        registry
            .requests
            .insert("active".into(), ("signature".into(), Value::Null));
        for index in 0..300 {
            let id = index.to_string();
            registry
                .requests
                .insert(id.clone(), ("signature".into(), Value::Null));
            registry.complete_request(id);
        }
        assert_eq!(registry.requests.len(), 129);
        assert!(registry.requests.contains_key("active"));
        assert!(!registry.requests.contains_key("0"));
        assert!(registry.requests.contains_key("299"));
    }
}
