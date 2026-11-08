use super::*;
use crate::services::catalogue::files::trash_native::tracked_injections;
use std::path::Path;

pub(super) fn tag_card(f: &Fixture) {
    let id = f.card["ficheId"].as_str().unwrap();
    f.store.mutate(serde_json::from_value(json!({"kind":"changeTags","requestKey":uuid::Uuid::new_v4().to_string(),"ficheIds":[id],"addLabels":["Retained"],"addTagIds":[],"removeTagIds":[]})).unwrap(), f.store.list_sources().unwrap().catalogue_revision).unwrap();
    f.store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [id])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
}
fn recycle(f: &Fixture, key: &str) -> PathBuf {
    let payload = f.root.join("native-trash/files").join(key);
    fs::create_dir_all(payload.parent().unwrap()).unwrap();
    tracked_injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), payload.clone());
    let p = plan(f);
    let token = confirm(f, &p, "trash", None);
    let receipt = launch(f, &p, vec![token], key).unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(payload.exists());
    assert!(!f.source.exists());
    payload
}

#[test]
fn trashed_last_copy_allows_device_repatriation_after_restart() {
    use crate::services::storyteller_device::cards::CardCatalogue;
    let mut f = Fixture::new(false);
    let uuid = uuid::Uuid::parse_str(f.card["uuid"].as_str().unwrap()).unwrap();
    let fiche = f.card["ficheId"].as_str().unwrap().to_owned();
    f.store.save_name(uuid, "Le Petit Nuage pack").unwrap();
    assert_eq!(f.store.device_card_link(uuid).unwrap().unwrap().0, fiche);
    // Models the archive recovered from the device, outside the removed copy.
    let recovered = f.root.join("recovered.zip");
    fs::copy(&f.source, &recovered).unwrap();
    let payload = recycle(&f, "device-repatriation");
    assert!(f.store.device_card_link(uuid).unwrap().is_none());
    assert_eq!(
        f.store.card(uuid).unwrap().unwrap().card.title,
        "Le Petit Nuage pack"
    );
    let replacement =
        Arc::new(Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap());
    drop(std::mem::replace(&mut f.store, replacement));
    f.store = Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
    assert!(f.store.device_card_link(uuid).unwrap().is_none());
    let (published, _) = f
        .store
        .publish_repatriated_story(&recovered, uuid, &f.root, "Le Petit Nuage pack")
        .unwrap();
    assert_eq!(published, fiche);
    assert_eq!(f.store.device_card_link(uuid).unwrap().unwrap().0, fiche);
    assert_eq!(
        f.store.card(uuid).unwrap().unwrap().card.title,
        "Le Petit Nuage pack"
    );
    assert!(
        payload.exists(),
        "repatriation leaves the native trash copy intact"
    );
}

#[test]
fn trashed_copy_does_not_allow_repatriation_while_an_offline_copy_remains() {
    let f = Fixture::new(false);
    let uuid = uuid::Uuid::parse_str(f.card["uuid"].as_str().unwrap()).unwrap();
    let fiche = f.card["ficheId"].as_str().unwrap();
    retain_other_copy(&f);
    recycle(&f, "device-offline-sibling");
    assert_eq!(f.store.device_card_link(uuid).unwrap().unwrap().0, fiche);
    assert!(f.store.retire_exemplar(fiche, "retained-copy").unwrap());
    assert!(f.store.device_card_link(uuid).unwrap().is_none());
}

