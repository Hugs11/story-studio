use super::*;
use std::{io::Write, sync::Mutex};
pub(super) fn mutation(root: &Path) -> std::sync::Arc<Mutex<()>> {
    use std::sync::{Arc, OnceLock, Weak};
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>> =
        OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = root.canonicalize().unwrap_or_else(|_| root.to_owned());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}
pub(crate) struct BackupScope<'a>(&'a Device);
impl Drop for BackupScope<'_> {
    fn drop(&mut self) {
        self.0
            .backup_depth
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Each variant represents an explicit user action, never a connection repair.
pub(crate) enum Action {
    Install {
        story: crate::services::storyteller::cipher::EncryptedStory,
        position: Option<usize>,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        progress: Option<super::install::CopyProgress>,
    },
    Hide(Uuid),
    Show(Uuid),
    RestorePlaylist,
    RepairPlaylist,
    Remove(Uuid),
    Reorder(Vec<Uuid>),
    /// The caller supplies an independently known full UUID (e.g. its local
    /// catalogue). A suffix alone cannot reconstruct it. None is a typed refusal.
    Restore {
        folder: String,
        known_uuid: Option<Uuid>,
    },
    DeleteOrphan(String),
    /// Several `.content` orphans, each with an independently known full UUID,
    /// back at the end of the list in one `.pi` write. Order: the most recent
    /// D15 copy that lists them, then the others in the given order.
    /// Incomplete folders are left out and stay orphans.
    RestoreOrphans(Vec<(String, Uuid)>),
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Outcome {
    Complete,
    /// Playlist committed; sidecar/folder finalization needs a retry, or the
    /// final volume synchronization failed: the gesture may not be durable.
    StateWarning,
    /// Payload and .pi verified, but publication did not reach durable storage.
    InstalledNotDurable,
    Repaired {
        kept: usize,
        removed: Vec<Uuid>,
        /// No complete story entry remains after repair.
        empty: bool,
        /// An incomplete final record was discarded.
        truncated: bool,
    },
    RepairedNotDurable {
        kept: usize,
        removed: Vec<Uuid>,
        /// No complete story entry remains after repair.
        empty: bool,
        /// An incomplete final record was discarded.
        truncated: bool,
    },
    /// .pi was verified but its publication is not durable: retain the folder.
    RemovedWithOrphan,
    /// Restored list verified, but directory synchronization failed.
    RestoredNotDurable,
    /// List durable, but temporary cleanup failed or was not durable.
    RestoredWithResidue,
}
pub(crate) struct Device {
    pub(crate) root: PathBuf,
    pub(super) backups: PathBuf,
    backup_depth: std::sync::atomic::AtomicUsize,
    backup_taken: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(super) fail_at: Option<usize>,
    #[cfg(test)]
    pub(super) after_install_chunk: Option<fn(&std::sync::atomic::AtomicBool)>,
    #[cfg(test)]
    pub(super) after_install_rename: Option<fn(&Path, &std::sync::atomic::AtomicBool)>,
    #[cfg(test)]
    pub(super) fail_publish_sync: bool,
    /// Final volume barrier of a gesture fails (see `sync_volume`).
    #[cfg(test)]
    pub(super) fail_volume_sync: bool,
    #[cfg(test)]
    pub(super) volume_syncs: std::cell::Cell<usize>,
    #[cfg(test)]
    pub(super) barriers: std::cell::Cell<usize>,
    #[cfg(test)]
    pub(super) fail_cleanup: bool,
    #[cfg(test)]
    pub(super) fail_cleanup_sync: bool,
    #[cfg(test)]
    pub(super) before_recovery_cleanup: Option<fn(&Path)>,
    #[cfg(test)]
    pub(super) after_recovery_backup: Option<fn(&Path)>,
    #[cfg(test)]
    pub(super) after_unpark: Option<fn(&Path)>,
    #[cfg(test)]
    step: std::cell::Cell<usize>,
}
impl Device {
    /// `app_data` is the application-data directory resolved by the future host,
    /// never a frontend-supplied arbitrary device-relative backup destination.
    pub(crate) fn open(root: &Path, app_data: &Path) -> Result<Self> {
        let _guard = platform::access_guard();
        safe(root, true)?;
        if !app_data.is_absolute() {
            return Err(Error::UnsafePath);
        }
        let app_data = app_data.canonicalize()?;
        if !app_data.is_dir() {
            return Err(Error::UnsafePath);
        }
        let root = root.canonicalize()?;
        let backups = app_data.canonicalize()?.join("storyteller-backups");
        if backups.starts_with(&root) || root.starts_with(&backups) {
            return Err(Error::UnsafePath);
        }
        Ok(Self {
            root,
            backups,
            backup_depth: std::sync::atomic::AtomicUsize::new(0),
            backup_taken: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fail_at: None,
            #[cfg(test)]
            after_install_chunk: None,
            #[cfg(test)]
            after_install_rename: None,
            #[cfg(test)]
            fail_publish_sync: false,
            #[cfg(test)]
            fail_volume_sync: false,
            #[cfg(test)]
            volume_syncs: std::cell::Cell::new(0),
            #[cfg(test)]
            barriers: std::cell::Cell::new(0),
            #[cfg(test)]
            fail_cleanup: false,
            #[cfg(test)]
            fail_cleanup_sync: false,
            #[cfg(test)]
            before_recovery_cleanup: None,
            #[cfg(test)]
            after_recovery_backup: None,
            #[cfg(test)]
            after_unpark: None,
            #[cfg(test)]
            step: std::cell::Cell::new(0),
        })
    }
    pub(crate) fn backup_scope(&self) -> BackupScope<'_> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.backup_depth.fetch_add(1, SeqCst) == 0 {
            self.backup_taken.store(false, SeqCst);
        }
        BackupScope(self)
    }
    pub(super) fn checkpoint(&self) -> Result<()> {
        #[cfg(test)]
        {
            let step = self.step.get();
            self.step.set(step + 1);
            if self.fail_at == Some(step) {
                return Err(Error::Interrupted);
            }
        }
        Ok(())
    }
    pub(crate) fn apply(&self, action: Action) -> Result<Outcome> {
        self.apply_with_catalogue(
            action,
            &NativeVolumes,
            None::<&crate::services::catalogue::store::Store>,
        )
    }
    pub(crate) fn apply_with_catalogue<C: OfficialCatalogue>(
        &self,
        action: Action,
        volumes: &impl Volumes,
        catalogue: Option<&C>,
    ) -> Result<Outcome> {
        let _guard = platform::access_guard();
        let mutation = mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        let install = matches!(action, Action::Install { .. });
        let restore = matches!(
            action,
            Action::Restore { .. } | Action::RestoreOrphans(_) | Action::RestorePlaylist
        );
        let result = self.apply_locked(action, volumes, catalogue);
        // Also after a failure: partial writes reach the medium. The original
        // error is kept; only a success can be downgraded.
        let durable = self.sync_volume();
        match result {
            Ok(outcome) if durable.is_err() => Ok(not_durable(outcome, install, restore)),
            other => other,
        }
    }
    /// End of every writing gesture on the storyteller: the whole volume is on
    /// the medium before the outcome is announced (see platform::sync_volume).
    pub(super) fn sync_volume(&self) -> Result<()> {
        #[cfg(test)]
        {
            self.volume_syncs.set(self.volume_syncs.get() + 1);
            if self.fail_volume_sync {
                return Err(Error::Io);
            }
        }
        platform::sync_volume(&self.root)
    }
    /// Intermediate barrier inside a gesture (ordering), counted in tests.
    pub(super) fn volume_barrier(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        self.barriers.set(self.barriers.get() + 1);
        platform::sync_volume(path)
    }
    fn apply_locked<C: OfficialCatalogue>(
        &self,
        action: Action,
        volumes: &impl Volumes,
        catalogue: Option<&C>,
    ) -> Result<Outcome> {
        safe(&self.root, true)?;
        if !volumes.writable(&self.root)? {
            return Err(Error::ReadOnly);
        }
        let metadata = read::metadata(&self.root)?;
        if let Some(e) = metadata.read_only {
            return Err(e);
        }
        if matches!(action, Action::RestorePlaylist) {
            return self.restore_playlist(&metadata);
        }
        let recovery = read::recovery(&self.root)?;
        let repairing = matches!(action, Action::RepairPlaylist);
        if recovery.is_some_and(RecoveryState::requires_restore) {
            return Err(Error::RecoveryRequired);
        }
        let restoring = matches!(action, Action::Restore { .. } | Action::RestoreOrphans(_));
        let original_bytes = if repairing {
            read::require_content(&self.root)?;
            Some(read::playlist_bytes(&self.root.join(".pi"))?)
        } else {
            None
        };
        let old = if repairing {
            Vec::new()
        } else {
            read::playlist(&self.root).map_err(|e| match e {
                Error::InvalidPlaylist | Error::SuffixCollision => Error::PlaylistDamaged,
                other => other,
            })?
        };
        if !repairing
            && !matches!(action, Action::DeleteOrphan(_))
            && read::has_missing_folders(&self.root, &old)?
        {
            return Err(Error::PlaylistDamaged);
        }
        let (mut next, removed) = if let Some(bytes) = &original_bytes {
            let (next, removed) = self.repair_plan(bytes)?;
            let serialized: Vec<_> = next.iter().flat_map(|id| *id.as_bytes()).collect();
            if serialized == *bytes {
                return Err(Error::NoRepairRequired);
            }
            (next, removed)
        } else {
            (old.clone(), Vec::new())
        };
        let mut delete = None;
        if !repairing {
            safe(&self.root.join(".content"), true)?;
        }
        let mut hidden_state = state::normalized(&self.root, if repairing { &next } else { &old });
        let mut full_order = state::full_order(if repairing { &next } else { &old }, &hidden_state);
        let mut visibility = None;
        // A parked orphan moved to .content before its entry is published.
        let mut unparked = None;
        let mut install_cancel = None;
        let mut install_story = None;
        match action {
            Action::Install {
                story,
                position,
                cancel,
                progress,
            } => {
                if recognizes_official(&story.uuid.to_string(), catalogue) != (false, false) {
                    return Err(Error::OfficialStory);
                }
                self.install_payload(&story, &old, volumes, &metadata, &cancel, progress.as_ref())?;
                full_order.insert(
                    position.unwrap_or(full_order.len()).min(full_order.len()),
                    story.uuid,
                );
                hidden_state
                    .hidden
                    .retain(|h| h.uuid != story.uuid.to_string());
                install_cancel = Some(cancel);
                install_story = Some(story);
            }
            Action::Hide(id) => {
                visibility = Some((id, true));
            }
            Action::Show(id) => {
                visibility = Some((id, false));
            }
            Action::RestorePlaylist => unreachable!(),
            Action::RepairPlaylist => {}
            Action::Remove(id) => {
                if let Some(pos) = next.iter().position(|v| *v == id) {
                    next.remove(pos);
                } else if hidden_state.hidden.iter().any(|v| v.uuid == id.to_string()) {
                    hidden_state.hidden.retain(|v| v.uuid != id.to_string());
                } else {
                    return Err(Error::MissingStory);
                }
                full_order.retain(|v| *v != id);
                hidden_state.sent.remove(&id.to_string());
                let path = state::story_path(&self.root, id);
                if path.symlink_metadata().is_ok() {
                    check_tree(&path)?;
                    // Recorded with the list, before the deletion that may be cut.
                    if !hidden_state.removed.contains(&id.to_string()) {
                        hidden_state.removed.push(id.to_string());
                    }
                    delete = Some(path);
                }
            }
            Action::Reorder(order) => {
                let full = state::full_order(&old, &hidden_state);
                let mut a = full.clone();
                let mut b = order.clone();
                a.sort();
                b.sort();
                if a != b {
                    return Err(Error::InvalidOrder);
                }
                if order == full
                    && hidden_state.hidden.is_empty()
                    && state::load(&self.root).hidden.is_empty()
                {
                    return Ok(Outcome::Complete);
                }
                full_order = order;
            }
            Action::Restore {
                folder: name,
                known_uuid,
            } => {
                let parked = name.strip_prefix("parked:");
                let folder_name = parked.unwrap_or(&name);
                if !valid_folder(folder_name) {
                    return Err(Error::UnsafePath);
                }
                let id = known_uuid.ok_or(Error::UnknownUuid)?;
                if folder(id) != folder_name {
                    return Err(Error::UnknownUuid);
                }
                if hidden_state.hidden.iter().any(|h| h.uuid == id.to_string()) {
                    return Err(Error::HiddenStory);
                }
                // Hidden stories included: a parked copy never comes back under another UUID.
                if full_order.iter().any(|v| folder(*v) == folder_name) {
                    return Err(Error::SuffixCollision);
                }
                self.check_orphan_uuid(&self.backup_lists(), folder_name, id)?;
                safe(&self.root.join(".content"), true)?;
                let content = self.root.join(".content").join(folder_name);
                let path = if parked.is_some() {
                    self.root
                        .join(cards::DIRECTORY)
                        .join("masquees")
                        .join(folder_name)
                } else {
                    content.clone()
                };
                safe(&path, true)?;
                if !read::complete(&path, metadata.version) {
                    return Err(Error::IncompleteStory);
                }
                if parked.is_some() {
                    // Move the whole orphan before publishing its entry, as for Show.
                    // A cut leaves a complete content orphan, never a dangling entry.
                    if content.symlink_metadata().is_ok() {
                        return Err(Error::Duplicate { position: None });
                    }
                    self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
                        .map_err(|_| Error::BackupFailed)?;
                    platform::move_dir(&path, &content)?;
                    unparked = Some(id);
                    #[cfg(test)]
                    if let Some(change) = self.after_unpark {
                        change(&self.root);
                    }
                }
                next.push(id);
                full_order.push(id);
            }
            Action::RestoreOrphans(items) => {
                safe(&self.root.join(".content"), true)?;
                let lists = self.backup_lists();
                let mut chosen: Vec<Uuid> = Vec::new();
                for (name, id) in &items {
                    if !valid_folder(name) {
                        return Err(Error::UnsafePath);
                    }
                    if folder(*id) != *name {
                        return Err(Error::UnknownUuid);
                    }
                    if hidden_state.hidden.iter().any(|h| h.uuid == id.to_string()) {
                        return Err(Error::HiddenStory);
                    }
                    // Hidden stories included, as for a single Restore.
                    if full_order
                        .iter()
                        .chain(&chosen)
                        .any(|v| folder(*v) == *name)
                    {
                        return Err(Error::SuffixCollision);
                    }
                    self.check_orphan_uuid(&lists, name, *id)?;
                    // A folder gone since display is left out, like an incomplete one.
                    let path = self.root.join(".content").join(name);
                    if safe(&path, true).is_ok() && read::complete(&path, metadata.version) {
                        chosen.push(*id);
                    }
                }
                if chosen.is_empty() {
                    return Err(if items.is_empty() {
                        Error::MissingStory
                    } else {
                        Error::IncompleteStory
                    });
                }
                let ordered = lists.order(&chosen);
                next.extend(&ordered);
                full_order.extend(ordered);
            }
            Action::DeleteOrphan(name) => {
                let parked_name = name.strip_prefix("parked:");
                let name = parked_name.unwrap_or(&name).to_owned();
                if !valid_folder(&name) && !install_temporary(&name) {
                    return Err(Error::UnsafePath);
                }
                if parked_name.is_none() && old.iter().any(|v| folder(*v) == name) {
                    return Err(Error::InvalidPlaylist);
                }
                let path = if parked_name.is_some() {
                    self.root
                        .join(cards::DIRECTORY)
                        .join("masquees")
                        .join(&name)
                } else {
                    self.root.join(".content").join(&name)
                };
                // Only the authoritative copy of a hidden story is protected;
                // another existing folder of the same name is an orphan (E11).
                if read::hidden(&self.root)?.iter().any(|id| {
                    folder(*id) == name
                        && (state::story_path(&self.root, *id) == path
                            || path.symlink_metadata().is_err())
                }) {
                    return Err(Error::HiddenStory);
                }
                if parked_name.is_none() || safe(&path, false).is_err() {
                    check_tree(&path)?;
                }
                delete = Some(path);
            }
        }
        let hiding = visibility.filter(|(_, hidden)| *hidden).map(|(id, _)| id);
        let shown = visibility
            .filter(|(id, hidden)| {
                !hidden && !self.root.join(".content").join(folder(*id)).exists()
            })
            .map(|(id, _)| id);
        let result = (|| {
            if unparked.is_some() {
                // One barrier covers .content and masquees/.
                platform::sync_volume(&self.root)?;
            }
            (next, hidden_state) = self.transition(
                full_order,
                hidden_state,
                state::Phase::Prepare(visibility),
                &metadata,
            )?;
            // Never publish an index referencing an absent folder, including after a cut.
            if next != old {
                for id in &next {
                    safe(&self.root.join(".content").join(folder(*id)), true)
                        .map_err(|_| Error::MissingStory)?;
                }
            }
            self.checkpoint()?;
            self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
                .map_err(|_| Error::BackupFailed)?;
            self.checkpoint()?;
            if read::metadata(&self.root)? != metadata
                || !self.playlist_unchanged(original_bytes.as_deref(), &old)?
                || (repairing
                    && read::recovery(&self.root)?.is_some_and(RecoveryState::requires_restore))
            {
                return Err(Error::Changed);
            }
            if !repairing && next == old {
                let committed = self.transition(
                    next.clone(),
                    hidden_state,
                    hiding.map_or(state::Phase::Commit, state::Phase::CommitHide),
                    &metadata,
                );
                if hiding.is_some() {
                    committed?;
                } else {
                    state::unrelated_parking(committed)?;
                }
                if let Some(path) = delete {
                    // Hidden state may have changed while the D15 copy was taken.
                    let name = path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .ok_or(Error::UnsafePath)?;
                    if read::hidden(&self.root)?
                        .iter()
                        .any(|id| folder(*id) == name && state::story_path(&self.root, *id) == path)
                    {
                        return Err(Error::HiddenStory);
                    }
                    self.delete_tree(&path)?;
                    platform::sync_volume(path.parent().ok_or(Error::UnsafePath)?)?;
                }
                return Ok(Outcome::Complete);
            }
            let temp = self
                .root
                .join(format!(".story-studio-pi-{}", Uuid::new_v4()));
            // Exclusive creation never overwrites an existing recovery candidate.
            let file = fs::File::create_new(&temp)?;
            let result = (|| {
                let mut file = file;
                self.checkpoint()?;
                for id in &next {
                    file.write_all(id.as_bytes())?;
                    self.checkpoint()?;
                }
                self.checkpoint()?;
                file.sync_all()?;
                drop(file);
                self.checkpoint()?;
                if !self.playlist_unchanged(original_bytes.as_deref(), &old)?
                    || read::metadata(&self.root)? != metadata
                {
                    return Err(Error::Changed);
                }
                if repairing {
                    read::require_content(&self.root)?;
                }
                if read::has_missing_folders(&self.root, &next)? {
                    return Err(Error::Changed);
                }
                if install_cancel
                    .as_ref()
                    .is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst))
                {
                    // This temporary has never participated in a rename; safe to remove.
                    if fs::remove_file(&temp).is_err() {
                        state::cleanup_warning();
                    }
                    return Err(Error::Cancelled);
                }
                if install_story
                    .as_ref()
                    .is_some_and(|s| !s.matches_device(&self.root))
                {
                    if fs::remove_file(&temp).is_err() {
                        state::cleanup_warning();
                    }
                    return Err(Error::Changed);
                }
                if install_story.as_ref().is_some_and(|s| {
                    !read::complete(
                        &self.root.join(".content").join(folder(s.uuid)),
                        metadata.version,
                    )
                }) {
                    return Err(Error::IncompleteStory);
                }
                let durable = self.publish(&temp, &next)?;
                // Keep visibility recovery memory until the playlist is durable.
                // Hide must not move yet; Show must remain retryable after a cut.
                if !durable && visibility.is_some() {
                    return Ok(Outcome::StateWarning);
                }
                match self.transition(
                    next.clone(),
                    hidden_state,
                    hiding.map_or(state::Phase::Commit, state::Phase::CommitHide),
                    &metadata,
                ) {
                    Ok(_) => {}
                    // .pi no longer lists the story; its folder stays in .content.
                    Err(Error::ParkingFailed) if hiding.is_some() => {
                        return Err(Error::ParkingFailed)
                    }
                    Err(Error::ParkingFailed) => {}
                    Err(_) => return Ok(Outcome::StateWarning),
                }
                self.checkpoint()?;
                if read::playlist(&self.root)? != next {
                    return Err(Error::Verification);
                }
                self.checkpoint()?;
                if repairing {
                    return Ok(if durable {
                        Outcome::Repaired {
                            empty: next.is_empty(),
                            truncated: original_bytes.as_ref().is_some_and(|b| b.len() % 16 != 0),
                            kept: next.len(),
                            removed,
                        }
                    } else {
                        Outcome::RepairedNotDurable {
                            empty: next.is_empty(),
                            truncated: original_bytes.as_ref().is_some_and(|b| b.len() % 16 != 0),
                            kept: next.len(),
                            removed,
                        }
                    });
                }
                if install_story.is_some() && !durable {
                    return Ok(Outcome::InstalledNotDurable);
                }
                if restoring && !durable {
                    return Ok(Outcome::RestoredNotDurable);
                }
                if let Some(path) = delete {
                    if !durable {
                        return Ok(Outcome::RemovedWithOrphan);
                    }
                    self.delete_tree(&path)?;
                    platform::sync_volume(path.parent().ok_or(Error::UnsafePath)?)?;
                }
                self.checkpoint()?;
                Ok(Outcome::Complete)
            })();
            // A failed FAT rename can leave a temporary aliasing .pi clusters.
            // Never unlink it automatically, even if the operation failed early.
            if result == Err(Error::Cancelled) {
                let cleanup = (|| -> Result<()> {
                    if let Some(story) = &install_story {
                        let path = self.root.join(".content").join(folder(story.uuid));
                        if !read::playlist(&self.root)?.contains(&story.uuid) {
                            check_tree(&path)?;
                            fs::remove_dir_all(&path)?;
                            platform::sync_volume(path.parent().ok_or(Error::UnsafePath)?)?;
                        }
                    }
                    Ok(())
                })();
                if cleanup.is_err() {
                    state::cleanup_warning();
                }
            }
            result
        })();
        if result.is_err() {
            // Show and parked Restore: an unpublished entry sends its folder back.
            if let Some(id) = shown.or(unparked) {
                if read::playlist(&self.root).is_ok_and(|list| !list.contains(&id)) {
                    let content = self.root.join(".content").join(folder(id));
                    let parked = self
                        .root
                        .join(cards::DIRECTORY)
                        .join("masquees")
                        .join(folder(id));
                    if content.is_dir() && !parked.exists() {
                        // Keep the original error; a failed return is logged.
                        state::unpark_back(&content, &parked);
                    }
                }
            }
        }
        result
    }
    fn playlist_unchanged(&self, bytes: Option<&[u8]>, old: &[Uuid]) -> Result<bool> {
        if let Some(bytes) = bytes {
            Ok(read::playlist_bytes(&self.root.join(".pi"))? == bytes)
        } else {
            Ok(read::playlist(&self.root)? == old)
        }
    }
    /// Read-only preview uses the exact repair planner, including truncated records.
    pub(crate) fn repair_preview(&self) -> Result<Outcome> {
        read::require_content(&self.root)?;
        let bytes = read::playlist_bytes(&self.root.join(".pi"))?;
        let (next, removed) = self.repair_plan(&bytes)?;
        Ok(Outcome::Repaired {
            kept: next.len(),
            empty: next.is_empty(),
            removed,
            truncated: bytes.len() % 16 != 0,
        })
    }
    /// D27: complete records only, stable order, no backup as a data source.
    fn repair_plan(&self, bytes: &[u8]) -> Result<(Vec<Uuid>, Vec<Uuid>)> {
        let mut seen = std::collections::HashSet::new();
        let mut suffixes = std::collections::HashSet::new();
        let mut next = Vec::new();
        let mut removed = Vec::new();
        for record in bytes.chunks_exact(16) {
            let id = Uuid::from_slice(record).unwrap();
            if id.is_nil() || !seen.insert(id) {
                removed.push(id);
                continue;
            }
            // Even two missing folders cannot justify an arbitrary UUID choice.
            if !suffixes.insert(folder(id)) {
                return Err(Error::SuffixCollision);
            }
            if read::directory_present(&self.root, id)? {
                next.push(id);
            } else {
                removed.push(id);
            }
        }
        Ok((next, removed))
    }
    pub(super) fn publish(&self, temp: &Path, next: &[Uuid]) -> Result<bool> {
        platform::replace(temp, &self.root.join(".pi"))?;
        let durable = self.sync_root();
        if read::playlist(&self.root)?.as_slice() != next {
            return Err(Error::Verification);
        }
        Ok(durable)
    }
    /// The volume barrier may fail after a successful replacement: one rule
    /// for publication and D33 commit (a warning, never a refusal). A
    /// directory fsync alone would not persist the replaced `.pi` entry on FAT.
    pub(super) fn sync_root(&self) -> bool {
        let sync = platform::sync_volume(&self.root);
        #[cfg(test)]
        let sync = if self.fail_publish_sync {
            Err(Error::Io)
        } else {
            sync
        };
        sync.is_ok()
    }
    fn valid_candidate(&self, path: &Path) -> Result<Vec<Uuid>> {
        let list = read::playlist_file(path)?;
        for id in &list {
            safe(&self.root.join(".content").join(folder(*id)), true)
                .map_err(|_| Error::MissingStory)?;
        }
        Ok(list)
    }
    fn restore_playlist(&self, metadata: &Metadata) -> Result<Outcome> {
        let state = read::recovery(&self.root)?.ok_or(Error::NoRecoveryRequired)?;
        let serial = metadata.serial().ok_or(Error::InvalidMetadata)?;
        let old = read::playlist(&self.root);
        let temps = read::temporaries(&self.root)?;
        // With a readable .pi, even a well-formed temporary may be truncated.
        // Preserve the current list and its directory entry without rewriting.
        let keep_playlist = state != RecoveryState::MissingPlaylist && old.is_ok();
        let candidate = if state == RecoveryState::MissingPlaylist && temps.len() == 1 {
            self.valid_candidate(&temps[0])
                .ok()
                .filter(|l| !l.is_empty())
        } else {
            None
        };
        let adopted = candidate.is_some();
        let next = if keep_playlist {
            old.clone()?
        } else if let Some(list) = candidate {
            list
        } else {
            let parent = self.backups.join(serial);
            safe(&parent, true).map_err(|_| Error::BackupFailed)?;
            let mut copies = backup_copies(&parent).map_err(|_| Error::BackupFailed)?;
            copies.sort();
            let latest = copies
                .iter()
                .rev()
                .find(|p| p.join(".pi").symlink_metadata().is_ok())
                .ok_or(Error::BackupFailed)?;
            self.valid_candidate(&latest.join(".pi"))?
        };
        self.backup(serial).map_err(|_| Error::BackupFailed)?;
        #[cfg(test)]
        if let Some(change) = self.after_recovery_backup {
            change(&self.root);
        }
        self.checkpoint()?;
        if read::metadata(&self.root)? != *metadata
            || read::playlist(&self.root) != old
            || read::recovery(&self.root)? != Some(state)
            || read::temporaries(&self.root)? != temps
        {
            return Err(Error::Changed);
        }
        if !keep_playlist {
            // Copy to a fresh file; never truncate a potential cluster alias.
            let temp = self
                .root
                .join(format!(".story-studio-pi-{}", Uuid::new_v4()));
            let mut file = fs::File::create_new(&temp)?;
            for id in &next {
                file.write_all(id.as_bytes())?;
            }
            file.sync_all()?;
            drop(file);
            if !self.publish(&temp, &next)? {
                // Keep recovery evidence until publication is durable.
                return Ok(Outcome::RestoredNotDurable);
            }
        }
        #[cfg(test)]
        if let Some(change) = self.before_recovery_cleanup {
            change(&self.root);
        }
        let mut removed_temporary = false;
        for path in temps {
            safe(&path, false)?;
            // Identical contents may share clusters with .pi on Linux FAT.
            // Retain pre-existing aliases. An adopted candidate was copied to
            // a fresh, durable .pi above and can now be removed.
            if !adopted && read::playlist_file(&path).is_ok_and(|list| list == next) {
                continue;
            }
            #[cfg(test)]
            if self.fail_cleanup {
                return Ok(Outcome::RestoredWithResidue);
            }
            if fs::remove_file(path).is_err() {
                return Ok(Outcome::RestoredWithResidue);
            }
            removed_temporary = true;
        }
        if removed_temporary {
            let sync = platform::sync_volume(&self.root);
            #[cfg(test)]
            let sync = if self.fail_cleanup_sync {
                Err(Error::Io)
            } else {
                sync
            };
            if sync.is_err() {
                return Ok(Outcome::RestoredWithResidue);
            }
        }
        Ok(Outcome::Complete)
    }
    pub(super) fn backup(&self, serial: &str) -> Result<()> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.backup_depth.load(SeqCst) > 0 && self.backup_taken.load(SeqCst) {
            return Ok(());
        }
        let parent = self.backups.join(serial);
        mkdir_safe(&parent)?;
        let mut copies = backup_copies(&parent)?;
        copies.sort();
        if let Some(last) = copies.last() {
            if [".md", ".pi", ".pi.hidden"]
                .iter()
                .all(|name| same_file(&self.root.join(name), &last.join(name)).unwrap_or(false))
            {
                self.backup_taken.store(true, SeqCst);
                return Ok(());
            }
        }
        // Preserve compatibility with the previous 39-digit names. No clock is
        // consulted; even a backwards wall clock cannot evict the new copy.
        let counter = copies
            .iter()
            .filter_map(|p| p.file_name()?.to_str()?.get(..39)?.parse::<u128>().ok())
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(Error::BackupFailed)?;
        let name = format!("{counter:039}-{}", Uuid::new_v4());
        let staging = parent.join(format!(".pending-{name}"));
        fs::create_dir(&staging)?;
        let result = (|| {
            for name in [".md", ".pi", ".pi.hidden"] {
                let source = self.root.join(name);
                if name == ".pi.hidden" || name == ".pi" {
                    match source.symlink_metadata() {
                        Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(e.into()),
                        Ok(_) => {}
                    }
                }
                safe(&source, false)?;
                // Opaque backup only: no parsing, hashing or logging crypto data.
                let mut input = fs::File::open(&source)?;
                let mut out = fs::File::create_new(staging.join(name))?;
                io::copy(&mut input, &mut out)?;
                out.sync_all()?;
                self.checkpoint()?;
            }
            platform::sync_dir(&staging)?;
            fs::rename(&staging, parent.join(&name))?;
            platform::sync_dir(&parent)?;
            self.checkpoint()?;
            // Only completed backups owned by this module; unknown local files
            // and interrupted pending backups are never mistaken for rotations.
            let mut copies = backup_copies(&parent)?;
            copies.sort();
            // A recovery snapshot may have no .pi. Keep the last usable D15
            // playlist across repeated interrupted restoration attempts.
            let last_playlist = copies
                .iter()
                .rev()
                .find(|p| p.join(".pi").is_file())
                .cloned();
            // D42: the newest copy identifying each story outside the list is
            // set aside, outside the ten. If that cannot be decided, keep all.
            let Ok(pinned) = self.pinned_copies(&copies) else {
                state::rotation_warning();
                return Ok(());
            };
            let pinned: Vec<_> = pinned
                .into_iter()
                .filter(|p| p != &parent.join(&name) && Some(p) != last_playlist.as_ref())
                .collect();
            let excess = (copies.len() - pinned.len()).saturating_sub(10);
            for path in copies
                .into_iter()
                .filter(|p| {
                    p != &parent.join(&name)
                        && Some(p) != last_playlist.as_ref()
                        && !pinned.contains(p)
                })
                .take(excess)
            {
                check_tree(&path)?;
                fs::remove_dir_all(path)?;
            }
            Ok(())
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        if result.is_ok() {
            self.backup_taken.store(true, SeqCst);
        }
        result
    }
    fn delete_tree(&self, path: &Path) -> Result<()> {
        // A stray file under a parked name is deleted as such (DeleteOrphan).
        if safe(path, false).is_ok() {
            self.checkpoint()?;
            fs::remove_file(path)?;
            return Ok(());
        }
        self.delete_tree_at(path, 0)
    }
    fn delete_tree_at(&self, path: &Path, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err(Error::UnsafePath);
        }
        safe(path, true)?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                self.delete_tree_at(&entry.path(), depth + 1)?;
            } else {
                safe(&entry.path(), false)?;
                self.checkpoint()?;
                fs::remove_file(entry.path())?;
            }
        }
        self.checkpoint()?;
        fs::remove_dir(path)?;
        Ok(())
    }
}
/// A completed gesture whose final volume barrier failed: never `Complete`.
pub(super) fn not_durable(outcome: Outcome, install: bool, restore: bool) -> Outcome {
    match outcome {
        Outcome::Complete if install => Outcome::InstalledNotDurable,
        Outcome::Complete if restore => Outcome::RestoredNotDurable,
        Outcome::Complete => Outcome::StateWarning,
        // Residue: the list was durable, the cleanup and now the barrier not.
        Outcome::RestoredWithResidue => Outcome::RestoredNotDurable,
        Outcome::Repaired {
            kept,
            removed,
            empty,
            truncated,
        } => Outcome::RepairedNotDurable {
            kept,
            removed,
            empty,
            truncated,
        },
        other => other,
    }
}
pub(super) fn mkdir_safe(path: &Path) -> Result<()> {
    if path.symlink_metadata().is_ok() {
        return safe(path, true);
    }
    let parent = path.parent().ok_or(Error::UnsafePath)?;
    mkdir_safe(parent)?;
    fs::create_dir(path)?;
    safe(path, true)
}
pub(super) fn check_tree(path: &Path) -> Result<()> {
    check_tree_at(path, 0)
}
fn check_tree_at(path: &Path, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(Error::UnsafePath);
    }
    safe(path, true)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            check_tree_at(&entry.path(), depth + 1)?;
        } else {
            safe(&entry.path(), false)?;
        }
    }
    Ok(())
}

