use super::*;
use crate::services::catalogue::{
    files::{checker, duplicates},
    open::editor_extractions,
};
fn refresh(f: &Fixture, path: &Path) {
    let source = f.store.list_sources().unwrap().items[0].clone();
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: path.into(),
                settled: true,
                structural: true,
            }],
            &f.store
                .exclusions(&f.root.join("cache"), &f.root.join("data"))
                .unwrap(),
            Duration::ZERO,
            &AtomicBool::new(false),
            &writes::Registry::default(),
        )
        .unwrap();
}
fn find(f: &Fixture, fiche: Option<String>, request: &str) -> (Value, Value) {
    let receipt = f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: fiche },
            request.into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let progress = f.wait(receipt["operationId"].as_str().unwrap());
    assert_eq!(progress.status, "success", "{:?}", progress.error);
    let result = f
        .store
        .duplicate_results(receipt["operationId"].as_str().unwrap(), 0, 100)
        .unwrap();
    (receipt, result)
}
#[test]
fn handwritten_diagnostics_and_checker_dtos_have_the_public_shape() {
    let mut manual: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/duplicates-page.json"
    ))
    .unwrap();
    manual.as_object_mut().unwrap().remove("cursor");
    let actual = duplicates::Results {
        exact_groups: vec![duplicates::ExactGroup {
            digest: "0123456789abcdef".into(),
            exemplar_ids: vec!["pack-a".into(), "pack-b".into()],
        }],
        older_versions: vec![duplicates::OlderVersion {
            uuid: "bda17862-0d71-41f6-974a-111111111111".into(),
            format: "zip".into(),
            exemplar_ids: vec!["pack-c".into()],
        }],
        issues: vec![
            json!({"exemplarId":"pack-d","code":"CATALOG_DUPLICATE_HASH_FAILED","detail":"read failed"}),
        ],
    };
    assert_eq!(serde_json::to_value(actual).unwrap(), manual);
    let manual: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/checker-entry.json"
    ))
    .unwrap();
    let actual = checker::Entry {
        preparation_id: "preparation-a".into(),
        zip_path: "/cache/checker/pack.zip".into(),
        source: checker::Source {
            exemplar_id: "pack-a".into(),
            path: "/packs/bundle.7z".into(),
            child_id: Some("pack-a".into()),
        },
        temporary: true,
        content_token: "content-and-identity".into(),
    };
    assert_eq!(serde_json::to_value(actual).unwrap(), manual);
}
#[test]
fn exact_and_older_versions_are_separate_requested_diagnostics() {
    let f = Fixture::new(false);
    let same = f.source.with_file_name("Same.zip");
    fs::copy(&f.source, &same).unwrap();
    refresh(&f, &same);
    let (_, result) = find(&f, None, "exact");
    assert_eq!(result["exactGroups"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["exactGroups"][0]["exemplarIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(result["olderVersions"], json!([]));
    let output = f.source.with_file_name("New.zip");
    prepare_fixture_zip(
        &f.source,
        &output,
        &BTreeMap::from([("versionDeclared".into(), json!(2))]),
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    refresh(&f, &output);
    let (receipt, result) = find(
        &f,
        Some(f.card["ficheId"].as_str().unwrap().into()),
        "versions",
    );
    assert_eq!(result["olderVersions"].as_array().unwrap().len(), 1);
    assert_eq!(result["olderVersions"][0]["format"], "zip");
    assert_eq!(
        result["olderVersions"][0]["exemplarIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(result["issues"], json!([]));
    assert_eq!(
        f.store
            .find_duplicates(
                duplicates::Scope {
                    fiche_id: Some(f.card["ficheId"].as_str().unwrap().into())
                },
                "versions".into(),
                Arc::new(|_, _| {})
            )
            .unwrap(),
        receipt
    );
    assert!(f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: None },
            "versions".into(),
            Arc::new(|_, _| {})
        )
        .is_err());
    let id = receipt["operationId"].as_str().unwrap();
    let first = f.store.duplicate_results(id, 0, 1).unwrap();
    assert_eq!(first["cursor"], 1);
    let second = f.store.duplicate_results(id, 1, 1).unwrap();
    assert!(second["cursor"].is_null());
    assert!(f.store.duplicate_results(id, 3, 1).is_err());
    assert!(f.store.duplicate_results(id, 0, 0).is_err());
    assert!(f.source.exists());
    assert!(same.exists());
    assert!(output.exists());
}
#[test]
fn formats_and_undeclared_versions_are_not_compared() {
    let f = Fixture::new(false);
    let output = f.source.with_file_name("New.zip");
    prepare_fixture_zip(
        &f.source,
        &output,
        &BTreeMap::from([("versionDeclared".into(), json!(2))]),
        None,
        &AtomicBool::new(false),
    )
    .unwrap();
    let directory = f.source.with_file_name("Folder");
    fs::create_dir(&directory).unwrap();
    let mut z = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    z.extract(&directory).unwrap();
    refresh(&f, &directory);
    let (_, result) = find(&f, None, "formats");
    assert_eq!(result["olderVersions"], json!([]));
}
/// Device packs read from a 7z are left out of the diagnostics like device
/// ZIPs: their conversion is not byte-stable, so they are neither hashed nor
/// compared by version, and never reported as a changed source.
#[test]
fn seven_zip_device_packs_are_excluded_like_device_zips() {
    let f = Fixture::new(false);
    let first = f.source.with_file_name("Device A.7z");
    device_seven_zip(&first);
    let second = f.source.with_file_name("Device B.7z");
    fs::copy(&first, &second).unwrap();
    refresh(&f, &first);
    refresh(&f, &second);
    let receipt = f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: None },
            "device-7z".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let progress = f.wait(receipt["operationId"].as_str().unwrap());
    assert_eq!(progress.status, "success", "{:?}", progress.error);
    // Only the STUdio ZIP of the fixture is examined.
    assert_eq!(progress.candidates.processed, 1);
    let result = f
        .store
        .duplicate_results(receipt["operationId"].as_str().unwrap(), 0, 100)
        .unwrap();
    assert_eq!(result["issues"], json!([]));
    assert_eq!(result["exactGroups"], json!([]));
    assert_eq!(result["olderVersions"], json!([]));
}
#[test]
fn hash_reads_media_bytes_even_when_size_and_timestamp_match() {
    use std::fs::{File, FileTimes};
    let f = Fixture::new(true);
    let other = f.source.with_file_name("Other");
    patch::copy_tree(&f.source, &other, &AtomicBool::new(false)).unwrap();
    let media = other.join("assets/audio");
    let original = f.source.join("assets/audio");
    let before = fs::metadata(&original).unwrap();
    let mut changed = fs::read(&original).unwrap();
    changed[0] ^= 1;
    fs::write(&media, changed).unwrap();
    File::options()
        .write(true)
        .open(&media)
        .unwrap()
        .set_times(FileTimes::new().set_modified(before.modified().unwrap()))
        .unwrap();
    assert_eq!(fs::metadata(&media).unwrap().len(), before.len());
    assert_ne!(
        duplicates::digest(&f.source, &AtomicBool::new(false)).unwrap(),
        duplicates::digest(&other, &AtomicBool::new(false)).unwrap()
    );
    refresh(&f, &other);
    let (_, result) = find(&f, None, "media");
    assert_eq!(result["exactGroups"], json!([]));
}
#[test]
fn cancellation_while_waiting_for_the_heavy_worker_stops_hashing() {
    let f = Fixture::new(false);
    let guard = f.store.scans.heavy.lock().unwrap();
    let receipt = f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: None },
            "cancel".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let id = receipt["operationId"].as_str().unwrap();
    f.store.cancel_operation(id).unwrap();
    drop(guard);
    assert_eq!(f.wait(id).status, "cancelled");
    assert!(f.source.exists());
}
#[test]
fn direct_zip_and_folder_preparations_keep_sources_and_release_only_the_cache() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let registry = Arc::new(editor_extractions::Registry::new(f.root.join("checker")));
        let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        let entry = f
            .store
            .prepare_checker_entry(
                &registry,
                f.exemplar["id"].as_str().unwrap(),
                f.store.list_sources().unwrap().catalogue_revision,
            )
            .unwrap();
        assert_eq!(entry.temporary, directory);
        assert_eq!(entry.source.exemplar_id, f.exemplar["id"]);
        assert_eq!(
            entry.source.path,
            crate::support::paths::path_for_frontend(&f.source)
        );
        assert_eq!(entry.source.child_id, None);
        let zip = PathBuf::from(&entry.zip_path);
        assert!(zip.is_file());
        let source = patch::inventory(&f.source, &AtomicBool::new(false)).unwrap();
        // Un dossier préparé en archive ne garde que le pack : les fichiers
        // étrangers à sa racine ne font pas partie du pack converti.
        let expected = if directory { pack_only(source) } else { source };
        assert_eq!(
            patch::inventory(&zip, &AtomicBool::new(false)).unwrap(),
            expected
        );
        let task = registry.acquire(&entry.preparation_id).unwrap();
        registry.release(&entry.preparation_id).unwrap();
        assert!(zip.exists());
        drop(task);
        registry.release(&entry.preparation_id).unwrap();
        assert_eq!(zip.exists(), !directory);
        assert!(recovery::matches(&f.source, &before));
    }
}
struct DirectoryAlias(PathBuf);
impl DirectoryAlias {
    fn new(target: &Path, alias: PathBuf) -> Self {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &alias).unwrap();
        // Directory junctions exercise Windows reparse checks without
        // requiring administrator rights or Developer Mode.
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(crate::support::paths::path_for_frontend(&alias).replace('/', "\\"))
                .arg(crate::support::paths::path_for_frontend(target).replace('/', "\\"))
                .output()
                .unwrap();
            assert!(output.status.success(), "junction creation: {output:?}");
        }
        Self(alias)
    }
}
impl Drop for DirectoryAlias {
    fn drop(&mut self) {
        #[cfg(windows)]
        fs::remove_dir(&self.0).unwrap();
        #[cfg(unix)]
        fs::remove_file(&self.0).unwrap();
    }
}

