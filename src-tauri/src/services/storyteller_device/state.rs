//! D33: playlist authority and recoverable moves outside `.content/`.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
#[derive(Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct State {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub hidden: Vec<Hidden>,
    #[serde(default)]
    pub sent: std::collections::BTreeMap<String, u64>,
    /// D42: stories removed by an explicit gesture whose folder may survive an
    /// interrupted deletion. Such a folder is never a « damaged list » cause.
    /// Kept only while its folder is still in .content outside the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Hidden {
    pub uuid: String,
    pub position: usize,
    #[serde(default)]
    pub folder: String,
    /// Third-party hidden entries stay in .content until explicit Hide.
    #[serde(default)]
    pub external: bool,
    /// Set by an explicit Hide until its folder is parked. Only this entry may
    /// replace an existing parked copy; any other gesture leaves it intact.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hiding: bool,
}
#[derive(Serialize, Deserialize)]
struct Record {
    version: u8,
    state: State,
}
const MAX: u64 = 1024 * 1024;
fn load_record(root: &Path, name: &str) -> Result<State> {
    let read = || -> Result<State> {
        safe(&root.join(cards::DIRECTORY), true)?;
        let path = root.join(cards::DIRECTORY).join(name);
        safe(&path, false)?;
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX {
            return Err(Error::InvalidCard);
        }
        let mut record: Record = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidCard)?;
        if record.version != 1 {
            return Err(Error::FutureCard);
        }
        let mut seen = std::collections::HashSet::new();
        record
            .state
            .hidden
            .retain(|h| Uuid::parse_str(&h.uuid).is_ok_and(|id| !id.is_nil() && seen.insert(id)));
        Ok(record.state)
    };
    read()
}
pub(super) fn load(root: &Path) -> State {
    let mut state = load_record(root, "device.json").unwrap_or_default();
    // A separate intent preserves the UUID across a cut after .pi publication.
    // It is never treated as authoritative over the current playlist.
    if let Ok(intent) = load_record(root, "visibility.json") {
        for h in intent.hidden {
            if let Some(saved) = state.hidden.iter_mut().find(|v| v.uuid == h.uuid) {
                // The explicit intent is newer than durable device memory;
                // in particular Hide must override a third-party hidden entry.
                *saved = h;
            } else {
                state.hidden.push(h);
            }
        }
    }
    state
}
pub(super) fn save(root: &Path, state: &State) -> Result<()> {
    save_record(root, "device.json", state)
}
fn save_record(root: &Path, name: &str, state: &State) -> Result<()> {
    safe(root, true)?;
    let dir = root.join(cards::DIRECTORY);
    if !dir.try_exists()? {
        fs::create_dir(&dir)?;
        platform::sync_volume(root)?;
    }
    safe(&dir, true)?;
    let target = dir.join(name);
    if target.try_exists()? {
        safe(&target, false)?;
        // Never downgrade future data, even though reading it is tolerant.
        if fs::metadata(&target)?.len() > MAX {
            return Err(Error::InvalidCard);
        }
        let bytes = fs::read(&target)?;
        if bytes.len() as u64 > MAX {
            return Err(Error::InvalidCard);
        }
        // A file emptied by a disk check (0 bytes, or zeros only) holds no
        // data to protect: it is read as absent and rewritten.
        if bytes.iter().any(|b| *b != 0) {
            let record: Record = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidCard)?;
            if record.version != 1 {
                return Err(Error::FutureCard);
            }
        }
    }
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"state":state}))
        .map_err(|_| Error::InvalidCard)?;
    if bytes.len() as u64 > MAX {
        return Err(Error::InvalidCard);
    }
    let temp = dir.join(format!(".pending-{}", Uuid::new_v4()));
    let mut file = fs::File::create_new(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    platform::replace(&temp, &target)?;
    platform::sync_volume(&dir)?;
    Ok(())
}
pub(super) fn full_order(visible: &[Uuid], state: &State) -> Vec<Uuid> {
    let mut order = visible.to_vec();
    let mut hidden: Vec<_> = state.hidden.iter().collect();
    hidden.sort_by_key(|v| v.position);
    for entry in hidden {
        if let Ok(id) = Uuid::parse_str(&entry.uuid) {
            if !order.contains(&id) {
                order.insert(entry.position.min(order.len()), id);
            }
        }
    }
    order
}
pub(crate) fn story_path(root: &Path, id: Uuid) -> PathBuf {
    let listed = read::playlist(root).is_ok_and(|list| list.contains(&id));
    let entry = if listed {
        None
    } else {
        load(root)
            .hidden
            .into_iter()
            .find(|h| Uuid::parse_str(&h.uuid).is_ok_and(|v| v == id))
    };
    path_for(root, id, entry.as_ref())
}
pub(super) fn parked_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(cards::DIRECTORY)
        .join("masquees")
        .join(folder(id))
}
/// Authoritative copy of a story. Once its Hide completed, the parked copy wins:
/// a later folder of the same name in .content is an orphan, never a source.
fn path_for(root: &Path, id: Uuid, entry: Option<&Hidden>) -> PathBuf {
    let parked = parked_path(root, id);
    let content = root.join(".content").join(folder(id));
    if entry.is_some_and(|h| !h.external && !h.hiding) && safe(&parked, true).is_ok() {
        return parked;
    }
    if safe(&content, true).is_ok() {
        content
    } else {
        parked
    }
}
/// .pi always wins. Accept legacy/in-flight folders still in .content so they
/// remain actionable after a cut; the next writing gesture finishes their move.
pub(super) fn normalized(root: &Path, visible: &[Uuid]) -> State {
    let mut state = load(root);
    if let Ok(ids) = read::playlist_file(&root.join(".pi.hidden")) {
        for id in ids {
            if !state.hidden.iter().any(|h| h.uuid == id.to_string()) {
                state.hidden.push(Hidden {
                    uuid: id.to_string(),
                    folder: folder(id),
                    external: true,
                    hiding: false,
                    position: visible.len() + state.hidden.len(),
                });
            }
        }
    }
    state.hidden.retain_mut(|h| {
        let Ok(id) = Uuid::parse_str(&h.uuid) else {
            return false;
        };
        if visible.contains(&id) || safe(&path_for(root, id, Some(h)), true).is_err() {
            return false;
        }
        if !h.folder.is_empty() && h.folder != folder(id) {
            return false;
        }
        h.uuid = id.to_string();
        h.folder = folder(id);
        true
    });
    state.removed.retain(|id| {
        Uuid::parse_str(id).is_ok_and(|id| {
            !visible.contains(&id) && safe(&root.join(".content").join(folder(id)), true).is_ok()
        })
    });
    state
}
pub(super) fn merge_inventory(
    root: &Path,
    stories: &mut Vec<Story>,
    catalogue: Option<&(impl OfficialCatalogue + ?Sized)>,
) {
    let visible = read::playlist(root).unwrap_or_default();
    let state = normalized(root, &visible);
    for h in &state.hidden {
        let id = Uuid::parse_str(&h.uuid).unwrap();
        if let Some(s) = stories.iter_mut().find(|s| s.uuid == Some(id)) {
            s.uuid = Some(id);
            s.probable_hidden = true;
            s.parking_pending =
                h.hiding && safe(&root.join(".content").join(folder(id)), true).is_ok();
        } else {
            let (recognized, degraded) = recognizes_official(&h.uuid, catalogue);
            stories.push(Story {
                uuid: Some(id),
                folder: folder(id),
                listed: false,
                complete: read::complete(
                    &path_for(root, id, Some(h)),
                    read::metadata(root).map(|m| m.version).unwrap_or(0),
                ),
                directory_present: true,
                official: official_state(recognized, degraded),
                probable_hidden: true,
                parking_pending: h.hiding
                    && safe(&root.join(".content").join(folder(id)), true).is_ok(),
            });
        }
    }
    let parked = root.join(cards::DIRECTORY).join("masquees");
    if safe(&parked, true).is_ok() {
        if let Ok(entries) = fs::read_dir(&parked) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let directory = safe(&entry.path(), true).is_ok();
                // A stray file under our name is ours to offer for deletion.
                let file = valid_folder(&name) && safe(&entry.path(), false).is_ok();
                if (valid_folder(&name) || install_temporary(&name))
                    && (directory || file)
                    && !state.hidden.iter().any(|h| {
                        h.folder == name
                            && Uuid::parse_str(&h.uuid)
                                .is_ok_and(|id| path_for(root, id, Some(h)) == entry.path())
                    })
                {
                    stories.push(Story {
                        uuid: None,
                        folder: format!("parked:{name}"),
                        listed: false,
                        complete: directory
                            && read::complete(
                                &entry.path(),
                                read::metadata(root).map(|m| m.version).unwrap_or(0),
                            ),
                        directory_present: true,
                        official: OfficialProvenance::Unknown,
                        probable_hidden: false,
                        parking_pending: false,
                    });
                }
            }
        }
    }
    let order = full_order(&visible, &state);
    stories.sort_by_key(|s| {
        s.uuid
            .and_then(|id| order.iter().position(|v| *v == id))
            .unwrap_or(usize::MAX)
    });
}

