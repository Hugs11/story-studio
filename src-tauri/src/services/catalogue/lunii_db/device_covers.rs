//! D43: official covers of stories present only on a device, keyed by the
//! canonical UUID. Files under application data, outside the catalogue
//! schema: no fiche is ever created for these stories.
use super::{covers::download_cover, *};
use crate::services::storyteller_device::cards::reduced_cover;
use std::{collections::HashSet, path::PathBuf};
use uuid::Uuid;

const DIRECTORY: &str = "lunii-device-covers";
/// Same ceiling as an official fiche cover: after three counted failures the
/// image is no longer requested, a launch never retries a failure twice.
const FAILURES: u32 = 3;
/// `reduced_cover` output: PNG, at most 320×240 and 64 KiB.
const STORED_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub(crate) struct DeviceCovers {
    /// One request at a time per UUID, whichever device or inspection asked.
    pending: HashSet<Uuid>,
    /// Already tried during this launch (success or counted failure).
    attempted: HashSet<Uuid>,
}

/// Only the canonical form names a file: braces, URN or simple forms are refused.
fn canonical(key: &str) -> Result<Uuid> {
    Uuid::parse_str(key)
        .ok()
        .filter(|id| id.to_string() == key)
        .ok_or_else(|| message(codes::CATALOG_LUNII_INVALID))
}

impl Store {
    fn device_cover_root(&self) -> PathBuf {
        self.images_root().parent().unwrap().join(DIRECTORY)
    }
    fn device_cover_path(&self, id: Uuid) -> PathBuf {
        self.device_cover_root().join(format!("{id}.png"))
    }
    fn device_cover_failures_path(&self, id: Uuid) -> PathBuf {
        self.device_cover_root().join(format!("{id}.failures"))
    }

    /// Cheap presence check for the panel listing; serving validates the bytes.
    pub(crate) fn has_official_device_cover(&self, key: &str) -> bool {
        canonical(key).is_ok_and(|id| {
            std::fs::symlink_metadata(self.device_cover_path(id))
                .is_ok_and(|m| m.is_file() && m.len() > 0 && m.len() <= STORED_BYTES)
        })
    }