#[test]
fn checker_extraction_accepts_linked_cache_but_refuses_links_inside_the_extraction() {
    let f = Fixture::new(true);
    let physical = f.root.join("physical-cache");
    fs::create_dir(&physical).unwrap();
    let cache_alias = DirectoryAlias::new(&physical, f.root.join("cache-alias"));
    let cache = cache_alias.0.join("not-created-yet");
    assert!(!cache.exists());
    let state = crate::services::catalogue::CatalogueState::default();
    let registry = crate::services::catalogue::open::editor_extractions_in(&state, &cache).unwrap();
    let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let entry = f
        .store
        .prepare_checker_entry(
            &registry,
            f.exemplar["id"].as_str().unwrap(),
            f.store.list_sources().unwrap().catalogue_revision,
        )
        .unwrap();
    assert!(entry.temporary);
    let zip = PathBuf::from(&entry.zip_path);
    let canonical_cache = PathBuf::from(crate::support::paths::path_for_frontend(
        cache.canonicalize().unwrap(),
    ));
    assert!(zip.starts_with(&canonical_cache));
    let lease = registry.acquire(&entry.preparation_id).unwrap();
    assert!(lease.path().starts_with(&canonical_cache));
    drop(lease);
    checker::require_content(&zip, &entry.content_token).unwrap();
    assert!(recovery::matches(&f.source, &before));

    let outside = f.root.join("outside-extraction");
    fs::create_dir(&outside).unwrap();
    let outside_zip = outside.join("pack.zip");
    fs::copy(&zip, &outside_zip).unwrap();
    let outside_token =
        patch::token(&patch::snapshot(&outside_zip, &AtomicBool::new(false)).unwrap());
    checker::require_content(&outside_zip, &outside_token).unwrap();
    let internal_alias = DirectoryAlias::new(&outside, zip.parent().unwrap().join("linked"));
    let error =
        checker::require_content(&internal_alias.0.join("pack.zip"), &outside_token).unwrap_err();
    assert_eq!(error.code, codes::CATALOG_FILE_VERIFY_FAILED);
    drop(internal_alias);
    registry.release(&entry.preparation_id).unwrap();
    assert!(!zip.exists());
}