fn empty(payload: &Path) {
    if payload.is_dir() {
        fs::remove_dir_all(payload).unwrap();
    } else {
        fs::remove_file(payload).unwrap();
    }
}
fn refresh(f: &Fixture) {
    let source = f
        .store
        .list_sources()
        .unwrap()
        .items
        .into_iter()
        .find(|source| {
            source.status == "active"
                && crate::services::catalogue::path_identity::contains(
                    &source.native_path,
                    &f.source,
                )
        })
        .expect("registered source of the refreshed file");
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: f.source.clone(),
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

fn full_scan(f: &Fixture) {
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
    assert_eq!(f.wait(&receipt.operation_id).status, "success");
}

fn personal_data(f: &Fixture) {
    tag_card(f);
    f.store.write(|tx| {
        tx.execute("INSERT INTO provenance(id,kind) VALUES ('absence-manual','manual')", []).map_err(error)?;
        tx.execute("INSERT INTO correction VALUES (?1,'ageMin','','defined','3','absence-manual',NULL,1)", [f.card["ficheId"].as_str().unwrap()]).map_err(error)?;
        Ok(())
    }).unwrap();
}

fn assert_personal_data(f: &Fixture) {
    let id = f.card["ficheId"].as_str().unwrap();
    let card = f
        .store
        .get_card(id)
        .expect("absence must preserve the fiche");
    assert_eq!(card["favorite"], true);
    assert_eq!(card["tags"][0]["label"], "Retained");
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    let correction: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT value_json FROM correction WHERE fiche_id=?1 AND field='ageMin'",
                [id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(correction, "3");
}

#[test]
fn trash_retention_absent_forever_keeps_visible_fiche_personal_data_and_tag() {
    absent_pack(false);
}

#[test]
fn trash_retention_missing_copy_blocks_another_copys_permanent_purge_after_restart() {
    for directory in [false, true] {
        let mut f = Fixture::new(directory);
        personal_data(&f);
        let original = f.source.clone();
        let copy = original.with_file_name(if directory { "Copy" } else { "Copy.zip" });
        patch::copy_tree(&original, &copy, &AtomicBool::new(false)).unwrap();
        full_scan(&f);
        let payload = recycle(&f, "copy-a-in-trash");
        f.source = copy;
        f.card = f
            .store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .unwrap();
        f.exemplar = f.card["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["state"] == "available")
            .expect("copy B remains available")
            .clone();
        let permanent = permanent_last_copy_plan(&f);
        let first = confirm(&f, &permanent, "targets", None);
        let second = confirm(&f, &permanent, "irreversible", Some(first.clone()));
        let receipt = launch(&f, &permanent, vec![first, second], "delete-copy-b").unwrap();
        let operation = receipt["operationId"].as_str().unwrap();
        assert_eq!(f.wait(operation).status, "success");
        assert!(!f.source.exists());
        assert_eq!(removal_row(&f, operation).0, "purgePending");
        assert_personal_data(&f);

        let placeholder = Arc::new(
            Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
        );
        drop(std::mem::replace(&mut f.store, placeholder));
        fs::rename(payload, &original).unwrap();
        let renamed = original.with_file_name(if directory { "Renamed" } else { "Renamed.zip" });
        fs::rename(&original, &renamed).unwrap();
        f.store = Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
        assert!(f
            .store
            .recover_inherited(f.store.inherited_recovery().unwrap())
            .is_empty());
        // Startup retries B's purge after A becomes Missing, before discovery.
        assert_personal_data(&f);
        assert!(f
            .store
            .read(super::super::super::trash_retention::retained_exemplars)
            .unwrap()
            .is_empty());
        assert_eq!(removal_row(&f, operation).0, "purgePending");
        assert!(!f.store.retry_removal_purges());
        assert_personal_data(&f);

        full_scan(&f);
        assert_personal_data(&f);
        let card = f
            .store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .unwrap();
        assert!(card["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["state"] == "available"
                && e["path"] == crate::support::paths::path_for_frontend(&renamed)));
        assert_eq!(f.store.list_entries(100, None).unwrap().items.len(), 1);
    }
}

#[test]
fn trash_retention_absent_pack_later_found_in_another_source_rejoins_its_fiche() {
    absent_pack(true);
}

#[test]
fn trash_retention_same_restored_exemplars_permanent_deletion_can_purge() {
    let f = Fixture::new(false);
    personal_data(&f);
    let payload = recycle(&f, "same-exemplar");
    fs::rename(payload, &f.source).unwrap();
    refresh(&f);
    assert_personal_data(&f);
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .unwrap()["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == f.exemplar["id"] && e["state"] == "available"));
    let permanent = permanent_last_copy_plan(&f);
    let first = confirm(&f, &permanent, "targets", None);
    let second = confirm(&f, &permanent, "irreversible", Some(first.clone()));
    let receipt = launch(&f, &permanent, vec![first, second], "delete-same-exemplar").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_err());
    assert!(f.store.list_tags().unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn trash_retention_inherited_absence_purge_pending_preserves_personal_data() {
    let f = Fixture::new(false);
    personal_data(&f);
    let payload = recycle(&f, "old-purge-pending");
    empty(&payload);
    // Journal produced by the former Emptied branch, possibly left pending
    // by an unrelated recovery blocker when the application was closed.
    f.store.write(|tx| {
        tx.execute("UPDATE file_removal SET state='purgePending',evidence_json=json_set(evidence_json,'$.retainedInTrash',json('false')) WHERE json_extract(evidence_json,'$.plan.targets[0].exemplarId')=?1", [f.exemplar["id"].as_str().unwrap()]).map_err(error)?;
        Ok(())
    }).unwrap();
    assert!(f.store.retry_removal_purges());
    assert_personal_data(&f);
    assert!(!f.store.retry_removal_purges());
    assert!(f
        .store
        .list_entries(100, None)
        .unwrap()
        .items
        .iter()
        .any(|e| e["id"] == f.card["ficheId"] && e["offlineReason"] == "unavailable"));
}

fn absent_pack(found_later: bool) {
    for directory in [false, true] {
        let mut f = Fixture::new(directory);
        personal_data(&f);
        let saved = f.root.join("outside-sources");
        patch::copy_tree(&f.source, &saved, &AtomicBool::new(false)).unwrap();
        let payload = recycle(&f, "absent-pack");
        empty(&payload);
        f.store.reconcile_trash_retention().unwrap();
        for restart in [false, true] {
            if restart {
                let placeholder = Arc::new(
                    Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
                );
                drop(std::mem::replace(&mut f.store, placeholder));
                f.store =
                    Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
                assert!(f
                    .store
                    .recover_inherited(f.store.inherited_recovery().unwrap())
                    .is_empty());
            }
            full_scan(&f);
            f.store.retry_removal_purges();
            assert!(f.store.reconcile_trash_retention().unwrap().is_none());
            assert_personal_data(&f);
            let entries = f.store.list_entries(100, None).unwrap();
            let entry = entries
                .items
                .iter()
                .find(|e| e["id"] == f.card["ficheId"])
                .expect("offline fiche remains visible");
            assert_eq!(entry["offlineReason"], "unavailable");
            assert!(entry["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["availability"] != "available"));
        }
        if found_later {
            let other = f.root.join("another-source");
            fs::create_dir(&other).unwrap();
            let moved = other.join(if directory { "Moved" } else { "Moved.zip" });
            fs::rename(saved, &moved).unwrap();
            f.store.add_source(&other, 1, false).unwrap();
            full_scan(&f);
            assert_personal_data(&f);
            let card = f
                .store
                .get_card(f.card["ficheId"].as_str().unwrap())
                .unwrap();
            assert!(card["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["state"] == "available"
                    && e["path"] == crate::support::paths::path_for_frontend(&moved)));
            assert_eq!(f.store.list_entries(100, None).unwrap().items.len(), 1);
        }
    }
}

#[test]
fn trash_retention_disconnected_source_never_purges_personal_data() {
    for emptied in [false, true] {
        let f = Fixture::new(false);
        full_scan(&f);
        personal_data(&f);
        let payload = recycle(&f, "disconnected-source");
        if emptied {
            empty(&payload);
        }
        fs::rename(f.root.join("packs"), f.root.join("unmounted-source")).unwrap();
        for _ in 0..3 {
            assert!(f.store.reconcile_trash_retention().unwrap().is_none());
            f.store.retry_removal_purges();
            assert_personal_data(&f);
        }
        // Keep the root genuinely inaccessible (NotFound), even when the
        // native trash payload is empty: no complete inventory proves absence.
        f.store
            .reconcile_source(
                &crate::services::catalogue::refresh::Root {
                    source_id: f.store.list_sources().unwrap().items[0].id.clone(),
                    path: f.root.join("packs"),
                },
                &f.store
                    .exclusions(&f.root.join("cache"), &f.root.join("data"))
                    .unwrap(),
                std::time::Duration::ZERO,
                &std::sync::atomic::AtomicBool::new(false),
                &|_| false,
                &crate::services::catalogue::writes::Registry::default(),
            )
            .unwrap();
        assert_eq!(
            f.store.list_sources().unwrap().items[0].availability,
            "unavailable"
        );
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        f.store.retry_removal_purges();
        assert_personal_data(&f);
    }
}

#[test]
fn trash_retention_explicit_permanent_deletion_purges_last_fiche_and_tag() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        personal_data(&f);
        let permanent = permanent_last_copy_plan(&f);
        let first = confirm(&f, &permanent, "targets", None);
        let second = confirm(&f, &permanent, "irreversible", Some(first.clone()));
        let receipt = launch(&f, &permanent, vec![first, second], "explicit-last").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap()).status,
            "success"
        );
        assert!(!f.source.exists());
        assert!(f
            .store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .is_err());
        let counts: (i64, i64, i64, i64) = f.store.read(|c| c.query_row(
            "SELECT (SELECT count(*) FROM correction),(SELECT count(*) FROM tag_member),(SELECT count(*) FROM tag),(SELECT count(*) FROM provenance WHERE id='absence-manual')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
        )).unwrap();
        assert_eq!(counts, (0, 0, 0, 0));
    }
}

pub(super) fn permanent_last_copy_plan(f: &Fixture) -> FilePlan {
    let trash = plan(f);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::UnavailableForTarget);
    let token = confirm(f, &trash, "trash", None);
    let receipt = launch(f, &trash, vec![token], "unavailable-last").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap())
            .error
            .unwrap()
            .code,
        codes::CATALOG_TRASH_UNAVAILABLE
    );
    f.store.prepare_permanent_delete(&trash.plan_id).unwrap()
}

