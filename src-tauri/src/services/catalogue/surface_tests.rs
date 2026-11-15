//! UI contracts: independent fixture, proposal transitions, reports and retries.
use super::*;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("catalogue-surface-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.join("source")).unwrap();
        let path: std::path::PathBuf =
            crate::support::paths::path_for_frontend(path.canonicalize().unwrap()).into();
        Self(path)
    }
    fn store(&self) -> Arc<store::Store> {
        Arc::new(store::Store::open(&self.0.join("data"), &self.0.join("cache")).unwrap())
    }
    fn wait(&self, store: &store::Store, id: &str) -> events::Progress {
        let deadline = Instant::now() + crate::test_support::timeout();
        loop {
            let p = store.get_operation(id).unwrap();
            if !matches!(p.status.as_str(), "running" | "queued" | "cancelling") {
                return p;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn source_contract_is_durable() {
    let f = Fixture::new();
    let store = f.store();
    std::fs::create_dir_all(f.0.join("first/exports")).unwrap();
    store
        .remember_workspace(Some(f.0.join("first").to_str().unwrap()))
        .unwrap();
    let list = store.list_sources().unwrap();
    let exports = list
        .items
        .iter()
        .find(|s| s.status == "active" && s.path.ends_with("exports"))
        .unwrap();
    let id = exports.id.clone();
    store
        .add_source(&exports.native_path, list.sources_revision)
        .unwrap();
    drop(store);
    let store = f.store();
    let list = store.list_sources().unwrap();
    let actual = serde_json::to_value(list.items.iter().find(|s| s.id == id).unwrap()).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/catalogue/source.json"
    ))
    .unwrap();
    for (key, expected) in fixture.as_object().unwrap() {
        assert!(actual.get(key).is_some(), "missing {key}");
        assert_eq!(
            std::mem::discriminant(&actual[key]),
            std::mem::discriminant(expected),
            "type {key}"
        );
    }
    assert_eq!(actual["availability"], "available");
    assert!(actual["lastScanAt"].is_null());
}
#[test]
fn recent_operations_and_retry_leave_sources_intact() {
    let f = Fixture::new();
    let store = f.store();
    let root = f.0.join("source");
    let path = root.join("broken.zip");
    std::fs::write(&path, b"corrupt zip").unwrap();
    let source = store.add_source(&root, 0).unwrap();
    let scan = store
        .start_scan(
            None,
            "first".into(),
            source.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let progress = f.wait(&store, &scan.operation_id);
    let operations = store.list_operations(200).unwrap();
    assert_eq!(operations.items.len(), 1);
    assert_eq!(operations.items[0].status, progress.status);
    assert_eq!(operations.items[0].scan_complete, progress.scan_complete);
    let list = store.list_sources().unwrap();
    assert!(list.items[0].last_scan_at.is_some());
    assert_eq!(list.items[0].last_scan_status.as_deref(), Some("success"));
    assert!(!list.items[0].scanning);
    let actual = serde_json::to_value(&operations).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/catalogue/operations.json"
    ))
    .unwrap();
    for (key, value) in fixture["items"][0].as_object().unwrap() {
        assert_eq!(
            std::mem::discriminant(&actual["items"][0][key]),
            std::mem::discriminant(value),
            "type {key}"
        );
    }
    let retry = store
        .start_scan_paths(
            None,
            Some(vec![path.to_string_lossy().into_owned()]),
            "retry".into(),
            source.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_ne!(scan.operation_id, retry.operation_id);
    f.wait(&store, &retry.operation_id);
    assert_eq!(
        store.list_operations(1).unwrap().items[0].operation_id,
        retry.operation_id
    );
    assert_eq!(std::fs::read(path).unwrap(), b"corrupt zip");
    let error = store
        .start_scan_paths(
            None,
            Some(vec![f
                .0
                .join("elsewhere.zip")
                .to_string_lossy()
                .into_owned()]),
            "invalid".into(),
            source.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "CATALOG_SOURCE_UNAVAILABLE");
}
#[test]
fn a_successful_source_keeps_its_date_when_another_root_fails() {
    let f = Fixture::new();
    let store = f.store();
    let good = f.0.join("source");
    let first = store.add_source(&good, 0).unwrap();
    let missing = f.0.join("missing");
    std::fs::create_dir(&missing).unwrap();
    let second = store.add_source(&missing, first.sources_revision).unwrap();
    std::fs::remove_dir(&missing).unwrap();
    let scan = store
        .start_scan(
            None,
            "mixed".into(),
            second.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_eq!(f.wait(&store, &scan.operation_id).status, "partial");
    let list = store.list_sources().unwrap();
    let healthy = list.items.iter().find(|s| s.id == first.source_id).unwrap();
    let offline = list
        .items
        .iter()
        .find(|s| s.id == second.source_id)
        .unwrap();
    assert!(healthy.last_scan_at.is_some());
    assert_eq!(healthy.last_scan_status.as_deref(), Some("success"));
    assert_eq!(offline.availability, "unavailable");
    assert!(offline.last_scan_at.is_none());
}
#[test]
fn nested_sources_share_counts_and_selected_scan_state() {
    let f = Fixture::new();
    let store = f.store();
    let root = f.0.join("source");
    let child = root.join("nested");
    let other = f.0.join("other");
    std::fs::create_dir(&child).unwrap();
    std::fs::create_dir(&other).unwrap();
    let parent = store.add_source(&root, 0).unwrap();
    let nested = store.add_source(&child, parent.sources_revision).unwrap();
    let outside = store.add_source(&other, nested.sources_revision).unwrap();
    std::fs::write(
        child.join("a.mbah"),
        r#"{"packMetadata":{"uuid":"5c0d3f7e-2b1a-4c6d-9e8f-111111111111","title":"A"}}"#,
    )
    .unwrap();
    let _heavy = store.scans.heavy.lock().unwrap();
    let scan = store
        .start_scan(
            Some(vec![parent.source_id.clone()]),
            "selected".into(),
            outside.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let list = store.list_sources().unwrap();
    assert!(list.scanning);
    assert!(
        list.items
            .iter()
            .find(|s| s.id == parent.source_id)
            .unwrap()
            .scanning
    );
    assert!(
        list.items
            .iter()
            .find(|s| s.id == nested.source_id)
            .unwrap()
            .scanning
    );
    assert!(
        !list
            .items
            .iter()
            .find(|s| s.id == outside.source_id)
            .unwrap()
            .scanning
    );
    drop(_heavy);
    f.wait(&store, &scan.operation_id);
    let list = store.list_sources().unwrap();
    assert_eq!(list.exemplar_count, 1);
    assert_eq!(
        list.items
            .iter()
            .find(|s| s.id == parent.source_id)
            .unwrap()
            .exemplar_count,
        1
    );
    let child = list
        .items
        .iter()
        .find(|s| s.id == nested.source_id)
        .unwrap();
    assert_eq!(child.exemplar_count, 1);
    assert_eq!(
        child.included_in.as_deref(),
        Some(parent.source_id.as_str())
    );
}
#[test]
fn listing_reports_the_last_recorded_access_without_probing_the_disk() {
    let f = Fixture::new();
    let store = f.store();
    let root = f.0.join("removable");
    std::fs::create_dir(&root).unwrap();
    let added = store.add_source(&root, 0).unwrap();
    std::fs::remove_dir(&root).unwrap();
    // A dead mount must not block the listing: only scans and the watcher
    // probe the volume, in the background.
    let list = store.list_sources().unwrap();
    let source = list.items.iter().find(|s| s.id == added.source_id).unwrap();
    assert_eq!(source.availability, "available");
    let scan = store
        .start_scan(
            None,
            "offline".into(),
            list.sources_revision,
            f.0.join("cache"),
            f.0.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    f.wait(&store, &scan.operation_id);
    let list = store.list_sources().unwrap();
    let source = list.items.iter().find(|s| s.id == added.source_id).unwrap();
    assert_eq!(source.availability, "unavailable");
}