#[test]
fn registered_source_through_a_directory_alias_supports_checker_duplicates_and_trash() {
    let mut f = Fixture::new(true);
    let packs = f.source.parent().unwrap().to_path_buf();
    patch::copy_tree(&f.source, &packs.join("Second"), &AtomicBool::new(false)).unwrap();
    let alias = DirectoryAlias::new(&packs, f.root.join("user-selected-source"));
    f.store =
        Arc::new(Store::open(&f.root.join("alias-data"), &f.root.join("alias-cache")).unwrap());
    f.store.add_source(&alias.0, 0, false).unwrap();
    let receipt = f
        .store
        .start_scan(
            None,
            uuid::Uuid::new_v4().to_string(),
            f.store.list_sources().unwrap().sources_revision,
            f.root.join("alias-cache"),
            f.root.join("alias-data"),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let progress = f.wait(&receipt.operation_id);
    assert_eq!(progress.status, "success", "{:?}", progress.error);

    let page = f.store.list_entries(100, None).unwrap();
    let item = serde_json::to_value(&page).unwrap()["items"][0].clone();
    f.card = f.store.get_card(item["id"].as_str().unwrap()).unwrap();
    f.source = crate::support::paths::without_verbatim_prefix(f.source.canonicalize().unwrap());
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            f.store
                .resolve_target(e["id"].as_str().unwrap(), page.catalogue_revision)
                .unwrap()
                .path
                == f.source
        })
        .unwrap()
        .clone();
    let target = f
        .store
        .resolve_target(f.exemplar["id"].as_str().unwrap(), page.catalogue_revision)
        .unwrap();
    assert_eq!(target.path, f.source);
    assert!(!target.path.starts_with(&alias.0));

    let state = crate::services::catalogue::CatalogueState::default();
    let registry = crate::services::catalogue::open::editor_extractions_in(
        &state,
        &f.root.join("checker-cache"),
    )
    .unwrap();
    let entry = f
        .store
        .prepare_checker_entry(
            &registry,
            f.exemplar["id"].as_str().unwrap(),
            page.catalogue_revision,
        )
        .unwrap();
    checker::require_content(Path::new(&entry.zip_path), &entry.content_token).unwrap();
    registry.release(&entry.preparation_id).unwrap();
    let (_, duplicates) = find(&f, None, "alias-duplicates");
    assert_eq!(duplicates["issues"], json!([]));
    assert_eq!(duplicates["exactGroups"].as_array().unwrap().len(), 1);
    assert_eq!(
        duplicates["exactGroups"][0]["exemplarIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let plan = f
        .store
        .plan_file_operation(
            "trash".into(),
            vec![TargetRequest {
                fiche_id: f.card["ficheId"].as_str().unwrap().into(),
                exemplar_id: f.exemplar["id"].as_str().unwrap().into(),
                expected_revision: f.store.list_sources().unwrap().catalogue_revision,
            }],
            serde_json::from_value(json!({"mode":"replace"})).unwrap(),
        )
        .unwrap();
    let token = f
        .store
        .confirm_file_removal(&plan.plan_id, "trash", None)
        .unwrap()
        .token;
    // Exercise the full removal worker while replacing only the OS bin move:
    // the payload stays inside this disposable fixture on every platform.
    let bin = f.root.join("simulated-bin-item");
    super::super::trash_native::tracked_injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), bin.clone());
    let receipt = f
        .store
        .start_file_operation(
            plan.plan_id,
            Decisions {
                summary_validated: true,
                skip_exemplar_ids: vec![],
                removal_confirmations: vec![token],
            },
            "alias-trash".into(),
            Arc::new(|_, _| {}),
            f.root.join("alias-cache"),
            f.root.join("alias-data"),
        )
        .unwrap();
    let progress = f.wait(receipt["operationId"].as_str().unwrap());
    assert_eq!(progress.status, "success", "{:?}", progress.error);
    assert!(!f.source.exists());
    assert!(bin.join("story.json").is_file());
    assert!(packs.join("Second/story.json").is_file());
}

