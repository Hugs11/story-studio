//! Source proofs, read-only inventories and byte-preserving conversion.
use super::{fail, io_error, Result};
use crate::support::user_message::UserMessage;
use crate::{services::community_pack_checker, support::user_message::codes};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(test)]
type SnapshotReadHook = Box<dyn FnMut(&Path)>;
#[cfg(test)]
thread_local! {
    pub(super) static SNAPSHOT_READ_HOOK: std::cell::RefCell<Option<SnapshotReadHook>> = const { std::cell::RefCell::new(None) };
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub content: BTreeMap<String, String>,
    pub identities: BTreeMap<String, String>,
    pub bytes: u64,
}
pub(super) fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(fail(codes::GENERATION_CANCELLED))
    } else {
        Ok(())
    }
}
pub(super) fn hash(reader: &mut impl Read, cancel: &AtomicBool) -> Result<(String, u64)> {
    let mut h = Sha256::new();
    let mut n = 0;
    let mut buffer = [0u8; 65536];
    loop {
        check(cancel)?;
        let read = reader.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        h.update(&buffer[..read]);
        n += read as u64;
    }
    Ok((format!("{:x}", h.finalize()), n))
}
pub(super) fn regular(path: &Path) -> Result<fs::Metadata> {
    let m = fs::symlink_metadata(path).map_err(io_error)?;
    if m.file_type().is_symlink() || reparse(path, &m)? || (!m.is_file() && !m.is_dir()) {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    Ok(m)
}
// Cloud placeholders must hydrate normally; all other reparse tags remain
// forbidden, including junctions that FileType::is_symlink may not identify.
#[cfg(windows)]
fn reparse(path: &Path, m: &fs::Metadata) -> Result<bool> {
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    if m.file_attributes() & 0x400 == 0 {
        return Ok(false);
    }
    #[repr(C)]
    struct TagInfo {
        attributes: u32,
        tag: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut std::ffi::c_void,
            class: i32,
            info: *mut std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(7)
        .custom_flags(0x02200000)
        .open(path)
        .map_err(io_error)?;
    let mut info = TagInfo {
        attributes: 0,
        tag: 0,
    };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            9,
            (&mut info as *mut TagInfo).cast(),
            std::mem::size_of::<TagInfo>() as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(!cloud_tag(info.tag))
}
#[cfg(any(windows, test))]
pub(super) fn cloud_tag(tag: u32) -> bool {
    tag & 0xffff0fff == 0x9000001a
}
#[cfg(not(windows))]
fn reparse(_: &Path, _: &fs::Metadata) -> Result<bool> {
    Ok(false)
}
#[cfg(test)]
thread_local! { pub(super) static IDENTITY_EPOCH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) }; }
fn identity(path: &Path) -> Result<String> {
    let id = crate::services::catalogue::writes::file_id(path)
        .ok_or_else(|| fail(codes::CATALOG_FILE_SOURCE_CHANGED))?;
    #[cfg(test)]
    let id = IDENTITY_EPOCH.with(|epoch| {
        if epoch.get() == 0 {
            id.clone()
        } else {
            format!("{}:{id}", epoch.get())
        }
    });
    Ok(id)
}
pub(super) fn snapshot(path: &Path, cancel: &AtomicBool) -> Result<Snapshot> {
    for ancestor in crate::support::paths::filesystem_ancestors(path) {
        regular(ancestor)?;
    }
    let mut out = Snapshot {
        content: BTreeMap::new(),
        identities: BTreeMap::new(),
        bytes: 0,
    };
    fn walk(
        root: &Path,
        path: &Path,
        out: &mut Snapshot,
        cancel: &AtomicBool,
        depth: usize,
    ) -> Result<()> {
        check(cancel)?;
        if depth > 64 || out.identities.len() >= 100000 {
            return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
        }
        let m = regular(path)?;
        let key = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let id = identity(path)?;
        out.identities.insert(key.clone(), id.clone());
        if m.is_dir() {
            out.content.insert(format!("{key}/"), String::new());
            for e in fs::read_dir(path).map_err(io_error)? {
                walk(root, &e.map_err(io_error)?.path(), out, cancel, depth + 1)?;
            }
        } else {
            let mut file = fs::File::open(path).map_err(io_error)?;
            #[cfg(test)]
            SNAPSHOT_READ_HOOK.with(|slot| {
                if let Some(hook) = slot.borrow_mut().as_mut() {
                    hook(path);
                }
            });
            let (hash, bytes) = hash(&mut file, cancel)?;
            if identity(path)? != id {
                return Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED));
            }
            out.bytes += bytes;
            out.content.insert(key, hash);
        }
        Ok(())
    }
    walk(path, path, &mut out, cancel, 0)?;
    Ok(out)
}
/// Native ownership evidence is distinct from the identities used by content
/// observation. A diagnostic identity change must never authorize deletion.
pub(super) fn physical_ids(path: &Path, snapshot: &Snapshot) -> Result<BTreeMap<String, String>> {
    snapshot
        .identities
        .keys()
        .map(|name| {
            let entry = if name.is_empty() {
                path.to_path_buf()
            } else {
                path.join(name)
            };
            regular(&entry)?;
            let id = crate::services::catalogue::writes::file_id(&entry)
                .ok_or_else(|| fail(codes::CATALOG_FILE_RECOVERY_REQUIRED))?;
            Ok((name.clone(), id))
        })
        .collect()
}
pub(super) fn token(s: &Snapshot) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(s).unwrap()))
}
pub(super) fn unchanged(path: &Path, expected: &Snapshot, cancel: &AtomicBool) -> Result<()> {
    match snapshot(path, cancel) {
        // Byte counts are capacity estimates (subtree evidence may omit them).
        // Content hashes and physical identities are the full pre-write proof.
        Ok(actual)
            if actual.content == expected.content && actual.identities == expected.identities =>
        {
            Ok(())
        }
        Err(e) if e.code == codes::GENERATION_CANCELLED => Err(e),
        _ => Err(fail(codes::CATALOG_FILE_SOURCE_CHANGED)),
    }
}

