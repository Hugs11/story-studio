use super::*;
use serde_json::{json, Value};
use std::{
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
        let root =
            std::env::temp_dir().join(format!("catalogue-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Arc::new(Store::open(&root.join("data"), &root.join("cache")).unwrap());
        Self { root, store }
    }
    fn path(&self) -> PathBuf {
        self.root.join("sauvegarde-é.zip")
    }
    fn seed(&self) {
        self.store.write(|tx| {
            tx.execute_batch("UPDATE catalogue SET id='origin',revision=7;
                INSERT INTO fiche VALUES ('card',1,1,7);
                INSERT INTO provenance(id,kind) VALUES ('manual','manual');
                INSERT INTO correction VALUES ('card','title','fr','defined','\"Titre\"','manual',NULL,7);
                INSERT INTO correction VALUES ('card','description','it','cleared',NULL,'manual',NULL,7);
                INSERT INTO correction VALUES ('card','author','en','source',NULL,'manual',NULL,7);").map_err(error)?;
            Ok(())
        }).unwrap();
    }
    fn plan(&self) -> ExportPlan {
        self.store
            .plan_catalogue_export(
                self.path(),
                self.store.list_sources().unwrap().catalogue_revision,
            )
            .unwrap()
    }
    fn publish(&self, plan: &ExportPlan, cancel: &AtomicBool) -> Result<Value> {
        let registry = self.store.backup_exports.lock().unwrap();
        export::write_archive(
            &self.store,
            &registry.plans[&plan.plan_id],
            cancel,
            |_| {},
            || Ok(()),
        )
    }
    fn image(&self) -> String {
        let bytes = include_bytes!("../../../../icons/32x32.png");
        let sha = validate::payload(bytes).sha256;
        fs::write(self.store.images_root().join(&sha), bytes).unwrap();
        self.store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO image_asset VALUES (?1,'image/png',?2,?3)",
                    rusqlite::params![sha, bytes.len() as i64, format!("images/{sha}")],
                )
                .map_err(error)?;
                tx.execute(
                    "UPDATE correction SET image_sha256=?1 WHERE state='defined'",
                    [&sha],
                )
                .map_err(error)?;
                tx.execute(
                    "INSERT INTO reference_value VALUES ('card','cover','',?1,'manual',?2)",
                    rusqlite::params![json!(sha).to_string(), sha],
                )
                .map_err(error)?;
                Ok(())
            })
            .unwrap();
        sha
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/backup-export.json"
    ))
    .unwrap()
}
fn document(path: &std::path::Path) -> Value {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    serde_json::from_reader(zip.by_name("catalogue.json").unwrap()).unwrap()
}
#[test]
fn manual_contract_matches_snapshot_and_dtos() {
    let f = Fixture::new();
    f.seed();
    let expected = fixture();
    let snapshot = f.store.backup_snapshot(7).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&snapshot.catalogue).unwrap(),
        expected["catalogue"]
    );
    let p: ExportPlan = serde_json::from_value(expected["plan"].clone()).unwrap();
    assert_eq!(serde_json::to_value(p).unwrap(), expected["plan"]);
    let receipt: crate::services::catalogue::scan::Receipt = scan_receipt(&expected["receipt"]);
    assert_eq!(serde_json::to_value(receipt).unwrap(), expected["receipt"]);
    validate::document(&expected["catalogue"]).unwrap();
}
fn scan_receipt(v: &Value) -> crate::services::catalogue::scan::Receipt {
    crate::services::catalogue::scan::Receipt {
        operation_id: v["operationId"].as_str().unwrap().into(),
        request_id: v["requestId"].as_str().unwrap().into(),
        sources_revision: v["sourcesRevision"].as_i64().unwrap(),
        catalogue_revision: v["catalogueRevision"].as_i64().unwrap(),
    }
}
#[test]
fn complete_export_is_portable_deduplicated_and_excludes_technical_data() {
    let f = Fixture::new();
    f.seed();
    let sha = f.image();
    f.store.write(|tx| {
        tx.execute_batch("
            INSERT INTO tag VALUES ('t','Calme','calme',1);
            INSERT INTO tag_member VALUES ('t','card');
            INSERT INTO fiche VALUES ('orphan',2,0,1);
            INSERT INTO fiche_grouping VALUES ('orphan','card');
            INSERT INTO operation VALUES ('op','group','committed','req',7,1,'{\"secret\":true}');
            INSERT INTO suggestion_decision VALUES ('refusal','[\"card\",\"orphan\"]','{\"kind\":\"manual\"}','refused','op');
            INSERT INTO exemplar VALUES ('ex','card',NULL,'{\"path\":\"/old/pack.zip\"}',NULL,'{\"secret\":true}',1,0,1);
            INSERT INTO reference_source VALUES ('card','ex',1,1);
            INSERT INTO pack_identity VALUES ('12345678-1234-1234-1234-123456789012','card','{\"kind\":\"file\"}');
            INSERT INTO provenance(id,kind,url,language) VALUES ('web','web','https://example.org/cover','it');
            INSERT INTO reference_value VALUES ('card','description','it','\"Descrizione\"','web',NULL);").map_err(error)?;Ok(())
    }).unwrap();
    fs::write(f.root.join("real-pack.zip"), b"pack bytes").unwrap();
    fs::write(f.store.staging_root().join("private-staging"), b"private").unwrap();
    let plan = f.plan();
    assert_eq!(
        plan.counts,
        format::Counts {
            cards: 2,
            tags: 1,
            images: 1
        }
    );
    let result = f.publish(&plan, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        result["digest"],
        validate::payload(&fs::read(f.path()).unwrap()).sha256
    );
    let manifest = validate::archive(&f.path()).unwrap();
    assert_eq!(manifest.entries.len(), 2);
    assert!(manifest.entries.contains_key(&format!("images/{sha}")));
    let value = document(&f.path());
    assert_eq!(value["references"][0]["exemplarId"], "ex");
    assert_eq!(value["suggestionDecisions"][0]["decision"], "refused");
    assert_eq!(value["associations"][0]["targetId"], "card");
    assert!(value["provenances"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["url"] == "https://example.org/cover"));
    assert!(!value.to_string().contains("secret"));
    assert_eq!(
        fs::read(f.root.join("real-pack.zip")).unwrap(),
        b"pack bytes"
    );
    assert_eq!(f.store.list_sources().unwrap().catalogue_revision, 7);
}
#[test]
fn frozen_images_survive_mutation_and_gc() {
    let f = Fixture::new();
    f.seed();
    let sha = f.image();
    let plan = f.plan();
    let store = Arc::clone(&f.store);
    std::thread::spawn(move || {
        store.write(|tx| {tx.execute_batch("DELETE FROM correction;DELETE FROM reference_value;UPDATE catalogue SET revision=8;").map_err(error)?;Ok(())}).unwrap();
        store.clean_orphan_images().unwrap();
    }).join().unwrap();
    assert!(!f.store.images_root().join(sha).exists());
    f.publish(&plan, &AtomicBool::new(false)).unwrap();
    let value = document(&f.path());
    assert_eq!(value["catalogueRevision"], 7);
    assert_eq!(value["corrections"].as_array().unwrap().len(), 3);
    validate::archive(&f.path()).unwrap();
}
#[test]
fn missing_and_corrupt_images_refuse_planning_without_final() {
    for corrupt in [false, true] {
        let f = Fixture::new();
        f.seed();
        let sha = f.image();
        let path = f.store.images_root().join(&sha);
        if corrupt {
            fs::write(path, b"damaged").unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
        let e = f.store.plan_catalogue_export(f.path(), 7).unwrap_err();
        assert_eq!(e.code, codes::CATALOG_BACKUP_IMAGE_MISSING);
        assert!(!f.path().exists());
        assert_eq!(fs::read_dir(f.store.backup_root()).unwrap().count(), 0);
    }
}
#[test]
fn stale_revision_and_changed_destination_require_replan() {
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    f.store
        .write(|tx| {
            tx.execute("UPDATE catalogue SET revision=8", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let e = f
        .store
        .start_catalogue_export(
            plan.plan_id,
            format::Decisions {
                summary_validated: true,
                replace_existing: false,
            },
            "request".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::CATALOG_BACKUP_EXPORT_SOURCE_CHANGED);
    let plan = f.plan();
    fs::write(f.path(), b"rival").unwrap();
    assert_eq!(
        f.publish(&plan, &AtomicBool::new(false)).unwrap_err().code,
        codes::CATALOG_BACKUP_DESTINATION_CONFLICT
    );
    assert_eq!(fs::read(f.path()).unwrap(), b"rival");
}
#[test]
fn cancellation_and_no_space_preserve_existing_backup() {
    let f = Fixture::new();
    f.seed();
    let first = f.plan();
    f.publish(&first, &AtomicBool::new(false)).unwrap();
    let original = fs::read(f.path()).unwrap();
    let plan = f.plan();
    assert_eq!(plan.conflicts, vec!["destinationExists"]);
    assert!(f.publish(&plan, &AtomicBool::new(true)).is_err());
    crate::services::catalogue::files::publish::AVAILABLE_BYTES.with(|v| v.set(Some(0)));
    assert!(f.publish(&plan, &AtomicBool::new(false)).is_err());
    crate::services::catalogue::files::publish::AVAILABLE_BYTES.with(|v| v.set(None));
    assert_eq!(fs::read(f.path()).unwrap(), original);
    assert!(!fs::read_dir(&f.root).unwrap().any(|e| e
        .unwrap()
        .path()
        .extension()
        .is_some_and(|s| s == "partial")));
    f.publish(&plan, &AtomicBool::new(false)).unwrap();
    validate::archive(&f.path()).unwrap();
}
#[test]
fn cancellation_during_writing_cleans_temporary() {
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    let registry = f.store.backup_exports.lock().unwrap();
    let cancel = AtomicBool::new(false);
    let result = export::write_archive(
        &f.store,
        &registry.plans[&plan.plan_id],
        &cancel,
        |phase| {
            if phase == "writing" {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        || Ok(()),
    );
    assert!(result.is_err());
    assert!(!f.path().exists());
    assert!(!fs::read_dir(&f.root).unwrap().any(|e| e
        .unwrap()
        .path()
        .extension()
        .is_some_and(|s| s == "partial")));
}
#[test]
fn rejects_technical_destination_and_arbitrary_existing_file() {
    let f = Fixture::new();
    assert!(f
        .store
        .plan_catalogue_export(f.store.images_root().join("backup.zip"), 0)
        .is_err());
    fs::write(f.path(), b"not a catalogue backup").unwrap();
    assert!(f.store.plan_catalogue_export(f.path(), 0).is_err());
    assert_eq!(fs::read(f.path()).unwrap(), b"not a catalogue backup");
}
#[test]
fn shared_limits_reject_depth_rows_invalid_states_and_archive_tampering() {
    let mut value = fixture()["catalogue"].clone();
    value["corrections"][0]["state"] = json!("unknown");
    assert!(validate::document(&value).is_err());
    let mut value = fixture()["catalogue"].clone();
    let mut deep = json!(null);
    for _ in 0..40 {
        deep = json!([deep]);
    }
    value["corrections"][0]["value"] = deep;
    assert!(validate::document(&value).is_err());
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    f.publish(&plan, &AtomicBool::new(false)).unwrap();
    let mut bytes = fs::read(f.path()).unwrap();
    let at = bytes.windows(5).position(|b| b == b"Titre").unwrap();
    bytes[at] = b'X';
    fs::write(f.path(), bytes).unwrap();
    assert!(validate::archive(&f.path()).is_err());
}
#[test]
fn operation_is_idempotent_and_carries_verified_result() {
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    let decisions = format::Decisions {
        summary_validated: true,
        replace_existing: false,
    };
    let receipt = f
        .store
        .start_catalogue_export(
            plan.plan_id.clone(),
            decisions.clone(),
            "request".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_eq!(
        f.store
            .start_catalogue_export(
                plan.plan_id,
                decisions,
                "request".into(),
                Arc::new(|_, _| {})
            )
            .unwrap(),
        receipt
    );
    let id = receipt["operationId"].as_str().unwrap();
    let started = std::time::Instant::now();
    loop {
        let operations = f.store.scans.operations.lock().unwrap();
        let p = operations[id].progress.lock().unwrap().clone();
        drop(operations);
        if p.status == "success" {
            assert_eq!(p.result.unwrap()["catalogueRevision"], 7);
            return;
        }
        assert_ne!(p.status, "failed");
        assert!(
            started.elapsed() < crate::test_support::timeout(),
            "export did not finish"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn independently_authored_archive_contract_is_readable_and_rejects_unknown_versions() {
    use std::io::Write;
    let f = Fixture::new();
    let contract = fixture();
    let mut manifest = contract["manifest"].clone();
    for version in [1, 2] {
        manifest["formatVersion"] = json!(version);
        let mut zip = zip::ZipWriter::new(fs::File::create(f.path()).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("catalogue.json", options).unwrap();
        zip.write_all(contract["catalogueUtf8"].as_str().unwrap().as_bytes())
            .unwrap();
        zip.finish().unwrap();
        assert_eq!(validate::archive(&f.path()).is_ok(), version == 1);
    }
    let result: format::ExportResult = serde_json::from_value(contract["result"].clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), contract["result"]);
}
#[test]
fn every_correctable_field_and_language_survives_without_resolution_or_source_access() {
    let f = Fixture::new();
    f.seed();
    let fields = [
        "title",
        "description",
        "versionDeclared",
        "cover",
        "ageMin",
        "ageMax",
        "language",
        "author",
        "producer",
        "bonus",
        "keywords",
        "durationSeconds",
        "storyCount",
    ];
    f.store
        .write(|tx| {
            tx.execute("DELETE FROM correction", []).map_err(error)?;
            for field in fields {
                for language in ["fr", "en", "it"] {
                    for (index, state) in ["defined", "cleared", "source"].iter().enumerate() {
                        let card = format!("{field}-{language}-{index}");
                        tx.execute("INSERT INTO fiche VALUES (?1,1,1,7)", [&card])
                            .map_err(error)?;
                        tx.execute(
                            "INSERT INTO correction VALUES (?1,?2,?3,?4,?5,'manual',NULL,7)",
                            rusqlite::params![
                                card,
                                field,
                                language,
                                state,
                                if *state == "defined" {
                                    Some("\"saved value\"")
                                } else {
                                    None
                                }
                            ],
                        )
                        .map_err(error)?;
                    }
                }
            }
            Ok(())
        })
        .unwrap();
    let snapshot = f.store.backup_snapshot(7).unwrap();
    let value: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(
        value["corrections"].as_array().unwrap().len(),
        fields.len() * 9
    );
    for field in fields {
        for language in ["fr", "en", "it"] {
            let rows = value["corrections"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| v["field"] == field && v["language"] == language)
                .collect::<Vec<_>>();
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0]["value"], "saved value");
            assert_eq!(rows[1]["state"], "cleared");
            assert_eq!(rows[2]["state"], "source");
        }
    }
}
#[test]
fn publication_collision_and_same_size_image_corruption_are_refused() {
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    let registry = f.store.backup_exports.lock().unwrap();
    let result = export::write_archive(
        &f.store,
        &registry.plans[&plan.plan_id],
        &AtomicBool::new(false),
        |phase| {
            if phase == "publication" {
                fs::write(f.path(), b"external file").unwrap();
            }
        },
        || Ok(()),
    );
    assert_eq!(
        result.unwrap_err().code,
        codes::CATALOG_BACKUP_DESTINATION_CONFLICT
    );
    assert_eq!(fs::read(f.path()).unwrap(), b"external file");
    drop(registry);
    fs::remove_file(f.path()).unwrap();
    let sha = f.image();
    let path = f.store.images_root().join(sha);
    let mut bytes = fs::read(&path).unwrap();
    bytes[20] ^= 1;
    fs::write(path, bytes).unwrap();
    assert_eq!(
        f.store.plan_catalogue_export(f.path(), 7).unwrap_err().code,
        codes::CATALOG_BACKUP_IMAGE_MISSING
    );
}

#[cfg(unix)] // POSIX permissions exercise a genuinely read-only destination.
#[test]
fn read_only_destination_fails_without_changing_source() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.seed();
    let dir = f.root.join("readonly");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("backup.zip");
    let plan = f.store.plan_catalogue_export(path.clone(), 7).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
    let result = f.publish(&plan, &AtomicBool::new(false));
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert!(!path.exists());
    assert_eq!(f.store.list_sources().unwrap().catalogue_revision, 7);
}
#[test]
fn replacement_never_overwrites_a_rival_arriving_at_the_publication_boundary() {
    let f = Fixture::new();
    f.seed();
    let first = f.plan();
    f.publish(&first, &AtomicBool::new(false)).unwrap();
    let plan = f.plan();
    let registry = f.store.backup_exports.lock().unwrap();
    let result = export::write_archive(
        &f.store,
        &registry.plans[&plan.plan_id],
        &AtomicBool::new(false),
        |_| {},
        || {
            fs::write(f.path(), b"rival at publication").unwrap();
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(f.path()).unwrap(), b"rival at publication");
}
#[test]
fn snapshot_image_pin_distinguishes_missing_payload_from_a_new_revision() {
    let f = Fixture::new();
    f.seed();
    let sha = f.image();
    fs::remove_file(f.store.images_root().join(&sha)).unwrap();
    assert_eq!(
        f.store.pin_snapshot_image(&sha, 7).unwrap_err().code,
        codes::CATALOG_BACKUP_IMAGE_MISSING
    );
    f.store
        .write(|tx| {
            tx.execute_batch("DELETE FROM correction;DELETE FROM reference_value;UPDATE catalogue SET revision=8;")
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    f.store.clean_orphan_images().unwrap();
    assert_eq!(
        f.store.pin_snapshot_image(&sha, 7).unwrap_err().code,
        codes::CATALOG_BACKUP_EXPORT_SOURCE_CHANGED
    );
}

#[test]
fn snapshot_racing_a_mutation_and_gc_never_combines_revisions() {
    for _ in 0..8 {
        let f = Fixture::new();
        f.seed();
        f.image();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writer = Arc::clone(&f.store);
        let ready = Arc::clone(&barrier);
        let mutation = std::thread::spawn(move || {
            ready.wait();
            writer.write(|tx| {
                tx.execute_batch("DELETE FROM correction;DELETE FROM reference_value;UPDATE fiche SET favorite=0;UPDATE catalogue SET revision=8;").map_err(error)?;Ok(())
            }).unwrap();
            writer.clean_orphan_images().unwrap();
        });
        barrier.wait();
        let snapshot = f.store.backup_snapshot(7);
        mutation.join().unwrap();
        match snapshot {
            Ok(s) => {
                let v: Value = serde_json::from_slice(&s.catalogue).unwrap();
                assert_eq!(v["catalogueRevision"], 7);
                assert_eq!(v["cards"][0]["favorite"], 1);
                assert_eq!(v["corrections"].as_array().unwrap().len(), 3);
                assert_eq!(s.manifest.counts.images, 1);
                for key in s
                    .manifest
                    .entries
                    .keys()
                    .filter(|n| n.starts_with("images/"))
                {
                    assert!(s.root.join(&key[7..]).exists());
                }
            }
            Err(e) => assert_eq!(e.code, codes::CATALOG_BACKUP_EXPORT_SOURCE_CHANGED),
        }
        let s = f.store.backup_snapshot(8).unwrap();
        let v: Value = serde_json::from_slice(&s.catalogue).unwrap();
        assert_eq!(v["cards"][0]["favorite"], 0);
        assert!(v["corrections"].as_array().unwrap().is_empty());
        assert_eq!(s.manifest.counts.images, 0);
    }
}

#[test]
fn interrupted_replacement_restores_previous_archive_on_store_reopen() {
    let f = Fixture::new();
    f.seed();
    let plan = f.plan();
    f.publish(&plan, &AtomicBool::new(false)).unwrap();
    let before = fs::read(f.path()).unwrap();
    let replacement = f.plan();
    export::INTERRUPT_AFTER_MOVE.with(|flag| flag.set(true));
    assert!(f.publish(&replacement, &AtomicBool::new(false)).is_err());
    assert!(!f.path().exists());
    let path = f.path();
    let root = f.root.clone();
    drop(
        f.store
            .backup_exports
            .lock()
            .unwrap()
            .plans
            .remove(&replacement.plan_id),
    );
    // Keep the fixture directory alive while dropping the original writer.
    let mut f = f;
    drop(std::mem::replace(
        &mut f.store,
        Arc::new(Store::open(&root.join("other-data"), &root.join("other-cache")).unwrap()),
    ));
    let reopened = Store::open(&root.join("data"), &root.join("cache")).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(reopened.warnings.is_empty());
    assert!(reopened.recover_backup_publications().unwrap().is_empty());
    // A completed recovery releases the destination for a normal replacement.
    let plan = reopened.plan_catalogue_export(path.clone(), 7).unwrap();
    let registry = reopened.backup_exports.lock().unwrap();
    export::write_archive(
        &reopened,
        &registry.plans[&plan.plan_id],
        &AtomicBool::new(false),
        |_| {},
        || Ok(()),
    )
    .unwrap();
    assert_eq!(document(&path)["catalogueRevision"], 7);
    assert_eq!(
        reopened
            .read(
                |c| c.query_row("SELECT count(*) FROM backup_publication", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
}

#[test]
fn interrupted_replacement_preserves_a_rival_and_the_recoverable_original() {
    let mut f = Fixture::new();
    f.seed();
    let first = f.plan();
    f.publish(&first, &AtomicBool::new(false)).unwrap();
    let original = fs::read(f.path()).unwrap();
    let replacement = f.plan();
    export::INTERRUPT_AFTER_MOVE.with(|flag| flag.set(true));
    assert!(f.publish(&replacement, &AtomicBool::new(false)).is_err());
    let recovery = fs::read_dir(&f.root)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "previous"))
        .unwrap();
    fs::write(f.path(), b"new external archive").unwrap();
    let root = f.root.clone();
    drop(std::mem::replace(
        &mut f.store,
        Arc::new(Store::open(&root.join("other-data"), &root.join("other-cache")).unwrap()),
    ));
    let reopened = Store::open(&root.join("data"), &root.join("cache")).unwrap();
    assert_eq!(fs::read(f.path()).unwrap(), b"new external archive");
    assert_eq!(fs::read(recovery).unwrap(), original);
    assert_eq!(reopened.warnings.len(), 1);
    assert_eq!(
        reopened
            .plan_catalogue_export(f.path(), 7)
            .unwrap_err()
            .code,
        codes::CATALOG_BACKUP_DESTINATION_CONFLICT
    );
}

#[test]
fn m1_portable_export_keeps_offline_cards_and_excludes_confirmed_erasures_and_refusals() {
    let f = Fixture::new();
    f.seed();
    let packs = f.root.join("packs");
    fs::create_dir_all(&packs).unwrap();
    let added = f.store.add_source(&packs, 0, false).unwrap();
    // A durable exemplar without any observation cache is offline, not erased.
    f.store.write(|tx| {
        tx.execute("INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,retired) VALUES ('offline','card',?1,'{}',1,0)",[json!({"path":packs.join("absent.zip").to_string_lossy()}).to_string()]).map_err(error)?;
        Ok(())
    }).unwrap();
    let revision = f.store.list_sources().unwrap().catalogue_revision;
    let snapshot = f.store.backup_snapshot(revision).unwrap();
    let doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    assert_eq!(doc["cards"].as_array().unwrap().len(), 1);
    assert_eq!(doc["corrections"].as_array().unwrap().len(), 3);
    drop(snapshot);
    let p = f.store.preview_remove_source(&added.source_id).unwrap();
    assert_eq!(p.count, 1);
    f.store
        .remove_source_confirmed(&added.source_id, p.sources_revision, p.catalogue_revision)
        .unwrap();
    let snapshot = f.store.backup_snapshot(p.catalogue_revision + 1).unwrap();
    let doc: Value = serde_json::from_slice(&snapshot.catalogue).unwrap();
    for key in [
        "cards",
        "corrections",
        "exemplarHints",
        "identities",
        "forgottenCards",
        "rootHints",
    ] {
        assert!(doc[key].as_array().unwrap().is_empty(), "{key}");
    }
}
