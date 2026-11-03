//! Read bounded members from an owned immutable copy, never archive paths.
use super::{format::*, import::invalid, validate, Result};
use crate::services::catalogue::store::{error, Store};
use crate::support::user_message::{codes, UserMessage};
use image::{ImageFormat, ImageReader, Limits};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) struct Staged {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub document: Value,
    pub digest: String,
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn member(zip: &mut zip::ZipArchive<File>, name: &str, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    zip.by_name(name)
        .map_err(|_| invalid())?
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > max {
        return Err(limit());
    }
    Ok(bytes)
}
pub(super) fn limit() -> UserMessage {
    UserMessage::new(codes::CATALOG_IMPORT_LIMIT_EXCEEDED)
}
fn image(bytes: &[u8]) -> Result<&'static str> {
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    let media = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        _ => return Err(invalid()),
    };
    let (w, h) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| invalid())?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(limit());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| invalid())?;
    Ok(media)
}
pub(super) fn prepare(store: &Store, path: &Path, cancel: &AtomicBool) -> Result<Staged> {
    let meta = fs::metadata(path).map_err(error)?;
    if !meta.is_file() {
        return Err(invalid());
    }
    if meta.len() > MAX_TOTAL + MAX_JSON {
        return Err(limit());
    }
    let root = store.backup_root().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).map_err(error)?;
    let result = (|| {
        crate::services::catalogue::files::publish::require_space(&root, meta.len())?;
        let target = root.join("archive.zip");
        let mut input = File::open(path)
            .map_err(error)?
            .take(MAX_TOTAL + MAX_JSON + 1);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(error)?;
        let mut buf = [0; 65536];
        let mut size = 0;
        loop {
            super::export::check(cancel)?;
            let n = input.read(&mut buf).map_err(error)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > MAX_TOTAL + MAX_JSON {
                return Err(limit());
            }
            output.write_all(&buf[..n]).map_err(error)?;
        }
        output.sync_all().map_err(error)?;
        drop(output);
        let mut zip =
            zip::ZipArchive::new(File::open(&target).map_err(error)?).map_err(|_| invalid())?;
        if zip.len() > MAX_IMAGES + 2 {
            return Err(limit());
        }
        for i in 0..zip.len() {
            super::export::check(cancel)?;
            let entry = zip.by_index(i).map_err(|_| invalid())?;
            let max = if entry.name() == "catalogue.json" || entry.name() == "manifest.json" {
                MAX_JSON
            } else {
                MAX_IMAGE
            };
            if entry.size() > max {
                return Err(limit());
            }
        }
        let header: Value = validate::strict_json(&member(&mut zip, "manifest.json", MAX_JSON)?)
            .map_err(|_| invalid())?;
        if header["format"] == FORMAT
            && header["formatVersion"]
                .as_u64()
                .is_some_and(|v| v > u64::from(VERSION))
        {
            return Err(UserMessage::new(codes::CATALOG_IMPORT_VERSION_UNSUPPORTED));
        }
        let mut expanded = 0u64;
        if let Some(entries) = header["entries"].as_object() {
            for (name, entry) in entries {
                let size = entry["byteSize"].as_u64().ok_or_else(invalid)?;
                let max = if name == "catalogue.json" {
                    MAX_JSON
                } else {
                    MAX_IMAGE
                };
                expanded = expanded.checked_add(size).ok_or_else(limit)?;
                if size > max || expanded > MAX_TOTAL {
                    return Err(limit());
                }
            }
        }
        drop(zip);
        let manifest = validate::archive_cancel(&target, cancel).map_err(|e| {
            if e.code == codes::CATALOG_BACKUP_ROW_LIMIT_EXCEEDED {
                return limit();
            }
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                e
            } else {
                invalid().with_detail(e.to_string())
            }
        })?;
        let digest = super::export::digest(&target, cancel)?.sha256;
        // A concurrent replacement never supplies a mixture of validated bytes.
        if super::export::digest(path, cancel)?.sha256 != digest {
            return Err(UserMessage::new(codes::CATALOG_IMPORT_SOURCE_CHANGED));
        }
        let mut zip =
            zip::ZipArchive::new(File::open(&target).map_err(error)?).map_err(|_| invalid())?;
        let mut document = validate::strict_json(&member(&mut zip, "catalogue.json", MAX_JSON)?)
            .map_err(|_| invalid())?;
        validate::ignore_collections(&mut document);
        super::matching::validate_cancellable(&document, cancel)?;
        for name in manifest.entries.keys().filter(|n| n.starts_with("images/")) {
            super::export::check(cancel)?;
            let bytes = member(&mut zip, name, MAX_IMAGE)?;
            image(&bytes)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(&name[7..]))
                .map_err(error)?;
            file.write_all(&bytes).map_err(error)?;
            file.sync_all().map_err(error)?;
        }
        Ok(Staged {
            root: root.clone(),
            manifest,
            document,
            digest,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(root);
    }
    result
}
// Called under the common writer lock, before installing any SQL references.
// GC uses the same lock. A failed SQL commit leaves only collectible files.
pub(super) fn publish(
    store: &Store,
    tx: &rusqlite::Transaction<'_>,
    staged: &Staged,
    cancel: &AtomicBool,
) -> Result<()> {
    crate::services::catalogue::files::publish::require_space(
        &store.images_root(),
        staged
            .manifest
            .entries
            .iter()
            .filter(|(n, _)| n.starts_with("images/"))
            .map(|(_, p)| p.byte_size)
            .sum(),
    )?;
    for (name, payload) in staged
        .manifest
        .entries
        .iter()
        .filter(|(n, _)| n.starts_with("images/"))
    {
        super::export::check(cancel)?;
        let sha = &name[7..];
        let bytes = validate::image(&staged.root.join(sha), sha, payload.byte_size)?;
        let media = image(&bytes)?;
        let destination = store.images_root().join(sha);
        if destination.exists() {
            validate::image(&destination, sha, payload.byte_size)?;
        } else {
            let partial = store
                .images_root()
                .join(format!("{}.partial", uuid::Uuid::new_v4()));
            let result = (|| -> Result<()> {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&partial)
                    .map_err(error)?;
                file.write_all(&bytes).map_err(error)?;
                file.sync_all().map_err(error)?;
                drop(file);
                crate::services::catalogue::files::publish::no_replace(&partial, &destination)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&partial);
            }
            result?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO image_asset VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                sha,
                media,
                payload.byte_size as i64,
                format!("images/{sha}")
            ],
        )
        .map_err(error)?;
    }
    Ok(())
}