    /// Cached bytes, decoded and checked again; a damaged file is dropped so
    /// that the next connection can fetch it again.
    pub(crate) fn official_device_cover(&self, key: &str) -> Result<Vec<u8>> {
        let id = canonical(key)?;
        let path = self.device_cover_path(id);
        let meta = std::fs::symlink_metadata(&path).map_err(error)?;
        if !meta.is_file() {
            return Err(message(codes::CATALOG_LUNII_INVALID));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .map_err(error)?
            .take(STORED_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        let valid = bytes.len() as u64 <= STORED_BYTES
            && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            && reduced_cover(&bytes).is_ok();
        if !valid {
            let _ = std::fs::remove_file(&path);
            return Err(message(codes::CATALOG_LUNII_INVALID));
        }
        Ok(bytes)
    }

    /// Image path of a recognized official, in the same locale as its title.
    /// `None` for a UUID absent from the official database: no request.
    fn official_image_path(&self, id: Uuid) -> Option<String> {
        self.read(|c| {
            let raw: Option<String> = c
                .query_row(
                    "SELECT document_json FROM lunii_pack WHERE uuid=?1",
                    [id.to_string()],
                    |r| r.get(0),
                )
                .optional()?;
            let locale: String =
                c.query_row("SELECT locale FROM lunii_context WHERE id=1", [], |r| {
                    r.get(0)
                })?;
            // `localized` chooses the locale slot (as for the title) but
            // leaves the image out of its values: read it from that slot.
            Ok(raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| {
                    parse::localized(&v, &locale).and_then(|(key, _)| image_path(&v, &key))
                })
                .filter(|p| parse::image_path_valid(p)))
        })
        .ok()
        .flatten()
    }

    fn device_cover_failures(&self, id: Uuid) -> u32 {
        let mut text = String::new();
        std::fs::File::open(self.device_cover_failures_path(id))
            .and_then(|f| f.take(16).read_to_string(&mut text))
            .ok()
            .and_then(|_| text.trim().parse().ok())
            .unwrap_or(0)
    }

    fn count_device_cover_failure(&self, id: Uuid) {
        let count = (self.device_cover_failures(id) + 1).min(FAILURES);
        let written = std::fs::create_dir_all(self.device_cover_root()).and_then(|_| {
            write_replacing(
                &self.device_cover_failures_path(id),
                count.to_string().as_bytes(),
            )
        });
        if let Err(reason) = written {
            log::warn!(
                "Official device cover failure not recorded: {:?}",
                reason.kind()
            );
        }
    }

    /// Background download, once per UUID and launch, for each recognized
    /// official without a cached cover. Nothing happens without the network
    /// agreement already given for the official database. `done` is called
    /// once at the end of a batch that kept at least one cover, so the device panel reads itself again.
    pub(crate) fn fetch_official_device_covers(
        self: &Arc<Self>,
        ids: &[Uuid],
        done: Arc<dyn Fn() + Send + Sync>,
    ) {
        #[cfg(test)]
        let Some(base) = self.lunii.cover_base.lock().ok().and_then(|v| v.clone()) else {
            // Background test requests require an explicitly injected server;
            // otherwise they can starve concurrent HTTP fixture tests.
            return;
        };
        #[cfg(not(test))]
        let base = "https://storage.googleapis.com/lunii-data-prod".to_owned();
        let _ = self.fetch_official_device_covers_from(ids, base, done);
    }

    pub(super) fn fetch_official_device_covers_from(
        self: &Arc<Self>,
        ids: &[Uuid],
        base: String,
        done: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<std::thread::JoinHandle<()>> {
        if !self.lunii_allowed() {
            return None;
        }
        let wanted: Vec<(Uuid, String)> = {
            let Ok(mut state) = self.lunii.device_covers.lock() else {
                return None;
            };
            let mut wanted = Vec::new();
            for &id in ids {
                if state.pending.contains(&id)
                    || state.attempted.contains(&id)
                    || self.has_official_device_cover(&id.to_string())
                    || self.device_cover_failures(id) >= FAILURES
                {
                    continue;
                }
                let Some(path) = self.official_image_path(id) else {
                    continue;
                };
                state.pending.insert(id);
                wanted.push((id, path));
            }
            wanted
        };
        if wanted.is_empty() {
            return None;
        }
        let store = Arc::clone(self);
        let worker = std::thread::Builder::new()
            .name("official-device-cover".into())
            .spawn(move || {
                let mut failures = std::collections::BTreeMap::<String, usize>::new();
                let mut kept = false;
                for (id, path) in wanted {
                    let result = store.download_device_cover(id, &path, &base);
                    // Cancellation (agreement withdrawn) and a full transport
                    // are neither counted nor final for this launch.
                    let mut transient = false;
                    if let Err(reason) = &result {
                        transient = matches!(
                            reason.message.code.as_ref(),
                            codes::CATALOG_LUNII_BUSY | codes::GENERATION_CANCELLED
                        );
                        // Only the image's fault counts toward the three
                        // failures: an HTTP error or invalid content. Being
                        // offline, DNS, a refused connection or a timeout do not.
                        if reason.definitive && !transient {
                            store.count_device_cover_failure(id);
                        }
                        *failures.entry(reason.message.code.to_string()).or_default() += 1;
                    }
                    if let Ok(mut state) = store.lunii.device_covers.lock() {
                        state.pending.remove(&id);
                        if !transient {
                            state.attempted.insert(id);
                        }
                    }
                    kept |= result.is_ok();
                }
                // One refresh for the whole batch, not one per cover.
                if kept {
                    done();
                }
                for (code, count) in failures {
                    log::warn!("{count} official device covers unavailable: {code}");
                }
            });
        match worker {
            Ok(handle) => Some(handle),
            Err(_) => {
                if let Ok(mut state) = self.lunii.device_covers.lock() {
                    state.pending.clear();
                }
                None
            }
        }
    }

    fn download_device_cover(
        &self,
        id: Uuid,
        path: &str,
        base: &str,
    ) -> std::result::Result<(), covers::CoverFailure> {
        let transport = |reason: UserMessage| covers::CoverFailure {
            message: reason,
            definitive: false,
        };
        if !self.lunii_allowed() {
            return Err(transport(message(codes::GENERATION_CANCELLED)));
        }
        let cancel = Arc::clone(
            &*self
                .lunii
                .network_cancel
                .lock()
                .map_err(|e| transport(error(e)))?,
        );
        #[cfg(test)]
        self.lunii.cover_requests.fetch_add(1, Ordering::SeqCst);
        let normalized = download_cover(&format!("{base}{path}"), &cancel)?;
        // `reduced_cover` already guarantees PNG, 320x240 at most, 64 KiB at most.
        let png = reduced_cover(&normalized).map_err(|_| covers::CoverFailure {
            message: message(codes::CATALOG_LUNII_INVALID),
            definitive: true,
        })?;
        std::fs::create_dir_all(self.device_cover_root()).map_err(|e| transport(error(e)))?;
        write_replacing(&self.device_cover_path(id), &png).map_err(|e| transport(error(e)))?;
        let _ = std::fs::remove_file(self.device_cover_failures_path(id));
        Ok(())
    }
}

/// Temporary file in the same directory, then rename: a reader never sees a
/// partial cover.
fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, sync::atomic::AtomicUsize};