#[test]
fn checker_revision_failure_does_not_leave_a_preparation() {
    let f = Fixture::new(false);
    let path = f.root.join("checker");
    let registry = Arc::new(editor_extractions::Registry::new(path.clone()));
    let error = f
        .store
        .prepare_checker_entry(&registry, f.exemplar["id"].as_str().unwrap(), -1)
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_CHECKER_PREPARATION_FAILED);
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    assert!(f.source.exists());
}

#[test]
fn checker_native_and_child_inputs_use_the_shared_conversion_and_keep_the_container() {
    use std::io::Write;
    for kind in ["fs", "archive-entry", "pack-root", "7z"] {
        let f = Fixture::new(false);
        let bytes = fs::read(&f.source).unwrap();
        let studio_expected = patch::inventory(&f.source, &AtomicBool::new(false)).unwrap();
        let path = f.source.parent().unwrap().join(if kind == "fs" {
            crate::support::fs_pack_reader::fs_fixtures::DIALECT_PACK_UUID
        } else if kind == "7z" {
            "Input.7z"
        } else {
            "Bundle.zip"
        });
        if kind == "fs" {
            crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&path);
        } else if kind == "7z" {
            let tool = Path::new("/usr/bin/7z");
            if !tool.exists() {
                eprintln!("SKIP: injected archive reader absent");
                continue;
            }
            formats::write_seven(tool, &f.source, &path, &AtomicBool::new(false)).unwrap();
        } else {
            let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            if kind == "archive-entry" {
                writer
                    .start_file("nested/pack.zip", zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(&bytes).unwrap();
            } else {
                let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i).unwrap();
                    writer
                        .start_file(
                            format!("nested/pack/{}", entry.name()),
                            zip::write::SimpleFileOptions::default(),
                        )
                        .unwrap();
                    std::io::copy(&mut entry, &mut writer).unwrap();
                }
            }
            writer.finish().unwrap();
        }
        refresh(&f, &path);
        let page = serde_json::to_value(f.store.list_entries(100, None).unwrap()).unwrap();
        let exemplar = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["exemplars"].as_array().unwrap())
            .find(|e| {
                e["locator"]["path"] == crate::support::paths::path_for_frontend(&path).as_str()
            })
            .unwrap();
        let before = patch::snapshot(&path, &AtomicBool::new(false)).unwrap();
        let registry = Arc::new(editor_extractions::Registry::new(f.root.join("checker")));
        let entry = f
            .store
            .prepare_checker_entry(
                &registry,
                exemplar["id"].as_str().unwrap(),
                f.store.list_sources().unwrap().catalogue_revision,
            )
            .unwrap();
        assert!(entry.temporary);
        assert_eq!(
            entry.source.path,
            crate::support::paths::path_for_frontend(&path)
        );
        assert_eq!(
            entry.source.child_id.is_some(),
            matches!(kind, "archive-entry" | "pack-root")
        );
        let zip = Path::new(&entry.zip_path);
        assert!(zip.is_file());
        if kind != "fs" {
            // Une archive 7z est reconvertie : les fichiers étrangers à la racine
            // du pack ne font pas partie du pack converti.
            let expected = if kind == "7z" {
                pack_only(studio_expected.clone())
            } else {
                studio_expected.clone()
            };
            assert_eq!(
                patch::inventory(zip, &AtomicBool::new(false)).unwrap(),
                expected
            );
        }
        registry.release(&entry.preparation_id).unwrap();
        assert!(!zip.exists());
        assert!(recovery::matches(&path, &before));
    }
}

