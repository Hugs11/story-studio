//! Temporary editor inputs belong to a mounted funnel, never to the catalogue.
//! Closing an owner rejects late extraction requests; an in-flight request is
//! allowed to finish before its directory is removed. Nothing survives restart.
use crate::services::catalogue::{store::error, Result};
use crate::support::user_message::{codes, UserMessage};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Owner {
    readers: usize,
    closed: bool,
}
pub struct Registry {
    root: PathBuf,
    owners: Mutex<HashMap<String, Owner>>,
}

pub fn root(cache: &Path) -> PathBuf {
    cache.join("catalogue/staging/editor-extractions")
}
fn remove(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
fn validate(owner: &str) -> Result<()> {
    if uuid::Uuid::parse_str(owner)
        .ok()
        .is_some_and(|id| id.to_string() == owner)
    {
        Ok(())
    } else {
        Err(UserMessage::new(codes::CATALOG_MUTATION_INVALID))
    }
}
impl Registry {
    pub fn new(root: PathBuf) -> Self {
        // Initialization happens once, before any owner can acquire a lease.
        if let Err(reason) = remove(&root) {
            log::warn!("Editor extraction orphan cleanup: {reason}");
        }
        Self::without_cleanup(root)
    }
    pub(crate) fn without_cleanup(root: PathBuf) -> Self {
        Self {
            root,
            owners: Mutex::new(HashMap::new()),
        }
    }
    pub fn acquire(self: &Arc<Self>, owner: &str) -> Result<Lease> {
        validate(owner)?;
        {
            let mut owners = self.owners.lock().map_err(error)?;
            let entry = owners.entry(owner.to_owned()).or_default();
            if entry.closed {
                return Err(UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE));
            }
            entry.readers += 1;
        }
        let lease = Lease {
            registry: Arc::clone(self),
            owner: owner.into(),
            path: self.root.join(owner).join(uuid::Uuid::new_v4().to_string()),
            published: false,
        };
        std::fs::create_dir_all(&lease.path).map_err(error)?;
        Ok(lease)
    }
    pub fn release(&self, owner: &str) -> Result<()> {
        validate(owner)?;
        let mut owners = self.owners.lock().map_err(error)?;
        let entry = owners.entry(owner.into()).or_default();
        entry.closed = true;
        if entry.readers == 0 {
            self.clean_owner(owner);
        }
        Ok(())
    }
    fn clean_owner(&self, owner: &str) {
        if let Err(reason) = remove(&self.root.join(owner)) {
            log::warn!("Editor extraction cleanup: {reason}");
        }
    }
}
/// Compatibility cleanup for copies produced by the first implementation.
/// These were never session inputs after an import had finished.
pub fn clean_legacy(cache: &Path) {
    let legacy = cache
        .join(crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR)
        .join("catalogue-children");
    if let Err(reason) = remove(&legacy) {
        log::warn!("Legacy editor extraction cleanup: {reason}");
    }
}

pub struct Lease {
    registry: Arc<Registry>,
    owner: String,
    path: PathBuf,
    published: bool,
}
impl Lease {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn publish(&mut self) -> Result<()> {
        let owners = self.registry.owners.lock().map_err(error)?;
        if owners.get(&self.owner).is_none_or(|owner| owner.closed) {
            return Err(UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE));
        }
        self.published = true;
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove(&self.path);
        }
        if let Ok(mut owners) = self.registry.owners.lock() {
            if let Some(owner) = owners.get_mut(&self.owner) {
                owner.readers -= 1;
                if owner.closed && owner.readers == 0 {
                    self.registry.clean_owner(&self.owner);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn success_failure_cancellation_and_restart_release_only_owned_files() {
        let cache =
            std::env::temp_dir().join(format!("editor-extractions-{}", uuid::Uuid::new_v4()));
        let registry = Arc::new(Registry::new(root(&cache)));
        let owner = uuid::Uuid::new_v4().to_string();
        let mut success = registry.acquire(&owner).unwrap();
        std::fs::write(success.path().join("pack.zip"), b"pack").unwrap();
        success.publish().unwrap();
        let saved = success.path().to_owned();
        drop(success);
        assert!(saved.exists());
        registry.release(&owner).unwrap();
        assert!(!saved.exists());
        assert!(
            registry.acquire(&owner).is_err(),
            "a late response cannot recreate a closed owner"
        );
        let owner = uuid::Uuid::new_v4().to_string();
        let failed = registry.acquire(&owner).unwrap();
        let failed_path = failed.path().to_owned();
        drop(failed);
        assert!(!failed_path.exists());
        registry.release(&owner).unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        let mut pending = registry.acquire(&owner).unwrap();
        let path = pending.path().to_owned();
        registry.release(&owner).unwrap();
        assert!(path.exists(), "a live native reader still owns its lease");
        assert!(pending.publish().is_err());
        drop(pending);
        assert!(!path.exists());
        let owner = uuid::Uuid::new_v4().to_string();
        let mut orphan = registry.acquire(&owner).unwrap();
        orphan.publish().unwrap();
        let path = orphan.path().to_owned();
        drop(orphan);
        drop(registry);
        let outside = cache.join("session");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("project.mbah"), b"keep").unwrap();
        let _restarted = Registry::new(root(&cache));
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(outside.join("project.mbah")).unwrap(),
            b"keep"
        );
        let legacy = cache
            .join(crate::support::imported_pack::IMPORTED_PACK_CACHE_DIR)
            .join("catalogue-children/old");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("pack.zip"), b"old").unwrap();
        clean_legacy(&cache);
        assert!(!legacy.exists());
        assert!(Arc::new(Registry::new(root(&cache)))
            .acquire("../session")
            .is_err());
        let _ = std::fs::remove_dir_all(cache);
    }
}
