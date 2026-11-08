use super::*;
use crate::services::catalogue::data::journal::Mutation;
use crate::services::catalogue::{
    events::Progress,
    refresh::{Change, Root},
};
use std::{collections::BTreeMap, fs, path::PathBuf, time::Instant};

/// Inventaire attendu d'un pack converti depuis un dossier ou une archive
/// reconvertie (7z) : les fichiers étrangers à la racine (ici `extra.txt`) ne
/// font pas partie du pack converti ; tout le reste est comparé exactement.
pub(super) fn pack_only(mut inventory: BTreeMap<String, String>) -> BTreeMap<String, String> {
    assert!(
        inventory.remove("extra.txt").is_some(),
        "fixture sans fichier étranger"
    );
    inventory
}
struct Fixture {
    root: PathBuf,
    store: Arc<Store>,
    source: PathBuf,
    card: Value,
    exemplar: Value,
}
impl Fixture {
    fn new(directory: bool) -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("catalogue-files-{}", uuid::Uuid::new_v4()));
        let packs = root.join("packs");
        fs::create_dir_all(&packs).unwrap();
        let source = packs.join(if directory {
            "Original"
        } else {
            "Original.zip"
        });
        let story = json!({"title":"Original","description":"Before","version":1,"stageNodes":[{"uuid":"bda17862-0d71-41f6-974a-111111111111","squareOne":true,"image":"image","audio":"audio"}],"actionNodes":[]});
        let entries = [
            ("story.json", serde_json::to_vec_pretty(&story).unwrap()),
            ("assets/image", b"unchanged-invalid-image".to_vec()),
            ("assets/audio", b"unchanged-invalid-audio".to_vec()),
            ("thumbnail.png", b"old cover".to_vec()),
            ("extra.txt", b"extra".to_vec()),
        ];
        if directory {
            fs::create_dir_all(source.join("assets")).unwrap();
            for (name, bytes) in entries {
                fs::write(source.join(name), bytes).unwrap();
            }
        } else {
            use std::io::Write;
            let mut w = zip::ZipWriter::new(fs::File::create(&source).unwrap());
            for (name, bytes) in entries {
                w.start_file(
                    name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
                w.write_all(&bytes).unwrap();
            }
            w.finish().unwrap();
        }
        let store = Arc::new(Store::open(&root.join("data"), &root.join("cache")).unwrap());
        store.add_source(&packs, 0, false).unwrap();
        let sources = store.list_sources().unwrap();
        store
            .refresh_paths(
                &Root {
                    source_id: sources.items[0].id.clone(),
                    path: packs,
                },
                &[Change {
                    path: source.clone(),
                    settled: true,
                    structural: true,
                }],
                &store
                    .exclusions(&root.join("cache"), &root.join("data"))
                    .unwrap(),
                Duration::ZERO,
                &AtomicBool::new(false),
                &writes::Registry::default(),
            )
            .unwrap();
        let page = store.list_entries(100, None).unwrap();
        let card = serde_json::to_value(&page).unwrap()["items"][0].clone();
        let detail = store.get_card(card["id"].as_str().unwrap()).unwrap();
        let exemplar = detail["exemplars"][0].clone();
        Self {
            root,
            store,
            source,
            card: detail,
            exemplar,
        }
    }
    fn wait(&self, id: &str) -> Progress {
        let start = Instant::now();
        loop {
            let p = self.store.get_operation(id).unwrap();
            if !matches!(p.status.as_str(), "queued" | "running" | "cancelling") {
                let unused = self.store.read(|c| c.query_row("SELECT count(*) FROM tag WHERE NOT EXISTS(SELECT 1 FROM tag_member WHERE tag_id=tag.id)", [], |r| r.get::<_, i64>(0))).unwrap();
                assert_eq!(unused, 0, "completed file operations prune unused labels");
                return p;
            }
            assert!(start.elapsed() < crate::test_support::timeout());
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn corrupt_zip_and_links_are_refused_and_exclusive_publish_never_clobbers() {
    let f = Fixture::new(false);
    let bad = f.root.join("bad.zip");
    fs::write(&bad, b"bad").unwrap();
    assert!(patch::inventory(&bad, &AtomicBool::new(false)).is_err());
    let a = f.root.join("a");
    let b = f.root.join("b");
    fs::write(&a, b"a").unwrap();
    fs::write(&b, b"b").unwrap();
    assert_eq!(
        publish::no_replace(&a, &b).unwrap_err().code,
        codes::CATALOG_FILE_NAME_CONFLICT
    );
    assert_eq!(fs::read(&a).unwrap(), b"a");
    assert_eq!(fs::read(&b).unwrap(), b"b");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&a, f.root.join("link")).unwrap();
        assert!(patch::snapshot(&f.root.join("link"), &AtomicBool::new(false)).is_err());
    }
}