#[cfg(unix)]
#[test]
fn duplicate_hash_rejects_links_without_reading_or_modifying_the_outside_target() {
    let f = Fixture::new(true);
    let outside = f.root.join("outside");
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, f.source.join("escape")).unwrap();
    assert!(duplicates::digest(&f.source, &AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"outside");
}

#[test]
fn unreadable_exemplar_is_a_diagnostic_issue_and_an_error_in_the_operation_counts() {
    let f = Fixture::new(false);
    fs::remove_file(&f.source).unwrap();
    let (receipt, result) = find(&f, None, "missing");
    assert_eq!(result["exactGroups"], json!([]));
    assert_eq!(
        result["issues"][0]["code"],
        codes::CATALOG_DUPLICATE_HASH_FAILED
    );
    let progress = f
        .store
        .get_operation(receipt["operationId"].as_str().unwrap())
        .unwrap();
    assert_eq!(progress.outcomes.error, 1);
    assert_eq!(progress.outcomes.unchanged, 0);
}

#[test]
fn checker_tasks_refuse_content_replaced_after_preparation() {
    let f = Fixture::new(false);
    let registry = Arc::new(editor_extractions::Registry::new(f.root.join("checker")));
    let entry = f
        .store
        .prepare_checker_entry(
            &registry,
            f.exemplar["id"].as_str().unwrap(),
            f.store.list_sources().unwrap().catalogue_revision,
        )
        .unwrap();
    checker::require_content(&f.source, &entry.content_token).unwrap();
    fs::write(&f.source, b"replaced").unwrap();
    assert_eq!(
        checker::require_content(&f.source, &entry.content_token)
            .unwrap_err()
            .code,
        codes::CATALOG_CHECKER_PREPARATION_FAILED
    );
    registry.release(&entry.preparation_id).unwrap();
    assert_eq!(fs::read(&f.source).unwrap(), b"replaced");
}

