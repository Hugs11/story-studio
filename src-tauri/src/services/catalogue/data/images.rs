//! Retained images: bounded decode, staging, durable publication before SQL.
use crate::services::catalogue::{
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use image::{ImageFormat, ImageReader, Limits};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read, Write},
    path::Path,
    sync::Mutex,
};
const INPUT: u64 = 10 * 1024 * 1024;
const PIXELS: u64 = 16_000_000;
/// Retained-image technical ceiling, independent of thumbnail budgets.
pub const LONG_SIDE: u32 = 1600;
pub const RETAINED_BYTES: usize = 1024 * 1024;
static DECODER: Mutex<()> = Mutex::new(());
fn invalid(path: &str) -> UserMessage {
    UserMessage::new(codes::CATALOG_COVER_INVALID).param("path", path)
}
fn id_path(store: &Store, id: &str) -> Result<std::path::PathBuf> {
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| invalid(""))?;
    if uuid.to_string() != id {
        return Err(invalid(""));
    }
    Ok(store.staging_root().join(id))
}
impl Store {
    pub fn stage_cover(&self, path: &Path) -> Result<Value> {
        let path_label = crate::support::paths::path_for_frontend(path);
        let file = std::fs::File::open(path).map_err(|_| invalid(&path_label))?;
        let mut bytes = Vec::new();
        file.take(INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid(&path_label))?;
        if bytes.len() as u64 > INPUT {
            return Err(invalid(&path_label));
        }
        self.stage_cover_bytes(&bytes)
    }
    pub fn stage_cover_bytes(&self, bytes: &[u8]) -> Result<Value> {
        let (output, width, height) = normalized_cover(bytes)?;
        let sha = format!("{:x}", Sha256::digest(&output));
        let id = uuid::Uuid::new_v4().to_string();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(id_path(self, &id)?)
            .map_err(error)?;
        file.write_all(&output).map_err(error)?;
        file.sync_all().map_err(error)?;
        Ok(
            json!({"coverStagingId":id,"sha256":sha,"width":width,"height":height,"byteSize":output.len()}),
        )
    }
    pub fn discard_covers(&self, ids: &[String]) -> Result<()> {
        for id in ids {
            let path = id_path(self, id)?;
            if path.exists() {
                std::fs::remove_file(path).map_err(error)?;
            }
        }
        Ok(())
    }
    pub fn clean_images(&self) -> Result<()> {
        for entry in std::fs::read_dir(self.staging_root()).map_err(error)? {
            let path = entry.map_err(error)?.path();
            if path.is_file() {
                std::fs::remove_file(path).map_err(error)?;
            }
        }
        self.clean_orphan_images()
    }
    pub fn clean_orphan_images(&self) -> Result<()> {
        // Serialize publication and cleanup: no concurrent edit can start
        // referring to an asset between the reachability read and unlink.
        self.write(|tx| {
        let c: &rusqlite::Connection=tx;
        let used=(|| -> rusqlite::Result<std::collections::BTreeSet<String>> {
            let mut used=c.prepare("SELECT image_sha256 FROM correction WHERE image_sha256 IS NOT NULL UNION SELECT image_sha256 FROM reference_value WHERE image_sha256 IS NOT NULL UNION SELECT image_sha256 FROM lunii_pending_cover")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<std::collections::BTreeSet<_>>>()?;
            let snapshots=c.prepare("SELECT before_json || after_json FROM operation_change WHERE operation_id IN (SELECT o.id FROM operation o JOIN undo_head h ON h.operation_id=o.id WHERE o.status='committed') UNION ALL SELECT before_json || after_json FROM association_event WHERE operation_id IN (SELECT o.id FROM operation o JOIN undo_head h ON h.operation_id=o.id WHERE o.status='committed') UNION ALL SELECT document_json FROM pending_import")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?.join("");
            for sha in c.prepare("SELECT sha256 FROM image_asset")?.query_map([],|r|r.get::<_,String>(0))? {let sha=sha?;if snapshots.contains(&sha) {used.insert(sha);}}
            Ok(used)
        })().map_err(error)?;
        for entry in std::fs::read_dir(self.images_root()).map_err(error)? {
            let path = entry.map_err(error)?.path();
            if path.is_file()
                && !used.contains(&path.file_name().unwrap().to_string_lossy().to_string())
            {
                std::fs::remove_file(&path).map_err(error)?;
            }
        }
        let assets=tx.prepare("SELECT sha256 FROM image_asset").map_err(error)?.query_map([],|r|r.get::<_,String>(0)).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        for sha in assets {if !used.contains(&sha) {tx.execute("DELETE FROM image_asset WHERE sha256=?1",[sha]).map_err(error)?;}}
        Ok(())
        })
    }
}
pub fn publish(store: &Store, tx: &Transaction<'_>, id: &str) -> Result<String> {
    let source = id_path(store, id)?;
    let bytes = std::fs::read(&source).map_err(|_| invalid(""))?;
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let destination = store.images_root().join(&sha);
    if !destination.exists() {
        let partial = store
            .images_root()
            .join(format!("{}.partial", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&partial, &destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result.map_err(error)?;
    }
    // The preparation remains reusable after a rolled-back transaction; purged
    // at card close/startup. A failed SQL commit leaves only a cleanable orphan.
    tx.execute(
        "INSERT OR IGNORE INTO image_asset VALUES (?1,'image/jpeg',?2,?3)",
        params![sha, bytes.len() as i64, format!("images/{sha}")],
    )
    .map_err(error)?;
    Ok(sha)
}

/// Shared bounded image decoding and JPEG encoding for retained and assembled covers.
pub(crate) fn normalized_cover(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    normalize_cover(bytes, true)
}

/// Official covers retain their resolution below the shared technical ceiling.
/// Assembly and user-image normalization keep their existing canonical size.
pub(crate) fn normalized_official_cover(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    normalize_cover(bytes, false)
}

fn normalize_cover(bytes: &[u8], canonical_size: bool) -> Result<(Vec<u8>, u32, u32)> {
    let path_label = String::new();
    let decoder = DECODER.lock().map_err(error)?;
    if bytes.len() as u64 > INPUT {
        return Err(invalid(""));
    }
    let format = image::guess_format(bytes).map_err(|_| invalid(&path_label))?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(invalid(&path_label));
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|_| invalid(&path_label))?;
    if u64::from(width) * u64::from(height) > PIXELS {
        return Err(invalid(&path_label));
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let bounds = if canonical_size {
        (LONG_SIDE, LONG_SIDE)
    } else {
        (width.min(LONG_SIDE), height.min(LONG_SIDE))
    };
    let image = reader
        .decode()
        .map_err(|_| invalid(&path_label))?
        // Official covers must not multiply pixels and encoder work under the
        // shared image-memory guard just to reach the retention ceiling.
        .thumbnail(bounds.0, bounds.1)
        .to_rgb8();
    // The large input allocation is gone after resizing. Each remaining RGB
    // image is at most 1600 × 1600 × 3 bytes, and its JPEG encoder has no shared
    // state. Do not serialize encoding behind unrelated large image jobs.
    drop(decoder);
    let mut output = Vec::new();
    for quality in [85, 70, 55, 40, 25] {
        output.clear();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&image)
            .map_err(|_| invalid(&path_label))?;
        if output.len() <= RETAINED_BYTES {
            break;
        }
    }
    if output.len() > RETAINED_BYTES {
        return Err(invalid(&path_label));
    }
    Ok((output, image.width(), image.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_cover_preserves_small_image_dimensions() {
        let mut input = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let (bytes, width, height) = normalized_official_cover(input.get_ref()).unwrap();
        assert_eq!((width, height), (2, 3));
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 3));
    }
}
