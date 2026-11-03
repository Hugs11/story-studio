//! Disposable, content-revision keyed thumbnails. No source is ever written.
//! One decoder, at most 32 admitted requests and 32 isolated source workers.
//! Each input is capped at 16 MiB, RGBA at 8 MP and decoder allocations at
//! 64 MiB. Timed-out OS reads retain their worker until the OS returns; their
//! aggregate allocations are additional to the active decoding budget.
use super::{
    store::{error, Store},
    Result,
};
use crate::support::user_message::{codes, UserMessage};
use image::{ImageReader, Limits};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

const INPUT_BYTES: u64 = 16 * 1024 * 1024;
const PIXELS: u64 = 8_000_000;
// Three source pixels per CSS pixel for the catalogue's usual ~256 px cards.
// Keep fine cover lettering instead of squeezing every image below 32 KiB.
pub(super) const LONG_SIDE: u32 = 768;
pub(super) const TARGET: usize = 1024 * 1024;
const DISK_BYTES: u64 = 512 * 1024 * 1024;
static DECODER: Mutex<()> = Mutex::new(());
static ADMITTED: AtomicUsize = AtomicUsize::new(0);

// The source worker never owns DECODER or a scan read permit. A timed-out OS read
// cannot be interrupted portably; keep its worker bounded until the OS returns.
// One outstanding worker per persisted source prevents a stalled share from
// consuming all worker slots as more covers enter the viewport.
static SOURCE_READS: Mutex<Vec<String>> = Mutex::new(Vec::new());
#[derive(Debug, PartialEq)]
enum SourceReadFailure {
    Busy,
    Unreadable,
}
fn bounded_source_read<T: Send + 'static>(
    key: String,
    timeout: std::time::Duration,
    read: impl FnOnce() -> T + Send + 'static,
) -> std::result::Result<T, SourceReadFailure> {
    {
        let mut active = SOURCE_READS
            .lock()
            .map_err(|_| SourceReadFailure::Unreadable)?;
        if active.len() >= 32 || active.contains(&key) {
            return Err(SourceReadFailure::Busy);
        }
        active.push(key.clone());
    }
    let worker_key = key.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("catalogue-cover-read".into())
        .spawn(move || {
            struct Reading(String);
            impl Drop for Reading {
                fn drop(&mut self) {
                    if let Ok(mut active) = SOURCE_READS.lock() {
                        active.retain(|key| key != &self.0);
                    }
                }
            }
            let reading = Reading(worker_key);
            let result = read();
            // A completed read must release its slot before a caller can
            // immediately reprobe the same source after a conclusive failure.
            drop(reading);
            let _ = send.send(result);
        });
    if worker.is_err() {
        if let Ok(mut active) = SOURCE_READS.lock() {
            active.retain(|item| item != &key);
        }
        return Err(SourceReadFailure::Unreadable);
    }
    receive
        .recv_timeout(timeout)
        .map_err(|_| SourceReadFailure::Unreadable)
}

/// Held before spawn_blocking, so the runtime's waiting work is also bounded.
pub struct Admission;
impl Admission {
    pub fn acquire() -> Result<Self> {
        ADMITTED
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 32).then_some(n + 1)
            })
            .map_err(error)?;
        Ok(Self)
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        ADMITTED.fetch_sub(1, Ordering::AcqRel);
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<&'static str>,
    /// JPEG, serialized as base64; never a cache path or an
    /// original-resolution image.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_base64"
    )]
    pub bytes: Option<Vec<u8>>,
    /// Fiche requests only: cover signature (`coverSignature` of the entry
    /// list) of the inputs this answer was computed from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}
