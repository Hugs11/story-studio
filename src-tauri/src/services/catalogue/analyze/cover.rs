//! Targeted cover reads reuse analyzer locators. Nested archives are spooled
//! only into the application's temporary workspace and removed on drop.
use super::{member, seven_zip, temporary};
use crate::support::fs_pack_reader::{decode_fs_pack_asset, FsPackVariant};
use serde_json::Value;
use std::{
    io::{Read, Seek},
    path::Path,
    sync::atomic::AtomicBool,
};

/// Only a missing member inside an opened pack or corrupt bytes are conclusive.
/// Opaque helper errors (including temporary workspace failures) are transient.
#[derive(Debug, PartialEq)]
pub enum CoverReadError {
    Missing,
    Decode,
    TooLarge,
    Transient,
}
impl From<std::io::Error> for CoverReadError {
    fn from(_: std::io::Error) -> Self {
        // An I/O NotFound may concern the pack or a temporary workspace.
        // Missing members are classified explicitly at the lookup site.
        Self::Transient
    }
}
impl From<zip::result::ZipError> for CoverReadError {
    fn from(error: zip::result::ZipError) -> Self {
        match error {
            zip::result::ZipError::Io(error) => error.into(),
            zip::result::ZipError::FileNotFound => Self::Missing,
            zip::result::ZipError::InvalidArchive(_) => Self::Decode,
            _ => Self::Transient,
        }
    }
}
impl From<String> for CoverReadError {
    fn from(error: String) -> Self {
        if matches!(error.as_str(), "tooLarge" | "readLimitExceeded") {
            Self::TooLarge
        } else {
            Self::Transient
        }
    }
}
impl From<&str> for CoverReadError {
    fn from(_: &str) -> Self {
        Self::Transient
    }
}

fn bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, CoverReadError> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(CoverReadError::TooLarge);
    }
    Ok(bytes)
}
fn zip_cover(
    reader: impl Read + Seek,
    chain: &[member::Segment],
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, CoverReadError> {
    let mut archive = zip::ZipArchive::new(reader)?;
    if let Some((segment, rest)) = chain.split_first() {
        if segment.kind == "archive-entry" {
            let mut entry = archive.by_name(&segment.path)?;
            let temporary = temporary::Temporary::spool(&mut entry, &AtomicBool::new(false))?;
            return zip_cover(temporary.read()?, rest, name, limit);
        }
    }
    let entry = archive.by_name(name)?;
    bounded(entry, limit)
}
pub fn read_cover(
    anchor: &Value,
    observation: &Value,
    limit: u64,
) -> Result<Vec<u8>, CoverReadError> {
    let cover = &observation["cover"];
    let path = Path::new(anchor["path"].as_str().ok_or("unreadable")?);
    if cover["kind"] != "archiveEntry" {
        let file = cover["path"]
            .as_str()
            .or_else(|| cover.as_str())
            .ok_or("unreadable")?;
        // A surviving mount point does not prove the exemplar is present.
        // Only absence inside a pack we can still access is conclusive.
        std::fs::metadata(path)?;
        let file = std::fs::File::open(file).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound && std::fs::metadata(path).is_ok() {
                CoverReadError::Missing
            } else {
                CoverReadError::Transient
            }
        })?;
        let bytes = bounded(file, limit)?;
        // An encrypted FS pack stores its images enciphered; the reader owns
        // the cipher, the 16 MiB bound applies to the bytes read from disk.
        if observation["format"] == "fsDirectory" {
            if let Some(variant) = observation["raw"]["variant"]
                .as_str()
                .and_then(FsPackVariant::from_preview_name)
                .filter(|variant| *variant == FsPackVariant::Encrypted)
            {
                return Ok(decode_fs_pack_asset(variant, &bytes));
            }
        }
        return Ok(bytes);
    }
    let name = cover["path"].as_str().ok_or("unreadable")?;
    member::validate_names(std::iter::once(name))?;
    let chain: Vec<member::Segment> = serde_json::from_value(observation["chain"].clone())
        .map_err(|_| CoverReadError::Transient)?;
    if observation["format"] == "7z" {
        if let Some(segment) = chain
            .first()
            .filter(|segment| segment.kind == "archive-entry")
        {
            let temporary = temporary::Temporary::new()?;
            seven_zip::spool_member(path, &segment.path, temporary.write()?)?;
            return zip_cover(temporary.read()?, &chain[1..], name, limit);
        }
        let bytes = seven_zip::read_member(path, name, limit)?;
        // A device pack read from a 7z decodes its image like a device ZIP.
        return Ok(match super::device_pack_variant(observation) {
            Some(variant) => decode_fs_pack_asset(variant, &bytes),
            None => bytes,
        });
    }
    let bytes = zip_cover(std::fs::File::open(path)?, &chain, name, limit)?;
    if observation["format"] == "fsZip" {
        if let Some(variant) = super::device_pack_variant(observation) {
            return Ok(decode_fs_pack_asset(variant, &bytes));
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_members_and_corrupt_bytes_are_conclusive() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            CoverReadError::from(Error::from(ErrorKind::NotFound)),
            CoverReadError::Transient
        );
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::Other,
            ErrorKind::WouldBlock,
            ErrorKind::StorageFull,
            ErrorKind::TimedOut,
            ErrorKind::NotConnected,
        ] {
            assert_eq!(
                CoverReadError::from(Error::from(kind)),
                CoverReadError::Transient,
                "{kind:?}"
            );
        }
        // ZIP I/O and temporary helpers' opaque errors are inconclusive,
        // including an ENOSPC or a missing workspace.
        assert_eq!(
            CoverReadError::from(zip::result::ZipError::Io(Error::from(ErrorKind::Other))),
            CoverReadError::Transient
        );
        for failure in [
            "Permission denied",
            "Input/output error",
            "Resource busy",
            "No space left on device",
            "No such file or directory",
        ] {
            assert_eq!(
                CoverReadError::from(failure.to_owned()),
                CoverReadError::Transient
            );
        }
        assert_eq!(
            zip_cover(std::io::Cursor::new(b"broken"), &[], "cover.png", 1024),
            Err(CoverReadError::Decode)
        );
    }
}
