//! Fiche-owned covers survive the official tool and thumbnail-cache purges.
use super::*;
use crate::services::catalogue::{data, thumbnails};
#[derive(Default)]
pub(super) struct Acquisition {
    result: Mutex<Option<Result<Vec<u8>>>>,
    failure_accounted: Mutex<bool>,
}
const ACQUISITIONS: usize = 16;
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    bounded::check(cancel, Instant::now() + Duration::from_secs(30)).map_err(failure)
}
impl Store {
    pub(crate) fn download_lunii_covers(self: &Arc<Self>, sink: scan::Sink) {
        #[cfg(test)]
        let base = match self.lunii.cover_base.lock().ok().and_then(|v| v.clone()) {
            Some(base) => base,
            None if self.lunii.cover_response_configured.load(Ordering::SeqCst) => {
                "http://127.0.0.1:9".to_owned()
            }
            // A fixture may inject either an HTTP server or in-memory bytes.
            // Unconfigured catalogue tests must not occupy shared transport.
            None => return,
        };
        #[cfg(not(test))]
        let base = "https://storage.googleapis.com/lunii-data-prod";
        self.download_lunii_covers_from(sink, base.to_owned());
    }

    pub(super) fn download_lunii_covers_from(self: &Arc<Self>, sink: scan::Sink, base: String) {
        if !self.lunii_allowed() {
            return;
        }
        let ids = self.read_snapshot(|c| c.prepare("SELECT DISTINCT v.fiche_id FROM reference_value v JOIN provenance p ON p.id=v.provenance_id LEFT JOIN lunii_image_attempt a ON a.fiche_id=v.fiche_id WHERE p.kind='lunii' AND v.field='cover' AND v.image_sha256 IS NULL AND coalesce(a.failures,0)<3 ORDER BY v.fiche_id")?.query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>());
        let Ok(ids) = ids else {
            return;
        };
        let ids: Vec<_> = ids
            .into_iter()
            .filter(|id| {
                self.lunii
                    .cover_attempted
                    .lock()
                    .is_ok_and(|a| !a.contains(id))
            })
            .collect();
        if ids.is_empty() {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            let mut failures = std::collections::BTreeMap::<String, usize>::new();
            for id in ids {
                let result = store.acquire_lunii_thumbnail(&id, &base);
                match result {
                    Ok(Some(t)) if t.state == "ready" => {
                        // Publish before starting the next request: later covers
                        // may each spend their full network deadline waiting.
                        if let Ok(list) = store.list_sources() {
                            sink(
                                "catalogue-operation-finished",
                                &super::super::events::Progress {
                                    request_id: "lunii-auto-images".into(),
                                    catalogue_changed: true,
                                    catalogue_revision: list.catalogue_revision,
                                    ..Default::default()
                                },
                            );
                        }
                    }
                    Err(reason) => *failures.entry(reason.code.to_string()).or_default() += 1,
                    _ => {}
                }
            }
            for (code, count) in failures {
                log::warn!("{count} official covers unavailable: {code}");
            }
        });
    }

    pub fn lunii_thumbnail(&self, id: &str) -> Result<Option<thumbnails::Thumbnail>> {
        let cover = self.read_snapshot(|c| {
            Ok(data::card::resolution(c, id, &[])?
                .values
                .get("cover")
                .cloned())
        })?;
        let Some(cover) = cover.filter(|v| v["kind"] == "lunii" && valid_cover(v)) else {
            return Ok(None);
        };
        if cover["sha256"].as_str().is_none() {
            // Report an in-flight official acquisition independently of the
            // display fallback. This status never starts a network request.
            let key = format!("{id}:{}", cover["imagePath"].as_str().unwrap());
            let pending = self
                .lunii
                .cover
                .lock()
                .map_err(error)?
                .iter()
                .any(|(k, job)| {
                    k == &key && job.result.lock().is_ok_and(|result| result.is_none())
                });
            return Ok(pending.then(|| thumbnails::Thumbnail::state("absent")));
        }
        self.lunii_thumbnail_from(id, "https://storage.googleapis.com/lunii-data-prod")
    }
    pub(super) fn lunii_thumbnail_from(
        &self,
        id: &str,
        base: &str,
    ) -> Result<Option<thumbnails::Thumbnail>> {
        match self.acquire_lunii_thumbnail(id, base) {
            Err(_) => Ok(Some(thumbnails::Thumbnail::state("absent"))),
            result => result,
        }
    }
    fn acquire_lunii_thumbnail(
        &self,
        id: &str,
        base: &str,
    ) -> Result<Option<thumbnails::Thumbnail>> {
        let image = self.read_snapshot(|c| {
            let resolved = data::card::resolution(c, id, &[])?;
            if resolved
                .values
                .get("cover")
                .and_then(|v| v["kind"].as_str())
                != Some("lunii")
            {
                return Ok(None);
            }
            let value = &resolved.values["cover"];
            let Some(path) = value["imagePath"].as_str().filter(|_| valid_cover(value)) else {
                return Ok(None);
            };
            let path = path.to_owned();
            let key = image_key(&path);
            if let Some(sha) = value["sha256"].as_str() {
                return Ok(Some((path, key, Some(sha.to_owned()))));
            }
            Ok(Some((path, key, None)))
        })?;
        let Some((path, key, sha)) = image else {
            return Ok(None);
        };
        if let Some(sha) = sha {
            let file = std::fs::File::open(self.images_root().join(sha)).map_err(error)?;
            let mut bytes = Vec::new();
            file.take(data::images::RETAINED_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(error)?;
            let bytes = verified_thumbnail(&bytes)?;
            return Ok(Some(thumbnails::Thumbnail::ready(&bytes)));
        }
        let bytes = self.fetch_lunii_cover(id, &path, base, &AtomicBool::new(false))?;
        self.retain_lunii_cover(id, &key, &bytes)?;
        self.lunii
            .cover_attempted
            .lock()
            .map_err(error)?
            .insert(id.to_owned());
        Ok(Some(thumbnails::Thumbnail::ready(&verified_thumbnail(
            &bytes,
        )?)))
    }
    /// Materialize the effective official image without requiring a thumbnail visit.
    /// Consumer preparations own these bytes; retaining a thumbnail later changes
    /// the catalogue notification revision, but not the selected card values.
    #[cfg(test)]
    pub(crate) fn lunii_cover_bytes(&self, id: &str, key: &str) -> Result<Vec<u8>> {
        self.lunii_cover_bytes_cancel(id, key, &AtomicBool::new(false))
    }
    pub(crate) fn lunii_cover_bytes_cancel(
        &self,
        id: &str,
        key: &str,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>> {
        cancelled(cancel)?;
        let cover = self
            .read_snapshot(|c| {
                Ok(data::card::resolution(c, id, &[])?
                    .values
                    .get("cover")
                    .cloned())
            })?
            .filter(|v| v["kind"] == "lunii" && v["key"] == key && valid_cover(v))
            .ok_or_else(|| message(codes::CATALOG_COVER_INVALID).param("path", ""))?;
        if let Some(sha) = cover["sha256"].as_str() {
            let file = std::fs::File::open(self.images_root().join(sha)).map_err(error)?;
            let mut bytes = Vec::new();
            file.take(data::images::RETAINED_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(error)?;
            return verified_cover(&bytes);
        }
        #[cfg(test)]
        let base = self
            .lunii
            .cover_base
            .lock()
            .map_err(error)?
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:9".into());
        #[cfg(not(test))]
        let base = "https://storage.googleapis.com/lunii-data-prod".to_owned();
        self.fetch_lunii_cover(id, cover["imagePath"].as_str().unwrap(), &base, cancel)
    }

    pub(super) fn fetch_lunii_cover(
        &self,
        id: &str,
        path: &str,
        base: &str,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>> {
        #[cfg(test)]
        struct Waiter<'a>(&'a std::sync::atomic::AtomicUsize);
        #[cfg(test)]
        impl Drop for Waiter<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        #[cfg(test)]
        let _waiter = {
            self.lunii.cover_waiters.fetch_add(1, Ordering::SeqCst);
            Waiter(&self.lunii.cover_waiters)
        };
        // The registry never owns a socket wait. Each consumer can leave while
        // the shared bounded transport continues for its other consumers.
        let mut acquisitions = loop {
            cancelled(cancel)?;
            match self.lunii.cover.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(error(e)),
            }
        };
        cancelled(cancel)?;
        // Automatic retention may have completed after the caller's first read.
        let sha = self.read_snapshot(|c| {
            Ok(data::card::resolution(c, id, &[])?
                .values
                .get("cover")
                .filter(|v| v["kind"] == "lunii" && v["key"] == image_key(path))
                .and_then(|v| v["sha256"].as_str())
                .map(str::to_owned))
        })?;
        if let Some(sha) = sha {
            let file = std::fs::File::open(self.images_root().join(sha)).map_err(error)?;
            let mut bytes = Vec::new();
            file.take(data::images::RETAINED_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(error)?;
            cancelled(cancel)?;
            return verified_cover(&bytes);
        }
        let key = format!("{id}:{path}");
        let attempted = self
            .lunii
            .cover_attempted
            .lock()
            .map_err(error)?
            .contains(id);
        // A completed failure is eligible again only after the next application launch.
        acquisitions.retain(|(k, job)| {
            k != &key || attempted || !job.failure_accounted.lock().is_ok_and(|v| *v)
        });
        let job = if let Some((_, job)) = acquisitions.iter().find(|(k, _)| k == &key) {
            Arc::clone(job)
        } else {
            let failures = self
                .read(|c| {
                    c.query_row(
                        "SELECT failures FROM lunii_image_attempt WHERE fiche_id=?1",
                        [id],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()
                })?
                .unwrap_or(0);
            if failures >= 3 || attempted {
                return Err(message(codes::CATALOG_LUNII_OFFLINE));
            }
            if acquisitions.len() >= ACQUISITIONS {
                let finished = acquisitions
                    .iter()
                    .position(|(_, job)| job.result.lock().is_ok_and(|v| v.is_some()));
                if let Some(index) = finished {
                    acquisitions.remove(index);
                } else {
                    return Err(message(codes::CATALOG_LUNII_BUSY));
                }
            }
            if !self.lunii_allowed() {
                return Err(message(codes::CATALOG_LUNII_OFFLINE));
            }
            let network_cancel = Arc::clone(&*self.lunii.network_cancel.lock().map_err(error)?);
            let job = Arc::new(Acquisition::default());
            let worker = Arc::clone(&job);
            let url = format!("{base}{path}");
            #[cfg(test)]
            let response = self.lunii.cover_response.lock().map_err(error)?.take();
            #[cfg(test)]
            let pause = self.lunii.cover_pause.lock().map_err(error)?.take();
            #[cfg(test)]
            self.lunii.cover_requests.fetch_add(1, Ordering::SeqCst);
            std::thread::Builder::new()
                .name("official-cover".into())
                .spawn(move || {
                    #[cfg(test)]
                    if let Some((ready, release)) = pause {
                        let _ = ready.send(());
                        let _ = release.recv_timeout(Duration::from_secs(5));
                    }
                    #[cfg(not(test))]
                    let response: Option<Vec<u8>> = None;
                    let result = if network_cancel.load(Ordering::SeqCst) {
                        Err(message(codes::GENERATION_CANCELLED))
                    } else {
                        match response {
                            Some(bytes) => normalize_cover(&bytes),
                            None => download_cover(&url, &network_cancel),
                        }
                        .map_err(|reason| reason.message)
                    };
                    if let Ok(mut slot) = worker.result.lock() {
                        *slot = Some(result);
                    }
                })
                .map_err(error)?;
            acquisitions.push_back((key, Arc::clone(&job)));
            job
        };
        drop(acquisitions);
        let result = loop {
            cancelled(cancel)?;
            if let Some(result) = job.result.lock().map_err(error)?.clone() {
                break result;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        cancelled(cancel)?;
        if result.as_ref().is_err_and(|reason| {
            matches!(
                reason.code.as_ref(),
                codes::CATALOG_LUNII_BUSY | codes::GENERATION_CANCELLED
            )
        }) {
            self.lunii
                .cover
                .lock()
                .map_err(error)?
                .retain(|(_, candidate)| !Arc::ptr_eq(candidate, &job));
            return result;
        }
        if result.is_ok() {
            self.lunii
                .cover_attempted
                .lock()
                .map_err(error)?
                .insert(id.to_owned());
        }
        if result.is_err() {
            let mut accounted = job.failure_accounted.lock().map_err(error)?;
            if !*accounted {
                self.write(|tx| {
                    tx.execute("INSERT INTO lunii_image_attempt VALUES (?1,1) ON CONFLICT(fiche_id) DO UPDATE SET failures=min(failures+1,3)", [id]).map_err(error)?;
                    Ok(())
                })?;
                self.lunii
                    .cover_attempted
                    .lock()
                    .map_err(error)?
                    .insert(id.to_owned());
                *accounted = true;
            }
        }
        result
    }
    #[cfg(test)]
    pub(crate) fn lunii_cover_test_pause(
        &self,
        ready: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        *self.lunii.cover_pause.lock().unwrap() = Some((ready, release));
    }
    #[cfg(test)]
    pub(crate) fn lunii_cover_test_waiters(&self, count: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while self.lunii.cover_waiters.load(Ordering::SeqCst) < count {
            assert!(
                Instant::now() < until,
                "consumers did not reach the shared acquisition"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    #[cfg(test)]
    pub(crate) fn lunii_cover_test_requests(&self) -> usize {
        self.lunii.cover_requests.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub(crate) fn lunii_cover_test_response(&self, bytes: Vec<u8>) {
        self.lunii
            .cover_response_configured
            .store(true, Ordering::SeqCst);
        *self.lunii.cover_response.lock().unwrap() = Some(bytes);
    }
    #[cfg(test)]
    pub(crate) fn lunii_cover_test_base(&self, base: String) {
        *self.lunii.cover_base.lock().unwrap() = Some(base);
    }

    pub(crate) fn retain_lunii_cover(&self, id: &str, key: &str, bytes: &[u8]) -> Result<()> {
        let staging = uuid::Uuid::new_v4().to_string();
        std::fs::write(self.staging_root().join(&staging), bytes).map_err(error)?;
        let result = self.write(|tx| {
            let sha = data::images::publish(self, tx, &staging)?;
            let changed = tx.execute(
                "UPDATE reference_value SET image_sha256=?1 WHERE fiche_id=?2 AND field='cover' AND json_extract(value_json,'$.key')=?3 AND image_sha256 IS NULL AND provenance_id IN (SELECT id FROM provenance WHERE kind='lunii')",
                rusqlite::params![sha, id, key],
            ).map_err(error)?;
            // Each retained image must invalidate catalogue readers and their
            // notification cursors. Its immutable key does not change the card.
            if changed > 0 {
                tx.execute("UPDATE catalogue SET revision=revision+1,cover_revision=cover_revision+1", []).map_err(error)?;
            }
            Ok(())
        });
        let _ = std::fs::remove_file(self.staging_root().join(staging));
        result
    }
}

fn verified_thumbnail(bytes: &[u8]) -> Result<Vec<u8>> {
    let encoded =
        thumbnails::encode_bounded(bytes).map_err(|_| message(codes::CATALOG_LUNII_INVALID))?;
    let dimensions = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok());
    if bytes.starts_with(&[0xff, 0xd8, 0xff])
        && bytes.len() <= thumbnails::TARGET
        && dimensions.is_some_and(|(w, h)| w <= thumbnails::LONG_SIDE && h <= thumbnails::LONG_SIDE)
    {
        Ok(bytes.to_vec())
    } else {
        Ok(encoded)
    }
}

fn verified_cover(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > data::images::RETAINED_BYTES {
        return Err(message(codes::CATALOG_LUNII_TOO_LARGE));
    }
    data::images::normalized_official_cover(bytes)
        .map_err(|_| message(codes::CATALOG_LUNII_INVALID))?;
    Ok(bytes.to_vec())
}

/// A cover download that failed. `definitive` is true when the image itself is
/// at fault (HTTP error, oversized or unreadable content), false for a
/// transport problem (offline, DNS, refused connection, timeout, cancellation).
pub(super) struct CoverFailure {
    pub(super) message: UserMessage,
    pub(super) definitive: bool,
}
/// Decodes and normalizes an official cover, whatever its origin.
pub(super) fn normalize_cover(bytes: &[u8]) -> std::result::Result<Vec<u8>, CoverFailure> {
    data::images::normalized_official_cover(bytes)
        .map(|(bytes, _, _)| bytes)
        .map_err(|_| CoverFailure {
            message: message(codes::CATALOG_LUNII_INVALID),
            definitive: true,
        })
}
/// Bounded download (10 MiB, 15 s) followed by normalization: shared by the
/// catalogue fiches and the device-only officials.
pub(super) fn download_cover(
    url: &str,
    cancel: &AtomicBool,
) -> std::result::Result<Vec<u8>, CoverFailure> {
    let bytes = bounded::get(
        url,
        None,
        10 * 1024 * 1024,
        cancel,
        Instant::now() + Duration::from_secs(15),
        |_| {},
    )
    .map_err(|reason| CoverFailure {
        definitive: matches!(reason, Failure::Status | Failure::TooLarge),
        message: failure(reason),
    })?;
    normalize_cover(&bytes)
}