impl Thumbnail {
    pub(crate) fn state(state: &'static str) -> Self {
        Self {
            state,
            mime: None,
            bytes: None,
            signature: None,
        }
    }
    pub(crate) fn ready(bytes: &[u8]) -> Self {
        Self {
            state: "ready",
            mime: Some("image/jpeg"),
            bytes: Some(bytes.to_vec()),
            signature: None,
        }
    }
}
fn serialize_base64<S: serde::Serializer>(
    bytes: &Option<Vec<u8>>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match bytes {
        Some(bytes) => serializer.serialize_str(&base64(bytes)),
        None => serializer.serialize_none(),
    }
}
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as usize) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as usize) << 8)
            | chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(ALPHABET[n >> 18] as char);
        out.push(ALPHABET[(n >> 12) & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n & 63] as char
        } else {
            '='
        });
    }
    out
}
fn encode(bytes: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unreadable")?;
    let (width, height) = reader.into_dimensions().map_err(|_| "unreadable")?;
    if u64::from(width) * u64::from(height) > PIXELS {
        return Err("tooLarge");
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "unreadable")?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|err| {
        if matches!(err, image::ImageError::Limits(_)) {
            "tooLarge"
        } else {
            "unreadable"
        }
    })?;
    let image = if image.width() > LONG_SIDE || image.height() > LONG_SIDE {
        image.resize(LONG_SIDE, LONG_SIDE, image::imageops::FilterType::Lanczos3)
    } else {
        image
    }
    .to_rgb8();
    for quality in [90, 85, 80] {
        let mut output = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&image)
            .map_err(|_| "unreadable")?;
        if output.len() <= TARGET {
            return Ok(output);
        }
    }
    Err("tooLarge")
}
/// Files' modification times are last access times, refreshed on cache hit.
/// Unknown/partial files count too, so the directory has a real byte ceiling.
fn evict(root: &Path, incoming: u64, budget: u64) -> std::io::Result<()> {
    let mut files = std::fs::read_dir(root)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            meta.is_file()
                .then(|| (entry.path(), meta.len(), meta.modified().ok()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.2);
    let mut total = files.iter().map(|entry| entry.1).sum::<u64>();
    for (path, size, _) in files {
        if total.saturating_add(incoming) <= budget {
            break;
        }
        std::fs::remove_file(path)?;
        total = total.saturating_sub(size);
    }
    Ok(())
}
pub(crate) fn encode_bounded(bytes: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    let _decoder = DECODER.lock().map_err(|_| "unreadable")?;
    encode(bytes)
}
/// Identity of the inputs that decide a fiche thumbnail, independent of
/// catalogue metadata revisions. Mirrors `Store::fiche_thumbnail`: correction,
/// then valid official image, then the first usable file supplier with its
/// content revision and effective availability (an offline supplier yields a
/// transient failure, its return must request the cover again).
/// `resolved` is the fiche resolution read in the same snapshot.
pub(crate) fn cover_signature(
    c: &rusqlite::Connection,
    id: &str,
    resolved: &super::data::resolver::Resolution,
) -> rusqlite::Result<String> {
    Ok(cover_keys(c, id, resolved)?.signature)
}

/// Keys of one fiche cover, read in one snapshot.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CoverKeys {
    /// `coverSignature` of the entry list: the address key.
    pub signature: String,
    /// The same inputs without the supplier's availability: equal contents
    /// produce equal images, so an offline supplier keeps its stored image.
    pub content: String,
    /// The file supplier deciding the image is not confirmed available.
    pub offline: bool,
    /// Exemplar supplying the image when no correction or official image decides.
    pub supplier: Option<String>,
    /// A valid official image not acquired yet: only `download_lunii_covers`
    /// (consented flow) fetches it; its retention changes the signature.
    pub official_pending: bool,
}