    const OFFICIAL: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn store(image: &str) -> (Temp, Arc<Store>) {
        let temp = Temp(std::env::temp_dir().join(format!("device-cover-{}", Uuid::new_v4())));
        std::fs::create_dir_all(&temp.0).unwrap();
        let s = Store::open(&temp.0.join("data"), &temp.0.join("cache")).unwrap();
        s.set_lunii_permission(true).unwrap();
        s.lunii_locale("fr").unwrap();
        let raw = json!({"k":{"uuid":OFFICIAL,"localized_infos":{
            "fr_FR":{"title":"Lune","image":{"image_url":image}},
            "en_US":{"title":"Moon","image":{"image_url":"/public/images/packs/en.png"}}}}});
        s.publish_lunii(
            &parse::parse(raw.to_string().as_bytes()).unwrap(),
            "import",
            &AtomicBool::new(false),
        )
        .unwrap();
        (temp, Arc::new(s))
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_fn(width, height, |x, y| image::Rgb([x as u8, y as u8, 7]))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    /// Local server answering `responses` in order; returns the request lines.
    fn serve(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "no local request");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("local server: {e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                requests.push(
                    bounded::read_request(&mut socket)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_owned(),
                );
                let _ = socket.write_all(&response);
            }
            requests
        });
        (base, server)
    }
    fn ok(body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }
    fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        (
            count,
            Arc::new(move || {
                seen.fetch_add(1, Ordering::SeqCst);
            }),
        )
    }
    fn official() -> Uuid {
        Uuid::parse_str(OFFICIAL).unwrap()
    }
    fn next_launch(s: &Store) {
        s.lunii.device_covers.lock().unwrap().attempted.clear();
    }

    #[test]
    fn kept_cover_is_served_without_network_and_refresh_is_emitted() {
        let _network = bounded::test_network();
        let (_temp, s) = store("/public/images/packs/test.png");
        assert!(!s.has_official_device_cover(OFFICIAL));
        let (base, server) = serve(vec![ok(&png(1200, 900))]);
        let (done, notify) = counter();
        s.fetch_official_device_covers_from(&[official()], base, notify)
            .unwrap()
            .join()
            .unwrap();
        // Same locale as the title: the French image, not the English one.
        assert_eq!(
            server.join().unwrap(),
            ["GET /public/images/packs/test.png HTTP/1.1"]
        );
        assert_eq!(done.load(Ordering::SeqCst), 1);
        assert!(s.has_official_device_cover(OFFICIAL));
        let file = s.device_cover_path(official());
        assert_eq!(
            file.file_name().unwrap(),
            format!("{OFFICIAL}.png").as_str()
        );
        assert!(file.starts_with(s.images_root().parent().unwrap()));
        let leftovers = std::fs::read_dir(s.device_cover_root()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary file left");
        // Offline and without agreement, the cache is still served and nothing is requested.
        s.set_lunii_permission(false).unwrap();
        let bytes = s.official_device_cover(OFFICIAL).unwrap();
        assert!(bytes.len() as u64 <= STORED_BYTES);
        let image = image::load_from_memory(&bytes).unwrap();
        let (w, h) = (image.width(), image.height());
        assert!(w <= 320 && h <= 240);
        s.set_lunii_permission(true).unwrap();
        let requests = s.lunii_cover_test_requests();
        assert!(s
            .fetch_official_device_covers_from(
                &[official()],
                "http://127.0.0.1:9".into(),
                counter().1
            )
            .is_none());
        next_launch(&s);
        assert!(s
            .fetch_official_device_covers_from(
                &[official()],
                "http://127.0.0.1:9".into(),
                counter().1
            )
            .is_none());
        assert_eq!(s.lunii_cover_test_requests(), requests);
    }

    #[test]
    fn without_agreement_or_for_an_unknown_uuid_nothing_is_requested() {
        let (_temp, s) = store("/public/images/packs/test.png");
        s.set_lunii_permission(false).unwrap();
        let (done, notify) = counter();
        assert!(s
            .fetch_official_device_covers_from(
                &[official()],
                "http://127.0.0.1:9".into(),
                notify.clone()
            )
            .is_none());
        s.set_lunii_permission(true).unwrap();
        let unknown = Uuid::new_v4();
        assert!(s
            .fetch_official_device_covers_from(&[unknown], "http://127.0.0.1:9".into(), notify)
            .is_none());
        assert_eq!(s.lunii_cover_test_requests(), 0);
        assert_eq!(done.load(Ordering::SeqCst), 0);
        assert!(!s.has_official_device_cover(&unknown.to_string()));
    }

    #[test]
    fn invalid_image_path_in_the_database_is_never_requested() {
        let (_temp, s) = store("/public/images/packs/test.png");
        s.write(|tx| {
            tx.execute(
                "UPDATE lunii_pack SET document_json=json_set(document_json,'$.localized_infos.fr_FR.imagePath','/public/images/../../etc/passwd') WHERE uuid=?1",
                [OFFICIAL],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
        assert!(s
            .fetch_official_device_covers_from(
                &[official()],
                "http://127.0.0.1:9".into(),
                counter().1
            )
            .is_none());
        assert_eq!(s.lunii_cover_test_requests(), 0);
    }

    #[test]
    fn non_canonical_uuid_is_refused() {
        let (_temp, s) = store("/public/images/packs/test.png");
        let upper = OFFICIAL.to_uppercase();
        let simple = OFFICIAL.replace('-', "");
        let braced = format!("{{{OFFICIAL}}}");
        for key in [upper.as_str(), simple.as_str(), braced.as_str(), "../x", ""] {
            assert!(!s.has_official_device_cover(key));
            assert!(s.official_device_cover(key).is_err());
        }
    }

    #[test]
    fn network_failure_is_counted_then_no_longer_retried() {
        let _network = bounded::test_network();
        let (_temp, s) = store("/public/images/packs/test.png");
        let unavailable =
            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (done, notify) = counter();
        for launch in 1..=FAILURES {
            let (base, server) = serve(vec![unavailable.clone()]);
            s.fetch_official_device_covers_from(&[official()], base.clone(), notify.clone())
                .unwrap()
                .join()
                .unwrap();
            assert_eq!(server.join().unwrap().len(), 1);
            assert_eq!(s.device_cover_failures(official()), launch);
            // Same launch: a refresh of the panel never asks again.
            assert!(s
                .fetch_official_device_covers_from(&[official()], base, notify.clone())
                .is_none());
            next_launch(&s);
        }
        let requests = s.lunii_cover_test_requests();
        assert!(s
            .fetch_official_device_covers_from(&[official()], "http://127.0.0.1:9".into(), notify)
            .is_none());
        assert_eq!(s.lunii_cover_test_requests(), requests);
        assert_eq!(done.load(Ordering::SeqCst), 0);
        assert!(!s.has_official_device_cover(OFFICIAL));
    }

    #[test]
    fn offline_is_not_counted_toward_the_definitive_failures() {
        let _network = bounded::test_network();
        let (_temp, s) = store("/public/images/packs/test.png");
        // Nothing listens on this port: connection refused, an offline failure.
        let (done, notify) = counter();
        s.fetch_official_device_covers_from(&[official()], "http://127.0.0.1:9".into(), notify)
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(s.device_cover_failures(official()), 0);
        assert_eq!(done.load(Ordering::SeqCst), 0);
        // Still retried at the next launch.
        next_launch(&s);
        let (base, server) = serve(vec![ok(&png(64, 48))]);
        s.fetch_official_device_covers_from(&[official()], base, counter().1)
            .unwrap()
            .join()
            .unwrap();
        server.join().unwrap();
        assert!(s.has_official_device_cover(OFFICIAL));
    }

    #[test]
    fn a_batch_refreshes_once() {
        let _network = bounded::test_network();
        let (_temp, s) = store("/public/images/packs/test.png");
        let second = Uuid::new_v4();
        s.write(|tx| {
            let raw: String = tx
                .query_row(
                    "SELECT document_json FROM lunii_pack WHERE uuid=?1",
                    [OFFICIAL],
                    |r| r.get(0),
                )
                .map_err(error)?;
            tx.execute(
                "INSERT INTO lunii_pack(uuid, document_json) SELECT ?1, ?2",
                rusqlite::params![second.to_string(), raw],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
        let (base, server) = serve(vec![ok(&png(64, 48)), ok(&png(64, 48))]);
        let (done, notify) = counter();
        s.fetch_official_device_covers_from(&[official(), second], base, notify)
            .unwrap()
            .join()
            .unwrap();
        drop(server);
        assert_eq!(done.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn invalid_or_oversized_image_is_refused_and_not_kept() {
        let _network = bounded::test_network();
        let (_temp, s) = store("/public/images/packs/test.png");
        let oversized =
            b"HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n".to_vec();
        for response in [ok(b"not an image at all"), oversized] {
            next_launch(&s);
            let (base, server) = serve(vec![response]);
            let (done, notify) = counter();
            s.fetch_official_device_covers_from(&[official()], base, notify)
                .unwrap()
                .join()
                .unwrap();
            server.join().unwrap();
            assert_eq!(done.load(Ordering::SeqCst), 0);
            assert!(!s.has_official_device_cover(OFFICIAL));
            assert!(s.official_device_cover(OFFICIAL).is_err());
        }
        assert_eq!(s.device_cover_failures(official()), 2);
        assert!(!s.device_cover_root().read_dir().unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".png")));
    }

    #[test]
    fn damaged_cache_is_refused_and_dropped() {
        let (_temp, s) = store("/public/images/packs/test.png");
        std::fs::create_dir_all(s.device_cover_root()).unwrap();
        let path = s.device_cover_path(official());
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nbroken").unwrap();
        assert!(s.has_official_device_cover(OFFICIAL));
        assert!(s.official_device_cover(OFFICIAL).is_err());
        assert!(!path.exists());
        std::fs::write(&path, vec![0u8; STORED_BYTES as usize + 1]).unwrap();
        assert!(!s.has_official_device_cover(OFFICIAL));
        assert!(s.official_device_cover(OFFICIAL).is_err());
    }
}