#[test]
fn trash_retention_restore_then_rename_while_closed_preserves_personal_data() {
    restore_while_closed(true, true);
}

#[test]
fn trash_retention_restore_without_rename_while_closed_preserves_personal_data() {
    restore_while_closed(true, false);
}

#[test]
fn trash_retention_rename_without_trash_while_closed_preserves_personal_data() {
    restore_while_closed(false, true);
}

fn restore_while_closed(trash: bool, rename: bool) {
    for directory in [false, true] {
        let mut f = Fixture::new(directory);
        let id = f.card["ficheId"].as_str().unwrap().to_owned();
        tag_card(&f);
        f.store.write(|tx| {
            tx.execute("INSERT INTO provenance(id,kind) VALUES ('rename-manual','manual')", []).map_err(error)?;
            tx.execute("INSERT INTO correction VALUES (?1,'ageMin','','defined','3','rename-manual',NULL,1)", [&id]).map_err(error)?;
            Ok(())
        }).unwrap();
        let payload = trash.then(|| recycle(&f, "restore-then-rename"));
        let placeholder = Arc::new(
            Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
        );
        drop(std::mem::replace(&mut f.store, placeholder));
        if let Some(payload) = payload {
            fs::rename(payload, &f.source).unwrap();
        }
        let renamed = if rename {
            f.source
                .with_file_name(if directory { "Renamed" } else { "Renamed.zip" })
        } else {
            f.source.clone()
        };
        if rename {
            fs::rename(&f.source, &renamed).unwrap();
        }
        f.store = Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
        assert!(f
            .store
            .recover_inherited(f.store.inherited_recovery().unwrap())
            .is_empty());
        // Startup probes the native trash before reconciling the sources.
        f.store.reconcile_trash_retention().unwrap();
        assert!(
            f.store.get_card(&id).is_ok(),
            "a missing trash item is not proof of emptying"
        );
        full_scan(&f);
        f.store.reconcile_trash_retention().unwrap();
        let card = f.store.get_card(&id).unwrap();
        assert_eq!(card["favorite"], true);
        assert_eq!(card["tags"][0]["label"], "Retained");
        let correction: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT value_json FROM correction WHERE fiche_id=?1 AND field='ageMin'",
                    [&id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(correction, "3");
        assert!(
            card["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["state"] == "available"
                    && e["path"] == crate::support::paths::path_for_frontend(&renamed)),
            "the renamed pack must belong to the original fiche: {card}"
        );
        assert!(
            f.store
                .read(super::super::super::trash_retention::retained_exemplars)
                .unwrap()
                .is_empty(),
            "rediscovery consumes the retention"
        );
    }
}

#[test]
fn trash_retention_survives_restart_restores_tags_and_keeps_data_after_disappearance() {
    for kind in ["zip", "directory", "legacyProject"] {
        let mut f = if kind == "legacyProject" {
            project_fixture()
        } else {
            Fixture::new(kind == "directory")
        };
        let id = f.card["ficheId"].as_str().unwrap().to_owned();
        let exemplar = f.exemplar["id"].as_str().unwrap().to_owned();
        tag_card(&f);
        let payload = recycle(&f, "first-trash");
        assert_eq!(
            f.store.get_card(&id).unwrap()["tags"][0]["label"],
            "Retained"
        );
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        assert!(!f
            .store
            .list_entries(100, None)
            .unwrap()
            .items
            .iter()
            .any(|c| c["id"] == id));
        let replacement = Arc::new(
            Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
        );
        drop(std::mem::replace(&mut f.store, replacement));
        f.store = Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
        assert!(f
            .store
            .recover_inherited(f.store.inherited_recovery().unwrap())
            .is_empty());
        assert_eq!(
            f.store.get_card(&id).unwrap()["tags"][0]["label"],
            "Retained"
        );
        fs::rename(&payload, &f.source).unwrap();
        // Production publication must restore the legacy anchor too, before
        // assigning a new identity. No explicit restore helper in the test.
        if kind == "directory" {
            let receipt = f
                .store
                .start_scan(
                    None,
                    "restore-directory".into(),
                    f.store.list_sources().unwrap().sources_revision,
                    f.root.join("cache"),
                    f.root.join("data"),
                    Arc::new(|_, _| {}),
                )
                .unwrap();
            assert_eq!(f.wait(&receipt.operation_id).status, "success");
        } else {
            refresh(&f);
        }
        let restored = f.store.get_card(&id).unwrap();
        assert_eq!(restored["tags"][0]["label"], "Retained");
        assert_eq!(restored["favorite"], true);
        assert!(
            restored["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == exemplar && e["state"] == "available"),
            "{kind}: {restored}"
        );
        assert!(f
            .store
            .list_entries(100, None)
            .unwrap()
            .items
            .iter()
            .any(|c| c["id"] == id));
        let payload = recycle(&f, "second-trash");
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        empty(&payload);
        assert!(f.store.reconcile_trash_retention().unwrap().is_some());
        assert_eq!(f.store.get_card(&id).unwrap()["favorite"], true);
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
    }
}

#[test]
fn trash_retention_emptying_preserves_a_tag_owned_by_another_fiche() {
    let f = Fixture::new(false);
    tag_card(&f);
    f.store.write(|tx| tx.execute_batch("INSERT INTO fiche VALUES ('other',1,0,0); INSERT INTO tag_member SELECT id,'other' FROM tag;").map_err(error)).unwrap();
    let payload = recycle(&f, "shared-tag");
    empty(&payload);
    f.store.reconcile_trash_retention().unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 2);
    assert_eq!(
        f.store.get_card("other").unwrap()["tags"][0]["label"],
        "Retained"
    );
}

#[test]
fn trash_retention_unavailable_or_replaced_trash_parent_never_proves_emptying() {
    for replace in [false, true] {
        let f = Fixture::new(false);
        tag_card(&f);
        let payload = recycle(&f, "offline-trash");
        let parent = payload.parent().unwrap();
        let disconnected = f.root.join("disconnected");
        fs::rename(parent, &disconnected).unwrap();
        if replace {
            fs::create_dir(parent).unwrap();
        }
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        if replace {
            fs::remove_dir(parent).unwrap();
        }
        fs::rename(disconnected, parent).unwrap();
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        empty(&payload);
        assert!(f.store.reconcile_trash_retention().unwrap().is_some());
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    }
}

#[test]
fn trash_retention_emptying_never_erases_a_replacement_file() {
    let f = Fixture::new(false);
    tag_card(&f);
    let payload = recycle(&f, "replacement");
    empty(&payload);
    fs::write(&f.source, b"unrelated new file").unwrap();
    f.store.reconcile_trash_retention().unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    assert_eq!(fs::read(&f.source).unwrap(), b"unrelated new file");
}

#[test]
fn trash_retention_missing_receipt_after_interruption_keeps_personal_data() {
    let f = Fixture::new(false);
    tag_card(&f);
    let p = plan(&f);
    let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap()),"snapshot":patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap()});
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('crash',?1,'pending')",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let payload = f.root.join("not-yet-recorded-native-item");
    fs::rename(&f.source, &payload).unwrap();
    assert!(f
        .store
        .recover_removals_from(vec![("crash".into(), evidence.to_string())])
        .unwrap()
        .is_empty());
    assert!(f.store.reconcile_trash_retention().unwrap().is_none());
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    fs::rename(payload, &f.source).unwrap();
    refresh(&f);
    assert_eq!(
        f.store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .unwrap()["tags"][0]["label"],
        "Retained"
    );
}