pub(crate) fn cover_keys(
    c: &rusqlite::Connection,
    id: &str,
    resolved: &super::data::resolver::Resolution,
) -> rusqlite::Result<CoverKeys> {
    let correction = c
        .query_row(
            "SELECT state,image_sha256 FROM correction WHERE fiche_id=?1 AND field='cover' AND language=''",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let mut offline = false;
    let mut supplier_id = None;
    let mut official_pending = false;
    let (inputs, content) = match correction {
        Some((state, sha)) if state == "cleared" || (state == "defined" && sha.is_some()) => {
            let inputs = serde_json::json!({"correction": [state, sha]});
            (inputs.clone(), inputs)
        }
        _ => {
            let official = resolved
                .values
                .get("cover")
                .filter(|v| super::lunii_db::valid_cover(v));
            if let Some(cover) = official.filter(|v| v["sha256"].is_string()) {
                let inputs = serde_json::json!({"official": cover});
                (inputs.clone(), inputs)
            } else {
                official_pending = official.is_some();
                let mut supplier = None;
                let mut content = None;
                // Same ordered fallback as the engine; a candidate already
                // known unreadable is skipped, a later sibling cannot change
                // an image supplied by the first usable source.
                let sources = super::data::card::cover_exemplars_from(
                    c,
                    id,
                    resolved.cover_provenance.as_deref(),
                )?;
                for source in sources {
                    let input = c
                        .query_row(
                            "SELECT o.content_revision,json_quote(json_extract(o.raw_observation_json,'$.cover')),
                             EXISTS(SELECT 1 FROM cache.extracted_value v WHERE v.exemplar_id=o.exemplar_id AND v.candidate_key='@unreadable:' || o.content_revision),
                             o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=e.id AND s.status='active' AND coalesce(h.availability,'available')='available')
                             FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1 AND e.retired=0",
                            [&source],
                            |r| {
                                Ok((
                                    r.get::<_, i64>(0)?,
                                    r.get::<_, Option<String>>(1)?,
                                    r.get::<_, bool>(2)?,
                                    r.get::<_, bool>(3)?,
                                ))
                            },
                        )
                        .optional()?;
                    if let Some((revision, Some(cover), false, available)) = input {
                        if cover != "null" {
                            supplier =
                                Some(serde_json::json!([source, revision, cover, available]));
                            content = Some(serde_json::json!([source, revision, cover]));
                            offline = !available;
                            supplier_id = Some(source);
                            break;
                        }
                    }
                }
                (
                    serde_json::json!({"official": official, "supplier": supplier}),
                    serde_json::json!({"official": official, "supplier": content}),
                )
            }
        }
    };
    Ok(CoverKeys {
        signature: format!("{:x}", Sha256::digest(inputs.to_string().as_bytes())),
        content: format!(
            "{:x}",
            Sha256::digest(format!("cover-content-v1:{content}").as_bytes())
        ),
        offline,
        supplier: supplier_id,
        official_pending,
    })
}