pub(super) enum Phase {
    Prepare(Option<(Uuid, bool)>),
    Commit,
    CommitHide(Uuid),
}
impl Device {
    /// The only D33 transition: projection of full order, folder movement and
    /// durable memory. Prepare precedes .pi replacement; Commit follows it.
    /// Hide writes a recovery intent first, removes .pi, then parks the folder.
    /// Show restores the folder before publishing its entry (E12).
    pub(super) fn transition(
        &self,
        mut order: Vec<Uuid>,
        mut state: State,
        phase: Phase,
        metadata: &Metadata,
    ) -> Result<(Vec<Uuid>, State)> {
        match phase {
            Phase::Prepare(change) => {
                if let Some((id, hidden)) = change {
                    let content = self.root.join(".content").join(folder(id));
                    if hidden {
                        let position = order
                            .iter()
                            .position(|v| *v == id)
                            .ok_or(Error::MissingStory)?;
                        if let Some(h) = state.hidden.iter_mut().find(|h| h.uuid == id.to_string())
                        {
                            h.external = false;
                            h.hiding = true;
                        } else {
                            safe(&content, true)?;
                            state.hidden.push(Hidden {
                                uuid: id.to_string(),
                                folder: folder(id),
                                external: false,
                                hiding: true,
                                position,
                            });
                        }
                        let target = parked_path(&self.root, id);
                        if target.symlink_metadata().is_ok() {
                            super::writes::check_tree(&target)?;
                            // Never replace a parked copy with an incomplete one.
                            if safe(&content, true).is_ok()
                                && !read::complete(&content, metadata.version)
                            {
                                return Err(Error::IncompleteStory);
                            }
                        }
                        // Probe the cross-directory rename without touching the listed payload.
                        let parked = self.root.join(cards::DIRECTORY).join("masquees");
                        super::writes::mkdir_safe(&parked).map_err(parking)?;
                        if safe(&content, true).is_ok() {
                            self.probe_parking(&parked)?;
                        }
                        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
                            .map_err(|_| Error::BackupFailed)?;
                        save_record(&self.root, "visibility.json", &state)?;
                    } else {
                        let index = state
                            .hidden
                            .iter()
                            .position(|h| h.uuid == id.to_string())
                            .ok_or(Error::HiddenStory)?;
                        let source = path_for(&self.root, id, Some(&state.hidden[index]));
                        if !read::complete(&source, metadata.version) {
                            return Err(Error::IncompleteStory);
                        }
                        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
                            .map_err(|_| Error::BackupFailed)?;
                        let restored = source != content;
                        let result = (|| -> Result<()> {
                            if restored {
                                safe(&self.root.join(".content"), true)?;
                                if content.symlink_metadata().is_ok() {
                                    return Err(Error::Duplicate { position: None });
                                }
                                platform::move_dir(&source, &content)?;
                                // One barrier covers both directories of the move.
                                platform::sync_volume(&self.root)?;
                            }
                            self.checkpoint()
                        })();
                        if let Err(error) = result {
                            if restored && content.is_dir() && !source.exists() {
                                // Keep the original error; a failed return is logged.
                                unpark_back(&content, &source);
                            }
                            return Err(error);
                        }
                        state.hidden.remove(index);
                    }
                }
                for h in &mut state.hidden {
                    h.position = order
                        .iter()
                        .position(|id| h.uuid == id.to_string())
                        .ok_or(Error::InvalidOrder)?;
                }
                order.retain(|id| !state.hidden.iter().any(|h| h.uuid == id.to_string()));
            }
            Phase::Commit | Phase::CommitHide(_) => {
                let gesture = match phase {
                    Phase::CommitHide(id) => Some(id),
                    _ => None,
                };
                let visible = read::playlist(&self.root)?;
                if !state.hidden.is_empty() || !load(&self.root).hidden.is_empty() {
                    // A previous publication may have returned a durability warning.
                    // Persist the file before relying on .pi to move a payload or
                    // discard recovery memory. Directory fsync follows publish:
                    // unsupported means a warning, never a permanent refusal.
                    platform::sync_file(&self.root.join(".pi"))?;
                    if !self.sync_root() {
                        durability_warning();
                    }
                    if read::playlist(&self.root)? != visible {
                        return Err(Error::Changed);
                    }
                }
                let mut unparked = false;
                for h in &mut state.hidden {
                    if h.external {
                        continue;
                    }
                    let id = Uuid::parse_str(&h.uuid).map_err(|_| Error::InvalidCard)?;
                    if visible.contains(&id) {
                        return Err(Error::Changed);
                    }
                    let content = self.root.join(".content").join(folder(id));
                    if safe(&content, true).is_err() {
                        h.hiding = false;
                        continue;
                    }
                    let target = parked_path(&self.root, id);
                    // Only an explicit Hide (or its resumption) replaces a parked
                    // copy, and only with a complete payload. Otherwise the parked
                    // copy stays authoritative and .content/<folder> is an orphan.
                    if target.symlink_metadata().is_ok()
                        && (!h.hiding || !read::complete(&content, metadata.version))
                    {
                        h.hiding = false;
                        continue;
                    }
                    match self.park(id, &content, &target) {
                        Ok(()) => h.hiding = false,
                        // The folder stays in .content and the state knows it.
                        Err(Error::ParkingFailed) => {
                            if gesture == Some(id) {
                                unparked = true;
                            } else {
                                unrelated_parking::<()>(Err(Error::ParkingFailed))?;
                            }
                        }
                        Err(error) => return Err(error),
                    }
                }
                // Reconcile third-party hidden lists with exactly the state
                // exposed by inspection, including explicit Remove and Show.
                if let Ok(old) = read::playlist_file(&self.root.join(".pi.hidden")) {
                    let next: Vec<_> = old
                        .iter()
                        .copied()
                        .filter(|id| state.hidden.iter().any(|h| h.uuid == id.to_string()))
                        .collect();
                    if old != next {
                        let temp = self
                            .root
                            .join(cards::DIRECTORY)
                            .join(format!(".pending-{}", Uuid::new_v4()));
                        super::writes::mkdir_safe(&self.root.join(cards::DIRECTORY))?;
                        let mut file = fs::File::create_new(&temp)?;
                        for id in next {
                            file.write_all(id.as_bytes())?;
                        }
                        file.sync_all()?;
                        drop(file);
                        platform::replace(&temp, &self.root.join(".pi.hidden"))?;
                        if !self.sync_root() {
                            durability_warning();
                        }
                    }
                }
                // A pending Hide stays durable in device.json (hiding flag), so
                // the recovery intent is no longer needed even if parking failed.
                let target = self.root.join(cards::DIRECTORY).join("device.json");
                let unchanged = if target.try_exists()? {
                    load_record(&self.root, "device.json").is_ok_and(|saved| saved == state)
                } else {
                    state == State::default()
                };
                if !unchanged {
                    save(&self.root, &state)?;
                }
                let intent = self.root.join(cards::DIRECTORY).join("visibility.json");
                if intent.try_exists()? {
                    safe(&intent, false)?;
                    fs::remove_file(&intent)?;
                    platform::sync_volume(intent.parent().ok_or(Error::UnsafePath)?)?;
                }
                if unparked {
                    return Err(Error::ParkingFailed);
                }
            }
        }
        Ok((order, state))
    }
    /// Moves one hidden folder from .content to masquees/. Failures before the
    /// move leave the payload in .content and any previous parked copy intact.
    fn park(&self, id: Uuid, content: &Path, target: &Path) -> Result<()> {
        let parked = target.parent().ok_or(Error::UnsafePath)?;
        super::writes::mkdir_safe(parked).map_err(parking)?;
        // Revalidate and flush the authoritative removal before moving (E12).
        platform::sync_file(&self.root.join(".pi"))?;
        if read::playlist(&self.root)?.contains(&id) {
            return Err(Error::Changed);
        }
        let previous = if target.symlink_metadata().is_ok() {
            super::writes::check_tree(target).map_err(|_| Error::ParkingFailed)?;
            let previous = parked.join(format!(".story-studio-install-{}", Uuid::new_v4()));
            platform::move_dir(target, &previous).map_err(parking)?;
            Some(previous)
        } else {
            None
        };
        let moved = self
            .checkpoint()
            .and_then(|()| platform::move_dir(content, target));
        if let Err(error) = moved {
            if let Some(previous) = previous {
                if platform::move_dir(&previous, target).is_err() {
                    // The previous copy stays visible as a deletable parked orphan.
                    cleanup_warning();
                }
            }
            return Err(parking(error));
        }
        // One barrier covers .content and masquees/.
        if platform::sync_volume(&self.root).is_err() {
            durability_warning();
        }
        if let Some(previous) = previous {
            if fs::remove_dir_all(previous).is_err() {
                cleanup_warning();
            }
            if platform::sync_volume(parked).is_err() {
                durability_warning();
            }
        }
        Ok(())
    }
    /// An empty probe folder tests the rename into masquees/ before Hide
    /// publishes anything. Whatever copy of the probe remains is removed.
    fn probe_parking(&self, parked: &Path) -> Result<()> {
        let probe = parked.join(format!(".story-studio-install-{}", Uuid::new_v4()));
        let source = self
            .root
            .join(".content")
            .join(format!(".story-studio-install-{}", Uuid::new_v4()));
        fs::create_dir(&source).map_err(|_| Error::ParkingFailed)?;
        let result =
            platform::move_dir(&source, &probe).and_then(|()| platform::move_dir(&probe, &source));
        let mut residue = false;
        for path in [&source, &probe] {
            if path.symlink_metadata().is_ok() && fs::remove_dir(path).is_err() {
                residue = true;
            }
        }
        if residue {
            cleanup_warning();
        }
        result.map_err(parking)
    }
}
/// Parking is impossible (e.g. masquees/ not writable): typed, so the user is
/// told to show the story again; other errors keep their meaning.
fn parking(error: Error) -> Error {
    if error == Error::Io {
        Error::ParkingFailed
    } else {
        error
    }
}
pub(super) fn unpark_back(content: &Path, parked: &Path) {
    // One barrier covers both parents of the move.
    let result = platform::move_dir(content, parked)
        .and_then(|()| platform::sync_volume(content.parent().ok_or(Error::UnsafePath)?));
    if result.is_err() {
        cleanup_warning();
    }
}
/// A Hide that cannot park its folder leaves it in .content, known to the
/// state: only that Hide reports it; unrelated gestures are not blocked.
pub(super) fn unrelated_parking<T>(result: Result<T>) -> Result<()> {
    match result {
        Ok(_) => Ok(()),
        Err(Error::ParkingFailed) => {
            log::warn!(target: "storyteller_device", "A hidden story could not be parked");
            Ok(())
        }
        Err(error) => Err(error),
    }
}
impl Device {
    pub(crate) fn name(&self) -> Result<String> {
        if let Some(name) = load(&self.root).name {
            return Ok(name);
        }
        let md = read::metadata(&self.root)?;
        let serial = md.serial().unwrap_or("");
        Ok(format!("Lunii {serial}").trim().into())
    }
    pub(crate) fn rename(&self, name: String) -> Result<()> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        if name.trim().is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control)
        {
            return Err(Error::InvalidName);
        }
        if !NativeVolumes.writable(&self.root)? {
            return Err(Error::ReadOnly);
        }
        let metadata = read::metadata(&self.root)?;
        if let Some(e) = metadata.read_only {
            return Err(e);
        }
        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
            .map_err(|_| Error::BackupFailed)?;
        let visible = read::playlist(&self.root)?;
        let mut state = normalized(&self.root, &visible);
        state.name = Some(name.trim().into());
        let result = unrelated_parking(self.transition(visible, state, Phase::Commit, &metadata));
        let durable = self.sync_volume();
        result.and(durable)
    }
    pub(crate) fn sent_at(&self, id: Uuid) -> Option<u64> {
        load(&self.root).sent.get(&id.to_string()).copied()
    }
    pub(crate) fn mark_sent(&self, id: Uuid) -> Result<()> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        if !NativeVolumes.writable(&self.root)? {
            return Err(Error::ReadOnly);
        }
        let metadata = read::metadata(&self.root)?;
        if let Some(e) = metadata.read_only {
            return Err(e);
        }
        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
            .map_err(|_| Error::BackupFailed)?;
        let visible = read::playlist(&self.root)?;
        let mut state = normalized(&self.root, &visible);
        state.sent.insert(
            id.to_string(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| Error::Io)?
                .as_secs(),
        );
        let result = unrelated_parking(self.transition(visible, state, Phase::Commit, &metadata));
        let durable = self.sync_volume();
        result.and(durable)
    }
}

pub(super) fn cleanup_warning() {
    log::warn!(target: "storyteller_device", "Device cleanup could not be completed");
}
/// Windows refused to open the volume root: no barrier, the gesture goes on.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn barrier_unavailable_warning() {
    log::warn!(target: "storyteller_device", "Volume flush unavailable: root could not be opened");
}
/// A card copied from the catalogue during inspection is not yet durable.
pub(super) fn card_durability_warning() {
    log::warn!(target: "storyteller_device", "Card publication could not be made durable");
}
pub(super) fn durability_warning() {
    log::warn!(target: "storyteller_device", "Device directory synchronization failed");
}
/// D42: copies set aside could not be determined; the rotation kept everything.
pub(super) fn rotation_warning() {
    log::warn!(target: "storyteller_device", "Backup rotation skipped: copies set aside unknown");
}
