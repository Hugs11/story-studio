//! Files an analysis reads outside the scanned unit's own token (a project's
//! cover beside it, the indexes and cover of a device-pack folder). Each read
//! is stamped before it happens; a cached analysis is reused only while every
//! stamp, including a recorded absence, is still the same.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
    /// The scanned unit itself (a pack folder).
    Unit,
    /// The folder holding the scanned file (a project's relative cover).
    Parent,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    /// Path as located by the reader's lookup. On a case-sensitive file system
    /// a case-only rename changes it; on a case-insensitive one it may not,
    /// which is harmless since the reader opens the same file either way.
    resolved: String,
    kind: String,
    /// Directories only prove their presence: their date moves with any entry.
    size: Option<u64>,
    seconds: Option<u64>,
    nanos: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRead {
    anchor: Anchor,
    /// Joined to the anchor; an absolute path is used as is.
    relative: String,
    /// Resolved with the device-pack reader's own rule
    /// (`fs_pack_reader::resolve_fs_path`) rather than spelled exactly.
    pack_lookup: bool,
    /// `None`: nothing was found there.
    found: Option<FileStamp>,
}
impl ExternalRead {
    /// Stamped now: call it before the read it accounts for.
    pub fn capture(unit: &Path, anchor: Anchor, relative: &str, pack_lookup: bool) -> Self {
        let mut read = Self {
            anchor,
            relative: relative.into(),
            pack_lookup,
            found: None,
        };
        read.found = read.stamp(unit);
        read
    }
    fn locate(&self, unit: &Path) -> PathBuf {
        let base = match self.anchor {
            Anchor::Unit => unit,
            Anchor::Parent => unit.parent().unwrap_or(Path::new(".")),
        };
        if self.pack_lookup {
            crate::support::fs_pack_reader::resolve_fs_path(base, &self.relative)
        } else {
            base.join(&self.relative)
        }
    }
    fn stamp(&self, unit: &Path) -> Option<FileStamp> {
        let path = self.locate(unit);
        let link = std::fs::symlink_metadata(&path).ok()?;
        // A link is followed for its target's size and date.
        let (kind, meta) = if link.file_type().is_symlink() {
            ("link", std::fs::metadata(&path).ok())
        } else if link.is_dir() {
            ("directory", None)
        } else if link.is_file() {
            ("file", Some(link))
        } else {
            ("other", Some(link))
        };
        let date = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|d| d.duration_since(UNIX_EPOCH).unwrap_or_default());
        Some(FileStamp {
            resolved: crate::support::paths::path_for_frontend(&path),
            kind: kind.into(),
            size: meta.as_ref().map(std::fs::Metadata::len),
            seconds: date.map(|d| d.as_secs()),
            nanos: date.map(|d| d.subsec_nanos()),
        })
    }
    /// The file is found exactly as it was stamped (or is still absent).
    pub fn holds(&self, unit: &Path) -> bool {
        self.stamp(unit) == self.found
    }
    /// Date of the stamped file in milliseconds, for the coarse-date window.
    pub fn date_millis(&self) -> Option<u64> {
        let found = self.found.as_ref()?;
        Some(found.seconds? * 1000 + u64::from(found.nanos?) / 1_000_000)
    }
}
/// Pack-folder entries probed by the device-pack reader (structure detection,
/// cleartext marker, indexes), resolved with its case rule. The STUdio files
/// of a folder (`story.json`, `thumbnail.png`) are read by exact name and
/// already belong to the folder's token.
pub const PACK_FOLDER_ENTRIES: [&str; 10] = [
    "ni",
    "ri",
    "si",
    "li",
    "ri.plain",
    "si.plain",
    "li.plain",
    crate::support::fs_pack_reader::FS_PACK_CLEARTEXT_MARKER,
    "rf",
    "sf",
];
/// Adds `read` unless the same location was already stamped (earliest wins).
pub fn record(reads: &mut Vec<ExternalRead>, read: ExternalRead) {
    if !reads
        .iter()
        .any(|r| r.anchor == read.anchor && r.relative == read.relative)
    {
        reads.push(read);
    }
}