#[path = "convert_review_tests.rs"]
mod convert_review;
#[path = "review_tests.rs"]
mod review;
/// A 7z holding one device pack (common-key encrypted) under its UUID
/// folder, written by the bundled 7z tool from the shared reader fixture.
fn device_seven_zip(archive: &Path) {
    let tree = archive.with_extension("tree");
    crate::support::fs_pack_reader::fs_fixtures::write_encrypted_cover_pack(
        &tree.join(crate::support::fs_pack_reader::fs_fixtures::DIALECT_PACK_UUID),
        b"BMdevice-seven-zip-cover",
    );
    let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
    let output = std::process::Command::new(tool)
        .arg("a")
        .arg("-t7z")
        .arg(archive)
        .arg(crate::support::fs_pack_reader::fs_fixtures::DIALECT_PACK_UUID)
        .current_dir(&tree)
        .output()
        .unwrap();
    assert!(output.status.success());
    fs::remove_dir_all(tree).unwrap();
}

#[path = "diagnostics_tests.rs"]
mod diagnostics;

fn assembly_request(f: &Fixture) -> crate::services::catalogue::assembly::Request {
    crate::services::catalogue::assembly::Request {
        ordered_selection: vec![crate::services::catalogue::assembly::Selection {
            fiche_id: f.card["ficheId"].as_str().unwrap().into(),
            expected_fiche_revision: f.card["ficheRevision"].as_i64().unwrap(),
        }],
        exemplar_choices: Default::default(),
        request_id: uuid::Uuid::new_v4().to_string(),
    }
}
fn assembly_finish(f: &Fixture, receipt: &Value) -> Progress {
    let until = Instant::now() + crate::test_support::timeout();
    loop {
        let p = f
            .store
            .get_operation(receipt["operationId"].as_str().unwrap())
            .unwrap();
        if ["success", "failed", "partial", "cancelled"].contains(&p.status.as_str()) {
            return p;
        }
        assert!(Instant::now() < until, "preparation timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn assembly_owns_converted_inputs_and_release_is_idempotent() {
    for folder in [false, true] {
        let f = Fixture::new(folder);
        let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        let receipt = f
            .store
            .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
            .unwrap();
        let done = assembly_finish(&f, &receipt);
        assert_eq!(done.status, "success", "{:?}", done.error);
        let result = done.result.unwrap();
        assert_eq!(result["ownership"], "assistant");
        assert_eq!(result["entries"][0]["title"], "Original");
        let output = PathBuf::from(result["entries"][0]["zipPath"].as_str().unwrap());
        assert!(output.is_file());
        assert!(
            result["entries"][0]["coverPath"].is_null(),
            "invalid cover bytes are not assembled"
        );
        assert_ne!(output, f.source);
        assert_eq!(
            before,
            patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap()
        );
        let id = result["preparationId"].as_str().unwrap();
        assert_eq!(f.store.release_assembly(id).unwrap()["released"], true);
        assert!(!output.exists());
        assert_eq!(f.store.release_assembly(id).unwrap()["released"], false);
    }
}
#[test]
fn assembly_rejects_stale_cards_and_replays_only_the_same_request() {
    let f = Fixture::new(false);
    let mut request = assembly_request(&f);
    request.ordered_selection[0].expected_fiche_revision += 1;
    let receipt = f
        .store
        .prepare_assembly(request.clone(), Arc::new(|_, _| {}))
        .unwrap();
    assert_eq!(
        receipt,
        f.store
            .prepare_assembly(request.clone(), Arc::new(|_, _| {}))
            .unwrap()
    );
    request.ordered_selection[0].expected_fiche_revision += 1;
    assert!(f
        .store
        .prepare_assembly(request, Arc::new(|_, _| {}))
        .is_err());
    let done = assembly_finish(&f, &receipt);
    assert_eq!(done.status, "failed");
    assert_eq!(
        done.error.unwrap().code,
        codes::CATALOG_ASSEMBLY_SOURCE_CHANGED
    );
}
#[test]
fn assembly_detects_a_source_replaced_after_indexing() {
    let f = Fixture::new(false);
    fs::write(&f.source, b"external replacement").unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let done = assembly_finish(&f, &receipt);
    assert_eq!(done.status, "failed");
    assert_eq!(
        done.error.unwrap().code,
        codes::CATALOG_ASSEMBLY_SOURCE_CHANGED
    );
}
#[test]
fn assembly_tasks_prevent_cleanup_and_last_reader_cleans_deferred_release() {
    let f = Fixture::new(false);
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let result = assembly_finish(&f, &receipt).result.unwrap();
    let id = result["preparationId"].as_str().unwrap();
    let first = f.store.retain_assembly_task(id).unwrap();
    let second = f.store.retain_assembly_task(id).unwrap();
    assert_eq!(
        f.store.release_assembly(id).unwrap_err().code,
        codes::CATALOG_ASSEMBLY_PREPARATION_IN_USE
    );
    let path = PathBuf::from(result["entries"][0]["zipPath"].as_str().unwrap());
    f.store.finish_assembly_task(&first).unwrap();
    assert!(path.exists());
    f.store.finish_assembly_task(&first).unwrap();
    assert!(path.exists());
    f.store.finish_assembly_task(&second).unwrap();
    assert!(!path.exists());
    assert_eq!(f.store.release_assembly(id).unwrap()["released"], false);
}
#[test]
fn assembly_effective_age_zero_and_intentional_clear_match_contract() {
    let f = Fixture::new(false);
    let card = f.card["ficheId"].as_str().unwrap();
    f.store.write(|tx| {
        tx.execute("INSERT INTO provenance(id,kind) VALUES ('assembly-manual','manual')", []).map_err(error)?;
        tx.execute("INSERT INTO correction VALUES (?1,'ageMin','','defined','0','assembly-manual',NULL,1)",[card]).map_err(error)?;
        Ok(())
    }).unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let result = assembly_finish(&f, &receipt).result.unwrap();
    assert_eq!(result["suggestedAgeMin"], 0);
    assert_eq!(result["entries"][0]["ageMin"], 0);
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/assembly-preparation.json"
    ))
    .unwrap();
    let keys = |v: &Value| {
        v.as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert_eq!(keys(&result), keys(&fixture));
    assert_eq!(keys(&result["entries"][0]), keys(&fixture["entries"][0]));
    f.store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
    f.store.write(|tx| { tx.execute("UPDATE correction SET state='cleared',value_json=NULL WHERE fiche_id=?1 AND field='ageMin'",[card]).map_err(error)?; Ok(()) }).unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let result = assembly_finish(&f, &receipt).result.unwrap();
    assert!(result["suggestedAgeMin"].is_null());
    assert!(result["entries"][0]["ageMin"].is_null());
    f.store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
}
#[test]
fn assembly_cancelled_in_queue_leaves_no_owned_inputs() {
    let f = Fixture::new(false);
    let guard = f.store.scans.heavy.lock().unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    f.store
        .cancel_operation(receipt["operationId"].as_str().unwrap())
        .unwrap();
    drop(guard);
    let done = assembly_finish(&f, &receipt);
    assert_eq!(done.status, "cancelled");
    assert!(done.result.is_none());
    assert!(!f.store.file_root().join("assembly").exists());
}
#[test]
fn assembly_retains_corrected_cover_independently_of_staging() {
    let f = Fixture::new(false);
    let card = f.card["ficheId"].as_str().unwrap();
    let image = f.root.join("chosen.png");
    image::RgbImage::new(2, 2).save(&image).unwrap();
    let staged = f.store.stage_cover(&image).unwrap();
    let stage_id = staged["coverStagingId"].as_str().unwrap();
    let sha = staged["sha256"].as_str().unwrap();
    f.store
        .write(|tx| {
            let sha = crate::services::catalogue::data::images::publish(&f.store, tx, stage_id)?;
            tx.execute(
                "INSERT INTO provenance(id,kind) VALUES ('assembly-cover','manual')",
                [],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO correction VALUES (?1,'cover','','defined',?2,'assembly-cover',?3,1)",
                rusqlite::params![card, json!({"sha256":sha}).to_string(), sha],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let expected = fs::read(f.store.images_root().join(sha)).unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let result = assembly_finish(&f, &receipt).result.unwrap();
    f.store.discard_covers(&[stage_id.to_owned()]).unwrap();
    let cover = PathBuf::from(result["entries"][0]["coverPath"].as_str().unwrap());
    assert_eq!(fs::read(&cover).unwrap(), expected);
    assert_ne!(cover, f.store.images_root().join(sha));
    assert!(result["entries"][0]["provenance"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["field"] == "cover" && field["effective"]["origin"] == "correction"));
    f.store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
    assert!(!cover.exists());
    assert!(f.store.images_root().join(sha).exists());
}

#[test]
fn assembly_operation_page_has_flat_progress_contract() {
    let f = Fixture::new(false);
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    assembly_finish(&f, &receipt);
    let page = serde_json::to_value(
        f.store
            .operation_page(receipt["operationId"].as_str().unwrap(), 100, None)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(page["status"], "success");
    assert!(page["result"]["preparationId"].is_string());
    assert!(page["items"].is_array());
    assert!(page.get("progress").is_none());
    f.store
        .release_assembly(page["result"]["preparationId"].as_str().unwrap())
        .unwrap();
}

#[test]
fn assembly_source_changes_during_conversion_remove_owned_outputs() {
    for disappear in [false, true] {
        let f = Fixture::new(true);
        let source = f.source.clone();
        convert::ASSEMBLY_CONVERSION_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                if disappear {
                    fs::remove_dir_all(&source).unwrap();
                } else {
                    fs::write(source.join("assets/audio"), b"external edit").unwrap();
                }
            }));
        });
        let result =
            f.store
                .assembly_inputs(&assembly_request(&f), &AtomicBool::new(false), |_, _| {});
        assert!(result.is_err());
        let root = f.store.file_root().join("assembly");
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
        if !disappear {
            assert_eq!(
                fs::read(f.source.join("assets/audio")).unwrap(),
                b"external edit"
            );
        }
    }
}

