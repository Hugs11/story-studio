//! Entry page contract read by the interface: fields used by search, sorting
//! and filters, the hand-written fixture shared with the JavaScript adapter,
//! and the expired cursor code.
use super::*;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("catalogue-entries-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        Self(root)
    }
    fn root(&self) -> PathBuf {
        self.0.join("source")
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn open(&self) -> Arc<store::Store> {
        Arc::new(store::Store::open(&self.data(), &self.0.join("cache")).unwrap())
    }
    fn scan(&self, store: &Arc<store::Store>) {
        let receipt = store
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                store.list_sources().unwrap().sources_revision,
                self.0.join("cache"),
                self.data(),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        let start = Instant::now();
        loop {
            let p = store.get_operation(&receipt.operation_id).unwrap();
            if !matches!(p.status.as_str(), "queued" | "running" | "cancelling") {
                assert_eq!(
                    p.status,
                    "success",
                    "{}",
                    serde_json::to_string(&p).unwrap()
                );
                return;
            }
            assert!(start.elapsed() < Duration::from_secs(20));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const ID: &str = "bda17862-0d71-41f6-974a-333333333333";

fn zip_with(files: &[(&str, Value)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, value) in files {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(value.to_string().as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
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

/// One project with full metadata, a multipack ZIP (two children) and a
/// STUdio folder sharing the project UUID.
fn populate(root: &Path) {
    std::fs::write(
        root.join("lune.mbah"),
        json!({"packMetadata": {
            "uuid": ID, "title": "La Lune", "minAge": 3, "version": 4,
            "description": "Une histoire douce", "author": "Camille"
        }})
        .to_string(),
    )
    .unwrap();
    // The project is the most recently modified exemplar: the card's
    // reference, whose values the card publishes.
    std::fs::File::options()
        .write(true)
        .open(root.join("lune.mbah"))
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(4_000_000_000)),
        )
        .unwrap();
    std::fs::create_dir(root.join("Lune")).unwrap();
    std::fs::write(
        root.join("Lune/story.json"),
        json!({"title": "La Lune", "version": 2, "stageNodes": [{"uuid": ID, "squareOne": true}]})
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        root.join("compilation.zip"),
        zip_with(&[
            (
                "5+ours/story.json",
                json!({"title": "Ours", "description": ""}),
            ),
            ("chat/story.json", json!({"title": "Chat", "version": "x"})),
        ]),
    )
    .unwrap();
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Same keys, and the same JSON type wherever both sides carry a value
/// (a field documented as nullable may be null on either side).
fn assert_same_shape(context: &str, expected: &Value, actual: &Value) {
    let (Some(expected), Some(actual)) = (expected.as_object(), actual.as_object()) else {
        panic!("{context}: object expected");
    };
    let mut wanted: Vec<_> = expected.keys().collect();
    let mut got: Vec<_> = actual.keys().collect();
    wanted.sort();
    got.sort();
    assert_eq!(wanted, got, "{context}: keys");
    for (key, value) in expected {
        let other = &actual[key];
        if !value.is_null() && !other.is_null() {
            assert_eq!(kind(value), kind(other), "{context}.{key}: type");
        }
    }
}

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/fixtures/catalogue/entries-page.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn entry_page_matches_the_hand_written_contract_fixture() {
    let f = Fixture::new();
    populate(&f.root());
    let store = f.open();
    store.add_source(&f.root(), 0, false).unwrap();
    f.scan(&store);
    let page = serde_json::to_value(store.query_entries(2, None, true).unwrap()).unwrap();
    let expected = fixture();
    assert_same_shape("page", &expected, &page);
    let expected_item = &expected["items"][0];
    let expected_exemplar = &expected_item["exemplars"][0];
    let all = serde_json::to_value(store.query_entries(200, None, true).unwrap()).unwrap();
    for item in all["items"].as_array().unwrap() {
        assert_same_shape("item", expected_item, item);
        for exemplar in item["exemplars"].as_array().unwrap() {
            let contract = if exemplar["format"] == "project" {
                expected["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|item| item["exemplars"].as_array().unwrap())
                    .find(|e| e["format"] == "project")
                    .unwrap()
            } else {
                expected_exemplar
            };
            assert_same_shape("exemplar", contract, exemplar);
            if exemplar["format"] == "project" {
                assert_eq!(exemplar["generation"], json!({"state":"unknown"}));
            }
        }
    }
    // Every documented nullable field is seen with a value at least once in
    // the fixture, so the type comparison is never vacuous on that side.
    let items = expected["items"].as_array().unwrap();
    let exemplars: Vec<_> = items
        .iter()
        .flat_map(|item| item["exemplars"].as_array().unwrap())
        .collect();
    for key in ["addedAt", "sizeBytes", "versionDeclared", "container"] {
        assert!(
            exemplars.iter().any(|e| !e[key].is_null()),
            "fixture {key} needs a value"
        );
    }
    for key in ["description", "author", "ageFromName", "pendingConvergence"] {
        assert!(items.iter().any(|i| !i[key].is_null()), "fixture {key}");
    }
}

#[test]
fn entries_publish_dates_sizes_sources_versions_and_containers() {
    let f = Fixture::new();
    populate(&f.root());
    let before = snapshot(&f.root());
    let store = f.open();
    let source = store.add_source(&f.root(), 0, false).unwrap().source_id;
    f.scan(&store);
    let page = store.query_entries(200, None, false).unwrap();
    assert_eq!(page.items.len(), 3);
    let by_title = |title: &str| {
        page.items
            .iter()
            .find(|i| i["values"]["title"] == title)
            .unwrap()
            .clone()
    };

    let lune = by_title("La Lune");
    assert!(lune["addedAt"].as_i64().unwrap() > 0);
    assert_eq!(lune["description"], "Une histoire douce");
    assert_eq!(lune["author"], "Camille");
    assert_eq!(lune["values"]["description"], "Une histoire douce");
    // DUREE: an unclassifiable project stays unknown, never a fabricated zero.
    assert!(lune["storyCount"].is_null());
    assert!(lune["values"]["storyCount"].is_null());
    for key in ["language", "durationSeconds"] {
        assert!(lune[key].is_null(), "{key} is never invented");
    }
    let exemplars = lune["exemplars"].as_array().unwrap();
    assert_eq!(exemplars.len(), 2);
    for exemplar in exemplars {
        assert_eq!(exemplar["availability"], "available");
        assert_eq!(exemplar["sourceIds"], json!([source]));
        assert!(exemplar["addedAt"].as_i64().unwrap() > 0);
        assert!(exemplar["container"].is_null());
        match exemplar["format"].as_str().unwrap() {
            "project" => {
                let size = std::fs::metadata(f.root().join("lune.mbah")).unwrap().len();
                assert_eq!(exemplar["sizeBytes"], json!(size));
                assert_eq!(exemplar["versionDeclared"], 4);
            }
            "studioDirectory" => {
                assert!(exemplar["sizeBytes"].is_null(), "no folder entry size");
                assert_eq!(exemplar["versionDeclared"], 2);
            }
            other => panic!("unexpected format {other}"),
        }
    }

    // Archive children: the container path, never the whole archive's size;
    // an empty description or a mistyped version stays absent.
    for title in ["Ours", "Chat"] {
        let card = by_title(title);
        assert!(card["description"].is_null());
        assert!(card["author"].is_null());
        let exemplar = &card["exemplars"][0];
        assert_eq!(exemplar["container"]["path"], exemplar["locator"]["path"]);
        assert!(exemplar["container"]["path"]
            .as_str()
            .unwrap()
            .ends_with("compilation.zip"));
        assert!(exemplar["sizeBytes"].is_null());
        assert!(exemplar["versionDeclared"].is_null());
    }
    assert_eq!(by_title("Ours")["ageFromName"], 5);

    // Confirmed source removal erases cards, without touching any source bytes.
    let revision = store.list_sources().unwrap().sources_revision;
    store.remove_source(&source, revision).unwrap();
    assert!(store
        .query_entries(200, None, true)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(snapshot(&f.root()), before, "source bytes unchanged");
}

#[test]
fn a_cursor_of_an_older_revision_is_refused_with_its_own_code() {
    let f = Fixture::new();
    populate(&f.root());
    let store = f.open();
    store.add_source(&f.root(), 0, false).unwrap();
    f.scan(&store);
    let cursor = store.query_entries(1, None, false).unwrap().cursor.unwrap();
    f.scan(&store);
    // A no-op scan preserves cursors; a real catalogue change expires them.
    assert!(store.query_entries(1, Some(&cursor), false).is_ok());
    std::fs::write(
        f.root().join("additional.mbah"),
        json!({"packMetadata":{"title":"Additional pack"}}).to_string(),
    )
    .unwrap();
    f.scan(&store);
    let error = store.query_entries(1, Some(&cursor), false).err().unwrap();
    assert_eq!(error.code, "CATALOG_ENTRIES_CURSOR_EXPIRED");
    let error = store
        .query_entries(2, Some("garbage"), false)
        .err()
        .unwrap();
    assert_eq!(error.code, "CATALOG_ENTRIES_CURSOR_EXPIRED");
}

/// `official` is the send gate's decision, read from the same stored data:
/// the observed identity UUID (here declared official by the downloaded Lunii
/// base, as no real official UUID may appear in tests) and, for a project, its
/// recorded provenance. A creation stays false.
#[test]
fn entries_publish_the_send_gate_official_decision() {
    const OFFICIAL: &str = "00000000-0000-4000-8000-0000000000f1";
    const CREATION: &str = "00000000-0000-4000-8000-0000000000c1";
    const RECORDED: &str = "00000000-0000-4000-8000-0000000000e1";
    let f = Fixture::new();
    let folder = |name: &str, uuid: &str| {
        std::fs::create_dir(f.root().join(name)).unwrap();
        std::fs::write(
            f.root().join(name).join("story.json"),
            json!({"title": name, "stageNodes": [{"uuid": uuid, "squareOne": true}]}).to_string(),
        )
        .unwrap();
    };
    folder("Officielle", OFFICIAL);
    folder("Creation", CREATION);
    std::fs::write(
        f.root().join("importee.mbah"),
        json!({"officialProvenance": "official", "packMetadata": {"uuid": RECORDED, "title": "Importee"}})
            .to_string(),
    )
    .unwrap();
    let store = f.open();
    store.add_source(&f.root(), 0, false).unwrap();
    f.scan(&store);
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,'{}')",
                [OFFICIAL],
            )
            .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    let page = store.query_entries(200, None, true).unwrap();
    let by_uuid = |uuid: &str| {
        page.items
            .iter()
            .find(|i| i["exemplars"][0]["observation"]["identity"]["value"].as_str() == Some(uuid))
            .unwrap()
            .clone()
    };
    for (uuid, expected) in [(OFFICIAL, true), (CREATION, false), (RECORDED, true)] {
        let card = by_uuid(uuid);
        assert_eq!(card["official"], expected, "card {uuid}");
        let exemplar = &card["exemplars"][0];
        assert_eq!(exemplar["official"], expected, "exemplar {uuid}");
        // The send gate reads the revalidated target with the store as catalogue.
        let target = store
            .resolve_target(exemplar["id"].as_str().unwrap(), page.catalogue_revision)
            .unwrap();
        let gate = observed_official(&target.observation.unwrap().raw, Some(&*store));
        assert_eq!(gate, expected, "send gate {uuid}");
    }
    // Without the downloaded base, the same UUID is a creation again (D4, D25).
    store
        .write(|tx| {
            tx.execute("DELETE FROM lunii_pack", [])
                .map_err(store::error)?;
            Ok(())
        })
        .unwrap();
    let page = store.query_entries(200, None, true).unwrap();
    let card = page
        .items
        .iter()
        .find(|i| i["exemplars"][0]["observation"]["identity"]["value"] == OFFICIAL)
        .unwrap();
    assert_eq!(card["official"], false);
}