fn fiche_cover_signature(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<String> {
    Ok(fiche_cover_keys(c, id)?.signature)
}

pub(crate) fn fiche_cover_keys(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<CoverKeys> {
    let resolved = super::data::card::resolution(c, id, &[])?;
    cover_keys(c, id, &resolved)
}

impl Store {
    fn mark_cover_unreadable(&self, exemplar: &str, revision: i64) -> Result<()> {
        self.write(|tx| {
            // The source may have been rescanned while its bytes were read.
            let changed = tx.execute(
                "INSERT OR IGNORE INTO cache.extracted_value
                 SELECT exemplar_id,'cover','','@unreadable:' || content_revision,'present','invalid',NULL,NULL,'{}'
                 FROM cache.observation o WHERE exemplar_id=?1 AND content_revision=?2 AND state='available'
                 AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=o.exemplar_id AND s.status='active' AND coalesce(h.availability,'available')='available')",
                rusqlite::params![exemplar, revision],
            ).map_err(error)?;
            if changed > 0 {
                tx.execute("UPDATE catalogue SET revision=revision+1", []).map_err(error)?;
                tx.execute("UPDATE fiche SET revision=revision+1 WHERE id IN (SELECT fiche_id FROM exemplar WHERE id=?1)", [exemplar]).map_err(error)?;
            }
            Ok(())
        })
    }

    pub fn get_thumbnail(
        &self,
        exemplar_id: Option<&str>,
        fiche_id: Option<&str>,
        expected_revision: Option<i64>,
    ) -> Result<Thumbnail> {
        if let (None, Some(card)) = (exemplar_id, fiche_id) {
            return self.fiche_thumbnail(card, expected_revision);
        }
        self.exemplar_thumbnail(exemplar_id, fiche_id, expected_revision)
    }

    /// The signature is read in the snapshot that decides the correction, then
    /// read again after the bytes are produced: official and supplier reads use
    /// later snapshots, so a change in between is never labelled with the
    /// first signature. Every input is content addressed (image SHA, monotonic
    /// content revision), so equal signatures before and after identify the
    /// bytes returned. The read itself may record a conclusive `@unreadable`
    /// marker and move on to a sibling: the answer is then recomputed once
    /// from the new state (marked candidate skipped, sibling usually served by
    /// the disk cache); a second change is refused as stale.
    pub(crate) fn fiche_thumbnail(
        &self,
        card: &str,
        expected_revision: Option<i64>,
    ) -> Result<Thumbnail> {
        let mut expected_revision = expected_revision;
        for _ in 0..2 {
            let (revision, correction, signature) = self.read_snapshot(|c| {
                let revision=c.query_row("SELECT revision FROM catalogue",[],|r|r.get::<_,i64>(0))?;
                let correction=c.query_row("SELECT state,image_sha256 FROM correction WHERE fiche_id=?1 AND field='cover' AND language=''",[card],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?;
                Ok((revision, correction, fiche_cover_signature(c, card)?))
            })?;
            // Checked against the caller's revision once; the re-run follows
            // a change made by this request.
            if expected_revision.take().is_some_and(|v| v != revision) {
                return Err(UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE));
            }
            let mut thumbnail = self.fiche_thumbnail_from(card, correction)?;
            if self.read_snapshot(|c| fiche_cover_signature(c, card))? == signature {
                thumbnail.signature = Some(signature);
                return Ok(thumbnail);
            }
        }
        Err(UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE))
    }

    fn fiche_thumbnail_from(
        &self,
        card: &str,
        correction: Option<(String, Option<String>)>,
    ) -> Result<Thumbnail> {
        if let Some((state, sha)) = correction {
            if state == "cleared" {
                return Ok(Thumbnail::state("absent"));
            }
            if let Some(sha) = sha.filter(|_| state == "defined") {
                let bytes = std::fs::read(self.images_root().join(sha)).map_err(error)?;
                let _decoder = DECODER.lock().map_err(error)?;
                return Ok(match encode(&bytes) {
                    Ok(v) => Thumbnail::ready(&v),
                    Err(state) => Thumbnail::state(state),
                });
            }
        }
        if let Some(thumbnail) = self.lunii_thumbnail(card)? {
            // An official acquisition status must not hide the image
            // already embedded in the pack while acquisition is pending.
            if thumbnail.state != "absent" {
                return Ok(thumbnail);
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let sources = self.read_snapshot(|c| super::data::card::cover_exemplars(c, card))?;
        for source in sources {
            let thumbnail = self.exemplar_thumbnail(Some(&source), None, None)?;
            match thumbnail.state {
                // The source may have disappeared after candidate selection.
                "absent" => {}
                "unreadable" => {
                    let invalid = self.read_snapshot(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM cache.extracted_value v JOIN cache.observation o ON o.exemplar_id=v.exemplar_id WHERE v.exemplar_id=?1 AND v.candidate_key='@unreadable:' || o.content_revision)", [&source], |r| r.get::<_, bool>(0)))?;
                    if !invalid {
                        return Ok(thumbnail);
                    }
                }
                _ => return Ok(thumbnail),
            }
            if std::time::Instant::now() >= deadline {
                return Ok(Thumbnail::state("busy"));
            }
        }
        Ok(Thumbnail::state("absent"))
    }

    fn exemplar_thumbnail(
        &self,
        exemplar_id: Option<&str>,
        fiche_id: Option<&str>,
        expected_revision: Option<i64>,
    ) -> Result<Thumbnail> {
        let target = self.read_snapshot(|c| {
            let revision: i64 = c.query_row("SELECT revision FROM catalogue", [], |r| r.get(0))?;
            let id = match exemplar_id {
                Some(id) => Some(id.to_owned()),
                None => c.query_row("SELECT exemplar_id FROM reference_source WHERE fiche_id=?1", [fiche_id.unwrap_or_default()], |r| r.get::<_, Option<String>>(0)).optional()?.flatten(),
            };
            let row = match id {
                Some(id) => c.query_row("SELECT e.anchor_json,o.content_revision,o.raw_observation_json,o.state='available' AND EXISTS(SELECT 1 FROM cache.coverage v JOIN source s ON s.id=v.source_id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=e.id AND s.status='active' AND coalesce(h.availability,'available')='available'),(SELECT source_id FROM cache.coverage WHERE exemplar_id=e.id LIMIT 1) FROM exemplar e JOIN cache.observation o ON o.exemplar_id=e.id WHERE e.id=?1 AND e.retired=0", [&id], |r| Ok((id.clone(), r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get::<_, Option<String>>(4)?))).optional()?,
                None => None,
            };
            Ok((revision, row))
        })?;
        if expected_revision.is_some_and(|revision| revision != target.0) {
            return Err(UserMessage::new(codes::CATALOG_TARGET_REVISION_STALE));
        }
        let Some((id, anchor, content_revision, observation, source_available, source_id)) =
            target.1
        else {
            return Ok(Thumbnail::state("absent"));
        };
        let observation: Value = serde_json::from_str(&observation).map_err(error)?;
        let cover = &observation["cover"];
        if cover.is_null() {
            return Ok(Thumbnail::state("absent"));
        }
        let anchor: Value = serde_json::from_str(&anchor).map_err(error)?;
        let root = self.thumbnail_root();
        std::fs::create_dir_all(&root).map_err(error)?;
        let key = format!(
            "{:x}",
            Sha256::digest(format!("thumbnail-v2:{id}:{content_revision}").as_bytes())
        );
        let cache = root.join(format!("{key}.jpg"));
        let cached = std::fs::File::open(&cache).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(TARGET as u64 + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        if let Ok(bytes) = cached {
            if bytes.len() <= TARGET {
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&cache)
                    .and_then(|file| file.set_modified(std::time::SystemTime::now()))
                    .map_err(error)?;
                // A hit adds no bytes: the ceiling is enforced before each write.
                return Ok(Thumbnail::ready(&bytes));
            }
            std::fs::remove_file(&cache).map_err(error)?;
        }
        let source_roots = self.read_snapshot(|c| {
            c.prepare("SELECT coalesce(s.resolved_path,s.path) FROM source s JOIN cache.coverage v ON v.source_id=s.id LEFT JOIN source_health h ON h.source_id=s.id WHERE v.exemplar_id=?1 AND s.status='active' AND coalesce(h.availability,'available')='available'")?.query_map([&id], |r| r.get::<_, Vec<u8>>(0))?.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        // Light-read budget, not the heavy job: covers load during a scan.
        let _light = self.scans.light.acquire()?;
        let source_key =
            source_id.unwrap_or_else(|| anchor["path"].as_str().unwrap_or_default().to_owned());
        let check_roots = source_roots.clone();
        let check_path = anchor["path"].as_str().unwrap_or_default().to_owned();
        let original = bounded_source_read(
            source_key.clone(),
            std::time::Duration::from_secs(2),
            move || {
                // Probe inside the bounded worker: an offline volume is not a
                // missing cover, even when persisted source health is stale.
                if !source_available
                    || !source_roots.into_iter().any(|root| {
                        std::fs::metadata(super::sources::native(root)).is_ok_and(|m| m.is_dir())
                    })
                {
                    return Err(super::analyze::CoverReadError::Transient);
                }
                super::analyze::read_cover(&anchor, &observation, INPUT_BYTES)
            },
        );
        let original = match original {
            Ok(result) => result,
            Err(SourceReadFailure::Busy) => return Ok(Thumbnail::state("busy")),
            Err(SourceReadFailure::Unreadable) => return Ok(Thumbnail::state("unreadable")),
        };
        let result = match original {
            Ok(bytes) => {
                let _decoder = DECODER.lock().map_err(error)?;
                encode(&bytes).map_err(|state| match state {
                    "tooLarge" => super::analyze::CoverReadError::TooLarge,
                    _ => super::analyze::CoverReadError::Decode,
                })
            }
            Err(failure) => Err(failure),
        };
        drop(_light);
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(failure) => {
                if source_available
                    && matches!(
                        failure,
                        super::analyze::CoverReadError::Missing
                            | super::analyze::CoverReadError::Decode
                    )
                {
                    // Reprobe after failure, immediately before recording evidence.
                    // Keep native probes bounded even when a volume disappeared.
                    let healthy = bounded_source_read(
                        source_key,
                        std::time::Duration::from_secs(2),
                        move || {
                            std::fs::metadata(check_path).is_ok()
                                && check_roots.into_iter().any(|root| {
                                    std::fs::metadata(super::sources::native(root))
                                        .is_ok_and(|m| m.is_dir())
                                })
                        },
                    )
                    .unwrap_or(false);
                    if healthy {
                        self.mark_cover_unreadable(&id, content_revision)?;
                    }
                }
                return Ok(Thumbnail::state(
                    if failure == super::analyze::CoverReadError::TooLarge {
                        "tooLarge"
                    } else {
                        "unreadable"
                    },
                ));
            }
        };
        evict(&root, bytes.len() as u64, DISK_BYTES).map_err(error)?;
        // Written aside then renamed: an interrupted write never leaves a
        // truncated JPEG under the final key.
        let partial = root.join(format!("{key}.partial"));
        std::fs::write(&partial, &bytes).map_err(error)?;
        std::fs::rename(&partial, &cache).map_err(error)?;
        Ok(Thumbnail::ready(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_source_does_not_hold_decoder_or_block_local_read() {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        assert!(bounded_source_read(
            "stalled-test".into(),
            std::time::Duration::from_millis(10),
            move || wait.recv()
        )
        .is_err());
        assert!(bounded_source_read(
            "stalled-test".into(),
            std::time::Duration::from_secs(1),
            || panic!("a stalled source must not accumulate workers")
        )
        .is_err());
        let local = bounded_source_read(
            "local-test".into(),
            std::time::Duration::from_secs(1),
            || png(16, 16),
        )
        .unwrap();
        let _decoder = DECODER.lock().unwrap();
        assert!(encode(&local).is_ok());
        release.send(()).unwrap();
    }
    #[test]
    fn busy_source_can_be_retried_after_abandoned_read_finishes() {
        let key = format!("cancelled-source-{}", uuid::Uuid::new_v4());
        let (release, wait) = std::sync::mpsc::channel::<()>();
        // A's caller has stopped waiting, while its native I/O remains active.
        assert_eq!(
            bounded_source_read(
                key.clone(),
                std::time::Duration::from_millis(10),
                move || wait.recv()
            ),
            Err(SourceReadFailure::Unreadable)
        );
        assert_eq!(
            bounded_source_read(key.clone(), std::time::Duration::from_secs(1), || panic!(
                "busy B must not start a second worker"
            )),
            Err(SourceReadFailure::Busy)
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/catalogue/thumbnail-busy.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(Thumbnail::state("busy")).unwrap(),
            fixture
        );
        release.send(()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            match bounded_source_read(key.clone(), std::time::Duration::from_secs(1), || {
                encode(&png(16, 16))
            }) {
                Ok(bytes) => {
                    assert!(bytes.is_ok());
                    break;
                }
                Err(SourceReadFailure::Busy) => {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("healthy B failed: {error:?}"),
            }
        }
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([x as u8, y as u8, (x ^ y) as u8])
        });
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }
    #[test]
    fn thumbnail_budgets_and_explicit_states() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/catalogue/thumbnail.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(Thumbnail::ready(b"hello")).unwrap(),
            fixture
        );
        let bytes = encode(&png(1024, 768)).unwrap();
        assert!(bytes.len() <= TARGET);
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (768, 576));
        assert_eq!(encode(b"invalid image"), Err("unreadable"));
        assert_eq!(encode(&png(4000, 2001)), Err("tooLarge"));
        assert_eq!(base64(b"hello"), "aGVsbG8=");
        // The command answer keeps its JSON shape: raw bytes, base64 on the wire.
        assert_eq!(
            serde_json::to_value(Thumbnail::ready(&[1, 2, 3])).unwrap()["bytes"],
            "AQID"
        );
    }
    #[test]
    fn disk_lru_counts_bytes_and_keeps_latest_hit() {
        let root = std::env::temp_dir().join(format!("thumbnail-lru-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["old", "hit", "new"] {
            std::fs::write(root.join(name), [0; 10]).unwrap();
        }
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(10);
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("old"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("hit"))
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(1))
            .unwrap();
        evict(&root, 10, 30).unwrap();
        assert!(!root.join("old").exists());
        assert!(root.join("hit").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn noisy_and_varied_images_preserve_resolution_with_bounded_high_quality() {
        let mut seed = 123456789u32;
        for (width, height) in [(768, 768), (1024, 768), (64, 256), (256, 64)] {
            let source = image::RgbImage::from_fn(width, height, |_, _| {
                let mut channels = [0; 3];
                for channel in &mut channels {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    *channel = seed as u8;
                }
                image::Rgb(channels)
            });
            let mut png = Cursor::new(Vec::new());
            source.write_to(&mut png, image::ImageFormat::Png).unwrap();
            let thumbnail = encode(&png.into_inner()).unwrap();
            assert!(thumbnail.len() <= TARGET);
            let decoded = image::load_from_memory(&thumbnail).unwrap();
            let scale = (LONG_SIDE as f64 / width.max(height) as f64).min(1.0);
            assert_eq!(decoded.width(), (width as f64 * scale).round() as u32);
            assert_eq!(decoded.height(), (height as f64 * scale).round() as u32);
            if width == 768 && height == 768 {
                let allowed_encodings = [90, 85, 80].map(|quality| {
                    let mut output = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
                        .encode_image(&source)
                        .unwrap();
                    output
                });
                assert!(
                    allowed_encodings.contains(&thumbnail),
                    "never degrade below quality 80"
                );
            }
        }
    }

    #[test]
    fn admission_is_bounded_and_released_on_drop() {
        let admissions = (0..32)
            .map(|_| Admission::acquire().unwrap())
            .collect::<Vec<_>>();
        assert!(Admission::acquire().is_err());
        drop(admissions);
        assert!(Admission::acquire().is_ok());
    }
}