#[test]
fn assembly_more_than_128_prepare_release_cycles_remain_usable() {
    let f = Fixture::new(false);
    for _ in 0..130 {
        let receipt = f
            .store
            .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
            .unwrap();
        let done = assembly_finish(&f, &receipt);
        assert_eq!(done.status, "success", "{:?}", done.error);
        f.store
            .release_assembly(done.result.unwrap()["preparationId"].as_str().unwrap())
            .unwrap();
    }
    assert_eq!(
        fs::read_dir(f.store.file_root().join("assembly"))
            .unwrap()
            .count(),
        0
    );
}

#[path = "trash_tests.rs"]
mod trash_tests;

#[test]
fn official_cover_is_materialized_for_assembly_before_any_thumbnail() {
    official_cover_consumers(false);
}
#[test]
fn official_cover_consumers_download_from_http_before_any_thumbnail() {
    official_cover_consumers(true);
}
fn official_cover_consumers(http: bool) {
    use std::io::Write;
    let _network = http.then(crate::support::network::bounded::test_network);
    let mut f = official_cover_fixture();
    let id = f.card["ficheId"].as_str().unwrap().to_owned();
    let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let server = if http {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        f.store
            .lunii_cover_test_base(format!("http://{}", listener.local_addr().unwrap()));
        Some(crate::test_support::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let until = Instant::now() + crate::test_support::timeout();
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("image was never requested: {e}"),
                }
            };
            let request = crate::support::network::bounded::read_request(&mut stream);
            assert!(request.contains("/public/images/packs/cover.png"));
            let bytes = include_bytes!("../../../../icons/32x32.png");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(bytes).unwrap();
        }))
    } else {
        f.store
            .lunii_cover_test_response(include_bytes!("../../../../icons/32x32.png").to_vec());
        None
    };
    f.card = f.store.get_card(&id).unwrap();
    let inputs = f
        .store
        .assembly_inputs(&assembly_request(&f), &AtomicBool::new(false), |_, _| {})
        .unwrap();
    let cover = fs::read(inputs["entries"][0]["coverPath"].as_str().unwrap()).unwrap();
    image::load_from_memory(&cover).unwrap();
    if let Some(server) = server {
        crate::test_support::join(server);
    }
    assert_eq!(
        patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap(),
        before
    );
}