pub(super) fn backup_copies(parent: &Path) -> Result<Vec<PathBuf>> {
    let mut copies = Vec::new();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let n = entry.file_name().to_string_lossy().into_owned();
        if n.len() == 76
            && n.as_bytes()[..39].iter().all(u8::is_ascii_digit)
            && n.as_bytes()[39] == b'-'
            && Uuid::parse_str(&n[40..]).is_ok()
        {
            safe(&entry.path(), true)?;
            copies.push(entry.path());
        }
    }
    Ok(copies)
}

fn same_file(a: &Path, b: &Path) -> Result<bool> {
    use std::io::Read;
    let exists = |p: &Path| -> Result<bool> {
        match p.symlink_metadata() {
            Ok(_) => {
                safe(p, false)?;
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    };
    let (ea, eb) = (exists(a)?, exists(b)?);
    if !ea || !eb {
        return Ok(ea == eb);
    }
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (
        io::BufReader::new(fs::File::open(a)?),
        io::BufReader::new(fs::File::open(b)?),
    );
    let (mut x, mut y) = ([0u8; 8192], [0u8; 8192]);
    loop {
        let n = a.read(&mut x)?;
        if n == 0 {
            return Ok(b.read(&mut y)? == 0);
        }
        b.read_exact(&mut y[..n])?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
    }
}
