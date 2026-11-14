//! Mounted storyteller management, from specification-conteuse §§1,2,3,5,7.
//! No transport crypto, imports, IPC or automatic orphan repair.
pub(crate) mod cards;
pub(crate) mod flam;
mod install;
mod orphans;
pub(crate) use orphans::Identity;
pub(crate) mod platform;
mod preview;
mod read;
mod state;
pub(crate) use state::story_path;
#[cfg(test)]
mod tests;
mod writes;

use crate::domain::official_provenance::{recognizes_official, OfficialProvenance};
use crate::services::official_packs::OfficialCatalogue;
use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) type Result<T> = std::result::Result<T, Error>;
/// Headless errors: IPC must map these to translated messages before exposure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    Io,
    Duplicate {
        position: Option<usize>,
    },
    NoSpace {
        missing_bytes: u64,
    },
    ReadOnly,
    FlamReadOnly,
    Busy,
    Cancelled,
    InvalidName,
    InvalidCard,
    FutureCard,
    OfficialStory,
    UnsafePath,
    UnknownFormat,
    InvalidMetadata,
    MetadataSize,
    InvalidPlaylist,
    PlaylistDamaged,
    PlaylistTooLarge,
    ContentUnavailable,
    NoRepairRequired,
    SuffixCollision,
    InvalidOrder,
    MissingStory,
    UnknownUuid,
    IncompleteStory,
    UnreadableStory,
    BackupFailed,
    Changed,
    Verification,
    RecoveryRequired,
    NoRecoveryRequired,
    HiddenStory,
    /// A hidden story could not be moved to masquees/; it stays in .content.
    ParkingFailed,
    Interrupted,
    Disconnected,
}
impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

impl From<Error> for crate::support::user_message::UserMessage {
    fn from(error: Error) -> Self {
        use crate::support::user_message::codes;
        match error {
            Error::Duplicate { position } => {
                return Self::new(codes::STORYTELLER_STORY_DUPLICATE).param(
                    "position",
                    position
                        .map(|v| v + 1)
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                )
            }
            Error::NoSpace { missing_bytes } => {
                if missing_bytes == u64::MAX {
                    return Self::new(codes::STORYTELLER_NO_SPACE_UNKNOWN);
                }
                return Self::new(codes::STORYTELLER_NO_SPACE).param("missingBytes", missing_bytes);
            }
            _ => {}
        }
        Self::new(match error {
            Error::HiddenStory => codes::STORYTELLER_STORY_HIDDEN,
            Error::ParkingFailed => codes::STORYTELLER_STORY_PARKING_FAILED,
            Error::MissingStory => codes::STORYTELLER_STORY_MISSING,
            Error::IncompleteStory => codes::STORYTELLER_STORY_INCOMPLETE,
            Error::UnreadableStory => codes::STORYTELLER_STORY_UNREADABLE,
            Error::Changed => codes::STORYTELLER_DEVICE_CHANGED,
            Error::InvalidOrder => codes::STORYTELLER_INVALID_ORDER,
            Error::Disconnected => codes::STORYTELLER_SEND_DISCONNECTED,
            Error::ReadOnly => codes::STORYTELLER_VOLUME_READ_ONLY,
            Error::FlamReadOnly => codes::STORYTELLER_FLAM_READ_ONLY,
            Error::UnknownFormat | Error::InvalidMetadata | Error::MetadataSize => {
                codes::STORYTELLER_READ_ONLY
            }
            Error::Busy => codes::STORYTELLER_DEVICE_BUSY,
            Error::Cancelled => codes::STORYTELLER_SEND_CANCELLED,
            Error::InvalidName => codes::STORYTELLER_INVALID_NAME,
            Error::OfficialStory => codes::STORYTELLER_OFFICIAL_REFUSED,
            Error::PlaylistTooLarge => codes::STORYTELLER_PLAYLIST_TOO_LARGE,
            Error::ContentUnavailable => codes::STORYTELLER_CONTENT_UNAVAILABLE,
            Error::PlaylistDamaged => codes::STORYTELLER_PLAYLIST_DAMAGED,
            Error::NoRepairRequired => codes::STORYTELLER_PLAYLIST_HEALTHY,
            Error::SuffixCollision => codes::STORYTELLER_PLAYLIST_COLLISION,
            Error::BackupFailed => codes::STORYTELLER_BACKUP_FAILED,
            Error::RecoveryRequired => codes::STORYTELLER_PLAYLIST_RECOVERY_REQUIRED,
            _ => codes::STORYTELLER_WRITE_FAILED,
        })
    }
}