fn official_cover_fixture() -> Fixture {
    let mut f = Fixture::new(false);
    let id = f.card["ficheId"].as_str().unwrap().to_owned();
    f.store.set_lunii_permission(true).unwrap();
    f.store.lunii_locale("fr").unwrap();
    let uuid = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT verified_uuid FROM exemplar WHERE fiche_id=?1",
                [&id],
                |r| r.get::<_, String>(0),
            )
        })
        .unwrap();
    let official = f.root.join("official.json");
    fs::write(&official, json!({"pack":{"uuid":uuid,"localized_infos":{"fr_FR":{"title":"Official","image":{"image_url":"/public/images/packs/cover.png"}}}}}).to_string()).unwrap();
    f.store.load_lunii_fixture(&official).unwrap();
    f.card = f.store.get_card(&id).unwrap();
    f
}

#[test]
fn assembly_cover_cancellation_leaves_the_automatic_consumer_running() {
    suspended_assembly_cover(false, true);
    suspended_assembly_cover(false, false);
}
#[test]
fn assembly_cover_cancellation_with_suspended_http_response() {
    suspended_assembly_cover(true, false);
}
fn suspended_assembly_cover(http: bool, automatic_first: bool) {
    use std::{io::Write, sync::mpsc};
    let f = official_cover_fixture();
    let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let (ready, started) = mpsc::channel();
    let (release, finish) = mpsc::channel();
    let _network = http.then(crate::support::network::bounded::test_network);
    let server = if http {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        f.store
            .lunii_cover_test_base(format!("http://{}", listener.local_addr().unwrap()));
        Some(crate::test_support::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let until = Instant::now() + crate::test_support::timeout();
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("request missing: {e}"),
                }
            };
            crate::support::network::bounded::read_request(&mut socket);
            let bytes = include_bytes!("../../../../icons/32x32.png");
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            ready.send(()).unwrap();
            finish.recv().unwrap();
            socket.write_all(bytes).unwrap();
        }))
    } else {
        f.store
            .lunii_cover_test_response(include_bytes!("../../../../icons/32x32.png").to_vec());
        f.store.lunii_cover_test_pause(ready, finish);
        None
    };
    let (notified, retained) = mpsc::channel();
    let sink: crate::services::catalogue::scan::Sink = Arc::new(move |_, _| {
        let _ = notified.send(());
    });
    let request = assembly_request(&f);
    let cancel = Arc::new(AtomicBool::new(false));
    let (done, outcome) = mpsc::channel();
    let start = || {
        let store = Arc::clone(&f.store);
        let cancel = Arc::clone(&cancel);
        let request = request.clone();
        let done = done.clone();
        crate::test_support::spawn(move || {
            let _ = done.send(store.assembly_inputs(&request, &cancel, |_, _| {}));
        })
    };
    let mut worker = if automatic_first { None } else { Some(start()) };
    if automatic_first {
        f.store.download_lunii_covers(Arc::clone(&sink));
    }
    started
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    if automatic_first {
        worker = Some(start());
    } else {
        f.store.download_lunii_covers(sink);
    }
    f.store.lunii_cover_test_waiters(2);
    cancel.store(true, Ordering::SeqCst);
    let result = outcome.recv_timeout(Duration::from_millis(250));
    release.send(()).unwrap();
    crate::test_support::join(worker.unwrap());
    if let Some(server) = server {
        crate::test_support::join(server);
    }
    assert_eq!(
        result.unwrap().unwrap_err().code,
        crate::support::user_message::codes::GENERATION_CANCELLED
    );
    retained
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    assert_eq!(f.store.lunii_cover_test_requests(), 1);
    let id = f.card["ficheId"].as_str().unwrap();
    let cover = f
        .store
        .read(|c| crate::services::catalogue::lunii_db::values(c, id))
        .unwrap()
        .0["cover"]
        .clone();
    assert!(cover["sha256"].is_string());
    let attempts: i64 = f
        .store
        .read(|c| c.query_row("SELECT count(*) FROM lunii_image_attempt", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(attempts, 0);
    assert_eq!(
        patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap(),
        before
    );
}

#[test]
fn concurrent_official_cover_preparations_share_download_and_preserve_revisions() {
    use std::sync::mpsc;
    let mut f = official_cover_fixture();
    let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let (ready, started) = mpsc::channel();
    let (release, finish) = mpsc::channel();
    let (notified, retained) = mpsc::channel();
    f.store
        .lunii_cover_test_response(include_bytes!("../../../../icons/32x32.png").to_vec());
    f.store.lunii_cover_test_pause(ready, finish);
    f.store.download_lunii_covers(Arc::new(move |_, _| {
        let _ = notified.send(());
    }));
    started
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    let result = std::thread::scope(|scope| {
        let preparation = scope.spawn(|| official_cover_preparation(&f));
        f.store.lunii_cover_test_waiters(2);
        release.send(()).unwrap();
        preparation
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    });
    retained
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    result.expect("retaining an official image must preserve preparation revisions");
    let id = f.card["ficheId"].as_str().unwrap();
    f.card = f.store.get_card(id).unwrap();
    official_cover_preparation(&f).unwrap();
    assert_eq!(f.store.lunii_cover_test_requests(), 1);
    assert_eq!(
        patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap(),
        before
    );
}
fn official_cover_preparation(f: &Fixture) -> crate::services::catalogue::Result<()> {
    f.store
        .assembly_inputs(&assembly_request(f), &AtomicBool::new(false), |_, _| {})
        .map(|_| ())
}

struct MovingIds;
impl MovingIds {
    fn enable() -> Self {
        writes::PATH_FILE_IDS.with(|v| v.set(true));
        Self
    }
}
impl Drop for MovingIds {
    fn drop(&mut self) {
        writes::PATH_FILE_IDS.with(|v| v.set(false));
    }
}
/// Simulated remount: every native identity changes (device number, FAT inodes).
struct Remount;
impl Remount {
    fn now() -> Self {
        writes::REMOUNT_EPOCH.with(|v| v.set(v.get() + 1));
        Self
    }
}
impl Drop for Remount {
    fn drop(&mut self) {
        writes::REMOUNT_EPOCH.with(|v| v.set(0));
    }
}

#[test]
fn rename_probe_moves_a_file_holding_data() {
    let parent = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("catalogue-probe-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&parent).unwrap();
    // Identity derived from the first cluster: an empty file has none.
    writes::DATA_PATH_FILE_IDS.with(|v| v.set(true));
    let survived = publish::probe(&parent, false);
    writes::DATA_PATH_FILE_IDS.with(|v| v.set(false));
    assert!(!survived.unwrap());
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    fs::remove_dir(parent).unwrap();
}

// A folder file moved to its retired name, then a stop before `fileRetired`
// records it: recovery restores the original in both identity modes.

#[test]
fn only_cloud_reparse_tags_are_accepted() {
    for tag in [0x9000001a, 0x9000101a, 0x9000f01a] {
        assert!(patch::cloud_tag(tag));
    }
    for tag in [0xa0000003, 0xa000000c, 0x8000001b] {
        assert!(!patch::cloud_tag(tag));
    }
}

#[test]
fn assembly_ignores_unrelated_mutations_but_rechecks_selected_values() {
    for selected in [false, true] {
        let f = Fixture::new(false);
        let id = f.card["ficheId"].as_str().unwrap();
        f.store
            .write(|tx| {
                tx.execute("INSERT INTO fiche VALUES ('unrelated',unixepoch(),0,0)", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let result=f.store.assembly_inputs(&assembly_request(&f),&AtomicBool::new(false),|_,_| {
            let target=if selected {id} else {"unrelated"};
            let card=f.store.get_card(target).unwrap();
            f.store.mutate(serde_json::from_value(json!({"kind":"setFavorite","requestKey":"concurrent","ficheIds":[target],"value":true,"expectedFicheRevisions":{target:card["ficheRevision"]}})).unwrap(),card["catalogueRevision"].as_i64().unwrap()).unwrap();
        });
        if selected {
            assert_eq!(
                result.unwrap_err().code,
                codes::CATALOG_ASSEMBLY_SOURCE_CHANGED
            );
        } else {
            assert_eq!(result.unwrap()["entries"].as_array().unwrap().len(), 1);
        }
    }
}

#[test]
fn assembly_external_project_cover_requires_valid_image_and_observed_reference() {
    for mode in ["nonimage", "image", "importedPath", "retainedHash"] {
        let f = Fixture::new(false);
        let id = f.card["ficheId"].as_str().unwrap();
        let external = f.root.join("external.png");
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        fs::write(
            &external,
            if mode == "nonimage" {
                b"private data".as_slice()
            } else {
                png.get_ref()
            },
        )
        .unwrap();
        let project = f.root.join("packs/reference.mbah");
        fs::write(&project, json!({"thumbnailImage":external}).to_string()).unwrap();
        // Add a project reference while retaining the ZIP as assembly input.
        let observation =
            crate::services::catalogue::analyze::analyze(&project, &AtomicBool::new(false))
                .unwrap()
                .remove(0);
        let source = f.store.list_sources().unwrap().items[0].id.clone();
        let (token, modified, size) = crate::services::catalogue::scan::token(&project).unwrap();
        let item = crate::services::catalogue::grouping::Scanned {
            source_id: source.clone(),
            path: project.to_string_lossy().into(),
            path_key: project.to_string_lossy().as_bytes().to_vec(),
            token,
            modified,
            size,
            file_id: writes::file_id(&project),
            save_prestate: None,
            observation,
        };
        f.store
            .publish_targeted("project", 1, &source, &[item], &[])
            .unwrap();
        let project_card = f
            .store
            .list_entries(100, None)
            .unwrap()
            .items
            .into_iter()
            .find(|c| c["id"] != id)
            .unwrap();
        let pid = project_card["id"].as_str().unwrap();
        let project_detail = f.store.get_card(pid).unwrap();
        let eid = project_detail["exemplars"][0]["id"].as_str().unwrap();
        f.store.write(|tx| {
            tx.execute("UPDATE exemplar SET fiche_id=?1 WHERE id=?2",rusqlite::params![id,eid]).unwrap();
            crate::services::catalogue::data::mutate::reference::select(tx,id,eid)?;
            if mode=="importedPath" || mode=="retainedHash" {
                tx.execute("INSERT INTO provenance(id,kind) VALUES ('imported-cover','import')",[]).unwrap();
                let sha=if mode=="retainedHash" {
                    let staged=f.store.stage_cover(&external)?;
                    Some(crate::services::catalogue::data::images::publish(&f.store,tx,staged["coverStagingId"].as_str().unwrap())?)
                } else {None};
                tx.execute("INSERT INTO correction VALUES (?1,'cover','','defined',?2,'imported-cover',?3,1)",rusqlite::params![id,json!({"path":f.root.join("unobserved.png")}).to_string(),sha]).unwrap();
            }
            Ok(())
        }).unwrap();
        let result = f
            .store
            .assembly_inputs(&assembly_request(&f), &AtomicBool::new(false), |_, _| {})
            .unwrap();
        let cover = &result["entries"][0]["coverPath"];
        if mode == "nonimage" || mode == "importedPath" {
            assert!(cover.is_null(), "{mode}: {cover}");
            let root = PathBuf::from(result["entries"][0]["zipPath"].as_str().unwrap());
            assert_eq!(fs::read_dir(root.parent().unwrap()).unwrap().count(), 1);
        } else {
            let bytes = fs::read(cover.as_str().unwrap()).unwrap();
            assert_eq!(
                image::guess_format(&bytes).unwrap(),
                image::ImageFormat::Jpeg
            );
            assert_eq!(
                (
                    image::load_from_memory(&bytes).unwrap().width(),
                    image::load_from_memory(&bytes).unwrap().height()
                ),
                (1600, 1067)
            );
            assert_ne!(bytes, png.into_inner());
        }
    }
}

#[test]
fn assembly_official_cover_wins_over_an_imported_retained_reference() {
    let f = official_cover_fixture();
    let id = f.card["ficheId"].as_str().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0])))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let staged = f.store.stage_cover_bytes(png.get_ref()).unwrap();
    f.store.write(|tx| {
        let sha=crate::services::catalogue::data::images::publish(&f.store,tx,staged["coverStagingId"].as_str().unwrap())?;
        tx.execute("INSERT INTO provenance(id,kind) VALUES ('retained-import','import')",[]).map_err(error)?;
        tx.execute("INSERT OR REPLACE INTO reference_value VALUES (?1,'cover','',?2,'retained-import',?3)",rusqlite::params![id,json!({"path":"imported-cover.png"}).to_string(),sha]).map_err(error)?;
        Ok(())
    }).unwrap();
    let detail = f.store.get_card(id).unwrap();
    let cover = detail["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["field"] == "cover")
        .unwrap();
    assert_eq!(cover["effective"]["origin"], "lunii");
    let key = cover["effective"]["value"]["key"].as_str().unwrap();
    f.store
        .lunii_cover_test_response(include_bytes!("../../../../icons/32x32.png").to_vec());
    let inputs = f
        .store
        .assembly_inputs(&assembly_request(&f), &AtomicBool::new(false), |_, _| {})
        .unwrap();
    let actual = fs::read(inputs["entries"][0]["coverPath"].as_str().unwrap()).unwrap();
    let official = f
        .store
        .lunii_cover_bytes_cancel(id, key, &AtomicBool::new(false))
        .unwrap();
    assert!(
        actual == official,
        "assembly must use the effective official cover, not the imported reference"
    );
}

#[test]
fn revd2_reservations_match_only_card_identifiers_and_use_pending_indexes() {
    let f = Fixture::new(false);
    f.store.write(|tx| {
        tx.execute("INSERT INTO file_journal VALUES ('pending',?1)",[json!({"stage":"prepared","target":{"identityTargetFicheId":"busy"}}).to_string()]).unwrap();
        {
            let id = "busy";
            let forget=|request:&str,ids:Vec<&str>|serde_json::from_value::<Mutation>(json!({"kind":"forgetUnreferencedCards","requestKey":request,"ficheIds":ids,"expectedFicheRevisions":{}})).unwrap();
            assert_eq!(require_mutation_available(tx,&forget("r",vec!["free",id])).unwrap_err().code,codes::CATALOG_FILE_RECOVERY_REQUIRED);
            require_mutation_available(tx,&forget(id,vec!["free"])).unwrap();
        }
        // The pending file query must use its partial index.
        let plan=tx.prepare(&format!("EXPLAIN QUERY PLAN {PENDING_TARGETS_SQL}")).unwrap().query_map([],|r|r.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        {
            let index = "file_journal_pending";
            assert!(plan.iter().any(|line|line.contains(index)),"{index}: {plan:?}");
        }
        Ok(())
    }).unwrap();
}

#[test]
fn finz_mutation_designates_cards_by_variant() {
    let cases = [(
        json!({"kind":"setMetadataBatch","requestKey":"r","ficheId":"f","expectedFicheRevision":0,"changes":[]}),
        vec!["f"],
    )];
    for (payload, expected) in cases {
        let mutation: Mutation = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(mutation.reserved_fiche_ids(), expected, "{payload}");
    }
}

#[test]
#[ignore = "explicit synthetic 10000-card before/after timing"]
fn revd2_reservation_benchmark_10000_cards() {
    let f = Fixture::new(false);
    let ids: Vec<String> = (0..10000).map(|i| format!("card-{i}")).collect();
    f.store.write(|tx| {
        for (i,id) in ids.iter().enumerate() {
            tx.execute("INSERT INTO fiche VALUES (?1,unixepoch(),0,0)",[id]).unwrap();
            if i<1000 {
                tx.execute("INSERT INTO file_journal VALUES (?1,?2)",rusqlite::params![id,json!({"stage":"complete","target":{"ficheId":id}}).to_string()]).unwrap();
            }
        }
        let payload=Mutation::ForgetUnreferencedCards{request_key:"measure".into(),fiche_ids:ids.clone(),expected_fiche_revisions:Default::default()};
        tx.execute_batch("DROP INDEX file_journal_pending; DROP INDEX project_metadata_pending;").unwrap();
        let before=Instant::now();
        // SQL and per-string traversal from HEAD before REVd2 (completed journal history).
        for id in ["forgetUnreferencedCards","measure"].into_iter().chain(ids.iter().map(String::as_str)) {
            let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM file_journal WHERE json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.stage') NOT IN ('complete','failed','rolledBack') AND (json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.ficheId')=?1 OR json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.identityTargetFicheId')=?1)) OR EXISTS(SELECT 1 FROM project_metadata_operation WHERE state IN ('saving','publishing','published') AND (json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.ficheId')=?1 OR json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.target.identityTargetFicheId')=?1))",[id],|r|r.get(0)).unwrap();
            assert!(!busy);
        }
        let old=before.elapsed();
        tx.execute_batch("CREATE INDEX file_journal_pending ON file_journal(id) WHERE json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.stage') NOT IN ('complete','failed','rolledBack'); CREATE INDEX project_metadata_pending ON project_metadata_operation(id) WHERE state IN ('saving','publishing','published');").unwrap();
        let after=Instant::now();
        require_mutation_available(tx,&payload)?;
        eprintln!("REVd2 10000 cards, 1000 completed rows per journal: before={old:?}, after={:?}",after.elapsed());
        Ok(())
    }).unwrap();
}

#[test]
fn revd2_assembly_survives_selected_official_cover_retention() {
    let f = official_cover_fixture();
    let id = f.card["ficheId"].as_str().unwrap();
    let card = f.store.get_card(id).unwrap();
    let key = card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["field"] == "cover")
        .unwrap()["effective"]["value"]["key"]
        .as_str()
        .unwrap();
    f.store
        .lunii_cover_test_response(include_bytes!("../../../../icons/32x32.png").to_vec());
    let result = f
        .store
        .assembly_inputs(&assembly_request(&f), &AtomicBool::new(false), |_, _| {
            let bytes = f.store.lunii_cover_bytes(id, key).unwrap();
            f.store.retain_lunii_cover(id, key, &bytes).unwrap();
        })
        .unwrap();
    let after = f.store.get_card(id).unwrap();
    assert_eq!(after["ficheRevision"], card["ficheRevision"]);
    let output = fs::read(result["entries"][0]["coverPath"].as_str().unwrap()).unwrap();
    assert_eq!(output, f.store.lunii_cover_bytes(id, key).unwrap());
}