#[test]
fn trash_retention_follows_the_exemplar_through_fiche_grouping() {
    let mut f = project_fixture();
    tag_card(&f);
    let old = f.card["ficheId"].as_str().unwrap().to_owned();
    let payload = recycle(&f, "grouped-project");
    let other = f
        .store
        .list_entries(100, None)
        .unwrap()
        .items
        .into_iter()
        .find(|c| c["id"] != old)
        .unwrap();
    let target = other["id"].as_str().unwrap().to_owned();
    f.store
        .write(|tx| {
            crate::services::catalogue::data::mutate::association::group_for_file(
                tx,
                &[old.clone(), target.clone()],
                &target,
                &[],
                true,
            )
        })
        .unwrap();
    f.card = f.store.get_card(&target).unwrap();
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["state"] == "available")
        .unwrap()
        .clone();
    f.source = f.root.join("packs/Original.zip");
    let second = recycle(&f, "grouped-zip");
    empty(&second);
    f.store.reconcile_trash_retention().unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    assert!(f.store.get_card(&target).is_ok());
    empty(&payload);
    f.store.reconcile_trash_retention().unwrap();
    assert!(f.store.get_card(&target).is_ok());
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
}

#[test]
fn trash_retention_watcher_publishes_unavailable_fiche_and_emits_the_new_revision() {
    let f = Fixture::new(false);
    tag_card(&f);
    let payload = recycle(&f, "background-emptying");
    let (send, receive) = std::sync::mpsc::channel();
    let service = crate::services::catalogue::watch::Service::start(
        Arc::clone(&f.store),
        Box::leak(Box::default()),
        f.root.join("cache"),
        f.root.join("data"),
        crate::services::catalogue::watch::Config {
            tick: Duration::from_millis(10),
            poll_interval: Duration::from_millis(50),
            stability: Duration::ZERO,
            force_polling: true,
            ..Default::default()
        },
        Arc::new(move |revision| {
            let _ = send.send(revision);
        }),
    )
    .unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    empty(&payload);
    let start = Instant::now();
    let mut notified = 0;
    loop {
        if let Ok(revision) = receive.recv_timeout(Duration::from_millis(100)) {
            notified = notified.max(revision);
        }
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        if f.store
            .list_entries(100, None)
            .unwrap()
            .items
            .iter()
            .any(|e| e["id"] == f.card["ficheId"] && e["offlineReason"] == "unavailable")
            && notified >= f.store.list_sources().unwrap().catalogue_revision
        {
            break;
        }
        assert!(
            start.elapsed() < crate::test_support::timeout(),
            "the offline fiche must be published without reopening the catalogue"
        );
    }
    service.stop();
}

