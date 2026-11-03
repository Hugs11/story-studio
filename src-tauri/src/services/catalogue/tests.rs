use super::*;
use std::path::PathBuf;
struct Fixture(PathBuf);

#[test]
fn releasing_extractions_after_cache_initialization_failure_is_a_noop() {
    let f = Fixture::new();
    let blocked = f.0.join("cache-is-a-file");
    std::fs::write(&blocked, b"preserve").unwrap();
    let state = CatalogueState::default();
    assert!(open::editor_extractions_in(&state, &blocked).is_err());
    let owner = uuid::Uuid::new_v4().to_string();
    open::release_editor_extractions_in(&state, &owner).unwrap();
    assert!(state.editor_extractions.get().is_none());
    assert_eq!(std::fs::read(&blocked).unwrap(), b"preserve");
    assert!(open::editor_extractions_in(&state, &blocked).is_err());

    let registry = open::editor_extractions_in(&state, &f.cache()).unwrap();
    let lease = registry.acquire(&owner).unwrap();
    open::release_editor_extractions_in(&state, &owner).unwrap();
    assert!(registry.acquire(&owner).is_err());
    assert!(lease.path().exists());
    let path = lease.path().to_owned();
    drop(lease);
    assert!(!path.exists());
}

impl Fixture {
    fn new() -> Self {
        let root = crate::support::paths::canonical_temp_dir()
            .join(format!("catalogue-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn cache(&self) -> PathBuf {
        self.0.join("cache")
    }
    fn open(&self) -> store::Store {
        store::Store::open(&self.data(), &self.cache()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn prepare_mock_resources() {
    // macOS Tauri resolves resources relative to the executable. A cargo test
    // binary lives in debug/deps, outside an .app, so its ../Resources fixture
    // must exist too. Keep it for concurrent mock apps using the same build.
    #[cfg(target_os = "macos")]
    std::fs::create_dir_all(
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("../Resources"),
    )
    .unwrap();
}
#[test]
fn creation_and_transaction_rollback() {
    let f = Fixture::new();
    let store = f.open();
    assert_eq!(
        store
            .read(|c| c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        10
    );
    assert_eq!(
        store
            .read_cache(|c| c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        2
    );
    let result: Result<()> = store.write(|tx| {
        tx.execute("UPDATE catalogue SET revision=123", []).unwrap();
        Err(store::error("rollback"))
    });
    assert!(result.is_err());
    assert_eq!(store.list_sources().unwrap().catalogue_revision, 0);
    store
        .write_cache(|tx| {
            tx.execute(
                "INSERT INTO scan VALUES ('s','source',0,'running','{}')",
                [],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    assert!(
        store::Store::open(&f.data(), &f.cache()).is_err(),
        "second writer refused"
    );
}
#[test]
fn migration_v0_backup() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.data().join("catalogue")).unwrap();
    let c = rusqlite::Connection::open(f.data().join("catalogue/catalogue.sqlite")).unwrap();
    c.execute_batch("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('retained'); PRAGMA journal_mode=WAL;").unwrap();
    let store = f.open();
    assert_eq!(
        store
            .read(|c| c.query_row("SELECT value FROM legacy", [], |r| r.get::<_, String>(0)))
            .unwrap(),
        "retained"
    );
    let backup = std::fs::read_dir(f.data().join("catalogue/recovery"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let b = rusqlite::Connection::open(backup).unwrap();
    assert_eq!(
        b.query_row("SELECT value FROM legacy", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "retained"
    );
    assert_eq!(
        b.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn corrupt_preserved_and_future_refused() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.data().join("catalogue")).unwrap();
    let path = f.data().join("catalogue/catalogue.sqlite");
    std::fs::write(&path, b"broken database").unwrap();
    let store = f.open();
    assert_eq!(store.warnings[0].code, "CATALOG_STORE_CORRUPT");
    let recovery = std::fs::read_dir(f.data().join("catalogue/recovery"))
        .unwrap()
        .filter_map(|r| r.ok())
        .find(|r| r.file_name().to_string_lossy().starts_with("corrupt-"))
        .unwrap();
    assert_eq!(
        std::fs::read(recovery.path().join("catalogue.sqlite")).unwrap(),
        b"broken database"
    );
    drop(store);
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA user_version=42;").unwrap();
    drop(c);
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        store::Store::open(&f.data(), &f.cache())
            .err()
            .unwrap()
            .code,
        "CATALOG_STORE_VERSION_UNSUPPORTED"
    );
    assert_eq!(std::fs::read(path).unwrap(), before);
}
#[test]
fn durable_survives_cache_purge() {
    let f = Fixture::new();
    let store = f.open();
    store
        .write(|tx| {
            tx.execute("INSERT INTO fiche VALUES ('f',0,1,0)", [])
                .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    drop(store);
    // Exercise the actual startup cleaner with a file older than 24 hours.
    let cache_file = f.cache().join("catalogue/index.sqlite");
    std::fs::File::options()
        .write(true)
        .open(&cache_file)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
        .unwrap();
    let disposable = f
        .cache()
        .join(crate::support::temp::PODCAST_MEDIA_DIR)
        .join("old.tmp");
    std::fs::create_dir_all(disposable.parent().unwrap()).unwrap();
    let file = std::fs::File::create(&disposable).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
        .unwrap();
    drop(file);
    crate::cleanup_application_cache(&f.cache());
    assert!(!disposable.exists());
    // Startup deliberately excludes the catalogue index; a cache purge remains
    // safe even when performed independently of the age-based startup cleanup.
    assert!(cache_file.exists());
    assert!(f.data().join("catalogue/catalogue.sqlite").exists());
    std::fs::remove_dir_all(f.cache()).unwrap();
    let store = f.open();
    assert_eq!(
        store
            .read(
                |c| c.query_row("SELECT favorite FROM fiche WHERE id='f'", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        1
    );
}
#[test]
fn nested_roots_removal_and_declines() {
    let f = Fixture::new();
    let store = f.open();
    let child = f.0.join("root/child");
    std::fs::create_dir_all(&child).unwrap();
    let parent = store.add_source(&f.0.join("root"), 0, false).unwrap();
    let added = store.add_source(&child, 1, false).unwrap();
    let list = store.list_sources().unwrap();
    assert_eq!(
        list.items
            .iter()
            .find(|s| s.id == added.source_id)
            .unwrap()
            .included_in
            .as_deref(),
        Some(parent.source_id.as_str())
    );
    store.remove_source(&parent.source_id, 2).unwrap();
    assert!(store
        .list_sources()
        .unwrap()
        .items
        .iter()
        .find(|s| s.id == added.source_id)
        .unwrap()
        .included_in
        .is_none());
    let workspace = f.0.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    store
        .add_source(&workspace.join("exports"), 3, true)
        .unwrap();
    store.remember_workspace(workspace.to_str()).unwrap();
    store.remember_workspace(workspace.to_str()).unwrap();
    assert_eq!(
        store
            .list_sources()
            .unwrap()
            .items
            .iter()
            .filter(|s| s.status == "declined")
            .count(),
        1
    );
}
#[test]
fn roles_temporaries_and_source_bytes_untouched() {
    let f = Fixture::new();
    let store = f.open();
    let w = f.0.join("workspace");
    std::fs::create_dir_all(w.join("sauvegardes/ordinary")).unwrap();
    let project = w.join("sauvegardes/ordinary/project.mbah");
    std::fs::write(&project, b"author data").unwrap();
    store.remember_workspace(w.to_str()).unwrap();
    let rules = store.exclusions(&f.cache(), &f.data()).unwrap();
    for path in [
        w.join("zips-extraits/pack"),
        w.join("sauvegardes/versions-securite/x.mbah"),
        f.0.join("external/.story-studio-backups/x.mbah"),
        f.cache().join("sessions/story_studio_session_x/x.mbah"),
        w.join("x.mbah.tmp-1-random"),
        w.join(format!("x.zip.{}.partial", uuid::Uuid::new_v4())),
        w.join(".story-studio-write-test-x.tmp"),
    ] {
        assert!(rules.reason_for(&path).is_some(), "{}", path.display());
    }
    for path in [
        &project,
        &w.join("exports/x.zip"),
        &f.0.join("ordinary/zips-extraits/x.zip"),
        &w.join("fichiers-importes-personnels/x.zip"),
    ] {
        assert!(rules.reason_for(path).is_none(), "{}", path.display());
    }
    assert_eq!(std::fs::read(&project).unwrap(), b"author data");
}

#[test]
fn concurrent_reads_and_stale_revision() {
    let f = Fixture::new();
    let store = std::sync::Arc::new(f.open());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let store = store.clone();
            scope.spawn(move || {
                for _ in 0..20 {
                    assert_eq!(store.list_sources().unwrap().catalogue_revision, 0);
                }
            });
        }
    });
    store
        .write(|tx| {
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    let added = store.add_source(&f.0, 0, false).unwrap();
    assert_eq!(added.catalogue_revision, 2);
    assert_eq!(added.sources_revision, 1);
    assert_eq!(
        store.remove_source(&added.source_id, 0).err().unwrap().code,
        "CATALOG_REVISION_CONFLICT"
    );
}
#[test]
fn cache_corruption_and_old_workspace_roles() {
    let f = Fixture::new();
    let store = f.open();
    let old = f.0.join("old");
    let new = f.0.join("new");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(&new).unwrap();
    store.remember_workspace(old.to_str()).unwrap();
    store.remember_workspace(new.to_str()).unwrap();
    drop(store);
    std::fs::write(f.cache().join("catalogue/index.sqlite"), b"bad index").unwrap();
    let store = f.open();
    assert_eq!(store.warnings.len(), 1);
    let rules = store.exclusions(&f.cache(), &f.data()).unwrap();
    assert!(rules.reason_for(&old.join("zips-extraits/a.zip")).is_some());
    assert!(rules.reason_for(&new.join("zips-extraits/a.zip")).is_some());
    let sources = store.list_sources().unwrap();
    assert_eq!(sources.items.len(), 4);
    assert_eq!(
        sources.items.iter().filter(|s| s.status == "hint").count(),
        2
    );
}

#[test]
fn failed_migration_keeps_original_and_backup() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.data().join("catalogue")).unwrap();
    let path = f.data().join("catalogue/catalogue.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE fiche (sentinel TEXT); INSERT INTO fiche VALUES ('original');")
        .unwrap();
    drop(c);
    assert!(store::Store::open(&f.data(), &f.cache()).is_err());
    let c = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT sentinel FROM fiche", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "original"
    );
    assert_eq!(
        std::fs::read_dir(f.data().join("catalogue/recovery"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn source_wire_contract() {
    let f = Fixture::new();
    let store = f.open();
    let outcome = store.add_source(&f.0, 0, false).unwrap();
    let value = serde_json::to_value(outcome).unwrap();
    assert_eq!(value["sourcesRevision"], 1);
    assert_eq!(value["catalogueRevision"], 1);
    assert_eq!(value["affectedCardIds"], serde_json::json!([]));
    let page = serde_json::to_value(store.list_sources().unwrap()).unwrap();
    assert_eq!(page["totalMatching"], 1);
    assert_eq!(page["items"][0]["status"], "active");
    assert!(page.get("catalogue_revision").is_none());
    let reason = serde_json::to_value(store.exclusions(&f.cache(), &f.data()).unwrap()).unwrap();
    assert_eq!(
        reason["items"][0]["reason"]["code"],
        "CATALOG_SOURCE_EXCLUDED"
    );
    assert!(reason["items"][0]["reason"]["params"].is_object());
}

// Native test adapter: directory symlinks use distinct OS APIs.
fn directory_link(target: &std::path::Path, link: &std::path::Path) -> bool {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_dir(target, link);
    // Creating a Windows symbolic link requires Developer Mode or the
    // SeCreateSymbolicLinkPrivilege. Other filesystem errors remain failures.
    #[cfg(windows)]
    if result
        .as_ref()
        .is_err_and(|e| e.raw_os_error() == Some(1314))
    {
        use std::io::Write;
        writeln!(
            std::io::stderr(),
            "SKIP {}: Windows symlink privilege unavailable (1314)",
            std::thread::current().name().unwrap_or("directory_link")
        )
        .unwrap();
        return false;
    }
    result.unwrap();
    true
}

#[test]
fn technical_links_and_direct_sources_remain_excluded() {
    let f = Fixture::new();
    let store = f.open();
    let collection = f.0.join("collection");
    let archives = f.0.join("archives");
    std::fs::create_dir_all(&collection).unwrap();
    std::fs::create_dir_all(&archives).unwrap();
    let technical = collection.join(".story-studio-backups");
    if !directory_link(&archives, &technical) {
        return;
    }
    let project = technical.join("project.mbah");
    std::fs::write(&project, b"untouched backup").unwrap();
    let before = std::fs::read(&project).unwrap();
    store.add_source(&technical, 0, false).unwrap();
    let rules = store.exclusions(&f.cache(), &f.data()).unwrap();
    assert_eq!(
        rules.reason_for(&project).unwrap().role,
        ".story-studio-backups"
    );
    assert!(rules.reason_for(&technical).is_some());
    let source_path = store.list_sources().unwrap().items.remove(0).path;
    assert!(rules
        .reason_for(std::path::Path::new(&source_path))
        .is_some());
    let alias = f.0.join("ordinary-alias");
    let private = collection.join(".story-studio-image-edits");
    std::fs::create_dir_all(&private).unwrap();
    if !directory_link(&private, &alias) {
        return;
    }
    assert_eq!(
        rules.reason_for(&alias.join("image.png")).unwrap().role,
        ".story-studio-image-edits"
    );
    let workspace = f.0.join("workspace");
    std::fs::create_dir_all(workspace.join("zips-extraits")).unwrap();
    store.remember_workspace(workspace.to_str()).unwrap();
    let revision = store.list_sources().unwrap().sources_revision;
    store
        .add_source(&workspace.join("zips-extraits"), revision, false)
        .unwrap();
    let rules = store.exclusions(&f.cache(), &f.data()).unwrap();
    assert_eq!(
        rules
            .reason_for(&workspace.join("zips-extraits/pack.zip"))
            .unwrap()
            .role,
        "zips-extraits"
    );
    assert_eq!(std::fs::read(project).unwrap(), before);
}

#[test]
fn missing_alias_sources_keep_identity_through_creation_and_return() {
    let f = Fixture::new();
    let store = f.open();
    let real = f.0.join("real");
    let alias = f.0.join("alias");
    std::fs::create_dir_all(&real).unwrap();
    if !directory_link(&real, &alias) {
        return;
    }
    let refused = store.add_source(&alias.join("new"), 0, true).unwrap();
    std::fs::create_dir_all(real.join("new")).unwrap();
    let refused_again = store.add_source(&real.join("new"), 1, true).unwrap();
    assert_eq!(refused.source_id, refused_again.source_id);
    // A declined source must be activated before it can be explicitly removed.
    assert_eq!(
        store
            .remove_source(&refused.source_id, 2)
            .err()
            .unwrap()
            .code,
        "CATALOG_SOURCE_NOT_FOUND"
    );
    store.add_source(&real.join("new"), 2, false).unwrap();
    store.remove_source(&refused.source_id, 3).unwrap();
    std::fs::remove_dir(real.join("new")).unwrap();
    store.reconcile_sources().unwrap();
    let missing = store.list_sources().unwrap();
    assert_eq!(missing.items.len(), 1);
    assert_eq!(missing.items[0].status, "removed");
    std::fs::create_dir_all(real.join("new")).unwrap();
    store.reconcile_sources().unwrap();
    let returned = store.list_sources().unwrap();
    assert_eq!(returned.items.len(), 1);
    assert_eq!(returned.items[0].id, refused.source_id);
    assert_eq!(returned.items[0].status, "removed");
    let reactivated = store.add_source(&alias.join("new"), 4, false).unwrap();
    assert_eq!(reactivated.source_id, refused.source_id);
    store.remove_source(&refused.source_id, 5).unwrap();
    std::fs::remove_dir_all(&real).unwrap();
    store.reconcile_sources().unwrap();
    let absent_target = store.list_sources().unwrap();
    assert_eq!(absent_target.items[0].id, refused.source_id);
    assert_eq!(absent_target.items[0].status, "removed");
    assert_eq!(absent_target.sources_revision, 6);
    std::fs::create_dir_all(real.join("new")).unwrap();
    store.reconcile_sources().unwrap();
    let restored_target = store.list_sources().unwrap();
    assert_eq!(restored_target.items.len(), 1);
    assert_eq!(restored_target.items[0].status, "removed");
    assert_eq!(restored_target.sources_revision, 6);
}

#[test]
fn legacy_alias_duplicates_preserve_declines_and_withdrawals() {
    for status in ["declined", "removed"] {
        let f = Fixture::new();
        let store = f.open();
        let real = f.0.join("real");
        let alias = f.0.join("alias");
        std::fs::create_dir_all(real.join("new")).unwrap();
        if !directory_link(&real, &alias) {
            return;
        }
        let canonical = std::fs::canonicalize(real.join("new")).unwrap();
        // Simulate records persisted by the original v1 implementation.
        store
            .write(|tx| {
                #[cfg(unix)]
                let encode = |path: &std::path::Path| {
                    use std::os::unix::ffi::OsStrExt;
                    path.as_os_str().as_bytes().to_vec()
                };
                #[cfg(windows)]
                let encode = |path: &std::path::Path| {
                    use std::os::windows::ffi::OsStrExt;
                    path.as_os_str()
                        .encode_wide()
                        .flat_map(u16::to_le_bytes)
                        .collect::<Vec<_>>()
                };
                for (id, path, state) in [
                    ("remembered", alias.join("new"), status),
                    ("duplicate", canonical.clone(), "active"),
                ] {
                    #[cfg(unix)]
                    let key = encode(&path);
                    #[cfg(windows)]
                    let key = crate::support::paths::path_key(
                        &crate::support::paths::path_for_frontend(&path),
                    )
                    .into_bytes();
                    tx.execute(
                        "INSERT INTO source(id,path,path_key,origin,status,revision)
                         VALUES (?1,?2,?3,'workspace',?4,0)",
                        rusqlite::params![id, encode(&path), key, state],
                    )
                    .map_err(store::error)?;
                }
                Ok(())
            })
            .unwrap();
        // Reconciliation is a background pass; listings never repair.
        store.reconcile_sources().unwrap();
        let list = store.list_sources().unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, "remembered");
        assert_eq!(list.items[0].status, status);
        assert_eq!(list.sources_revision, 1);
        store.remember_workspace(real.to_str()).unwrap();
        assert_eq!(
            store
                .list_sources()
                .unwrap()
                .items
                .iter()
                .find(|s| s.id == "remembered")
                .unwrap()
                .status,
            status
        );
    }
}

fn check_link_target_reconciliation(swap: bool) {
    let f = Fixture::new();
    let store = f.open();
    let targets = [f.0.join("a"), f.0.join("b"), f.0.join("c")];
    for target in &targets {
        std::fs::create_dir_all(target).unwrap();
        std::fs::write(target.join("sentinel.mbah"), b"source bytes").unwrap();
    }
    let links = [f.0.join("first-link"), f.0.join("second-link")];
    if !directory_link(&targets[0], &links[0]) {
        return;
    }
    if !directory_link(&targets[1], &links[1]) {
        return;
    }
    let first = store.add_source(&links[0], 0, false).unwrap();
    let second = store.add_source(&links[1], 1, true).unwrap();
    store.remove_source(&first.source_id, 2).unwrap();
    let before = store.list_sources().unwrap();
    for link in &links {
        // Remove only the link, never the target directory (native API constraint).
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
    }
    if !directory_link(&targets[1], &links[0]) {
        return;
    }
    if !directory_link(&targets[if swap { 0 } else { 2 }], &links[1]) {
        return;
    }
    // Reconciliation is a background pass; listings never repair.
    store.reconcile_sources().unwrap();
    let after = store.list_sources().unwrap();
    assert_eq!(after.items.len(), 2);
    assert_eq!(after.sources_revision, before.sources_revision + 1);
    assert_eq!(after.catalogue_revision, before.catalogue_revision + 1);
    for (id, status) in [
        (&first.source_id, "removed"),
        (&second.source_id, "declined"),
    ] {
        let old = before.items.iter().find(|source| &source.id == id).unwrap();
        let new = after.items.iter().find(|source| &source.id == id).unwrap();
        assert_eq!(new.status, status);
        assert_eq!(new.path, old.path);
        assert_eq!(new.origin, old.origin);
        assert_eq!(new.revision, old.revision + 1);
    }
    // A second reconciliation is stable, and mutations find the final keys.
    store.reconcile_sources().unwrap();
    assert_eq!(
        store.list_sources().unwrap().sources_revision,
        after.sources_revision
    );
    let reactivated = store
        .add_source(&links[0], after.sources_revision, false)
        .unwrap();
    assert_eq!(reactivated.source_id, first.source_id);
    assert_eq!(
        store
            .remove_source(&second.source_id, reactivated.sources_revision)
            .err()
            .unwrap()
            .code,
        "CATALOG_SOURCE_NOT_FOUND"
    );
    assert_eq!(store.list_sources().unwrap().items.len(), 2);
    for target in targets {
        assert_eq!(
            std::fs::read(target.join("sentinel.mbah")).unwrap(),
            b"source bytes"
        );
    }
}

#[test]
fn link_targets_move_in_chain_without_key_collisions() {
    check_link_target_reconciliation(false);
}

#[test]
fn link_targets_swap_without_key_collisions() {
    check_link_target_reconciliation(true);
}

#[test]
fn a_hung_source_probe_never_blocks_the_listing_nor_the_writer() {
    use std::{
        sync::{mpsc, Arc, Mutex},
        time::{Duration, Instant},
    };
    let f = Fixture::new();
    let store = f.open();
    let share = f.0.join("network-share");
    std::fs::create_dir_all(&share).unwrap();
    store.add_source(&share, 0, false).unwrap();
    let before = store.list_sources().unwrap();
    // A simulated dead mount: the resolution never answers until released.
    let (entered, started) = mpsc::channel();
    let (release, hold) = mpsc::channel::<()>();
    let (entered, hold) = (Mutex::new(entered), Mutex::new(hold));
    let resolver: sources::Resolver = Arc::new(move |_| {
        let _ = entered.lock().unwrap().send(());
        let _ = hold.lock().unwrap().recv();
        None
    });
    let timeout = Duration::from_secs(2);
    std::thread::scope(|scope| {
        let pass = scope.spawn(|| {
            let begin = Instant::now();
            let result = store.reconcile_sources_with(&resolver, timeout);
            (result, begin.elapsed())
        });
        started.recv().unwrap();
        // The probe hangs: the listing answers and the writer is free.
        let list = store.list_sources().unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].availability, "available");
        store
            .try_write(|_| Ok(()))
            .expect("no lock is held while probing");
        assert!(!pass.is_finished());
        // The probe is abandoned after its delay; the source keeps its key.
        let (result, elapsed) = pass.join().unwrap();
        assert_eq!(result.unwrap(), sources::Reconciled::default());
        assert!(elapsed >= timeout, "{elapsed:?}");
        assert!(elapsed < timeout + Duration::from_secs(3), "{elapsed:?}");
    });
    let after = store.list_sources().unwrap();
    assert_eq!(after.sources_revision, before.sources_revision);
    assert_eq!(after.items[0].id, before.items[0].id);
    release.send(()).unwrap();
}

#[test]
fn nesting_uses_the_persisted_resolution() {
    let f = Fixture::new();
    let store = f.open();
    let real = f.0.join("real");
    let alias = f.0.join("alias");
    std::fs::create_dir_all(real.join("inner")).unwrap();
    if !directory_link(&real, &alias) {
        return;
    }
    let outer = store.add_source(&alias, 0, false).unwrap();
    let inner = store
        .add_source(&real.join("inner"), outer.sources_revision, false)
        .unwrap();
    // The link disappears: the listing still nests from the stored
    // resolution, without probing the disk.
    #[cfg(unix)]
    std::fs::remove_file(&alias).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(&alias).unwrap();
    let list = store.list_sources().unwrap();
    let nested = list.items.iter().find(|s| s.id == inner.source_id).unwrap();
    assert_eq!(
        nested.included_in.as_deref(),
        Some(outer.source_id.as_str())
    );
}

#[test]
fn two_instances_admit_only_the_one_that_can_guard_project_saves() {
    let f = Fixture::new();
    let first = CatalogueState::default();
    let second = CatalogueState::default();
    let store = first.store(&f.data(), &f.cache()).unwrap();
    assert!(second.store(&f.data(), &f.cache()).is_err());
    let path = f.0.join("new.mbah").to_string_lossy().into_owned();
    let claim = store
        .project_access("save", Some(path), None, None)
        .unwrap();
    store
        .project_access(
            "release",
            None,
            Some(claim["token"].as_str().unwrap().into()),
            None,
        )
        .unwrap();
    drop(store);
    drop(first);
    // Admission failure is latched until restart; never retry behind the editor.
    assert_eq!(
        second.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_ALREADY_OPEN"
    );
    assert!(CatalogueState::default()
        .store(&f.data(), &f.cache())
        .is_ok());
}

#[test]
fn unavailable_catalogue_is_latched_without_reopening_disk() {
    let f = Fixture::new();
    std::fs::write(f.data(), b"not a directory").unwrap();
    let state = CatalogueState::default();
    assert_eq!(
        state.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_STORE_UNAVAILABLE"
    );
    std::fs::remove_file(f.data()).unwrap();
    assert_eq!(
        state.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_STORE_UNAVAILABLE"
    );
    assert!(
        !f.data().exists(),
        "no retry may acquire a writer after degraded editing begins"
    );
    assert!(CatalogueState::default()
        .store(&f.data(), &f.cache())
        .is_ok());
}

#[test]
#[allow(deprecated)] // Mock runtime: one iteration explicitly executes Tauri setup.
fn failed_admission_does_not_abort_tauri_setup() {
    use tauri::Manager;
    prepare_mock_resources();
    let state = CatalogueState::default();
    assert!(state
        .admit_once(|| Err(store::error("simulated unreadable catalogue")))
        .is_err());
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let setup_completed = Arc::clone(&completed);
    let mut app = tauri::test::mock_builder()
        .manage(state)
        .setup(move |app| {
            assert!(crate::admit_startup(
                app.handle(),
                |owns_writer| {
                    assert!(!owns_writer, "degraded editing must skip writer cleanup");
                    let (_, _, logger) = crate::log_plugin_builder(None).split(app.handle())?;
                    logger.log(
                        &log::Record::builder()
                            .args(format_args!("degraded startup"))
                            .level(log::Level::Warn)
                            .target("boot")
                            .build(),
                    );
                    logger.flush();
                    Ok(())
                },
                || panic!("cleanup in degraded mode")
            )
            .unwrap());
            assert_eq!(
                open_store(app.handle()).err().unwrap().code,
                "CATALOG_STORE_UNAVAILABLE"
            );
            assert_eq!(
                app.state::<CatalogueState>()
                    .ensure_available()
                    .unwrap_err()
                    .code,
                "CATALOG_STORE_UNAVAILABLE"
            );
            setup_completed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.run_iteration(|_, _| {});
    assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn ordinary_bundle_child_extracts_after_catalogue_admission_failure() {
    use std::io::Write;
    let f = Fixture::new();
    std::fs::write(f.data(), b"unreadable catalogue directory").unwrap();
    let state = CatalogueState::default();
    assert_eq!(
        state.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_STORE_UNAVAILABLE"
    );

    let mut child = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    child
        .start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    child.write_all(b"{}").unwrap();
    let child = child.finish().unwrap().into_inner();
    let path = f.0.join("multipack.zip");
    let mut bundle = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for name in ["first.zip", "second.zip"] {
        bundle
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        bundle.write_all(&child).unwrap();
    }
    bundle.finish().unwrap();
    let original = std::fs::read(&path).unwrap();
    let path = path.to_str().unwrap();
    let crate::support::imported_pack::ImportedPackSource::Bundle(inventory) =
        crate::support::imported_pack::ensure_studio_pack_source(path).unwrap()
    else {
        panic!("expected a multipack");
    };
    let child_id = inventory.children()[0].child_id.clone();
    let fingerprint = crate::support::imported_pack::bundle_container_fingerprint(path).unwrap();
    drop(inventory);

    // This shared registry serves temporary editor/checker inputs. It must
    // remain usable without SQLite, just like ordinary bundle extraction.
    let root = open::editor_extractions::root(&f.cache());
    std::fs::create_dir_all(&root).unwrap();
    let live = root.join("other-process");
    std::fs::write(&live, b"preserve").unwrap();
    let registry = open::editor_extractions_in(&state, &f.cache()).unwrap();
    assert_eq!(std::fs::read(&live).unwrap(), b"preserve");
    let owner = uuid::Uuid::new_v4().to_string();
    let lease = registry.acquire(&owner).unwrap();
    let extracted = crate::commands::pack::extract_bundle_child_routed(
        path,
        &fingerprint,
        &child_id,
        &f.cache(),
        || panic!("ordinary import must not access catalogue"),
    )
    .unwrap();
    assert_eq!(std::fs::read(extracted).unwrap(), child);
    assert_eq!(
        crate::commands::pack::extract_bundle_child_routed(
            path,
            &fingerprint,
            "catalogue:test",
            &f.cache(),
            || Err("unavailable".into())
        )
        .unwrap_err(),
        "unavailable"
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
    drop(lease);
    registry.release(&owner).unwrap();
    assert_eq!(
        state.ensure_available().unwrap_err().code,
        "CATALOG_STORE_UNAVAILABLE"
    );
}

#[test]
#[allow(deprecated)]
fn writer_contention_blocks_real_startup_without_cleaning_extractions() {
    let f = Fixture::new();
    let first = CatalogueState::default();
    let _writer = first.store(&f.data(), &f.cache()).unwrap();
    let root = open::editor_extractions::root(&f.cache());
    std::fs::create_dir_all(&root).unwrap();
    let live = root.join("live");
    std::fs::write(&live, b"alive").unwrap();
    let second = CatalogueState::default();
    assert_eq!(
        second.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_ALREADY_OPEN"
    );
    let checked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done = checked.clone();
    let mut app = tauri::test::mock_builder()
        .manage(second)
        .setup(move |app| {
            assert!(!crate::admit_startup(
                app.handle(),
                |_| Ok(()),
                || {
                    std::fs::remove_dir_all(&root).unwrap();
                    panic!("secondary instance ran cleanup");
                }
            )
            .unwrap());
            assert_eq!(std::fs::read(&live).unwrap(), b"alive");
            assert!(
                !crate::admit_startup(app.handle(), |_| Ok(()), || panic!("retry cleanup"))
                    .unwrap()
            );
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.run_iteration(|_, _| {});
    assert!(checked.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
#[allow(deprecated)]
fn startup_preserves_rotating_logs_when_blocked_and_prepares_tools_before_watching() {
    use tauri::Manager;
    fn snapshot(root: &std::path::Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        std::fs::read_dir(root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }
    let f = Fixture::new();
    let logs = f.0.join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    // At the real production rotation threshold, even a small write rotates.
    std::fs::write(
        logs.join("story-studio.log"),
        vec![b'x'; crate::LOG_MAX_FILE_SIZE as usize],
    )
    .unwrap();
    std::fs::write(logs.join("story-studio.previous.log"), b"retained log").unwrap();
    let before = snapshot(&logs);
    let first = CatalogueState::default();
    let _writer = first.store(&f.data(), &f.cache()).unwrap();
    let second = CatalogueState::default();
    assert_eq!(
        second.store(&f.data(), &f.cache()).err().unwrap().code,
        "CATALOG_ALREADY_OPEN"
    );
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done = completed.clone();
    let mut blocked = tauri::test::mock_builder()
        .manage(second)
        .setup(move |app| {
            assert!(!crate::admit_startup(
                app.handle(),
                |_| {
                    let (_, _, logger) =
                        crate::log_plugin_builder(Some(tauri_plugin_log::TargetKind::Folder {
                            path: logs.clone(),
                            file_name: Some("story-studio".into()),
                        }))
                        .split(app.handle())?;
                    logger.log(
                        &log::Record::builder()
                            .args(format_args!("secondary admission failed"))
                            .level(log::Level::Error)
                            .target("catalogue")
                            .build(),
                    );
                    logger.flush();
                    Ok(())
                },
                || panic!("blocked watcher started")
            )?);
            assert!(
                snapshot(&logs) == before,
                "blocked startup changed log files or bytes"
            );
            // Positive control: the exact logger configuration really rotates this
            // fixture when an admitted process writes to it (no global logger).
            let state = app.state::<CatalogueState>();
            // The first instance owns admission; use a separate mock app below for
            // the positive startup path rather than retrying this rejected state.
            assert!(state.ensure_available().is_err());
            let (_, _, logger) =
                crate::log_plugin_builder(Some(tauri_plugin_log::TargetKind::Folder {
                    path: logs.clone(),
                    file_name: Some("story-studio".into()),
                }))
                .split(app.handle())?;
            logger.log(
                &log::Record::builder()
                    .args(format_args!("admitted writer"))
                    .level(log::Level::Warn)
                    .target("boot")
                    .build(),
            );
            logger.flush();
            assert!(
                snapshot(&logs) != before,
                "rotation fixture did not detect a real log write"
            );
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    blocked.run_iteration(|_, _| {});
    assert!(completed.load(std::sync::atomic::Ordering::SeqCst));

    let order = std::cell::RefCell::new(Vec::new());
    let mut admitted = tauri::test::mock_builder()
        .manage(first)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    admitted.run_iteration(|_, _| {});
    assert!(crate::admit_startup_with_resources(
        admitted.handle(),
        || {
            order.borrow_mut().push("resources");
            Ok(())
        },
        |owns_writer| {
            assert!(owns_writer);
            order.borrow_mut().push("logs");
            Ok(())
        },
        || {
            order.borrow_mut().push("writer work");
        }
    )
    .unwrap());
    assert_eq!(*order.borrow(), ["resources", "logs", "writer work"]);
}

#[test]
fn failed_open_after_lock_keeps_exclusion() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.data().join("catalogue")).unwrap();
    std::fs::write(f.data().join("catalogue/images"), b"not a directory").unwrap();
    assert!(store::Store::admit(&f.data(), &f.cache()).is_err());
    std::fs::remove_file(f.data().join("catalogue/images")).unwrap();
    assert_eq!(
        store::Store::admit(&f.data(), &f.cache())
            .err()
            .unwrap()
            .code,
        "CATALOG_ALREADY_OPEN"
    );
}

#[test]
fn failed_recovery_start_keeps_exclusion() {
    let f = Fixture::new();
    drop(store::Store::admit(&f.data(), &f.cache()).unwrap());
    // An unreadable recovery inventory makes `start_recovery` fail after the
    // lock is taken and the store is built.
    rusqlite::Connection::open(f.data().join("catalogue/catalogue.sqlite"))
        .unwrap()
        .execute("DROP TABLE file_journal", [])
        .unwrap();
    assert!(CatalogueState::default()
        .store(&f.data(), &f.cache())
        .is_err());
    assert_eq!(
        store::Store::admit(&f.data(), &f.cache())
            .err()
            .unwrap()
            .code,
        "CATALOG_ALREADY_OPEN"
    );
}

#[test]
#[allow(deprecated)]
fn run_named_startup_keeps_plugin_admission_cleanup_and_file_logging_order() {
    use log::Log;
    use tauri::Manager;
    prepare_mock_resources();
    for mode in ["blocked", "degraded", "writer"] {
        let f = Fixture::new();
        let logs = f.0.join("startup-logs");
        let plugin_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ready = plugin_ready.clone();
        let plugin = tauri::plugin::Builder::new("single-instance-test")
            .setup(move |_, _| {
                ready.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .build();
        let complete = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = complete.clone();
        let mut app = crate::startup_builder(tauri::test::mock_builder(), plugin)
            .setup(move |app| {
                assert!(plugin_ready.load(std::sync::atomic::Ordering::SeqCst));
                assert!(!logs.exists(), "file logger preceded admission");
                let state = app.state::<CatalogueState>();
                let result = state.admit_once(|| match mode {
                    "blocked" => Err(UserMessage::new(
                        crate::support::user_message::codes::CATALOG_ALREADY_OPEN,
                    )),
                    "degraded" => Err(store::error("simulated failure")),
                    _ => Ok(Arc::new(store::Store::admit(&f.data(), &f.cache())?)),
                });
                assert_eq!(result.is_ok(), mode == "writer");
                let buffer = crate::support::startup_log::StartupLog::default();
                buffer.log(
                    &log::Record::builder()
                        .target("catalogue")
                        .level(log::Level::Warn)
                        .args(format_args!("admission recovery warning"))
                        .build(),
                );
                struct Work<'a> {
                    state: &'a CatalogueState,
                    logs: &'a std::path::Path,
                    calls: std::cell::RefCell<Vec<&'static str>>,
                }
                impl Work<'_> {
                    fn record(&self, step: &'static str) {
                        assert!(
                            self.state.ensure_available().is_ok(),
                            "cleanup before admission"
                        );
                        assert!(
                            self.logs.join("story-studio.log").exists(),
                            "cleanup before logging"
                        );
                        self.calls.borrow_mut().push(step);
                    }
                }
                impl crate::StartupWriterWork for Work<'_> {
                    fn cleanup_temporary(&self) {
                        self.record("temporary");
                    }
                    fn cleanup_cache(&self) {
                        self.record("cache");
                    }
                    fn start_watching(&self) {
                        self.record("watch");
                    }
                    fn clean_at_startup(&self) {
                        self.record("extractions");
                    }
                }
                let work = Work {
                    state: &state,
                    logs: &logs,
                    calls: Default::default(),
                };
                let admitted = crate::setup_startup(
                    app.handle(),
                    &buffer,
                    tauri_plugin_log::TargetKind::Folder {
                        path: logs.clone(),
                        file_name: Some("story-studio".into()),
                    },
                    &work,
                )?;
                assert_eq!(admitted, mode != "blocked");
                assert_eq!(
                    *work.calls.borrow(),
                    if mode == "writer" {
                        vec!["temporary", "cache", "watch", "extractions"]
                    } else {
                        vec![]
                    }
                );
                if mode == "blocked" {
                    assert!(!logs.exists(), "blocked startup wrote logs");
                } else {
                    buffer.flush();
                    assert!(std::fs::read_to_string(logs.join("story-studio.log"))
                        .unwrap()
                        .contains("admission recovery warning"));
                }
                done.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.run_iteration(|_, _| {});
        assert!(complete.load(std::sync::atomic::Ordering::SeqCst));
    }
}

#[test]
fn m1_workspace_must_exist_and_removed_defaults_are_never_proposed_again() {
    let f = Fixture::new();
    let store = f.open();
    let root = f.0.join("workspace");
    assert!(!store.remember_workspace(root.to_str()).unwrap());
    assert!(store.list_sources().unwrap().items.is_empty());
    std::fs::create_dir_all(&root).unwrap();
    assert!(store.remember_workspace(root.to_str()).unwrap());
    let list = store.list_sources().unwrap();
    assert_eq!(list.items.len(), 2);
    let id = &list.items[0].id;
    let p = store.preview_remove_source(id).unwrap();
    store
        .remove_source_confirmed(id, p.sources_revision, p.catalogue_revision)
        .unwrap();
    assert!(!store.remember_workspace(root.to_str()).unwrap());
    assert_eq!(
        store
            .list_sources()
            .unwrap()
            .items
            .iter()
            .filter(|s| s.status == "active")
            .count(),
        1
    );
    std::fs::remove_dir(&root).unwrap();
    assert!(!store.remember_workspace(root.to_str()).unwrap());
    assert_eq!(
        store.list_sources().unwrap().items.len(),
        2,
        "known roots survive an outage"
    );
}