/// Test data only: existing checker API builds variants used by transfer and duplicate tests.
fn prepare_fixture_zip(
    source: &Path,
    output: &Path,
    fields: &BTreeMap<String, Value>,
    cover: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Result<()> {
    use crate::services::community_pack_checker::{self, PackMetadataPatch};
    let mut story = patch::read_story(source)?;
    community_pack_checker::apply_metadata_patch(
        &mut story,
        &PackMetadataPatch {
            title: fields
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            description: fields
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
            version: fields
                .get("versionDeclared")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
            uuid: fields
                .get("uuid")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ..Default::default()
        },
    )
    .map_err(super::super::store::error)?;
    let text = community_pack_checker::serialize_metadata_story(&story)
        .map_err(super::super::store::error)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(io_error)?;
    community_pack_checker::write_metadata_zip(source, file, Some(&text), cover, cancel)
        .map_err(super::super::store::error)
}

#[path = "startup_recovery_tests.rs"]
mod startup_recovery;

#[test]
fn removed_write_actions_and_options_are_rejected() {
    let f = Fixture::new(false);
    for action in ["applyMetadata", "changeIdentity"] {
        let options = serde_json::from_value(json!({"mode":"copy"})).unwrap();
        assert_eq!(
            f.store
                .plan_file_operation(action.into(), vec![], options)
                .unwrap_err()
                .code,
            codes::CATALOG_MUTATION_INVALID
        );
    }
    for (key, value) in [
        ("fields", json!({"title":"After"})),
        ("newUuid", json!("bda17862-0d71-41f6-974a-333333333333")),
        ("rename", json!(true)),
        ("backupPolicy", json!({})),
        ("copyCorrectionsToRemaining", json!(true)),
    ] {
        let mut options = json!({"mode":"copy"});
        options[key] = value;
        assert!(serde_json::from_value::<Options>(options).is_err(), "{key}");
    }
}

#[test]
fn compl3_empty_mount_does_not_prove_cover_unreadable_and_remount_reads_it() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let image = include_bytes!("../../../../icons/32x32.png");
        let cancel = AtomicBool::new(false);
        let temp = f.root.join("covered.zip");
        // Use the same locator and observation after the cover-bearing rescan.
        if directory {
            fs::write(f.source.join("thumbnail.png"), image).unwrap();
        } else {
            prepare_fixture_zip(&f.source, &temp, &BTreeMap::new(), Some(image), &cancel).unwrap();
            fs::rename(temp, &f.source).unwrap();
        }
        let sources = f.store.list_sources().unwrap();
        let receipt = f
            .store
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                sources.sources_revision,
                f.root.join("cache"),
                f.root.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        assert_eq!(f.wait(&receipt.operation_id).status, "success");
        let id = f.card["ficheId"].as_str().unwrap();
        let before = f.store.get_card(id).unwrap();
        let parked = f.root.join("parked");
        fs::rename(&f.source, &parked).unwrap();
        assert!(f.source.parent().unwrap().is_dir());
        assert_eq!(
            f.store.get_thumbnail(None, Some(id), None).unwrap().state,
            "unreadable"
        );
        assert_eq!(f.store.get_card(id).unwrap(), before);
        f.store.read(|c| {
            assert_eq!(c.query_row("SELECT count(*) FROM cache.extracted_value WHERE candidate_key LIKE '@unreadable:%'", [], |r| r.get::<_, i64>(0))?, 0);
            Ok(())
        }).unwrap();
        fs::rename(parked, &f.source).unwrap();
        assert_eq!(
            f.store.get_thumbnail(None, Some(id), None).unwrap().state,
            "ready"
        );
    }
}

#[test]
fn assembly_children_carry_official_origin_uuid() {
    let f = Fixture::new(false);
    let pack_uuid = "bda17862-0d71-41f6-974a-111111111111";
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,'{}')",
                [pack_uuid],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let receipt = f
        .store
        .prepare_assembly(assembly_request(&f), Arc::new(|_, _| {}))
        .unwrap();
    let result = assembly_finish(&f, &receipt).result.unwrap();
    assert_eq!(result["entries"][0]["packUuid"], pack_uuid);
    assert_eq!(result["entries"][0]["officialProvenance"], "official");
    assert_eq!(result["entries"][0]["officialOriginUuid"], pack_uuid);
    f.store
        .release_assembly(result["preparationId"].as_str().unwrap())
        .unwrap();
}