#[test]
fn completed_diagnostics_can_be_released_for_more_than_thirty_two_searches() {
    let f = Fixture::new(false);
    let mut first = None;
    for n in 0..40 {
        let (receipt, _) = find(&f, None, &format!("successive-{n}"));
        assert_eq!(receipt["retentionSeconds"], 900);
        let id = receipt["operationId"].as_str().unwrap();
        assert_eq!(
            f.store.release_duplicate_results(id).unwrap(),
            json!({"released":true})
        );
        assert_eq!(
            f.store.release_duplicate_results(id).unwrap(),
            json!({"released":true})
        );
        assert_eq!(
            f.store.duplicate_results(id, 0, 100).unwrap_err().code,
            codes::CATALOG_OPERATION_EXPIRED
        );
        if first.is_none() {
            first = Some(receipt);
        }
    }
    let replay = f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: None },
            "successive-0".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_eq!(replay, first.unwrap());
    assert!(f.source.exists());
}

#[test]
fn release_cannot_discard_an_active_diagnostic() {
    let f = Fixture::new(false);
    let guard = f.store.scans.heavy.lock().unwrap();
    let receipt = f
        .store
        .find_duplicates(
            duplicates::Scope { fiche_id: None },
            "retain-active".into(),
            Arc::new(|_, _| {}),
        )
        .unwrap();
    let id = receipt["operationId"].as_str().unwrap();
    assert_eq!(
        f.store.release_duplicate_results(id).unwrap(),
        json!({"released":false})
    );
    assert!(f.store.duplicate_results(id, 0, 100).is_ok());
    f.store.cancel_operation(id).unwrap();
    drop(guard);
    assert_eq!(f.wait(id).status, "cancelled");
    assert_eq!(
        f.store.duplicate_results(id, 0, 100).unwrap_err().code,
        codes::CATALOG_OPERATION_EXPIRED
    );
    assert_eq!(
        f.store.release_duplicate_results(id).unwrap(),
        json!({"released":true})
    );
}

#[test]
fn checker_command_transport_preserves_replaced_content_and_closed_preparation_errors() {
    use crate::commands::pack::checker_transport;
    use crate::support::user_message::UserMessage;
    let f = Fixture::new(false);
    let registry = Arc::new(editor_extractions::Registry::new(f.root.join("checker")));
    let entry = f
        .store
        .prepare_checker_entry(
            &registry,
            f.exemplar["id"].as_str().unwrap(),
            f.store.list_sources().unwrap().catalogue_revision,
        )
        .unwrap();
    checker_transport(checker::require_content(&f.source, &entry.content_token)).unwrap();
    fs::write(&f.source, b"replaced after preparation").unwrap();
    let error = UserMessage::from(
        checker_transport(checker::require_content(&f.source, &entry.content_token)).unwrap_err(),
    );
    let payload = serde_json::to_value(&error).unwrap();
    assert_eq!(payload["code"], codes::CATALOG_CHECKER_PREPARATION_FAILED);
    assert_eq!(payload["params"], json!({}));
    registry.release(&entry.preparation_id).unwrap();
    let error = UserMessage::from(
        checker_transport(registry.acquire(&entry.preparation_id))
            .err()
            .expect("closed preparation cannot be acquired"),
    );
    let payload = serde_json::to_value(&error).unwrap();
    assert_eq!(payload["code"], codes::CATALOG_TARGET_REVISION_STALE);
    assert_eq!(payload["params"], json!({}));
    assert_eq!(fs::read(&f.source).unwrap(), b"replaced after preparation");
}

#[test]
fn fiche_identical_copies_is_scoped_cancellable_and_uses_full_bytes() {
    let f = Fixture::new(false);
    let same = f.source.with_file_name("Same.zip");
    fs::copy(&f.source, &same).unwrap();
    refresh(&f, &same);
    let fiche = f.card["ficheId"].as_str().unwrap();
    let copies = f
        .store
        .identical_copies(fiche, "fiche-copies".into())
        .unwrap();
    assert_eq!(copies.len(), 1);
    assert_eq!(
        f.store
            .identical_copies(fiche, "fiche-copies-again".into())
            .unwrap(),
        copies
    );
    assert!(f
        .store
        .identical_copies("other-fiche", "other".into())
        .unwrap()
        .is_empty());
    // A same-size edit after the first comparison must invalidate the cached
    // full fingerprint, even without a catalogue rescan.
    let mut bytes = fs::read(&same).unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 1;
    fs::write(&same, &bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(&same)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_nanos(1234567890))
        .unwrap();
    assert!(f
        .store
        .identical_copies(fiche, "changed-bytes".into())
        .unwrap()
        .is_empty());
    f.store.cancel_identical_copies("closed".into()).unwrap();
    assert!(f.store.identical_copies(fiche, "closed".into()).is_err());
}