/// Debug deliberately omits the serial (including for unknown/invalid devices).
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub version: u16,
    pub firmware: Option<String>,
    serial: Option<String>,
    pub read_only: Option<Error>,
}
impl Metadata {
    pub(crate) fn serial(&self) -> Option<&str> {
        self.serial.as_deref()
    }
}
impl fmt::Debug for Metadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Metadata")
            .field("version", &self.version)
            .field("firmware", &self.firmware)
            .field("read_only", &self.read_only)
            .finish()
    }
}
#[derive(Debug)]
pub(crate) struct Story {
    pub uuid: Option<Uuid>,
    pub folder: String,
    pub listed: bool,
    pub complete: bool,
    pub directory_present: bool,
    pub official: OfficialProvenance,
    pub probable_hidden: bool,
    pub parking_pending: bool,
}
#[derive(Debug)]
pub(crate) struct Inventory {
    pub metadata: Metadata,
    pub stories: Vec<Story>,
    pub story_count: usize,
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub recovery: Option<RecoveryState>,
    pub recognition_degraded: bool,
    pub playlist_error: Option<Error>,
    /// D27 unless a recoverable Story Studio temporary explains the damage.
    pub playlist_state: PlaylistState,
}
/// Why a storyteller is shown read-only, the cause to act on first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReadOnlyCause {
    /// The operating system mounted the volume read-only, or turned it
    /// read-only after a file system error (Linux `errors=remount-ro`), as
    /// after an unplug without ejection: the volume needs a disk check.
    Volume,
    /// `.md` version, size or public fields are not supported.
    Metadata,
    /// `.pi` cannot be read.
    Unavailable,
}
impl Inventory {
    /// `writable` comes from `Volumes::writable` (statvfs `ST_RDONLY` on
    /// POSIX, `FILE_READ_ONLY_VOLUME` on Windows). The firmware version is never
    /// a cause: any `.md` v6/v7 with valid public fields is writable. A dirty
    /// FAT bit is not a cause either (D34).
    pub(crate) fn read_only_cause(&self, writable: bool) -> Option<ReadOnlyCause> {
        if !writable {
            Some(ReadOnlyCause::Volume)
        } else if self.metadata.read_only.is_some() {
            Some(ReadOnlyCause::Metadata)
        } else if self.playlist_state == PlaylistState::Unavailable {
            Some(ReadOnlyCause::Unavailable)
        } else {
            None
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaylistState {
    Readable,
    Damaged,
    RecoveryRequired,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryState {
    MissingPlaylist,
    PlaylistAndTemporary,
    /// Identical temporary: possible shared FAT clusters. Keep it and recommend
    /// a disk check; this residue does not prevent normal actions.
    ResidueDiskCheckRecommended,
}

impl RecoveryState {
    fn requires_restore(self) -> bool {
        matches!(self, Self::MissingPlaylist | Self::PlaylistAndTemporary)
    }
}

/// Native differences are restricted to mounted-volume discovery, capacity and
/// replacement durability. Tests inject discovery and never enumerate devices.
pub(crate) trait Volumes {
    fn mounted_removable(&self) -> Result<Vec<PathBuf>>;
    fn capacity(&self, root: &Path) -> Result<(u64, u64)>;
    fn allocation_unit(&self, root: &Path) -> Result<u64> {
        platform::allocation_unit(root)
    }
    fn writable(&self, root: &Path) -> Result<bool> {
        Ok(!fs::metadata(root)?.permissions().readonly())
    }
}
// Public headless facade, consumed by the forthcoming host integration.
#[allow(unused_imports)]
pub(crate) use platform::NativeVolumes;

pub(crate) fn detect(volumes: &impl Volumes) -> Result<Vec<PathBuf>> {
    let _guard = platform::access_guard();
    let mut roots = Vec::new();
    for root in volumes.mounted_removable()? {
        if root.is_absolute()
            && (root.join(".md").symlink_metadata().is_ok() || flam::is_device(&root))
            && safe(&root, true).is_ok()
        {
            if let Ok(root) = root.canonicalize() {
                roots.push(root);
            }
        }
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}
pub(crate) fn inspect<C: OfficialCatalogue + ?Sized>(
    root: &Path,
    volumes: &impl Volumes,
    catalogue: Option<&C>,
) -> Result<Inventory> {
    let _guard = platform::access_guard();
    safe(root, true)?;
    let metadata = read::metadata(root)?;
    let (list, playlist_error) = match read::playlist(root) {
        Ok(v) => (v, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let hidden = read::hidden(root).unwrap_or_default();
    let recovery = read::recovery(root)?;
    let playlist_state = if recovery.is_some_and(RecoveryState::requires_restore) {
        PlaylistState::RecoveryRequired
    } else {
        match playlist_error {
            Some(Error::InvalidPlaylist | Error::SuffixCollision) => PlaylistState::Damaged,
            Some(_) => PlaylistState::Unavailable,
            None => match read::has_missing_folders(root, &list) {
                Ok(true) => PlaylistState::Damaged,
                Ok(false) => PlaylistState::Readable,
                Err(_) => PlaylistState::Unavailable,
            },
        }
    };
    let mut recognition_degraded = catalogue.is_none();
    let mut stories = Vec::new();
    for id in &list {
        let folder = folder(*id);
        let path = root.join(".content").join(&folder);
        let present = safe(&path, true).is_ok();
        let (recognized, degraded) = recognizes_official(&id.to_string(), catalogue);
        recognition_degraded |= degraded;
        let official = official_state(recognized, degraded);
        stories.push(Story {
            uuid: Some(*id),
            folder,
            listed: true,
            complete: present && read::complete(&path, metadata.version),
            directory_present: present,
            official,
            probable_hidden: false,
            parking_pending: false,
        });
    }
    let content = root.join(".content");
    if content.try_exists()? {
        safe(&content, true)?;
        let mut entries = fs::read_dir(content)?.collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (valid_folder(&name) || install_temporary(&name))
                && safe(&entry.path(), true).is_ok()
                && !stories.iter().any(|s| s.folder == name)
            {
                // A folder beside the authoritative parked copy is an orphan.
                let uuid = hidden
                    .iter()
                    .find(|id| {
                        folder(**id) == name && state::story_path(root, **id) == entry.path()
                    })
                    .copied();
                let official = if let Some(id) = uuid {
                    let (recognized, degraded) = recognizes_official(&id.to_string(), catalogue);
                    recognition_degraded |= degraded;
                    official_state(recognized, degraded)
                } else {
                    OfficialProvenance::Unknown
                };
                stories.push(Story {
                    uuid,
                    probable_hidden: uuid.is_some(),
                    parking_pending: false,
                    folder: name.clone(),
                    listed: false,
                    complete: !install_temporary(&name)
                        && read::complete(&entry.path(), metadata.version),
                    directory_present: true,
                    official,
                });
            }
        }
    }
    state::merge_inventory(root, &mut stories, catalogue);
    let capacity = volumes.capacity(root).ok();
    let free_bytes = capacity.map(|v| v.0);
    let total_bytes = capacity.map(|v| v.1);
    let story_count = stories
        .iter()
        .filter(|s| s.listed || s.probable_hidden)
        .count();
    Ok(Inventory {
        metadata,
        story_count,
        stories,
        free_bytes,
        total_bytes,
        playlist_error,
        playlist_state,
        recovery,
        recognition_degraded,
    })
}
fn official_state(recognized: bool, degraded: bool) -> OfficialProvenance {
    if recognized {
        OfficialProvenance::Official
    } else if degraded {
        OfficialProvenance::Unknown
    } else {
        OfficialProvenance::NotOfficial
    }
}
use crate::services::storyteller::story_folder as folder;
fn valid_folder(name: &str) -> bool {
    name.len() == 8
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}
/// Reject links/reparse points at every ancestor, including the supplied root.
fn safe(path: &Path, directory: bool) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::UnsafePath);
    }
    for ancestor in crate::support::paths::filesystem_ancestors(path) {
        let m = fs::symlink_metadata(ancestor)?;
        if m.file_type().is_symlink() {
            return Err(Error::UnsafePath);
        }
        if platform::is_reparse(&m) {
            return Err(Error::UnsafePath);
        }
    }
    let m = fs::symlink_metadata(path)?;
    if (directory && !m.is_dir()) || (!directory && !m.is_file()) {
        return Err(Error::UnsafePath);
    }
    Ok(())
}
pub(crate) use install::CopyEvent;
#[allow(unused_imports)]
pub(crate) use writes::{Action, Device, Outcome};

fn install_temporary(name: &str) -> bool {
    name.strip_prefix(".story-studio-install-")
        .is_some_and(|s| Uuid::parse_str(s).is_ok())
}

/// One classification for send items and IPC/operation errors. `device` means
/// an operation writing the volume without any pack preparation (remove, etc.).
pub(crate) fn device_fault(code: &str, stage: &str) -> bool {
    use crate::support::user_message::codes;
    match code {
        codes::STORYTELLER_NO_SPACE
        | codes::STORYTELLER_NO_SPACE_UNKNOWN
        | codes::STORYTELLER_SEND_DISCONNECTED
        | codes::STORYTELLER_DEVICE_GONE
        | codes::STORYTELLER_DEVICE_UNRESPONSIVE
        | codes::STORYTELLER_REPATRIATE_DISCONNECTED
        | codes::STORYTELLER_CIPHER_METADATA_IO
        | codes::STORYTELLER_CIPHER_METADATA_REFUSED
        | codes::STORYTELLER_STORY_PARKING_FAILED
        | codes::STORYTELLER_VOLUME_READ_ONLY
        | codes::STORYTELLER_FLAM_READ_ONLY
        | codes::STORYTELLER_BACKUP_FAILED
        | codes::STORYTELLER_PLAYLIST_RECOVERY_REQUIRED
        | codes::STORYTELLER_PLAYLIST_DAMAGED
        | codes::STORYTELLER_DEVICE_CHANGED
        | codes::STORYTELLER_PLAYLIST_TOO_LARGE
        | codes::STORYTELLER_READ_ONLY => true,
        codes::STORYTELLER_WRITE_FAILED => matches!(stage, "copying" | "finalizing" | "device"),
        _ => false,
    }
}

pub(crate) fn classify_error(
    mut error: crate::support::user_message::UserMessage,
    stage: &str,
) -> crate::support::user_message::UserMessage {
    error.device_fault = Some(
        error
            .device_fault
            .unwrap_or_else(|| device_fault(&error.code, stage)),
    );
    error
}

/// Preserve card refusals before their public message becomes WRITE_FAILED.
pub(crate) fn classify_device_error(
    error: Error,
    stage: &str,
) -> crate::support::user_message::UserMessage {
    let mut message = crate::support::user_message::UserMessage::from(error);
    message.device_fault = Some(match error {
        Error::InvalidCard | Error::FutureCard => false,
        Error::Io
        | Error::Verification
        | Error::BackupFailed
        | Error::NoSpace { .. }
        | Error::ReadOnly => true,
        _ => device_fault(&message.code, stage),
    });
    message
}