#[test]
fn trash_retention_source_removal_keeps_the_other_sources_trashed_copy() {
    for restore in [false, true] {
        let f = Fixture::new(false);
        tag_card(&f);
        let fiche = f.card["ficheId"].as_str().unwrap();
        let other = f.root.join("other-source");
        fs::create_dir(&other).unwrap();
        let copy = other.join("Copy.zip");
        fs::copy(&f.source, &copy).unwrap();
        let added = f.store.add_source(&other, 1, false).unwrap();
        let exclusions = f
            .store
            .exclusions(&f.root.join("cache"), &f.root.join("data"))
            .unwrap();
        f.store
            .refresh_paths(
                &Root {
                    source_id: added.source_id.clone(),
                    path: other,
                },
                &[Change {
                    path: copy.clone(),
                    settled: true,
                    structural: true,
                }],
                &exclusions,
                Duration::ZERO,
                &AtomicBool::new(false),
                &writes::Registry::default(),
            )
            .unwrap();
        let payload = recycle(&f, "other-source-retention");
        // Source membership must survive a cache rebuild too.
        f.store
            .write_cache(|tx| {
                tx.execute("DELETE FROM coverage", [])
                    .map(|_| ())
                    .map_err(error)
            })
            .unwrap();
        let preview = f.store.preview_remove_source(&added.source_id).unwrap();
        assert_eq!(preview.count, 0);
        assert_eq!(preview.remaining, 1);
        f.store
            .remove_source_confirmed(
                &added.source_id,
                preview.sources_revision,
                preview.catalogue_revision,
            )
            .unwrap();
        assert!(copy.exists(), "removing a source never deletes its files");
        assert_eq!(
            f.store.get_card(fiche).unwrap()["tags"][0]["label"],
            "Retained"
        );
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
        assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        if restore {
            fs::rename(&payload, &f.source).unwrap();
            refresh(&f);
            let card = f.store.get_card(fiche).unwrap();
            assert_eq!(card["favorite"], true);
            assert_eq!(card["tags"][0]["label"], "Retained");
            assert!(card["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == f.exemplar["id"] && e["state"] == "available"));
            let second = recycle(&f, "restored-after-source-removal");
            empty(&second);
        } else {
            empty(&payload);
        }
        f.store.reconcile_trash_retention().unwrap();
        assert!(f.store.get_card(fiche).is_ok());
        assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    }
}

#[test]
fn trash_retention_restore_before_publication_respects_native_parent_case() {
    for full_scan in [false, true] {
        let mut f = Fixture::new(false);
        let parent = f.root.join("packs/MixedParent");
        fs::create_dir(&parent).unwrap();
        f.source = parent.join("Project.mbah");
        fs::write(
            &f.source,
            json!({"title":"Legacy without UUID","type":"pack","tree":[]}).to_string(),
        )
        .unwrap();
        refresh(&f);
        let entry = f
            .store
            .list_entries(100, None)
            .unwrap()
            .items
            .into_iter()
            .find(|c| {
                c["exemplars"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["format"] == "project")
            })
            .unwrap();
        let fiche = entry["id"].as_str().unwrap().to_owned();
        f.card = f.store.get_card(&fiche).unwrap();
        f.exemplar = f.card["exemplars"][0].clone();
        let exemplar = f.exemplar["id"].clone();
        tag_card(&f);
        let original = f.source.clone();
        let payload = recycle(&f, "case-restoration");
        // Two actual renames work even where a case-only rename is special.
        let temporary = f.root.join("packs/renaming-parent");
        let renamed = f.root.join("packs/mixedparent");
        fs::rename(&parent, &temporary).unwrap();
        fs::rename(&temporary, &renamed).unwrap();
        f.source = renamed.join("Project.mbah");
        fs::rename(&payload, &f.source).unwrap();
        // The filesystem supplies the oracle, not the path-key implementation.
        let alias = original.exists();
        if full_scan {
            let receipt = f
                .store
                .start_scan(
                    None,
                    "restore-parent-case".into(),
                    f.store.list_sources().unwrap().sources_revision,
                    f.root.join("cache"),
                    f.root.join("data"),
                    Arc::new(|_, _| {}),
                )
                .unwrap();
            assert_eq!(f.wait(&receipt.operation_id).status, "success");
        } else {
            refresh(&f);
        }
        let projects: Vec<_> = f
            .store
            .list_entries(100, None)
            .unwrap()
            .items
            .into_iter()
            .filter(|c| {
                c["exemplars"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["format"] == "project" && e["state"] == "available")
            })
            .collect();
        assert_eq!(
            projects.len(),
            1,
            "no duplicate active project after publication"
        );
        if alias {
            assert_eq!(projects[0]["id"], fiche);
            let restored = f.store.get_card(&fiche).unwrap();
            assert_eq!(restored["tags"][0]["label"], "Retained");
            assert_eq!(restored["favorite"], true);
            assert!(restored["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == exemplar && e["state"] == "available"));
            assert!(f.store.reconcile_trash_retention().unwrap().is_none());
            let retained = f
                .store
                .read(super::super::super::trash_retention::retained_exemplars)
                .unwrap();
            assert!(
                retained.is_empty(),
                "restoration must consume its trash retention"
            );
        } else {
            // Case-sensitive volumes must not attach a new path to the old
            // legacy fiche or release personal data without proof of emptying.
            assert_ne!(projects[0]["id"], fiche);
            assert!(projects[0]["tags"].as_array().unwrap().is_empty());
            assert_eq!(
                f.store.get_card(&fiche).unwrap()["tags"][0]["label"],
                "Retained"
            );
            assert!(f.store.reconcile_trash_retention().unwrap().is_none());
        }
    }
}

#[test]
fn trash_retention_last_missing_sibling_removal_keeps_the_trashed_fiche() {
    let f = Fixture::new(false);
    tag_card(&f);
    // Real missing sibling, with a durable reference and source coverage.
    let copy = f.root.join("packs/Copy.zip");
    fs::copy(&f.source, &copy).unwrap();
    let source = f.store.list_sources().unwrap().items[0].clone();
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: copy.clone(),
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
    let payload = recycle(&f, "missing-sibling");
    // An accessible empty source is conservatively treated as an unmounted
    // volume. Keep a sentinel so this fixture can prove a missing sibling.
    fs::write(f.root.join("packs/.keep"), b"mounted").unwrap();
    fs::remove_file(&copy).unwrap();
    let source = f.store.list_sources().unwrap().items[0].clone();
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: copy,
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
    let card = f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .unwrap();
    let missing = card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["state"] == "missing" && e["retired"] != true)
        .unwrap();
    f.store
        .remove_missing_exemplar(
            missing["id"].as_str().unwrap(),
            card["catalogueRevision"].as_i64().unwrap(),
        )
        .unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    empty(&payload);
    f.store.reconcile_trash_retention().unwrap();
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
}
