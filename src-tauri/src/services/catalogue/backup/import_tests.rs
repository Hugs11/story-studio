use super::import::{ApplyImport, Prepared};
use super::*;
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Fixture {
    root: PathBuf,
    store: Arc<Store>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("catalogue-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root: std::path::PathBuf =
            crate::support::paths::path_for_frontend(root.canonicalize().unwrap()).into();
        let store = Arc::new(Store::open(&root.join("data"), &root.join("cache")).unwrap());
        Self { root, store }
    }
    fn document() -> Value {
        serde_json::from_str::<Value>(include_str!(
            "../../../../../scripts/fixtures/catalogue/backup-export.json"
        ))
        .unwrap()["catalogue"]
            .clone()
    }
    fn archive(&self, doc: &Value) -> PathBuf {
        let path = self.root.join(format!("{}.zip", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(doc).unwrap();
        let manifest = format::Manifest {
            format: format::FORMAT.into(),
            format_version: 1,
            schema: format::SCHEMA.into(),
            backup_id: uuid::Uuid::new_v4().to_string(),
            origin_catalogue_id: doc["originCatalogueId"].as_str().unwrap().into(),
            catalogue_revision: doc["catalogueRevision"].as_i64().unwrap(),
            counts: format::Counts {
                cards: doc["cards"].as_array().unwrap().len(),
                tags: doc["tags"].as_array().unwrap().len(),
                images: 0,
            },
            entries: BTreeMap::from([("catalogue.json".into(), validate::payload(&bytes))]),
        };
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.start_file("catalogue.json", options).unwrap();
        zip.write_all(&bytes).unwrap();
        zip.finish().unwrap();
        path
    }
    fn prepare(&self, path: &std::path::Path) -> Result<Prepared> {
        let staged = staging::prepare(&self.store, path, &AtomicBool::new(false))?;
        let plan = self
            .store
            .write(|tx| matching::plan(tx, &staged, "preview", &BTreeMap::new()))?;
        Ok(Prepared {
            staged,
            plan,
            source: path.into(),
            created: Instant::now(),
            associations: BTreeMap::new(),
        })
    }
    fn apply(&self, p: &Prepared, choices: BTreeMap<String, String>) -> Result<Value> {
        let (_, op) = self.store.begin_file_report(
            &uuid::Uuid::new_v4().to_string(),
            "catalogueImport",
            1,
            Arc::new(|_, _| {}),
        )?;
        let result = super::merge::apply(
            &self.store,
            p,
            &ApplyImport {
                preview_id: "preview".into(),
                choices,
                associations: p.associations.clone(),
                expected_catalogue_revision: p.plan.preview.expected_catalogue_revision,
                request_id: uuid::Uuid::new_v4().to_string(),
            },
            &op,
        );
        if result.is_ok() {
            let unused = self.store.read(|c| c.query_row("SELECT count(*) FROM tag WHERE NOT EXISTS(SELECT 1 FROM tag_member WHERE tag_id=tag.id)", [], |r| r.get::<_, i64>(0))).unwrap();
            assert_eq!(
                unused, 0,
                "every import and reconciliation prunes unused tags"
            );
        }
        result
    }
    fn count(&self, table: &str) -> i64 {
        self.store
            .read(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
            .unwrap()
    }
    fn local(&self) {
        self.store.write(|tx| {
  tx.execute_batch("INSERT INTO fiche VALUES ('local',1,0,1);INSERT INTO provenance(id,kind) VALUES ('local-provenance','manual');INSERT INTO correction VALUES ('local','title','fr','defined','\"Local\"','local-provenance',NULL,1);").map_err(error)?;
  tx.execute("INSERT INTO pack_identity VALUES (?1,'local','{}')",["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]).map_err(error)?;Ok(())
 }).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn identified() -> Value {
    let mut doc = Fixture::document();
    doc["identities"] = json!([{"packUuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","ficheId":"card","provenance":{}}]);
    doc
}
#[test]
fn unassociated_data_cleared_source_languages_retained_and_idempotent() {
    let f = Fixture::new();
    let path = f.archive(&Fixture::document());
    let before = fs::read(&path).unwrap();
    let p = f.prepare(&path).unwrap();
    assert_eq!(p.plan.preview.unresolved[0].reason, "missingIdentity");
    let result = f.apply(&p, BTreeMap::new()).unwrap();
    assert!(result["imported"].as_u64().unwrap() > 0);
    assert_eq!(f.count("fiche"), 1);
    assert_eq!(f.count("pack_identity"), 0);
    assert_eq!(f.count("correction"), 3);
    assert_eq!(f.count("source"), 0);
    assert_eq!(f.count("pending_import"), 0);
    let p = f.prepare(&path).unwrap();
    let again = f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(result, again);
    assert_eq!(f.count("fiche"), 1);
    assert_eq!(f.count("operation"), 1);
    assert_eq!(fs::read(path).unwrap(), before);
}
#[test]
fn uuid_match_ignores_paths_and_defaults_to_local_then_allows_individual_incoming() {
    for incoming in [false, true] {
        let f = Fixture::new();
        f.local();
        let path = f.archive(&identified());
        let p = f.prepare(&path).unwrap();
        assert_eq!(p.plan.cards["card"], "local");
        assert!(p.plan.preview.unresolved.is_empty());
        assert_eq!(p.plan.preview.conflicts.len(), 2);
        let choices = if incoming {
            p.plan
                .preview
                .conflicts
                .iter()
                .map(|c| (c.id.clone(), "incoming".into()))
                .collect()
        } else {
            BTreeMap::new()
        };
        f.apply(&p, choices).unwrap();
        let value:String=f.store.read(|c|c.query_row("SELECT value_json FROM correction WHERE fiche_id='local' AND field='title' AND language='fr'",[],|r|r.get(0))).unwrap();
        assert_eq!(value, if incoming { "\"Titre\"" } else { "\"Local\"" });
        assert_eq!(f.count("fiche"), 1);
    }
}
#[test]
fn explicit_association_requires_existing_target_and_produces_conflicts() {
    let f = Fixture::new();
    f.local();
    let staged = staging::prepare(
        &f.store,
        &f.archive(&Fixture::document()),
        &AtomicBool::new(false),
    )
    .unwrap();
    let good = BTreeMap::from([("card".into(), "local".into())]);
    let plan = f
        .store
        .write(|tx| matching::plan(tx, &staged, "preview", &good))
        .unwrap();
    assert_eq!(plan.preview.conflicts.len(), 2);
    assert_eq!(plan.cards["card"], "local");
    let bad = BTreeMap::from([("card".into(), "missing".into())]);
    assert!(f
        .store
        .write(|tx| matching::plan(tx, &staged, "preview", &bad))
        .is_err());
}
#[test]
fn stale_revision_and_sql_failure_roll_back_every_row() {
    for sql_fail in [false, true] {
        let f = Fixture::new();
        let p = f.prepare(&f.archive(&Fixture::document())).unwrap();
        f.store.write(|tx|{tx.execute_batch(if sql_fail {"CREATE TRIGGER injected BEFORE INSERT ON import_receipt BEGIN SELECT RAISE(ABORT,'injected'); END;"} else {"UPDATE catalogue SET revision=revision+1;"}).map_err(error)?;Ok(())}).unwrap();
        assert!(f.apply(&p, BTreeMap::new()).is_err());
        assert_eq!(f.count("fiche"), 0);
        assert_eq!(f.count("provenance"), 0);
        assert_eq!(f.count("operation"), 0);
        assert_eq!(f.count("import_identity"), 0);
    }
}
#[test]
fn cancellation_before_commit_preserves_local_and_preparation_is_reusable() {
    let f = Fixture::new();
    let p = f.prepare(&f.archive(&Fixture::document())).unwrap();
    let (_, op) = f
        .store
        .begin_file_report("cancel", "catalogueImport", 1, Arc::new(|_, _| {}))
        .unwrap();
    op.cancel.store(true, Ordering::SeqCst);
    let args = ApplyImport {
        preview_id: "preview".into(),
        request_id: "apply".into(),
        expected_catalogue_revision: 0,
        ..Default::default()
    };
    assert!(super::merge::apply(&f.store, &p, &args, &op).is_err());
    assert_eq!(f.count("fiche"), 0);
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("fiche"), 1);
}
#[test]
fn duplicate_rows_bad_uuid_and_bad_foreign_keys_are_rejected_before_writes() {
    for kind in 0..5 {
        let f = Fixture::new();
        let mut doc = identified();
        match kind {
            0 => {
                let duplicate = doc["cards"][0].clone();
                doc["cards"].as_array_mut().unwrap().push(duplicate);
            }
            1 => doc["identities"][0]["packUuid"] = json!("not-uuid"),
            2 => doc["corrections"][0]["ficheId"] = json!("missing"),
            3 => doc["corrections"][0]["provenanceId"] = json!("missing"),
            _ => doc["corrections"][0]["state"] = json!("other"),
        }
        assert!(f.prepare(&f.archive(&doc)).is_err());
        assert_eq!(f.count("fiche"), 0);
    }
}
#[test]
fn same_title_distinct_uuid_never_matches() {
    let f = Fixture::new();
    f.local();
    let mut doc = identified();
    doc["identities"][0]["packUuid"] = json!("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert_ne!(p.plan.cards["card"], "local");
    let rejected = f.store.write(|tx| {
        matching::plan(
            tx,
            &p.staged,
            "incompatible",
            &BTreeMap::from([("card".into(), "local".into())]),
        )
    });
    assert!(
        rejected.is_err(),
        "an explicit choice must not override UUID identity"
    );
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("fiche"), 2);
}
#[test]
fn independent_contract_serializes_real_preview_conflict_and_result() {
    let f = Fixture::new();
    let p = f.prepare(&f.archive(&Fixture::document())).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/backup-import.json"
    ))
    .unwrap();
    let preview = super::import::ImportPreview {
        preview_id: "preview".into(),
        format_version: 1,
        backup_digest: "a".repeat(64),
        expected_catalogue_revision: 7,
        counts: p.plan.preview.counts.clone(),
        issues: vec![],
        additions: vec![],
        changes: fixture["preview"]["changes"]["items"]
            .as_array()
            .unwrap()
            .clone(),
        conflicts: vec![super::import::Conflict {
            id: "favorite-conflict".into(),
            target: json!({"kind":"favorite","id":"local-card","key":"","label":"Le voyage","identity":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}),
            local: json!(0),
            incoming: json!(1),
            default_choice: "local".into(),
        }],
        unresolved: vec![super::import::Unresolved {
            id: "remote-card".into(),
            label: Some("Le voyage".into()),
            identity: None,
            reason: "missingIdentity".into(),
            reference: None,
        }],
    };
    assert_eq!(
        serde_json::to_value(&preview.conflicts).unwrap(),
        fixture["preview"]["conflicts"]["items"]
    );
    let mut registry = f.store.backup_exports.lock().unwrap();
    let mut p = p;
    p.plan.preview = preview;
    registry.previews.insert("preview".into(), p);
    drop(registry);
    assert_eq!(
        f.store.import_preview_page("preview", 0, 100).unwrap(),
        fixture["preview"]
    );
    assert_eq!(
        f.store.import_preview_page("preview", 100, 100).unwrap()["conflicts"]["items"],
        json!([])
    );
    assert!(f.store.import_preview_page("preview", 0, 101).is_err());
    assert!(f.store.import_preview_page("missing", 0, 100).is_err());
}
fn custom_archive(
    f: &Fixture,
    name: &str,
    payload: &[u8],
    declared: Option<u64>,
    symlink: bool,
    version: u32,
    copies: usize,
) -> PathBuf {
    use std::io::Write;
    let path = f.root.join("hostile.zip");
    let mut doc = Fixture::document();
    doc["referenceValues"] = json!([{"ficheId":"card","field":"cover","language":"","value":null,"provenanceId":"manual","imageSha256":validate::payload(payload).sha256}]);
    let catalogue = serde_json::to_vec(&doc).unwrap();
    let mut entries = BTreeMap::from([("catalogue.json".into(), validate::payload(&catalogue))]);
    let mut names = vec![];
    for i in 0..copies {
        let member = if copies == 1 {
            name.to_string()
        } else {
            format!("images/{i:064x}")
        };
        let mut descriptor = validate::payload(payload);
        if let Some(size) = declared {
            descriptor.byte_size = size;
        }
        entries.insert(member.clone(), descriptor);
        names.push(member);
    }
    let manifest = format::Manifest {
        format: format::FORMAT.into(),
        format_version: version,
        schema: format::SCHEMA.into(),
        backup_id: uuid::Uuid::new_v4().to_string(),
        origin_catalogue_id: doc["originCatalogueId"].as_str().unwrap().into(),
        catalogue_revision: doc["catalogueRevision"].as_i64().unwrap(),
        counts: format::Counts {
            cards: doc["cards"].as_array().unwrap().len(),
            tags: doc["tags"].as_array().unwrap().len(),
            images: copies,
        },
        entries,
    };
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    zip.start_file("catalogue.json", options).unwrap();
    zip.write_all(&catalogue).unwrap();
    for name in names {
        if symlink {
            zip.add_symlink(name, std::str::from_utf8(payload).unwrap(), options)
                .unwrap();
        } else {
            zip.start_file(name, options).unwrap();
            zip.write_all(payload).unwrap();
        }
    }
    zip.finish().unwrap();
    path
}
#[test]
fn archive_hostile_paths_symlinks_and_future_version_fail() {
    for (name, symlink, version, code) in [
        ("../escape", false, 1, codes::CATALOG_IMPORT_INVALID),
        ("/escape", false, 1, codes::CATALOG_IMPORT_INVALID),
        ("images/../escape", false, 1, codes::CATALOG_IMPORT_INVALID),
        (
            "images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            true,
            1,
            codes::CATALOG_IMPORT_INVALID,
        ),
        ("extra", false, 2, codes::CATALOG_IMPORT_VERSION_UNSUPPORTED),
    ] {
        let f = Fixture::new();
        let path = custom_archive(&f, name, b"bad", None, symlink, version, 1);
        assert_eq!(f.prepare(&path).err().unwrap().code, code);
        assert!(!f.root.join("escape").exists());
        assert!(!f.store.backup_root().join("escape").exists());
        assert_eq!(f.count("fiche"), 0);
    }
}
#[test]
fn archive_declared_sizes_compression_image_count_and_pixels_are_bounded() {
    let sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (bytes, size, copies, code) in [
        (vec![0; 20], Some(10), 1, codes::CATALOG_IMPORT_INVALID),
        (
            vec![0; 1024 * 1024 + 1],
            Some(10),
            1,
            codes::CATALOG_IMPORT_LIMIT_EXCEEDED,
        ),
        (
            vec![0; 1],
            None,
            format::MAX_IMAGES + 1,
            codes::CATALOG_IMPORT_LIMIT_EXCEEDED,
        ),
    ] {
        let f = Fixture::new();
        let path = custom_archive(&f, &format!("images/{sha}"), &bytes, size, false, 1, copies);
        assert_eq!(f.prepare(&path).err().unwrap().code, code);
        assert_eq!(f.count("fiche"), 0);
    }
    let f = Fixture::new();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5000, 4000)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    assert!(bytes.len() as u64 <= format::MAX_IMAGE);
    let hash = validate::payload(&bytes).sha256;
    let path = custom_archive(&f, &format!("images/{hash}"), &bytes, None, false, 1, 1);
    assert_eq!(
        f.prepare(&path).err().unwrap().code,
        codes::CATALOG_IMPORT_LIMIT_EXCEEDED
    );
}
#[test]
fn roundtrip_export_import_preserves_labels_memberships_and_images() {
    let source = Fixture::new();
    source.store.write(|tx|{
  tx.execute_batch("INSERT INTO fiche VALUES ('card',1,1,1);INSERT INTO provenance(id,kind) VALUES ('p','manual');INSERT INTO tag VALUES ('t','Été','ete',1);INSERT INTO tag_member VALUES ('t','card');").map_err(error)?;
  let bytes=include_bytes!("../../../../icons/32x32.png");let sha=validate::payload(bytes).sha256;
  fs::write(source.store.images_root().join(&sha),bytes).map_err(error)?;
  tx.execute("INSERT INTO image_asset VALUES (?1,'image/png',?2,?3)",params![sha,bytes.len() as i64,format!("images/{sha}")]).map_err(error)?;
  tx.execute("INSERT INTO correction VALUES ('card','cover','','defined',?1,'p',?2,1)",params![json!({"sha256":sha}).to_string(),sha]).map_err(error)?;Ok(())
 }).unwrap();
    let path = source.root.join("roundtrip.zip");
    let plan = source.store.plan_catalogue_export(path.clone(), 0).unwrap();
    {
        let registry = source.store.backup_exports.lock().unwrap();
        export::write_archive(
            &source.store,
            &registry.plans[&plan.plan_id],
            &AtomicBool::new(false),
            |_| {},
            || Ok(()),
        )
        .unwrap();
    }
    let target = Fixture::new();
    let p = target.prepare(&path).unwrap();
    target.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(target.count("tag_member"), 1);
    assert_eq!(target.count("image_asset"), 1);
    target.store.clean_orphan_images().unwrap();
    assert_eq!(fs::read_dir(target.store.images_root()).unwrap().count(), 1);
    let next = target.prepare(&path).unwrap();
    target.apply(&next, BTreeMap::new()).unwrap();
    assert_eq!(target.count("tag"), 1);
}
fn wait(store: &Store, receipt: &Value) -> crate::services::catalogue::events::Progress {
    let id = receipt["operationId"].as_str().unwrap();
    let started = std::time::Instant::now();
    loop {
        let progress = store.get_operation(id).unwrap();
        if matches!(
            progress.status.as_str(),
            "success" | "failed" | "cancelled" | "partial"
        ) {
            return progress;
        }
        assert!(
            started.elapsed() < crate::test_support::timeout(),
            "import did not finish"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn real_operations_revalidate_source_revision_choices_and_request_ids() {
    let f = Fixture::new();
    let path = f.archive(&Fixture::document());
    let sink: crate::services::catalogue::scan::Sink = Arc::new(|_, _| {});
    let receipt = f
        .store
        .preview_catalogue_import(
            path.clone(),
            "preview-request".into(),
            BTreeMap::new(),
            sink.clone(),
        )
        .unwrap();
    assert_eq!(
        receipt,
        f.store
            .preview_catalogue_import(
                path.clone(),
                "preview-request".into(),
                BTreeMap::new(),
                sink.clone()
            )
            .unwrap()
    );
    let preview = wait(&f.store, &receipt);
    assert_eq!(preview.status, "success");
    let id = preview.result.unwrap()["previewId"]
        .as_str()
        .unwrap()
        .to_string();
    let mut args = ApplyImport {
        preview_id: id.clone(),
        request_id: "apply-request".into(),
        expected_catalogue_revision: 0,
        ..Default::default()
    };
    args.choices
        .insert("foreign-conflict".into(), "incoming".into());
    assert!(f
        .store
        .apply_catalogue_import(args.clone(), sink.clone())
        .is_err());
    args.choices.clear();
    args.associations
        .insert("card".into(), "foreign-target".into());
    assert!(f
        .store
        .apply_catalogue_import(args.clone(), sink.clone())
        .is_err());
    args.associations.clear();
    fs::write(&path, b"changed").unwrap();
    let apply = f.store.apply_catalogue_import(args, sink).unwrap();
    let failed = wait(&f.store, &apply);
    assert_eq!(failed.status, "failed");
    assert_eq!(
        failed.error.unwrap().code,
        codes::CATALOG_IMPORT_SOURCE_CHANGED
    );
    assert_eq!(f.count("fiche"), 0);
}
#[test]
fn new_association_on_identical_archive_is_applied_instead_of_replaying_old_receipt() {
    let f = Fixture::new();
    f.local();
    let path = f.archive(&Fixture::document());
    let first = f.prepare(&path).unwrap();
    f.apply(&first, BTreeMap::new()).unwrap();
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    let plan = f
        .store
        .write(|tx| matching::plan(tx, &staged, "associated", &associations))
        .unwrap();
    let choices = plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    let p = Prepared {
        staged,
        plan,
        source: path,
        created: Instant::now(),
        associations: associations.clone(),
    };
    let (_, op) = f
        .store
        .begin_file_report("associate", "catalogueImport", 1, Arc::new(|_, _| {}))
        .unwrap();
    let result = super::merge::apply(
        &f.store,
        &p,
        &ApplyImport {
            preview_id: "associated".into(),
            request_id: "associate-apply".into(),
            choices,
            associations,
            expected_catalogue_revision: p.plan.preview.expected_catalogue_revision,
        },
        &op,
    )
    .unwrap();
    assert!(result["imported"].as_u64().unwrap() > 0);
    let title:String=f.store.read(|c|c.query_row("SELECT value_json FROM correction WHERE fiche_id='local' AND field='title' AND language='fr'",[],|r|r.get(0))).unwrap();
    assert_eq!(title, "\"Titre\"");
    assert_eq!(f.count("fiche"), 1);
    let snapshot = f
        .store
        .backup_snapshot(result["catalogueRevision"].as_i64().unwrap())
        .unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(exported["cards"].as_array().unwrap().len(), 1);
}
#[test]
fn duplicate_normalized_labels_merge_without_duplicate_memberships() {
    let f = Fixture::new();
    let mut doc = Fixture::document();
    doc["tags"] =
        json!([{"id":"one","label":"Été","revision":1},{"id":"two","label":"ete","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"one","ficheId":"card"},{"tagId":"two","ficheId":"card"}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("tag"), 1);
    assert_eq!(f.count("tag_member"), 1);
}
#[test]
fn incoming_convergence_cannot_create_duplicate_conflict_ids() {
    let f = Fixture::new();
    f.local();
    let mut doc = identified();
    let mut second = doc["cards"][0].clone();
    second["id"] = json!("other");
    doc["cards"].as_array_mut().unwrap().push(second);
    doc["identities"].as_array_mut().unwrap().push(json!({"packUuid":"bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee","ficheId":"other","provenance":{}}));
    f.store.write(|tx|{tx.execute("INSERT INTO pack_identity VALUES ('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee','local','{}')",[]).map_err(error)?;Ok(())}).unwrap();
    assert_eq!(
        f.prepare(&f.archive(&doc)).err().unwrap().code,
        codes::CATALOG_IMPORT_ASSOCIATION_INVALID
    );
}
#[test]
fn disk_full_preparation_and_publishing_fail_without_local_rows() {
    let f = Fixture::new();
    let path = f.archive(&Fixture::document());
    crate::services::catalogue::files::publish::AVAILABLE_BYTES.with(|v| v.set(Some(0)));
    assert!(f.prepare(&path).is_err());
    crate::services::catalogue::files::publish::AVAILABLE_BYTES.with(|v| v.set(None));
    assert_eq!(f.count("fiche"), 0);
}
#[test]
fn duplicate_json_keys_overflow_and_depth_are_rejected_without_panic() {
    assert!(validate::strict_json(br#"{"x":1,"x":2}"#).is_err());
    assert!(validate::strict_json(br#"{"x":{"y":1,"y":2}}"#).is_err());
    let nested = format!("{}0{}", "[".repeat(40), "]".repeat(40));
    assert!(validate::strict_json(nested.as_bytes()).is_err());
    let mut doc = Fixture::document();
    doc["corrections"][0]["value"] = json!("x".repeat(1024 * 1024 + 1));
    assert!(matching::validate_document(&doc).is_err());
}
#[test]
fn retained_evidence_survives_export_import_export_without_nesting() {
    let f = Fixture::new();
    let mut doc = Fixture::document();
    doc["suggestionDecisions"] =
        json!([{"key":"refused","participants":[],"evidence":{},"decision":"refused"}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    let snapshot = f.store.backup_snapshot(1).unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(
        exported["retainedImports"][0]["suggestionDecisions"],
        doc["suggestionDecisions"]
    );
    validate::document(&exported).unwrap();
    let g = Fixture::new();
    let p = g.prepare(&g.archive(&exported)).unwrap();
    g.apply(&p, BTreeMap::new()).unwrap();
    let snapshot = g.store.backup_snapshot(1).unwrap();
    let again: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    for retained in again["retainedImports"].as_array().unwrap() {
        assert!(retained.get("retainedImports").is_none());
    }
}
#[test]
fn receipt_never_hides_a_new_local_change() {
    let f = Fixture::new();
    f.local();
    let path = f.archive(&identified());
    let p = f.prepare(&path).unwrap();
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    f.store.write(|tx|{tx.execute_batch("UPDATE correction SET value_json='\"Changed again\"' WHERE fiche_id='local' AND field='title';UPDATE fiche SET favorite=0 WHERE id='local';UPDATE catalogue SET revision=revision+1;").map_err(error)?;Ok(())}).unwrap();
    let p = f.prepare(&path).unwrap();
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    let title:String=f.store.read(|c|c.query_row("SELECT value_json FROM correction WHERE fiche_id='local' AND field='title' AND language='fr'",[],|r|r.get(0))).unwrap();
    assert_eq!(title, "\"Titre\"");
}
fn archive_image(f: &Fixture, bytes: &[u8]) -> PathBuf {
    archive_image_document(f, bytes, None)
}
fn archive_image_document(f: &Fixture, bytes: &[u8], document: Option<Value>) -> PathBuf {
    use std::io::Write;
    let sha = validate::payload(bytes).sha256;
    let mut doc = Fixture::document();
    doc["corrections"] = json!([{"ficheId":"card","field":"cover","language":"","state":"defined","value":{"sha256":sha},"provenanceId":"manual","imageSha256":sha,"revision":1}]);
    if let Some(document) = document {
        doc = document;
    }
    let path = f.archive(&doc);
    let file = fs::File::open(&path).unwrap();
    let mut old = zip::ZipArchive::new(file).unwrap();
    let mut header = String::new();
    use std::io::Read;
    old.by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut header)
        .unwrap();
    let mut manifest: format::Manifest = serde_json::from_str(&header).unwrap();
    drop(old);
    manifest.counts.images = 1;
    manifest
        .entries
        .insert(format!("images/{sha}"), validate::payload(bytes));
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, data) in [
        (
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        ),
        ("catalogue.json".into(), serde_json::to_vec(&doc).unwrap()),
        (format!("images/{sha}"), bytes.to_vec()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&data).unwrap();
    }
    zip.finish().unwrap();
    path
}
#[test]
fn corrupt_image_and_publication_failure_never_install_references() {
    let f = Fixture::new();
    assert!(f.prepare(&archive_image(&f, b"not an image")).is_err());
    let bytes = include_bytes!("../../../../icons/32x32.png");
    let path = archive_image(&f, bytes);
    let p = f.prepare(&path).unwrap();
    // A blocking directory simulates an unwritable destination without relying on
    // root/non-root permission semantics.
    let destination = f.store.images_root().join(validate::payload(bytes).sha256);
    fs::create_dir(&destination).unwrap();
    assert!(f.apply(&p, BTreeMap::new()).is_err());
    assert_eq!(f.count("image_asset"), 0);
    assert_eq!(f.count("fiche"), 0);
    fs::remove_dir(&destination).unwrap();
    f.store.write(|tx|{tx.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON import_receipt BEGIN SELECT RAISE(ABORT,'injected'); END;").map_err(error)?;Ok(())}).unwrap();
    assert!(f.apply(&p, BTreeMap::new()).is_err());
    assert_eq!(f.count("correction"), 0);
    assert!(destination.is_file());
    f.store.clean_orphan_images().unwrap();
    assert!(!destination.exists());
    f.store
        .write(|tx| {
            tx.execute_batch("DROP TRIGGER fail_import")
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    assert!(destination.is_file());
}
#[test]
fn unapplied_incoming_image_is_retained_for_recovery_and_reexport() {
    let f = Fixture::new();
    f.local();
    let bytes = include_bytes!("../../../../icons/32x32.png");
    let mut p = f.prepare(&archive_image(&f, bytes)).unwrap();
    f.store.write(|tx|{tx.execute("INSERT INTO correction VALUES ('local','cover','','cleared',NULL,'local-provenance',NULL,1)",[]).map_err(error)?;Ok(())}).unwrap();
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    p.plan = f
        .store
        .write(|tx| matching::plan(tx, &p.staged, "preview", &associations))
        .unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    f.store.clean_orphan_images().unwrap();
    assert!(f
        .store
        .images_root()
        .join(validate::payload(bytes).sha256)
        .is_file());
    let snapshot = f.store.backup_snapshot(1).unwrap();
    assert_eq!(snapshot.manifest.counts.images, 1);
    let revision = f.store.get_card("local").unwrap()["ficheRevision"]
        .as_i64()
        .unwrap();
    f.store.mutate(serde_json::from_value(json!({"kind":"forgetUnreferencedCards","requestKey":"forget-rejected-cover","ficheIds":["local"],"expectedFicheRevisions":{"local":revision}})).unwrap(),1).unwrap();
    assert_eq!(f.count("image_asset"), 0);
    assert!(!f
        .store
        .images_root()
        .join(validate::payload(bytes).sha256)
        .exists());
    assert_eq!(
        f.store.backup_snapshot(2).unwrap().manifest.counts.images,
        0
    );
}
#[test]
fn rescan_never_replaces_an_unavailable_imported_reference_implicitly() {
    use std::io::Write;
    let f = Fixture::new();
    f.local();
    let mut doc = identified();
    doc["referenceValues"] = json!([{"ficheId":"card","field":"title","language":"","value":"Saved reference","provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    let root = f.root.join("sources");
    fs::create_dir(&root).unwrap();
    let path = root.join("pack.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(json!({"title":"Local source","stageNodes":[{"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","squareOne":true}]}).to_string().as_bytes()).unwrap();
    zip.finish().unwrap();
    let original = fs::read(&path).unwrap();
    f.store.add_source(&root, 0, false).unwrap();
    let receipt = f
        .store
        .start_scan(
            None,
            "rescan".into(),
            f.store.list_sources().unwrap().sources_revision,
            f.root.join("cache"),
            f.root.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let p = wait(&f.store, &serde_json::to_value(receipt).unwrap());
    assert_eq!(p.status, "success");
    assert_eq!(f.count("reference_source"), 0);
    let value: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT value_json FROM reference_value WHERE fiche_id='local' AND field='title'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(value, "\"Saved reference\"");
    let eid: String = f
        .store
        .read(|c| {
            c.query_row("SELECT id FROM exemplar WHERE fiche_id='local'", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    f.store
        .write(|tx| crate::services::catalogue::data::mutate::reference::select(tx, "local", &eid))
        .unwrap();
    assert_eq!(f.count("import_reference"), 0);
    assert_eq!(f.count("reference_source"), 1);
    assert_eq!(fs::read(path).unwrap(), original);
}
#[test]
fn deferred_sql_commit_failure_rolls_back_and_releases_cancellation_boundary() {
    let f = Fixture::new();
    let (_, op) = f
        .store
        .begin_file_report("commit-failure", "catalogueImport", 1, Arc::new(|_, _| {}))
        .unwrap();
    let result=f.store.write_guarded(|tx|{
  tx.execute_batch("PRAGMA defer_foreign_keys=ON;INSERT INTO fiche VALUES ('temporary',1,0,0);INSERT INTO tag_member VALUES ('missing','temporary');").map_err(error)?;Ok(())
 },||op.progress.lock().map_err(error));
    assert!(result.is_err());
    assert_eq!(f.count("fiche"), 0);
    assert!(op.progress.try_lock().is_ok());
    assert!(!op.published.load(Ordering::SeqCst));
}
#[test]
fn uuid_survives_three_catalogues_without_activating_sources() {
    let a = Fixture::new();
    let mut original = identified();
    original["tags"] = json!([{"id":"tag","label":"Été","revision":1}]);
    original["tagMembers"] = json!([{"tagId":"tag","ficheId":"card"}]);
    let path = a.archive(&original);
    let b = Fixture::new();
    let p = b.prepare(&path).unwrap();
    b.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(b.count("pack_identity"), 0);
    assert_eq!(b.count("saved_pack_identity"), 1);
    assert_eq!(b.count("source"), 0);
    let snapshot = b.store.backup_snapshot(1).unwrap();
    let portable: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(
        portable["identities"][0]["packUuid"],
        original["identities"][0]["packUuid"]
    );
    assert_eq!(
        portable["identities"][0]["ficheId"],
        portable["cards"][0]["id"]
    );
    let c = Fixture::new();
    c.local();
    let p = c.prepare(&c.archive(&portable)).unwrap();
    assert_eq!(
        p.plan.cards[portable["cards"][0]["id"].as_str().unwrap()],
        "local"
    );
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|r| (r.id.clone(), "incoming".into()))
        .collect();
    c.apply(&p, choices).unwrap();
    assert_eq!(c.count("fiche"), 1);
    assert_eq!(c.count("tag_member"), 1);
    assert_eq!(c.count("source"), 0);
    let title:String=c.store.read(|db|db.query_row("SELECT value_json FROM correction WHERE fiche_id='local' AND field='title' AND language='fr'",[],|r|r.get(0))).unwrap();
    assert_eq!(title, "\"Titre\"");
}
#[test]
fn waiting_edits_conflict_then_reconcile_without_exported_duplicate() {
    for choose_waiting in [false, true] {
        let f = Fixture::new();
        f.local();
        let path = f.archive(&Fixture::document());
        let first = f.prepare(&path).unwrap();
        let waiting = first.plan.cards["card"].clone();
        f.apply(&first, BTreeMap::new()).unwrap();
        f.store.write(|tx|{
            tx.execute("UPDATE correction SET value_json='\"Edited while waiting\"' WHERE fiche_id=?1 AND field='title'",[&waiting]).map_err(error)?;
            tx.execute_batch("INSERT INTO tag VALUES ('waiting-tag','Famille','famille',1);").map_err(error)?;

            tx.execute("INSERT INTO tag_member VALUES ('waiting-tag',?1)",[&waiting]).map_err(error)?;
            tx.execute("INSERT INTO enrichment_tag_origin VALUES ('waiting-tag',?1,'{\"url\":\"https://example.org/waiting\"}')",[&waiting]).map_err(error)?;
            tx.execute("INSERT INTO fiche_forgotten VALUES (?1)",[&waiting]).map_err(error)?;
            tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;Ok(())
        }).unwrap();
        let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
        let associations = BTreeMap::from([("card".into(), "local".into())]);
        let plan = f
            .store
            .write(|tx| matching::plan(tx, &staged, "reconcile", &associations))
            .unwrap();
        let conflict = plan
            .preview
            .conflicts
            .iter()
            .find(|r| r.target["kind"] == "pendingCorrections" && r.target["key"] == "title:fr")
            .unwrap();
        assert_eq!(conflict.incoming["value"], "Edited while waiting");
        let mut choices = BTreeMap::new();
        if choose_waiting {
            choices.insert(conflict.id.clone(), "incoming".into());
        }
        let p = Prepared {
            staged,
            plan,
            source: path,
            created: Instant::now(),
            associations,
        };
        f.apply(&p, choices).unwrap();
        assert_eq!(f.count("fiche"), 1);
        // The transferred forgetting conflicts; its default preserves local data.
        assert_eq!(f.count("tag_member"), 1);
        assert_eq!(f.count("enrichment_tag_origin"), 1);
        assert_eq!(f.count("fiche_forgotten"), 0);
        let title:String=f.store.read(|db|db.query_row("SELECT value_json FROM correction WHERE fiche_id='local' AND field='title' AND language='fr'",[],|r|r.get(0))).unwrap();
        assert_eq!(
            title,
            if choose_waiting {
                "\"Edited while waiting\""
            } else {
                "\"Local\""
            }
        );
        let snapshot = f
            .store
            .backup_snapshot(f.store.list_sources().unwrap().catalogue_revision)
            .unwrap();
        let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
        assert_eq!(exported["cards"].as_array().unwrap().len(), 1);
        assert!(exported["corrections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["ficheId"] == "local"));
        assert_eq!(exported["tagMembers"][0]["ficheId"], "local");
    }
}
fn relation_fixture() -> (Fixture, Value, BTreeMap<String, String>) {
    use crate::services::catalogue::{analyze, grouping::Scanned};
    let f = Fixture::new();
    let root = f.root.join("source");
    fs::create_dir(&root).unwrap();
    f.store.add_source(&root, 0, false).unwrap();
    let source = f.store.list_sources().unwrap().items[0].id.clone();
    let mut items = vec![];
    for name in ["one.mbah", "two.mbah"] {
        let path = root.join(name);
        let raw = json!({"title":"Voyage"});
        fs::write(&path, raw.to_string()).unwrap();
        let mut observation = analyze::Observation::new("project");
        observation.title = Some("Voyage".into());
        observation
            .fields
            .insert("/title".into(), analyze::observed(&raw, "/title", "string"));
        items.push(Scanned {
            source_id: source.clone(),
            path: path.to_string_lossy().into(),
            path_key: path.to_string_lossy().as_bytes().to_vec(),
            token: format!("token-{name}"),
            modified: 1,
            size: 18,
            file_id: None,
            save_prestate: None,
            observation,
        });
    }
    f.store
        .publish_scan("relations", 1, &items, &[(source, true)])
        .unwrap();
    let ids = f
        .store
        .read(|c| {
            c.prepare("SELECT fiche_id FROM exemplar ORDER BY anchor_json")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    let mut doc = Fixture::document();
    doc["cards"] = json!([{"id":"a","createdAt":1,"favorite":0,"revision":1},{"id":"b","createdAt":1,"favorite":0,"revision":1}]);
    doc["corrections"] = json!([]);
    let associations = BTreeMap::from([("a".into(), ids[0].clone()), ("b".into(), ids[1].clone())]);
    (f, doc, associations)
}
fn relation_preview(f: &Fixture, doc: &Value, associations: BTreeMap<String, String>) -> Prepared {
    let source = f.archive(doc);
    let staged = staging::prepare(&f.store, &source, &AtomicBool::new(false)).unwrap();
    let plan = f
        .store
        .write(|tx| matching::plan(tx, &staged, "relations", &associations))
        .unwrap();
    Prepared {
        staged,
        plan,
        source,
        created: Instant::now(),
        associations,
    }
}
#[test]
fn legacy_unidentified_group_stays_pending_even_with_verified_member_proofs() {
    for available in [true, false] {
        let (f, mut doc, associations) = relation_fixture();
        let mut members = vec![];
        for id in ["a", "b"] {
            let proofs=f.store.read(|c|c.prepare("SELECT proof_json,verified_uuid FROM exemplar WHERE fiche_id=?1")?.query_map([&associations[id]],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()).unwrap().into_iter().map(|(proof,uuid)|json!({"digest":validate::payload(proof.as_bytes()).sha256,"uuid":uuid})).collect::<Vec<_>>();
            members.push(json!({"ficheId":id,"proofs":proofs}));
        }
        doc["associations"] = json!([{"ficheId":"a","targetId":"b","members":members}]);
        if !available {
            f.store
                .write(|tx| {
                    tx.execute("UPDATE cache.observation SET state='unavailable'", [])
                        .map_err(error)?;
                    Ok(())
                })
                .unwrap();
        }
        let p = relation_preview(&f, &doc, associations);
        let group = p
            .plan
            .preview
            .conflicts
            .iter()
            .find(|r| r.target["kind"] == "group");
        assert!(
            group.is_none(),
            "unidentified files cannot be grouped by import"
        );
        let choices = group
            .map(|r| BTreeMap::from([(r.id.clone(), "incoming".into())]))
            .unwrap_or_default();
        f.apply(&p, choices).unwrap();
        assert_eq!(f.count("fiche_grouping"), 0);
        assert_eq!(
            f.store.query_entries(100, None, true).unwrap().items.len(),
            2
        );
        assert_eq!(f.count("pending_import"), 1);
        for name in ["one.mbah", "two.mbah"] {
            assert_eq!(
                fs::read(f.root.join("source").join(name)).unwrap(),
                json!({"title":"Voyage"}).to_string().as_bytes()
            );
        }
    }
}
#[test]
fn convergence_restores_only_for_current_reliable_observation() {
    for reliable in [false, true] {
        let (f, mut doc, associations) = relation_fixture();
        let uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let eid: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT id FROM exemplar WHERE fiche_id=?1",
                    [&associations["a"]],
                    |r| r.get(0),
                )
            })
            .unwrap();
        f.store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO pack_identity VALUES (?1,?2,'{}')",
                    params![uuid, associations["b"]],
                )
                .map_err(error)?;
                let raw = json!({"identity":{"value":uuid,"reliable":reliable}}).to_string();
                tx.execute(
                    "UPDATE cache.observation SET raw_observation_json=?2 WHERE exemplar_id=?1",
                    params![eid, raw],
                )
                .map_err(error)?;
                Ok(())
            })
            .unwrap();
        doc["identities"] = json!([{"packUuid":uuid,"ficheId":"b","provenance":{}}]);
        doc["exemplarHints"] = json!([{"id":"remote-exemplar","ficheId":"a","verifiedUuid":null,"locator":{},"retired":0,"createdAt":1}]);
        doc["pendingAssociations"] =
            json!([{"exemplarId":"remote-exemplar","knownFicheId":"b","packUuid":uuid}]);
        let p = relation_preview(&f, &doc, associations);
        assert_eq!(
            p.plan.actions.iter().any(|r| r.kind == "convergence"),
            reliable
        );
        f.apply(&p, BTreeMap::new()).unwrap();
        assert_eq!(f.count("identity_convergence"), i64::from(reliable));
        assert_eq!(f.count("pending_import"), i64::from(!reliable));
    }
}
#[test]
fn group_without_archived_membership_proof_is_retained_even_when_local_cards_are_ready() {
    let (f, mut doc, associations) = relation_fixture();
    doc["associations"] = json!([{"ficheId":"a","targetId":"b"}]);
    let p = relation_preview(&f, &doc, associations);
    assert!(!p.plan.actions.iter().any(|r| r.kind == "group"));
    assert!(p
        .plan
        .preview
        .issues
        .iter()
        .any(|r| r == "retained:associations"));
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("fiche_grouping"), 0);
}
// Persist a pre-MENAGE association as a compatibility fixture. No public
// mutation is used: current clients cannot create this state.
fn legacy_group(f: &Fixture, ids: &[String], target: &str) {
    use crate::services::catalogue::data::mutate::association;
    f.store
        .write(|tx| {
            let before = association::snapshot(tx, ids)?;
            association::group(tx, ids, target, &[], false)?;
            let operation = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO operation VALUES (?1,'groupCards','committed',?1,0,1,'{}')",
                [&operation],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO association_event VALUES (?1,?1,'groupCards','{}',?2,?3)",
                params![
                    operation,
                    serde_json::to_string(&before).unwrap(),
                    serde_json::to_string(&association::snapshot(tx, ids)?).unwrap()
                ],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
}
fn group_local_pair(f: &Fixture, ids: &BTreeMap<String, String>) {
    legacy_group(f, &[ids["a"].clone(), ids["b"].clone()], &ids["b"]);
}

#[test]
fn legacy_group_export_import_keeps_reference_choices_without_rejoining_files() {
    let (a, _, original) = relation_fixture();
    group_local_pair(&a, &original);
    let snapshot = a
        .store
        .backup_snapshot(a.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    let relation = &doc["associations"][0];
    assert_eq!(
        relation["members"][0]["proofs"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        relation["members"][1]["proofs"].as_array().unwrap().len(),
        1
    );
    let (b, _, local) = relation_fixture();
    let associations = BTreeMap::from([
        (original["a"].clone(), local["a"].clone()),
        (original["b"].clone(), local["b"].clone()),
    ]);
    // Same values as the active local reference: nothing to choose (REVb2 P2-B).
    let p = relation_preview(&b, &doc, associations.clone());
    assert!(!p.plan.actions.iter().any(|r| r.kind == "referenceBundle"));
    let mut doc = doc;
    for row in doc["referenceValues"].as_array_mut().unwrap() {
        if row["field"] == "title" {
            row["value"] = json!("Voyage modifié");
        }
    }
    let p = relation_preview(&b, &doc, associations);
    assert!(!p.plan.actions.iter().any(|r| r.kind == "group"));
    assert!(p.plan.actions.iter().any(|r| r.kind == "referenceBundle"));
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|r| (r.id.clone(), "incoming".into()))
        .collect();
    b.apply(&p, choices).unwrap();
    assert_eq!(b.count("fiche_grouping"), 0);
    assert_eq!(
        b.store.query_entries(100, None, true).unwrap().items.len(),
        2
    );
    assert_eq!(b.count("import_reference"), 1);
    let exported = b
        .store
        .backup_snapshot(b.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let doc: Value = serde_json::from_slice(&exported.catalogue).unwrap();
    assert!(doc["associations"].as_array().unwrap().is_empty());
    assert!(!doc["retainedImports"].as_array().unwrap().is_empty());
}
fn third_member(f: &Fixture) -> String {
    use crate::services::catalogue::{analyze, grouping::Scanned};
    let path = f.root.join("source/three.mbah");
    let raw = json!({"title":"Voyage"});
    fs::write(&path, raw.to_string()).unwrap();
    let source = f.store.list_sources().unwrap().items[0].id.clone();
    let mut observation = analyze::Observation::new("project");
    observation.title = Some("Voyage".into());
    observation
        .fields
        .insert("/title".into(), analyze::observed(&raw, "/title", "string"));
    f.store
        .publish_scan(
            "third",
            1,
            &[Scanned {
                source_id: source.clone(),
                path: path.to_string_lossy().into(),
                path_key: path.to_string_lossy().as_bytes().to_vec(),
                token: "token-three.mbah".into(),
                modified: 1,
                size: 18,
                file_id: None,
                save_prestate: None,
                observation,
            }],
            &[(source, true)],
        )
        .unwrap();
    f.store
        .read(|c| {
            c.query_row(
                "SELECT fiche_id FROM exemplar WHERE json_extract(anchor_json,'$.path')=?1",
                [path.to_string_lossy().as_ref()],
                |r| r.get(0),
            )
        })
        .unwrap()
}
#[test]
fn legacy_three_member_import_keeps_files_independent_and_reimport_is_idempotent() {
    let (a, _, mut original) = relation_fixture();
    original.insert("c".into(), third_member(&a));
    legacy_group(
        &a,
        &original.values().cloned().collect::<Vec<_>>(),
        &original["b"],
    );
    let snapshot = a
        .store
        .backup_snapshot(a.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(doc["associations"].as_array().unwrap().len(), 2);
    let (b, _, mut local) = relation_fixture();
    local.insert("c".into(), third_member(&b));
    let associations = original
        .iter()
        .map(|(key, id)| (id.clone(), local[key].clone()))
        .collect();
    let p = relation_preview(&b, &doc, associations);
    assert_eq!(
        p.plan.actions.iter().filter(|r| r.kind == "group").count(),
        0
    );
    // Reimport retains historical evidence without restoring the old group.
    b.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(b.count("fiche_grouping"), 0);
    let p = relation_preview(&b, &doc, p.associations.clone());
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .filter(|r| r.target["kind"] == "group")
        .map(|r| (r.id.clone(), "incoming".into()))
        .collect();
    b.apply(&p, choices).unwrap();
    assert_eq!(b.count("fiche_grouping"), 0);
    assert_eq!(
        b.store.query_entries(100, None, true).unwrap().items.len(),
        3
    );
    let p = b.prepare(&p.source).unwrap();
    b.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(b.count("fiche_grouping"), 0);
    assert_eq!(
        b.store.query_entries(100, None, true).unwrap().items.len(),
        3
    );
    let snapshot = b
        .store
        .backup_snapshot(b.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert!(exported["associations"].as_array().unwrap().is_empty());
    for retained in exported["retainedImports"].as_array().into_iter().flatten() {
        assert_eq!(retained["associations"].as_array().unwrap().len(), 2);
    }
}

#[test]
fn historical_label_and_new_label_remain_distinct_when_incoming_rename_is_chosen() {
    for (table, kind, members, column) in [("tags", "tag", "tagMembers", "tagId")] {
        for incoming in [false, true] {
            let f = Fixture::new();
            let mut doc = identified();
            doc[table] = json!([{"id":"old","label":"A","revision":1}]);
            doc[members] = json!([{column:"old","ficheId":"card"}]);
            let p = f.prepare(&f.archive(&doc)).unwrap();
            f.apply(&p, BTreeMap::new()).unwrap();
            f.store
                .write(|tx| {
                    tx.execute(
                        &format!("UPDATE {kind} SET label='C',normalized_label='c'"),
                        [],
                    )
                    .map_err(error)?;
                    Ok(())
                })
                .unwrap();
            doc[table] = json!([{"id":"old","label":"A","revision":1},{"id":"new","label":"C","revision":1}]);
            doc[members] = json!([{column:"old","ficheId":"card"},{column:"new","ficheId":"card"}]);
            let p = f.prepare(&f.archive(&doc)).unwrap();
            let choices = if incoming {
                p.plan
                    .preview
                    .conflicts
                    .iter()
                    .map(|c| (c.id.clone(), "incoming".into()))
                    .collect()
            } else {
                BTreeMap::new()
            };
            f.apply(&p, choices).unwrap();
            assert_eq!(f.count(kind), if incoming { 2 } else { 1 });
            let label:String=f.store.read(|c|c.query_row(&format!("SELECT label FROM {kind} JOIN {kind}_member ON {kind}.id={kind}_member.{kind}_id WHERE {kind}.id=(SELECT local_entity_id FROM import_identity WHERE origin_catalogue_id=?1 AND entity_type=?2 AND origin_entity_id='new')"),rusqlite::params![doc["originCatalogueId"].as_str().unwrap(),kind],|r|r.get(0))).unwrap();
            assert_eq!(label, "C");
            let p = f.prepare(&f.archive(&doc)).unwrap();
            let choices = if incoming {
                p.plan
                    .preview
                    .conflicts
                    .iter()
                    .map(|c| (c.id.clone(), "incoming".into()))
                    .collect()
            } else {
                BTreeMap::new()
            };
            f.apply(&p, choices).unwrap();
            assert_eq!(f.count(kind), if incoming { 2 } else { 1 });
        }
    }
}
#[test]
fn empty_imported_reference_survives_reexport() {
    use std::io::Write;
    let b = Fixture::new();
    let mut doc = identified();
    doc["exemplarHints"] = json!([{"id":"selected","ficheId":"card","verifiedUuid":null,"locator":{},"retired":0,"createdAt":1}]);
    doc["references"] =
        json!([{"ficheId":"card","exemplarId":"selected","selectedAt":1,"revision":1}]);
    let p = b.prepare(&b.archive(&doc)).unwrap();
    b.apply(&p, BTreeMap::new()).unwrap();
    let snapshot = b.store.backup_snapshot(1).unwrap();
    let portable: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert!(portable["cards"][0].get("importedReference").is_some());
    let c = Fixture::new();
    c.local();
    let p = c.prepare(&c.archive(&portable)).unwrap();
    c.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(c.count("import_reference"), 1);
    assert_eq!(c.count("reference_source"), 0);
    let root = c.root.join("sources");
    fs::create_dir(&root).unwrap();
    let path = root.join("pack.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(json!({"title":"Local source","stageNodes":[{"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","squareOne":true}]}).to_string().as_bytes()).unwrap();
    zip.finish().unwrap();
    let original = fs::read(&path).unwrap();
    c.store.add_source(&root, 0, false).unwrap();
    let receipt = c
        .store
        .start_scan(
            None,
            "rescan".into(),
            c.store.list_sources().unwrap().sources_revision,
            c.root.join("cache"),
            c.root.join("data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let p = wait(&c.store, &serde_json::to_value(receipt).unwrap());
    assert_eq!(p.status, "success");
    assert_eq!(c.count("reference_source"), 0);
    assert_eq!(c.count("import_reference"), 1);
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn enrichment_roundtrip_keeps_reduced_image_description_and_web_evidence() {
    let source = Fixture::new();
    let bytes = include_bytes!("../../../../icons/32x32.png");
    let hash = super::validate::payload(bytes).sha256;
    fs::write(source.store.images_root().join(&hash), bytes).unwrap();
    source.store.write(|tx| {
        tx.execute_batch(r#"INSERT INTO fiche VALUES ('web',1,0,0);
            INSERT INTO provenance(id,kind,url,locator_json) VALUES ('web-origin','web','https://example.org/origin','{"mechanism":"pastedText"}');
            INSERT INTO correction VALUES ('web','description','','defined','"Une description choisie explicitement"','web-origin',NULL,1);"#) .map_err(error)?;
        tx.execute("INSERT INTO image_asset VALUES (?1,'image/png',?2,?3)",rusqlite::params![hash,bytes.len() as i64,hash.clone()]).map_err(error)?;
        tx.execute("INSERT INTO correction VALUES ('web','cover','','defined',?1,'web-origin',?2,1)",rusqlite::params![json!({"sha256":hash}).to_string(),hash]).map_err(error)?;
        Ok(())
    }).unwrap();
    let path = source.root.join("web-roundtrip.zip");
    let plan = source.store.plan_catalogue_export(path.clone(), 0).unwrap();
    {
        let registry = source.store.backup_exports.lock().unwrap();
        export::write_archive(
            &source.store,
            &registry.plans[&plan.plan_id],
            &AtomicBool::new(false),
            |_| {},
            || Ok(()),
        )
        .unwrap();
    }
    let target = Fixture::new();
    let p = target.prepare(&path).unwrap();
    target.apply(&p, BTreeMap::new()).unwrap();
    target.store.clean_images().unwrap();
    assert_eq!(target.count("image_asset"), 1);
    let evidence = target
        .store
        .read_snapshot(|c| {
            c.query_row(
                "SELECT url,locator_json FROM provenance WHERE url IS NOT NULL",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
        })
        .unwrap();
    assert_eq!(evidence.0, "https://example.org/origin");
    assert!(evidence.1.contains("pastedText"));
    let description: String = target
        .store
        .read_snapshot(|c| {
            c.query_row(
                "SELECT value_json FROM correction WHERE field='description'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(description.contains("Une description choisie"));
    assert_eq!(fs::read_dir(target.store.images_root()).unwrap().count(), 1);
}

#[test]
fn web_tag_membership_origin_survives_portable_backup() {
    let source = Fixture::new();
    source.store.write(|tx|tx.execute_batch("INSERT INTO fiche VALUES ('web-tag',1,0,0);INSERT INTO tag VALUES ('tag','Aventure','aventure',1);INSERT INTO tag_member VALUES ('tag','web-tag');INSERT INTO enrichment_tag_origin VALUES ('tag','web-tag','{\"url\":\"https://example.org/work\",\"retrievedAt\":1900000000,\"mechanism\":\"jsonLd\",\"passage\":\"Catégorie : Aventure\"}');").map_err(error)).unwrap();
    let path = source.root.join("tag-origin.zip");
    let plan = source.store.plan_catalogue_export(path.clone(), 0).unwrap();
    {
        let registry = source.store.backup_exports.lock().unwrap();
        export::write_archive(
            &source.store,
            &registry.plans[&plan.plan_id],
            &AtomicBool::new(false),
            |_| {},
            || Ok(()),
        )
        .unwrap();
    }
    let target = Fixture::new();
    let prepared = target.prepare(&path).unwrap();
    target.apply(&prepared, BTreeMap::new()).unwrap();
    assert_eq!(target.count("enrichment_tag_origin"), 1);
    let origin: String = target
        .store
        .read_snapshot(|c| {
            c.query_row(
                "SELECT provenance_json FROM enrichment_tag_origin",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&origin).unwrap()["passage"],
        "Catégorie : Aventure"
    );
}

#[test]
fn forgotten_import_is_absent_from_next_export() {
    let f = Fixture::new();
    let doc = Fixture::document();
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let id = p.plan.cards["card"].clone();
    f.apply(&p, BTreeMap::new()).unwrap();
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO import_reference VALUES (?1,'null')", [&id])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let revision = f.store.get_card(&id).unwrap()["ficheRevision"]
        .as_i64()
        .unwrap();
    f.store.mutate(serde_json::from_value(json!({"kind":"forgetUnreferencedCards","requestKey":"forget-import","ficheIds":[id],"expectedFicheRevisions":{id.clone():revision}})).unwrap(),1).unwrap();
    let snapshot = f.store.backup_snapshot(2).unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert!(exported["corrections"].as_array().unwrap().is_empty());
    for card in exported["cards"].as_array().unwrap() {
        assert!(card.get("importedReference").is_none());
    }
    assert_eq!(f.count("pending_import"), 0);
    assert_eq!(f.count("import_reference"), 0);
}

#[test]
fn integrated_documents_do_not_duplicate_rows_across_roundtrips() {
    let mut doc = Fixture::document();
    for key in validate::ARRAYS {
        doc[*key] = json!([]);
    }
    doc["cards"] = json!((0..100_001)
        .map(|i| json!({"id":format!("c{i}"),"createdAt":0,"favorite":0,"revision":0}))
        .collect::<Vec<_>>());
    validate::document(&doc).unwrap();
    // Exercise compaction at the format limit without creating 100,001 operations.
    let f = Fixture::new();
    f.store
        .write(|tx| {
            super::relations::trim_retained(tx, &mut doc, &[], "other")?;
            Ok(())
        })
        .unwrap();
    assert!(doc["cards"].as_array().unwrap().is_empty());
    let legacy = Fixture::document();
    let prepared = f.prepare(&f.archive(&legacy)).unwrap();
    f.apply(&prepared, BTreeMap::new()).unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO pending_import VALUES (?1,'old-full-document',?2)",
                params![
                    legacy["originCatalogueId"].as_str().unwrap(),
                    legacy.to_string()
                ],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let snapshot = f.store.backup_snapshot(1).unwrap();
    let compacted: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert!(compacted.get("retainedImports").is_none());
    // Planning is read-only; compaction affects the portable snapshot only.
    assert_eq!(f.count("pending_import"), 1);
    let mut portable = Fixture::document();
    for _ in 0..3 {
        let next = Fixture::new();
        let p = next.prepare(&next.archive(&portable)).unwrap();
        next.apply(&p, BTreeMap::new()).unwrap();
        let snapshot = next.store.backup_snapshot(1).unwrap();
        portable = serde_json::from_slice(&snapshot.catalogue).unwrap();
        validate::document(&portable).unwrap();
        assert_eq!(next.count("pending_import"), 0);
        assert_eq!(portable["cards"].as_array().unwrap().len(), 1);
        assert_eq!(portable["corrections"].as_array().unwrap().len(), 3);
    }
}

#[test]
fn label_collisions_and_name_permutations_preserve_local_memberships() {
    let kind = "tag";
    let f = Fixture::new();
    let mut doc = Fixture::document();
    let table = "tags";
    doc[table] = json!([{"id":"a","label":"A","revision":1},{"id":"b","label":"B","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"a","ficheId":"card"},{"tagId":"b","ficheId":"card"}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    let a = p.plan.labels[&(kind.into(), "a".into())].clone();
    let b = p.plan.labels[&(kind.into(), "b".into())].clone();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO tag_member VALUES (?1,?2)",
                params![a, p.plan.cards["card"]],
            )
            .map_err(error)?;
            tx.execute(
                "UPDATE tag SET label='C',normalized_label='c' WHERE id=?1",
                [&a],
            )
            .map_err(error)?;
            tx.execute("INSERT INTO tag VALUES ('collision','A','a',1)", [])
                .map_err(error)?;
            tx.execute(
                "INSERT INTO tag_member VALUES ('collision',?1)",
                [&p.plan.cards["card"]],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    assert_eq!(f.count(kind), 3);
    let local_members: i64 = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT count(*) FROM tag_member WHERE tag_id=?1",
                [&a],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(local_members, 1);
    // Swap both incoming labels: unique keys must never collide mid-transaction.
    doc[table][0]["label"] = json!("B");
    doc[table][1]["label"] = json!("A");
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    assert!(f
        .store
        .read(
            |c| c.query_row("SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)", [&b], |r| {
                r.get::<_, bool>(0)
            })
        )
        .unwrap());
}

#[test]
fn reconcile_keeps_empty_imported_reference_and_tag_origin_with_target_priority() {
    for collision in [false, true] {
        let f = Fixture::new();
        f.local();
        let mut doc = Fixture::document();
        doc["references"] = json!([]);
        doc["referenceValues"] = json!([]);
        let path = f.archive(&doc);
        let first = f.prepare(&path).unwrap();
        let waiting = first.plan.cards["card"].clone();
        f.apply(&first, BTreeMap::new()).unwrap();
        let marker =
            json!({"ficheId":"original","exemplarId":"selected","selectedAt":1,"revision":1});
        f.store.write(|tx|{
            tx.execute("INSERT INTO import_reference VALUES (?1,?2)",params![waiting,marker.to_string()]).map_err(error)?;
            tx.execute_batch("INSERT INTO tag VALUES ('web-tag','Famille','famille',1)").map_err(error)?;
            tx.execute("INSERT INTO tag_member VALUES ('web-tag',?1)",[&waiting]).map_err(error)?;
            tx.execute("INSERT INTO enrichment_tag_origin VALUES ('web-tag',?1,'{\"url\":\"https://example.org/waiting\"}')",[&waiting]).map_err(error)?;
            if collision {tx.execute_batch("INSERT INTO import_reference VALUES ('local','null');INSERT INTO tag_member VALUES ('web-tag','local');INSERT INTO enrichment_tag_origin VALUES ('web-tag','local','{\"url\":\"https://example.org/target\"}')").map_err(error)?;}
            Ok(())
        }).unwrap();
        let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
        let associations = BTreeMap::from([("card".into(), "local".into())]);
        let plan = f
            .store
            .write(|tx| matching::plan(tx, &staged, "reconcile", &associations))
            .unwrap();
        assert_eq!(
            plan.preview
                .conflicts
                .iter()
                .any(|c| c.target["kind"] == "pendingReferenceBundle"),
            collision
        );
        let p = Prepared {
            staged,
            plan,
            source: path,
            created: Instant::now(),
            associations,
        };
        f.apply(&p, BTreeMap::new()).unwrap();
        let source: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT reference_json FROM import_reference WHERE fiche_id='local'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&source).unwrap(),
            if collision {
                Value::Null
            } else {
                marker.clone()
            }
        );
        let origin: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT provenance_json FROM enrichment_tag_origin WHERE fiche_id='local'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(origin.contains(if collision { "/target" } else { "/waiting" }));
        let snapshot = f
            .store
            .backup_snapshot(f.store.list_sources().unwrap().catalogue_revision)
            .unwrap();
        let portable: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
        assert_eq!(
            portable["cards"][0]["importedReference"],
            if collision { Value::Null } else { marker }
        );

        use std::io::Write;
        let root = f.root.join("reference-rescan");
        fs::create_dir(&root).unwrap();
        let path = root.join("pack.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("story.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(json!({"title":"Local source","stageNodes":[{"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","squareOne":true}]}).to_string().as_bytes()).unwrap();
        zip.finish().unwrap();
        let before = fs::read(&path).unwrap();
        f.store.add_source(&root, 0, false).unwrap();
        let receipt = f
            .store
            .start_scan(
                None,
                "reference-rescan".into(),
                f.store.list_sources().unwrap().sources_revision,
                f.root.join("cache"),
                f.root.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        assert_eq!(
            wait(&f.store, &serde_json::to_value(receipt).unwrap()).status,
            "success"
        );
        assert_eq!(f.count("reference_source"), 0);
        assert_eq!(f.count("import_reference"), 1);
        assert_eq!(fs::read(path).unwrap(), before);
    }
}

#[test]
fn large_valid_import_can_be_exported_again_without_row_amplification() {
    let f = Fixture::new();
    let mut doc = Fixture::document();
    for key in validate::ARRAYS {
        doc[*key] = json!([]);
    }
    doc["cards"] = json!((0..100_001)
        .map(|i| json!({"id":format!("c{i}"),"createdAt":0,"favorite":0,"revision":0}))
        .collect::<Vec<_>>());
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    let snapshot = f.store.backup_snapshot(1).unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(exported["cards"].as_array().unwrap().len(), 100_001);
    assert!(exported.get("retainedImports").is_none());
    validate::document(&exported).unwrap();
    assert!((snapshot.catalogue.len() as u64) < format::MAX_JSON);
}
#[test]
fn lunii_fiche_values_and_locale_roundtrip_without_the_internal_database() {
    let source = Fixture::new();
    source.store.write(|tx|{tx.execute_batch("INSERT INTO fiche VALUES ('official-card',1,0,0);INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','official-card','{}');").map_err(error)?;Ok(())}).unwrap();
    let raw = json!({"one":{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","authors":[{"name":"Portable author"}],"age_min":5,"keywords":"lune,voyage","localized_infos":{"fr_FR":{"title":"Titre conservé","description":"Description conservée","subtitle":"Sous-titre","image":{"image_url":"/public/images/packs/test.png"}},"it_IT":{"title":"Titolo"}}}});
    let official = source.root.join("official.json");
    fs::write(&official, raw.to_string()).unwrap();
    source.store.set_lunii_permission(true).unwrap();
    source.store.lunii_locale("fr").unwrap();
    source.store.load_lunii_fixture(&official).unwrap();
    let key = source
        .store
        .read(|c| crate::services::catalogue::lunii_db::values(c, "official-card"))
        .unwrap()
        .0["cover"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let image = crate::services::catalogue::thumbnails::encode_bounded(include_bytes!(
        "../../../../icons/32x32.png"
    ))
    .unwrap();
    source
        .store
        .retain_lunii_cover("official-card", &key, &image)
        .unwrap();
    let original_cover = serde_json::to_value(
        source
            .store
            .lunii_thumbnail("official-card")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let mut tool_only = raw.clone();
    tool_only["one"]["uuid"] = json!("99999999-2222-4333-8444-555555555555");
    tool_only["one"]["localized_infos"]["fr_FR"]["title"] = json!("INTERNAL_DATABASE_ONLY");
    fs::write(&official, tool_only.to_string()).unwrap();
    source.store.load_lunii_fixture(&official).unwrap();
    let revision = source.store.list_sources().unwrap().catalogue_revision;
    let path = source.root.join("lunii.zip");
    let plan = source
        .store
        .plan_catalogue_export(path.clone(), revision)
        .unwrap();
    {
        let registry = source.store.backup_exports.lock().unwrap();
        export::write_archive(
            &source.store,
            &registry.plans[&plan.plan_id],
            &AtomicBool::new(false),
            |_| {},
            || Ok(()),
        )
        .unwrap();
    }
    let file = fs::File::open(&path).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("catalogue.json").unwrap(), &mut text).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    assert!(!text.contains("INTERNAL_DATABASE_ONLY"));
    assert!(doc.get("lunii_pack").is_none());
    assert!(doc.get("lunii_state").is_none());
    assert!(doc["provenances"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["kind"] == "lunii" && p["language"] == "fr_FR"));
    let target = Fixture::new();
    let prepared = target.prepare(&path).unwrap();
    target.apply(&prepared, BTreeMap::new()).unwrap();
    assert_eq!(target.count("lunii_pack"), 0);
    assert_eq!(target.count("lunii_filled"), 1);
    assert_eq!(target.count("correction"), 0);
    assert_eq!(target.count("image_asset"), 1);
    let id = target
        .store
        .read(|c| c.query_row("SELECT id FROM fiche", [], |r| r.get::<_, String>(0)))
        .unwrap();
    assert_eq!(
        serde_json::to_value(target.store.lunii_thumbnail(&id).unwrap().unwrap()).unwrap(),
        original_cover
    );
    target.store.lunii_locale("it").unwrap();
    let card = target.store.get_card(&id).unwrap();
    assert_eq!(
        card["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field"] == "title")
            .unwrap()["effective"]["value"],
        "Titolo"
    );
    let author = card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == "author")
        .unwrap();
    assert_eq!(author["effective"]["value"], "Portable author");
    assert_eq!(author["effective"]["origin"], "lunii");
    assert!(author["referenceValue"]["provenanceId"].is_string());
    assert_eq!(
        target
            .store
            .read(|c| crate::services::catalogue::lunii_db::values(c, &id))
            .unwrap()
            .1
            .as_deref(),
        Some("it_IT")
    );
}

#[test]
fn different_lunii_backup_values_keep_current_without_conflict_and_manual_wins() {
    let f = Fixture::new();
    f.store.lunii_locale("fr").unwrap();
    f.store.write(|tx| {
        tx.execute_batch("INSERT INTO fiche VALUES ('local',0,0,0); INSERT INTO pack_identity VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','local','{}'); INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('local','title','@lunii:fr_FR','\"Current\"','official',NULL);").map_err(error)?;
        Ok(())
    }).unwrap();
    let mut doc = identified();
    doc["cards"][0]["favorite"] = json!(0);
    doc["corrections"] = json!([]);
    doc["references"] = json!([]);
    doc["referenceValues"] = json!([{"ficheId":"card","field":"title","language":"@lunii:fr_FR","value":"Incoming","provenanceId":"remote-lunii","imageSha256":null}]);
    doc["provenances"] = json!([{"id":"remote-lunii","kind":"lunii","language":"fr_FR"}]);
    let path = f.archive(&doc);
    let prepared = f.prepare(&path).unwrap();
    assert!(prepared.plan.preview.conflicts.is_empty());
    f.apply(&prepared, BTreeMap::new()).unwrap();
    assert_eq!(
        f.store
            .read(|c| crate::services::catalogue::lunii_db::values(c, "local"))
            .unwrap()
            .0["title"],
        "Current"
    );
    doc["corrections"] = json!([{"ficheId":"card","field":"title","language":"","state":"defined","value":"Personal","provenanceId":"remote-manual","imageSha256":null}]);
    doc["provenances"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"remote-manual","kind":"manual"}));
    let path = f.archive(&doc);
    let prepared = f.prepare(&path).unwrap();
    assert!(prepared.plan.preview.conflicts.is_empty());
    f.apply(&prepared, BTreeMap::new()).unwrap();
    assert_eq!(
        f.store
            .read(|c| crate::services::catalogue::data::card::resolution(c, "local", &[]))
            .unwrap()
            .values["title"],
        "Personal"
    );
}

#[test]
fn waiting_lunii_values_reconcile_without_conflicts_and_keep_the_current_card() {
    for (has_local, pack_conflict) in [(false, false), (true, false), (false, true), (true, true)] {
        let f = Fixture::new();
        f.store.lunii_locale("fr").unwrap();
        let mut doc = Fixture::document();
        doc["cards"][0]["favorite"] = json!(0);
        doc["cards"][0]["luniiFilled"] = json!(true);
        for table in [
            "corrections",
            "references",
            "referenceValues",
            "provenances",
        ] {
            doc[table] = json!([]);
        }
        let path = f.archive(&doc);
        let archive_before = fs::read(&path).unwrap();
        let first = f.prepare(&path).unwrap();
        let waiting = first.plan.cards["card"].clone();
        f.apply(&first, BTreeMap::new()).unwrap();
        f.store.write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('local',0,0,0); INSERT INTO provenance(id,kind,language) VALUES ('waiting-official','lunii','fr_FR'),('current-official','lunii','fr_FR');").map_err(error)?;
            tx.execute("INSERT INTO reference_value VALUES (?1,'title','@lunii:fr_FR','\"Waiting\"','waiting-official',NULL)", [&waiting]).map_err(error)?;
            if has_local {
                tx.execute_batch("INSERT INTO reference_value VALUES ('local','title','@lunii:fr_FR','\"Current\"','current-official',NULL); INSERT INTO lunii_filled(fiche_id) VALUES ('local');").map_err(error)?;
            }
            if pack_conflict {
                tx.execute_batch("INSERT INTO provenance(id,kind) VALUES ('pack-reference','file'); INSERT INTO reference_value VALUES ('local','description','','\"Local pack\"','pack-reference',NULL);").map_err(error)?;
                tx.execute("INSERT INTO reference_value VALUES (?1,'description','','\"Waiting pack\"','pack-reference',NULL)", [&waiting]).map_err(error)?;
            }
            Ok(())
        }).unwrap();
        let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
        let associations = BTreeMap::from([("card".into(), "local".into())]);
        let plan = f
            .store
            .write(|tx| matching::plan(tx, &staged, "reconcile", &associations))
            .unwrap();
        assert_eq!(plan.preview.conflicts.len(), usize::from(pack_conflict));
        for conflict in &plan.preview.conflicts {
            assert_eq!(conflict.target["kind"], "pendingReferenceBundle");
            assert!(conflict.incoming["values"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v["field"] != "title"));
        }
        let choices = plan
            .preview
            .conflicts
            .iter()
            .map(|c| (c.id.clone(), "incoming".into()))
            .collect();
        let prepared = Prepared {
            staged,
            plan,
            source: path.clone(),
            created: Instant::now(),
            associations,
        };
        f.apply(&prepared, choices).unwrap();
        assert_eq!(f.count("fiche"), 1);
        assert_eq!(
            f.store
                .read(|c| crate::services::catalogue::lunii_db::values(c, "local"))
                .unwrap()
                .0["title"],
            if has_local { "Current" } else { "Waiting" }
        );
        assert_eq!(fs::read(&path).unwrap(), archive_before);
        assert_eq!(f.count("lunii_filled"), 1);
    }
}

fn empty_document() -> Value {
    let mut doc = Fixture::document();
    for key in validate::ARRAYS {
        doc[*key] = json!([]);
    }
    doc
}
#[test]
fn malformed_official_provenance_is_rejected_in_both_value_tables() {
    for table in ["corrections", "referenceValues"] {
        let f = Fixture::new();
        f.local();
        let mut doc = identified();
        doc["provenances"] = json!([{"id":"rl","kind":"lunii","language":"fr_FR"}]);
        doc["corrections"] = json!([]);
        doc[table] = json!([{"ficheId":"card","field":"title","language":"","state":"defined","value":"OVERWRITE","provenanceId":"rl","imageSha256":null}]);
        assert_eq!(
            f.prepare(&f.archive(&doc)).err().unwrap().code,
            codes::CATALOG_IMPORT_INVALID
        );
        let title: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT value_json FROM correction WHERE fiche_id='local'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(title, "\"Local\"");
    }
}
fn seed_reference(f: &Fixture) {
    f.local();
    f.store.write(|tx| {
        tx.execute_batch("INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,created_at) VALUES ('ex','local','{}','{}',1,1); INSERT INTO reference_source VALUES ('local','ex',1,1); INSERT INTO reference_value VALUES ('local','title','','\"Pack title\"','local-provenance',NULL);").map_err(error)?;
        Ok(())
    }).unwrap();
}
#[test]
fn unchanged_reference_roundtrips_without_conflicts_and_stays_active() {
    let f = Fixture::new();
    seed_reference(&f);
    let snapshot = f.store.backup_snapshot(0).unwrap();
    let doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert!(p.plan.preview.conflicts.is_empty());
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    assert_eq!(f.count("reference_source"), 1);
    assert_eq!(f.count("import_reference"), 0);
    let other = Fixture::new();
    let path = other.archive(&doc);
    let p = other.prepare(&path).unwrap();
    other.apply(&p, BTreeMap::new()).unwrap();
    let again = other.prepare(&path).unwrap();
    assert!(!again
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "referenceBundle"));
}
#[test]
fn changed_reference_reuses_same_catalogue_exemplar_and_marks_foreign_replacement() {
    let f = Fixture::new();
    seed_reference(&f);
    let snapshot = f.store.backup_snapshot(0).unwrap();
    let mut doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    doc["referenceValues"][0]["value"] = json!("Changed");
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let c = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "referenceBundle")
        .unwrap();
    assert_ne!(c.target["requiresIndividualChoice"], true);
    f.apply(&p, BTreeMap::from([(c.id.clone(), "incoming".into())]))
        .unwrap();
    assert_eq!(f.count("reference_source"), 1);
    assert_eq!(f.count("import_reference"), 0);
    doc["originCatalogueId"] = json!("foreign");
    let p = f.prepare(&f.archive(&doc)).unwrap();
    // Make an actual value conflict, not just different transport provenance.
    assert!(!p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "referenceBundle"));
    doc["referenceValues"][0]["value"] = json!("Foreign");
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert_eq!(
        p.plan
            .preview
            .conflicts
            .iter()
            .find(|c| c.target["kind"] == "referenceBundle")
            .unwrap()
            .target["requiresIndividualChoice"],
        true
    );
}
#[test]
fn grouped_member_association_is_rejected_and_canonical_reference_is_untouched() {
    let f = Fixture::new();
    seed_reference(&f);
    f.store.write(|tx| {tx.execute_batch("INSERT INTO fiche VALUES ('member',1,0,1);INSERT INTO fiche_grouping VALUES ('member','local');").map_err(error)?;Ok(())}).unwrap();
    let doc = Fixture::document();
    let path = f.archive(&doc);
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let result = f
        .store
        .read_snapshot(|c| {
            Ok(matching::plan(
                c,
                &staged,
                "preview",
                &BTreeMap::from([("card".into(), "member".into())]),
            ))
        })
        .unwrap();
    assert_eq!(
        result.err().unwrap().code,
        codes::CATALOG_IMPORT_ASSOCIATION_INVALID
    );
    assert_eq!(f.count("reference_source"), 1);
}
#[test]
fn saved_identity_collision_does_not_move_the_existing_owner() {
    let f = Fixture::new();
    f.local();
    let second = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    f.store
        .write(|tx| {
            tx.execute_batch("INSERT INTO fiche VALUES ('other',1,0,1);")
                .map_err(error)?;
            tx.execute(
                "INSERT INTO saved_pack_identity VALUES (?1,'local','{}')",
                ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO pack_identity VALUES (?1,'other','{}')",
                [second],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let mut doc = identified();
    doc["identities"]
        .as_array_mut()
        .unwrap()
        .push(json!({"packUuid":second,"ficheId":"card","provenance":{}}));
    // Mixed UUID evidence stays on a waiting card without moving either owner.
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert_ne!(p.plan.cards["card"], "local");
    assert_ne!(p.plan.cards["card"], "other");
    f.apply(&p, BTreeMap::new()).unwrap();
    let other: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT fiche_id FROM pack_identity WHERE pack_uuid=?1",
                [second],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(other, "other");
    assert_eq!(f.count("saved_pack_identity"), 1);
    assert_eq!(f.count("pending_import"), 1);
    let owner:String=f.store.read(|c|c.query_row("SELECT fiche_id FROM saved_pack_identity WHERE pack_uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'",[],|r|r.get(0))).unwrap();
    assert_eq!(owner, "local");
}
#[test]
fn age_bounds_have_one_choice_and_cannot_be_mixed() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx|{tx.execute_batch("INSERT INTO correction VALUES ('local','ageMin','','defined','8','local-provenance',NULL,1); INSERT INTO correction VALUES ('local','ageMax','','defined','10','local-provenance',NULL,1);").map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMin","language":"","state":"defined","value":1,"provenanceId":"manual","imageSha256":null},{"ficheId":"card","field":"ageMax","language":"","state":"defined","value":3,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert!(!p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "corrections"));
    let age = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "ageRange")
        .unwrap();
    f.apply(&p, BTreeMap::from([(age.id.clone(), "incoming".into())]))
        .unwrap();
    let bounds:Vec<String>=f.store.read(|c|c.prepare("SELECT value_json FROM correction WHERE field IN ('ageMin','ageMax') ORDER BY field")?.query_map([],|r|r.get(0))?.collect()).unwrap();
    assert_eq!(bounds, vec!["3", "1"]);
}
#[cfg(unix)]
#[test]
fn selected_backup_symlink_is_read_through_a_private_copy() {
    let f = Fixture::new();
    let path = f.archive(&Fixture::document());
    let link = f.root.join("link.zip");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(f.prepare(&link).is_ok());
}
#[test]
#[ignore = "release volume benchmark; run explicitly"]
fn linked_rows_at_portable_limit_release_benchmark() {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "run with --release"
    );
    let f = Fixture::new();
    let mut doc = empty_document();
    let n = format::MAX_ROWS / 6;
    let started = Instant::now();
    let mut cards = Vec::with_capacity(n);
    let mut identities = Vec::with_capacity(n);
    let mut provenances = Vec::with_capacity(n);
    let mut values = Vec::with_capacity(n * 3);
    for i in 0..n {
        let id = format!("c{i}");
        let provenance = format!("p{i}");
        cards.push(json!({"id":id,"createdAt":0,"favorite":0,"revision":0}));
        identities.push(json!({"ficheId":id,"packUuid":uuid::Uuid::from_u128(i as u128).to_string(),"provenance":{}}));
        provenances.push(json!({"id":provenance,"kind":"file"}));
        for (field, value) in [
            ("title", json!("Title")),
            ("author", json!("Author")),
            ("versionDeclared", json!(1)),
        ] {
            values.push(json!({"ficheId":id,"field":field,"language":"","value":value,"imageSha256":null,"provenanceId":provenance}));
        }
    }
    doc["rootHints"] = json!(vec!["informational"; format::MAX_ROWS % 6]);
    doc["cards"] = Value::Array(cards);
    doc["identities"] = Value::Array(identities);
    doc["provenances"] = Value::Array(provenances);
    doc["referenceValues"] = Value::Array(values);
    eprintln!(
        "volume cards={n} rows={} generation={:?}",
        format::MAX_ROWS,
        started.elapsed()
    );
    let path = f.archive(&doc);
    drop(doc);
    let start = Instant::now();
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let validation = start.elapsed();
    let start = Instant::now();
    let plan = f
        .store
        .read_snapshot(|c| Ok(matching::plan(c, &staged, "volume", &BTreeMap::new())))
        .unwrap()
        .unwrap();
    let planning = start.elapsed();
    eprintln!("volume validation={validation:?} planning={planning:?}");
    assert_eq!(plan.cards.len(), n);
    assert!(validation.as_secs() < 180);
    assert!(planning.as_secs() < 180);
}

#[test]
fn age_additions_apply_by_default_and_partial_inversion_requires_an_individual_choice() {
    let f = Fixture::new();
    f.local();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMin","language":"","state":"defined","value":8,"provenanceId":"manual","imageSha256":null},{"ficheId":"card","field":"ageMax","language":"","state":"defined","value":10,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert!(p
        .plan
        .preview
        .additions
        .iter()
        .any(|a| a["kind"] == "ageRange"));
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(
        f.store
            .read(|c| c.query_row(
                "SELECT value_json FROM correction WHERE field='ageMin'",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        "8"
    );
    // REVb2 P2-A: the default keeps 8-10, so the preview is no longer refused;
    // only the inverting alternative leaves the global choice.
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMax","language":"","state":"defined","value":3,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let age = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "ageRange")
        .unwrap();
    assert_eq!(age.target["requiresIndividualChoice"], true);
    assert_eq!(age.target["individualChoiceReason"], "ageInterval");
    let error = f
        .apply(&p, BTreeMap::from([(age.id.clone(), "incoming".into())]))
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT);
    assert_eq!(error.params["title"], "Local");
    assert_eq!(age_bounds(&f, "local"), ["10", "8"]);
}
fn age_bounds(f: &Fixture, id: &str) -> Vec<String> {
    f.store.read(|c| c.prepare("SELECT value_json FROM correction WHERE fiche_id=?1 AND field IN ('ageMin','ageMax') ORDER BY field")?.query_map([id], |r| r.get(0))?.collect()).unwrap()
}
/// Choices sent by the client for a global "incoming" choice (`conflictChoice`).
fn global_incoming(p: &Prepared) -> BTreeMap<String, String> {
    p.plan
        .preview
        .conflicts
        .iter()
        .map(|c| {
            let choice = if c.target["requiresIndividualChoice"] == true {
                "local"
            } else {
                "incoming"
            };
            (c.id.clone(), choice.into())
        })
        .collect()
}
#[test]
fn membership_additions_and_waiting_card_reconciliation_are_visible() {
    let f = Fixture::new();
    let mut doc = identified();
    doc["tags"] = json!([{"id":"tag","label":"Tag","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"tag","ficheId":"card"}]);
    doc["cards"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"second","createdAt":1,"favorite":0,"revision":0}));
    doc["tagMembers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"tagId":"tag","ficheId":"second"}));
    let path = f.archive(&doc);
    let p = f.prepare(&path).unwrap();
    assert_eq!(
        p.plan
            .preview
            .additions
            .iter()
            .filter(|a| a["kind"] == "membership")
            .count(),
        1
    );
    assert!(p
        .plan
        .preview
        .additions
        .iter()
        .filter(|a| a["kind"] == "membership")
        .all(|a| a["incoming"]["count"] == 2));
    f.apply(&p, BTreeMap::new()).unwrap();
    let old = p.plan.cards["card"].clone();
    f.local();
    let next = f.prepare(&path).unwrap();
    assert!(next
        .plan
        .preview
        .changes
        .iter()
        .any(|a| a["kind"] == "reconcile"
            && a["incoming"]["from"] == old
            && a["incoming"]["to"] == "local"));
}
#[test]
fn cancelled_validation_and_plan_never_wait_for_application() {
    let f = Fixture::new();
    let doc = identified();
    let path = f.archive(&doc);
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let cancelled = AtomicBool::new(true);
    assert!(matching::validate_cancellable(&doc, &cancelled).is_err());
    assert!(f
        .store
        .read_snapshot(|c| Ok(matching::plan_cancellable(
            c,
            &staged,
            "cancelled",
            &BTreeMap::new(),
            &cancelled
        )))
        .unwrap()
        .is_err());
    assert_eq!(f.count("fiche"), 0);
}
#[test]
fn preview_computation_keeps_the_writer_available_and_pins_its_revision() {
    let f = Fixture::new();
    let path = f.archive(&identified());
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    f.store
        .read_snapshot(|c| {
            let other = Arc::clone(&f.store);
            let (send, recv) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                send.send(other.write(|tx| {
                    tx.execute("UPDATE catalogue SET revision=revision+1", [])
                        .map_err(error)?;
                    Ok(())
                }))
                .unwrap();
            });
            recv.recv_timeout(crate::test_support::timeout())
                .expect("preview must not hold the writer")
                .unwrap();
            worker.join().unwrap();
            let plan = matching::plan(c, &staged, "snapshot", &BTreeMap::new()).unwrap();
            assert_eq!(plan.preview.expected_catalogue_revision, 0);
            Ok(())
        })
        .unwrap();
    assert_eq!(f.store.list_sources().unwrap().catalogue_revision, 1);
}
#[test]
fn portable_row_limit_has_a_dedicated_export_code_and_import_code() {
    let mut doc = empty_document();
    doc["rootHints"] = json!(vec![""; format::MAX_ROWS + 1]);
    assert_eq!(
        validate::document(&doc).err().unwrap().code,
        codes::CATALOG_BACKUP_ROW_LIMIT_EXCEEDED
    );
    assert_eq!(
        matching::validate_document(&doc).err().unwrap().code,
        codes::CATALOG_IMPORT_LIMIT_EXCEEDED
    );
}

thread_local! {
    static REVIEW_WORK: std::cell::Cell<[(usize, usize); 3]> = const {std::cell::Cell::new([(0,usize::MAX);3])};
}
pub(super) fn record_review_work(category: usize) {
    REVIEW_WORK.with(|state| {
        let mut work = state.get();
        work[category].0 += 1;
        state.set(work);
        assert!(
            work[category].0 <= work[category].1,
            "work budget exceeded for category {category}: {} > {}",
            work[category].0,
            work[category].1
        );
    });
}
struct ReviewWorkBudget;
impl ReviewWorkBudget {
    fn new(category: usize, limit: usize) -> Self {
        REVIEW_WORK.with(|state| {
            let mut work = state.get();
            work[category] = (0, limit);
            state.set(work);
        });
        Self
    }
}
impl Drop for ReviewWorkBudget {
    fn drop(&mut self) {
        REVIEW_WORK.with(|state| state.set([(0, usize::MAX); 3]));
    }
}
#[test]
fn reconciled_age_additions_survive_default_and_explicit_archive_choices() {
    for archive_choice in [false, true] {
        for waiting_max in [None, Some(9)] {
            let f = Fixture::new();
            f.local();
            f.store.write(|tx| {
                tx.execute_batch("INSERT INTO correction VALUES ('local','ageMax','','defined','10','local-provenance',NULL,1);").map_err(error)?;Ok(())
            }).unwrap();
            let mut doc = Fixture::document();
            doc["corrections"] = json!([{"ficheId":"card","field":"ageMin","language":"","state":"defined","value":1,"provenanceId":"manual","imageSha256":null}]);
            let path = f.archive(&doc);
            let first = f.prepare(&path).unwrap();
            let waiting = first.plan.cards["card"].clone();
            f.apply(&first, BTreeMap::new()).unwrap();
            f.store.write(|tx| {
                tx.execute("UPDATE correction SET value_json='8' WHERE fiche_id=?1 AND field='ageMin'",[&waiting]).map_err(error)?;
                if let Some(max)=waiting_max {tx.execute("INSERT INTO correction VALUES (?1,'ageMax','','defined',?2,'local-provenance',NULL,1)",params![waiting,max.to_string()]).map_err(error)?;}
                tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;Ok(())
            }).unwrap();
            let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
            let associations = BTreeMap::from([("card".into(), "local".into())]);
            let plan = f
                .store
                .read_snapshot(|c| Ok(matching::plan(c, &staged, "age-reconcile", &associations)))
                .unwrap()
                .unwrap();
            let conflict = plan
                .preview
                .conflicts
                .iter()
                .find(|c| c.target["kind"] == "ageRange")
                .unwrap();
            assert_eq!(
                conflict.local["ageMin"]["value"], 8,
                "the preview must retain the reconciled local minimum"
            );
            assert_eq!(conflict.local["ageMax"]["value"], 10);
            let choices = if archive_choice {
                BTreeMap::from([(conflict.id.clone(), "incoming".into())])
            } else {
                BTreeMap::new()
            };
            let p = Prepared {
                staged,
                plan,
                source: path,
                created: Instant::now(),
                associations,
            };
            f.apply(&p, choices).unwrap();
            let bounds:Vec<String>=f.store.read(|c|c.prepare("SELECT value_json FROM correction WHERE fiche_id='local' AND field IN ('ageMin','ageMax') ORDER BY field")?.query_map([],|r|r.get(0))?.collect()).unwrap();
            assert_eq!(
                bounds,
                vec![
                    "10".to_string(),
                    if archive_choice { "1" } else { "8" }.into()
                ]
            );
            assert_eq!(f.count("fiche"), 1);
            assert_eq!(
                f.store
                    .read(|c| c.query_row(
                        "SELECT COUNT(*) FROM correction WHERE fiche_id=?1",
                        [&waiting],
                        |r| r.get::<_, i64>(0)
                    ))
                    .unwrap(),
                0
            );
        }
    }
}
#[test]
fn many_labels_apply_with_linear_action_index_work() {
    let f = Fixture::new();
    let mut doc = empty_document();
    let n = 10_000usize;
    doc["cards"] = Value::Array(
        (0..100)
            .map(|i| json!({"id":format!("card-{i}"),"createdAt":1,"favorite":0,"revision":0}))
            .collect(),
    );
    let table = "tags";
    doc[table] = Value::Array(
        (0..n)
            .map(|i| json!({"id":format!("tag-{i}"),"label":format!("tag {i:05}"),"revision":1}))
            .collect(),
    );

    let p = f.prepare(&f.archive(&doc)).unwrap();
    let _budget = ReviewWorkBudget::new(0, p.plan.actions.len() + n * 2);
    let start = Instant::now();
    f.apply(&p, BTreeMap::new()).unwrap();
    eprintln!("label application: tags={n}, elapsed={:?}", start.elapsed());
    assert_eq!(
        f.count("tag"),
        0,
        "imported labels without a fiche have no lifetime"
    );
    assert_eq!(f.count("fiche"), 100);
    let counts=f.store.read(|c|c.query_row("SELECT COUNT(*),COUNT(DISTINCT local_entity_id) FROM import_identity WHERE entity_type='tag'",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))).unwrap();
    assert_eq!(counts, (n as i64, n as i64));
}
#[test]
fn large_association_component_finds_its_sink_with_linear_work() {
    let f = Fixture::new();
    let mut doc = empty_document();
    let n = 20_000usize;
    doc["cards"] = Value::Array(
        (0..n)
            .map(|i| json!({"id":format!("member-{i:05}"),"createdAt":1,"favorite":0,"revision":0}))
            .collect(),
    );
    doc["associations"]=Value::Array((0..n-1).map(|i|json!({"ficheId":format!("member-{i:05}"),"targetId":format!("member-{:05}",n-1)})).collect());
    let path = f.archive(&doc);
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let _budget = ReviewWorkBudget::new(1, n * 2);
    let start = Instant::now();
    let plan = f
        .store
        .read_snapshot(|c| {
            Ok(matching::plan(
                c,
                &staged,
                "many-associations",
                &BTreeMap::new(),
            ))
        })
        .unwrap()
        .unwrap();
    eprintln!(
        "association planning: members={n}, elapsed={:?}",
        start.elapsed()
    );
    assert_eq!(plan.cards.len(), n);
    assert!(plan
        .preview
        .issues
        .iter()
        .any(|issue| issue == "retained:associations"));
    assert!(!plan.actions.iter().any(|a| a.kind == "group"));
}

#[test]
fn incompatible_reconciliation_and_archive_ages_are_refused_only_when_chosen() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {
        tx.execute_batch("INSERT INTO correction VALUES ('local','ageMin','','defined','1','local-provenance',NULL,1);INSERT INTO correction VALUES ('local','ageMax','','defined','10','local-provenance',NULL,1);").map_err(error)?;
        Ok(())
    }).unwrap();
    let mut doc = Fixture::document();
    doc["corrections"] = json!([
        {"ficheId":"card","field":"ageMin","language":"","state":"defined","value":8,"provenanceId":"manual","imageSha256":null},
        {"ficheId":"card","field":"ageMax","language":"","state":"defined","value":9,"provenanceId":"manual","imageSha256":null}
    ]);
    let first = f.prepare(&f.archive(&doc)).unwrap();
    let waiting = first.plan.cards["card"].clone();
    f.apply(&first, BTreeMap::new()).unwrap();
    doc["corrections"] = json!([
        {"ficheId":"card","field":"ageMax","language":"","state":"defined","value":6,"provenanceId":"manual","imageSha256":null}
    ]);
    // REVb2 P2-A: the default (1-10) is valid, so the preview is accepted. The
    // inverting combination of both incoming choices leaves the global choice
    // and an explicit request is refused at application, naming the fiche.
    let path = f.archive(&doc);
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    let plan = f
        .store
        .read_snapshot(|c| Ok(matching::plan(c, &staged, "ages", &associations)))
        .unwrap()
        .expect("a valid default choice must produce a preview");
    let p = Prepared {
        staged,
        plan,
        source: path,
        created: Instant::now(),
        associations,
    };
    let ages = p
        .plan
        .preview
        .conflicts
        .iter()
        .filter(|c| {
            matches!(
                c.target["kind"].as_str(),
                Some("ageRange" | "pendingAgeRange")
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(ages.len(), 2);
    assert!(ages
        .iter()
        .all(|c| c.target["requiresIndividualChoice"] == true));
    let all = ages
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    let error = f.apply(&p, all).unwrap_err();
    assert_eq!(error.code, codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT);
    assert_eq!(error.params["title"], "Local");
    assert_eq!(age_bounds(&f, "local"), ["10", "1"]);
    assert_eq!(
        f.store
            .read(|c| c.query_row(
                "SELECT COUNT(*) FROM correction WHERE fiche_id=?1",
                [&waiting],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        2
    );
    // A compatible archive still permits choosing both incoming ranges and
    // persists them after reconciliation removes the waiting card.
    doc["corrections"][0]["value"] = json!(12);
    let path = f.archive(&doc);
    let staged = staging::prepare(&f.store, &path, &AtomicBool::new(false)).unwrap();
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    let plan = f
        .store
        .read_snapshot(|c| Ok(matching::plan(c, &staged, "ages-safe", &associations)))
        .unwrap()
        .unwrap();
    let choices = plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(
        &Prepared {
            staged,
            plan,
            source: path,
            created: Instant::now(),
            associations,
        },
        choices,
    )
    .unwrap();
    let bounds: Vec<String> = f.store.read(|c| c.prepare("SELECT value_json FROM correction WHERE fiche_id='local' AND field IN ('ageMin','ageMax') ORDER BY field")?.query_map([], |r| r.get(0))?.collect()).unwrap();
    assert_eq!(bounds, ["12", "8"]);
    assert_eq!(f.count("fiche"), 1);
}

#[test]
fn blocked_label_rename_chains_propagate_with_linear_work() {
    let (table, kind) = ("tags", "tag");
    let f = Fixture::new();
    let n = 1_000usize;
    let mut doc = empty_document();
    doc[table] = Value::Array(
        (0..n)
            .map(
                |i| json!({"id":format!("label-{i}"),"label":format!("Label {i:04}"),"revision":1}),
            )
            .collect(),
    );
    doc["cards"] = json!([{"id":"holder","createdAt":1,"favorite":0,"revision":0}]);
    doc["tagMembers"] = Value::Array(
        (0..n)
            .map(|i| json!({"tagId":format!("label-{i}"),"ficheId":"holder"}))
            .collect(),
    );
    f.apply(&f.prepare(&f.archive(&doc)).unwrap(), BTreeMap::new())
        .unwrap();
    let original_labels: Vec<(String, String)> = f
        .store
        .read(|c| {
            c.prepare("SELECT id,label FROM tag ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO tag VALUES ('stationary',?1,?2,1)",
                params![format!("Label {n:04}"), format!("label {n:04}")],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO tag_member SELECT 'stationary',id FROM fiche LIMIT 1",
                [],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    for (i, row) in doc[table].as_array_mut().unwrap().iter_mut().enumerate() {
        row["label"] = json!(format!("Label {:04}", i + 1));
    }
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert_eq!(p.plan.preview.conflicts.len(), n);
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    let _budget = ReviewWorkBudget::new(2, n * 3);
    f.apply(&p, choices).unwrap();
    assert_eq!(f.count(kind), (n + 1) as i64);
    let after_labels: Vec<(String, String)> = f
        .store
        .read(|c| {
            c.prepare("SELECT id,label FROM tag WHERE id!='stationary' ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .unwrap();
    assert_eq!(after_labels, original_labels);

    let unchanged: i64 = f.store.read(|c| c.query_row("SELECT COUNT(*) FROM tag l JOIN import_identity i ON i.local_entity_id=l.id WHERE i.entity_type=?1 AND l.label=json_extract(i.last_imported_json,'$.label')", [kind], |r| r.get(0))).unwrap();
    assert_eq!(unchanged, n as i64);
    let original: i64 = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM tag WHERE label='Label 0000'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(original, 1);
}

fn export_fixture(f: &Fixture) -> PathBuf {
    let path = f.root.join(format!("export-{}.zip", uuid::Uuid::new_v4()));
    let plan = f
        .store
        .plan_catalogue_export(
            path.clone(),
            f.store.list_sources().unwrap().catalogue_revision,
        )
        .unwrap();
    let registry = f.store.backup_exports.lock().unwrap();
    export::write_archive(
        &f.store,
        &registry.plans[&plan.plan_id],
        &AtomicBool::new(false),
        |_| {},
        || Ok(()),
    )
    .unwrap();
    path
}
fn official_cover(path: &str) -> Value {
    use sha2::{Digest, Sha256};
    json!({"kind":"lunii","key":format!("{:x}",Sha256::digest(path.as_bytes())),"imagePath":path})
}
fn add_official(f: &Fixture, id: &str, cover: &Value, sha: Option<&str>) {
    f.store.write(|tx| {
        tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)",[id]).map_err(error)?;
        tx.execute("INSERT OR IGNORE INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR')",[]).map_err(error)?;
        tx.execute("INSERT INTO reference_value VALUES (?1,'cover','@lunii:fr_FR',?2,'official',?3)",params![id,cover.to_string(),sha]).map_err(error)?;
        tx.execute("INSERT INTO lunii_filled(fiche_id) VALUES (?1)",[id]).map_err(error)?;
        Ok(())
    }).unwrap();
}
#[test]
fn official_backup_deduplicates_keys_restores_missing_payload_and_keeps_user_cover() {
    let source = Fixture::new();
    let cover = official_cover("/public/images/covers/one.jpg");
    add_official(&source, "one", &cover, None);
    let bytes = crate::services::catalogue::thumbnails::encode_bounded(include_bytes!(
        "../../../../icons/32x32.png"
    ))
    .unwrap();
    source
        .store
        .retain_lunii_cover("one", cover["key"].as_str().unwrap(), &bytes)
        .unwrap();
    add_official(&source, "two", &cover, None);
    add_official(
        &source,
        "missing",
        &official_cover("/public/images/covers/missing.jpg"),
        None,
    );
    let absent = "d".repeat(64);
    source
        .store
        .write(|tx| {
            tx.execute(
                "INSERT INTO image_asset VALUES (?1,'image/jpeg',123,?2)",
                params![absent, format!("images/{absent}")],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    add_official(
        &source,
        "missing-file",
        &official_cover("/public/images/missing-file.jpg"),
        Some(&absent),
    );
    let path = export_fixture(&source);
    let target = Fixture::new();
    let p = target.prepare(&path).unwrap();
    assert_eq!(p.staged.manifest.counts.images, 1);
    let id = p.plan.cards["one"].clone();
    target.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(
        target
            .store
            .lunii_cover_bytes(&id, cover["key"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    assert_eq!(target.count("lunii_pack"), 0);
    // A current official reference without its payload acquires only its own key.
    target
        .store
        .write(|tx| {
            tx.execute(
                "UPDATE reference_value SET image_sha256=NULL WHERE fiche_id=?1",
                [&id],
            )
            .map_err(error)?;
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let p = target.prepare(&path).unwrap();
    assert!(!p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "referenceValues"));
    target.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(
        target
            .store
            .lunii_cover_bytes(&id, cover["key"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    target
        .store
        .write(|tx| {
            tx.execute(
                "INSERT INTO provenance(id,kind) VALUES ('user','manual')",
                [],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO correction VALUES (?1,'cover','','cleared',NULL,'user',NULL,1)",
                [&id],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let p = target.prepare(&path).unwrap();
    target.apply(&p, BTreeMap::new()).unwrap();
    assert!(target.store.lunii_thumbnail(&id).unwrap().is_none());
    let sha = validate::payload(&bytes).sha256;
    target.store.write(|tx| {
        tx.execute("UPDATE correction SET state='defined',value_json=?2,image_sha256=?3 WHERE fiche_id=?1",params![id,json!({"sha256":sha}).to_string(),sha]).map_err(error)?;
        tx.execute("UPDATE catalogue SET revision=revision+1",[]).map_err(error)?;
        Ok(())
    }).unwrap();
    let p = target.prepare(&path).unwrap();
    target.apply(&p, BTreeMap::new()).unwrap();
    let user_image: String = target
        .store
        .read(|c| {
            c.query_row(
                "SELECT image_sha256 FROM correction WHERE fiche_id=?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(user_image, sha);
    let registry = source.store.backup_exports.lock().unwrap();
    assert_eq!(
        registry.plans.values().next().unwrap().plan.issues,
        vec!["luniiImageMissing", "luniiImageMissing"]
    );
}
#[test]
fn imported_forgetting_purges_like_local_and_preview_alone_does_nothing() {
    let imported = Fixture::new();
    let local = Fixture::new();
    for f in [&imported, &local] {
        f.local();
        f.store.write(|tx|{tx.execute_batch("INSERT INTO lunii_filled(fiche_id) VALUES ('local'); INSERT INTO lunii_image_attempt VALUES ('local',2); INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR'); INSERT INTO reference_value VALUES ('local','title','@lunii:fr_FR','\"Lunii\"','official',NULL);").map_err(error)?;Ok(())}).unwrap();
        // One shared operation mentions the fiche and records an unrelated
        // decision next to one about the fiche.
        f.store.write(|tx|{tx.execute_batch("INSERT INTO operation VALUES ('shared','test','committed','shared',0,0,'{\"ficheIds\":[\"local\"]}'); INSERT INTO operation_change VALUES ('shared','fiche','local','{}','{}',1); INSERT INTO suggestion_decision VALUES ('kept','[\"x\",\"y\"]','{}','refused','shared'); INSERT INTO suggestion_decision VALUES ('gone','[\"local\",\"y\"]','{}','refused','shared');").map_err(error)?;Ok(())}).unwrap();
    }
    let mut doc = identified();
    doc["forgottenCards"] = json!([{"ficheId":"card"}]);
    let p = imported.prepare(&imported.archive(&doc)).unwrap();
    assert!(p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "forgotten"));
    assert_eq!(imported.count("correction"), 1);
    assert_eq!(imported.count("fiche_forgotten"), 0);
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    imported.apply(&p, choices).unwrap();
    local.store.mutate(serde_json::from_value(json!({"kind":"forgetUnreferencedCards","requestKey":"local-forget","ficheIds":["local"],"expectedFicheRevisions":{"local":1}})).unwrap(),0).unwrap();
    for table in [
        "correction",
        "reference_value",
        "reference_source",
        "tag_member",
        "lunii_filled",
        "lunii_image_attempt",
        "fiche_forgotten",
        "pending_import",
    ] {
        assert_eq!(imported.count(table), local.count(table), "{table}");
    }
    // BKc2 P3-3: same final content, not only the same number of rows.
    let content = |f: &Fixture| -> Vec<String> {
        f.store
            .read(|c| {
                let mut out = vec![crate::services::catalogue::data::card::snapshot(c, "local")
                    .unwrap()
                    .map(|v| v.to_string())
                    .unwrap_or_default()];
                for sql in [
                    "SELECT json_group_array(json_array(id,favorite)) FROM fiche WHERE id='local'",
                    "SELECT json_group_array(json_array(key,participants_json,decision,operation_id)) FROM (SELECT * FROM suggestion_decision ORDER BY key)",
                    "SELECT json_group_array(json_array(exemplar_id,known_fiche_id)) FROM identity_convergence",
                    "SELECT count(*) FROM import_identity WHERE local_entity_id='local' OR instr(last_imported_json,'local')>0",
                    "SELECT count(*) FROM operation_change WHERE entity_id='local' OR instr(before_json,'local')>0 OR instr(after_json,'local')>0",
                    "SELECT count(*) FROM association_event WHERE instr(evidence_json||before_json||after_json,'local')>0",
                    "SELECT json_group_array(json_array(id,recovery_json)) FROM operation WHERE id='shared'",
                ] {
                    out.push(c.query_row(sql, [], |r| r.get::<_, rusqlite::types::Value>(0)).map(|v| format!("{v:?}"))?);
                }
                Ok(out)
            })
            .unwrap()
    };
    let expected = content(&local);
    assert_eq!(content(&imported), expected);
    assert!(expected[2].contains("kept") && !expected[2].contains("gone"));
}
#[test]
fn imported_forgetting_refuses_covered_card_atomically() {
    for covered in [false, true] {
        let f = Fixture::new();
        f.local();
        let root = f.root.join("packs");
        fs::create_dir(&root).unwrap();
        let pack = root.join("pack.zip");
        fs::write(&pack, b"untouched pack bytes").unwrap();
        if covered {
            f.store.add_source(&root, 0, false).unwrap();
        }
        f.store.write(|tx|{tx.execute("INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,created_at) VALUES ('ex','local',?1,'{}',0,0)",[json!({"path":pack}).to_string()]).map_err(error)?;Ok(())}).unwrap();
        let mut doc = identified();
        doc["forgottenCards"] = json!([{"ficheId":"card"}]);
        let p = f.prepare(&f.archive(&doc)).unwrap();
        let forgotten = p
            .plan
            .preview
            .conflicts
            .iter()
            .find(|c| c.target["kind"] == "forgotten")
            .unwrap();
        // BKc2 P2: a covered target cannot follow the global choice.
        assert_eq!(
            forgotten.target["requiresIndividualChoice"] == true,
            covered
        );
        let choices = p
            .plan
            .preview
            .conflicts
            .iter()
            .map(|c| (c.id.clone(), "incoming".into()))
            .collect();
        if covered {
            // Explicit individual choice: still atomic, now naming the fiche.
            let error = f.apply(&p, choices).unwrap_err();
            assert_eq!(error.code, codes::CATALOG_IMPORT_FORGET_REFUSED);
            // Same label as the conflict in the preview (the backup title).
            assert_eq!(error.params["title"], forgotten.target["label"]);
            assert_eq!(f.count("correction"), 1);
            assert_eq!(f.count("fiche_forgotten"), 0);
            // The global incoming choice imports and keeps the covered fiche.
            f.apply(&p, global_incoming(&p)).unwrap();
            assert_eq!(f.count("fiche_forgotten"), 0);
            assert!(f.count("correction") >= 1);
        } else {
            f.apply(&p, choices).unwrap();
            assert_eq!(f.count("correction"), 0);
            assert_eq!(f.count("fiche_forgotten"), 0);
            assert_eq!(f.count("fiche"), 0);
        }
        assert_eq!(f.count("exemplar"), i64::from(covered));
        assert_eq!(fs::read(pack).unwrap(), b"untouched pack bytes");
    }
}
// REVb3 P3-3: local forgetting never accepts a group member, so an imported
// forgetting of a member leaves the global choice and an explicit one is refused.
#[test]
fn imported_forgetting_of_a_group_member_is_refused_and_keeps_the_group() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {tx.execute_batch("INSERT INTO fiche VALUES ('head',1,0,1);INSERT INTO fiche_grouping VALUES ('local','head');").map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["forgottenCards"] = json!([{"ficheId":"card"}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let forgotten = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "forgotten")
        .unwrap();
    assert_eq!(forgotten.target["requiresIndividualChoice"], true);
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    let error = f.apply(&p, choices).unwrap_err();
    assert_eq!(error.code, codes::CATALOG_IMPORT_FORGET_REFUSED);
    assert_eq!(f.count("fiche_forgotten"), 0);
    assert_eq!(f.count("correction"), 1);
    f.apply(&p, global_incoming(&p)).unwrap();
    assert_eq!(f.count("fiche_forgotten"), 0);
    let group: Vec<(String, String)> = f
        .store
        .read(|c| {
            c.prepare("SELECT fiche_id,target_id FROM fiche_grouping")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .unwrap();
    assert_eq!(group, [("local".to_string(), "head".to_string())]);
    assert_eq!(f.count("fiche"), 2);
}
#[test]
fn six_hundred_official_covers_fit_export_and_offline_preview() {
    let f = Fixture::new();
    let mut seed = 1u32;
    let pixels = image::RgbImage::from_fn(256, 256, |_, _| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        image::Rgb([(seed >> 24) as u8, (seed >> 16) as u8, (seed >> 8) as u8])
    });
    let mut base = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut base, 75)
        .encode_image(&pixels)
        .unwrap();
    let mut total = 0;
    // Synthetic retained assets; unique JPEG comments prevent content deduplication.
    f.store.write(|tx| {
        tx.execute("INSERT INTO provenance(id,kind,language) VALUES ('official','lunii','fr_FR')",[]).map_err(error)?;
        for n in 0..600u32 {
            let cover=official_cover(&format!("/public/images/covers/{n}.jpg"));
            let id=format!("card-{n}");
            let mut bytes=base.clone();
            bytes.splice(2..2,[0xff,0xfe,0,6].into_iter().chain(n.to_be_bytes()));
            let sha=validate::payload(&bytes).sha256;
            total+=bytes.len();
            fs::write(f.store.images_root().join(&sha),&bytes).map_err(error)?;
            tx.execute("INSERT INTO image_asset VALUES (?1,'image/jpeg',?2,?3)",params![sha,bytes.len() as i64,format!("images/{sha}")]).map_err(error)?;
            tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)",[&id]).map_err(error)?;
            tx.execute("INSERT INTO reference_value VALUES (?1,'cover','@lunii:fr_FR',?2,'official',?3)",params![id,cover.to_string(),sha]).map_err(error)?;
            tx.execute("INSERT INTO lunii_filled(fiche_id) VALUES (?1)",[&id]).map_err(error)?;
        }
        Ok(())
    }).unwrap();
    println!("600 covers seeded: {total}");
    let path = export_fixture(&f);
    println!("600 covers exported");
    let target = Fixture::new();
    let p = target.prepare(&path).unwrap();
    println!("600 covers staged");
    assert_eq!(p.staged.manifest.counts.images, 600);
    target.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(target.count("image_asset"), 600);
    f.store
        .write(|tx| {
            tx.execute("UPDATE reference_value SET image_sha256=NULL", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let reference_only = export_fixture(&f);
    let reference_size = fs::metadata(reference_only).unwrap().len();
    println!(
        "600 covers: reference-only archive {reference_size} bytes; added {} bytes",
        fs::metadata(&path).unwrap().len() - reference_size
    );
    let archive_size = fs::metadata(path).unwrap().len();
    println!("600 covers: payload {total} bytes; archive {archive_size} bytes");
    // BKc2 P3-4: each cover is stored once, without amplification. Measured
    // on Linux: 198 179 bytes without images, payload + 467 581 with them.
    assert!(reference_size < 512 * 1024, "{reference_size}");
    assert!(
        archive_size <= total as u64 + 1024 * 1024,
        "{archive_size} > {total} + 1 MiB"
    );
}

#[test]
fn hostile_official_payload_is_rejected_before_any_local_write() {
    let f = Fixture::new();
    let bytes = b"hostile image bytes";
    let sha = validate::payload(bytes).sha256;
    let mut doc = identified();
    doc["corrections"] = json!([]);
    doc["provenances"] = json!([{"id":"official","kind":"lunii","language":"fr_FR"}]);
    doc["referenceValues"] = json!([{"ficheId":"card","field":"cover","language":"@lunii:fr_FR","value":official_cover("/public/images/hostile.jpg"),"provenanceId":"official","imageSha256":sha}]);
    assert!(f
        .prepare(&archive_image_document(&f, bytes, Some(doc)))
        .is_err());
    assert_eq!(f.count("fiche"), 0);
    assert_eq!(f.count("image_asset"), 0);
}

fn review_associate(f: &Fixture, path: &std::path::Path) -> Prepared {
    let staged = staging::prepare(&f.store, path, &AtomicBool::new(false)).unwrap();
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    let plan = f
        .store
        .write(|tx| matching::plan(tx, &staged, "review", &associations))
        .unwrap();
    Prepared {
        staged,
        plan,
        source: path.into(),
        created: Instant::now(),
        associations,
    }
}
#[test]
fn pending_forgetting_requires_choice_and_refuses_covered_target_atomically() {
    for (choose_forget, covered) in [(false, false), (true, false), (false, true), (true, true)] {
        let f = Fixture::new();
        f.local();
        let mut doc = empty_document();
        doc["cards"] = json!([{"id":"card","createdAt":0,"favorite":0,"revision":0}]);
        let path = f.archive(&doc);
        let first = f.prepare(&path).unwrap();
        let waiting = first.plan.cards["card"].clone();
        f.apply(&first, BTreeMap::new()).unwrap();
        // Legacy imports could leave a forgotten waiting fiche with its mapping.
        f.store
            .write(|tx| {
                tx.execute("INSERT INTO fiche_forgotten VALUES (?1)", [&waiting])
                    .map_err(error)?;
                Ok(())
            })
            .unwrap();
        f.store.write(|tx|{tx.execute_batch("UPDATE fiche SET favorite=1 WHERE id='local';  INSERT INTO tag VALUES ('lt','Local','local',1);  INSERT INTO tag_member VALUES ('lt','local'); INSERT INTO reference_value VALUES ('local','description','','\"Local reference\"','local-provenance',NULL); INSERT INTO lunii_filled(fiche_id) VALUES ('local');").map_err(error)?;Ok(())}).unwrap();
        let root = f.root.join("packs");
        fs::create_dir(&root).unwrap();
        let pack = root.join("pack.zip");
        fs::write(&pack, b"pack preserved").unwrap();
        if covered {
            f.store
                .add_source(
                    &root,
                    f.store.list_sources().unwrap().sources_revision,
                    false,
                )
                .unwrap();
            f.store.write(|tx|{tx.execute("INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,created_at) VALUES ('ex','local',?1,'{}',0,0)",[json!({"path":pack}).to_string()]).map_err(error)?;Ok(())}).unwrap();
        }
        let p = review_associate(&f, &path);
        assert_eq!(
            p.plan.pending.get(&waiting).map(String::as_str),
            Some("local")
        );
        let conflict = p
            .plan
            .preview
            .conflicts
            .iter()
            .find(|c| c.target["kind"] == "pendingForgotten")
            .expect("transferred forgetting must be a conflict");
        assert_eq!(conflict.local, false);
        assert_eq!(conflict.incoming, true);
        assert_eq!(conflict.default_choice, "local");
        let snapshot = |id: &str| {
            f.store
                .read(|c| crate::services::catalogue::data::card::snapshot(c, id))
                .unwrap()
        };
        let before = snapshot("local");
        let before_waiting = snapshot(&waiting);
        let choices = if choose_forget {
            BTreeMap::from([(conflict.id.clone(), "incoming".into())])
        } else {
            BTreeMap::new()
        };
        let result = f.apply(&p, choices);
        assert_eq!(conflict.target["requiresIndividualChoice"] == true, covered);
        if choose_forget && covered {
            let error = result.unwrap_err();
            assert_eq!(error.code, codes::CATALOG_IMPORT_FORGET_REFUSED);
            assert_eq!(error.params["title"], "Local");
            assert_eq!(snapshot("local"), before);
            assert_eq!(snapshot(&waiting), before_waiting);
        } else {
            result.unwrap();
            let kept = i64::from(!choose_forget);
            for table in [
                "correction",
                "tag_member",
                "reference_value",
                "lunii_filled",
            ] {
                assert_eq!(f.count(table), kept, "{table}");
            }
            assert_eq!(f.count("fiche_forgotten"), 0);
            if choose_forget {
                assert!(f.store.get_card("local").is_err());
            }
            let favorite: i64 = f
                .store
                .read(|c| {
                    c.query_row(
                        "SELECT coalesce((SELECT favorite FROM fiche WHERE id='local'),0)",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(favorite, kept);
            if !choose_forget {
                let title: String = f
                    .store
                    .read(|c| {
                        c.query_row(
                            "SELECT value_json FROM correction WHERE fiche_id='local'",
                            [],
                            |r| r.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(title, "\"Local\"");
            }
        }
        assert_eq!(fs::read(pack).unwrap(), b"pack preserved");
    }
}
#[test]
fn waiting_reference_only_cover_is_attached_after_transfer_offline() {
    let f = Fixture::new();
    f.store.lunii_locale("fr").unwrap();
    let bytes = include_bytes!("../../../../icons/32x32.png");
    let sha = validate::payload(bytes).sha256;
    let cover = official_cover("/public/images/review.jpg");
    let mut doc = empty_document();
    doc["cards"] =
        json!([{"id":"card","createdAt":0,"favorite":0,"revision":0,"luniiFilled":true}]);
    doc["provenances"] = json!([{"id":"official","kind":"lunii","language":"fr_FR"}]);
    doc["referenceValues"] = json!([{"ficheId":"card","field":"cover","language":"@lunii:fr_FR","value":cover,"provenanceId":"official","imageSha256":sha}]);
    let path = archive_image_document(&f, bytes, Some(doc));
    let first = f.prepare(&path).unwrap();
    let waiting = first.plan.cards["card"].clone();
    f.apply(&first, BTreeMap::new()).unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE reference_value SET image_sha256=NULL WHERE fiche_id=?1",
                [&waiting],
            )
            .map_err(error)?;
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    f.local();
    let p = review_associate(&f, &path);
    assert!(p
        .plan
        .actions
        .iter()
        .any(|a| a.kind == "pendingLuniiValue" && a.incoming["imageSha256"].is_null()));
    assert!(p.plan.actions.iter().all(|a| a.kind != "referenceValues"));
    f.apply(&p, BTreeMap::new()).unwrap();
    let restored: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT image_sha256 FROM reference_value WHERE fiche_id='local' AND field='cover'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(restored, sha);
    assert_eq!(
        f.store
            .lunii_cover_bytes("local", cover["key"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    assert!(f.store.lunii_thumbnail("local").unwrap().is_some());
    assert_eq!(f.count("lunii_pack"), 0);
}

fn legacy_forgotten_document() -> Value {
    let mut doc = identified();
    doc["cards"][0]["luniiFilled"] = json!(true);
    doc["forgottenCards"] = json!([{"ficheId":"card"}]);
    doc["tags"] = json!([{"id":"tag","label":"Tag","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"tag","ficheId":"card"}]);
    doc["provenances"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"official","kind":"lunii","language":"fr_FR"}));
    doc["referenceValues"] = json!([{"ficheId":"card","field":"title","language":"@lunii:fr_FR","value":"Official title","provenanceId":"official","imageSha256":null}]);
    doc
}
fn assert_forgotten_data_absent(f: &Fixture, erased: bool) {
    for table in [
        "correction",
        "reference_value",
        "reference_source",
        "import_reference",
        "tag_member",
        "lunii_filled",
        "lunii_image_attempt",
        "pending_import",
        "operation_change",
    ] {
        assert_eq!(f.count(table), 0, "{table} must stay purged");
    }
    assert_eq!(f.count("fiche"), i64::from(!erased));
    assert_eq!(f.count("fiche_forgotten"), i64::from(!erased));
    let card_mappings: i64 = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT count(*) FROM import_identity WHERE entity_type='card'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(card_mappings, 0);
    let favorite: i64 = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT coalesce((SELECT favorite FROM fiche WHERE id='local'),0)",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(favorite, 0);
}
fn assert_forgetting_preview(f: &Fixture, prepared: Prepared) -> Prepared {
    f.store
        .backup_exports
        .lock()
        .unwrap()
        .previews
        .insert("preview".into(), prepared);
    let page = f.store.import_preview_page("preview", 100, 100).unwrap();
    assert_eq!(page["forgottenCount"], 1);
    f.store
        .backup_exports
        .lock()
        .unwrap()
        .previews
        .remove("preview")
        .unwrap()
}
#[test]
fn already_forgotten_card_is_purged_after_importing_legacy_personal_data() {
    let f = Fixture::new();
    f.local();
    f.store
        .write(|tx| {
            // Persisted legacy state, authored independently of the new purge.
            tx.execute_batch("DELETE FROM correction WHERE fiche_id='local'; UPDATE fiche SET favorite=0 WHERE id='local'; INSERT INTO fiche_forgotten VALUES ('local');").map_err(error)?;
            Ok(())
        })
        .unwrap();
    let doc = legacy_forgotten_document();
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let p = assert_forgetting_preview(&f, p);
    assert!(!p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "forgotten"));
    assert_forgotten_data_absent(&f, false);
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    assert_forgotten_data_absent(&f, true);
}
#[test]
fn already_forgotten_target_is_purged_after_forgotten_waiting_card_transfer() {
    let f = Fixture::new();
    let mut doc = legacy_forgotten_document();
    doc["identities"] = json!([]);
    doc["forgottenCards"] = json!([]);
    let path = f.archive(&doc);
    let first = f.prepare(&path).unwrap();
    let waiting = first.plan.cards["card"].clone();
    f.apply(&first, BTreeMap::new()).unwrap();
    f.local();
    f.store
        .write(|tx| {
            tx.execute_batch("DELETE FROM correction WHERE fiche_id='local'; UPDATE fiche SET favorite=0 WHERE id='local'; INSERT INTO fiche_forgotten VALUES ('local');").map_err(error)?;
            // Older imports retained data and mappings alongside a forgotten marker.
            tx.execute("INSERT INTO fiche_forgotten VALUES (?1)", [&waiting])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let p = review_associate(&f, &path);
    let p = assert_forgetting_preview(&f, p);
    assert_eq!(
        p.plan.pending.get(&waiting).map(String::as_str),
        Some("local")
    );
    assert!(!p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "pendingForgotten"));
    assert!(p.plan.actions.iter().any(|a| a.kind == "pendingLuniiValue"));
    assert!(f.count("correction") > 0);
    let choices = p
        .plan
        .preview
        .conflicts
        .iter()
        .map(|c| (c.id.clone(), "incoming".into()))
        .collect();
    f.apply(&p, choices).unwrap();
    assert_forgotten_data_absent(&f, true);
}

// REVb2 P2-A (relecture, sonde zz_a): one divergent fiche never blocks the
// preview; the default application keeps the local interval.
#[test]
fn one_divergent_age_keeps_the_preview_and_the_default_keeps_local_bounds() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {tx.execute_batch("INSERT INTO correction VALUES ('local','ageMin','','defined','8','local-provenance',NULL,1); INSERT INTO correction VALUES ('local','ageMax','','defined','10','local-provenance',NULL,1);").map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMax","language":"","state":"defined","value":6,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert!(p
        .plan
        .preview
        .conflicts
        .iter()
        .any(|c| c.target["kind"] == "ageRange"));
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(age_bounds(&f, "local"), ["10", "8"]);
}
// REVb2 P2-A: an incoming addition inverted against a local bound becomes a
// single conflict that keeps the local bound by default.
#[test]
fn inverted_age_addition_becomes_a_conflict_keeping_the_local_bound() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {tx.execute("INSERT INTO correction VALUES ('local','ageMin','','defined','8','local-provenance',NULL,1)",[]).map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMax","language":"","state":"defined","value":6,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    assert!(!p
        .plan
        .preview
        .additions
        .iter()
        .any(|a| a["kind"] == "ageRange"));
    let age = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "ageRange")
        .unwrap();
    assert_eq!(age.default_choice, "local");
    assert_eq!(age.local["ageMin"]["value"], 8);
    assert_eq!(age.target["requiresIndividualChoice"], true);
    f.apply(&p, global_incoming(&p)).unwrap();
    assert_eq!(age_bounds(&f, "local"), ["8"]);
}
// REVb2 P3-A.1 (sonde zz_b): a `source` choice is resolved through the
// reference value, so the risk is visible and the refusal names the fiche.
#[test]
fn source_age_choice_is_checked_against_the_reference_and_names_the_fiche() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {tx.execute_batch("INSERT INTO correction VALUES ('local','ageMin','','defined','1','local-provenance',NULL,1); INSERT INTO correction VALUES ('local','ageMax','','defined','6','local-provenance',NULL,1); INSERT INTO reference_value VALUES ('local','ageMin','','8','local-provenance',NULL); INSERT INTO reference_value VALUES ('local','ageMax','','10','local-provenance',NULL);").map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"ageMin","language":"","state":"source","value":null,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let age = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "ageRange")
        .unwrap();
    assert_eq!(age.target["requiresIndividualChoice"], true);
    let error = f
        .apply(&p, BTreeMap::from([(age.id.clone(), "incoming".into())]))
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT);
    assert_eq!(error.params["title"], "Local");
    assert_eq!(age_bounds(&f, "local"), ["6", "1"]);
}
// REVb2 P3-A.2 (sonde zz_c): a reference replacement takes part in the
// simulation of the bounds.
#[test]
fn reference_replacement_is_simulated_with_age_corrections() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {tx.execute_batch("INSERT INTO correction VALUES ('local','ageMin','','defined','8','local-provenance',NULL,1); INSERT INTO reference_value VALUES ('local','ageMax','','10','local-provenance',NULL);").map_err(error)?;Ok(())}).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([]);
    doc["referenceValues"] = json!([{"ficheId":"card","field":"ageMax","language":"","value":6,"provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    let reference = p
        .plan
        .preview
        .conflicts
        .iter()
        .find(|c| c.target["kind"] == "referenceBundle")
        .unwrap();
    assert_eq!(reference.target["requiresIndividualChoice"], true);
    assert_eq!(reference.target["individualChoiceReason"], "ageInterval");
    let error = f
        .apply(
            &p,
            BTreeMap::from([(reference.id.clone(), "incoming".into())]),
        )
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT);
    let max: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT value_json FROM reference_value WHERE fiche_id='local' AND field='ageMax'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(max, "10");
    f.apply(&p, global_incoming(&p)).unwrap();
}
// REVb3 P3-1: a reference or an official value added where the card has none
// becomes a conflict keeping the local side, like an age correction addition.
#[test]
fn inverted_reference_or_official_addition_becomes_a_conflict_keeping_local() {
    for (kind, official) in [("referenceBundle", false), ("referenceValues", true)] {
        let f = Fixture::new();
        f.local();
        f.store.write(|tx| {tx.execute("INSERT INTO correction VALUES ('local','ageMin','','defined','8','local-provenance',NULL,1)",[]).map_err(error)?;Ok(())}).unwrap();
        let mut doc = identified();
        doc["corrections"] = json!([]);
        doc["references"] = json!([]);
        if official {
            doc["referenceValues"] = json!([{"ficheId":"card","field":"ageMax","language":"@lunii:fr_FR","value":6,"provenanceId":"remote-lunii","imageSha256":null}]);
            doc["provenances"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"remote-lunii","kind":"lunii","language":"fr_FR"}));
        } else {
            doc["referenceValues"] = json!([{"ficheId":"card","field":"ageMax","language":"","value":6,"provenanceId":"manual","imageSha256":null}]);
        }
        let p = f
            .prepare(&f.archive(&doc))
            .unwrap_or_else(|e| panic!("{kind}: preview refused: {}", e.code));
        assert!(
            !p.plan.preview.additions.iter().any(|a| a["kind"] == kind),
            "{kind}"
        );
        let conflict = p
            .plan
            .preview
            .conflicts
            .iter()
            .find(|c| c.target["kind"] == kind)
            .unwrap();
        assert_eq!(conflict.default_choice, "local");
        assert!(conflict.local.is_null());
        assert_eq!(conflict.target["requiresIndividualChoice"], true);
        assert_eq!(conflict.target["individualChoiceReason"], "ageInterval");
        if official {
            assert_eq!(conflict.target["key"], "ageMax:@lunii:fr_FR");
        }
        let error = f
            .apply(
                &p,
                BTreeMap::from([(conflict.id.clone(), "incoming".into())]),
            )
            .unwrap_err();
        assert_eq!(error.code, codes::CATALOG_IMPORT_AGE_INTERVAL_CONFLICT);
        f.apply(&p, global_incoming(&p)).unwrap();
        assert_eq!(age_bounds(&f, "local"), ["8"]);
        assert_eq!(f.count("reference_value"), 0, "{kind}");
    }
}
// REVb2 P2-B (sonde zz_d): after a reinstall and a new scan, the active local
// reference with the same values is kept without conflict, at every round.
#[test]
fn identical_active_reference_of_another_catalogue_never_conflicts() {
    let a = Fixture::new();
    seed_reference(&a);
    let doc: Value =
        serde_json::from_slice(&a.store.backup_snapshot(0).unwrap().catalogue).unwrap();
    let b = Fixture::new();
    seed_reference(&b);
    b.store
        .write(|tx| {
            tx.execute_batch("PRAGMA defer_foreign_keys=ON; UPDATE exemplar SET id='exB'; UPDATE reference_source SET exemplar_id='exB';")
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert_ne!(
        b.store
            .read(|c| c.query_row("SELECT id FROM catalogue", [], |r| r.get::<_, String>(0)))
            .unwrap(),
        doc["originCatalogueId"].as_str().unwrap()
    );
    for _ in 0..2 {
        let p = b.prepare(&b.archive(&doc)).unwrap();
        assert!(!p.plan.actions.iter().any(|a| a.kind == "referenceBundle"));
        assert!(!p
            .plan
            .preview
            .unresolved
            .iter()
            .any(|u| u.reason == "referenceUnavailable"));
        b.apply(&p, global_incoming(&p)).unwrap();
        let active: String = b
            .store
            .read(|c| c.query_row("SELECT exemplar_id FROM reference_source", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(active, "exB");
        assert_eq!(b.count("import_reference"), 0);
    }
}
// REVb2 mineur: every portable ceiling reached by an export has its own code.
#[test]
fn export_ceilings_have_a_dedicated_code() {
    assert_eq!(
        snapshot::within(format::MAX_JSON + 1, format::MAX_JSON)
            .unwrap_err()
            .code,
        codes::CATALOG_BACKUP_SIZE_LIMIT_EXCEEDED
    );
    assert!(snapshot::within(format::MAX_JSON, format::MAX_JSON).is_ok());
    let f = Fixture::new();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO provenance(id,kind) VALUES ('user','manual')",
                [],
            )
            .map_err(error)?;
            for i in 0..=format::MAX_IMAGES {
                let sha = format!("{i:064x}");
                let id = format!("card-{i}");
                tx.execute(
                    "INSERT INTO image_asset VALUES (?1,'image/png',1,?2)",
                    params![sha, format!("images/{sha}")],
                )
                .map_err(error)?;
                tx.execute("INSERT INTO fiche VALUES (?1,0,0,0)", [&id])
                    .map_err(error)?;
                tx.execute(
                    "INSERT INTO correction VALUES (?1,'cover','','defined',?2,'user',?3,1)",
                    params![id, json!({"sha256":sha}).to_string(), sha],
                )
                .map_err(error)?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store.backup_snapshot(0).err().unwrap().code,
        codes::CATALOG_BACKUP_SIZE_LIMIT_EXCEEDED
    );
}
// REVb2 mineur: a symbolic `catalogue.json` member is refused again by a test.
#[test]
fn symbolic_catalogue_member_is_refused() {
    use std::io::Write;
    let f = Fixture::new();
    let doc = Fixture::document();
    let catalogue = serde_json::to_vec(&doc).unwrap();
    let manifest = format::Manifest {
        format: format::FORMAT.into(),
        format_version: 1,
        schema: format::SCHEMA.into(),
        backup_id: uuid::Uuid::new_v4().to_string(),
        origin_catalogue_id: "origin".into(),
        catalogue_revision: 7,
        counts: format::Counts {
            cards: 1,
            tags: 0,
            images: 0,
        },
        entries: BTreeMap::from([("catalogue.json".into(), validate::payload(&catalogue))]),
    };
    let path = f.root.join("linked.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    // The link text equals the declared payload: only the member type refuses it.
    zip.add_symlink(
        "catalogue.json",
        std::str::from_utf8(&catalogue).unwrap(),
        options,
    )
    .unwrap();
    zip.finish().unwrap();
    assert_eq!(
        f.prepare(&path).err().unwrap().code,
        codes::CATALOG_IMPORT_INVALID
    );
    assert_eq!(f.count("fiche"), 0);
}
// BKc2 P2 (relecture P2-1): forgetting C keeps the refused A/B decision that
// the same import operation restored, by import and locally alike.
#[test]
fn forgetting_keeps_unrelated_decisions_of_the_same_operation() {
    for imported in [false, true] {
        let (f, mut doc, associations) = relation_fixture();
        f.store.write(|tx| {
            tx.execute_batch("INSERT INTO operation VALUES ('legacy-decision','legacy','committed','legacy',0,0,'{}');
                INSERT INTO suggestion_decision VALUES ('legacy','[\"unrelated-a\",\"unrelated-b\"]','{}','refused','legacy-decision');").map_err(error)?;
            Ok(())
        }).unwrap();
        doc["cards"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"c","createdAt":1,"favorite":1,"revision":1}));
        doc["corrections"] = json!([{"ficheId":"c","field":"title","language":"","state":"defined","value":"Oubliée","provenanceId":"manual","imageSha256":null}]);
        let p = relation_preview(&f, &doc, associations.clone());
        f.apply(&p, BTreeMap::new()).unwrap();
        let c = p.plan.cards["c"].clone();
        let decisions = || -> Vec<(String, String)> {
            f.store
                .read(|db| {
                    db.prepare("SELECT participants_json,decision FROM suggestion_decision")?
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect()
                })
                .unwrap()
        };
        let restored = decisions();
        assert_eq!(restored.len(), 1);
        if imported {
            doc["forgottenCards"] = json!([{"ficheId":"c"}]);
            let p = relation_preview(&f, &doc, associations);
            f.apply(&p, global_incoming(&p)).unwrap();
        } else {
            let revision = f.store.get_card(&c).unwrap()["ficheRevision"].clone();
            f.store
                .mutate(
                    serde_json::from_value(json!({"kind":"forgetUnreferencedCards","requestKey":"forget-c","ficheIds":[c],"expectedFicheRevisions":{&c:revision}}))
                        .unwrap(),
                    f.store.list_sources().unwrap().catalogue_revision,
                )
                .unwrap();
        }
        assert_eq!(f.count("fiche_forgotten"), 0, "imported={imported}");
        assert!(
            f.store.get_card(&c).is_err(),
            "confirmed erasure removes the card"
        );
        assert_eq!(decisions(), restored, "imported={imported}");
        let mentions: i64 = f
            .store
            .read(|db| {
                db.query_row(
                    "SELECT count(*) FROM operation_change WHERE entity_id=?1 OR instr(before_json,?1)>0 OR instr(after_json,?1)>0",
                    [&c],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(mentions, 0);
    }
}
// BKc2 P3 (relecture P3-2): two different payloads under one Lunii key
// produce one archived image, attached to both fiches.
#[test]
fn official_covers_are_deduplicated_by_key_not_by_content() {
    let source = Fixture::new();
    let cover = official_cover("/public/images/covers/shared.jpg");
    let key = cover["key"].as_str().unwrap();
    for (id, icon) in [
        ("one", &include_bytes!("../../../../icons/32x32.png")[..]),
        ("two", &include_bytes!("../../../../icons/64x64.png")[..]),
    ] {
        add_official(&source, id, &cover, None);
        let bytes = crate::services::catalogue::thumbnails::encode_bounded(icon).unwrap();
        source.store.retain_lunii_cover(id, key, &bytes).unwrap();
    }
    let shas = |f: &Fixture, ids: &[&str]| -> Vec<Option<String>> {
        ids.iter()
            .map(|id| {
                f.store
                    .read(|c| {
                        c.query_row(
                            "SELECT image_sha256 FROM reference_value WHERE fiche_id=?1 AND field='cover'",
                            [id],
                            |r| r.get(0),
                        )
                    })
                    .unwrap()
            })
            .collect()
    };
    let before = shas(&source, &["one", "two"]);
    assert!(before[0].is_some() && before[1].is_some() && before[0] != before[1]);
    let path = export_fixture(&source);
    let target = Fixture::new();
    let p = target.prepare(&path).unwrap();
    assert_eq!(p.staged.manifest.counts.images, 1);
    let ids = [p.plan.cards["one"].clone(), p.plan.cards["two"].clone()];
    target.apply(&p, BTreeMap::new()).unwrap();
    let after = shas(&target, &[&ids[0], &ids[1]]);
    assert!(after[0].is_some());
    assert_eq!(after[0], after[1]);
    assert!(before.contains(&after[0]));
}

#[test]
fn legacy_backup_collections_are_ignored_without_affecting_tags_or_reexport() {
    use std::io::{Read, Write};
    let f = Fixture::new();
    let mut doc = identified();
    doc["collections"] = json!([{"id":"old","label":"Old collection","revision":1}]);
    doc["collectionMembers"] = json!([{"collectionId":"old","ficheId":"card"}]);
    doc["tags"] = json!([{"id":"kept","label":"Kept tag","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"kept","ficheId":"card"}]);
    let path = f.archive(&doc);
    // Include the old manifest counter too, as written by previous versions.
    let mut source = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    let mut bytes = vec![];
    source
        .by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
    manifest["counts"]["collections"] = json!(1);
    drop(source);
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    archive
        .start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    archive
        .start_file("catalogue.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive
        .write_all(&serde_json::to_vec(&doc).unwrap())
        .unwrap();
    archive.finish().unwrap();
    let prepared = f.prepare(&path).unwrap();
    assert!(prepared.staged.document.get("collections").is_none());
    assert!(prepared.staged.document.get("collectionMembers").is_none());
    assert!(prepared.plan.preview.conflicts.is_empty());
    f.apply(&prepared, BTreeMap::new()).unwrap();
    assert_eq!(f.count("tag"), 1);
    assert_eq!(f.count("tag_member"), 1);
    let snapshot = f
        .store
        .backup_snapshot(f.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert!(exported.get("collections").is_none());
    assert!(exported.get("collectionMembers").is_none());
    assert_eq!(exported["tags"].as_array().unwrap().len(), 1);
    assert!(serde_json::to_value(&prepared.plan.preview.counts)
        .unwrap()
        .get("collections")
        .is_none());
}

#[test]
fn compl2_import_accepts_metadata_without_inheriting_inverted_sibling_age() {
    let f = Fixture::new();
    f.local();
    f.store.write(|tx| {
            tx.execute_batch("INSERT INTO provenance(id,kind) VALUES ('compl2-manual','manual');
                INSERT INTO source(id,path,path_key,origin,status,revision) VALUES ('compl2-source',X'00',X'00','manual','active',1);
                INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,retired) VALUES ('compl2-reference','local','{}','r',1,0),('compl2-sibling','local','{}','s',1,0);
                INSERT INTO reference_source VALUES ('local','compl2-reference',0,1);
                INSERT INTO cache.scan VALUES ('compl2-scan','compl2-source',1,'complete','[]');
                INSERT INTO cache.observation VALUES ('compl2-reference',NULL,X'01','r',1,'available','project',NULL,2,0,'{}','{}','compl2-scan'),('compl2-sibling',NULL,X'02','s',1,'available','project',NULL,1,0,'{}','{}','compl2-scan');
                INSERT INTO cache.coverage VALUES ('compl2-source','compl2-reference'),('compl2-source','compl2-sibling');
                INSERT INTO cache.extracted_value VALUES ('compl2-sibling','ageMin','','@card','present','valid','8','8','{}');
                INSERT INTO correction VALUES ('local','ageMax','','defined','5','compl2-manual',NULL,1);
            ").map_err(error)?;
            Ok(())
    }).unwrap();
    let mut doc = identified();
    doc["corrections"] = json!([{"ficheId":"card","field":"description","language":"","state":"defined","value":"Incoming","provenanceId":"manual","imageSha256":null}]);
    let p = f.prepare(&f.archive(&doc)).unwrap();
    f.apply(&p, BTreeMap::new()).unwrap();
    let card = f.store.get_card("local").unwrap();
    assert!(card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["field"] == "ageMin")
        .unwrap()["effective"]["value"]
        .is_null());
}

#[test]
fn compl3_imported_cover_without_exemplar_survives_rescan_assembly_and_cache() {
    use std::io::Write;
    let f = Fixture::new();
    let root = f.root.join("packs");
    fs::create_dir(&root).unwrap();
    let path = root.join("pack.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("story.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(json!({"title":"Original","stageNodes":[{"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","squareOne":true}],"actionNodes":[]}).to_string().as_bytes()).unwrap();
    zip.start_file("thumbnail.png", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(include_bytes!("../../../../icons/32x32.png"))
        .unwrap();
    zip.finish().unwrap();
    f.store.add_source(&root, 0, false).unwrap();
    let rescan = || {
        let receipt = f
            .store
            .start_scan(
                None,
                uuid::Uuid::new_v4().to_string(),
                f.store.list_sources().unwrap().sources_revision,
                f.root.join("cache"),
                f.root.join("data"),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        assert_eq!(
            wait(&f.store, &serde_json::to_value(receipt).unwrap()).status,
            "success"
        );
    };
    rescan();
    let mut snapshot = f
        .store
        .backup_snapshot(f.store.list_sources().unwrap().catalogue_revision)
        .unwrap();
    let mut doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    // Force replacement of the accepted bundle through the portable importer.
    for value in doc["referenceValues"].as_array_mut().unwrap() {
        if value["field"] == "title" {
            value["value"] = json!("Imported title");
        }
        if value["field"] == "cover" {
            value["imageSha256"] =
                json!(validate::payload(include_bytes!("../../../../icons/32x32.png")).sha256);
        }
    }
    let bytes = serde_json::to_vec(&doc).unwrap();
    let image = include_bytes!("../../../../icons/32x32.png");
    let image_name = format!("images/{}", validate::payload(image).sha256);
    snapshot
        .manifest
        .entries
        .insert("catalogue.json".into(), validate::payload(&bytes));
    snapshot
        .manifest
        .entries
        .insert(image_name.clone(), validate::payload(image));
    snapshot.manifest.counts.images = 1;
    let archive = f.root.join("portable.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for (name, payload) in [
        (
            "manifest.json",
            serde_json::to_vec(&snapshot.manifest).unwrap(),
        ),
        ("catalogue.json", bytes),
        (&image_name, image.to_vec()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&payload).unwrap();
    }
    zip.finish().unwrap();
    let prepared = f.prepare(&archive).unwrap();
    f.apply(&prepared, global_incoming(&prepared)).unwrap();
    rescan();
    let id = prepared.plan.cards.values().next().unwrap();
    let card = f.store.get_card(id).unwrap();
    f.store.read(|c| {
        let (provenance, exemplar): (String, Option<String>) = c.query_row("SELECT p.id,p.exemplar_id FROM reference_value v JOIN provenance p ON p.id=v.provenance_id WHERE v.fiche_id=?1 AND v.field='cover'", [id], |r| Ok((r.get(0)?,r.get(1)?)))?;
        assert!(provenance.starts_with("import-"));
        assert!(exemplar.is_none());
        Ok(())
    }).unwrap();
    let first = f.store.get_thumbnail(None, Some(id), None).unwrap();
    assert_eq!(first.state, "ready");
    // Cached bytes remain usable even if the physical pack is temporarily absent.
    fs::rename(&path, root.join("parked")).unwrap();
    let cached = f.store.get_thumbnail(None, Some(id), None).unwrap();
    assert_eq!(cached.state, "ready");
    assert_eq!(first.bytes, cached.bytes);
    fs::rename(root.join("parked"), &path).unwrap();
    let request = crate::services::catalogue::assembly::Request {
        ordered_selection: vec![crate::services::catalogue::assembly::Selection {
            fiche_id: id.clone(),
            expected_fiche_revision: card["ficheRevision"].as_i64().unwrap(),
        }],
        exemplar_choices: BTreeMap::new(),
        request_id: uuid::Uuid::new_v4().to_string(),
    };
    for retained in [true, false] {
        if !retained {
            // Exercise the file fallback too, as with an older accepted bundle
            // whose cover has no retained image asset.
            f.store.write(|tx| {
                tx.execute("UPDATE reference_value SET image_sha256=NULL WHERE fiche_id=?1 AND field='cover'", [id]).map_err(error)?;
                Ok(())
            }).unwrap();
        }
        let inputs = f
            .store
            .assembly_inputs(&request, &AtomicBool::new(false), |_, _| {})
            .unwrap();
        let cover = inputs["entries"][0]["coverPath"].as_str().unwrap();
        assert!(image::load_from_memory(&fs::read(cover).unwrap()).is_ok());
    }
}

#[test]
fn legacy_mixed_uuid_card_waits_without_blocking_other_cards() {
    let f = Fixture::new();
    f.local();
    let mut doc = identified();
    doc["identities"].as_array_mut().unwrap().push(
        json!({"packUuid":"bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee","ficheId":"card","provenance":{}}),
    );
    let mut healthy = doc["cards"][0].clone();
    healthy["id"] = json!("healthy");
    doc["cards"].as_array_mut().unwrap().push(healthy);
    doc["identities"].as_array_mut().unwrap().push(
        json!({"packUuid":"cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee","ficheId":"healthy","provenance":{}}),
    );
    doc["tags"] = json!([{"id":"tag","label":"Tag","revision":1}]);
    doc["tagMembers"] = json!([{"tagId":"tag","ficheId":"card"}]);
    doc["exemplarHints"] = json!([{"id":"selected","ficheId":"card","verifiedUuid":null,"locator":{},"retired":0,"createdAt":1}]);
    doc["references"] =
        json!([{"ficheId":"card","exemplarId":"selected","selectedAt":1,"revision":1}]);
    doc["referenceValues"] = json!([{"ficheId":"card","field":"title","language":"","value":"Saved reference","provenanceId":"manual","imageSha256":null}]);
    let path = f.archive(&doc);
    let p = f.prepare(&path).unwrap();
    let waiting = p.plan.cards["card"].clone();
    assert_ne!(
        waiting, "local",
        "no automatic choice among the mixed UUIDs"
    );
    assert!(p
        .plan
        .preview
        .unresolved
        .iter()
        .any(|u| u.id == "card" && u.reason == "ambiguousIdentity"));
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("fiche"), 3);
    assert_eq!(f.count("saved_pack_identity"), 1);
    let healthy: String = f.store.read(|c| c.query_row(
        "SELECT fiche_id FROM saved_pack_identity WHERE pack_uuid='cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'", [], |r| r.get(0))).unwrap();
    assert_eq!(healthy, p.plan.cards["healthy"]);
    let title: String = f.store.read(|c| c.query_row(
        "SELECT value_json FROM correction WHERE fiche_id=?1 AND field='title' AND language='fr'", [&waiting], |r| r.get(0))).unwrap();
    assert_eq!(title, "\"Titre\"");
    let retained: String = f
        .store
        .read(|c| c.query_row("SELECT document_json FROM pending_import", [], |r| r.get(0)))
        .unwrap();
    let retained: Value = serde_json::from_str(&retained).unwrap();
    assert_eq!(retained["cards"].as_array().unwrap().len(), 1);
    assert_eq!(retained["cards"][0], doc["cards"][0]);
    for key in [
        "corrections",
        "referenceValues",
        "references",
        "tagMembers",
        "tags",
        "exemplarHints",
    ] {
        assert_eq!(retained[key], doc[key], "retained {key}");
    }
    assert_eq!(retained["identities"].as_array().unwrap().len(), 2);
    let snapshot = f.store.backup_snapshot(1).unwrap();
    let exported: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    validate::document(&exported).unwrap();
    assert_eq!(
        exported["retainedImports"][0]["identities"],
        retained["identities"]
    );
    assert_eq!(exported["retainedImports"][0]["cards"][0], doc["cards"][0]);
    let associations = BTreeMap::from([("card".into(), "local".into())]);
    assert!(f
        .store
        .write(|tx| matching::plan(tx, &p.staged, "preview", &associations))
        .is_err());
    let p = f.prepare(&path).unwrap();
    assert_eq!(p.plan.cards["card"], waiting);
    f.apply(&p, BTreeMap::new()).unwrap();
    assert_eq!(f.count("fiche"), 3);
    assert_eq!(f.count("pending_import"), 1);
}
