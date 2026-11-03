use super::*;
use std::io::Read;

pub(super) fn metadata(root: &Path) -> Result<Metadata> {
    Ok(metadata_inner(root).unwrap_or_else(|error| Metadata {
        version: 0,
        firmware: None,
        serial: None,
        read_only: Some(error),
    }))
}
fn metadata_inner(root: &Path) -> Result<Metadata> {
    let path = root.join(".md");
    safe(&path, false)?;
    let mut file = fs::File::open(path)?;
    metadata_file(&mut file)
}
fn metadata_file(file: &mut fs::File) -> Result<Metadata> {
    let size = file.metadata()?.len();
    // Only the public prefix; never read offsets 40.. or crypto blocks.
    // Transport performs its own safety/size check: see read_cipher_material.
    let mut prefix = [0; 40];
    let mut m = Metadata {
        version: 0,
        firmware: None,
        serial: None,
        read_only: Some(Error::InvalidMetadata),
    };
    if size < 2 {
        return Ok(m);
    }
    file.read_exact(&mut prefix[..2])?;
    m.version = u16::from_le_bytes(prefix[..2].try_into().unwrap());
    if !matches!(m.version, 6 | 7) {
        m.read_only = Some(Error::UnknownFormat);
        return Ok(m);
    }
    if size != if m.version == 6 { 112 } else { 128 } {
        m.read_only = Some(Error::MetadataSize);
        return Ok(m);
    }
    file.read_exact(&mut prefix[2..])?;
    let Some(end) = prefix[2..26].iter().position(|b| *b == 0) else {
        return Ok(m);
    };
    let firmware = &prefix[2..2 + end];
    let parts: Vec<_> = firmware.split(|b| *b == b'.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|s| s.is_empty() || !s.iter().all(u8::is_ascii_digit))
        || !prefix[26..40].iter().all(u8::is_ascii_digit)
    {
        return Ok(m);
    }
    m.firmware = Some(String::from_utf8(firmware.to_vec()).unwrap());
    m.serial = Some(String::from_utf8(prefix[26..40].to_vec()).unwrap());
    m.read_only = None;
    Ok(m)
}
pub(super) fn playlist(root: &Path) -> Result<Vec<Uuid>> {
    playlist_file(&root.join(".pi"))
}
pub(super) fn playlist_file(path: &Path) -> Result<Vec<Uuid>> {
    let bytes = playlist_bytes(path)?;
    if bytes.len() % 16 != 0 {
        return Err(Error::InvalidPlaylist);
    }
    validate_entries(&bytes)
}
pub(super) fn playlist_bytes(path: &Path) -> Result<Vec<u8>> {
    safe(path, false)?;
    if fs::metadata(path)?.len() > 16 * 100_000 {
        return Err(Error::PlaylistTooLarge);
    }
    // Bound the read even if the file grows after metadata was checked.
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(16 * 100_000 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 100_000 {
        return Err(Error::PlaylistTooLarge);
    }
    Ok(bytes)
}
fn validate_entries(bytes: &[u8]) -> Result<Vec<Uuid>> {
    let list: Vec<_> = bytes
        .chunks_exact(16)
        .map(|b| Uuid::from_slice(b).unwrap())
        .collect();
    let mut suffixes = std::collections::HashSet::new();
    for id in &list {
        if id.is_nil() {
            return Err(Error::InvalidPlaylist);
        }
        if !suffixes.insert(folder(*id)) {
            return Err(Error::SuffixCollision);
        }
    }
    Ok(list)
}
/// Repair must distinguish an unavailable inventory from absent story folders.
pub(super) fn require_content(root: &Path) -> Result<()> {
    let check = || -> Result<()> {
        let content = root.join(".content");
        safe(&content, true)?;
        for entry in fs::read_dir(content)? {
            entry?;
        }
        Ok(())
    };
    check().map_err(|_| Error::ContentUnavailable)
}
pub(super) fn directory_present(root: &Path, id: Uuid) -> Result<bool> {
    let content = root.join(".content");
    match content.symlink_metadata() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
        Ok(_) => safe(&content, true)?,
    }
    let path = content.join(folder(id));
    match path.symlink_metadata() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
        Ok(_) => safe(&path, true).map(|_| true),
    }
}
pub(super) fn has_missing_folders(root: &Path, list: &[Uuid]) -> Result<bool> {
    for id in list {
        if !directory_present(root, *id)? {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn complete(path: &Path, version: u16) -> bool {
    check_complete(path, version).unwrap_or(false)
}
fn check_complete(path: &Path, version: u16) -> Result<bool> {
    for name in ["ni", "li", "ri", "si", "bt"] {
        safe(&path.join(name), false)?;
    }
    let ni_path = path.join("ni");
    let len = fs::metadata(&ni_path)?.len();
    if !(512..=512 + 44 * 100_000).contains(&len) {
        return Ok(false);
    }
    let ni = fs::read(ni_path)?;
    let u32_at = |offset| u32::from_le_bytes(ni[offset..offset + 4].try_into().unwrap());
    let nodes = u32_at(12) as usize;
    if ni[0..2] != [1, 0]
        || u32_at(4) != 512
        || u32_at(8) != 44
        || nodes == 0
        || ni.len() != 512 + nodes * 44
    {
        return Ok(false);
    }
    // E6c: factory=0 is a valid story too; provenance is resolved from the
    // UUID, never this flag. This completeness check is shared by inspection
    // and every device operation.
    // ni is clear even when ri/si are encrypted. Use both counts and node
    // references; tolerate the observed sound-count undercount of one (§7.9).
    for (offset, media, field) in [(16, "rf", 0), (20, "sf", 4)] {
        let count = u32_at(offset);
        if count > 100_000 {
            return Ok(false);
        }
        let mut required = count;
        for node in ni[512..].chunks_exact(44) {
            let index = i32::from_le_bytes(node[field..field + 4].try_into().unwrap());
            if index < -1 {
                return Ok(false);
            }
            if index >= 0 {
                let end = index as u32 + 1;
                if end > count + u32::from(media == "sf") {
                    return Ok(false);
                }
                required = required.max(end);
            }
        }
        if required > 100_000 {
            return Ok(false);
        }
        let directory = path.join(media).join("000");
        if required == 0 && !directory.try_exists()? {
            continue;
        }
        safe(&directory, true)?;
        let mut names = std::collections::HashSet::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_folder(&name) {
                safe(&entry.path(), false)?;
                names.insert(name);
            }
        }
        if names.len() < required as usize {
            return Ok(false);
        }
        // Resolve exact paths only for recognizably clear indexes. For opaque
        // indexes ni provides counts/references, never encrypted media names;
        // completeness then means structural completeness, not crypto validity.
        let index_path = path.join(if media == "rf" { "ri" } else { "si" });
        if fs::metadata(&index_path)?.len() > 12 * 100_000 + 16 {
            return Ok(false);
        }
        let bytes = fs::read(index_path)?;
        let expected = required as usize * 12;
        if expected > 0 && bytes.starts_with(b"000\\") {
            if bytes.len() < expected {
                return Ok(false);
            }
            for record in bytes[..expected].chunks_exact(12) {
                if &record[..4] != b"000\\" {
                    return Ok(false);
                }
                let name = std::str::from_utf8(&record[4..]).map_err(|_| Error::IncompleteStory)?;
                if !valid_folder(name) || !names.contains(name) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(!matches!(version, 6 | 7) || fs::metadata(path.join("bt"))?.len() == 32)
}

pub(super) fn hidden(root: &Path) -> Result<Vec<Uuid>> {
    let visible = playlist(root)?;
    Ok(state::normalized(root, &visible)
        .hidden
        .iter()
        .filter_map(|h| Uuid::parse_str(&h.uuid).ok())
        .collect())
}

pub(super) fn temporaries(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_str().is_some_and(|n| {
            n.strip_prefix(".story-studio-pi-")
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
        }) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}
pub(super) fn recovery(root: &Path) -> Result<Option<RecoveryState>> {
    let temps = temporaries(root)?;
    Ok(if temps.is_empty() {
        None
    } else if root.join(".pi").symlink_metadata().is_ok() {
        if playlist(root).is_ok_and(|list| {
            temps
                .iter()
                .all(|p| playlist_file(p).is_ok_and(|v| v == list))
        }) {
            Some(RecoveryState::ResidueDiskCheckRecommended)
        } else {
            Some(RecoveryState::PlaylistAndTemporary)
        }
    } else {
        Some(RecoveryState::MissingPlaylist)
    })
}

/// Ephemeral transport tuple: deliberately no Debug or serialization wrapper.
type CipherMaterial = (Metadata, [u8; 16], [u8; 16], [u8; 32], [u8; 32]);

/// Explicit opt-in to transport material; ordinary inspection never reads it.
impl Metadata {
    pub(crate) fn read_cipher_material(root: &Path) -> Result<CipherMaterial> {
        let _guard = platform::access_guard();
        use std::io::{Seek, SeekFrom};
        let path = root.join(".md");
        safe(&path, false)?;
        let mut file = fs::File::open(path)?;
        // Public metadata and secrets come from the same opened descriptor.
        let metadata = metadata_file(&mut file)?;
        if let Some(error) = metadata.read_only {
            return Err(error);
        }
        let expected = if metadata.version == 6 { 112 } else { 128 };
        if file.metadata()?.len() != expected {
            return Err(Error::MetadataSize);
        }
        file.seek(SeekFrom::Start(64))?;
        let mut block = [0; 32];
        file.read_exact(&mut block)?;
        let serial = metadata.serial().ok_or(Error::InvalidMetadata)?.as_bytes();
        let (mut key, mut iv) = Self::legacy_material(serial);
        let bt = if metadata.version == 6 {
            block
        } else {
            key.copy_from_slice(&block[..16]);
            iv.copy_from_slice(&block[16..]);
            let mut bt = [0; 32];
            bt[..14].copy_from_slice(serial);
            bt[24..].copy_from_slice(&serial[..8]);
            bt
        };
        for bytes in [&mut key, &mut iv] {
            for word in bytes.chunks_exact_mut(4) {
                word.reverse();
            }
        }
        use sha2::{Digest, Sha256};
        let fingerprint = Sha256::digest(block).into();
        Ok((metadata, key, iv, bt, fingerprint))
    }
    /// Raw v6 ingredients; the transport performs the common word reversal.
    pub(crate) fn legacy_material(serial: &[u8]) -> ([u8; 16], [u8; 16]) {
        let mut key = [0; 16];
        key[..14].copy_from_slice(serial);
        let mut iv = [0; 16];
        iv[8..].copy_from_slice(&serial[..8]);
        (key, iv)
    }
}
