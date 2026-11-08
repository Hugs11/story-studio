use super::*;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("catalogue-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        let root: std::path::PathBuf =
            crate::support::paths::path_for_frontend(root.canonicalize().unwrap()).into();
        Self(root)
    }
    fn root(&self) -> PathBuf {
        self.0.join("source")
    }
    fn open(&self) -> Arc<store::Store> {
        let store =
            Arc::new(store::Store::open(&self.0.join("data"), &self.0.join("cache")).unwrap());
        store.add_source(&self.root(), 0, false).unwrap();
        store
    }
    fn scan(&self, store: &Arc<store::Store>) -> events::Progress {
        let receipt = store
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                store.list_sources().unwrap().sources_revision,
                self.0.join("cache"),
                self.0.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        wait(store, &receipt.operation_id)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn wait(store: &store::Store, id: &str) -> events::Progress {
    let start = Instant::now();
    loop {
        let p = store.get_operation(id).unwrap();
        if !matches!(p.status.as_str(), "queued" | "running" | "cancelling") {
            return p;
        }
        assert!(start.elapsed() < crate::test_support::timeout());
        std::thread::sleep(Duration::from_millis(5));
    }
}
const ID: &str = "bda17862-0d71-41f6-974a-111111111111";
fn studio(id: Option<&str>) -> Value {
    json!({"title":"Même titre","stageNodes":[{"uuid":id,"squareOne":true}]})
}
fn zip_bytes(value: &Value) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(value.to_string().as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}
fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, value.to_string()).unwrap();
}
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            files.extend(snapshot(&p));
        } else {
            files.push((p.clone(), std::fs::read(p).unwrap()));
        }
    }
    files.sort();
    files
}
#[test]
fn uuid_formats_duplicates_homonyms_and_source_bytes() {
    let f = Fixture::new();
    let root = f.root();
    write_json(
        &root.join("3+Projet.mbah"),
        &json!({"packMetadata":{"uuid":ID,"title":"Même titre"}}),
    );
    for name in ["a.zip", "b.zip"] {
        std::fs::write(root.join(name), zip_bytes(&studio(Some(ID)))).unwrap();
    }
    std::fs::create_dir(root.join("directory")).unwrap();
    write_json(&root.join("directory/story.json"), &studio(Some(ID)));
    write_json(
        &root.join("homonym.mbah"),
        &json!({"packMetadata":{"uuid":"bda17862-0d71-41f6-974a-222222222222","title":"Même titre"}}),
    );
    let before = snapshot(&root);
    let store = f.open();
    let p = f.scan(&store);
    assert_eq!(
        p.status,
        "success",
        "{}",
        serde_json::to_string(&p).unwrap()
    );
    assert_eq!(p.outcomes.indexed_new, 5);
    assert_eq!(p.cards.created, 2);
    assert_eq!(p.candidates.processed, 5);
    let entries = store.list_entries(100, None).unwrap();
    assert_eq!(entries.items.len(), 2);
    let card = entries
        .items
        .iter()
        .find(|v| v["exemplars"].as_array().unwrap().len() == 4)
        .unwrap();
    let zips: Vec<_> = card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["format"] == "zip")
        .collect();
    assert_eq!(zips.len(), 2);
    let again = f.scan(&store);
    assert_eq!(again.outcomes.unchanged, 5);
    assert_eq!(again.cards.created, 0);
    assert_eq!(again.catalogue_revision, p.catalogue_revision);
    assert!(
        !again.catalogue_changed,
        "an unchanged scan must not emit catalogue-changed"
    );
    assert_eq!(snapshot(&root), before);
}
#[test]
fn legacy_project_and_non_uuid_fs_never_invent_identity_or_age() {
    let f = Fixture::new();
    write_json(&f.root().join("ancien.mbah"), &json!({"name":"Ancien"}));
    let fs = f.root().join("nom libre");
    crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&fs);
    let old = analyze::project(&f.root().join("ancien.mbah")).unwrap();
    assert!(old.identity.is_none());
    assert!(old.age_min.is_none());
    assert!(old.raw.get("packMetadata").is_none());
    let store = f.open();
    assert_eq!(f.scan(&store).cards.created, 2);
    assert_eq!(
        store
            .read(
                |c| c.query_row("SELECT count(*) FROM pack_identity", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
}
#[test]
fn multipack_modified_unknown_child_creates_new_card() {
    let f = Fixture::new();
    let path = f.root().join("bundle.zip");
    let bundle = |version| {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, value) in [
            ("known.zip", studio(Some(ID))),
            ("unknown.zip", json!({"title":version,"stageNodes":[]})),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&zip_bytes(&value)).unwrap();
        }
        writer.finish().unwrap().into_inner()
    };
    std::fs::write(&path, bundle("first")).unwrap();
    let store = f.open();
    let p = f.scan(&store);
    assert_eq!(p.status, "success");
    assert_eq!(p.outcomes.indexed_new, 2);
    assert_eq!(p.cards.created, 2);
    std::fs::write(&path, bundle("changed archive")).unwrap();
    let p = f.scan(&store);
    assert_eq!(
        p.status,
        "success",
        "{}",
        serde_json::to_string(&p).unwrap()
    );
    assert_eq!(p.cards.created, 1);
    assert_eq!(p.outcomes.indexed_new, 1);
    assert_eq!(
        store
            .read(|c| c.query_row("SELECT count(*) FROM container", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        1
    );
}
#[test]
fn stale_scan_is_rejected_and_queued_cancellation_has_exact_counters() {
    let f = Fixture::new();
    write_json(&f.root().join("pack.mbah"), &json!({"name":"test"}));
    let store = f.open();
    let guard = store.scans.heavy.lock().unwrap();
    let start = |request: &str| {
        store
            .start_scan(
                None,
                request.into(),
                1,
                f.0.join("cache"),
                f.0.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap()
    };
    let a = start("A");
    let b = start("B");
    drop(guard);
    let stale = wait(&store, &a.operation_id);
    assert_eq!(stale.status, "failed");
    assert_eq!(stale.error.unwrap().code, "CATALOG_SCAN_SUPERSEDED");
    assert_eq!(wait(&store, &b.operation_id).status, "success");
    let guard = store.scans.heavy.lock().unwrap();
    let c = start("C");
    store.cancel_operation(&c.operation_id).unwrap();
    drop(guard);
    let p = wait(&store, &c.operation_id);
    assert_eq!(p.status, "cancelled");
    assert_eq!(p.candidates.processed, 0);
    assert_eq!(p.outcomes.not_processed, p.candidates.discovered);
    assert!(!p.scan_complete);
}
#[test]
fn missing_root_keeps_reference_and_personal_data() {
    let f = Fixture::new();
    write_json(
        &f.root().join("pack.mbah"),
        &json!({"packMetadata":{"uuid":ID,"title":"Dernier titre"}}),
    );
    let store = f.open();
    assert_eq!(f.scan(&store).status, "success");
    store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1", [])
                .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    std::fs::rename(f.root(), f.0.join("offline")).unwrap();
    let p = f.scan(&store);
    assert_eq!(p.status, "partial");
    assert_eq!(p.roots.failed, 1);
    assert!(!p.scan_complete);
    let page = store.list_entries(100, None).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0]["favorite"], true);
    assert_eq!(page.items[0]["referenceUnavailable"], true);
    assert_eq!(page.items[0]["values"]["title"], "Dernier titre");
}
#[test]
fn age_conflict_and_manual_clearing_are_protected() {
    let f = Fixture::new();
    for name in ["3+test.mbah", "5+test.mbah"] {
        write_json(&f.root().join(name), &json!({"packMetadata":{"uuid":ID}}));
    }
    let store = f.open();
    f.scan(&store);
    let page = store.list_entries(100, None).unwrap();
    assert_eq!(page.items[0]["ageConflict"], true);
    assert!(page.items[0]["values"].get("ageMin").is_none());
    store.write(|tx| {tx.execute("INSERT INTO provenance (id,kind) VALUES ('manual','manual')",[]).map_err(store::error)?;tx.execute("INSERT INTO correction SELECT id,'ageMin','','cleared',NULL,'manual',NULL,0 FROM fiche",[]).map_err(store::error)?;Ok(())}).unwrap();
    assert_eq!(
        store.list_entries(100, None).unwrap().items[0]["ageConflict"],
        false
    );
}
#[cfg(unix)]
#[test]
fn symbolic_loop_and_root_cut_during_discovery() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let root = f.root();
    std::fs::create_dir(root.join("sub")).unwrap();
    symlink(&root, root.join("sub/loop")).unwrap();
    let store = f.open();
    let exclusions = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    let cancel = AtomicBool::new(false);
    let found = walk::discover(&root, &exclusions, &cancel, |_, _| {});
    assert!(found.complete);
    assert_eq!(found.directories, 2);
    let mut cut = false;
    let found = walk::discover(&root, &exclusions, &cancel, |_, _| {
        if !cut {
            std::fs::rename(&root, f.0.join("gone")).unwrap();
            cut = true;
        }
    });
    assert!(!found.complete);
    assert!(!found.errors.is_empty());
}
#[test]
fn future_cache_rebuild_and_recovery_retention() {
    let f = Fixture::new();
    let store = f.open();
    drop(store);
    let path = f.0.join("cache/catalogue/index.sqlite");
    let cache = rusqlite::Connection::open(&path).unwrap();
    cache.execute_batch("PRAGMA user_version=999").unwrap();
    drop(cache);
    for n in 0..12 {
        std::fs::write(
            f.0.join(format!("data/catalogue/recovery/backup-{n}")),
            "backup",
        )
        .unwrap();
    }
    let store = store::Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap();
    assert_eq!(store.list_sources().unwrap().items.len(), 1);
    assert_eq!(
        std::fs::read_dir(f.0.join("data/catalogue/recovery"))
            .unwrap()
            .count(),
        5
    );
    assert!(!f.0.join("cache/catalogue/recovery").exists());
}
#[test]
fn explicit_add_after_older_refusal_remains_active() {
    let f = Fixture::new();
    let store = f.open();
    store.add_source(&f.root(), 1, true).unwrap();
    store.add_source(&f.root(), 2, false).unwrap();
    let list = store.list_sources().unwrap();
    assert_eq!(list.items[0].status, "active");
    assert_eq!(list.sources_revision, 3);
}
#[test]
fn seven_zip_targeted_metadata_password_and_corruption() {
    let f = Fixture::new();
    let directory = f.0.join("payload");
    std::fs::create_dir(&directory).unwrap();
    write_json(&directory.join("story.json"), &studio(Some(ID)));
    let tool = crate::support::imported_pack::resolve_7z_path()
        .expect("7z available for catalogue fixtures");
    let archive = f.root().join("pack.7z");
    let protected = f.root().join("protected.7z");
    for (path, password) in [(&archive, false), (&protected, true)] {
        let mut command = std::process::Command::new(&tool);
        command
            .arg("a")
            .arg("-t7z")
            .arg(path)
            .arg("story.json")
            .current_dir(&directory);
        if password {
            command.args(["-psecret", "-mhe=on"]);
        }
        assert!(command.output().unwrap().status.success());
    }
    let cancel = AtomicBool::new(false);
    let observed = analyze::analyze(&archive, &cancel).unwrap();
    assert_eq!(observed[0].uuid(), Some(ID));
    assert_eq!(observed[0].format, "7z");
    assert_eq!(
        analyze::analyze(&protected, &cancel).unwrap_err(),
        "archiveProtected"
    );
    std::fs::write(f.root().join("broken.zip"), b"not an archive").unwrap();
    write_json(
        &f.root().join("same-identity.mbah"),
        &json!({"packMetadata":{"uuid":ID}}),
    );
    let before = snapshot(&f.root());
    let store = f.open();
    let p = f.scan(&store);
    // Corrupt and protected archives are refusals with their own exclusive
    // motif, not read errors: the scan itself completed.
    assert_eq!(p.status, "success");
    assert_eq!(p.cards.created, 1);
    assert_eq!(p.outcomes.indexed_new, 2);
    assert_eq!(p.outcomes.refused, 2);
    assert_eq!(p.outcomes.error, 0);
    assert_eq!(p.candidates.processed, 4);
    for reason in ["corruptArchive", "protectedArchive"] {
        assert!(
            p.reasons
                .iter()
                .any(|r| r.reason == reason && r.outcome == "refused" && r.count == 1),
            "{reason}"
        );
    }
    assert_eq!(snapshot(&f.root()), before);
}
#[test]
fn copying_file_is_deferred_with_explicit_reason() {
    let f = Fixture::new();
    let path = f.root().join("copy.mbah");
    write_json(&path, &json!({"name":"copy"}));
    let store = f.open();
    let writing = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&writing);
    let target = path.clone();
    let writer = std::thread::spawn(move || {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(target)
            .unwrap();
        while flag.load(std::sync::atomic::Ordering::Relaxed) {
            file.write_all(b" ").unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let p = f.scan(&store);
    writing.store(false, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
    assert_eq!(p.outcomes.error, 1);
    assert!(p.reasons.iter().any(|r| r.reason == "fileUnstable"));
    assert_eq!(p.cards.created, 0);
}

#[test]
fn cancellation_after_publication_keeps_exact_partial_results_and_report_pages() {
    let f = Fixture::new();
    for name in ["one.mbah", "two.mbah", "three.mbah"] {
        write_json(&f.root().join(name), &json!({"name":name}));
    }
    let store = f.open();
    let handle = Arc::clone(&store);
    let receipt = store
        .start_scan(
            None,
            "cancel-partial".into(),
            1,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(move |event, p| {
                if event == "catalogue-operation-progress"
                    && p.phase == "analysis"
                    && p.outcomes.indexed_new == 1
                {
                    handle.cancel_operation(&p.operation_id).unwrap();
                }
            }),
        )
        .unwrap();
    let p = wait(&store, &receipt.operation_id);
    assert_eq!(p.status, "cancelled");
    assert_eq!(p.candidates.discovered, 3);
    assert_eq!(p.candidates.processed, 1);
    assert_eq!(p.outcomes.indexed_new, 1);
    assert_eq!(p.outcomes.not_processed, 2);
    assert_eq!(store.list_entries(100, None).unwrap().items.len(), 1);
    let page = store
        .operation_page(&receipt.operation_id, 1, None)
        .unwrap();
    assert_eq!(page.total_matching, 1);
    assert_eq!(page.items.len(), 1);
    assert!(page.cursor.is_none());
}
#[test]
fn alias_reconciliation_keeps_latest_explicit_active_action() {
    let f = Fixture::new();
    std::fs::create_dir(f.root().join("sub")).unwrap();
    let store = f.open();
    let alias = f.root().join("sub/..");
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO source(id,path,path_key,origin,status,revision) VALUES ('older-refusal',?1,?2,'manual','declined',0)",
                rusqlite::params![sources::bytes(&alias), sources::bytes(&alias)],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    // Reconciliation is a background pass; listings never repair.
    store.reconcile_sources().unwrap();
    let sources = store.list_sources().unwrap();
    assert_eq!(sources.items.len(), 1);
    assert_eq!(sources.items[0].status, "active");
}
#[test]
fn reference_is_sticky_and_entry_cursors_are_bound_to_query_and_revision() {
    let f = Fixture::new();
    let a = f.root().join("a.mbah");
    let b = f.root().join("b.mbah");
    write_json(&a, &json!({"packMetadata":{"uuid":ID,"title":"A"}}));
    write_json(&b, &json!({"packMetadata":{"uuid":ID,"title":"B"}}));
    let set_time = |p: &Path, seconds| {
        std::fs::File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap()
    };
    set_time(&a, 10);
    set_time(&b, 20);
    write_json(&f.root().join("other.mbah"), &json!({"name":"Other"}));
    let store = f.open();
    f.scan(&store);
    let cards = store.list_entries(100, None).unwrap();
    let card = cards
        .items
        .iter()
        .find(|v| v["exemplars"].as_array().unwrap().len() == 2)
        .unwrap();
    let id = card["id"].clone();
    assert_eq!(card["values"]["title"], "B");
    write_json(&a, &json!({"packMetadata":{"uuid":ID,"title":"A changed"}}));
    set_time(&a, 30);
    f.scan(&store);
    let cards = store.list_entries(100, None).unwrap();
    assert_eq!(
        cards.items.iter().find(|v| v["id"] == id).unwrap()["values"]["title"],
        "B"
    );
    let page = store.query_entries(1, None, false).unwrap();
    let cursor = page.cursor.unwrap();
    assert!(store.query_entries(1, Some(&cursor), true).is_err());
    assert_eq!(
        store
            .query_entries(1, Some(&cursor), false)
            .unwrap()
            .items
            .len(),
        1
    );
    let unchanged = f.scan(&store);
    assert!(!unchanged.catalogue_changed);
    assert!(store.query_entries(1, Some(&cursor), false).is_ok());
    write_json(
        &a,
        &json!({"packMetadata":{"uuid":ID,"title":"Another real change"}}),
    );
    f.scan(&store);
    assert!(store.query_entries(1, Some(&cursor), false).is_err());
    store
        .remove_source(&store.list_sources().unwrap().items[0].id, 1)
        .unwrap();
    assert!(store
        .query_entries(100, None, false)
        .unwrap()
        .items
        .is_empty());
    assert!(store
        .query_entries(100, None, true)
        .unwrap()
        .items
        .is_empty());
}
#[test]
fn raw_fields_preserve_absence_null_invalid_values_and_uuid_provenance() {
    let f = Fixture::new();
    let project = f.root().join("raw.mbah");
    write_json(
        &project,
        &json!({"packMetadata":{"uuid":ID,"minAge":null,"version":"bad","description":""}}),
    );
    let observed = analyze::project(&project).unwrap();
    assert_eq!(observed.fields["/packMetadata/minAge"].presence, "null");
    assert_eq!(observed.fields["/packMetadata/title"].presence, "absent");
    assert_eq!(observed.fields["/packMetadata/version"].validity, "invalid");
    assert_eq!(
        observed.fields["/packMetadata/description"].validity,
        "empty"
    );
    assert!(observed.age_min.is_none());
    let mut value = studio(Some(ID));
    value["uuid"] = json!("bda17862-0d71-41f6-974a-333333333333");
    std::fs::write(f.root().join("identity.zip"), zip_bytes(&value)).unwrap();
    let observed =
        analyze::analyze(&f.root().join("identity.zip"), &AtomicBool::new(false)).unwrap();
    assert_eq!(observed[0].uuid(), Some(ID));
    assert_eq!(
        observed[0].identity.as_ref().unwrap().source,
        "/stageNodes/0/uuid"
    );
    assert_eq!(observed[0].raw["uuid"], value["uuid"]);
}

fn set_modified(path: &Path, seconds: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds)),
        )
        .unwrap();
}
#[test]
fn same_format_exemplars_are_ordered_by_date_then_path() {
    let f = Fixture::new();
    for (name, seconds) in [
        ("b.zip", 50),
        ("a.zip", 50),
        ("old.zip", 10),
        ("new.zip", 90),
    ] {
        let path = f.root().join(name);
        std::fs::write(&path, zip_bytes(&studio(Some(ID)))).unwrap();
        set_modified(&path, seconds);
    }
    let store = f.open();
    assert_eq!(f.scan(&store).cards.created, 1);
    let page = store.list_entries(100, None).unwrap();
    let names: Vec<_> = page.items[0]["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            Path::new(e["locator"]["path"].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, ["new.zip", "a.zip", "b.zip", "old.zip"]);
    // The initial reference is the most recently modified exemplar.
    let reference = page.items[0]["referenceExemplarId"].clone();
    assert_eq!(page.items[0]["exemplars"][0]["id"], reference);
}
#[test]
fn alias_reconciliation_keeps_a_more_recent_refusal() {
    let f = Fixture::new();
    std::fs::create_dir(f.root().join("sub")).unwrap();
    let store = f.open();
    let alias = f.root().join("sub/..");
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO source(id,path,path_key,origin,status,revision) VALUES ('newer-refusal',?1,?2,'manual','declined',99)",
                rusqlite::params![sources::bytes(&alias), sources::bytes(&alias)],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    // Reconciliation is a background pass; listings never repair.
    store.reconcile_sources().unwrap();
    let sources = store.list_sources().unwrap();
    assert_eq!(sources.items.len(), 1);
    assert_eq!(sources.items[0].status, "declined");
}
#[test]
fn unreadable_multipack_keeps_children_and_moves_are_only_suggested() {
    let f = Fixture::new();
    let bundle = f.root().join("bundle.zip");
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, value) in [
        ("one.zip", studio(Some(ID))),
        ("two.zip", json!({"title":"Sans identité","stageNodes":[]})),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&zip_bytes(&value)).unwrap();
    }
    std::fs::write(&bundle, writer.finish().unwrap().into_inner()).unwrap();
    let loose = f.root().join("loose.zip");
    std::fs::write(&loose, zip_bytes(&json!({"stageNodes":[]}))).unwrap();
    let store = f.open();
    assert_eq!(f.scan(&store).cards.created, 3);
    // The container becomes unreadable: both children keep their data, with
    // an explicit state, instead of being declared missing.
    std::fs::write(&bundle, b"truncated").unwrap();
    let p = f.scan(&store);
    assert_eq!(p.outcomes.refused, 1);
    let page = store.list_entries(100, None).unwrap();
    let states: Vec<_> = page
        .items
        .iter()
        .flat_map(|card| card["exemplars"].as_array().unwrap().clone())
        .map(|e| e["state"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(states.iter().filter(|s| *s == "corruptArchive").count(), 2);
    assert!(!states.iter().any(|s| s == "missing"));
    // An unidentified pack moved inside a fully visited source becomes a new
    // independent card without any automatic transfer.
    std::fs::create_dir(f.root().join("moved")).unwrap();
    std::fs::rename(&loose, f.root().join("moved/loose.zip")).unwrap();
    let p = f.scan(&store);
    assert_eq!(p.cards.created, 1);
    assert_eq!(
        store
            .read(|c| c.query_row(
                "SELECT count(*) FROM cache.sqlite_master WHERE name='suggestion'",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
}
#[test]
fn zip_multipack_isolates_an_unreadable_pack_folder() {
    let f = Fixture::new();
    let path = f.root().join("folders.zip");
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in [
        ("good/story.json", studio(Some(ID)).to_string()),
        ("broken/story.json", "{not json".to_owned()),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(body.as_bytes()).unwrap();
    }
    std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
    let observed = analyze::analyze(&path, &AtomicBool::new(false)).unwrap();
    assert_eq!(observed.len(), 2);
    let good = observed
        .iter()
        .find(|o| o.member.as_deref() == Some("good"))
        .unwrap();
    assert_eq!(good.state, "available");
    assert_eq!(good.uuid(), Some(ID));
    let broken = observed
        .iter()
        .find(|o| o.member.as_deref() == Some("broken"))
        .unwrap();
    assert_eq!(broken.state, "unreadableUnknown");
    assert!(broken.member_key().is_some());
}

#[test]
fn anchor_lookups_use_the_expression_indexes() {
    let f = Fixture::new();
    let store = f.open();
    let locator = json!({"path":"p","pathKey":[1,2],"memberKey":null,"member":null}).to_string();
    for (name, sql) in [
        ("current", grouping::SELECT_CURRENT_ANCHOR),
        ("member", grouping::MARK_FAILED_MEMBER),
        ("file", grouping::MARK_FAILED_FILE),
        ("container", grouping::SELECT_CONTAINER),
    ] {
        let plan = store
            .read(|c| {
                let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let count = statement.parameter_count();
                let mut rows = match count {
                    1 => statement.query([&locator])?,
                    2 => statement.query(["x", &locator])?,
                    _ => statement.query(["x", &locator, "y", "{}"])?,
                };
                let mut details = Vec::new();
                while let Some(row) = rows.next()? {
                    details.push(row.get::<_, String>(3)?);
                }
                Ok(details.join("\n"))
            })
            .unwrap();
        assert!(plan.contains("USING INDEX"), "{name}: {plan}");
        assert!(plan.contains("_anchor_"), "{name}: {plan}");
    }
}

#[test]
fn exclusions_are_counted_as_ignored_with_a_reason() {
    let f = Fixture::new();
    let hidden = f.root().join(".story-studio-backups");
    std::fs::create_dir(&hidden).unwrap();
    write_json(&hidden.join("old.mbah"), &json!({"name":"test"}));
    write_json(&f.root().join("pack.mbah"), &json!({"name":"test"}));
    let store = f.open();
    let p = f.scan(&store);
    assert_eq!(p.outcomes.ignored, 1);
    assert_eq!(p.candidates.processed, 1);
    assert!(p
        .reasons
        .iter()
        .any(|r| r.reason == "excludedByRule" && r.outcome == "ignored"));
}

#[test]
fn depth_limit_is_reported_and_never_concludes_absence() {
    let f = Fixture::new();
    let mut deep = f.root();
    for _ in 0..(walk::MAX_DEPTH + 2) {
        deep.push("d");
    }
    std::fs::create_dir_all(&deep).unwrap();
    let store = f.open();
    let exclusions = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    let found = walk::discover(&f.root(), &exclusions, &AtomicBool::new(false), |_, _| {});
    assert!(!found.complete);
    assert!(found
        .errors
        .iter()
        .any(|e| e.reason == "depthLimitExceeded"));
}

#[test]
fn removing_parent_after_global_scan_keeps_nested_source_entries_immediately() {
    let f = Fixture::new();
    let child = f.root().join("Enfants");
    std::fs::create_dir(&child).unwrap();
    write_json(&child.join("pack.mbah"), &json!({"name":"Enfant"}));
    let store = f.open();
    let list = store.list_sources().unwrap();
    let parent = list.items[0].id.clone();
    let added = store
        .add_source(&child, list.sources_revision, false)
        .unwrap();
    assert_eq!(f.scan(&store).status, "success");
    assert!(store.has_full_scan(&added.source_id).unwrap());
    let before = store.query_entries(100, None, false).unwrap();
    assert_eq!(before.items.len(), 1);
    store
        .remove_source(&parent, store.list_sources().unwrap().sources_revision)
        .unwrap();
    let after = store.query_entries(100, None, false).unwrap();
    // The card is unchanged; only the parent's coverage leaves its sources.
    let mut expected = before.items.clone();
    expected[0]["exemplars"][0]["sourceIds"] = json!([added.source_id]);
    assert_eq!(after.items, expected);
}

// Unix symlinks and Windows junctions share the canonical containment check.
// Creating a Windows symlink needs native privileges, so this real-link test
// runs on Unix; junction behavior remains part of Windows platform validation.
#[cfg(unix)]
#[test]
fn outside_source_link_is_diagnosed_and_never_indexed() {
    let f = Fixture::new();
    let outside = f.0.join("outside");
    std::fs::create_dir(&outside).unwrap();
    write_json(
        &outside.join("pack.mbah"),
        &json!({"name":"Hors périmètre"}),
    );
    std::os::unix::fs::symlink(&outside, f.root().join("link")).unwrap();
    let store = f.open();
    let before = std::fs::read(outside.join("pack.mbah")).unwrap();
    let p = f.scan(&store);
    assert!(p.reasons.iter().any(|r| r.reason == "outsideSource"));
    assert!(store.list_entries(100, None).unwrap().items.is_empty());
    assert_eq!(std::fs::read(outside.join("pack.mbah")).unwrap(), before);
}

#[test]
fn thumbnails_cache_purge_revision_and_source_integrity() {
    let f = Fixture::new();
    let pack = f.root().join("pack");
    std::fs::create_dir(&pack).unwrap();
    write_json(&pack.join("story.json"), &studio(Some(ID)));
    image::RgbImage::from_pixel(512, 512, image::Rgb([11, 22, 33]))
        .save(pack.join("thumbnail.png"))
        .unwrap();
    let original = snapshot(&f.root());
    let store = f.open();
    f.scan(&store);
    let entries = store.query_entries(10, None, true).unwrap();
    let fiche = entries.items[0]["id"].as_str().unwrap();
    let durable_bytes = std::fs::read(f.0.join("data/catalogue/catalogue.sqlite")).unwrap();
    let first = store.get_thumbnail(None, Some(fiche), None).unwrap();
    assert_eq!(first.state, "ready");
    let durable = store
        .read(|c| c.query_row("SELECT count(*) FROM fiche", [], |r| r.get::<_, i64>(0)))
        .unwrap();
    std::fs::remove_dir_all(store.thumbnail_root()).unwrap();
    assert_eq!(
        store.get_thumbnail(None, Some(fiche), None).unwrap().bytes,
        first.bytes
    );
    assert_eq!(
        store
            .read(|c| c.query_row("SELECT count(*) FROM fiche", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        durable
    );
    assert_eq!(snapshot(&f.root()), original);
    assert_eq!(
        std::fs::read(f.0.join("data/catalogue/catalogue.sqlite")).unwrap(),
        durable_bytes
    );
    let error = store
        .get_thumbnail(None, Some(fiche), Some(-1))
        .unwrap_err();
    assert_eq!(
        error.code,
        crate::support::user_message::codes::CATALOG_TARGET_REVISION_STALE
    );
    assert_eq!(
        store
            .get_thumbnail(Some("unknown"), None, None)
            .unwrap()
            .state,
        "absent"
    );
    std::fs::write(pack.join("thumbnail.png"), b"broken").unwrap();
    f.scan(&store);
    assert_eq!(
        store.get_thumbnail(None, Some(fiche), None).unwrap().state,
        "absent"
    );
    // An unreadable source cover is now absent from the effective card too.
    assert!(store.query_entries(10, None, true).unwrap().items[0]["values"]["cover"].is_null());
}

fn bmp(width: u32, height: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 90]))
        .write_to(&mut out, image::ImageFormat::Bmp)
        .unwrap();
    out.into_inner()
}

#[test]
fn encrypted_fs_pack_cover_is_deciphered_into_a_ready_thumbnail() {
    let f = Fixture::new();
    let pack = f.root().join("pack chiffré");
    crate::support::fs_pack_reader::fs_fixtures::write_encrypted_cover_pack(&pack, &bmp(64, 48));
    let original = snapshot(&f.root());
    let store = f.open();
    f.scan(&store);
    let entries = store.query_entries(10, None, true).unwrap();
    assert_eq!(entries.items.len(), 1);
    let thumbnail = store
        .get_thumbnail(None, entries.items[0]["id"].as_str(), None)
        .unwrap();
    assert_eq!(thumbnail.state, "ready");
    assert_eq!(snapshot(&f.root()), original);
}

#[test]
fn thumbnail_is_served_while_the_heavy_job_is_held() {
    let f = Fixture::new();
    let pack = f.root().join("pack");
    std::fs::create_dir(&pack).unwrap();
    write_json(&pack.join("story.json"), &studio(Some(ID)));
    image::RgbImage::from_pixel(64, 64, image::Rgb([1, 2, 3]))
        .save(pack.join("thumbnail.png"))
        .unwrap();
    let store = f.open();
    f.scan(&store);
    let entries = store.query_entries(10, None, true).unwrap();
    let fiche = entries.items[0]["id"].as_str().unwrap().to_owned();
    let store = &store;
    std::thread::scope(|scope| {
        let heavy = store.scans.heavy.lock().unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let fiche = &fiche;
        scope.spawn(move || {
            let _ = sent.send(store.get_thumbnail(None, Some(fiche), None));
        });
        let result = received.recv_timeout(crate::test_support::timeout());
        drop(heavy);
        let thumbnail = result
            .expect("a thumbnail must not wait for the heavy job")
            .unwrap();
        assert_eq!(thumbnail.state, "ready");
    });
}

#[test]
fn light_reads_admit_two_at_once_and_release_on_drop() {
    let lights = scan::LightReads::default();
    let first = lights.acquire().unwrap();
    let _second = lights.acquire().unwrap();
    std::thread::scope(|scope| {
        let (sent, received) = std::sync::mpsc::channel();
        let lights = &lights;
        scope.spawn(move || {
            let _third = lights.acquire().unwrap();
            let _ = sent.send(());
        });
        assert!(received.recv_timeout(Duration::from_millis(150)).is_err());
        drop(first);
        received
            .recv_timeout(crate::test_support::timeout())
            .expect("a released permit admits the waiting read");
    });
}

#[test]
fn thumbnail_archive_members_and_absent_covers() {
    let f = Fixture::new();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(256, 128, image::Rgb([100, 50, 200]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let options = zip::write::SimpleFileOptions::default();
    let mut inner = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    inner.start_file("story.json", options).unwrap();
    inner
        .write_all(studio(Some(ID)).to_string().as_bytes())
        .unwrap();
    inner.start_file("thumbnail.png", options).unwrap();
    inner.write_all(&png).unwrap();
    let inner = inner.finish().unwrap().into_inner();
    let mut outer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    outer.start_file("child.zip", options).unwrap();
    outer.write_all(&inner).unwrap();
    std::fs::write(
        f.root().join("nested.zip"),
        outer.finish().unwrap().into_inner(),
    )
    .unwrap();
    std::fs::write(f.root().join("absent.zip"), zip_bytes(&studio(None))).unwrap();
    let original = snapshot(&f.root());
    let store = f.open();
    f.scan(&store);
    let entries = store.query_entries(10, None, true).unwrap();
    assert_eq!(entries.items.len(), 2);
    let mut states = Vec::new();
    for entry in &entries.items {
        states.push(
            store
                .get_thumbnail(None, entry["id"].as_str(), None)
                .unwrap()
                .state,
        );
    }
    states.sort();
    assert_eq!(states, vec!["absent", "ready"]);
    assert_eq!(snapshot(&f.root()), original);
}

/// Opt-in Linux measurement adapter: /proc's VmHWM measures this isolated
/// process, including SQLite, the scan and the real serialized thumbnail
/// worker. Fixtures are generated outside it, so their allocation is excluded.
#[test]
#[ignore = "isolated RSS benchmark, requires CATALOGUE_THUMBNAIL_BENCH_INPUTS"]
fn thumbnail_worker_peak_measure() {
    let inputs = PathBuf::from(std::env::var("CATALOGUE_THUMBNAIL_BENCH_INPUTS").unwrap());
    let f = Fixture::new();
    let mut names = Vec::new();
    for entry in std::fs::read_dir(inputs).unwrap() {
        let entry = entry.unwrap();
        if !entry.file_type().unwrap().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let pack = f.root().join(&name);
        std::fs::create_dir(&pack).unwrap();
        write_json(&pack.join("story.json"), &json!({"title":name}));
        std::fs::copy(entry.path(), pack.join("thumbnail.png")).unwrap();
        names.push(name);
    }
    assert!(!names.is_empty());
    let store = f.open();
    f.scan(&store);
    let entries = store.query_entries(200, None, true).unwrap();
    assert_eq!(entries.items.len(), names.len());
    for pass in 0..3 {
        if store.thumbnail_root().exists() {
            std::fs::remove_dir_all(store.thumbnail_root()).unwrap();
        }
        for entry in &entries.items {
            let result = store
                .get_thumbnail(None, entry["id"].as_str(), None)
                .unwrap();
            assert_eq!(result.state, "ready");
            let status = std::fs::read_to_string("/proc/self/status").unwrap();
            let peak_kib: u64 = status
                .lines()
                .find_map(|line| {
                    line.strip_prefix("VmHWM:")?
                        .split_whitespace()
                        .next()?
                        .parse()
                        .ok()
                })
                .unwrap();
            println!(
                "{}",
                json!({"pass":pass,"name":entry["values"]["title"],"state":result.state,"encodedBase64Bytes":result.bytes.as_ref().unwrap().len(),"processPeakRssKiB":peak_kib})
            );
            assert!(
                peak_kib <= 128 * 1024,
                "isolated process RSS exceeds worker budget: {peak_kib} KiB"
            );
        }
    }
}

/// The device-pack families refused before (7z, `.cleartext`) are indexed,
/// an unknown key gets its own refusal motif, and the progress names the
/// analysed item instead of the last folder of the walk.
#[test]
fn device_7z_cleartext_and_unknown_key_packs_are_scanned_with_exact_motifs() {
    use crate::support::fs_pack_reader::fs_fixtures::{
        write_cleartext_pack, write_encrypted_cover_pack, write_unknown_key_pack,
    };
    fn zip_folder(archive: &Path, folder: &Path) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(archive).unwrap());
        let root = folder.parent().unwrap();
        let mut stack = vec![folder.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/");
                if path.is_dir() {
                    zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
                        .unwrap();
                    stack.push(path);
                } else {
                    zip.start_file(name, zip::write::SimpleFileOptions::default())
                        .unwrap();
                    zip.write_all(&std::fs::read(&path).unwrap()).unwrap();
                }
            }
        }
        zip.finish().unwrap();
    }
    let f = Fixture::new();
    let staging = f.0.join("staging");
    let device = "94617264-6ffc-4884-96ff-1634b06a2f83";
    let clear = "b41b89e0-8faa-4dab-9ed0-7cec76a3a9f0";
    let locked = "4d058e49-5594-4421-834b-e6d7007e60dc";
    let folder = "17f0da97-7db8-4f66-b9c1-a8e6d154a67d";
    write_encrypted_cover_pack(&staging.join(device), &bmp(64, 48));
    write_cleartext_pack(&staging.join(clear), true);
    write_unknown_key_pack(&staging.join(locked), true);
    let packs = f.root().join("Lunii.Pack14");
    std::fs::create_dir_all(&packs).unwrap();
    let tool = crate::support::imported_pack::resolve_7z_path()
        .expect("7z available for catalogue fixtures");
    let seven = packs.join("3+ Les Histoires d'Archibald.7z");
    assert!(std::process::Command::new(&tool)
        .arg("a")
        .arg("-t7z")
        .arg(&seven)
        .arg(device)
        .current_dir(&staging)
        .output()
        .unwrap()
        .status
        .success());
    zip_folder(&packs.join("3+ Bonne nuit!.zip"), &staging.join(clear));
    zip_folder(&packs.join("5+ Ciboulette.zip"), &staging.join(locked));
    let pack_folder = f.root().join("Lunii.Pack15").join(folder);
    write_cleartext_pack(&pack_folder, true);
    let candidates = [
        seven.clone(),
        packs.join("3+ Bonne nuit!.zip"),
        packs.join("5+ Ciboulette.zip"),
        pack_folder.clone(),
    ]
    .map(|path| crate::support::paths::path_for_frontend(&path));
    // The oldest item is analysed last (newest first): the 7z.
    set_modified(&seven, 1_000);
    set_modified(&packs.join("3+ Bonne nuit!.zip"), 2_000);
    set_modified(&packs.join("5+ Ciboulette.zip"), 3_000);
    let before = snapshot(&f.root());
    let store = f.open();
    let p = f.scan(&store);
    assert_eq!(p.status, "success");
    assert_eq!(
        p.outcomes.indexed_new,
        3,
        "{}",
        serde_json::to_string(&p).unwrap()
    );
    assert_eq!(p.outcomes.refused, 1);
    assert_eq!(p.outcomes.error, 0);
    assert!(p
        .reasons
        .iter()
        .any(|r| r.reason == "encryptedUnknownKey" && r.outcome == "refused" && r.count == 1));
    assert!(!p.reasons.iter().any(|r| r.reason == "invalidStructure"));
    assert_eq!(p.current_directory.as_ref(), Some(&candidates[0]));
    // The 7z cover is deciphered into a ready thumbnail like a device ZIP's.
    let entries = store.query_entries(10, None, true).unwrap();
    assert_eq!(entries.items.len(), 3);
    let seven_entry = entries
        .items
        .iter()
        .find(|e| e.to_string().contains(device))
        .expect("7z entry");
    let thumbnail = store
        .get_thumbnail(None, seven_entry["id"].as_str(), None)
        .unwrap();
    assert_eq!(thumbnail.state, "ready");
    assert_eq!(snapshot(&f.root()), before);
}

#[test]
fn manual_backup_source_excludes_security_versions_at_any_depth() {
    let f = Fixture::new();
    let root = f.root().join("Documents/story-studio/sauvegardes");
    std::fs::create_dir_all(root.join("versions-securite/nested")).unwrap();
    write_json(&root.join("x.mbah"), &json!({"packMetadata":{"uuid":ID}}));
    write_json(
        &root.join("versions-securite/nested/y.mbah"),
        &json!({"packMetadata":{"uuid":ID}}),
    );
    let store = Arc::new(store::Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap());
    store.add_source(&root, 0, false).unwrap();
    assert_eq!(store.list_sources().unwrap().items[0].origin, "manual");
    let progress = f.scan(&store);
    assert_eq!(progress.status, "success");
    assert_eq!(progress.outcomes.indexed_new, 1);
    let excluded = root.join("versions-securite/nested/y.mbah");
    let explanation = serde_json::to_value(
        store
            .explain_path(&excluded, &f.0.join("cache"), &f.0.join("data"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        explanation["excluded"]["role"],
        "sauvegardes/versions-securite"
    );
    let rules = store
        .exclusions_raw(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    assert!(rules
        .items
        .iter()
        .any(|r| r.path == "sauvegardes/versions-securite"));
    assert!(rules
        .reason_for_resolved(&root.join("x.mbah"), None)
        .is_none());
    assert!(rules
        .reason_for_resolved(&root.join("ordinary/versions-securite/y.mbah"), None)
        .is_none());
    assert!(rules
        .reason_for_resolved(&root.join("Versions-securite/y.mbah"), None)
        .is_none());
}

#[test]
fn unregistered_workspace_structure_excludes_only_its_internal_directories() {
    let f = Fixture::new();
    for name in [
        "sauvegardes/versions-securite",
        "exports",
        "fichiers-importes",
        "enregistrements",
        "voix-generees",
        "images-generees",
        "zips-extraits",
        "ordinary/voix-generees",
        "ordinary/versions-securite",
    ] {
        let dir = f.root().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join("pack.mbah"), &json!({"packMetadata":{"uuid":ID}}));
    }
    write_json(
        &f.root().join("sauvegardes/project.mbah"),
        &json!({"packMetadata":{"uuid":ID}}),
    );
    let store = f.open();
    assert!(store.workspace_roots().unwrap().is_empty());
    let progress = f.scan(&store);
    assert_eq!(progress.status, "success");
    assert_eq!(progress.outcomes.indexed_new, 4);
    let mut paths = store
        .read(|c| {
            c.prepare("SELECT json_extract(anchor_json,'$.path') FROM exemplar")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    paths.sort();
    let mut expected = [
        "exports/pack.mbah",
        "ordinary/voix-generees/pack.mbah",
        "ordinary/versions-securite/pack.mbah",
        "sauvegardes/project.mbah",
    ]
    .map(|name| {
        crate::support::paths::path_for_frontend(
            f.root().join(name).components().collect::<PathBuf>(),
        )
    })
    .to_vec();
    expected.sort();
    assert_eq!(paths, expected);
    let explanation = serde_json::to_value(
        store
            .explain_path(
                &f.root().join("voix-generees/pack.mbah"),
                &f.0.join("cache"),
                &f.0.join("data"),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(explanation["excluded"]["role"], "voix-generees");
}

#[test]
fn newly_excluded_indexed_exemplars_are_withdrawn_by_scan_and_refresh() {
    for mode in ["scan", "targeted", "reconcile"] {
        let f = Fixture::new();
        let dir = f.root().join("voix-generees");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.mbah");
        write_json(&path, &json!({"packMetadata":{"uuid":ID}}));
        write_json(
            &f.root().join("keep.mbah"),
            &json!({"packMetadata":{"uuid":ID}}),
        );
        let store = f.open();
        assert_eq!(f.scan(&store).outcomes.indexed_new, 2);
        // The old index is real: only now does the workspace acquire its
        // distinctive backup structure (no fixture derived from production SQL).
        std::fs::create_dir_all(f.root().join("sauvegardes/versions-securite")).unwrap();
        let root = refresh::Root {
            source_id: store.list_sources().unwrap().items[0].id.clone(),
            path: f.root(),
        };
        let rules = store
            .exclusions(&f.0.join("cache"), &f.0.join("data"))
            .unwrap();
        let registry = writes::Registry::default();
        match mode {
            "scan" => assert_eq!(f.scan(&store).status, "success"),
            "targeted" => {
                assert!(
                    store
                        .refresh_paths(
                            &root,
                            &[refresh::Change {
                                path: path.clone(),
                                settled: true,
                                structural: false
                            }],
                            &rules,
                            Duration::ZERO,
                            &AtomicBool::new(false),
                            &registry
                        )
                        .unwrap()
                        .changed
                );
            }
            _ => {
                assert!(
                    store
                        .reconcile_source(
                            &root,
                            &rules,
                            Duration::ZERO,
                            &AtomicBool::new(false),
                            &|_| false,
                            &registry
                        )
                        .unwrap()
                        .changed
                );
            }
        }
        let card = store.list_entries(10, None).unwrap().items.remove(0);
        let visible = card["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["retired"] != true)
            .collect::<Vec<_>>();
        assert_eq!(visible.len(), 1, "{mode}: {card}");
        assert!(visible[0]["locator"]["path"]
            .as_str()
            .unwrap()
            .ends_with("keep.mbah"));
        assert!(path.exists());
        assert_eq!(f.scan(&store).outcomes.indexed_new, 0);
    }
}

#[test]
fn legacy_index_under_security_versions_is_retired_without_touching_files() {
    let f = Fixture::new();
    let dir = f.root().join("sauvegardes/versions-securite");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("y.mbah");
    write_json(&path, &json!({"packMetadata":{"uuid":ID}}));
    write_json(
        &f.root().join("sauvegardes/x.mbah"),
        &json!({"packMetadata":{"uuid":ID}}),
    );
    let before = snapshot(&f.root());
    let store = f.open();
    let sources = store.list_sources().unwrap();
    let source = &sources.items[0];
    // Reproduce the former published index through the normal observation and
    // publication API, deliberately bypassing discovery's new exclusions.
    let observed = scan::observe(
        &source.id,
        &path,
        &scan::token(&path),
        &AtomicBool::new(false),
        &store.activity,
        true,
    );
    store
        .publish_scan(
            "legacy",
            sources.sources_revision,
            &observed,
            &[(source.id.clone(), true)],
        )
        .unwrap();
    assert_eq!(
        store.list_entries(10, None).unwrap().items[0]["exemplars"][0]["retired"],
        false
    );
    assert_eq!(f.scan(&store).status, "success");
    let card = store.list_entries(10, None).unwrap().items.remove(0);
    let exemplars = card["exemplars"].as_array().unwrap();
    assert_eq!(exemplars.iter().filter(|e| e["retired"] != true).count(), 1);
    assert!(exemplars.iter().any(
        |e| e["retired"] == true && e["locator"]["path"].as_str().unwrap().ends_with("y.mbah")
    ));
    assert_eq!(snapshot(&f.root()), before);
}

#[test]
fn unknown_workspace_shape_never_creates_exemplars_to_retire_on_next_pass() {
    for mode in ["scan", "targeted", "reconcile"] {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root().join("voix-generees")).unwrap();
        write_json(
            &f.root().join("keep.mbah"),
            &json!({"packMetadata":{"uuid":ID}}),
        );
        let store = f.open();
        assert_eq!(f.scan(&store).outcomes.indexed_new, 1);
        std::fs::create_dir_all(f.root().join("sauvegardes/versions-securite")).unwrap();
        let path = f.root().join("voix-generees/new.mbah");
        write_json(&path, &json!({"packMetadata":{"uuid":ID}}));
        let root = refresh::Root {
            source_id: store.list_sources().unwrap().items[0].id.clone(),
            path: f.root(),
        };
        // Discovery checks both the supplied and resolved spelling. Hold both
        // exact probe keys (extended Windows prefix, /private on macOS), so a
        // second spelling cannot answer the simulated unavailable probe.
        let raw = f.root().join("sauvegardes/versions-securite");
        let canonical = f
            .root()
            .canonicalize()
            .unwrap()
            .join("sauvegardes/versions-securite");
        let targets = if raw.as_os_str() == canonical.as_os_str() {
            vec![raw]
        } else {
            vec![raw, canonical]
        };
        let mut probes = Vec::new();
        for target in targets {
            let (entered, started) = std::sync::mpsc::channel();
            let (release, held) = std::sync::mpsc::channel();
            let owned = target.clone();
            let probe = std::thread::spawn(move || {
                super::probe::bounded(&owned, crate::test_support::timeout(), move || {
                    entered.send(()).unwrap();
                    held.recv().unwrap();
                    true
                })
            });
            started.recv().unwrap();
            probes.push((target, release, probe));
        }
        for pass in 0..2 {
            let rules = store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap();
            match mode {
                "scan" => {
                    let progress = f.scan(&store);
                    assert_eq!(progress.outcomes.indexed_new, 0);
                    assert_eq!(
                        progress.status,
                        if pass == 0 { "partial" } else { "success" }
                    );
                }
                "targeted" => {
                    store
                        .refresh_paths(
                            &root,
                            &[refresh::Change {
                                path: path.clone(),
                                settled: true,
                                structural: false,
                            }],
                            &rules,
                            Duration::ZERO,
                            &AtomicBool::new(false),
                            &writes::Registry::default(),
                        )
                        .unwrap();
                }
                _ => {
                    store
                        .reconcile_source(
                            &root,
                            &rules,
                            Duration::ZERO,
                            &AtomicBool::new(false),
                            &|_| false,
                            &writes::Registry::default(),
                        )
                        .unwrap();
                }
            }
            store
                .read(|c| {
                    let (total, retired): (i64, i64) = c.query_row(
                        "SELECT count(*),coalesce(sum(retired),0) FROM exemplar",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    assert_eq!((total, retired), (1, 0), "{mode}, pass {pass}");
                    Ok(())
                })
                .unwrap();
            if pass == 0 {
                // An inconclusive cached result is never a confirmed exclusion.
                assert!(store
                    .retire_excluded(&root.source_id, &rules)
                    .unwrap()
                    .is_none());
                for (target, release, _) in &probes {
                    release.send(()).unwrap();
                    // Confirm every held probe was released before the next pass.
                    assert_eq!(
                        super::probe::bounded(target, crate::test_support::timeout(), || true),
                        Some(true)
                    );
                }
            }
        }
        for (_, _, probe) in probes {
            assert_eq!(probe.join().unwrap(), Some(true));
        }
    }
}

#[test]
fn unavailable_source_keeps_nonexcluded_exemplar_unretired_after_reconcile_and_scan() {
    let f = Fixture::new();
    // This homonym is ordinary user data, without a workspace signature.
    std::fs::create_dir_all(f.root().join("voix-generees")).unwrap();
    let path = f.root().join("voix-generees/keep.mbah");
    write_json(&path, &json!({"packMetadata":{"uuid":ID}}));
    let store = f.open();
    assert_eq!(f.scan(&store).outcomes.indexed_new, 1);
    let root = refresh::Root {
        source_id: store.list_sources().unwrap().items[0].id.clone(),
        path: f.root(),
    };
    std::fs::rename(f.root(), f.0.join("offline")).unwrap();
    let rules = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    store
        .reconcile_source(
            &root,
            &rules,
            Duration::ZERO,
            &AtomicBool::new(false),
            &|_| false,
            &writes::Registry::default(),
        )
        .unwrap();
    // Reconciliation must return before evaluating any workspace shape.
    assert!(rules.workspace_shapes.lock().unwrap().is_empty());
    for scan in [false, true] {
        if scan {
            assert_eq!(f.scan(&store).outcomes.indexed_new, 0);
        }
        let card = store.list_entries(10, None).unwrap().items.remove(0);
        let exemplars = card["exemplars"].as_array().unwrap();
        assert_eq!(exemplars.len(), 1);
        assert_eq!(exemplars[0]["retired"], false);
        assert_eq!(exemplars[0]["state"], "unavailable");
    }
}

// Handwritten minimal editor envelopes, independent of the persistence encoder.
const PROJ_MENU_FIXTURE: &str = r#"{
    "schemaVersion": 4, "authoringMode": "free", "projectType": "pack",
    "packMetadata": {"title": "Mini-loup", "minAge": " 3 ",
                     "producer": "Producteur projet", "bonus": "Avec bonus"},
    "rootEntries": [{"type": "story"}, {"type": "zip"}]
}"#;
const PROJ_ADVANCED_FIXTURE: &str = r#"{
    "schemaVersion": 4, "authoringMode": "advanced", "projectType": "advanced",
    "packMetadata": {"minAge": " 3 ", "storyCount": 99,
                     "producer": "Producteur projet", "bonus": "Avec bonus"},
    "rootEntries": [],
    "authoring": {
        "payload": "{\"payloadVersion\":1,\"document\":{\"stageNodes\":[],\"actionNodes\":[]},\"context\":{\"documentOrigin\":\"created\",\"defaultValueOrigin\":\"authored\"}}",
        "mediaBindings": []
    }
}"#;

fn assert_proj_file_field(card: &Value, name: &str, expected: Value) {
    let field = card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["field"] == name)
        .unwrap();
    assert_eq!(field["effective"]["value"], expected);
    assert_eq!(field["effective"]["origin"], "reference");
    let provenance = card["provenance"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == field["effective"]["provenanceId"])
        .unwrap();
    assert_eq!(provenance["kind"], "file");
    assert_eq!(provenance["exemplarId"], card["reference"]["exemplarId"]);
}

#[test]
fn proj_age_integer_strings_integers_invalid_and_legacy_fallback() {
    let f = Fixture::new();
    let path = f.root().join("age.mbah");
    for fixture in [PROJ_MENU_FIXTURE, PROJ_ADVANCED_FIXTURE] {
        let original: Value = serde_json::from_str(fixture).unwrap();
        for (value, expected, validity) in [
            (json!(" 3 "), Some(3), "valid"),
            (json!(3), Some(3), "valid"),
            (json!("0"), Some(0), "valid"),
            (json!(18), Some(18), "valid"),
            (json!(" 18 "), Some(18), "valid"),
            (json!("trois"), None, "invalid"),
            (json!("3.0"), None, "invalid"),
            (json!("19"), None, "invalid"),
            (json!(19), None, "invalid"),
            (json!(-1), None, "invalid"),
            (json!("-1"), None, "invalid"),
            (json!(3.5), None, "invalid"),
        ] {
            let mut raw = original.clone();
            raw["packMetadata"]["minAge"] = value.clone();
            write_json(&path, &raw);
            let observation = analyze::project(&path).unwrap();
            assert_eq!(observation.age_min, expected, "{value}");
            let field = &observation.fields["/packMetadata/minAge"];
            assert_eq!(field.validity, validity, "{value}");
            assert_eq!(field.raw_value.as_ref(), Some(&value));

            raw["packMetadata"]
                .as_object_mut()
                .unwrap()
                .remove("minAge");
            raw["packMinAge"] = value.clone();
            write_json(&path, &raw);
            let observation = analyze::project(&path).unwrap();
            assert_eq!(observation.age_min, expected, "legacy {value}");
            assert_eq!(observation.fields["/packMinAge"].validity, validity);
        }
    }
}

#[test]
fn proj_age_reaches_card_as_number_or_remains_absent_when_invalid() {
    for (metadata, legacy, expected) in [
        (json!(" 3 "), Value::Null, json!(3)),
        (json!(3), Value::Null, json!(3)),
        (json!("trois"), Value::Null, Value::Null),
        (Value::Null, json!(" 7 "), json!(7)),
        (json!("invalide"), json!(" 7 "), json!(7)),
    ] {
        let f = Fixture::new();
        write_json(
            &f.root().join("project.mbah"),
            &json!({
                "packMetadata": {"minAge": metadata}, "packMinAge": legacy, "rootEntries": []
            }),
        );
        let store = f.open();
        f.scan(&store);
        let entries = store.query_entries(100, None, true).unwrap();
        let entry = &entries.items[0];
        assert_eq!(entry["values"]["ageMin"], expected);
        let card = store.get_card(entry["id"].as_str().unwrap()).unwrap();
        if expected.is_null() {
            let field = card["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["field"] == "ageMin")
                .unwrap();
            assert_eq!(field["effective"]["origin"], "none");
            assert!(field["effective"]["value"].is_null());
            assert_eq!(field["invalid"][0]["raw"], metadata);
        } else {
            assert_proj_file_field(&card, "ageMin", expected);
        }
    }
}

#[test]
fn proj_story_counts_and_metadata_reach_card_with_file_provenance() {
    for (fixture, entries, expected) in [
        (PROJ_MENU_FIXTURE, None, None),
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"type":"menu", "children":[
                    {"type":"story"},
                    {"type":"menu", "children":[{"type":"zip"}, {"type":"story"}]},
                    {"type":"menu"}
                ]},
                {"type":"mystery", "children":[{"type":"story"}]},
                {"type":"story", "children":[{"type":"story"}]}
            ])),
            None,
        ),
        (PROJ_MENU_FIXTURE, Some(json!([])), None),
        (PROJ_ADVANCED_FIXTURE, None, None),
        // DUREE: only identifiable, classifiable stories are measured. A ZIP
        // placeholder and incomplete entries never imply a count or a zero.
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"id":"menu","type":"menu","children":[
                    {"id":"a","type":"story","audio":"a.mp3"},
                    {"id":"b","type":"story","audio":"b.mp3"}
                ]}
            ])),
            Some(2),
        ),
        // DUREE (user decision): an imported ZIP not yet chosen plays nothing;
        // it is ignored, not invalidating.
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"id":"menu","type":"menu","children":[
                    {"id":"a","type":"story","audio":"a.mp3"},
                    {"id":"z","type":"zip"},
                    {"id":"b","type":"story","audio":"b.mp3"}
                ]}
            ])),
            Some(2),
        ),
        // The old link node no longer exists: a project that still holds one
        // (even pointing to a present story) has no value, like an unknown type.
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"id":"menu","type":"menu","children":[
                    {"id":"a","type":"story","audio":"a.mp3"},
                    {"id":"r","type":"ref","target":"story:a"},
                    {"id":"b","type":"story","audio":"b.mp3"}
                ]}
            ])),
            None,
        ),
        // Still no value: duplicate id, unknown type.
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"id":"a","type":"story","audio":"a.mp3"},
                {"id":"a","type":"story","audio":"b.mp3"}
            ])),
            None,
        ),
        (
            PROJ_MENU_FIXTURE,
            Some(json!([
                {"id":"a","type":"story","audio":"a.mp3"},
                {"id":"x","type":"mystery"}
            ])),
            None,
        ),
    ] {
        let f = Fixture::new();
        let path = f.root().join("project.mbah");
        let mut raw: Value = serde_json::from_str(fixture).unwrap();
        if let Some(entries) = entries {
            raw["rootEntries"] = entries;
        }
        write_json(&path, &raw);
        let store = f.open();
        f.scan(&store);
        let entries = store.query_entries(100, None, true).unwrap();
        let entry = &entries.items[0];
        assert_eq!(entry["values"]["ageMin"], 3);
        assert_eq!(
            entry["values"].get("storyCount").is_some(),
            expected.is_some()
        );
        let card = store.get_card(entry["id"].as_str().unwrap()).unwrap();
        let field = |name| {
            card["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["field"] == name)
                .unwrap()
        };
        if let Some(expected) = expected {
            assert_eq!(entry["values"]["storyCount"], expected);
            assert_proj_file_field(&card, "storyCount", json!(expected));
        } else {
            assert_eq!(field("storyCount")["effective"]["origin"], "none");
            assert!(field("storyCount")["effective"]["value"].is_null());
        }
        assert_proj_file_field(&card, "ageMin", json!(3));
        assert_proj_file_field(&card, "producer", json!("Producteur projet"));
        assert_proj_file_field(&card, "bonus", json!("Avec bonus"));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
            raw
        );
    }
}

