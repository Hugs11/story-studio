//! Watching, own writes and reconciliation on real temporary folders.
use super::{
    refresh::ActivitySnapshot,
    store::Store,
    watch::{Config, Service},
    writes::{Declaration, Registry},
};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const UUID_A: &str = "5c0d3f7e-2b1a-4c6d-9e8f-111111111111";
const UUID_B: &str = "5c0d3f7e-2b1a-4c6d-9e8f-222222222222";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = crate::support::paths::canonical_temp_dir()
            .join(format!("catalogue-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        Self(root)
    }
    fn root(&self) -> PathBuf {
        std::fs::canonicalize(self.0.join("source")).unwrap()
    }
    fn open(&self) -> Arc<Store> {
        let store = Arc::new(Store::open(&self.0.join("data"), &self.0.join("cache")).unwrap());
        store.add_source(&self.root(), 0, false).unwrap();
        store
    }
    fn scan(&self, store: &Arc<Store>) {
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
        assert!(until(Duration::from_secs(20), || {
            !matches!(
                store
                    .get_operation(&receipt.operation_id)
                    .unwrap()
                    .status
                    .as_str(),
                "queued" | "running" | "cancelling"
            )
        }));
        // Explicit scans stay visible as operations; background work never is.
        store.scans.operations.lock().unwrap().clear();
    }
    fn start(
        &self,
        store: &Arc<Store>,
        config: Config,
    ) -> (Service, &'static Registry, Arc<AtomicU64>) {
        let registry: &'static Registry = Box::leak(Box::default());
        let notifications = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&notifications);
        let service = Service::start(
            Arc::clone(store),
            registry,
            self.0.join("cache"),
            self.0.join("data"),
            config,
            Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();
        assert!(
            until(Duration::from_secs(20), || {
                let status = service.status();
                !status.sources.is_empty()
                    && status
                        .sources
                        .iter()
                        .all(|s| s.last_reconciled_at.is_some())
            }),
            "initial reconciliation"
        );
        (service, registry, notifications)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fast() -> Config {
    Config {
        debounce: Duration::from_millis(60),
        quiet: Duration::from_millis(60),
        max_delay: Duration::from_secs(1),
        stability: Duration::from_millis(30),
        poll_interval: Duration::from_millis(200),
        tick: Duration::from_millis(20),
        ..Config::default()
    }
}

fn until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

fn delta(after: ActivitySnapshot, before: ActivitySnapshot) -> ActivitySnapshot {
    ActivitySnapshot {
        analyses: after.analyses - before.analyses,
        full_scans: after.full_scans - before.full_scans,
        inventories: after.inventories - before.inventories,
        targeted: after.targeted - before.targeted,
        reconciliations: after.reconciliations - before.reconciliations,
        absorbed: after.absorbed - before.absorbed,
        publications: after.publications - before.publications,
    }
}

fn project(uuid: Option<&str>, title: &str) -> Vec<u8> {
    let mut metadata = json!({ "title": title });
    if let Some(uuid) = uuid {
        metadata["uuid"] = json!(uuid);
    }
    json!({ "projectName": title, "packMetadata": metadata })
        .to_string()
        .into_bytes()
}

fn zip_bytes(uuid: &str, title: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    let story = json!({"title": title, "stageNodes": [{"uuid": uuid, "squareOne": true}]});
    writer.write_all(story.to_string().as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}

fn entries(store: &Store) -> Vec<Value> {
    store.list_entries(200, None).unwrap().items
}

fn titles(store: &Store) -> Vec<String> {
    let mut titles: Vec<String> = entries(store)
        .iter()
        .filter_map(|e| e["values"]["title"].as_str().map(str::to_owned))
        .collect();
    titles.sort();
    titles
}

fn exemplar_states(store: &Store) -> Vec<(String, String)> {
    let mut states: Vec<(String, String)> = entries(store)
        .iter()
        .flat_map(|e| e["exemplars"].as_array().cloned().unwrap_or_default())
        .filter(|x| x["retired"] == false)
        .map(|x| {
            let path = x["locator"]["path"].as_str().unwrap_or("").to_owned();
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            (name, x["state"].as_str().unwrap_or("").to_owned())
        })
        .collect();
    states.sort();
    states
}

fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(snapshot(&path));
        } else {
            files.push((path.clone(), std::fs::read(path).unwrap()));
        }
    }
    files.sort();
    files
}

fn favorite_first_card(store: &Store) -> String {
    let card = entries(store)[0]["id"].as_str().unwrap().to_owned();
    store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [&card])
                .map_err(super::store::error)?;
            Ok(())
        })
        .unwrap();
    card
}

fn favorite(store: &Store, card: &str) -> bool {
    store
        .read(|c| {
            c.query_row("SELECT favorite FROM fiche WHERE id=?1", [card], |r| {
                r.get(0)
            })
        })
        .unwrap()
}

/// The way the interface saves a project: declared, temporary file, copy of
/// the previous version into the excluded history folder, rename, finished.
fn own_save(registry: &Registry, target: &Path, contents: &[u8], index: usize) {
    let temporary = target.with_file_name(format!("projet.mbah.tmp-{index}"));
    let history = target.with_file_name(".story-studio-backups");
    let id = registry.begin(
        Declaration::new("projectSave")
            .exact(target)
            .temporary(&temporary)
            .subtree(&history),
    );
    std::fs::create_dir_all(&history).unwrap();
    if target.exists() {
        std::fs::copy(target, history.join(format!("projet.{index}.mbah"))).unwrap();
    }
    std::fs::write(&temporary, contents).unwrap();
    std::fs::rename(&temporary, target).unwrap();
    registry.finish(&id, true, Vec::new());
}

#[test]
fn autosave_series_publishes_each_save_without_any_full_rescan() {
    let f = Fixture::new();
    let target = f.root().join("projet.mbah");
    std::fs::write(&target, project(Some(UUID_A), "Version 0")).unwrap();
    std::fs::write(f.root().join("autre.zip"), zip_bytes(UUID_B, "Autre")).unwrap();
    let store = f.open();
    f.scan(&store);
    let (service, registry, notifications) = f.start(&store, fast());
    let before = store.activity.snapshot();
    for index in 1..=12 {
        let title = format!("Version {index:02}");
        own_save(registry, &target, &project(Some(UUID_A), &title), index);
        assert!(
            until(Duration::from_secs(10), || titles(&store).contains(&title)),
            "save {index} published"
        );
    }
    // Native events of the saves are recognised as our own writes.
    assert!(until(Duration::from_secs(10), || {
        delta(store.activity.snapshot(), before).absorbed >= 1
    }));
    std::thread::sleep(Duration::from_millis(500));
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.full_scans, 0, "{work:?}");
    assert_eq!(work.inventories, 0, "{work:?}");
    assert_eq!(work.reconciliations, 0, "{work:?}");
    assert_eq!(work.analyses, 12, "one analysis per save: {work:?}");
    assert_eq!(work.publications, 12, "{work:?}");
    assert!(notifications.load(Ordering::SeqCst) >= 12);
    // No report or operation for background publications.
    assert!(store.scans.operations.lock().unwrap().is_empty());
    // One exemplar at the reused path; the history folder is never indexed.
    assert_eq!(
        exemplar_states(&store),
        vec![
            ("autre.zip".into(), "available".into()),
            ("projet.mbah".into(), "available".into())
        ]
    );
    assert_eq!(
        titles(&store),
        vec!["Autre".to_owned(), "Version 12".into()]
    );
    service.stop();
}

#[test]
fn external_write_rename_and_move_are_refreshed_in_place() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.zip"), zip_bytes(UUID_A, "Avec UUID")).unwrap();
    std::fs::write(f.root().join("ancien.mbah"), project(None, "Sans UUID")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = favorite_first_card(&store);
    let cards_before = entries(&store).len();
    let (service, _registry, _) = f.start(&store, fast());
    let before = store.activity.snapshot();

    // An external program writes a new pack.
    std::fs::write(f.root().join("b.zip"), zip_bytes(UUID_B, "Externe")).unwrap();
    assert!(until(Duration::from_secs(10), || titles(&store)
        .contains(&"Externe".to_owned())));

    // Renaming (moving) a pack with UUID keeps its card.
    std::fs::create_dir(f.root().join("rangement")).unwrap();
    std::fs::rename(f.root().join("a.zip"), f.root().join("rangement/a.zip")).unwrap();
    assert!(until(Duration::from_secs(10), || {
        let states = exemplar_states(&store);
        states.contains(&("a.zip".into(), "missing".into()))
            && states.contains(&("a.zip".into(), "available".into()))
    }));
    let with_uuid: Vec<Value> = entries(&store)
        .into_iter()
        .filter(|e| e["values"]["title"] == "Avec UUID")
        .collect();
    assert_eq!(with_uuid.len(), 1, "same card after the move");
    assert_eq!(entries(&store).len(), cards_before + 1);

    // Without UUID a move creates an independent card without proposals.
    let before_move = entries(&store).len();
    std::fs::rename(
        f.root().join("ancien.mbah"),
        f.root().join("rangement/ancien.mbah"),
    )
    .unwrap();
    assert!(until(Duration::from_secs(10), || entries(&store).len()
        == before_move + 1));
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.full_scans + work.inventories, 0, "{work:?}");
    assert!(favorite(&store, &card), "personal data kept");
    service.stop();
}

fn injected_transfer(
    uuid: Option<&str>,
    copy: bool,
    clear_file_identity: bool,
    notifications: impl FnOnce(&Path, &Path) -> Vec<Vec<notify_debouncer_full::notify::Event>>,
) {
    let f = Fixture::new();
    let origin = f.root().join("ancien.mbah");
    let destination = f.root().join("rangement/nouveau.mbah");
    let bytes = project(uuid, "Déplacé");
    std::fs::write(&origin, &bytes).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = entries(&store)[0]["id"].as_str().unwrap().to_owned();
    personal_data(&store, &card);
    store.set_operation_sink(Arc::new(|_, _| {})).unwrap();
    if clear_file_identity {
        // Exercise the existing UUID association even when native IDs are
        // unavailable (or differ, as with a move implemented as copy/delete).
        store
            .write(|tx| {
                tx.execute("UPDATE exemplar_file_state SET file_id=NULL", [])
                    .map_err(super::store::error)?;
                tx.execute("UPDATE cache.file_state SET file_id=NULL", [])
                    .map_err(super::store::error)?;
                Ok(())
            })
            .unwrap();
    }
    std::fs::create_dir(destination.parent().unwrap()).unwrap();
    if copy {
        std::fs::copy(&origin, &destination).unwrap();
    } else {
        std::fs::rename(&origin, &destination).unwrap();
    }
    let before = store.activity.snapshot();
    let pending = super::watch::inject_events(
        Arc::clone(&store),
        Box::leak(Box::default()),
        f.0.join("cache"),
        f.0.join("data"),
        notifications(&origin, &destination),
    );
    assert_eq!(pending, 0, "refresh completed without reconciliation");
    let cards = entries(&store);
    assert_eq!(cards.len(), if uuid.is_some() { 1 } else { 2 });
    let current = cards
        .iter()
        .find(|c| {
            c["exemplars"].as_array().unwrap().iter().any(|e| {
                e["locator"]["path"] == crate::support::paths::path_for_frontend(&destination)
                    && e["state"] == "available"
            })
        })
        .expect("destination indexed immediately");
    if uuid.is_some() {
        assert_eq!(current["id"], card, "existing UUID association");
    } else {
        assert_ne!(current["id"], card, "unidentified moves stay independent");
        assert_eq!(current["favorite"], false);
    }
    let mut states: Vec<_> = cards
        .iter()
        .flat_map(|c| c["exemplars"].as_array().unwrap())
        .filter(|e| e["retired"] == false)
        .map(|e| {
            (
                e["locator"]["path"].as_str().unwrap().to_owned(),
                e["state"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    states.sort();
    assert_eq!(
        states,
        vec![
            (
                crate::support::paths::path_for_frontend(&origin),
                if copy { "available" } else { "missing" }.into(),
            ),
            (
                crate::support::paths::path_for_frontend(&destination),
                "available".into(),
            ),
        ]
    );
    assert!(favorite(&store, &card));
    store
        .read(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT fiche_id FROM tag_member WHERE tag_id='personal-tag'",
                    [],
                    |r| r.get::<_, String>(0)
                )?,
                card
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM identity_convergence", [], |r| {
                    r.get::<_, i64>(0)
                })?,
                0,
                "no convergence proposal"
            );
            Ok(())
        })
        .unwrap();
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.analyses, 1, "{work:?}");
    assert_eq!(work.full_scans, 0, "{work:?}");
    assert_eq!(work.inventories, 0, "{work:?}");
    assert_eq!(work.reconciliations, 0, "{work:?}");
    for operation in store.scans.operations.lock().unwrap().values() {
        let report = operation.progress.lock().unwrap();
        assert_eq!(report.status, "success");
        assert_eq!(report.candidates.total, Some(report.candidates.processed));
        assert_eq!(report.candidates.discovered, report.candidates.processed);
    }
    assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    if copy {
        assert_eq!(std::fs::read(&origin).unwrap(), bytes);
    }
}