#[test]
fn identical_copies_tombstones_never_refuse_a_new_request() {
    let f = Fixture::new(false);
    let fiche = f.card["ficheId"].as_str().unwrap();
    // Far more closes than the registry keeps: the oldest tombstones give way.
    for i in 0..1100 {
        f.store
            .cancel_identical_copies(format!("closed-{i}"))
            .unwrap();
    }
    assert!(f
        .store
        .identical_copies(fiche, "after-many-closes".into())
        .unwrap()
        .is_empty());
    // The most recent tombstone still stops its late request.
    assert!(f
        .store
        .identical_copies(fiche, "closed-1099".into())
        .is_err());
}

#[test]
fn fiche_identical_copies_compares_the_same_pack_member_of_two_multipacks() {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    for (container, member) in [
        ("zip", "pack.zip"),
        ("7z", "pack.zip"),
        ("zip", "Dossier/Pack.zip"),
        ("7z", "Dossier/Pack.zip"),
    ] {
        let f = Fixture::new(false);
        let bytes = fs::read(&f.source).unwrap();
        let staging = f.root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(staging.join(member).parent().unwrap()).unwrap();
        fs::write(staging.join(member), &bytes).unwrap();
        fs::write(staging.join("other.txt"), b"not a pack").unwrap();
        let mut bundles = vec![];
        for name in ["First", "Second"] {
            let path = f.source.with_file_name(format!("{name}.{container}"));
            if container == "zip" {
                let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
                for (entry, content) in [
                    ("other.txt", b"not a pack".to_vec()),
                    (member, bytes.clone()),
                ] {
                    writer
                        .start_file(entry, zip::write::SimpleFileOptions::default())
                        .unwrap();
                    writer.write_all(&content).unwrap();
                }
                writer.finish().unwrap();
            } else {
                let tool =
                    crate::support::imported_pack::resolve_7z_path().expect("7z for the fixtures");
                let status = std::process::Command::new(&tool)
                    .args(["a", "-t7z", "-ms=on", "--"])
                    .arg(&path)
                    .args([member, "other.txt"])
                    .current_dir(&staging)
                    .stdout(std::process::Stdio::null())
                    .status()
                    .unwrap();
                assert!(status.success());
                let inventory =
                    super::super::formats::inventory_with(&tool, &path, &AtomicBool::new(false))
                        .unwrap();
                assert_eq!(inventory.len(), 2);
                assert_eq!(
                    inventory.get(member),
                    Some(&format!("{:x}", Sha256::digest(&bytes)))
                );
            }
            assert_eq!(
                super::super::formats::member_size(
                    &path,
                    container,
                    &[json!({"kind":"archive-entry", "path":member})],
                    &AtomicBool::new(false),
                )
                .unwrap(),
                Some(bytes.len() as u64)
            );
            refresh(&f, &path);
            bundles.push(crate::support::paths::path_for_frontend(&path));
        }
        // Without the standalone pack, only the two archive members can match.
        fs::remove_file(&f.source).unwrap();
        let page = serde_json::to_value(f.store.list_entries(100, None).unwrap()).unwrap();
        let members: Vec<String> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["exemplars"].as_array().unwrap())
            .filter(|e| bundles.iter().any(|b| e["locator"]["path"] == b.as_str()))
            .map(|e| {
                assert_eq!(e["locator"]["member"], member);
                e["id"].as_str().unwrap().to_owned()
            })
            .collect();
        assert_eq!(members.len(), 2, "{container}: {page}");
        let fiche = f.card["ficheId"].as_str().unwrap();
        let copies = f
            .store
            .identical_copies(fiche, format!("members-{container}"))
            .unwrap();
        assert_eq!(copies.len(), 1, "{container}");
        assert!(members.contains(&copies[0]), "{container}");
    }
}