#[test]
fn proj_studio_pack_has_no_producer_or_bonus() {
    for directory in [false, true] {
        let f = Fixture::new();
        let raw = json!({"title":"Pack",
                         "stageNodes":[{"uuid":ID,"squareOne":true}]});
        if directory {
            let path = f.root().join("pack");
            std::fs::create_dir(&path).unwrap();
            write_json(&path.join("story.json"), &raw);
        } else {
            std::fs::write(f.root().join("pack.zip"), zip_bytes(&raw)).unwrap();
        }
        let store = f.open();
        f.scan(&store);
        let entries = store.query_entries(100, None, true).unwrap();
        let entry = &entries.items[0];
        let card = store.get_card(entry["id"].as_str().unwrap()).unwrap();
        for name in ["producer", "bonus"] {
            assert!(entry["values"].get(name).is_none());
            let field = card["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["field"] == name)
                .unwrap();
            assert_eq!(field["effective"]["origin"], "none");
            assert!(field["effective"]["value"].is_null());
        }
    }
}

#[test]
fn proj_bonus_requires_text_in_both_project_modes() {
    for fixture in [PROJ_MENU_FIXTURE, PROJ_ADVANCED_FIXTURE] {
        for (value, validity) in [
            (json!("Avec bonus"), "valid"),
            (json!(true), "invalid"),
            (json!(3), "invalid"),
            (json!([]), "invalid"),
            (json!({}), "invalid"),
        ] {
            let f = Fixture::new();
            let path = f.root().join("bonus.mbah");
            let mut raw: Value = serde_json::from_str(fixture).unwrap();
            raw["packMetadata"]["bonus"] = value.clone();
            write_json(&path, &raw);
            let observation = analyze::project(&path).unwrap();
            let field = &observation.fields["/packMetadata/bonus"];
            assert_eq!(field.validity, validity, "{value}");
            assert_eq!(field.raw_value.as_ref(), Some(&value));
            let store = f.open();
            f.scan(&store);
            let entries = store.query_entries(100, None, true).unwrap();
            let entry = &entries.items[0];
            let card = store.get_card(entry["id"].as_str().unwrap()).unwrap();
            if validity == "valid" {
                assert_proj_file_field(&card, "bonus", value);
            } else {
                assert!(entry["values"].get("bonus").is_none());
                let field = card["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|field| field["field"] == "bonus")
                    .unwrap();
                assert_eq!(field["effective"]["origin"], "none");
                assert!(field["effective"]["value"].is_null());
                assert_eq!(field["invalid"][0]["raw"], value);
            }
        }
    }
}

#[test]
fn listening_cache_tracks_external_audio_and_survives_reopening() {
    let f = Fixture::new();
    let path = f.root().join("listening.mbah");
    let audio = f.0.join("story.mp3");
    fn sound(path: &Path, bytes: usize) {
        let mut b = vec![0; bytes];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        std::fs::write(path, b).unwrap();
    }
    sound(&audio, 16000);
    write_json(
        &path,
        &json!({"schemaVersion":4,"authoringMode":"free","projectType":"pack","projectName":"Measured",
        "rootEntries":[{"id":"a","type":"story","audio":audio}]}),
    );
    let store = f.open();
    let measured = || {
        store
            .activity
            .measurements
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(measured(), 1);
    let analyses = store.activity.snapshot().analyses;
    assert_eq!(f.scan(&store).outcomes.unchanged, 1);
    // Metadata is analysed again, as before; the sounds are not measured.
    assert_eq!(store.activity.snapshot().analyses, analyses + 1);
    assert_eq!(measured(), 1, "stable scan measures no sound");
    let id = store.query_entries(10, None, false).unwrap().items[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let card = store.get_card(&id).unwrap();
    assert_eq!(card["exemplars"][0]["storyCount"], 1);
    assert_eq!(card["exemplars"][0]["durationSeconds"], 1.0);
    drop(store);
    let store = Arc::new(store::Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap());
    let measured = || {
        store
            .activity
            .measurements
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    assert_eq!(f.scan(&store).outcomes.unchanged, 1);
    assert_eq!(measured(), 0, "persisted dependency locators");
    let card = store.get_card(&id).unwrap();
    assert_eq!(
        card["exemplars"][0]["durationSeconds"], 1.0,
        "reused values"
    );
    sound(&audio, 32000);
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(measured(), 1);
    let row = store.query_entries(10, None, false).unwrap().items[0].clone();
    let card = store.get_card(row["id"].as_str().unwrap()).unwrap();
    assert_eq!(card["exemplars"][0]["durationSeconds"], 2.0);
}

#[test]
fn a_new_listening_version_measures_again_and_keeps_the_fiche() {
    let f = Fixture::new();
    let path = f.root().join("listening.mbah");
    let audio = f.0.join("story.mp3");
    let mut sound = vec![0; 16000];
    sound[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
    std::fs::write(&audio, sound).unwrap();
    write_json(
        &path,
        &json!({"schemaVersion":4,"authoringMode":"free","projectType":"pack","projectName":"Measured",
        "rootEntries":[{"id":"a","type":"story","audio":audio}]}),
    );
    let store = f.open();
    let measured = || {
        store
            .activity
            .measurements
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(measured(), 1);
    store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1", [])
                .map_err(store::error)?;
            // Values stored by an earlier classification.
            tx.execute(
                "UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.listeningVersion',?1)",
                [i64::from(super::analyze::LISTENING_VERSION) - 1],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(
        measured(),
        2,
        "an older listening version is measured again"
    );
    assert_eq!(f.scan(&store).outcomes.unchanged, 1);
    assert_eq!(measured(), 2, "the new version is then reused");
    let row = store.query_entries(10, None, false).unwrap().items[0].clone();
    assert_eq!(row["favorite"], true);
    let card = store.get_card(row["id"].as_str().unwrap()).unwrap();
    assert_eq!(card["exemplars"][0]["storyCount"], 1);
    assert_eq!(card["exemplars"][0]["durationSeconds"], 1.0);
}

/// A solid archive holding one direct STUdio pack with two one-second stories.
fn measured_solid_archive(f: &Fixture) -> PathBuf {
    let payload = f.0.join("solid-payload");
    std::fs::create_dir_all(payload.join("assets")).unwrap();
    let mut story = studio(Some(ID));
    story["stageNodes"] = json!([
        {"uuid":ID,"squareOne":true,"okTransition":{"actionNode":"choice","optionIndex":0}},
        {"uuid":"a","audio":"a.mp3","controlSettings":{"pause":true}},
        {"uuid":"b","audio":"b.mp3","controlSettings":{"pause":true}}
    ]);
    story["actionNodes"] = json!([{"id":"choice","options":["a","b"]}]);
    write_json(&payload.join("story.json"), &story);
    for name in ["a.mp3", "b.mp3"] {
        let mut b = vec![0; 16000];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        std::fs::write(payload.join("assets").join(name), b).unwrap();
    }
    let archive = f.root().join("solid.7z");
    let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
    assert!(std::process::Command::new(tool)
        .args(["a", "-t7z", "-ms=on"])
        .arg(&archive)
        .args(["story.json", "assets"])
        .current_dir(&payload)
        .output()
        .unwrap()
        .status
        .success());
    archive
}
#[test]
fn stable_solid_archive_is_reanalysed_but_never_extracted_again() {
    let f = Fixture::new();
    measured_solid_archive(&f);
    let store = f.open();
    let passes = || {
        store
            .activity
            .solid_passes
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(passes(), 1);
    let analyses = store.activity.snapshot().analyses;
    let values = |store: &store::Store| {
        let id = store.query_entries(10, None, false).unwrap().items[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let card = store.get_card(&id).unwrap();
        (
            card["exemplars"][0]["storyCount"].clone(),
            card["exemplars"][0]["durationSeconds"].clone(),
        )
    };
    assert_eq!(values(&store), (json!(2), json!(2.0)));
    assert_eq!(f.scan(&store).status, "success");
    // Metadata is read again (listing and index), as before the listening pass.
    assert!(store.activity.snapshot().analyses > analyses);
    assert_eq!(
        passes(),
        1,
        "a stable solid archive is never extracted again"
    );
    assert_eq!(values(&store), (json!(2), json!(2.0)));
}
#[test]
fn cancelled_measurement_publishes_no_listening_value() {
    let f = Fixture::new();
    let path = f.root().join("listening.mbah");
    let audio = f.0.join("story.mp3");
    let mut b = vec![0; 16000];
    b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
    std::fs::write(&audio, b).unwrap();
    write_json(
        &path,
        &json!({"schemaVersion":4,"authoringMode":"free","projectType":"pack","projectName":"Measured",
        "rootEntries":[{"id":"a","type":"story","audio":audio}]}),
    );
    let store = f.open();
    let source_id = "source";
    let cancelled = AtomicBool::new(true);
    let observed = store.observe_listening(source_id, &path, &scan::token(&path), &cancelled);
    assert_eq!(observed.len(), 1);
    let observation = &observed[0].observation;
    assert!(
        observation.listening_token.is_none(),
        "measured again next time"
    );
    assert!(observation
        .valid_field(&["/packMetadata/storyCount", "/packMetadata/durationSeconds"])
        .is_none());
    let measured = store.observe_listening(
        source_id,
        &path,
        &scan::token(&path),
        &AtomicBool::new(false),
    );
    assert!(measured[0].observation.listening_token.is_some());
    assert_eq!(
        measured[0]
            .observation
            .valid_field(&["/packMetadata/durationSeconds"]),
        Some(&json!(1.0))
    );
}
#[test]
fn listening_publication_requires_the_token_taken_at_analysis() {
    let f = Fixture::new();
    let archive = measured_solid_archive(&f);
    let store = f.open();
    assert_eq!(f.scan(&store).status, "success");
    let registry = writes::Registry::default();
    let items = store.observe_listening(
        "source",
        &archive,
        &scan::token(&archive),
        &AtomicBool::new(false),
    );
    assert!(store
        .listening_publishable(&registry, &archive, &items)
        .unwrap());
    std::thread::sleep(Duration::from_millis(20));
    let bytes = std::fs::read(&archive).unwrap();
    std::fs::write(&archive, [bytes.as_slice(), b"x"].concat()).unwrap();
    assert!(!store
        .listening_publishable(&registry, &archive, &items)
        .unwrap());
}
#[test]
fn pending_solid_pass_left_by_a_tool_failure_is_retried_next_scan() {
    let f = Fixture::new();
    let archive = measured_solid_archive(&f);
    let store = f.open();
    let sources = store.list_sources().unwrap();
    let source = &sources.items[0];
    let items = store.observe_listening(
        &source.id,
        &archive,
        &scan::token(&archive),
        &AtomicBool::new(false),
    );
    assert!(items[0].observation.listening_pending);
    // Metadata published, then the solid pass failed on the tool (`Keep`):
    // nothing else is published and the pending state is stored.
    store
        .publish_targeted(
            "tool-failed",
            sources.sources_revision,
            &source.id,
            &items,
            &[],
        )
        .unwrap();
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(
        store
            .activity
            .solid_passes
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
        "retried once, at the next scan"
    );
    let id = store.query_entries(10, None, false).unwrap().items[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let card = store.get_card(&id).unwrap();
    assert_eq!(card["exemplars"][0]["storyCount"], 2);
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(
        store
            .activity
            .solid_passes
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
}
#[test]
fn startup_pending_solid_pass_is_resumed_then_skipped() {
    let f = Fixture::new();
    let archive = measured_solid_archive(&f);
    let store = f.open();
    assert_eq!(f.scan(&store).status, "success");
    // Simulate closing the app after metadata publication, before the solid pass.
    store.write(|tx| {
        tx.execute("UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.listeningPending',json('true'))", [])
            .map_err(store::error)?;
        Ok(())
    }).unwrap();
    let source = store.list_sources().unwrap().items.remove(0);
    let rules = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    let check = || {
        store
            .reconcile_source(
                &super::refresh::Root {
                    source_id: source.id.clone(),
                    path: source.resolved_path.clone(),
                },
                &rules,
                Duration::ZERO,
                &AtomicBool::new(false),
                &|_| false,
                &writes::Registry::default(),
            )
            .unwrap()
    };
    let before = store
        .activity
        .solid_passes
        .load(std::sync::atomic::Ordering::Relaxed);
    assert_eq!(check().analysed, 1);
    assert_eq!(
        store
            .activity
            .solid_passes
            .load(std::sync::atomic::Ordering::Relaxed),
        before + 1
    );
    let before = store.activity.snapshot();
    assert_eq!(check().analysed, 0);
    assert_eq!(store.activity.snapshot().analyses, before.analyses);
    assert!(!store.content_state(&archive).unwrap().analysis_stale);
}
#[test]
fn startup_failing_solid_pass_is_retried_once_per_session_until_content_changes() {
    let f = Fixture::new();
    let archive = measured_solid_archive(&f);
    let store = f.open();
    assert_eq!(f.scan(&store).status, "success");
    store.write(|tx| {
        tx.execute("UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.listeningPending',json('true'))", [])
            .map_err(store::error)?;
        Ok(())
    }).unwrap();
    store
        .activity
        .solid_pass_tool_fails
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let source = store.list_sources().unwrap().items.remove(0);
    let rules = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    let check = || {
        store
            .reconcile_source(
                &super::refresh::Root {
                    source_id: source.id.clone(),
                    path: source.resolved_path.clone(),
                },
                &rules,
                Duration::ZERO,
                &AtomicBool::new(false),
                &|_| false,
                &writes::Registry::default(),
            )
            .unwrap()
    };
    let passes = || {
        store
            .activity
            .solid_passes
            .load(std::sync::atomic::Ordering::Relaxed)
    };
    let before = passes();
    assert_eq!(check().analysed, 1);
    assert_eq!(passes(), before + 1);
    assert!(store.content_state(&archive).unwrap().analysis_stale);
    // The tool keeps failing: no second resumption in this session.
    let snapshot = store.activity.snapshot();
    assert_eq!(check().analysed, 0);
    assert_eq!(store.activity.snapshot().analyses, snapshot.analyses);
    assert_eq!(passes(), before + 1);
    // A real content change lifts the limit.
    let date = std::fs::metadata(&archive).unwrap().modified().unwrap() + Duration::from_secs(2);
    std::fs::File::options()
        .write(true)
        .open(&archive)
        .unwrap()
        .set_modified(date)
        .unwrap();
    assert_eq!(check().analysed, 1);
    assert_eq!(passes(), before + 2);
    assert_eq!(check().analysed, 0);
    assert_eq!(passes(), before + 2);
}
/// A multipack with one readable child and one unreadable child.
fn multipack_with_a_failed_child(f: &Fixture, solid: bool) -> PathBuf {
    let payload = f.0.join("multipack-payload");
    std::fs::create_dir_all(&payload).unwrap();
    let mut story = studio(Some(ID));
    story["stageNodes"] = json!([
        {"uuid":ID,"squareOne":true,"okTransition":{"actionNode":"choice","optionIndex":0}},
        {"uuid":"a","audio":"a.mp3","controlSettings":{"pause":true}}
    ]);
    story["actionNodes"] = json!([{"id":"choice","options":["a"]}]);
    let mut sound = vec![0; 16000];
    sound[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
    let good = {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        w.start_file("story.json", options).unwrap();
        w.write_all(story.to_string().as_bytes()).unwrap();
        w.start_file("assets/a.mp3", options).unwrap();
        w.write_all(&sound).unwrap();
        w.finish().unwrap().into_inner()
    };
    std::fs::write(payload.join("good.zip"), &good).unwrap();
    std::fs::write(payload.join("bad.zip"), b"not an archive").unwrap();
    write_listening_multipack(f, solid)
}
fn write_listening_multipack(f: &Fixture, solid: bool) -> PathBuf {
    let payload = f.0.join("multipack-payload");
    if solid {
        let archive = f.root().join("multipack.7z");
        let tool = crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
        assert!(std::process::Command::new(tool)
            .args(["a", "-t7z", "-ms=on"])
            .arg(&archive)
            .args(["good.zip", "bad.zip"])
            .current_dir(&payload)
            .output()
            .unwrap()
            .status
            .success());
        archive
    } else {
        use std::io::Write;
        let archive = f.root().join("multipack.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        for name in ["good.zip", "bad.zip"] {
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(&std::fs::read(payload.join(name)).unwrap())
                .unwrap();
        }
        w.finish().unwrap();
        archive
    }
}
#[test]
fn multipack_with_a_failed_child_is_measured_once() {
    for solid in [true, false] {
        let f = Fixture::new();
        multipack_with_a_failed_child(&f, solid);
        let store = f.open();
        let count = |counter: &std::sync::atomic::AtomicU64| {
            counter.load(std::sync::atomic::Ordering::Relaxed)
        };
        assert_eq!(f.scan(&store).status, "success");
        let (passes, measurements) = (
            count(&store.activity.solid_passes),
            count(&store.activity.measurements),
        );
        assert_eq!(passes, u64::from(solid));
        assert_eq!(measurements, 1);
        let entries = store.query_entries(10, None, false).unwrap();
        let card = store
            .get_card(entries.items[0]["id"].as_str().unwrap())
            .unwrap();
        let measured = card["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["storyCount"] == 1)
            .expect("the readable child is measured");
        assert_eq!(measured["durationSeconds"], 1.0);
        for _ in 0..2 {
            assert_eq!(f.scan(&store).status, "success");
        }
        assert_eq!(count(&store.activity.solid_passes), passes, "solid={solid}");
        assert_eq!(
            count(&store.activity.measurements),
            measurements,
            "solid={solid}"
        );
    }
}

#[test]
fn readable_multipack_child_becoming_corrupt_keeps_metadata_and_settles_listening() {
    for solid in [true, false] {
        let f = Fixture::new();
        let archive = multipack_with_a_failed_child(&f, solid);
        let payload = f.0.join("multipack-payload");
        std::fs::copy(payload.join("good.zip"), payload.join("bad.zip")).unwrap();
        std::fs::remove_file(&archive).unwrap();
        write_listening_multipack(&f, solid);
        let store = f.open();
        assert_eq!(f.scan(&store).status, "success");
        let previous: String = store.read(|c| c.query_row(
            "SELECT raw_observation_json FROM cache.observation o JOIN exemplar e ON e.id=o.exemplar_id WHERE json_extract(e.anchor_json,'$.member')='bad.zip'",
            [], |r| r.get(0))).unwrap();
        let previous: Value = serde_json::from_str(&previous).unwrap();
        assert_eq!(previous["state"], "available");
        std::fs::write(payload.join("bad.zip"), b"now corrupt").unwrap();
        std::fs::remove_file(&archive).unwrap();
        write_listening_multipack(&f, solid);
        let progress = f.scan(&store);
        assert_eq!(
            progress.status,
            "success",
            "{}",
            serde_json::to_string(&progress).unwrap()
        );
        let (state, raw): (String, String) = store.read(|c| c.query_row(
            "SELECT o.state,o.raw_observation_json FROM cache.observation o JOIN exemplar e ON e.id=o.exemplar_id WHERE json_extract(e.anchor_json,'$.member')='bad.zip'",
            [], |r| Ok((r.get(0)?,r.get(1)?)))).unwrap();
        let raw: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(state, "corruptArchive");
        assert_eq!(raw["fields"], previous["fields"]);
        assert_eq!(raw["title"], previous["title"]);
        assert_ne!(raw["listeningToken"], previous["listeningToken"]);
        let count = |counter: &std::sync::atomic::AtomicU64| {
            counter.load(std::sync::atomic::Ordering::Relaxed)
        };
        let passes = count(&store.activity.solid_passes);
        let measurements = count(&store.activity.measurements);
        for _ in 0..2 {
            assert_eq!(f.scan(&store).status, "success");
        }
        assert_eq!(count(&store.activity.solid_passes), passes, "solid={solid}");
        assert_eq!(
            count(&store.activity.measurements),
            measurements,
            "solid={solid}"
        );
    }
}

/// A STUdio pack whose root offers `stories` one-second stories.
#[cfg(unix)]
fn measured_story_zip(stories: usize) -> Vec<u8> {
    let names: Vec<String> = (0..stories).map(|i| format!("s{i}")).collect();
    let mut nodes = vec![json!({"uuid":ID,"squareOne":true,
        "okTransition":{"actionNode":"choice","optionIndex":0}})];
    nodes.extend(
        names
            .iter()
            .map(|n| json!({"uuid":n,"audio":format!("{n}.mp3"),"controlSettings":{"pause":true}})),
    );
    let mut story = studio(Some(ID));
    story["stageNodes"] = Value::Array(nodes);
    story["actionNodes"] = json!([{"id":"choice","options":names}]);
    let mut sound = vec![0; 16000];
    sound[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    w.start_file("story.json", options).unwrap();
    w.write_all(story.to_string().as_bytes()).unwrap();
    for name in &names {
        w.start_file(format!("assets/{name}.mp3"), options).unwrap();
        w.write_all(&sound).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A transient failure observed right after a content change must not settle
/// the listening values of the previous content.
#[cfg(unix)]
#[test]
fn access_denied_after_content_change_does_not_keep_stale_listening() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let path = f.root().join("pack.zip");
    std::fs::write(&path, measured_story_zip(1)).unwrap();
    let store = f.open();
    let values = |store: &store::Store| {
        let id = store.query_entries(10, None, false).unwrap().items[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let card = store.get_card(&id).unwrap();
        (
            card["exemplars"][0]["storyCount"].clone(),
            card["exemplars"][0]["durationSeconds"].clone(),
        )
    };
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(values(&store), (json!(1), json!(1.0)));
    std::fs::write(&path, measured_story_zip(3)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&path).is_ok() {
        // Running with privileges that ignore file modes: nothing to check.
        return;
    }
    f.scan(&store);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    for _ in 0..2 {
        assert_eq!(f.scan(&store).status, "success");
        assert_eq!(values(&store), (json!(3), json!(3.0)));
    }
}

#[test]
fn operation_issues_are_paginated_without_successes_and_keep_action_kind() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let (receipt, op) = store
        .begin_file_report(
            "trash-test",
            "trash",
            205,
            Arc::new(|_, p| {
                assert_eq!(p.operation_kind.as_deref(), Some("trash"));
            }),
        )
        .unwrap();
    {
        let mut progress = op.progress.lock().unwrap();
        for index in 0..202 {
            progress.report.push(events::ReportItem {
                path: format!("/success/{index}"),
                member: None,
                outcome: "updated".into(),
                reason: None,
                detail: None,
            });
        }
        for outcome in ["error", "refused", "scopeError"] {
            progress.report.push(events::ReportItem {
                path: format!("/failed/{outcome}"),
                member: None,
                outcome: outcome.into(),
                reason: Some("accessDenied".into()),
                detail: None,
            });
        }
    }
    let page = store
        .operation_issue_page(&receipt.operation_id, 2, None)
        .unwrap();
    assert_eq!(page.total_matching, 3);
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].outcome, "error");
    assert_eq!(page.items[1].outcome, "refused");
    let next = store
        .operation_issue_page(&receipt.operation_id, 2, page.cursor.as_deref())
        .unwrap();
    assert_eq!(next.items[0].outcome, "scopeError");
    assert!(next.cursor.is_none());
    assert!(store
        .operation_issue_page(&receipt.operation_id, 2, Some("4"))
        .is_err());
    let all = store
        .operation_page(&receipt.operation_id, 100, None)
        .unwrap();
    assert_eq!(all.total_matching, 205);
    assert_eq!(all.items[0].outcome, "updated");
    let serialized = serde_json::to_value(all).unwrap();
    assert_eq!(serialized["operationKind"], "trash");
}

#[test]
fn operation_failure_keeps_translatable_error_parameters_in_issue_page() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let sink: scan::Sink = Arc::new(|_, _| {});
    let (receipt, op) = store
        .begin_file_report("failure", "trash", 1, Arc::clone(&sink))
        .unwrap();
    op.progress.lock().unwrap().current_directory = Some("/missing.mbah".into());
    let failure = crate::support::user_message::UserMessage::new(
        crate::support::user_message::codes::CATALOG_FILE_DISAPPEARED,
    )
    .param("path", "/missing.mbah");
    store::Store::finish_file_report(&op, &sink, Err(failure.clone()), 1, false);
    let page = store
        .operation_issue_page(&receipt.operation_id, 100, None)
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].path, "/missing.mbah");
    let message: Value = serde_json::from_str(page.items[0].detail.as_ref().unwrap()).unwrap();
    assert_eq!(message["code"], failure.code);
    assert_eq!(message["params"]["path"], "/missing.mbah");
}

/// The listed `coverSignature` keys the front cache; the fiche thumbnail must
/// answer with the same signature for the same state, on real pack formats.
fn assert_listed_and_served_signatures_agree(store: &Arc<store::Store>) -> usize {
    let mut cursor = None::<String>;
    let mut checked = 0;
    loop {
        let page = store.query_entries(200, cursor.as_deref(), true).unwrap();
        for entry in &page.items {
            let id = entry["id"].as_str().unwrap();
            let listed = entry["coverSignature"].as_str().unwrap().to_owned();
            let served = store.get_thumbnail(None, Some(id), None).unwrap();
            let relisted = store
                .query_entries(200, None, true)
                .unwrap()
                .items
                .into_iter()
                .find(|e| e["id"] == id)
                .unwrap()["coverSignature"]
                .as_str()
                .unwrap()
                .to_owned();
            // Only the read itself (an `@unreadable` marker) may change the
            // inputs: the answer then carries the new listed signature.
            if served.state != "unreadable" {
                assert_eq!(
                    relisted, listed,
                    "{id}: a plain read changes no cover input"
                );
            }
            assert_eq!(
                served.signature.as_deref(),
                Some(relisted.as_str()),
                "{id} {}",
                entry["displayTitle"]
            );
            checked += 1;
        }
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    checked
}

#[test]
#[ignore = "real corpus: CATALOGUE_SIGNATURE_CORPUS=<dir> cargo test listed_and_served_signatures_on_corpus -- --ignored --nocapture"]
fn listed_and_served_signatures_on_corpus() {
    let corpus = PathBuf::from(std::env::var("CATALOGUE_SIGNATURE_CORPUS").unwrap());
    let f = Fixture::new();
    let status = std::process::Command::new("cp")
        .arg("-r")
        .arg(&corpus)
        .arg(f.root().join("corpus"))
        .status()
        .unwrap();
    assert!(status.success());
    let store = f.open();
    f.scan(&store);
    assert!(assert_listed_and_served_signatures_agree(&store) > 0);
}

#[test]
fn listed_and_served_signatures_agree_on_real_formats() {
    let f = Fixture::new();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(64, 64, image::Rgb([10, 120, 200]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let png = png.into_inner();
    let options = zip::write::SimpleFileOptions::default();
    let zip_with_cover = |story: &Value| {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.start_file("story.json", options).unwrap();
        writer.write_all(story.to_string().as_bytes()).unwrap();
        writer.start_file("thumbnail.png", options).unwrap();
        writer.write_all(&png).unwrap();
        writer.finish().unwrap().into_inner()
    };
    let other = "bda17862-0d71-41f6-974a-222222222222";
    // One pack in three formats (ZIP, 7z, studio folder) and other fiches.
    std::fs::write(f.root().join("pack.zip"), zip_with_cover(&studio(Some(ID)))).unwrap();
    let folder = f.root().join("pack folder");
    std::fs::create_dir(&folder).unwrap();
    write_json(&folder.join("story.json"), &studio(Some(ID)));
    std::fs::write(folder.join("thumbnail.png"), &png).unwrap();
    let payload = f.0.join("payload");
    std::fs::create_dir(&payload).unwrap();
    write_json(&payload.join("story.json"), &studio(Some(ID)));
    std::fs::write(payload.join("thumbnail.png"), &png).unwrap();
    let tool = crate::support::imported_pack::resolve_7z_path().expect("7z available");
    assert!(std::process::Command::new(&tool)
        .args(["a", "-t7z"])
        .arg(f.root().join("pack.7z"))
        .args(["story.json", "thumbnail.png"])
        .current_dir(&payload)
        .output()
        .unwrap()
        .status
        .success());
    let mut outer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    outer.start_file("child.zip", options).unwrap();
    outer
        .write_all(&zip_with_cover(&studio(Some(other))))
        .unwrap();
    std::fs::write(
        f.root().join("nested.zip"),
        outer.finish().unwrap().into_inner(),
    )
    .unwrap();
    std::fs::write(f.root().join("absent.zip"), zip_bytes(&studio(None))).unwrap();
    let store = f.open();
    f.scan(&store);
    assert_eq!(assert_listed_and_served_signatures_agree(&store), 3);
    // Unchanged rescan: same keys, nothing to reload in the front.
    let before = store.query_entries(200, None, true).unwrap().items;
    f.scan(&store);
    let after = store.query_entries(200, None, true).unwrap().items;
    let keys = |items: &[Value]| {
        let mut keys: Vec<_> = items
            .iter()
            .map(|e| (e["id"].clone(), e["coverSignature"].clone()))
            .collect();
        keys.sort_by_key(|k| k.0.to_string());
        keys
    };
    assert_eq!(keys(&before), keys(&after));
    assert_eq!(assert_listed_and_served_signatures_agree(&store), 3);
}

#[test]
fn operation_retention_registry_is_complete_beyond_the_presented_twenty() {
    let f = Fixture::new();
    let store = f.open();
    let active = store
        .begin_lunii_send("retention-active".into(), 1, Arc::new(|_, _| {}))
        .unwrap();
    let active_id = active.progress.lock().unwrap().operation_id.clone();
    let mut first = String::new();
    for i in 0..40 {
        let op = store
            .begin_lunii_send(format!("retention-{i}"), 1, Arc::new(|_, _| {}))
            .unwrap();
        let mut p = op.progress.lock().unwrap();
        if i == 0 {
            first = p.operation_id.clone();
        }
        p.status = "success".into();
        p.timestamp = i;
    }
    let listed = store.list_operations(20).unwrap();
    assert_eq!(listed.items.len(), 20);
    assert_eq!(listed.retained_operation_ids.len(), 32);
    assert!(listed.retained_operation_ids.contains(&active_id));
    assert_eq!(store.get_operation(&active_id).unwrap().status, "running");
    assert!(!listed.retained_operation_ids.contains(&first));
    assert!(store.get_operation(&first).is_err());
    for id in &listed.retained_operation_ids {
        assert!(store.get_operation(id).is_ok());
    }
    let json = serde_json::to_value(listed).unwrap();
    assert_eq!(json["retainedOperationIds"].as_array().unwrap().len(), 32);
}

#[test]
fn lunii_send_uses_catalogue_snapshots_cancellation_and_idempotent_receipt() {
    let f = Fixture::new();
    let store = f.open();
    let op = store
        .begin_lunii_send("send-request".into(), 3, Arc::new(|_, _| {}))
        .unwrap();
    let repeated = store
        .begin_lunii_send("send-request".into(), 3, Arc::new(|_, _| {}))
        .unwrap();
    assert!(Arc::ptr_eq(&op, &repeated));
    let id = op.progress.lock().unwrap().operation_id.clone();
    op.started.store(true, std::sync::atomic::Ordering::SeqCst);
    let p = store.get_operation(&id).unwrap();
    assert_eq!(p.operation_kind.as_deref(), Some("luniiSend"));
    assert_eq!(p.candidates.total, Some(3));
    assert_eq!(store.cancel_operation(&id).unwrap().status, "cancelling");
    assert!(op.cancel.load(std::sync::atomic::Ordering::SeqCst));
    assert!(store
        .list_operations(20)
        .unwrap()
        .items
        .iter()
        .any(|p| p.operation_id == id));
}

#[test]
fn a_damaged_picture_is_published_per_exemplar_and_measured_again_after_a_version_change() {
    let f = Fixture::new();
    let pack = f.root().join("pack");
    std::fs::create_dir_all(pack.join("assets")).unwrap();
    let mut story = studio(Some(ID));
    story["actionNodes"] = json!([]);
    story["stageNodes"][0]["name"] = json!("Accueil");
    story["stageNodes"][0]["image"] = json!("cut.bmp");
    write_json(&pack.join("story.json"), &story);
    std::fs::write(pack.join("assets/cut.bmp"), b"BM truncated").unwrap();
    let store = f.open();
    assert_eq!(f.scan(&store).status, "success");
    let field = |store: &store::Store| {
        store.query_entries(10, None, false).unwrap().items[0]["exemplars"][0]["observation"]
            ["fields"]["/packMetadata/damagedMedia"]["rawValue"]
            .clone()
    };
    assert_eq!(field(&store), json!({"kind": "image", "screen": "Accueil"}));
    // An observation stored by the previous version carries no such field.
    store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET raw_observation_json=json_remove(json_set(raw_observation_json,'$.listeningVersion',?1),'$.fields.\"/packMetadata/damagedMedia\"')",
                [i64::from(super::analyze::LISTENING_VERSION) - 1],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(field(&store), Value::Null);
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(
        field(&store),
        json!({"kind": "image", "screen": "Accueil"}),
        "the older version is measured again"
    );
    // The stable scan then reuses the stored value instead of decoding again.
    assert_eq!(f.scan(&store).outcomes.unchanged, 1);
    assert_eq!(field(&store), json!({"kind": "image", "screen": "Accueil"}));
    // Replacing the picture clears the flag (the picture is a dependency).
    let mut good = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(4, 4)
        .write_to(&mut good, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(pack.join("assets/cut.bmp"), good.into_inner()).unwrap();
    assert_eq!(f.scan(&store).status, "success");
    assert_eq!(field(&store), Value::Null);
}