pub(super) fn story_bytes(path: &Path) -> Result<Vec<u8>> {
    let bytes = if super::formats::is_seven(path) {
        super::formats::story(path)?
    } else if path.is_dir() {
        let mut b = Vec::new();
        fs::File::open(path.join("story.json"))
            .map_err(io_error)?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut b)
            .map_err(io_error)?;
        b
    } else {
        let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(io_error)?)
            .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
        let mut entry = archive
            .by_name("story.json")
            .map_err(|_| fail(codes::CATALOG_FILE_FORMAT_NOT_WRITABLE))?;
        let mut b = Vec::new();
        entry
            .by_ref()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut b)
            .map_err(io_error)?;
        b
    };
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    Ok(bytes)
}
pub(super) fn read_story(path: &Path) -> Result<Value> {
    let v: Value = serde_json::from_slice(&story_bytes(path)?)
        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    if !v.is_object() || !v["stageNodes"].is_array() || !v["actionNodes"].is_array() {
        return Err(fail(codes::CATALOG_FILE_FORMAT_NOT_WRITABLE));
    }
    Ok(v)
}
pub(super) fn copy_tree(source: &Path, dest: &Path, cancel: &AtomicBool) -> Result<()> {
    if regular(source)?.is_dir() {
        fs::create_dir(dest).map_err(io_error)?;
        for e in fs::read_dir(source).map_err(io_error)? {
            let e = e.map_err(io_error)?;
            copy_tree(&e.path(), &dest.join(e.file_name()), cancel)?;
        }
        super::publish::sync_directory(dest)?;
    } else {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .map_err(io_error)?;
        let mut input = fs::File::open(source).map_err(io_error)?;
        let mut buffer = [0u8; 65536];
        loop {
            check(cancel)?;
            let n = input.read(&mut buffer).map_err(io_error)?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n]).map_err(io_error)?;
        }
        output.sync_all().map_err(io_error)?;
    }
    Ok(())
}
pub(super) fn inventory(path: &Path, cancel: &AtomicBool) -> Result<BTreeMap<String, String>> {
    if super::formats::is_seven(path) {
        return super::formats::inventory(path, cancel);
    }
    if path.is_dir() {
        let s = snapshot(path, cancel)?;
        return Ok(s
            .content
            .into_iter()
            .filter(|(n, _)| !n.ends_with('/'))
            .collect());
    }
    let mut a = zip::ZipArchive::new(fs::File::open(path).map_err(io_error)?)
        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    if a.len() > 100000 {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    let mut out = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..a.len() {
        let mut e = a
            .by_index(i)
            .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
        if e.enclosed_name().is_none()
            || e.name().contains('\\')
            || e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
        }
        if e.is_dir() {
            continue;
        }
        total = total.saturating_add(e.size());
        if total > 16 * 1024 * 1024 * 1024 {
            return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
        }
        let name = e.name().to_owned();
        let (h, _) = hash(&mut e, cancel)?;
        if out.insert(name, h).is_some() {
            return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
        }
    }
    Ok(out)
}
pub(super) fn prepare(
    catalogue: Option<
        &dyn crate::services::official_packs::OfficialCatalogue<
            Error = crate::support::user_message::UserMessage,
        >,
    >,
    source: &Path,
    temp: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let text = String::from_utf8(story_bytes(source)?)
        .map_err(|_| fail(codes::CATALOG_FILE_VERIFY_FAILED))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(crate::native_pack::output_identity::invalid_story)?;
    let output_identity = crate::native_pack::output_identity::for_story(
        &value,
        crate::native_pack::output_identity::OutputForm::Rewritten,
        catalogue,
    )?;
    let authorized = output_identity
        .serialize(&text)
        .map_err(UserMessage::from)?;
    let mut expected = inventory(source, cancel)?;
    expected.insert(
        "story.json".into(),
        format!("{:x}", Sha256::digest(authorized.as_bytes())),
    );
    if source.is_dir() {
        copy_tree(source, temp, cancel)?;
        authorized
            .write_file(&temp.join("story.json"))
            .map_err(io_error)?;
    } else {
        let output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(io_error)?;
        let output_id = identity(temp)?;
        let written = community_pack_checker::write_metadata_zip_authorized(
            &output_identity,
            source,
            output,
            (authorized != text).then_some(authorized.as_str()),
            None,
            cancel,
        );
        if written.is_err() && cancel.load(Ordering::Relaxed) {
            // Only remove the file created exclusively above, after the writer has closed.
            // A replaced path belongs to its new owner and must remain untouched.
            if identity(temp).is_ok_and(|current| current == output_id) {
                fs::remove_file(temp).map_err(io_error)?;
                super::publish::sync_directory(temp.parent().unwrap())?;
            }
            return Err(fail(codes::GENERATION_CANCELLED));
        }
        written.map_err(|_| fail(codes::CATALOG_FILE_WRITE_FAILED))?;
    }
    verify(temp, &expected, &authorized, cancel)
}
pub(super) fn verify(
    path: &Path,
    expected: &BTreeMap<String, String>,
    story: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    if &inventory(path, cancel)? != expected {
        return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
    }
    if !path.is_dir() {
        use crate::native_pack::archive_review::{self, ArchiveExpectation, ExpectedArchiveEntry};
        let assets: Vec<_> = expected
            .iter()
            .filter_map(|(n, h)| {
                n.strip_prefix("assets/")
                    .map(|short| (short.to_owned(), h.clone()))
            })
            .collect();
        let r = archive_review::review_written_archive(
            path,
            &ArchiveExpectation {
                story_json: story,
                distinct_names: assets.iter().map(|(n, _)| n.clone()).collect(),
                entries: assets
                    .into_iter()
                    .map(|(n, h)| ExpectedArchiveEntry {
                        archive_name: n,
                        output_sha256: h,
                    })
                    .collect(),
                expects_thumbnail: expected.contains_key("thumbnail.png"),
            },
        );
        if !r.is_conformant() {
            return Err(fail(codes::CATALOG_FILE_VERIFY_FAILED));
        }
    }
    Ok(())
}
pub(super) fn neighbor(path: &Path, id: &str, suffix: &str) -> PathBuf {
    let digest = Sha256::digest(format!("{id}:{suffix}").as_bytes());
    let bytes: [u8; 16] = digest[..16].try_into().unwrap();
    path.parent().unwrap().join(format!(
        ".story-studio-write-{}",
        uuid::Uuid::from_bytes(bytes)
    ))
}
