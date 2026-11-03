//! D22–D24. Independent, bounded sidecars; never read or mutate story payloads.
use super::*;
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};

/// Provisional until E22 on hardware. The only definition of the directory name.
pub(crate) const DIRECTORY: &str = ".storystudio";
// Base64 cover (88 KiB) + worst-case JSON escaping of bounded text (129 KiB).
const MAX_CARD: u64 = 224 * 1024;
const MAX_COVER: usize = 64 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Card {
    pub title: String,
    pub description: String,
    pub age_min: Option<u32>,
    pub age_max: Option<u32>,
    /// PNG, at most 320×240 and 64 KiB. Embedded for one-file publication.
    #[serde(with = "cover_base64")]
    pub cover_png: Option<Vec<u8>>,
}
mod cover_base64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(
        bytes: &Option<Vec<u8>>,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&bytes.as_ref().map(|b| STANDARD.encode(b)), s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|s| STANDARD.decode(s).map_err(serde::de::Error::custom))
            .transpose()
    }
}
/// A temporarily unavailable cover must never erase the device's copy.
pub(crate) struct CatalogueCard {
    pub card: Card,
    pub cover_pending: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncStage {
    SaveName,
    Catalogue,
    Publish,
    Resolve,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SyncFailure {
    pub uuid: Uuid,
    pub stage: SyncStage,
    pub error: Error,
}
#[derive(Debug)]
pub(crate) struct SyncReport {
    /// Same order as the requested UUIDs, including failed stories.
    pub resolutions: Vec<Resolution>,
    pub failures: Vec<SyncFailure>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    uuid: Uuid,
    card: Card,
    /// Only an explicit device rename may override the catalogue on connection.
    pending_name: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolution {
    Official { title: Option<String> },
    Known(Card),
    Unknown,
}
/// Headless boundary. The production adapter uses existing catalogue resolution
/// and its revision-checked mutation journal; tests can use another data profile.
pub(crate) trait CardCatalogue: OfficialCatalogue {
    fn official_title(&self, id: Uuid) -> Result<Option<String>>;
    fn card(&self, id: Uuid) -> Result<Option<CatalogueCard>>;
    /// Missing pack is a no-op. Errors retain the device's pending rename.
    fn save_name(&self, id: Uuid, title: &str) -> Result<()>;
}
fn decode(bytes: &[u8], max_width: u32, max_height: u32) -> Result<image::DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Error::InvalidCard)?;
    // Probe headers before allocating pixels, including for formats whose decoder
    // does not enforce dimension limits itself.
    let (width, height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Error::InvalidCard)?
        .into_dimensions()
        .map_err(|_| Error::InvalidCard)?;
    if width > max_width || height > max_height {
        return Err(Error::InvalidCard);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(max_width);
    limits.max_image_height = Some(max_height);
    limits.max_alloc =
        Some((u64::from(max_width) * u64::from(max_height) * 8).min(64 * 1024 * 1024));
    reader.limits(limits);
    reader.decode().map_err(|_| Error::InvalidCard)
}
/// PNG avoids another lossy generation and has portable existing decoders.
/// Reduce further for noisy images until the byte ceiling is met.
pub(crate) fn reduced_cover(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(Error::InvalidCard);
    }
    let image = decode(bytes, 4096, 4096)?;
    let (mut w, mut h) = (320, 240);
    loop {
        let mut out = Cursor::new(Vec::new());
        image
            .thumbnail(w, h)
            .write_to(&mut out, ImageFormat::Png)
            .map_err(|_| Error::InvalidCard)?;
        let bytes = out.into_inner();
        if bytes.len() <= MAX_COVER {
            return Ok(bytes);
        }
        w /= 2;
        h /= 2;
        if w == 0 || h == 0 {
            return Err(Error::InvalidCard);
        }
    }
}
/// Same bounded validation as rendering, without thumbnailing or PNG encoding.
pub(super) fn check_cover_image(bytes: &[u8]) -> Result<()> {
    decode(bytes, 4096, 4096).map(|_| ())
}
fn validate(card: &Card) -> Result<()> {
    if card.title.trim().is_empty()
        || card.title.chars().count() > 2000
        || card.description.chars().count() > 20_000
        || card
            .age_min
            .zip(card.age_max)
            .is_some_and(|(min, max)| min > max)
        || card
            .age_min
            .into_iter()
            .chain(card.age_max)
            .any(|a| a > i32::MAX as u32)
    {
        return Err(Error::InvalidCard);
    }
    if let Some(bytes) = &card.cover_png {
        if bytes.len() > MAX_COVER || image::guess_format(bytes).ok() != Some(ImageFormat::Png) {
            return Err(Error::InvalidCard);
        }
        let image = decode(bytes, 320, 240)?;
        if image.width() > 320 || image.height() > 240 {
            return Err(Error::InvalidCard);
        }
    }
    Ok(())
}
#[derive(Default)]
struct LoadedCard {
    future: bool,
    record: Option<Record>,
}
/// Catalogue metadata wins, except for an unpublished device name and an
/// unavailable catalogue cover. Shared by silent reads and explicit sync.
fn preferred_card(loaded: &LoadedCard, entry: Option<CatalogueCard>) -> Option<Card> {
    let device = loaded.record.as_ref();
    if loaded.future {
        return device
            .map(|record| record.card.clone())
            .or_else(|| entry.map(|entry| entry.card));
    }
    match entry {
        Some(mut entry) => {
            if let Some(record) = device.filter(|record| record.pending_name) {
                entry.card.title.clone_from(&record.card.title);
            }
            if entry.cover_pending {
                entry.card.cover_png = device.and_then(|record| record.card.cover_png.clone());
            }
            Some(entry.card)
        }
        None => device.map(|record| record.card.clone()),
    }
}
/// Stop at version, so a truncated oversized record can still identify v1.
/// Input is bounded by MAX_CARD + 1; no version-specific field is decoded.
fn card_version(bytes: &[u8]) -> Option<u64> {
    struct Version<'a>(&'a mut Option<u64>);
    impl<'de> serde::de::Visitor<'de> for Version<'_> {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("card version")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<u64, A::Error> {
            while let Some(key) = map.next_key::<String>()? {
                if key == "version" {
                    *self.0 = Some(map.next_value()?);
                    // Deliberately stop: a damaged/truncated tail is irrelevant
                    // to version protection. serde_json otherwise requires `}`.
                    return Err(serde::de::Error::custom("version obtained"));
                }
                map.next_value::<serde::de::IgnoredAny>()?;
            }
            Err(serde::de::Error::missing_field("version"))
        }
    }
    let mut version = None;
    let _ = serde::de::Deserializer::deserialize_map(
        &mut serde_json::Deserializer::from_slice(bytes),
        Version(&mut version),
    );
    version
}
impl Device {
    /// A full identity may come from a validated sidecar, never from a folder suffix alone.
    #[cfg(test)]
    pub(crate) fn orphan_card_uuid(&self, name: &str) -> Option<Uuid> {
        match self.orphan_card_uuids(name).as_slice() {
            [id] => Some(*id),
            _ => None,
        }
    }
    /// Every validated sidecar whose UUID ends with this folder name.
    pub(crate) fn orphan_card_uuids(&self, name: &str) -> Vec<Uuid> {
        let name = name.strip_prefix("parked:").unwrap_or(name);
        let directory = self.root.join(DIRECTORY);
        if safe(&directory, true).is_err() {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(directory) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                return Vec::new();
            };
            let filename = entry.file_name();
            let Some(stem) = filename.to_str().and_then(|s| s.strip_suffix(".json")) else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(stem) else {
                continue;
            };
            if folder(id) == name && !found.contains(&id) && self.load_card(id).record.is_some() {
                found.push(id);
            }
        }
        found
    }
    /// Read-only resolution for an orphan's known UUID: official title or the
    /// device's own sidecar. No publication, backup or first-screen decoding.
    pub(crate) fn orphan_resolution<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: Option<&C>,
    ) -> Resolution {
        // Same guard and lock as resolve_card: never read a sidecar mid-write.
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let Ok(_lock) = mutation.lock() else {
            return Resolution::Unknown;
        };
        match state(id, catalogue) {
            OfficialProvenance::Official => Resolution::Official {
                title: catalogue.and_then(|c| c.official_title(id).ok().flatten()),
            },
            OfficialProvenance::Unknown => Resolution::Unknown,
            OfficialProvenance::NotOfficial => self
                .load_card(id)
                .record
                .map_or(Resolution::Unknown, |record| Resolution::Known(record.card)),
        }
    }
    /// Read-only sidecar access for repatriation: no synchronization/backups.
    pub(crate) fn repatriation_card(&self, id: Uuid) -> Option<Card> {
        self.load_card(id).record.map(|record| record.card)
    }
    fn sync_card_dir(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        if self.fail_publish_sync {
            return Err(Error::Io);
        }
        platform::sync_volume(path)
    }
    fn card_path(&self, id: Uuid) -> PathBuf {
        self.root.join(DIRECTORY).join(format!("{id}.json"))
    }
    /// Read once, bounded even for oversized/corrupt v1 records. A future
    /// version in the prefix protects its sidecar without decoding its schema.
    fn load_card(&self, id: Uuid) -> LoadedCard {
        let read = || -> Result<Vec<u8>> {
            safe(&self.root.join(DIRECTORY), true)?;
            let path = self.card_path(id);
            safe(&path, false)?;
            let mut bytes = Vec::new();
            fs::File::open(path)?
                .take(MAX_CARD + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        let Ok(bytes) = read() else {
            return LoadedCard::default();
        };
        let version = card_version(&bytes);
        if version.is_some_and(|v| v > 1) {
            return LoadedCard {
                future: true,
                record: None,
            };
        }
        let record = (version == Some(1) && bytes.len() as u64 <= MAX_CARD)
            .then(|| serde_json::from_slice::<Record>(&bytes).ok())
            .flatten()
            .filter(|r| r.uuid == id && validate(&r.card).is_ok());
        LoadedCard {
            future: false,
            record,
        }
    }
    fn publish_card(&self, id: Uuid, card: Card, pending_name: bool) -> Result<()> {
        self.publish_loaded_card(id, card, pending_name, self.load_card(id).future)
    }
    /// One card written then the volume barrier, run after an error as well;
    /// the write error wins, a failed barrier is never a written card.
    fn publish_loaded_card(
        &self,
        id: Uuid,
        card: Card,
        pending_name: bool,
        future: bool,
    ) -> Result<()> {
        let result = self.write_loaded_card(id, card, pending_name, future);
        let durable = self.sync_volume();
        result.and(durable)
    }
    /// Writes and verifies a card without the final barrier (callers own it).
    fn write_loaded_card(
        &self,
        id: Uuid,
        card: Card,
        pending_name: bool,
        future: bool,
    ) -> Result<()> {
        if future {
            return Err(Error::FutureCard);
        }
        safe(&self.root, true)?;
        if let Some(error) = read::metadata(&self.root)?.read_only {
            return Err(error);
        }
        validate(&card)?;
        let bytes = serde_json::to_vec(&Record {
            version: 1,
            uuid: id,
            card,
            pending_name,
        })
        .map_err(|_| Error::InvalidCard)?;
        if bytes.len() as u64 > MAX_CARD {
            return Err(Error::InvalidCard);
        }
        let metadata = read::metadata(&self.root)?;
        if !NativeVolumes.writable(&self.root)? {
            return Err(Error::ReadOnly);
        }
        self.backup(metadata.serial().ok_or(Error::InvalidMetadata)?)
            .map_err(|_| Error::BackupFailed)?;
        // Card writes are also writing gestures: resume legacy/in-flight D33
        // moves through the same transition, without changing a damaged .pi.
        if let Ok(visible) = read::playlist(&self.root) {
            super::state::unrelated_parking(self.transition(
                visible.clone(),
                super::state::normalized(&self.root, &visible),
                super::state::Phase::Commit,
                &metadata,
            ))?;
        }
        let directory = self.root.join(DIRECTORY);
        if !directory.try_exists()? {
            fs::create_dir(&directory)?;
            let _ = self.sync_card_dir(&self.root);
        }
        safe(&directory, true)?;
        let target = self.card_path(id);
        if target.symlink_metadata().is_ok() {
            safe(&target, false)?;
        }
        let temp = directory.join(format!(".pending-{}", Uuid::new_v4()));
        let mut file = fs::File::create_new(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // Same replacement/durability adapter as .pi. Never unlink a failed
        // temporary: interrupted FAT renames can alias target clusters.
        platform::replace(&temp, &target)?;
        if fs::read(target)? != bytes {
            return Err(Error::Verification);
        }
        Ok(())
    }
    /// Called by the future send operation. Fail closed on unknown recognition.
    pub(crate) fn write_card<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: Option<&C>,
        card: Card,
    ) -> Result<bool> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        if state(id, catalogue) != OfficialProvenance::NotOfficial {
            return Ok(false);
        }
        self.publish_card(id, card, false)?;
        Ok(true)
    }
    #[cfg(test)]
    pub(crate) fn resolve_card<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: Option<&C>,
    ) -> Result<Resolution> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        self.resolve_card_inner(id, catalogue)
    }
    fn resolve_card_inner<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: Option<&C>,
    ) -> Result<Resolution> {
        self.resolve_loaded_card(id, catalogue, self.load_card(id))
    }
    fn resolve_loaded_card<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: Option<&C>,
        loaded: LoadedCard,
    ) -> Result<Resolution> {
        match state(id, catalogue) {
            OfficialProvenance::Official => {
                return Ok(Resolution::Official {
                    title: catalogue.and_then(|c| c.official_title(id).ok().flatten()),
                })
            }
            OfficialProvenance::Unknown => return Ok(Resolution::Unknown),
            OfficialProvenance::NotOfficial => {}
        }
        if let Some(record) = loaded.record {
            return Ok(Resolution::Known(record.card));
        }
        if let Some(card) = catalogue.and_then(|c| c.card(id).ok().flatten()) {
            if validate(&card.card).is_err() {
                return Ok(Resolution::Unknown);
            }
            // Inspection goes on with the catalogue card; the failed copy to
            // the device is logged and retried at the next connection.
            if self
                .publish_loaded_card(id, card.card.clone(), false, loaded.future)
                .is_err()
            {
                super::state::card_durability_warning();
            }
            return Ok(Resolution::Known(card.card));
        }
        // First-screen decoding is deliberately deferred until E4.
        Ok(Resolution::Unknown)
    }
    /// Silent panel refresh: no publication, pending-name save, backup or barrier.
    pub(crate) fn read_cards<C: CardCatalogue>(
        &self,
        ids: &[Uuid],
        catalogue: &C,
    ) -> Vec<Resolution> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let Ok(_lock) = mutation.lock() else {
            return ids.iter().map(|_| Resolution::Unknown).collect();
        };
        ids.iter()
            .map(|&id| match state(id, Some(catalogue)) {
                OfficialProvenance::Official => Resolution::Official {
                    title: catalogue.official_title(id).ok().flatten(),
                },
                OfficialProvenance::Unknown => Resolution::Unknown,
                OfficialProvenance::NotOfficial => {
                    let loaded = self.load_card(id);
                    let entry = catalogue.card(id).ok().flatten();
                    preferred_card(&loaded, entry)
                        .filter(|card| validate(card).is_ok())
                        .or_else(|| loaded.record.map(|record| record.card))
                        .map_or(Resolution::Unknown, Resolution::Known)
                }
            })
            .collect()
    }
    /// Called on connection with the UUIDs from the driver's inventory.
    /// Does not enumerate payload folders, nor alter .pi/.md/story contents.
    pub(crate) fn sync_cards<C: CardCatalogue>(
        &self,
        ids: &[Uuid],
        catalogue: &C,
    ) -> Result<SyncReport> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        let mut report = SyncReport {
            resolutions: Vec::new(),
            failures: Vec::new(),
        };
        // One barrier after the loop covers every card copied at connection.
        let mut written = Vec::new();
        let mut attempted = false;
        for &id in ids {
            let mut loaded = self.load_card(id);
            let mut fail = |stage, error| {
                report.failures.push(SyncFailure {
                    uuid: id,
                    stage,
                    error,
                })
            };
            if state(id, Some(catalogue)) == OfficialProvenance::NotOfficial && !loaded.future {
                let device = &loaded.record;
                let saved = if let Some(record) = device.as_ref().filter(|r| r.pending_name) {
                    catalogue
                        .save_name(id, &record.card.title)
                        .map_err(|e| fail(SyncStage::SaveName, e))
                        .is_ok()
                } else {
                    true
                };
                if saved {
                    match catalogue.card(id) {
                        Ok(Some(entry)) => {
                            if let Some(card) = preferred_card(&loaded, Some(entry)) {
                                if device
                                    .as_ref()
                                    .is_none_or(|r| r.card != card || r.pending_name)
                                {
                                    attempted = true;
                                    match self.write_loaded_card(
                                        id,
                                        card.clone(),
                                        false,
                                        loaded.future,
                                    ) {
                                        Ok(()) => {
                                            written.push(id);
                                            loaded.record = Some(Record {
                                                version: 1,
                                                uuid: id,
                                                card,
                                                pending_name: false,
                                            })
                                        }
                                        Err(e) => fail(SyncStage::Publish, e),
                                    }
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(e) => fail(SyncStage::Catalogue, e),
                    }
                }
            }
            let resolution = self
                .resolve_loaded_card(id, Some(catalogue), loaded)
                .unwrap_or_else(|e| {
                    fail(SyncStage::Resolve, e);
                    Resolution::Unknown
                });
            report.resolutions.push(resolution);
        }
        // Also after failed writes; a card not made durable is reported.
        if attempted && self.sync_volume().is_err() {
            report
                .failures
                .extend(written.into_iter().map(|uuid| SyncFailure {
                    uuid,
                    stage: SyncStage::Publish,
                    error: Error::Io,
                }));
        }
        Ok(report)
    }
    /// Explicit rename from the forthcoming device UI; the durable marker makes
    /// a retry after restart safe even if catalogue publication was interrupted.
    pub(crate) fn name_card<C: CardCatalogue>(
        &self,
        id: Uuid,
        catalogue: &C,
        title: String,
    ) -> Result<()> {
        let _guard = platform::access_guard();
        let mutation = writes::mutation(&self.root);
        let _lock = mutation.lock().map_err(|_| Error::Io)?;
        let _operation = self.backup_scope();
        match state(id, Some(catalogue)) {
            OfficialProvenance::Official => return Err(Error::OfficialStory),
            OfficialProvenance::Unknown => return Err(Error::UnknownUuid),
            OfficialProvenance::NotOfficial => {}
        }
        let mut card = match self.resolve_card_inner(id, Some(catalogue))? {
            Resolution::Known(card) => card,
            _ => Card {
                title: title.clone(),
                description: String::new(),
                age_min: None,
                age_max: None,
                cover_png: None,
            },
        };
        card.title = title;
        self.publish_card(id, card.clone(), true)?;
        catalogue.save_name(id, &card.title)?;
        self.publish_card(id, card, false)
    }
}
fn state<C: OfficialCatalogue>(id: Uuid, catalogue: Option<&C>) -> OfficialProvenance {
    let (recognized, degraded) = recognizes_official(&id.to_string(), catalogue);
    official_state(recognized, degraded)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_png_header_is_rejected_before_pixel_decode() {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::new(20_000, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let bytes = bytes.into_inner();
        // Without IDAT data, the header probe succeeds but dimensions must reject pixel decoding.
        assert_eq!(
            ImageReader::new(Cursor::new(&bytes[..41]))
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (20_000, 1)
        );
        assert!(matches!(
            decode(&bytes[..41], 320, 240),
            Err(Error::InvalidCard)
        ));
        assert!(image::load_from_memory(&bytes[..41]).is_err());
        let mut card = Card {
            title: "Valid".into(),
            description: String::new(),
            age_min: None,
            age_max: None,
            cover_png: Some(bytes),
        };
        assert_eq!(validate(&card), Err(Error::InvalidCard));
        card.cover_png = None;
        assert_eq!(validate(&card), Ok(()));
    }
    #[test]
    fn noisy_cover_is_reduced_under_both_limits_and_bad_images_are_refused() {
        let image = image::RgbImage::from_fn(640, 480, |x, y| {
            let n = x.wrapping_mul(2654435761) ^ y.wrapping_mul(2246822519);
            image::Rgb([n as u8, (n >> 8) as u8, (n >> 16) as u8])
        });
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Png).unwrap();
        let bytes = reduced_cover(&input.into_inner()).unwrap();
        let decoded = decode(&bytes, 320, 240).unwrap();
        assert!(decoded.width() <= 320 && decoded.height() <= 240);
        assert!(bytes.len() <= MAX_COVER);
        assert_eq!(reduced_cover(b"broken"), Err(Error::InvalidCard));
        assert_eq!(
            reduced_cover(&vec![0; 10 * 1024 * 1024 + 1]),
            Err(Error::InvalidCard)
        );
    }
}