fn rename_event(paths: &[&Path]) -> notify_debouncer_full::notify::Event {
    use notify_debouncer_full::notify::{event::RenameMode, Event, EventKind};
    let mut event = Event::new(EventKind::Modify(
        notify_debouncer_full::notify::event::ModifyKind::Name(if paths.len() == 2 {
            RenameMode::Both
        } else {
            RenameMode::Any
        }),
    ));
    event.paths = paths.iter().map(|p| p.to_path_buf()).collect();
    event
}

#[test]
fn injected_move_destination_only_confirms_old_path() {
    injected_transfer(Some(UUID_A), false, false, |_, to| {
        vec![vec![rename_event(&[to])]]
    });
}

#[test]
fn injected_move_created_folder_discovers_destination_and_confirms_old_path() {
    use notify_debouncer_full::notify::{event::CreateKind, Event, EventKind};
    injected_transfer(Some(UUID_A), false, false, |_, to| {
        vec![vec![Event::new(EventKind::Create(CreateKind::Folder))
            .add_path(to.parent().unwrap().to_owned())]]
    });
}

#[test]
fn injected_move_unpaired_origin_then_destination_keeps_card() {
    injected_transfer(Some(UUID_A), false, false, |from, to| {
        vec![vec![rename_event(&[from])], vec![rename_event(&[to])]]
    });
}

#[test]
fn injected_move_paired_keeps_card() {
    injected_transfer(Some(UUID_A), false, false, |from, to| {
        vec![vec![rename_event(&[from, to])]]
    });
}

#[test]
fn injected_move_without_uuid_confirms_absence_without_associating_cards() {
    injected_transfer(None, false, false, |_, to| vec![vec![rename_event(&[to])]]);
}

#[test]
fn injected_move_uuid_without_file_identity_confirms_old_path() {
    injected_transfer(Some(UUID_A), false, true, |_, to| {
        vec![vec![rename_event(&[to])]]
    });
}

#[test]
fn injected_move_copy_keeps_both_paths_available() {
    injected_transfer(Some(UUID_A), true, true, |_, to| {
        vec![vec![rename_event(&[to])]]
    });
}

#[test]
fn injected_move_defers_old_path_owned_by_an_active_write() {
    let f = Fixture::new();
    let origin = f.root().join("ancien.mbah");
    let destination = f.root().join("rangement/nouveau.mbah");
    std::fs::write(&origin, project(Some(UUID_A), "Déplacé")).unwrap();
    let store = f.open();
    f.scan(&store);
    let registry: &'static Registry = Box::leak(Box::default());
    let write = registry.begin(Declaration::new("externalWrite").exact(&origin));
    std::fs::create_dir(destination.parent().unwrap()).unwrap();
    std::fs::rename(&origin, &destination).unwrap();
    let before = store.activity.snapshot();
    assert_eq!(
        super::watch::inject_events(
            Arc::clone(&store),
            registry,
            f.0.join("cache"),
            f.0.join("data"),
            vec![vec![rename_event(&[&destination])]],
        ),
        1,
        "the associated origin must be queued until its writer finishes"
    );
    assert_eq!(
        exemplar_states(&store),
        vec![
            ("ancien.mbah".into(), "available".into()),
            ("nouveau.mbah".into(), "available".into()),
        ]
    );
    registry.finish(&write, false, Vec::new());
    // Deliver the retained origin through the same pipeline after release.
    assert_eq!(
        super::watch::inject_events(
            Arc::clone(&store),
            registry,
            f.0.join("cache"),
            f.0.join("data"),
            vec![vec![rename_event(&[&origin])]],
        ),
        0
    );
    assert_eq!(
        exemplar_states(&store),
        vec![
            ("ancien.mbah".into(), "missing".into()),
            ("nouveau.mbah".into(), "available".into()),
        ]
    );
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.analyses, 1);
    assert_eq!(work.full_scans + work.inventories + work.reconciliations, 0);
}

#[test]
fn injected_move_ignores_retired_and_pathless_exemplars() {
    for (retired, anchor) in [
        (false, json!({})),
        (false, json!({"path": null, "pathKey": null})),
        (false, json!({"path": "restored.mbah"})),
        (false, json!({"pathKey": [1, 2, 3]})),
        (false, json!({"path": "restored.mbah", "pathKey": 42})),
        (true, json!({})),
    ] {
        let f = Fixture::new();
        let origin = f.root().join("ancien.mbah");
        let destination = f.root().join("nouveau.mbah");
        std::fs::write(&origin, project(Some(UUID_A), "Déplacé")).unwrap();
        let store = f.open();
        f.scan(&store);
        let card = entries(&store)[0]["id"].as_str().unwrap().to_owned();
        personal_data(&store, &card);
        // Restored/retired exemplars can keep the same UUID card without a
        // usable filesystem anchor. They must not poison related-path lookup.
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO exemplar
                       (id,fiche_id,anchor_json,verified_uuid,proof_json,content_revision,retired)
                     VALUES ('pathless',?1,?2,?3,'{}',0,?4)",
                    rusqlite::params![card, anchor.to_string(), UUID_A, retired],
                )
                .map_err(super::store::error)?;
                Ok(())
            })
            .unwrap();
        std::fs::rename(&origin, &destination).unwrap();
        let before = store.activity.snapshot();
        assert_eq!(
            super::watch::inject_events(
                Arc::clone(&store),
                Box::leak(Box::default()),
                f.0.join("cache"),
                f.0.join("data"),
                vec![vec![rename_event(&[&destination])]],
            ),
            0
        );
        let cards = entries(&store);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["id"], card);
        for (path, state) in [(&origin, "missing"), (&destination, "available")] {
            assert!(cards[0]["exemplars"].as_array().unwrap().iter().any(|e| {
                e["locator"]["path"] == crate::support::paths::path_for_frontend(path)
                    && e["state"] == state
            }));
        }
        let pathless = cards[0]["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == "pathless")
            .unwrap();
        assert_eq!(pathless["locator"], anchor);
        assert_eq!(pathless["retired"], retired);
        assert!(favorite(&store, &card));
        let work = delta(store.activity.snapshot(), before);
        assert_eq!(work.analyses, 1, "{work:?}");
        assert_eq!(work.publications, 1, "{work:?}");
        assert_eq!(work.full_scans + work.inventories + work.reconciliations, 0);
    }
}

#[test]
fn injected_move_lookup_error_publishes_destination_then_reconciles() {
    let f = Fixture::new();
    let origin = f.root().join("ancien.mbah");
    let destination = f.root().join("nouveau.mbah");
    std::fs::write(&origin, project(Some(UUID_A), "Déplacé")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = entries(&store)[0]["id"].as_str().unwrap().to_owned();
    personal_data(&store, &card);
    std::fs::rename(&origin, &destination).unwrap();
    let before = store.activity.snapshot();
    store
        .activity
        .related_path_lookup_fails
        .store(true, Ordering::Relaxed);
    // An empty batch advances the worker after the targeted refresh so the
    // requested reconciliation runs, with no new filesystem notification.
    super::watch::inject_events(
        Arc::clone(&store),
        Box::leak(Box::default()),
        f.0.join("cache"),
        f.0.join("data"),
        vec![vec![rename_event(&[&destination])], vec![]],
    );
    assert_eq!(
        exemplar_states(&store),
        vec![
            ("ancien.mbah".into(), "missing".into()),
            ("nouveau.mbah".into(), "available".into()),
        ]
    );
    assert_eq!(entries(&store).len(), 1);
    assert_eq!(entries(&store)[0]["id"], card);
    assert!(favorite(&store, &card));
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(
        work.analyses, 1,
        "destination was not analysed twice: {work:?}"
    );
    assert_eq!(
        work.publications, 2,
        "destination published before fallback: {work:?}"
    );
    assert_eq!(work.inventories, 1, "{work:?}");
    assert_eq!(work.reconciliations, 1, "{work:?}");
    assert_eq!(work.full_scans, 0, "{work:?}");
}

#[test]
fn injected_move_related_lookup_cost_is_per_file_not_per_archive_member() {
    use notify_debouncer_full::notify::{event::CreateKind, Event, EventKind};
    const CATALOGUE_FILES: usize = 128;
    const ARCHIVE_MEMBERS: usize = 32;
    const COPIES: usize = 24;
    let f = Fixture::new();
    let uuids: Vec<_> = (0..CATALOGUE_FILES)
        .map(|i| format!("5c0d3f7e-2b1a-4c6d-9e8f-{i:012}"))
        .collect();
    let names: Vec<_> = (0..CATALOGUE_FILES)
        .map(|i| format!("pack-{i:03}.zip"))
        .collect();
    for (name, uuid) in names.iter().zip(&uuids) {
        std::fs::write(f.root().join(name), zip_bytes(uuid, name)).unwrap();
    }
    let store = f.open();
    f.scan(&store);
    let incoming = f.root().join("incoming");
    std::fs::create_dir(&incoming).unwrap();
    let archive = incoming.join("bundle.zip");
    let members: Vec<_> = names
        .iter()
        .zip(&uuids)
        .take(ARCHIVE_MEMBERS)
        .map(|(name, uuid)| (name.as_str(), uuid.as_str()))
        .collect();
    std::fs::write(&archive, bundle(&members)).unwrap();
    // Different file identity: every member's UUID must still lead back to
    // its old path, rather than keeping only the archive's first UUID.
    for name in names.iter().take(ARCHIVE_MEMBERS) {
        std::fs::remove_file(f.root().join(name)).unwrap();
    }
    for name in names.iter().skip(ARCHIVE_MEMBERS).take(COPIES) {
        std::fs::copy(f.root().join(name), incoming.join(name)).unwrap();
    }
    let before = store.activity.snapshot();
    assert_eq!(
        super::watch::inject_events(
            Arc::clone(&store),
            Box::leak(Box::default()),
            f.0.join("cache"),
            f.0.join("data"),
            vec![vec![
                Event::new(EventKind::Create(CreateKind::Folder)).add_path(incoming)
            ]],
        ),
        0
    );
    assert_eq!(
        store
            .activity
            .related_file_map_loads
            .load(Ordering::Relaxed),
        1
    );
    assert_eq!(
        store.activity.related_uuid_queries.load(Ordering::Relaxed),
        (COPIES + 1) as u64
    );
    let states = exemplar_states(&store);
    for name in names.iter().take(ARCHIVE_MEMBERS) {
        assert!(states.contains(&(name.clone(), "missing".into())), "{name}");
    }
    let archive_path = crate::support::paths::path_for_frontend(&archive);
    let archive_exemplars: Vec<_> = entries(&store)
        .into_iter()
        .flat_map(|card| card["exemplars"].as_array().unwrap().clone())
        .filter(|e| e["locator"]["path"] == archive_path && e["state"] == "available")
        .collect();
    assert_eq!(archive_exemplars.len(), ARCHIVE_MEMBERS);
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.analyses, (COPIES + 1) as u64, "{work:?}");
    assert_eq!(work.full_scans + work.inventories + work.reconciliations, 0);
}

