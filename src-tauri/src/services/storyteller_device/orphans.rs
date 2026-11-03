//! Full identity and order of orphans, read from the D15 copies of `.pi`.
//! Read-only: a copy is never restored here, never written, never decrypted.
//! D42: the copy that identifies the stories outside the list is set aside.
use super::*;
use std::collections::BTreeSet;

/// Readable lists of the D15 copies of one storyteller, newest first.
/// Empty or damaged copies are ignored; any reading failure yields nothing.
pub(crate) struct BackupLists(Vec<Vec<Uuid>>);

/// Independent candidates for an orphan's full UUID: D15 copies and sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Identity {
    Unknown,
    Known(Uuid),
    /// Two candidates disagree: no identity, and none may be supplied.
    Contradicted,
}

impl Device {
    pub(crate) fn backup_lists(&self) -> BackupLists {
        let lists = (|| -> Result<Vec<Vec<Uuid>>> {
            let mut copies = self.backup_copy_paths()?;
            copies.reverse();
            Ok(copies
                .iter()
                .filter_map(|copy| read::playlist_file(&copy.join(".pi")).ok())
                .filter(|list| !list.is_empty())
                .collect())
        })();
        BackupLists(lists.unwrap_or_default())
    }
    /// Completed D15 copies of this storyteller, oldest first.
    fn backup_copy_paths(&self) -> Result<Vec<PathBuf>> {
        let metadata = read::metadata(&self.root)?;
        let parent = self
            .backups
            .join(metadata.serial().ok_or(Error::InvalidMetadata)?);
        safe(&parent, true)?;
        let mut copies = writes::backup_copies(&parent)?;
        copies.sort();
        Ok(copies)
    }
    /// Identity of an orphan folder (`XXXXXXXX` or `parked:XXXXXXXX`): every
    /// D15 copy that listed this folder and every validated sidecar must agree.
    /// A suffix alone never invents an identity.
    pub(crate) fn orphan_identity(&self, lists: &BackupLists, name: &str) -> Identity {
        let name = name.strip_prefix("parked:").unwrap_or(name);
        let mut found: BTreeSet<Uuid> = lists
            .0
            .iter()
            .flatten()
            .copied()
            .filter(|id| folder(*id) == name)
            .collect();
        found.extend(self.orphan_card_uuids(name));
        match found.len() {
            0 => Identity::Unknown,
            1 => found.pop_first().map_or(Identity::Unknown, Identity::Known),
            _ => Identity::Contradicted,
        }
    }
    #[cfg(test)]
    pub(crate) fn orphan_uuid(&self, lists: &BackupLists, name: &str) -> Option<Uuid> {
        match self.orphan_identity(lists, name) {
            Identity::Known(id) => Some(id),
            _ => None,
        }
    }
    /// A UUID supplied for an orphan (e.g. from the catalogue) is refused when
    /// the device's own candidates name another one or contradict each other.
    pub(super) fn check_orphan_uuid(
        &self,
        lists: &BackupLists,
        name: &str,
        id: Uuid,
    ) -> Result<()> {
        match self.orphan_identity(lists, name) {
            Identity::Unknown => Ok(()),
            Identity::Known(known) if known == id => Ok(()),
            _ => Err(Error::UnknownUuid),
        }
    }
    /// D42: the copies explain a lost list, and no orphan is a story whose
    /// explicit removal may have been cut before its folder was deleted.
    pub(crate) fn list_lost(
        &self,
        lists: &BackupLists,
        orphans: &[Uuid],
        current: &[Uuid],
    ) -> bool {
        let removed = state::normalized(&self.root, current).removed;
        lists.explain_loss(orphans, current)
            && !orphans.iter().any(|id| removed.contains(&id.to_string()))
    }
    /// Listed or hidden: the story belongs to the list. Anything else is an
    /// orphan, whose cover is served strictly read-only.
    pub(crate) fn lists_story(&self, id: Uuid) -> bool {
        let _guard = platform::access_guard();
        let Ok(visible) = read::playlist(&self.root) else {
            return false;
        };
        visible.contains(&id)
            || state::normalized(&self.root, &visible)
                .hidden
                .iter()
                .any(|h| h.uuid == id.to_string())
    }
    /// D42: for each folder outside the list (in `.content` or parked, hidden
    /// stories excepted), the newest copy whose `.pi` names it.
    pub(super) fn pinned_copies(&self, copies: &[PathBuf]) -> Result<Vec<PathBuf>> {
        let visible = read::playlist(&self.root).unwrap_or_default();
        let hidden = state::normalized(&self.root, &visible).hidden;
        let mut known: BTreeSet<String> = visible.iter().map(|id| folder(*id)).collect();
        known.extend(hidden.iter().map(|h| h.folder.clone()));
        let mut outside = BTreeSet::new();
        for directory in [
            self.root.join(".content"),
            self.root.join(cards::DIRECTORY).join("masquees"),
        ] {
            if directory.symlink_metadata().is_err() {
                continue;
            }
            safe(&directory, true)?;
            for entry in fs::read_dir(directory)? {
                let name = entry?.file_name().to_string_lossy().into_owned();
                if valid_folder(&name) && !known.contains(&name) {
                    outside.insert(name);
                }
            }
        }
        let mut pinned = Vec::new();
        for copy in copies.iter().rev() {
            if outside.is_empty() {
                break;
            }
            let Ok(list) = read::playlist_file(&copy.join(".pi")) else {
                continue;
            };
            let before = outside.len();
            for id in list {
                outside.remove(&folder(id));
            }
            if outside.len() != before {
                pinned.push(copy.clone());
            }
        }
        Ok(pinned)
    }
}

impl BackupLists {
    /// Order of the most recent copy that lists each story; stories that no
    /// copy lists follow, in the given order.
    pub(super) fn order(&self, ids: &[Uuid]) -> Vec<Uuid> {
        let rank = |id: &Uuid| {
            self.0
                .iter()
                .enumerate()
                .find_map(|(copy, list)| list.iter().position(|v| v == id).map(|at| (copy, at)))
        };
        let mut known: Vec<_> = ids
            .iter()
            .filter_map(|id| rank(id).map(|r| (r, *id)))
            .collect();
        known.sort();
        known
            .into_iter()
            .map(|(_, id)| id)
            .chain(ids.iter().filter(|id| rank(id).is_none()).copied())
            .collect()
    }
    /// D42 « liste abîmée »: the newest copy listing every orphan and every
    /// entry of the current list (an empty or shortened version of it), with
    /// no newer copy that already listed the current entries without one of
    /// these orphans. Such a newer copy shows the list was shortened on
    /// purpose before (e.g. a removal, then an interrupted send of the same
    /// story). Empty copies carry no evidence: they are the damage itself.
    pub(crate) fn explain_loss(&self, orphans: &[Uuid], current: &[Uuid]) -> bool {
        if orphans.is_empty() {
            return false;
        }
        let Some(covering) = self
            .0
            .iter()
            .position(|list| orphans.iter().chain(current).all(|id| list.contains(id)))
        else {
            return false;
        };
        !self.0[..covering].iter().any(|list| {
            current.iter().all(|id| list.contains(id))
                && orphans.iter().any(|id| !list.contains(id))
        })
    }
}