#[test]
fn related_lookup_query_plans_use_existing_indexes() {
    use super::refresh::{RELATED_FILE_IDS, RELATED_UUID_KEYS};
    let f = Fixture::new();
    let store = f.open();
    store
        .read(|c| {
            for (sql, parameter, searches) in [
                (
                    RELATED_FILE_IDS,
                    "source",
                    vec!["SEARCH v", "SEARCH e", "SEARCH f"],
                ),
                (RELATED_UUID_KEYS, "[]", vec!["SEARCH p", "SEARCH e"]),
            ] {
                let plan = c
                    .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
                    .query_map([parameter], |r| r.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert!(
                    !plan
                        .iter()
                        .any(|line| line.contains("SCAN e ") || line == "SCAN e"),
                    "{plan:?}"
                );
                for search in searches {
                    assert!(
                        plan.iter().any(|line| line.starts_with(search)),
                        "{search}: {plan:?}"
                    );
                }
                if sql == RELATED_UUID_KEYS {
                    assert!(
                        plan.iter().any(|line| line.contains("exemplar_fiche")),
                        "{plan:?}"
                    );
                    assert!(
                        plan.iter().any(|line| line.contains("pack_uuid=?")),
                        "{plan:?}"
                    );
                } else {
                    assert!(
                        plan.iter().any(|line| line.contains("source_id=?")),
                        "{plan:?}"
                    );
                }
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn lost_events_are_reconciled_at_startup_on_overflow_and_after_wake_up() {
    let f = Fixture::new();
    for (name, title) in [
        ("stable-1", "Un"),
        ("stable-2", "Deux"),
        ("change", "Avant"),
    ] {
        std::fs::write(f.root().join(format!("{name}.mbah")), project(None, title)).unwrap();
    }
    std::fs::write(f.root().join("parti.zip"), zip_bytes(UUID_A, "Parti")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = favorite_first_card(&store);

    // Changes while nothing watches: every native event is lost.
    std::fs::write(f.root().join("change.mbah"), project(None, "Après !")).unwrap();
    std::fs::remove_file(f.root().join("parti.zip")).unwrap();
    std::fs::write(f.root().join("nouveau.zip"), zip_bytes(UUID_B, "Nouveau")).unwrap();
    let source_bytes = snapshot(&f.root());
    let before = store.activity.snapshot();
    let config = Config {
        capacity: 2,
        ..fast()
    };
    let (service, _registry, _) = f.start(&store, config);
    let work = delta(store.activity.snapshot(), before);
    if cfg!(target_os = "macos") {
        // FSEvents delivers asynchronous, coalesced notifications: SinceNow
        // (notify 8.2.0, fsevent.rs) is not a drain barrier for pending changes.
        // Late notifications can overflow this deliberately tiny queue after
        // startup reconciliation. Extra inventories must remain idempotent.
        assert!(work.reconciliations >= 1, "{work:?}");
        assert!(work.inventories >= 1, "{work:?}");
        assert_eq!(work.publications, 1, "{work:?}");
    } else {
        assert_eq!(work.reconciliations, 1, "{work:?}");
    }
    assert_eq!(
        work.analyses, 2,
        "only the changed and the new file: {work:?}"
    );
    assert_eq!(work.full_scans, 0);
    let states = exemplar_states(&store);
    assert!(
        states.contains(&("parti.zip".into(), "missing".into())),
        "{states:?}"
    );
    assert!(states.contains(&("nouveau.zip".into(), "available".into())));
    assert!(titles(&store).contains(&"Après !".to_owned()));
    assert_eq!(
        states,
        vec![
            ("change.mbah".into(), "available".into()),
            ("nouveau.zip".into(), "available".into()),
            ("parti.zip".into(), "missing".into()),
            ("stable-1.mbah".into(), "available".into()),
            ("stable-2.mbah".into(), "available".into()),
        ]
    );
    // An external replacement without UUID retains the former card with a
    // retired exemplar; it cannot claim the continuity of an attested save.
    assert_eq!(
        titles(&store),
        vec!["Après !", "Avant", "Deux", "Nouveau", "Parti", "Un"]
    );

    // A burst larger than the queue overflows: the source is reconciled.
    let before = store.activity.snapshot();
    for index in 0..5 {
        let uuid = format!("5c0d3f7e-2b1a-4c6d-9e8f-00000000000{index}");
        std::fs::write(
            f.root().join(format!("rafale-{index}.zip")),
            zip_bytes(&uuid, &format!("Rafale {index}")),
        )
        .unwrap();
    }
    assert!(until(Duration::from_secs(15), || {
        (0..5).all(|i| titles(&store).contains(&format!("Rafale {i}")))
    }));
    assert!(delta(store.activity.snapshot(), before).reconciliations >= 1);

    // A wake-up reconciles without reanalysing unchanged files.
    let before = store.activity.snapshot();
    service.wake();
    assert!(until(Duration::from_secs(10), || {
        delta(store.activity.snapshot(), before).reconciliations >= 1
    }));
    assert_eq!(delta(store.activity.snapshot(), before).analyses, 0);
    assert!(favorite(&store, &card), "personal data intact");
    for (path, bytes) in &source_bytes {
        assert_eq!(
            &std::fs::read(path).unwrap(),
            bytes,
            "source bytes unchanged"
        );
    }
    service.stop();
}

#[test]
fn never_scanned_source_is_not_indexed_silently_and_polling_detects_changes() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.zip"), zip_bytes(UUID_A, "Premier")).unwrap();
    let store = f.open();
    let config = Config {
        force_polling: true,
        ..fast()
    };
    let (service, _registry, _) = f.start(&store, config);
    assert_eq!(service.status().sources[0].mode, "polling");
    assert_eq!(store.activity.snapshot().analyses, 0);
    assert!(entries(&store).is_empty(), "waits for the explicit scan");
    service.stop();

    f.scan(&store);
    let config = Config {
        force_polling: true,
        ..fast()
    };
    let (service, _registry, _) = f.start(&store, config);
    std::fs::write(f.root().join("b.zip"), zip_bytes(UUID_B, "Scruté")).unwrap();
    assert!(until(Duration::from_secs(15), || titles(&store)
        .contains(&"Scruté".to_owned())));
    service.stop();
}

#[test]
fn failed_own_write_is_released_and_reconciled() {
    let f = Fixture::new();
    let store = f.open();
    f.scan(&store);
    let (service, registry, _) = f.start(&store, fast());
    let target = f.root().join("export.zip");
    let id = registry.begin(Declaration::new("generation").subtree(f.root()));
    std::fs::write(&target, zip_bytes(UUID_A, "Partiel")).unwrap();
    // Deferred while the operation is active.
    std::thread::sleep(Duration::from_millis(400));
    assert!(titles(&store).is_empty());
    registry.finish(&id, false, Vec::new());
    assert!(until(Duration::from_secs(10), || titles(&store)
        .contains(&"Partiel".to_owned())));
    service.stop();
}

#[test]
fn reconciliation_leaves_files_of_an_active_own_write_alone() {
    let f = Fixture::new();
    std::fs::write(f.root().join("connu.zip"), zip_bytes(UUID_B, "Connu")).unwrap();
    let store = f.open();
    f.scan(&store);
    let (service, registry, _) = f.start(&store, fast());
    let target = f.root().join("corrige.zip");
    let known = f.root().join("connu.zip");
    let id = registry.begin(
        Declaration::new("checker")
            .exact(target.clone())
            .exact(known.clone()),
    );
    let full = zip_bytes(UUID_A, "Corrigé");
    std::fs::write(&target, &full[..full.len() / 2]).unwrap();
    std::fs::remove_file(&known).unwrap();

    let before = store.activity.snapshot();
    service.wake();
    assert!(until(Duration::from_secs(10), || {
        delta(store.activity.snapshot(), before).reconciliations >= 1
    }));
    std::thread::sleep(Duration::from_millis(300));
    let work = delta(store.activity.snapshot(), before);
    assert_eq!(work.analyses, 0, "{work:?}");
    assert!(!titles(&store).contains(&"Corrigé".to_owned()));
    assert!(
        exemplar_states(&store).contains(&("connu.zip".into(), "available".into())),
        "no absence concluded for a file under an active write"
    );

    std::fs::write(&target, &full).unwrap();
    std::fs::write(&known, zip_bytes(UUID_B, "Connu")).unwrap();
    let before = store.activity.snapshot();
    registry.finish(&id, true, vec![target.clone(), known.clone()]);
    assert!(until(Duration::from_secs(10), || titles(&store)
        .contains(&"Corrigé".to_owned())));
    std::thread::sleep(Duration::from_millis(400));
    let analyses = delta(store.activity.snapshot(), before).analyses;
    // One analysis per rewritten file (the target and the recreated one).
    assert_eq!(analyses, 2, "each file analysed once");
    service.stop();
}

fn refresh_file(
    f: &Fixture,
    store: &Store,
    registry: &Registry,
    path: &Path,
) -> super::refresh::Refreshed {
    let source = store
        .list_sources()
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.status == "active")
        .unwrap();
    store
        .refresh_paths(
            &super::refresh::Root {
                source_id: source.id,
                path: f.root(),
            },
            &[super::refresh::Change {
                path: path.to_owned(),
                settled: true,
                structural: true,
            }],
            &store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap(),
            Duration::from_millis(1),
            &std::sync::atomic::AtomicBool::new(false),
            registry,
        )
        .unwrap()
}

fn personal_data(store: &Store, card: &str) {
    store.write(|tx| {
        tx.execute("INSERT INTO tag VALUES ('personal-tag','Personal tag','personal tag',0)", []).map_err(super::store::error)?;
        tx.execute("INSERT INTO tag_member VALUES ('personal-tag',?1)", [card]).map_err(super::store::error)?;
        tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [card]).map_err(super::store::error)?;


        tx.execute("INSERT INTO provenance(id,kind) VALUES ('manual','manual')", []).map_err(super::store::error)?;
        tx.execute("INSERT INTO correction VALUES (?1,'title','','defined','\"Mon titre\"','manual',NULL,0)", [card]).map_err(super::store::error)?;
        Ok(())
    }).unwrap();
}

#[test]
fn attested_legacy_save_keeps_card_exemplar_and_personal_data_on_uuid_convergence() {
    for known_uuid in [false, true] {
        let f = Fixture::new();
        let path = f.root().join("ancien.mbah");
        std::fs::write(&path, project(None, "Ancien")).unwrap();
        if known_uuid {
            std::fs::write(f.root().join("export.zip"), zip_bytes(UUID_A, "Connu")).unwrap();
        }
        let store = f.open();
        f.scan(&store);
        let old = entries(&store)
            .into_iter()
            .find(|c| c["values"]["title"] == "Ancien")
            .unwrap();
        let card = old["id"].as_str().unwrap();
        let exemplar = old["exemplars"][0]["id"].as_str().unwrap();
        personal_data(&store, card);
        let registry = Registry::default();
        let write = registry.begin(Declaration::new("projectSave").exact(&path));
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, project(Some(UUID_A), "Avec identité")).unwrap();
        std::fs::rename(&temporary, &path).unwrap();
        registry.finish(&write, true, Vec::new());
        assert!(refresh_file(&f, &store, &registry, &path).changed);
        let current = store.query_entries(200, None, false).unwrap();
        assert_eq!(current.items.len(), 1);
        assert_eq!(current.items[0]["id"], card);
        assert!(current.items[0]["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == exemplar && e["retired"] == false));
        assert!(favorite(&store, card));
        store
            .read(|c| {
                assert_eq!(
                    c.query_row(
                        "SELECT value_json FROM correction WHERE fiche_id=?1",
                        [card],
                        |r| r.get::<_, String>(0)
                    )?,
                    "\"Mon titre\""
                );
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM tag_member WHERE fiche_id=?1",
                        [card],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
                assert_eq!(
                    c.query_row(
                        "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
                        [UUID_A],
                        |r| r.get::<_, String>(0)
                    )?,
                    card
                );
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn external_uuid_acquisition_and_save_to_another_path_have_no_automatic_continuity() {
    for copy in [false, true] {
        let f = Fixture::new();
        let original = f.root().join("ancien.mbah");
        std::fs::write(&original, project(None, "Ancien")).unwrap();
        let store = f.open();
        f.scan(&store);
        let card = favorite_first_card(&store);
        let registry = Registry::default();
        let destination = if copy {
            f.root().join("copie.mbah")
        } else {
            original
        };
        let write =
            copy.then(|| registry.begin(Declaration::new("projectSave").exact(&destination)));
        std::fs::write(&destination, project(Some(UUID_A), "Ancien")).unwrap();
        if let Some(write) = write {
            registry.finish(&write, true, Vec::new());
        }
        refresh_file(&f, &store, &registry, &destination);
        assert_eq!(entries(&store).len(), 2);
        assert!(favorite(&store, &card));
        assert!(
            !entries(&store).iter().find(|c| c["id"] != card).unwrap()["favorite"]
                .as_bool()
                .unwrap()
        );
    }
}

fn bundle(members: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, uuid) in members {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&zip_bytes(uuid, name)).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn stable_container_inventory_removes_renamed_replaced_and_direct_pack_members() {
    for case in 0..4 {
        let f = Fixture::new();
        let path = f.root().join("bundle.zip");
        std::fs::write(&path, bundle(&[("a.zip", UUID_A), ("b.zip", UUID_B)])).unwrap();
        let store = f.open();
        f.scan(&store);
        let old = entries(&store)
            .into_iter()
            .find(|c| c["values"]["title"] == "b.zip")
            .unwrap();
        let card = old["id"].as_str().unwrap();
        personal_data(&store, card);
        let bytes = match case {
            0 => bundle(&[("a.zip", UUID_A)]),
            1 => bundle(&[("a.zip", UUID_A), ("renamed.zip", UUID_B)]),
            2 => bundle(&[
                ("a.zip", UUID_A),
                ("b.zip", "5c0d3f7e-2b1a-4c6d-9e8f-333333333333"),
            ]),
            _ => zip_bytes(UUID_A, "Direct"),
        };
        std::fs::write(&path, &bytes).unwrap();
        let registry = Registry::default();
        let result = if case % 2 == 0 {
            refresh_file(&f, &store, &registry, &path)
        } else {
            let source = store.list_sources().unwrap().items[0].id.clone();
            store
                .reconcile_source(
                    &super::refresh::Root {
                        source_id: source,
                        path: f.root(),
                    },
                    &store
                        .exclusions(&f.0.join("cache"), &f.0.join("data"))
                        .unwrap(),
                    Duration::from_millis(1),
                    &std::sync::atomic::AtomicBool::new(false),
                    &|_| false,
                    &registry,
                )
                .unwrap()
        };
        assert!(result.changed);
        let former = entries(&store)
            .into_iter()
            .find(|c| c["id"] == card)
            .unwrap();
        let former_id = &old["exemplars"][0]["id"];
        assert!(former["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| &e["id"] == former_id && e["state"] != "available"));
        assert!(favorite(&store, card));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn queued_committed_write_does_not_publish_a_new_active_write() {
    let f = Fixture::new();
    let path = f.root().join("project.mbah");
    let store = f.open();
    f.scan(&store);
    let (service, registry, notifications) = f.start(&store, fast());
    // Hold background publication until A has queued its success and B owns
    // the same path, with a valid but provisional file that stays stable.
    let heavy = store.scans.heavy.lock().unwrap();
    let a = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "A")).unwrap();
    registry.finish(&a, true, Vec::new());
    let b = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "B provisoire")).unwrap();
    drop(heavy);
    std::thread::sleep(Duration::from_millis(500));
    assert!(entries(&store).is_empty());
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
    std::fs::write(&path, project(Some(UUID_A), "B final")).unwrap();
    registry.finish(&b, true, Vec::new());
    assert!(until(Duration::from_secs(10), || titles(&store)
        .contains(&"B final".into())));
    assert!(!titles(&store).contains(&"B provisoire".into()));
    service.stop();
}

#[test]
fn explicit_scan_preserves_active_write_without_analysis_or_absence() {
    let f = Fixture::new();
    let path = f.root().join("project.mbah");
    std::fs::write(&path, project(Some(UUID_A), "Avant")).unwrap();
    let store = f.open();
    f.scan(&store);
    let registry = super::writes::shared();
    // The process-wide registry is shared with concurrently running tests: a
    // save that meets a busy analyser is deliberately not declared. This test
    // needs a declared write, so it waits for a declaration that succeeds.
    let deadline = Instant::now() + Duration::from_secs(20);
    let write = loop {
        let id = registry.begin(Declaration::new("projectSave").exact(&path));
        if !id.is_empty() {
            break id;
        }
        assert!(Instant::now() < deadline, "no declaration accepted");
        std::thread::sleep(Duration::from_millis(5));
    };
    std::fs::write(&path, project(Some(UUID_A), "Provisoire")).unwrap();
    let before = store.activity.snapshot();
    f.scan(&store);
    assert_eq!(store.activity.snapshot().analyses, before.analyses);
    assert_eq!(titles(&store), vec!["Avant"]);
    assert_eq!(exemplar_states(&store)[0].1, "available");
    registry.finish(&write, false, Vec::new());
}

#[test]
fn native_root_removal_and_recreation_reinstalls_watcher_and_emits_return() {
    let f = Fixture::new();
    let root = f.root();
    let path = root.join("same.mbah");
    let bytes = project(Some(UUID_A), "Même fichier");
    std::fs::write(&path, &bytes).unwrap();
    let store = f.open();
    f.scan(&store);
    let (service, _, notifications) = f.start(&store, fast());
    assert_eq!(service.status().sources[0].mode, "native");
    let revision = store.list_entries(100, None).unwrap().catalogue_revision;
    // A detached directory models a volume leaving and returning unchanged;
    // removing the root name also invalidates native Linux watches.
    let away = f.0.join("away");
    std::fs::rename(&root, &away).unwrap();
    assert!(until(Duration::from_secs(10), || service.status().sources
        [0]
    .mode
        == "unavailable"
        && exemplar_states(&store)[0].1 == "unavailable"));
    let disconnected = store.list_entries(100, None).unwrap().catalogue_revision;
    let events = notifications.load(Ordering::SeqCst);
    assert!(disconnected > revision);
    std::fs::rename(&away, &root).unwrap();
    assert!(until(Duration::from_secs(10), || service.status().sources
        [0]
    .mode
        == "native"
        && exemplar_states(&store)[0].1 == "available"
        && notifications.load(Ordering::SeqCst) > events));
    assert!(store.list_entries(100, None).unwrap().catalogue_revision > disconnected);
    // Genuine deletion/recreation follows the same probe/reinstallation path.
    std::fs::remove_dir_all(&root).unwrap();
    assert!(until(Duration::from_secs(10), || service.status().sources
        [0]
    .mode
        == "unavailable"));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert!(until(Duration::from_secs(10), || service.status().sources
        [0]
    .mode
        == "native"
        && exemplar_states(&store)[0].1 == "available"));
    std::fs::write(
        root.join("new.mbah"),
        project(Some(UUID_B), "Nouvelle arborescence"),
    )
    .unwrap();
    assert!(until(Duration::from_secs(10), || titles(&store)
        .contains(&"Nouvelle arborescence".into())));
    service.stop();
}

#[test]
fn entry_page_uses_one_snapshot_across_concurrent_publication() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.mbah"), project(Some(UUID_A), "Avant")).unwrap();
    let store = f.open();
    f.scan(&store);
    let before = store.list_entries(100, None).unwrap();
    let writer = Arc::clone(&store);
    let page = store
        .query_entries_after_revision(1, None, false, move || {
            std::thread::spawn(move || {
                writer
                    .write(|tx| {
                        tx.execute("UPDATE catalogue SET revision=revision+1", [])
                            .map_err(super::store::error)?;
                        tx.execute("UPDATE fiche SET favorite=1", [])
                            .map_err(super::store::error)?;
                        tx.execute("UPDATE cache.observation SET state='missing'", [])
                            .map_err(super::store::error)?;
                        Ok(())
                    })
                    .unwrap()
            })
            .join()
            .unwrap();
        })
        .unwrap();
    assert_eq!(page.catalogue_revision, before.catalogue_revision);
    assert_eq!(page.total_matching, 1);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0]["favorite"], false);
    assert_eq!(page.items[0]["exemplars"][0]["state"], "available");
    assert!(store
        .query_entries(1, None, false)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn queued_legacy_saves_chain_attestations_after_event_retention() {
    let f = Fixture::new();
    let path = f.root().join("legacy.mbah");
    std::fs::write(&path, project(None, "Ancien")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = favorite_first_card(&store);
    let registry = Registry::new(Duration::from_millis(1), Duration::from_secs(30));
    for title in ["Premier enregistrement", "Deuxième enregistrement"] {
        let write = registry.begin(Declaration::new("projectSave").exact(&path));
        std::fs::write(&path, project(Some(UUID_A), title)).unwrap();
        registry.finish(&write, true, Vec::new());
        std::thread::sleep(Duration::from_millis(3));
        registry.sweep(Instant::now());
    }
    refresh_file(&f, &store, &registry, &path);
    assert_eq!(
        store.query_entries(200, None, false).unwrap().items[0]["id"],
        card
    );
    assert!(favorite(&store, &card));
    assert!(
        registry.save_prestate(&path).is_none(),
        "receipt consumed only after publication"
    );
}

#[test]
fn external_replacement_after_a_save_invalidates_its_attestation() {
    let f = Fixture::new();
    let path = f.root().join("legacy.mbah");
    std::fs::write(&path, project(None, "Ancien")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = favorite_first_card(&store);
    let registry = Registry::default();
    let write = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "Enregistré")).unwrap();
    registry.finish(&write, true, Vec::new());
    let replacement = f.root().join("replacement");
    std::fs::write(&replacement, project(Some(UUID_B), "Remplacement externe")).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    refresh_file(&f, &store, &registry, &path);
    assert_ne!(
        store.query_entries(200, None, false).unwrap().items[0]["id"],
        card
    );
    assert!(favorite(&store, &card));
}

#[test]
fn converging_personal_corrections_never_overwrite_conflicting_values() {
    let f = Fixture::new();
    let path = f.root().join("legacy.mbah");
    std::fs::write(&path, project(None, "Ancien")).unwrap();
    std::fs::write(f.root().join("known.zip"), zip_bytes(UUID_A, "Connu")).unwrap();
    let store = f.open();
    f.scan(&store);
    let all = entries(&store);
    let legacy = all
        .iter()
        .find(|c| c["values"]["title"] == "Ancien")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let known = all
        .iter()
        .find(|c| c["values"]["title"] == "Connu")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    personal_data(&store, legacy);
    store.write(|tx| {
        tx.execute("INSERT INTO correction VALUES (?1,'title','','defined','\"Autre correction\"','manual',NULL,0)",[known]).map_err(super::store::error)?;
        Ok(())
    }).unwrap();
    let registry = Registry::default();
    let write = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "Identité acquise")).unwrap();
    registry.finish(&write, true, Vec::new());
    refresh_file(&f, &store, &registry, &path);
    assert_eq!(
        store.query_entries(200, None, false).unwrap().items.len(),
        2
    );
    let before_resolution = store.query_entries(200, None, false).unwrap();
    let pending_card = before_resolution
        .items
        .iter()
        .find(|c| c["id"] == legacy)
        .unwrap();
    let exemplar = pending_card["exemplars"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(pending_card["pendingConvergence"]["knownFicheId"], known);
    assert!(!store
        .resolve_identity_convergence(&exemplar, before_resolution.catalogue_revision)
        .unwrap());
    f.scan(&store);
    assert_eq!(
        store.query_entries(200, None, false).unwrap().items.len(),
        2,
        "a scan cannot resolve a personal conflict"
    );
    store
        .read(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT value_json FROM correction WHERE fiche_id=?1",
                    [legacy],
                    |r| r.get::<_, String>(0)
                )?,
                "\"Mon titre\""
            );
            assert_eq!(
                c.query_row(
                    "SELECT value_json FROM correction WHERE fiche_id=?1",
                    [known],
                    |r| r.get::<_, String>(0)
                )?,
                "\"Autre correction\""
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM cache.sqlite_master WHERE name='suggestion'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    store
        .read(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
                    [UUID_A],
                    |r| r.get::<_, String>(0)
                )?,
                known
            );
            assert_eq!(
                c.query_row(
                    "SELECT fiche_id FROM exemplar WHERE id=?1",
                    [&exemplar],
                    |r| r.get::<_, String>(0)
                )?,
                legacy
            );
            assert_eq!(
                c.query_row(
                    "SELECT verified_uuid FROM exemplar WHERE id=?1",
                    [&exemplar],
                    |r| r.get::<_, Option<String>>(0)
                )?,
                None
            );
            assert!(
                !c.query_row("SELECT favorite FROM fiche WHERE id=?1", [known], |r| r
                    .get::<_, bool>(0))?
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM tag_member WHERE fiche_id=?1",
                    [known],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    drop(store);
    std::fs::remove_file(f.0.join("cache/catalogue/index.sqlite")).unwrap();
    let store = Arc::new(Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap());
    f.scan(&store);
    assert_eq!(
        store.query_entries(200, None, false).unwrap().items.len(),
        2,
        "pending convergence survives restart and cache purge"
    );
    // Explicit choice: keep the known card's correction on the surviving card.
    store.write(|tx| {
        tx.execute("UPDATE correction SET value_json='\"Autre correction\"' WHERE fiche_id=?1 AND field='title'",[legacy]).map_err(super::store::error)?;
        Ok(())
    }).unwrap();
    let revision = store
        .query_entries(200, None, false)
        .unwrap()
        .catalogue_revision;
    assert!(store
        .resolve_identity_convergence(&exemplar, revision)
        .unwrap());
    let after = store.query_entries(200, None, false).unwrap();
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.items[0]["id"], legacy);
    assert!(after.items[0]["pendingConvergence"].is_null());
    assert!(after.catalogue_revision > revision);
    store
        .read(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT value_json FROM correction WHERE fiche_id=?1",
                    [legacy],
                    |r| r.get::<_, String>(0)
                )?,
                "\"Autre correction\""
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn unchanged_unidentified_child_in_a_changed_archive_gets_a_new_card() {
    let f = Fixture::new();
    let path = f.root().join("bundle.zip");
    let make = |title: &str| {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in [
            ("known.zip", zip_bytes(UUID_A, title)),
            ("legacy.zip", zip_bytes("", "Sans identité")),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    };
    std::fs::write(&path, make("Avant")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = entries(&store)
        .iter()
        .find(|c| c["values"]["title"] == "Sans identité")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    personal_data(&store, &card);
    std::fs::write(&path, make("Autre membre modifié")).unwrap();
    refresh_file(&f, &store, &Registry::default(), &path);
    let current = store.query_entries(200, None, false).unwrap();
    let child = current
        .items
        .iter()
        .find(|c| c["values"]["title"] == "Sans identité")
        .unwrap();
    assert_ne!(child["id"], card);
    assert_eq!(child["favorite"], false);
    assert!(favorite(&store, &card));
}

#[test]
fn successful_save_receipt_survives_restart_before_publication() {
    for resave in [false, true] {
        let f = Fixture::new();
        let path = f.root().join("legacy.mbah");
        std::fs::write(&path, project(None, "Ancien")).unwrap();
        let store = f.open();
        f.scan(&store);
        let card = favorite_first_card(&store);
        let registry = Registry::default();
        let receipt_store = Arc::clone(&store);
        registry.set_listener(Some(Box::new(move |notice| {
            if let super::writes::Notice::Saved { attestations, .. } = notice {
                receipt_store.record_save_receipts(&attestations).unwrap();
            }
        })));
        let write = registry.begin(Declaration::new("projectSave").exact(&path));
        std::fs::write(&path, project(Some(UUID_A), "Enregistré")).unwrap();
        registry.finish(&write, true, Vec::new());
        assert!(store.saved_prestate(&path).unwrap().is_some());
        registry.set_listener(None);
        drop(registry);
        drop(store);
        let reopened = Arc::new(Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap());
        let fresh = Registry::default();
        fresh.bind_store(&reopened);
        if resave {
            let receipt_store = Arc::clone(&reopened);
            fresh.set_listener(Some(Box::new(move |notice| {
                if let super::writes::Notice::Saved { attestations, .. } = notice {
                    receipt_store.record_save_receipts(&attestations).unwrap();
                }
            })));
            let write = fresh.begin(Declaration::new("projectSave").exact(&path));
            std::fs::write(&path, project(Some(UUID_A), "Réenregistré après reprise")).unwrap();
            fresh.finish(&write, true, Vec::new());
            fresh.set_listener(None);
        }
        refresh_file(&f, &reopened, &fresh, &path);
        assert_eq!(
            reopened.query_entries(100, None, false).unwrap().items[0]["id"],
            card
        );
        assert!(favorite(&reopened, &card));
        assert!(reopened.saved_prestate(&path).unwrap().is_none());
    }
}

#[test]
fn external_replacement_before_save_with_same_token_never_inherits_personal_data() {
    let f = Fixture::new();
    let path = f.root().join("legacy.mbah");
    std::fs::write(&path, project(None, "Ancien")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = entries(&store)[0]["id"].as_str().unwrap().to_owned();
    personal_data(&store, &card);
    let before_token = super::scan::token(&path).unwrap();
    let before_id = super::writes::file_id(&path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let replacement = f.root().join("replacement");
    std::fs::write(&replacement, project(None, "Autres")).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        super::scan::token(&path).unwrap(),
        before_token,
        "same size and mtime"
    );
    assert_ne!(super::writes::file_id(&path).unwrap(), before_id);
    let registry = Registry::default();
    let write = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "Autres avec UUID")).unwrap();
    registry.finish(&write, true, Vec::new());
    refresh_file(&f, &store, &registry, &path);
    let current = store.query_entries(200, None, false).unwrap();
    assert_eq!(current.items.len(), 1);
    assert_ne!(current.items[0]["id"], card);
    assert_eq!(current.items[0]["favorite"], false);
    store
        .read(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM correction WHERE fiche_id=?1",
                    [&card],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM tag_member WHERE fiche_id=?1",
                    [&card],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM cache.sqlite_master WHERE name='suggestion'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    assert!(favorite(&store, &card));
}

#[test]
fn missing_verified_file_identity_requires_confirmation_for_uuid_acquisition() {
    let f = Fixture::new();
    let path = f.root().join("legacy.mbah");
    std::fs::write(&path, project(None, "Ancien")).unwrap();
    let store = f.open();
    f.scan(&store);
    let card = favorite_first_card(&store);
    store
        .write(|tx| {
            tx.execute("UPDATE exemplar_file_state SET file_id=NULL", [])
                .map_err(super::store::error)?;
            Ok(())
        })
        .unwrap();
    let registry = Registry::default();
    let write = registry.begin(Declaration::new("projectSave").exact(&path));
    std::fs::write(&path, project(Some(UUID_A), "Identité")).unwrap();
    registry.finish(&write, true, Vec::new());
    refresh_file(&f, &store, &registry, &path);
    assert_ne!(
        store.query_entries(200, None, false).unwrap().items[0]["id"],
        card
    );
    assert!(favorite(&store, &card));
}

#[test]
fn failed_nested_archive_branches_keep_descendants_and_personal_data() {
    for reason in ["corruptArchive", "protectedArchive", "readLimitExceeded"] {
        let f = Fixture::new();
        let path = f.root().join("bundle.zip");
        let wrap = |nested: &[u8], sibling: bool| {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            writer
                .start_file("nested.zip", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(nested).unwrap();
            if sibling {
                writer
                    .start_file("sibling.zip", zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer
                    .write_all(&zip_bytes(
                        "5c0d3f7e-2b1a-4c6d-9e8f-333333333333",
                        "Sibling",
                    ))
                    .unwrap();
            }
            writer.finish().unwrap().into_inner()
        };
        let initial = bundle(&[("a.zip", UUID_A), ("b.zip", UUID_B)]);
        std::fs::write(&path, wrap(&initial, true)).unwrap();
        let store = f.open();
        f.scan(&store);
        let all = entries(&store);
        let card = all
            .iter()
            .find(|c| c["values"]["title"] == "b.zip")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        personal_data(&store, card);
        let failed = match reason {
            "corruptArchive" => b"truncated nested archive".to_vec(),
            "protectedArchive" => {
                let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
                writer
                    .start_file(
                        "a.zip",
                        zip::write::SimpleFileOptions::default()
                            .with_aes_encryption(zip::AesMode::Aes256, "secret"),
                    )
                    .unwrap();
                writer.write_all(&zip_bytes(UUID_A, "a.zip")).unwrap();
                writer.finish().unwrap().into_inner()
            }
            _ => {
                let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
                for i in 0..=crate::support::archive_limits::ARCHIVE_MAX_ENTRIES {
                    writer
                        .start_file(
                            format!("entry-{i}"),
                            zip::write::SimpleFileOptions::default(),
                        )
                        .unwrap();
                }
                writer.finish().unwrap().into_inner()
            }
        };
        let bytes = wrap(&failed, false);
        std::fs::write(&path, &bytes).unwrap();
        let result = refresh_file(&f, &store, &Registry::default(), &path);
        assert!(result.changed);
        for entry in entries(&store) {
            for exemplar in entry["exemplars"].as_array().unwrap() {
                let member = exemplar["locator"]["member"].as_str().unwrap();
                if member.starts_with("nested.zip/") {
                    assert_eq!(exemplar["state"], reason);
                }
                if member == "sibling.zip" {
                    assert_eq!(exemplar["state"], "missing", "conclusive sibling absence");
                }
            }
        }
        f.scan(&store);
        for entry in entries(&store) {
            for exemplar in entry["exemplars"].as_array().unwrap() {
                if exemplar["locator"]["member"]
                    .as_str()
                    .unwrap()
                    .starts_with("nested.zip/")
                {
                    assert_eq!(
                        exemplar["state"], reason,
                        "finalization preserves branch failure"
                    );
                }
            }
        }
        assert!(favorite(&store, card));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&path, wrap(&initial, true)).unwrap();
        refresh_file(&f, &store, &Registry::default(), &path);
        assert!(exemplar_states(&store)
            .iter()
            .all(|(_, state)| state == "available"));
    }
}

#[test]
fn d55_age_corrections_on_one_card_or_complementary_bounds_stay_pending() {
    for complementary in [false, true] {
        let f = Fixture::new();
        let path = f.root().join("legacy.mbah");
        let known_path = f.root().join("known.zip");
        std::fs::write(&path, project(None, "Legacy")).unwrap();
        std::fs::write(&known_path, zip_bytes(UUID_A, "Known")).unwrap();
        let store = f.open();
        f.scan(&store);
        let all = entries(&store);
        let legacy = all
            .iter()
            .find(|c| c["values"]["title"] == "Legacy")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let known = all
            .iter()
            .find(|c| c["values"]["title"] == "Known")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        personal_data(&store, &legacy);
        let set_age = |id: &str, changes: serde_json::Value| {
            let card = store.get_card(id).unwrap();
            store.mutate(serde_json::from_value(json!({"kind":"setMetadataBatch","requestKey":uuid::Uuid::new_v4().to_string(),"ficheId":id,"expectedFicheRevision":card["ficheRevision"],"changes":changes})).unwrap(),card["catalogueRevision"].as_i64().unwrap()).unwrap();
        };
        set_age(
            &legacy,
            json!([{"field":"ageMin","state":"defined","value":8},{"field":"ageMax","state":"source"}]),
        );
        if complementary {
            set_age(
                &known,
                json!([{"field":"ageMin","state":"source"},{"field":"ageMax","state":"defined","value":10}]),
            );
        }
        let registry = Registry::default();
        let write = registry.begin(Declaration::new("projectSave").exact(&path));
        std::fs::write(&path, project(Some(UUID_A), "Saved")).unwrap();
        registry.finish(&write, true, Vec::new());
        let saved_bytes = std::fs::read(&path).unwrap();
        let known_bytes = std::fs::read(&known_path).unwrap();
        refresh_file(&f, &store, &registry, &path);
        let pending = store.query_entries(200, None, false).unwrap();
        assert_eq!(pending.items.len(), 2);
        let legacy_card = pending.items.iter().find(|c| c["id"] == legacy).unwrap();
        assert_eq!(legacy_card["pendingConvergence"]["knownFicheId"], known);
        assert_eq!(legacy_card["favorite"], true);
        f.scan(&store);
        assert_eq!(
            store.query_entries(200, None, false).unwrap().items.len(),
            2,
            "rescan must leave the age conflict pending"
        );
        assert_eq!(std::fs::read(&path).unwrap(), saved_bytes);
        assert_eq!(std::fs::read(&known_path).unwrap(), known_bytes);
    }
}

#[test]
fn attested_identity_acquisition_keeps_refused_grouping_pending() {
    for forgotten in [true, false] {
        let f = Fixture::new();
        let path = f.root().join("legacy.mbah");
        std::fs::write(&path, project(None, "Legacy")).unwrap();
        std::fs::write(f.root().join("known.zip"), zip_bytes(UUID_A, "Known")).unwrap();
        let store = f.open();
        f.scan(&store);
        let cards = entries(&store);
        let legacy = cards
            .iter()
            .find(|c| c["values"]["title"] == "Legacy")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let known = cards
            .iter()
            .find(|c| c["values"]["title"] == "Known")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        if forgotten {
            store
                .write(|tx| {
                    tx.execute("UPDATE exemplar SET retired=1 WHERE fiche_id=?1", [&known])
                        .unwrap();
                    Ok(())
                })
                .unwrap();
            let card = store.get_card(&known).unwrap();
            store.mutate(serde_json::from_value(json!({"kind":"forgetUnreferencedCards","requestKey":"forget","ficheIds":[known],"expectedFicheRevisions":{&known:card["ficheRevision"]}})).unwrap(),card["catalogueRevision"].as_i64().unwrap()).unwrap();
        } else {
            store.write(|tx| {
                tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1",[&known]).unwrap();
                // Fail after group has provisionally transferred the favorite.
                tx.execute_batch("CREATE TRIGGER refuse_exemplar_move BEFORE UPDATE OF fiche_id ON exemplar BEGIN SELECT RAISE(ABORT,'busy publication'); END;").unwrap();
                Ok(())
            }).unwrap();
        }
        let registry = Registry::default();
        let write = registry.begin(Declaration::new("projectSave").exact(&path));
        std::fs::write(&path, project(Some(UUID_A), "Acquired")).unwrap();
        registry.finish(&write, true, Vec::new());
        refresh_file(&f, &store, &registry, &path);
        if forgotten {
            store
                .read(|c| {
                    let count: i64 = c.query_row(
                        "SELECT count(*) FROM cache.sqlite_master WHERE name='suggestion'",
                        [],
                        |r| r.get(0),
                    )?;
                    assert_eq!(
                        count, 0,
                        "identity acquisition must not recreate a proposal to a forgotten card"
                    );
                    Ok(())
                })
                .unwrap();
            assert!(store.get_card(&known).is_err());
            assert!(store.get_card(&legacy).unwrap()["reference"]["state"] == "available");
            assert_eq!(
                store
                    .read(|c| c.query_row(
                        "SELECT count(*) FROM identity_convergence WHERE known_fiche_id=?1",
                        [&known],
                        |r| r.get::<_, i64>(0)
                    ))
                    .unwrap(),
                0
            );
            continue;
        }
        store
            .read(|c| {
                let evidence: String = c.query_row(
                    "SELECT evidence_json FROM identity_convergence WHERE known_fiche_id=?1",
                    [&known],
                    |r| r.get(0),
                )?;
                assert_eq!(
                    serde_json::from_str::<Value>(&evidence).unwrap()["reason"],
                    "groupingRefused"
                );
                assert!(
                    !favorite(&store, &legacy),
                    "failed group must roll back its transferred favorite"
                );
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM fiche_grouping WHERE fiche_id=?1",
                        [&known],
                        |r| r.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn unregistered_workspace_exclusions_apply_to_watcher_events() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.root().join("sauvegardes/versions-securite")).unwrap();
    std::fs::create_dir_all(f.root().join("voix-generees")).unwrap();
    std::fs::write(f.root().join("keep.mbah"), project(Some(UUID_A), "Keep")).unwrap();
    let store = f.open();
    f.scan(&store);
    let (service, _, _) = f.start(&store, fast());
    assert!(until(Duration::from_secs(10), || service.status().sources
        [0]
    .last_reconciled_at
    .is_some()));
    let reconciliations = store.activity.snapshot().reconciliations;
    for name in [
        "sauvegardes/versions-securite/y.mbah",
        "voix-generees/y.mbah",
        "sauvegardes/x.mbah",
    ] {
        std::fs::write(f.root().join(name), project(Some(UUID_A), "Keep")).unwrap();
    }
    let expected = vec![
        ("keep.mbah".into(), "available".into()),
        ("x.mbah".into(), "available".into()),
    ];
    let mut stable_since = None;
    assert!(until(Duration::from_secs(20), || {
        // Read every anchor, including retired ones: later retirement must not
        // hide an erroneous publication by the event path.
        let mut paths = store
            .read(|c| {
                c.prepare("SELECT json_extract(anchor_json,'$.path') FROM exemplar")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        paths.sort();
        let mut allowed = ["keep.mbah", "sauvegardes/x.mbah"]
            .map(|name| crate::support::paths::path_for_frontend(f.root().join(name)))
            .to_vec();
        allowed.sort();
        assert!(paths.iter().all(|path| allowed.contains(path)), "{paths:?}");
        assert_eq!(store.activity.snapshot().reconciliations, reconciliations);
        if paths == allowed && exemplar_states(&store) == expected {
            stable_since.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(2)
        } else {
            stable_since = None;
            false
        }
    }));
    // Reconciliation also sees the excluded files on disk, without indexing
    // them. This avoids asserting an absence merely before debounce fires.
    let source = store.list_sources().unwrap().items.remove(0);
    store
        .reconcile_source(
            &super::refresh::Root {
                source_id: source.id,
                path: f.root(),
            },
            &store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap(),
            Duration::ZERO,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| false,
            &Registry::default(),
        )
        .unwrap();
    assert_eq!(
        exemplar_states(&store),
        vec![
            ("keep.mbah".into(), "available".into()),
            ("x.mbah".into(), "available".into())
        ]
    );
}

/// Read-only corpus probe; CATALOGUE_PROFILE must contain COPIES of both bases.
/// Never starts recovery, downloads, cover work or a watcher on the real packs.
#[test]
#[ignore = "requires copied real catalogue bases in CATALOGUE_PROFILE"]
fn profile_startup_catalogue() {
    let base = PathBuf::from(std::env::var_os("CATALOGUE_PROFILE").expect("copied bases"));
    assert!(base.starts_with(std::env::temp_dir()));
    let data = base.join("data");
    let cache = base.join("cache");
    let store = Store::admit(&data, &cache).unwrap();
    let list = store.list_sources().unwrap();
    let exclusions = store.exclusions(&cache, &data).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    if std::env::var_os("CATALOGUE_PROFILE_CHECK_ONLY").is_some() {
        let events = startup_events(&store);
        let before = store.activity.snapshot();
        let started = Instant::now();
        for source in list
            .items
            .iter()
            .filter(|s| s.status == "active" && s.included_in.is_none())
        {
            let result = store
                .reconcile_source(
                    &super::refresh::Root {
                        source_id: source.id.clone(),
                        path: source.resolved_path.clone(),
                    },
                    &exclusions,
                    Duration::from_millis(20),
                    &cancel,
                    &|_| false,
                    &Registry::default(),
                )
                .unwrap();
            assert_eq!(result.analysed, 0, "{result:?}");
            assert!(!result.changed, "{result:?}");
        }
        assert!(events.lock().unwrap().is_empty());
        eprintln!(
            "PROFILE startup total={:.3}s activity={:?} events=0",
            started.elapsed().as_secs_f64(),
            delta(store.activity.snapshot(), before)
        );
        return;
    }
    let mut discovery = Duration::ZERO;
    let mut stats = Duration::ZERO;
    let mut reading = Duration::ZERO;
    let mut writes = Duration::ZERO;
    super::analyze::inventory_profile::NANOS.store(0, Ordering::Relaxed);
    let total = Instant::now();
    let mut files = 0;
    let mut observations = 0;
    for source in list
        .items
        .iter()
        .filter(|s| s.status == "active" && s.included_in.is_none())
    {
        let started = Instant::now();
        let found = super::walk::discover(&source.resolved_path, &exclusions, &cancel, |_, _| {});
        discovery += started.elapsed();
        assert!(found.complete, "incomplete corpus");
        let scopes = vec![(source.id.clone(), true)];
        let id = format!("profile-{}", uuid::Uuid::new_v4());
        for path in found.candidates {
            files += 1;
            let started = Instant::now();
            let initial = super::scan::token(&path);
            let _ = store.content_token(&path).unwrap();
            let _ = super::writes::file_id(&path);
            stats += started.elapsed();
            let started = Instant::now();
            let before_measurements = store.activity.measurements.load(Ordering::Relaxed);
            let items = store.observe_listening(&source.id, &path, &initial, &cancel);
            if store.activity.measurements.load(Ordering::Relaxed) != before_measurements {
                eprintln!("PROFILE remeasurement: {}", path.display());
            }
            reading += started.elapsed();
            observations += items.len();
            let started = Instant::now();
            store
                .publish_scan(&id, list.sources_revision, &items, &scopes)
                .unwrap();
            writes += started.elapsed();
            eprintln!(
                "profile {files}: {} ({:.3}s)",
                path.display(),
                reading.as_secs_f64()
            );
        }
        let started = Instant::now();
        store
            .finalize_scan(&id, list.sources_revision, &scopes)
            .unwrap();
        writes += started.elapsed();
    }
    eprintln!("PROFILE full total={:.3}s walk={:.3}s stat_identity={:.3}s observation={:.3}s writes={:.3}s files={files} exemplars={observations} analyses={} measurements={} solid={}", total.elapsed().as_secs_f64(), discovery.as_secs_f64(), stats.as_secs_f64(), reading.as_secs_f64(), writes.as_secs_f64(), store.activity.snapshot().analyses, store.activity.measurements.load(Ordering::Relaxed), store.activity.solid_passes.load(Ordering::Relaxed));
    eprintln!(
        "PROFILE archive_listing={:.3}s",
        super::analyze::inventory_profile::NANOS.load(Ordering::Relaxed) as f64 / 1e9
    );
    let before = store.activity.snapshot();
    let started = Instant::now();
    for source in list
        .items
        .iter()
        .filter(|s| s.status == "active" && s.included_in.is_none())
    {
        let result = store
            .reconcile_source(
                &super::refresh::Root {
                    source_id: source.id.clone(),
                    path: source.resolved_path.clone(),
                },
                &exclusions,
                Duration::from_millis(20),
                &cancel,
                &|_| false,
                &Registry::default(),
            )
            .unwrap();
        eprintln!("reconcile result={result:?}");
    }
    eprintln!(
        "PROFILE reconcile total={:.3}s activity={:?}",
        started.elapsed().as_secs_f64(),
        delta(store.activity.snapshot(), before)
    );
}

fn startup_events(store: &Store) -> Arc<std::sync::Mutex<Vec<(String, super::events::Progress)>>> {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    store
        .set_operation_sink(Arc::new(move |event, progress| {
            captured
                .lock()
                .unwrap()
                .push((event.to_owned(), progress.clone()));
        }))
        .unwrap();
    events
}

fn startup_check(f: &Fixture, store: &Store) -> super::refresh::Refreshed {
    let source = store
        .list_sources()
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.status == "active")
        .unwrap();
    store
        .reconcile_source(
            &super::refresh::Root {
                source_id: source.id,
                path: source.resolved_path,
            },
            &store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap(),
            Duration::ZERO,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| false,
            &Registry::default(),
        )
        .unwrap()
}

#[test]
fn startup_unchanged_opens_no_pack_and_publishes_no_operation() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.zip"), zip_bytes(UUID_A, "Archive")).unwrap();
    std::fs::write(f.root().join("b.mbah"), project(None, "Projet")).unwrap();
    std::fs::create_dir(f.root().join("directory")).unwrap();
    std::fs::write(
        f.root().join("directory/story.json"),
        json!({"title":"Dossier","stageNodes":[{"uuid":UUID_B,"squareOne":true}]}).to_string(),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    let before = store.activity.snapshot();
    let result = startup_check(&f, &store);
    assert!(!result.changed);
    assert_eq!(result.analysed, 0);
    // Every content reader is behind observe(), which increments analyses.
    assert_eq!(store.activity.snapshot().analyses, before.analyses);
    assert!(events.lock().unwrap().is_empty());
    assert!(store.scans.operations.lock().unwrap().is_empty());
}

#[test]
fn startup_only_analyses_additions_and_modifications_and_confirms_deletions() {
    let f = Fixture::new();
    std::fs::write(f.root().join("keep.zip"), zip_bytes(UUID_A, "Stable")).unwrap();
    std::fs::write(f.root().join("gone.zip"), zip_bytes(UUID_B, "Parti")).unwrap();
    std::fs::write(f.root().join("change.mbah"), project(None, "Avant")).unwrap();
    let store = f.open();
    f.scan(&store);
    std::fs::remove_file(f.root().join("gone.zip")).unwrap();
    std::fs::write(
        f.root().join("change.mbah"),
        project(None, "Après, titre plus long"),
    )
    .unwrap();
    std::fs::write(
        f.root().join("new.zip"),
        zip_bytes("5c0d3f7e-2b1a-4c6d-9e8f-333333333333", "Ajout"),
    )
    .unwrap();
    let events = startup_events(&store);
    let before = store.activity.snapshot();
    let result = startup_check(&f, &store);
    assert_eq!(result.analysed, 2);
    assert_eq!(result.missing, 1);
    assert_eq!(delta(store.activity.snapshot(), before).full_scans, 0);
    assert!(titles(&store).contains(&"Ajout".to_owned()));
    assert!(titles(&store).contains(&"Après, titre plus long".to_owned()));
    let terminal = events.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(terminal.status, "success");
    assert_eq!(terminal.candidates.discovered, 3);
    assert_eq!(terminal.candidates.processed, 3);
    assert!(!terminal
        .report
        .iter()
        .any(|item| item.path.ends_with("keep.zip")));
    let expected = exemplar_states(&store);
    f.scan(&store);
    assert_eq!(
        exemplar_states(&store),
        expected,
        "same missing states as a full scan"
    );
}

#[test]
fn startup_disconnected_source_is_unavailable_never_deleted() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.zip"), zip_bytes(UUID_A, "Débranché")).unwrap();
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    std::fs::rename(f.root(), f.0.join("detached")).unwrap();
    let before = store.activity.snapshot();
    let result = startup_check(&f, &store);
    assert_eq!(result.missing, 0);
    assert_eq!(store.activity.snapshot().analyses, before.analyses);
    assert_eq!(
        exemplar_states(&store),
        vec![("a.zip".into(), "unavailable".into())]
    );
    assert_eq!(events.lock().unwrap().last().unwrap().1.status, "partial");
}

#[test]
fn startup_exclusions_and_first_indexing_with_a_visible_report() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.root().join("workspace/sauvegardes/versions-securite")).unwrap();
    std::fs::create_dir_all(f.root().join("workspace/voix-generees")).unwrap();
    for name in [
        "workspace/sauvegardes/versions-securite/hidden.mbah",
        "workspace/voix-generees/hidden.mbah",
        "keep.mbah",
    ] {
        std::fs::write(f.root().join(name), project(None, name)).unwrap();
    }
    let store = f.open();
    let events = startup_events(&store);
    let result = startup_check(&f, &store);
    assert_eq!(
        result.analysed, 1,
        "first indexing after a missing cache also uses the shared refresh"
    );
    assert_eq!(
        exemplar_states(&store),
        vec![("keep.mbah".into(), "available".into())]
    );
    assert_eq!(events.lock().unwrap().last().unwrap().1.status, "success");
    store.scans.operations.lock().unwrap().clear();
    events.lock().unwrap().clear();
    assert_eq!(startup_check(&f, &store).analysed, 0);
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn startup_detects_date_only_change_and_same_stat_replacement() {
    let f = Fixture::new();
    let path = f.root().join("a.zip");
    let bytes = zip_bytes(UUID_A, "Identité");
    std::fs::write(&path, &bytes).unwrap();
    let store = f.open();
    f.scan(&store);
    startup_events(&store);
    let date = std::fs::metadata(&path).unwrap().modified().unwrap() + Duration::from_secs(2);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(date)
        .unwrap();
    assert_eq!(startup_check(&f, &store).analysed, 1, "mtime only");
    std::fs::rename(&path, f.root().join("old.backup")).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(date)
        .unwrap();
    assert_eq!(
        startup_check(&f, &store).analysed,
        1,
        "same size/date, different native identity"
    );
}

#[test]
fn startup_empty_mount_is_a_reported_problem_not_a_deletion() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.zip"), zip_bytes(UUID_A, "Débranché")).unwrap();
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    std::fs::rename(f.root(), f.0.join("detached")).unwrap();
    std::fs::create_dir(f.0.join("source")).unwrap();
    assert_eq!(startup_check(&f, &store).missing, 0);
    assert_eq!(
        exemplar_states(&store),
        vec![("a.zip".into(), "unavailable".into())]
    );
    assert_eq!(events.lock().unwrap().last().unwrap().1.status, "partial");
    events.lock().unwrap().clear();
    startup_check(&f, &store);
    assert!(
        events.lock().unwrap().is_empty(),
        "same problem is not republished every pass"
    );
}

#[test]
fn startup_incomplete_inventory_reports_problem_and_preserves_unvisited_packs() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.root().join("ordinary/voix-generees")).unwrap();
    std::fs::write(
        f.root().join("ordinary/voix-generees/a.mbah"),
        project(None, "Conservé"),
    )
    .unwrap();
    let store = f.open();
    f.scan(&store);
    let expected = exemplar_states(&store);
    let events = startup_events(&store);
    let rules = store
        .exclusions(&f.0.join("cache"), &f.0.join("data"))
        .unwrap();
    // An inconclusive structural probe leaves this subtree unvisited.
    rules
        .workspace_shapes
        .lock()
        .unwrap()
        .insert(f.root().join("ordinary"), None);
    let unvisited = f.root().join("ordinary/voix-generees/a.mbah");
    assert!(rules.classify(&unvisited, Some(&unvisited)).is_err());
    let source = store.list_sources().unwrap().items.remove(0);
    let check = || {
        store
            .reconcile_source(
                &super::refresh::Root {
                    source_id: source.id.clone(),
                    path: source.resolved_path.clone(),
                },
                &rules,
                Duration::ZERO,
                &std::sync::atomic::AtomicBool::new(false),
                &|_| false,
                &Registry::default(),
            )
            .unwrap()
    };
    let result = check();
    assert_eq!(result.missing, 0);
    assert_eq!(result.analysed, 0);
    assert_eq!(exemplar_states(&store), expected);
    let terminal = events.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(terminal.status, "partial");
    assert!(!terminal.scan_complete);
    assert!(terminal
        .report
        .iter()
        .any(|item| item.outcome == "scopeError"));
    events.lock().unwrap().clear();
    check();
    assert!(
        events.lock().unwrap().is_empty(),
        "permanent error reported once"
    );
    assert_eq!(store.scans.operations.lock().unwrap().len(), 1);

    std::fs::create_dir_all(f.root().join("another/voix-generees")).unwrap();
    rules
        .workspace_shapes
        .lock()
        .unwrap()
        .insert(f.root().join("another"), None);
    check();
    assert_eq!(store.scans.operations.lock().unwrap().len(), 2);
    assert_eq!(
        events.lock().unwrap().last().unwrap().1.directories.errors,
        2
    );
    events.lock().unwrap().clear();
    std::fs::write(f.root().join("new.mbah"), project(None, "Ajout")).unwrap();
    assert_eq!(check().analysed, 1);
    assert_eq!(
        events.lock().unwrap().last().unwrap().1.directories.errors,
        2,
        "unchanged scope errors accompany a real change"
    );
}

#[test]
fn startup_outdated_listening_is_measured_then_skipped() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.mbah"), project(None, "Version")).unwrap();
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    store.write(|tx| {
        tx.execute(
            "UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.listeningVersion',?1)",
            [i64::from(super::analyze::LISTENING_VERSION) - 1],
        ).map_err(super::store::error)?;
        Ok(())
    }).unwrap();
    let before = store.activity.measurements.load(Ordering::Relaxed);
    assert_eq!(startup_check(&f, &store).analysed, 1);
    assert_eq!(
        store.activity.measurements.load(Ordering::Relaxed),
        before + 1
    );
    assert!(!events.lock().unwrap().is_empty());
    events.lock().unwrap().clear();
    let before = store.activity.snapshot();
    assert_eq!(startup_check(&f, &store).analysed, 0);
    assert_eq!(store.activity.snapshot().analyses, before.analyses);
    assert!(events.lock().unwrap().is_empty());
}

/// A directory chain one level past the walk's depth limit, under `base`.
fn too_deep(base: &Path) -> PathBuf {
    let mut path = base.to_owned();
    for _ in 0..=super::walk::MAX_DEPTH {
        path.push("d");
    }
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn reconcile_with(
    f: &Fixture,
    store: &Store,
    stability: Duration,
    registry: &Registry,
) -> super::refresh::Refreshed {
    let source = store.list_sources().unwrap().items.remove(0);
    store
        .reconcile_source(
            &super::refresh::Root {
                source_id: source.id,
                path: source.resolved_path,
            },
            &store
                .exclusions(&f.0.join("cache"), &f.0.join("data"))
                .unwrap(),
            stability,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| false,
            registry,
        )
        .unwrap()
}

#[test]
fn startup_scope_errors_survive_restart_and_ignore_walk_order() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.mbah"), project(None, "Profond")).unwrap();
    let deepest = too_deep(&f.root());
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    startup_check(&f, &store);
    assert_eq!(
        store.scans.operations.lock().unwrap().len(),
        1,
        "a permanent error is reported once"
    );
    events.lock().unwrap().clear();
    startup_check(&f, &store);
    assert!(events.lock().unwrap().is_empty());
    drop(events);
    drop(store);

    // Restart: a new store on the same database remembers the fingerprint.
    let store = Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap();
    let events = startup_events(&store);
    startup_check(&f, &store);
    assert!(
        events.lock().unwrap().is_empty(),
        "same error after restart"
    );
    // Non-pack files change the walk's stopping entry and count, not the error.
    std::fs::write(deepest.parent().unwrap().join("note.txt"), b"x").unwrap();
    std::fs::write(f.root().join("note.txt"), b"x").unwrap();
    startup_check(&f, &store);
    assert!(events.lock().unwrap().is_empty(), "non-pack file added");

    // Resolved: published once, then quiet.
    std::fs::remove_dir_all(f.root().join("d")).unwrap();
    startup_check(&f, &store);
    assert_eq!(store.scans.operations.lock().unwrap().len(), 1);
    let terminal = events.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(terminal.status, "success");
    assert_eq!(terminal.directories.errors, 0);
    events.lock().unwrap().clear();
    startup_check(&f, &store);
    assert!(events.lock().unwrap().is_empty());

    // New again: published.
    too_deep(&f.root());
    startup_check(&f, &store);
    assert_eq!(store.scans.operations.lock().unwrap().len(), 2);
    assert_eq!(events.lock().unwrap().last().unwrap().1.status, "partial");
}

#[test]
fn startup_scope_errors_after_migration_from_v7_are_reported_once() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.mbah"), project(None, "Migré")).unwrap();
    too_deep(&f.root());
    let store = f.open();
    f.scan(&store);
    drop(store);
    // Bring the durable database back to v7, before the fingerprint column.
    {
        let c = rusqlite::Connection::open(f.0.join("data/catalogue/catalogue.sqlite")).unwrap();
        c.execute_batch(
            "ALTER TABLE source_health DROP COLUMN scope_errors_fingerprint;
             DELETE FROM migration WHERE version>=8; PRAGMA user_version=7;",
        )
        .unwrap();
    }
    let store = Store::open(&f.0.join("data"), &f.0.join("cache")).unwrap();
    assert_eq!(
        store
            .read(|c| c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        10
    );
    let stored = || {
        store
            .read(|c| {
                c.query_row(
                    "SELECT scope_errors_fingerprint FROM source_health",
                    [],
                    |r| r.get::<_, Option<String>>(0),
                )
            })
            .unwrap()
    };
    assert_eq!(stored(), None, "existing row: never recorded");
    let events = startup_events(&store);
    startup_check(&f, &store);
    assert_eq!(store.scans.operations.lock().unwrap().len(), 1);
    assert!(stored().is_some());
    events.lock().unwrap().clear();
    startup_check(&f, &store);
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn startup_without_scope_errors_stays_quiet_on_first_check() {
    let f = Fixture::new();
    std::fs::write(f.root().join("a.mbah"), project(None, "Sain")).unwrap();
    let store = f.open();
    f.scan(&store);
    let events = startup_events(&store);
    startup_check(&f, &store);
    assert!(
        events.lock().unwrap().is_empty(),
        "NULL and no error: quiet"
    );
}

#[test]
fn scope_error_fingerprint_keeps_only_path_and_reason() {
    use super::walk::ScopeError;
    let error = |path: &str, reason: &'static str, detail: &str| ScopeError {
        path: PathBuf::from(path),
        reason,
        detail: detail.into(),
    };
    let fingerprint = super::refresh::scope_errors_fingerprint;
    assert_eq!(
        fingerprint(&[error("/s/a", "itemLimitExceeded", "depth 3, items 100001")]),
        fingerprint(&[error(
            "/s/b/c.txt",
            "itemLimitExceeded",
            "depth 5, items 100001"
        )]),
    );
    assert_eq!(
        fingerprint(&[error("/s/x", "accessDenied", "os error 13")]),
        fingerprint(&[error("/s/x", "accessDenied", "Permission denied")]),
    );
    assert_ne!(
        fingerprint(&[error("/s/x", "accessDenied", "")]),
        fingerprint(&[error("/s/y", "accessDenied", "")]),
    );
    assert_ne!(
        fingerprint(&[]),
        fingerprint(&[error("/s/x", "accessDenied", "")])
    );
}

#[test]
fn startup_pack_vanishing_during_stability_wait_is_reported_once() {
    let f = Fixture::new();
    let path = f.root().join("change.mbah");
    std::fs::write(&path, project(None, "Avant")).unwrap();
    std::fs::write(f.root().join("keep.mbah"), project(None, "Reste")).unwrap();
    let store = f.open();
    f.scan(&store);
    std::fs::write(&path, project(None, "Après, titre plus long")).unwrap();
    let events = startup_events(&store);
    let remover = {
        let path = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            std::fs::remove_file(path).unwrap();
        })
    };
    let result = reconcile_with(&f, &store, Duration::from_millis(800), &Registry::default());
    remover.join().unwrap();
    assert_eq!(result.missing, 1);
    let terminal = events.lock().unwrap().last().unwrap().1.clone();
    let lines: Vec<_> = terminal
        .report
        .iter()
        .filter(|item| item.path.ends_with("change.mbah"))
        .map(|item| (item.outcome.clone(), item.reason.clone()))
        .collect();
    assert_eq!(
        lines,
        vec![("removed".to_owned(), Some("fileDisappeared".to_owned()))]
    );
    assert_eq!(terminal.outcomes.removed, 1);
    assert_eq!(terminal.outcomes.updated, 0);
    assert_eq!(terminal.candidates.processed, 1);
    assert_eq!(terminal.outcomes.error, 0);
    assert_eq!(terminal.outcomes.not_processed, 0);
    assert_eq!(terminal.candidates.discovered, 1);
}

#[test]
fn startup_removal_held_by_a_write_is_not_counted_as_unprocessed() {
    let f = Fixture::new();
    std::fs::write(f.root().join("gone.zip"), zip_bytes(UUID_A, "Parti")).unwrap();
    std::fs::write(f.root().join("held.zip"), zip_bytes(UUID_B, "Tenu")).unwrap();
    // A remaining pack: a source emptied entirely is an unmounted volume.
    std::fs::write(f.root().join("keep.mbah"), project(None, "Reste")).unwrap();
    let store = f.open();
    f.scan(&store);
    std::fs::remove_file(f.root().join("gone.zip")).unwrap();
    std::fs::remove_file(f.root().join("held.zip")).unwrap();
    let registry = Registry::default();
    let _write = registry.begin(Declaration::new("generation").exact(f.root().join("held.zip")));
    let events = startup_events(&store);
    let result = reconcile_with(&f, &store, Duration::ZERO, &registry);
    assert_eq!(result.missing, 1);
    let terminal = events.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(terminal.outcomes.removed, 1);
    assert_eq!(terminal.outcomes.updated, 0);
    assert_eq!(terminal.candidates.processed, 1);
    assert_eq!(terminal.candidates.discovered, 1);
    assert_eq!(terminal.outcomes.not_processed, 0);
    assert_eq!(terminal.status, "success");
}
