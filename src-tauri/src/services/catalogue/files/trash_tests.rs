use super::super::trash_native::{injections, Outcome};
use super::*;

#[path = "trash_retention_tests.rs"]
mod retention;
// These recovery fixtures physically destroy their temporary payload. The
// receipt models a missing bin item, which never proves permanent deletion.
fn emptied_receipt(f: &Fixture) -> Value {
    serde_json::to_value(
        super::super::trash_retention::Receipt::capture(f.root.join("already-emptied-native-item"))
            .unwrap(),
    )
    .unwrap()
}
fn options() -> Options {
    serde_json::from_value(json!({"mode":"replace"})).unwrap()
}
fn request(f: &Fixture) -> Vec<TargetRequest> {
    vec![TargetRequest {
        fiche_id: f.card["ficheId"].as_str().unwrap().into(),
        exemplar_id: f.exemplar["id"].as_str().unwrap().into(),
        expected_revision: f.store.list_sources().unwrap().catalogue_revision,
    }]
}
fn plan(f: &Fixture) -> FilePlan {
    f.store
        .plan_file_operation("trash".into(), request(f), options())
        .unwrap()
}
fn launch(f: &Fixture, p: &FilePlan, tokens: Vec<String>, key: &str) -> Result<Value> {
    f.store.start_file_operation(
        p.plan_id.clone(),
        Decisions {
            summary_validated: true,
            skip_exemplar_ids: vec![],
            removal_confirmations: tokens,
        },
        key.into(),
        Arc::new(|_, _| {}),
        f.root.join("cache"),
        f.root.join("data"),
    )
}
fn confirm(f: &Fixture, p: &FilePlan, stage: &str, previous: Option<String>) -> String {
    f.store
        .confirm_file_removal(&p.plan_id, stage, previous)
        .unwrap()
        .token
}
// Keep a second non-retired (offline) exemplar for tests protecting retained
// cards and durable removal evidence. Last-copy erasure is tested separately.
fn retain_other_copy(f: &Fixture) {
    f.store.write(|tx| {
        tx.execute("INSERT OR IGNORE INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,retired) SELECT 'retained-copy',fiche_id,'{}',proof_json,content_revision,0 FROM exemplar WHERE id=?1", [f.exemplar["id"].as_str().unwrap()]).map_err(error)?;
        Ok(())
    }).unwrap();
}
fn unavailable(f: &Fixture) -> FilePlan {
    retain_other_copy(f);
    let p = plan(f);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::UnavailableForTarget);
    let token = confirm(f, &p, "trash", None);
    let receipt = launch(f, &p, vec![token], "trash-unavailable").unwrap();
    let progress = f.wait(receipt["operationId"].as_str().unwrap());
    assert_eq!(
        progress.error.unwrap().code,
        codes::CATALOG_TRASH_UNAVAILABLE
    );
    f.store.prepare_permanent_delete(&p.plan_id).unwrap()
}

fn reindex_after_removal(recovery: bool, different_pack: bool) {
    for directory in [false, true] {
        let mut f = Fixture::new(directory);
        retain_other_copy(&f);
        let original_card = f.card["ficheId"].as_str().unwrap().to_owned();
        let original_exemplar = f.exemplar["id"].as_str().unwrap().to_owned();
        f.store
            .write(|tx| {
                tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [&original_card])
                    .map_err(error)?;
                Ok(())
            })
            .unwrap();
        let saved = f.root.join("saved-pack");
        patch::copy_tree(&f.source, &saved, &AtomicBool::new(false)).unwrap();
        let p = plan(&f);
        if recovery {
            let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap())});
            f.store
                .write(|tx| {
                    tx.execute(
                        "INSERT INTO file_removal VALUES ('interrupted',?1,'pending')",
                        [evidence.to_string()],
                    )
                    .map_err(error)?;
                    Ok(())
                })
                .unwrap();
            if directory {
                fs::remove_dir_all(&f.source).unwrap();
            } else {
                fs::remove_file(&f.source).unwrap();
            }
            let placeholder = Arc::new(
                Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
            );
            drop(std::mem::replace(&mut f.store, placeholder));
            f.store = Arc::new(Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap());
            assert!(f
                .store
                .recover_removals_from(vec![("interrupted".into(), evidence.to_string())])
                .unwrap()
                .is_empty());
            // Replaying recovery is harmless after retirement.
            assert!(f
                .store
                .recover_removals_from(vec![("interrupted".into(), evidence.to_string())])
                .unwrap()
                .is_empty());
        } else {
            injections()
                .lock()
                .unwrap()
                .insert(f.source.clone(), Outcome::Removed);
            let token = confirm(&f, &p, "trash", None);
            let receipt = launch(&f, &p, vec![token], "remove-before-rescan").unwrap();
            assert_eq!(
                f.wait(receipt["operationId"].as_str().unwrap()).status,
                "success"
            );
        }
        assert_eq!(f.store.list_unreferenced(100, None).unwrap().items.len(), 1);
        patch::copy_tree(&saved, &f.source, &AtomicBool::new(false)).unwrap();
        if different_pack {
            let mut story = patch::read_story(&f.source).unwrap();
            story["title"] = json!("Another pack");
            story["stageNodes"][0]["uuid"] = json!("bda17862-0d71-41f6-974a-222222222222");
            super::review::write_story(&f, &serde_json::to_string(&story).unwrap());
        }
        let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        let source = f.store.list_sources().unwrap().items[0].clone();
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
        patch::unchanged(&f.source, &before, &AtomicBool::new(false)).unwrap();
        let (key, state): (String, String) = f.store.read(|c| {
            c.query_row("SELECT CAST(locator_key AS TEXT),state FROM cache.observation WHERE exemplar_id=?1", [&original_exemplar], |r| Ok((r.get(0)?, r.get(1)?)))
        }).unwrap();
        assert_eq!(key, format!("retired:{original_exemplar}"));
        assert_eq!(state, "unavailable");
        assert_eq!(f.store.get_card(&original_card).unwrap()["favorite"], true);
        let page = serde_json::to_value(f.store.list_entries(100, None).unwrap()).unwrap();
        let active = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| {
                card["exemplars"].as_array().unwrap().iter().any(|e| {
                    e["state"] == "available"
                        && e["locator"]["path"]
                            == crate::support::paths::path_for_frontend(&f.source)
                })
            })
            .expect("the restored path must be indexed");
        assert!(active["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["state"] == "available" && e["id"] != original_exemplar));
        if different_pack {
            assert_ne!(active["id"], original_card);
            assert_eq!(f.store.list_unreferenced(100, None).unwrap().items.len(), 1);
        } else {
            assert_eq!(active["id"], original_card);
        }
    }
}

#[test]
fn trash_restored_pack_can_be_reindexed_at_the_same_path() {
    reindex_after_removal(false, false);
}
#[test]
fn trash_new_pack_can_be_reindexed_at_the_same_path() {
    reindex_after_removal(false, true);
}
#[test]
fn trash_recovery_restored_pack_can_be_reindexed_at_the_same_path() {
    reindex_after_removal(true, false);
}
#[test]
fn trash_recovery_new_pack_can_be_reindexed_at_the_same_path() {
    reindex_after_removal(true, true);
}
#[test]
fn trash_native_success_preserves_last_card_and_personal_data() {
    for dir in [false, true] {
        let f = Fixture::new(dir);
        f.store
            .write(|tx| {
                tx.execute(
                    "UPDATE fiche SET favorite=1 WHERE id=?1",
                    [f.card["ficheId"].as_str().unwrap()],
                )
                .map_err(error)?;
                let card = f.card["ficheId"].as_str().unwrap();
                tx.execute("INSERT INTO provenance(id,kind) VALUES ('corb-manual','manual')", []).map_err(error)?;
                tx.execute("INSERT INTO correction VALUES (?1,'ageMin','','defined','3','corb-manual',NULL,1)", [card]).map_err(error)?;
                tx.execute("INSERT INTO tag VALUES ('corb-tag','Personnel','personnel',1)", []).map_err(error)?;
                tx.execute("INSERT INTO tag_member VALUES ('corb-tag',?1)", [card]).map_err(error)?;
                Ok(())
            })
            .unwrap();
        let p = plan(&f);
        assert_eq!(p.targets.len(), 1);
        assert_eq!(
            p.targets[0].source_path,
            crate::support::paths::path_for_frontend(&f.source)
        );
        injections()
            .lock()
            .unwrap()
            .insert(f.source.clone(), Outcome::Removed);
        let token = confirm(&f, &p, "trash", None);
        let receipt = launch(&f, &p, vec![token.clone()], "trash-success").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap()).status,
            "success"
        );
        assert!(!f.source.exists());
        assert!(f
            .store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .is_ok());
        assert_eq!(f.store.list_unreferenced(200, None).unwrap().items.len(), 1);
        let counts: (i64, i64) = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT (SELECT count(*) FROM fiche),(SELECT count(*) FROM exemplar)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(counts, (1, 1));
        let personal: (i64, i64, i64) = f.store.read(|c| c.query_row("SELECT (SELECT count(*) FROM correction),(SELECT count(*) FROM tag_member),(SELECT count(*) FROM provenance WHERE id='corb-manual')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
        assert_eq!(personal, (1, 1, 1));
        // The operation remains idempotent while personal data is retained.
        assert_eq!(
            launch(&f, &p, vec![token], "trash-success").unwrap(),
            receipt
        );
    }
}
#[test]
fn trash_unavailability_requires_two_ordered_plan_bound_confirmations() {
    for dir in [false, true] {
        let f = Fixture::new(dir);
        let p = unavailable(&f);
        let original = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        assert_eq!(p.action, "deletePermanently");
        assert_eq!(
            launch(&f, &p, vec![], "missing").unwrap_err().code,
            codes::CATALOG_DELETE_CONFIRMATION_REQUIRED
        );
        assert!(f
            .store
            .confirm_file_removal(&p.plan_id, "irreversible", None)
            .is_err());
        let first = confirm(&f, &p, "targets", None);
        assert_eq!(
            launch(&f, &p, vec![first.clone()], "only-first")
                .unwrap_err()
                .code,
            codes::CATALOG_DELETE_CONFIRMATION_REQUIRED
        );
        assert!(f
            .store
            .confirm_file_removal(&p.plan_id, "irreversible", Some("foreign-token".into()))
            .is_err());
        let second = confirm(&f, &p, "irreversible", Some(first.clone()));
        assert_ne!(first, second);
        assert!(launch(&f, &p, vec![second.clone(), first.clone()], "wrong-order").is_err());
        patch::unchanged(&f.source, &original, &AtomicBool::new(false)).unwrap();
        let receipt = launch(&f, &p, vec![first, second], "permanent").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap()).status,
            "success"
        );
        assert!(!f.source.exists());
    }
}
#[test]
fn trash_failed_and_uncertain_never_authorize_permanent_deletion() {
    for outcome in [Outcome::Failed, Outcome::Uncertain] {
        let f = Fixture::new(false);
        let p = plan(&f);
        let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        injections()
            .lock()
            .unwrap()
            .insert(f.source.clone(), outcome);
        let token = confirm(&f, &p, "trash", None);
        let receipt = launch(&f, &p, vec![token], "failure").unwrap();
        let progress = f.wait(receipt["operationId"].as_str().unwrap());
        assert_eq!(
            progress.error.unwrap().code,
            if outcome == Outcome::Failed {
                codes::CATALOG_TRASH_FAILED
            } else {
                codes::CATALOG_TRASH_UNCERTAIN
            }
        );
        assert!(f.store.prepare_permanent_delete(&p.plan_id).is_err());
        patch::unchanged(&f.source, &before, &AtomicBool::new(false)).unwrap();
    }
}
#[test]
fn trash_no_native_unavailability_or_confirmation_cannot_be_bypassed() {
    let f = Fixture::new(false);
    let p = plan(&f);
    assert!(f.store.prepare_permanent_delete(&p.plan_id).is_err());
    assert_eq!(
        f.store
            .plan_file_operation("deletePermanently".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_DELETE_CONFIRMATION_REQUIRED
    );
    assert!(launch(&f, &p, vec![], "summary-only").is_err());
    let mut multiple = request(&f);
    multiple.extend(request(&f));
    assert!(f
        .store
        .plan_file_operation("trash".into(), multiple, options())
        .is_err());
    assert!(f.source.exists());
}
#[test]
fn trash_replaced_identity_between_confirmations_is_refused() {
    let f = Fixture::new(false);
    let p = unavailable(&f);
    let first = confirm(&f, &p, "targets", None);
    let replacement = f.source.with_extension("replacement");
    fs::copy(&f.source, &replacement).unwrap();
    fs::rename(replacement, &f.source).unwrap();
    assert_eq!(
        f.store
            .confirm_file_removal(&p.plan_id, "irreversible", Some(first))
            .unwrap_err()
            .code,
        codes::CATALOG_FILE_SOURCE_CHANGED
    );
    assert!(f.source.exists());
}
#[test]
fn trash_content_changed_after_final_confirmation_is_refused_at_launch() {
    let f = Fixture::new(true);
    let p = unavailable(&f);
    let first = confirm(&f, &p, "targets", None);
    let second = confirm(&f, &p, "irreversible", Some(first.clone()));
    fs::write(f.source.join("assets/audio"), b"changed-audio").unwrap();
    assert_eq!(
        launch(&f, &p, vec![first, second], "changed")
            .unwrap_err()
            .code,
        codes::CATALOG_FILE_SOURCE_CHANGED
    );
    assert!(f.source.exists());
}
#[test]
fn trash_forbids_protected_contents_at_plan_and_launch() {
    for name in ["project.mbah", "project.MBAH"] {
        let f = Fixture::new(true);
        let p = plan(&f);
        let token = confirm(&f, &p, "trash", None);
        fs::write(f.source.join(name), b"protected-project").unwrap();
        assert_eq!(
            f.store
                .plan_file_operation("trash".into(), request(&f), options())
                .unwrap_err()
                .code,
            codes::CATALOG_DELETE_TARGET_FORBIDDEN
        );
        assert_eq!(
            launch(&f, &p, vec![token], "protected").unwrap_err().code,
            codes::CATALOG_DELETE_TARGET_FORBIDDEN
        );
        assert_eq!(fs::read(f.source.join(name)).unwrap(), b"protected-project");
    }
}
#[cfg(unix)]
#[test]
fn trash_outgoing_symlink_is_rejected_without_touching_external_target() {
    let f = Fixture::new(true);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    let external = f.root.join("external.mbah");
    fs::write(&external, b"protected").unwrap();
    std::os::unix::fs::symlink(&external, f.source.join("link")).unwrap();
    assert_eq!(
        f.store
            .plan_file_operation("trash".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert_eq!(
        launch(&f, &p, vec![token], "linked").unwrap_err().code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert_eq!(fs::read(external).unwrap(), b"protected");
}
#[test]
fn trash_forbids_source_roots_and_archive_children_even_for_direct_launch() {
    for child in [false, true] {
        let f = Fixture::new(true);
        let p = plan(&f);
        let token = confirm(&f, &p, "trash", None);
        if child {
            f.store
                .file_plans
                .lock()
                .unwrap()
                .get_mut(&p.plan_id)
                .unwrap()
                .dto
                .targets[0]
                .member_chain = vec![json!({"path":"child.zip"})];
        } else {
            f.store
                .add_source(
                    &f.source,
                    f.store.list_sources().unwrap().sources_revision,
                    false,
                )
                .unwrap();
            // Reach target validation rather than stopping at the revision guard.
            let revision = f.store.list_sources().unwrap().catalogue_revision;
            let mut plans = f.store.file_plans.lock().unwrap();
            let stored = plans.get_mut(&p.plan_id).unwrap();
            stored.dto.catalogue_revision = revision;
            stored.dto.targets[0].expected_revision = revision;
        }
        assert_eq!(
            launch(&f, &p, vec![token], "forbidden").unwrap_err().code,
            codes::CATALOG_DELETE_TARGET_FORBIDDEN
        );
        if child {
            f.store.write(|tx|{tx.execute("UPDATE cache.observation SET raw_observation_json=json_set(raw_observation_json,'$.chain',json('[{\"path\":\"child.zip\"}]'))",[]).map_err(error)?;Ok(())}).unwrap();
        }
        assert_eq!(
            f.store
                .plan_file_operation("trash".into(), request(&f), options())
                .unwrap_err()
                .code,
            codes::CATALOG_DELETE_TARGET_FORBIDDEN
        );
        assert!(f.source.exists());
    }
}
#[test]
fn trash_cancellation_before_mutation_keeps_every_byte() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let stored = f
        .store
        .file_plans
        .lock()
        .unwrap()
        .get(&p.plan_id)
        .unwrap()
        .clone();
    let before = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let mut revision = p.catalogue_revision;
    assert_eq!(
        f.store
            .apply_removal(
                &stored,
                "cancelled",
                &AtomicBool::new(true),
                &mut revision,
                &f.root.join("cache"),
                &f.root.join("data"),
                |_| {}
            )
            .unwrap_err()
            .code,
        codes::GENERATION_CANCELLED
    );
    patch::unchanged(&f.source, &before, &AtomicBool::new(false)).unwrap();
}
#[test]
fn trash_recovery_reconciles_disappearance_without_destructive_replay() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap()),"trashReceipt":emptied_receipt(&f)});
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('interrupted',?1,'pending')",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    assert_eq!(
        f.store
            .recover_removals_from(vec![("interrupted".into(), evidence.to_string())])
            .unwrap()
            .len(),
        0
    );
    assert!(f.source.exists());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
    fs::remove_file(&f.source).unwrap();
    assert!(f
        .store
        .recover_removals_from(vec![("interrupted".into(), evidence.to_string())])
        .unwrap()
        .is_empty());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
    assert_eq!(f.store.list_unreferenced(100, None).unwrap().items.len(), 1);
}
#[test]
fn trash_confirmation_manual_contract() {
    let dto = super::super::trash::RemovalConfirmation {
        plan_id: "removal-plan".into(),
        target_token: "sha256-and-identity".into(),
        stage: "targets".into(),
        token: "first-receipt".into(),
    };
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/catalogue/removal-confirmation.json"
    ))
    .unwrap();
    assert_eq!(serde_json::to_value(dto).unwrap(), fixture);
}

#[test]
fn trash_project_extension_is_forbidden_at_plan_and_direct_launch() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    let protected = f.source.with_extension("mbah");
    fs::rename(&f.source, &protected).unwrap();
    let path = crate::support::paths::path_for_frontend(&protected);
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET anchor_json=json_set(anchor_json,'$.path',?1,'$.pathKey',?1)",
                [path],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store
            .plan_file_operation("trash".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert_eq!(
        launch(&f, &p, vec![token], "project").unwrap_err().code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert!(protected.exists());
}
#[test]
fn trash_worker_revalidates_identity_and_exclusions_after_launch() {
    for protected in [false, true] {
        let f = Fixture::new(true);
        let p = plan(&f);
        let stored = f
            .store
            .file_plans
            .lock()
            .unwrap()
            .get(&p.plan_id)
            .unwrap()
            .clone();
        if protected {
            fs::write(f.source.join("added.mbah"), b"protected").unwrap();
        } else {
            fs::write(f.source.join("assets/audio"), b"external").unwrap();
        }
        let mut revision = p.catalogue_revision;
        assert!(f
            .store
            .apply_removal(
                &stored,
                "late-change",
                &AtomicBool::new(false),
                &mut revision,
                &f.root.join("cache"),
                &f.root.join("data"),
                |_| {}
            )
            .is_err());
        assert!(f.source.exists());
    }
}
#[cfg(target_os = "linux")]
#[test]
#[ignore = "Uses an isolated XDG trash and the real desktop trash implementation"]
fn native_trash_linux_returns_a_real_recoverable_item() {
    let xdg =
        PathBuf::from(std::env::var_os("XDG_DATA_HOME").expect("isolated XDG_DATA_HOME required"));
    assert!(xdg
        .to_string_lossy()
        .starts_with("/tmp/story-studio-native-trash-"));
    let root = xdg.join("input");
    fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("pack-{}.zip", uuid::Uuid::new_v4()));
    fs::write(&path, b"synthetic-native-trash-test").unwrap();
    let item = junkyard::discard(&path).unwrap();
    assert!(!path.exists());
    assert!(Path::new(item.id()).is_file());
    let info = PathBuf::from(item.id());
    let payload = info
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("files")
        .join(info.file_stem().unwrap());
    assert_eq!(fs::read(&payload).unwrap(), b"synthetic-native-trash-test");
    fs::remove_file(payload).unwrap();
    fs::remove_file(info).unwrap();
}

#[test]
fn trash_fs_directory_is_removed_as_a_complete_pack() {
    let mut f = Fixture::new(true);
    fs::remove_dir_all(&f.source).unwrap();
    crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&f.source);
    let source = f.store.list_sources().unwrap().items[0].clone();
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
    let page = serde_json::to_value(f.store.list_entries(100, None).unwrap()).unwrap();
    let native_card = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|card| {
            card["exemplars"].as_array().unwrap().iter().any(|e| {
                e["format"] == "fsDirectory"
                    && e["locator"]["path"] == crate::support::paths::path_for_frontend(&f.source)
            })
        })
        .expect("the native pack must be indexed independently of the replaced pack's card");
    f.card = f
        .store
        .get_card(native_card["id"].as_str().unwrap())
        .unwrap();
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["format"] == "fsDirectory")
        .unwrap()
        .clone();
    let p = plan(&f);
    assert_eq!(p.targets[0].source_format, "fsDirectory");
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let token = confirm(&f, &p, "trash", None);
    let receipt = launch(&f, &p, vec![token], "fs").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
}

#[cfg(windows)]
#[test]
fn trash_windows_outgoing_junction_is_refused_at_plan_and_launch() {
    let f = Fixture::new(true);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    let external = f.root.join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("protected.mbah"), b"external-project").unwrap();
    let link = f.source.join("junction");
    // Junction creation needs no symlink privilege on NTFS. All paths are
    // synthetic fixture paths passed as separate arguments.
    let status = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&external)
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(
        f.store
            .plan_file_operation("trash".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert_eq!(
        launch(&f, &p, vec![token], "junction").unwrap_err().code,
        codes::CATALOG_DELETE_TARGET_FORBIDDEN
    );
    assert_eq!(
        fs::read(external.join("protected.mbah")).unwrap(),
        b"external-project"
    );
    fs::remove_dir(link).unwrap();
}

#[test]
fn trash_recreated_target_is_uncertain_and_keeps_a_durable_guard() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let stored = f
        .store
        .file_plans
        .lock()
        .unwrap()
        .get(&p.plan_id)
        .unwrap()
        .clone();
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    super::super::trash::AFTER_NATIVE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|path| {
            fs::write(path, b"external-recreation").unwrap();
        }))
    });
    let mut revision = p.catalogue_revision;
    let result = f.store.apply_removal(
        &stored,
        "recreated",
        &AtomicBool::new(false),
        &mut revision,
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    super::super::trash::AFTER_NATIVE_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(result.unwrap_err().code, codes::CATALOG_TRASH_UNCERTAIN);
    assert_eq!(fs::read(&f.source).unwrap(), b"external-recreation");
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    assert!(f.store.prepare_permanent_delete(&p.plan_id).is_err());
}

#[test]
fn trash_recovery_recreated_during_reconciliation_retains_present_exemplar_and_guard() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let original = fs::read(&f.source).unwrap();
    let expected_bytes = original.clone();
    let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap())});
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('recover-recreated',?1,'pending')",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    fs::remove_file(&f.source).unwrap();
    // Recovery has already observed absence when this hook runs. Reindex the
    // same UUID at its original path during the subsequent reconciliation.
    super::super::trash::RECOVERY_RECONCILE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |path| fs::write(path, &original).unwrap()))
    });
    let warnings = f
        .store
        .recover_removals_from(vec![("recover-recreated".into(), evidence.to_string())])
        .unwrap();
    super::super::trash::RECOVERY_RECONCILE_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(
        warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(),
        vec![codes::CATALOG_TRASH_UNCERTAIN]
    );
    let retired: bool = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT retired FROM exemplar WHERE id=?1",
                [f.exemplar["id"].as_str().unwrap()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!retired, "reindexed same-UUID exemplar must remain present");
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    assert_eq!(fs::read(&f.source).unwrap(), expected_bytes);
    assert!(f
        .store
        .list_unreferenced(100, None)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn trash_recovery_parent_replaced_after_reconciliation_keeps_uncertain_guard() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap())});
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('parent-replaced',?1,'pending')",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    fs::remove_file(&f.source).unwrap();
    super::super::trash::RECOVERY_AFTER_RECONCILE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|path| {
            let parent = path.parent().unwrap();
            fs::rename(parent, parent.with_file_name("previous-parent")).unwrap();
            fs::create_dir(parent).unwrap();
        }))
    });
    let warnings = f
        .store
        .recover_removals_from(vec![("parent-replaced".into(), evidence.to_string())])
        .unwrap();
    super::super::trash::RECOVERY_AFTER_RECONCILE_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].code, codes::CATALOG_TRASH_UNCERTAIN);
    let retired: bool = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT retired FROM exemplar WHERE id=?1",
                [f.exemplar["id"].as_str().unwrap()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!retired);
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    let state: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT state FROM file_removal WHERE id='parent-replaced'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(state, "uncertain");
}
#[test]
fn trash_cocoa_native_qualification_opens_only_the_two_confirmation_fallback() {
    use super::super::trash_native::{
        mac_probes,
        macos::{Domain, NativeError, Probe},
    };
    for (domain, code, expected) in [
        (Domain::Cocoa, 3328, codes::CATALOG_TRASH_UNAVAILABLE),
        (Domain::Cocoa, 513, codes::CATALOG_TRASH_FAILED),
        (Domain::Other, 3328, codes::CATALOG_TRASH_UNCERTAIN),
    ] {
        let f = Fixture::new(false);
        let p = plan(&f);
        let before = fs::read(&f.source).unwrap();
        mac_probes().lock().unwrap().insert(
            f.source.clone(),
            Probe {
                succeeded: false,
                error: Some(NativeError { domain, code }),
            },
        );
        let token = confirm(&f, &p, "trash", None);
        let receipt = launch(&f, &p, vec![token], "native-cocoa").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap())
                .error
                .unwrap()
                .code,
            expected
        );
        assert_eq!(fs::read(&f.source).unwrap(), before);
        let permanent = f.store.prepare_permanent_delete(&p.plan_id);
        if expected == codes::CATALOG_TRASH_UNAVAILABLE {
            let permanent = permanent.unwrap();
            assert!(launch(&f, &permanent, vec![], "no-confirmation").is_err());
            let first = confirm(&f, &permanent, "targets", None);
            assert!(launch(&f, &permanent, vec![first.clone()], "one-confirmation").is_err());
            let second = confirm(&f, &permanent, "irreversible", Some(first.clone()));
            let receipt = launch(&f, &permanent, vec![first, second], "confirmed-cocoa").unwrap();
            assert_eq!(
                f.wait(receipt["operationId"].as_str().unwrap()).status,
                "success"
            );
        } else {
            assert!(permanent.is_err());
            assert!(f.source.exists());
        }
    }
}

#[test]
fn trash_windows_disabled_bin_and_oversized_target_require_both_confirmations() {
    use super::super::trash_native::windows_probes;
    for (flags, code, expected) in [
        (0, 0x80270036u32 as i32, codes::CATALOG_TRASH_UNAVAILABLE),
        (0, 0x80270037u32 as i32, codes::CATALOG_TRASH_UNAVAILABLE),
        (0x80, 0x80070005u32 as i32, codes::CATALOG_TRASH_FAILED),
        (0x80, 0x80004004u32 as i32, codes::CATALOG_TRASH_UNCERTAIN),
    ] {
        let f = Fixture::new(false);
        let p = plan(&f);
        let before = fs::read(&f.source).unwrap();
        windows_probes()
            .lock()
            .unwrap()
            .insert(f.source.clone(), (flags, code));
        let token = confirm(&f, &p, "trash", None);
        let receipt = launch(&f, &p, vec![token], "native-windows").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap())
                .error
                .unwrap()
                .code,
            expected
        );
        assert_eq!(fs::read(&f.source).unwrap(), before);
        let permanent = f.store.prepare_permanent_delete(&p.plan_id);
        if expected == codes::CATALOG_TRASH_UNAVAILABLE {
            let permanent = permanent.unwrap();
            assert!(launch(&f, &permanent, vec![], "no-confirmation").is_err());
            let first = confirm(&f, &permanent, "targets", None);
            assert!(launch(&f, &permanent, vec![first.clone()], "one-confirmation").is_err());
            let second = confirm(&f, &permanent, "irreversible", Some(first.clone()));
            let receipt = launch(&f, &permanent, vec![first, second], "confirmed-windows").unwrap();
            assert_eq!(
                f.wait(receipt["operationId"].as_str().unwrap()).status,
                "success"
            );
        } else {
            assert!(permanent.is_err());
            assert!(f.source.exists());
        }
    }
}

#[test]
fn permanent_folder_deletion_recovers_detached_partial_tree_without_touching_recreated_source() {
    let f = Fixture::new(true);
    let p = unavailable(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    let source = f.source.clone();
    let detached = Arc::new(std::sync::Mutex::new(None));
    let recorded = Arc::clone(&detached);
    super::super::trash::AFTER_DETACH_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |tombstone| {
            *recorded.lock().unwrap() = Some(tombstone.to_path_buf());
            // Simulate interruption during remove_dir_all, after one entry.
            fs::remove_file(tombstone.join("extra.txt")).unwrap();
            fs::create_dir(&source).unwrap();
            fs::write(source.join("foreign"), b"keep recreated source").unwrap();
            panic!("simulated process termination during deletion");
        }))
    });
    let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut revision = p.catalogue_revision;
        f.store.apply_removal(
            &stored,
            "partial-delete",
            &AtomicBool::new(false),
            &mut revision,
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        )
    }));
    super::super::trash::AFTER_DETACH_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert!(stopped.is_err());
    let tombstone = detached.lock().unwrap().clone().unwrap();
    assert!(tombstone.exists());
    let inherited = f.store.inherited_recovery().unwrap();
    assert!(f
        .store
        .recover_removals_from(inherited.removals)
        .unwrap()
        .is_empty());
    assert!(!tombstone.exists());
    assert_eq!(
        fs::read(f.source.join("foreign")).unwrap(),
        b"keep recreated source"
    );
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
}

#[test]
fn unreadable_removal_evidence_does_not_stop_the_next_row() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap())});
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('valid',?1,'uncertain')",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert!(f
        .store
        .recover_removals_from(vec![
            ("broken".into(), "{".into()),
            ("valid".into(), evidence.to_string())
        ])
        .unwrap()
        .is_empty());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
}

#[test]
fn failed_permanent_detach_keeps_the_complete_original_and_uses_delete_message() {
    let f = Fixture::new(true);
    let p = unavailable(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    let original = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
    let tombstone = patch::neighbor(&f.source, "occupied-delete", "deleted");
    fs::write(&tombstone, b"foreign").unwrap();
    let mut revision = p.catalogue_revision;
    let error = f
        .store
        .apply_removal(
            &stored,
            "occupied-delete",
            &AtomicBool::new(false),
            &mut revision,
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        )
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_DELETE_FAILED);
    assert!(recovery::matches(&f.source, &original));
    assert_eq!(fs::read(tombstone).unwrap(), b"foreign");
}

#[test]
fn permanent_detach_refusal_releases_guard_and_allows_retry() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let p = unavailable(&f);
        let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
        let original = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        let mut revision = p.catalogue_revision;
        trash::FAIL_DETACH.with(|v| v.set(true));
        let failed = f.store.apply_removal(
            &stored,
            "denied",
            &AtomicBool::new(false),
            &mut revision,
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        );
        trash::FAIL_DETACH.with(|v| v.set(false));
        assert_eq!(failed.unwrap_err().code, codes::CATALOG_DELETE_FAILED);
        assert!(recovery::matches(&f.source, &original));
        assert!(!f.store.file_recovery_pending(&f.source).unwrap());
        let state: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT state FROM file_removal WHERE id='denied'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(state, "complete");
        f.store
            .apply_removal(
                &stored,
                "retry",
                &AtomicBool::new(false),
                &mut revision,
                &f.root.join("cache"),
                &f.root.join("data"),
                |_| {},
            )
            .unwrap();
        assert!(!f.source.exists());
    }
}

#[test]
fn permanent_detach_proof_failure_is_uncertain_and_recoverable() {
    let f = Fixture::new(true);
    let p = unavailable(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    trash::FAIL_DETACH_PROOF.with(|v| v.set(true));
    let failed = f.store.apply_removal(
        &stored,
        "proof-failed",
        &AtomicBool::new(false),
        &mut p.catalogue_revision.clone(),
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
    assert_eq!(failed.unwrap_err().code, codes::CATALOG_DELETE_FAILED);
    let state: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT state FROM file_removal WHERE id='proof-failed'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(state, "uncertain");
    assert!(f
        .store
        .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
        .unwrap()
        .is_empty());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
}

#[test]
fn permanent_detach_error_after_the_move_is_uncertain_not_refused() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let p = unavailable(&f);
        let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
        trash::FAIL_AFTER_DETACH.with(|v| v.set(true));
        let failed = f.store.apply_removal(
            &stored,
            "moved-then-failed",
            &AtomicBool::new(false),
            &mut p.catalogue_revision.clone(),
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        );
        trash::FAIL_AFTER_DETACH.with(|v| v.set(false));
        assert_eq!(failed.unwrap_err().code, codes::CATALOG_DELETE_FAILED);
        assert!(!f.source.exists());
        let tombstone = patch::neighbor(&f.source, "moved-then-failed", "deleted");
        assert!(
            tombstone.exists(),
            "the pack was detached despite the error"
        );
        let state: String = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT state FROM file_removal WHERE id='moved-then-failed'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(state, "uncertain");
        assert!(f.store.file_recovery_pending(&f.source).unwrap());
        assert!(f
            .store
            .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
            .unwrap()
            .is_empty());
        assert!(!tombstone.exists(), "recovery erases the proven tombstone");
        assert!(!f.store.file_recovery_pending(&f.source).unwrap());
    }
}

// Same as `unavailable`, but in this thread: identity injection is per thread.
fn unavailable_in_this_thread(f: &Fixture) -> FilePlan {
    retain_other_copy(f);
    let p = plan(f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::UnavailableForTarget);
    let error = f
        .store
        .apply_removal(
            &stored,
            "trash-unavailable",
            &AtomicBool::new(false),
            &mut p.catalogue_revision.clone(),
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        )
        .unwrap_err();
    assert_eq!(error.code, codes::CATALOG_TRASH_UNAVAILABLE);
    f.store.prepare_permanent_delete(&p.plan_id).unwrap()
}
fn removal_row(f: &Fixture, id: &str) -> (String, Value) {
    let (state, evidence): (String, String) = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT state,evidence_json FROM file_removal WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    (state, serde_json::from_str(&evidence).unwrap())
}
// Detach to the tombstone on a directory-entry identity volume, then stop
// (panic) or fail before the new identities are recorded.
fn detach_with_moving_identity(f: &Fixture, stop: bool) -> PathBuf {
    let p = unavailable_in_this_thread(f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    assert_eq!(stored.identities_survive_moves, vec![false]);
    if stop {
        trash::DETACHED_HOOK
            .with(|slot| *slot.borrow_mut() = Some(Box::new(|_| panic!("stop after the detach"))));
    } else {
        trash::FAIL_DETACH_PROOF.with(|v| v.set(true));
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.store.apply_removal(
            &stored,
            "moved-delete",
            &AtomicBool::new(false),
            &mut p.catalogue_revision.clone(),
            &f.root.join("cache"),
            &f.root.join("data"),
            |_| {},
        )
    }));
    trash::DETACHED_HOOK.with(|slot| *slot.borrow_mut() = None);
    trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
    if stop {
        assert!(result.is_err());
    } else {
        assert_eq!(
            result.unwrap().unwrap_err().code,
            codes::CATALOG_DELETE_FAILED
        );
    }
    let tombstone = patch::neighbor(&f.source, "moved-delete", "deleted");
    assert!(tombstone.exists() && !f.source.exists());
    let (state, evidence) = removal_row(f, "moved-delete");
    assert_eq!(state, if stop { "pending" } else { "uncertain" });
    assert_eq!(evidence["relearnAfterMove"], true);
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    tombstone
}

#[test]
fn moving_identity_permanent_deletion_recovers_after_unrecorded_detach() {
    for directory in [false, true] {
        for stop in [true, false] {
            let _ids = super::MovingIds::enable();
            let f = Fixture::new(directory);
            let tombstone = detach_with_moving_identity(&f, stop);
            assert!(
                f.store
                    .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
                    .unwrap()
                    .is_empty(),
                "directory={directory} stop={stop}"
            );
            assert!(!tombstone.exists());
            assert_eq!(removal_row(&f, "moved-delete").0, "complete");
            assert!(!f.store.file_recovery_pending(&f.source).unwrap());
        }
    }
}

#[test]
fn moving_identity_tombstone_with_changed_content_is_kept() {
    for directory in [false, true] {
        let _ids = super::MovingIds::enable();
        let f = Fixture::new(directory);
        let tombstone = detach_with_moving_identity(&f, false);
        if directory {
            fs::write(tombstone.join("extra.txt"), b"changed").unwrap();
        } else {
            let mut bytes = fs::read(&tombstone).unwrap();
            bytes.push(0);
            fs::write(&tombstone, bytes).unwrap();
        }
        let warnings = f
            .store
            .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
            .unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, codes::CATALOG_DELETE_FAILED);
        assert!(tombstone.exists());
        assert!(f.store.file_recovery_pending(&f.source).unwrap());
    }
}

// Expectation changed in REVa4 (P3-2): the tombstone is recognized by its
// reserved name, so an old row without the mode is relearned like the others.
#[test]
fn removal_evidence_without_identity_mode_relearns_reserved_tombstone() {
    let _ids = super::MovingIds::enable();
    let f = Fixture::new(false);
    let tombstone = detach_with_moving_identity(&f, false);
    let (_, mut evidence) = removal_row(&f, "moved-delete");
    evidence.as_object_mut().unwrap().remove("relearnAfterMove");
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE file_removal SET evidence_json=?1 WHERE id='moved-delete'",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert!(f
        .store
        .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
        .unwrap()
        .is_empty());
    assert!(!tombstone.exists());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
}

#[test]
fn tombstone_outside_its_reserved_name_keeps_strict_proof() {
    let _ids = super::MovingIds::enable();
    let f = Fixture::new(false);
    let tombstone = detach_with_moving_identity(&f, false);
    let elsewhere = f.root.join("packs").join("Copy.zip");
    fs::rename(&tombstone, &elsewhere).unwrap();
    let (_, mut evidence) = removal_row(&f, "moved-delete");
    evidence["tombstone"] = json!(elsewhere);
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE file_removal SET evidence_json=?1 WHERE id='moved-delete'",
                [evidence.to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let warnings = f
        .store
        .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
        .unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].code, codes::CATALOG_DELETE_FAILED);
    assert!(
        elsewhere.exists(),
        "a file at a non-reserved name is never erased"
    );
}

// P3-2: on a stable volume, a remount (replugged drive: new device number)
// changes every identity, whether or not the detached proof was recorded.
#[test]
fn remounted_volume_permanent_deletion_recovers_reserved_tombstone() {
    for directory in [false, true] {
        for recorded in [false, true] {
            let f = Fixture::new(directory);
            let p = unavailable_in_this_thread(&f);
            let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
            assert_eq!(stored.identities_survive_moves, vec![true]);
            if recorded {
                trash::AFTER_DETACH_HOOK.with(|slot| {
                    *slot.borrow_mut() = Some(Box::new(|_| panic!("stop after the record")))
                });
            } else {
                trash::FAIL_DETACH_PROOF.with(|v| v.set(true));
            }
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                f.store.apply_removal(
                    &stored,
                    "remount-delete",
                    &AtomicBool::new(false),
                    &mut p.catalogue_revision.clone(),
                    &f.root.join("cache"),
                    &f.root.join("data"),
                    |_| {},
                )
            }));
            trash::AFTER_DETACH_HOOK.with(|slot| *slot.borrow_mut() = None);
            trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
            let tombstone = patch::neighbor(&f.source, "remount-delete", "deleted");
            assert!(tombstone.exists() && !f.source.exists());
            assert_eq!(
                removal_row(&f, "remount-delete").1["relearnAfterMove"],
                false
            );
            let _remount = super::Remount::now();
            assert!(
                f.store
                    .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
                    .unwrap()
                    .is_empty(),
                "directory={directory} recorded={recorded}"
            );
            assert!(!tombstone.exists());
            assert_eq!(removal_row(&f, "remount-delete").0, "complete");
            assert!(!f.store.file_recovery_pending(&f.source).unwrap());
        }
    }
}

#[test]
fn remounted_tombstone_with_changed_content_is_kept() {
    let f = Fixture::new(true);
    let p = unavailable_in_this_thread(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    trash::FAIL_DETACH_PROOF.with(|v| v.set(true));
    let _ = f.store.apply_removal(
        &stored,
        "remount-changed",
        &AtomicBool::new(false),
        &mut p.catalogue_revision.clone(),
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
    let tombstone = patch::neighbor(&f.source, "remount-changed", "deleted");
    fs::write(tombstone.join("extra.txt"), b"changed").unwrap();
    let _remount = super::Remount::now();
    let warnings = f
        .store
        .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
        .unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(tombstone.join("extra.txt").exists());
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
}

#[test]
fn stable_identity_permanent_deletion_records_strict_mode() {
    let f = Fixture::new(true);
    let p = unavailable_in_this_thread(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    assert_eq!(stored.identities_survive_moves, vec![true]);
    trash::FAIL_DETACH_PROOF.with(|v| v.set(true));
    let _ = f.store.apply_removal(
        &stored,
        "stable-delete",
        &AtomicBool::new(false),
        &mut p.catalogue_revision.clone(),
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
    assert_eq!(
        removal_row(&f, "stable-delete").1["relearnAfterMove"],
        false
    );
}

// REVa4 (P3-1): a failed probe keeps the strict proof and never refuses the
// deletion. The tombstone left by an unrecorded detach is now relearned at
// its reserved name (P3-2), which lifts the lock this fallback used to keep.
#[test]
fn failed_probe_keeps_strict_mode_and_permanent_deletion_succeeds() {
    for directory in [false, true] {
        for unrecorded in [false, true] {
            let _ids = super::MovingIds::enable();
            let f = Fixture::new(directory);
            publish::FAIL_PUBLICATION.with(|v| v.set(true));
            let p = unavailable_in_this_thread(&f);
            publish::FAIL_PUBLICATION.with(|v| v.set(false));
            let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
            assert_eq!(stored.identities_survive_moves, vec![true]);
            assert!(fs::read_dir(f.source.parent().unwrap()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".story-studio-probe-")));
            trash::FAIL_DETACH_PROOF.with(|v| v.set(unrecorded));
            let result = f.store.apply_removal(
                &stored,
                "probe-failed",
                &AtomicBool::new(false),
                &mut p.catalogue_revision.clone(),
                &f.root.join("cache"),
                &f.root.join("data"),
                |_| {},
            );
            trash::FAIL_DETACH_PROOF.with(|v| v.set(false));
            let (state, evidence) = removal_row(&f, "probe-failed");
            assert_eq!(evidence["relearnAfterMove"], false);
            let tombstone = patch::neighbor(&f.source, "probe-failed", "deleted");
            if unrecorded {
                assert_eq!(result.unwrap_err().code, codes::CATALOG_DELETE_FAILED);
                assert_eq!(state, "uncertain");
                assert!(f
                    .store
                    .recover_removals_from(f.store.inherited_recovery().unwrap().removals)
                    .unwrap()
                    .is_empty());
            } else {
                result.unwrap();
                assert_eq!(state, "complete");
            }
            assert!(!tombstone.exists() && !f.source.exists());
            assert_eq!(removal_row(&f, "probe-failed").0, "complete");
            assert!(!f.store.file_recovery_pending(&f.source).unwrap());
        }
    }
}

fn project_fixture() -> Fixture {
    let mut f = Fixture::new(false);
    let project = f.root.join("packs/Project.mbah");
    fs::write(
        &project,
        json!({"title":"Project","type":"pack","tree":[]}).to_string(),
    )
    .unwrap();
    let source = f.store.list_sources().unwrap().items[0].clone();
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: project.clone(),
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
    let page = f.store.list_entries(100, None).unwrap();
    let entry = page
        .items
        .iter()
        .find(|c| {
            c["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["format"] == "project")
        })
        .expect("indexed project");
    f.card = f.store.get_card(entry["id"].as_str().unwrap()).unwrap();
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["format"] == "project")
        .unwrap()
        .clone();
    f.source = project;
    f
}

#[test]
fn trash_project_moves_only_the_file_and_refuses_a_live_editor_lease() {
    let f = project_fixture();
    let media = f.root.join("packs/media");
    let backups = f.root.join("packs/Project.backups");
    fs::create_dir(&media).unwrap();
    fs::create_dir(&backups).unwrap();
    fs::write(media.join("audio.wav"), b"audio").unwrap();
    fs::write(backups.join("saved.mbah"), b"backup").unwrap();
    let lease = f
        .store
        .project_access("open", Some(f.source.to_string_lossy().into()), None, None)
        .unwrap();
    assert_eq!(
        f.store
            .project_access(
                "status",
                Some(f.source.to_string_lossy().into()),
                None,
                None
            )
            .unwrap()["inUse"],
        true
    );
    assert_eq!(
        f.store
            .plan_file_operation("trash".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_PROJECT_IN_USE
    );
    f.store
        .project_access(
            "release",
            None,
            Some(lease["token"].as_str().unwrap().into()),
            None,
        )
        .unwrap();
    let p = plan(&f);
    let lease = f
        .store
        .project_access("open", Some(f.source.to_string_lossy().into()), None, None)
        .unwrap();
    assert_eq!(
        f.store
            .confirm_file_removal(&p.plan_id, "trash", None)
            .unwrap_err()
            .code,
        codes::CATALOG_PROJECT_IN_USE
    );
    f.store
        .project_access(
            "release",
            None,
            Some(lease["token"].as_str().unwrap().into()),
            None,
        )
        .unwrap();
    let token = confirm(&f, &p, "trash", None);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let receipt = launch(&f, &p, vec![token], "project-only").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
    assert_eq!(fs::read(media.join("audio.wav")).unwrap(), b"audio");
    assert_eq!(fs::read(backups.join("saved.mbah")).unwrap(), b"backup");
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_ok());
}

#[test]
fn unavailable_only_at_launch_prepares_a_last_copy_double_confirmation_plan() {
    let f = Fixture::new(false);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::UnavailableForTarget);
    let trash = plan(&f);
    assert!(f.source.exists(), "planning never calls the native adapter");
    assert!(f.store.prepare_permanent_delete(&trash.plan_id).is_err());
    let token = confirm(&f, &trash, "trash", None);
    let receipt = launch(&f, &trash, vec![token], "unavailable-last").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap())
            .error
            .unwrap()
            .code,
        codes::CATALOG_TRASH_UNAVAILABLE
    );
    let p = f.store.prepare_permanent_delete(&trash.plan_id).unwrap();
    assert!(launch(&f, &p, vec![], "unconfirmed").is_err());
    let first = confirm(&f, &p, "targets", None);
    assert!(launch(&f, &p, vec![first.clone()], "one-confirmation").is_err());
    let second = confirm(&f, &p, "irreversible", Some(first.clone()));
    let receipt = launch(&f, &p, vec![first, second], "permanent-last").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_err());
}

#[test]
fn trash_before_last_copy_preserves_favorite_tags_and_corrections() {
    let f = Fixture::new(false);
    retain_other_copy(&f);
    let id = f.card["ficheId"].as_str().unwrap();
    f.store
        .write(|tx| {
            tx.execute("UPDATE fiche SET favorite=1 WHERE id=?1", [id])
                .map_err(error)?;
            tx.execute(
                "INSERT INTO provenance(id,kind) VALUES ('corb-manual','manual')",
                [],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO correction VALUES (?1,'ageMin','','defined','3','corb-manual',NULL,1)",
                [id],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO tag VALUES ('corb-tag','Personnel','personnel',1)",
                [],
            )
            .map_err(error)?;
            tx.execute("INSERT INTO tag_member VALUES ('corb-tag',?1)", [id])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let receipt = launch(&f, &p, vec![token], "before-last").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert_eq!(f.store.get_card(id).unwrap()["favorite"], true);
    let personal: (i64, i64, String) = f.store.read(|c| c.query_row("SELECT (SELECT count(*) FROM correction WHERE fiche_id=?1),(SELECT count(*) FROM tag_member WHERE fiche_id=?1),(SELECT value_json FROM correction WHERE fiche_id=?1 AND field='ageMin')", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    assert_eq!(personal, (1, 1, "3".into()));
}

#[test]
fn trash_forty_released_previews_leave_capacity_for_a_new_plan() {
    let f = Fixture::new(false);
    for _ in 0..40 {
        let p = plan(&f);
        f.store.release_file_plan(&p.plan_id).unwrap();
    }
    assert!(f.store.file_plans.lock().unwrap().is_empty());
    let p = plan(&f);
    assert!(f.store.file_plans.lock().unwrap().contains_key(&p.plan_id));
}

#[test]
fn trash_last_copy_recovery_keeps_data_after_pending_and_uncertain_evidence() {
    for state in ["pending", "uncertain"] {
        let mut f = Fixture::new(false);
        let p = plan(&f);
        let evidence = json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap()),"trashReceipt":emptied_receipt(&f)});
        f.store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO file_removal VALUES ('crash-last',?1,?2)",
                    rusqlite::params![evidence.to_string(), state],
                )
                .map_err(error)?;
                tx.execute(
                    "UPDATE fiche SET favorite=1 WHERE id=?1",
                    [f.card["ficheId"].as_str().unwrap()],
                )
                .map_err(error)?;
                Ok(())
            })
            .unwrap();
        fs::remove_file(&f.source).unwrap();
        let placeholder = Arc::new(
            Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap(),
        );
        drop(std::mem::replace(&mut f.store, placeholder));
        let reopened = Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap();
        let warnings = reopened
            .recover_removals_from(reopened.inherited_recovery().unwrap().removals)
            .unwrap();
        assert!(warnings.is_empty());
        assert!(reopened
            .get_card(f.card["ficheId"].as_str().unwrap())
            .is_ok());
        let count: i64 = reopened
            .read(|c| {
                c.query_row(
                    "SELECT count(*) FROM file_removal WHERE id='crash-last'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            count, 1,
            "completed removal evidence remains without purging the fiche"
        );
    }
}

#[test]
fn permanent_last_copy_blocked_purge_keeps_retirement_and_retries_after_blocker_finishes() {
    let mut f = Fixture::new(false);
    let p = retention::permanent_last_copy_plan(&f);
    let first = confirm(&f, &p, "targets", None);
    let second = confirm(&f, &p, "irreversible", Some(first.clone()));
    // A separate unfinished journal mentioning the card must still block purge.
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO file_removal VALUES ('blocker',?1,'pending')",
                [json!({"ficheId":f.card["ficheId"]}).to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let receipt = launch(&f, &p, vec![first, second], "blocked-purge").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
    let retired: i64 = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT retired FROM exemplar WHERE id=?1",
                [f.exemplar["id"].as_str().unwrap()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(retired, 1);
    assert_eq!(
        removal_row(&f, receipt["operationId"].as_str().unwrap()).0,
        "purgePending"
    );
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_ok());
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE file_removal SET state='complete' WHERE id='blocker'",
                [],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let placeholder =
        Arc::new(Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap());
    drop(std::mem::replace(&mut f.store, placeholder));
    let reopened = Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap();
    assert!(reopened
        .recover_inherited(reopened.inherited_recovery().unwrap())
        .is_empty());
    assert!(reopened
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_err());
}

#[test]
fn trash_uncertain_with_proved_absence_retains_personal_data_without_emptying_proof() {
    let f = Fixture::new(false);
    retention::tag_card(&f);
    let p = plan(&f);
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Uncertain);
    super::super::trash::AFTER_NATIVE_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|path| {
            fs::remove_file(path).unwrap();
        }))
    });
    let result = f.store.apply_removal(
        &stored,
        "uncertain-last",
        &AtomicBool::new(false),
        &mut p.catalogue_revision.clone(),
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    super::super::trash::AFTER_NATIVE_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(result.unwrap_err().code, codes::CATALOG_TRASH_UNCERTAIN);
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_ok());
    assert!(f.store.file_recovery_pending(&f.source).unwrap());
    assert!(f.store.prepare_permanent_delete(&p.plan_id).is_err());
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
    let (_, evidence) = removal_row(&f, "uncertain-last");
    assert!(f
        .store
        .recover_removals_from(vec![("uncertain-last".into(), evidence.to_string())])
        .unwrap()
        .is_empty());
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
    assert_eq!(f.store.list_tags().unwrap()["items"][0]["count"], 1);
}

#[test]
fn trash_recovery_database_failure_does_not_stop_the_following_row() {
    let f = Fixture::new(false);
    retain_other_copy(&f);
    let p = plan(&f);
    let evidence =
        json!({"plan":p,"parentId":writes::file_id(f.source.parent().unwrap())}).to_string();
    f.store.write(|tx| {
        for id in ["bad-row", "next-row"] {
            tx.execute("INSERT INTO file_removal VALUES (?1,?2,'pending')", rusqlite::params![id,evidence]).map_err(error)?;
        }
        tx.execute_batch("CREATE TRIGGER fail_first_removal BEFORE UPDATE ON file_removal WHEN OLD.id='bad-row' BEGIN SELECT RAISE(ABORT,'simulated database failure'); END;").map_err(error)?;
        Ok(())
    }).unwrap();
    fs::remove_file(&f.source).unwrap();
    let warnings = f
        .store
        .recover_removals_from(vec![
            ("bad-row".into(), evidence.clone()),
            ("next-row".into(), evidence),
        ])
        .unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(removal_row(&f, "next-row").0, "complete");
}

#[test]
fn permanent_last_copy_failed_erasure_keeps_evidence_until_startup_recovery() {
    let f = Fixture::new(false);
    let trash = plan(&f);
    let stored = f.store.file_plans.lock().unwrap()[&trash.plan_id].clone();
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::UnavailableForTarget);
    assert_eq!(
        f.store
            .apply_removal(
                &stored,
                "unavailable",
                &AtomicBool::new(false),
                &mut trash.catalogue_revision.clone(),
                &f.root.join("cache"),
                &f.root.join("data"),
                |_| {}
            )
            .unwrap_err()
            .code,
        codes::CATALOG_TRASH_UNAVAILABLE
    );
    let p = f.store.prepare_permanent_delete(&trash.plan_id).unwrap();
    let stored = f.store.file_plans.lock().unwrap()[&p.plan_id].clone();
    super::super::recovery::FAIL_REMOVE_OWNED.with(|v| v.set(true));
    let result = f.store.apply_removal(
        &stored,
        "failed-last",
        &AtomicBool::new(false),
        &mut p.catalogue_revision.clone(),
        &f.root.join("cache"),
        &f.root.join("data"),
        |_| {},
    );
    super::super::recovery::FAIL_REMOVE_OWNED.with(|v| v.set(false));
    assert_eq!(result.unwrap_err().code, codes::CATALOG_DELETE_FAILED);
    let (state, evidence) = removal_row(&f, "failed-last");
    assert_eq!(state, "uncertain");
    let tombstone = PathBuf::from(evidence["tombstone"].as_str().unwrap());
    assert!(tombstone.exists());
    let id = f.card["ficheId"].as_str().unwrap();
    f.store.retry_removal_purges();
    assert!(f.store.get_card(id).is_ok());
    // Even an explicit purge cannot exempt a row still carrying native proof.
    assert!(f
        .store
        .write(
            |tx| crate::services::catalogue::removal::purge_after_file_removal(
                tx,
                &[id.into()],
                "failed-last"
            )
        )
        .is_err());
    let inherited = f.store.inherited_recovery().unwrap();
    assert!(inherited.removals.iter().any(|(id, _)| id == "failed-last"));
    assert!(f.store.recover_inherited(inherited).is_empty());
    assert!(!tombstone.exists());
    assert!(f.store.get_card(id).is_err());
}

#[test]
fn permanent_revision_conflict_inherits_unavailability_but_requires_two_new_receipts() {
    for at_start in [false, true] {
        let f = Fixture::new(false);
        let p = unavailable(&f);
        let first = confirm(&f, &p, "targets", None);
        let second = if at_start {
            Some(confirm(&f, &p, "irreversible", Some(first.clone())))
        } else {
            None
        };
        f.store
            .write(|tx| {
                tx.execute("UPDATE catalogue SET revision=revision+1", [])
                    .map_err(error)?;
                Ok(())
            })
            .unwrap();
        let error = if let Some(second) = second {
            launch(&f, &p, vec![first.clone(), second], "conflicted").unwrap_err()
        } else {
            f.store
                .confirm_file_removal(&p.plan_id, "irreversible", Some(first.clone()))
                .unwrap_err()
        };
        assert_eq!(error.code, codes::CATALOG_REVISION_CONFLICT);
        let fresh = plan(&f);
        assert_eq!(fresh.targets[0].source_token, p.targets[0].source_token);
        f.store.release_file_plan(&p.plan_id).unwrap();
        let fresh = f.store.prepare_permanent_delete(&fresh.plan_id).unwrap();
        assert!(launch(&f, &fresh, vec![first], "old-receipt").is_err());
        let first = confirm(&f, &fresh, "targets", None);
        assert!(launch(&f, &fresh, vec![first.clone()], "one-receipt").is_err());
        let second = confirm(&f, &fresh, "irreversible", Some(first.clone()));
        let receipt = launch(&f, &fresh, vec![first, second], "replanned").unwrap();
        assert_eq!(
            f.wait(receipt["operationId"].as_str().unwrap()).status,
            "success"
        );
    }
}

fn deferred_purge(f: &Fixture, id: &str, p: &FilePlan) {
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET retired=1 WHERE fiche_id=?1",
                [f.card["ficheId"].as_str().unwrap()],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO file_removal VALUES (?1,?2,'purgePending')",
                rusqlite::params![id, json!({"plan":p}).to_string()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn permanent_two_deferred_purges_on_same_card_do_not_block_each_other() {
    let f = Fixture::new(false);
    let mut p = plan(&f);
    p.action = "deletePermanently".into();
    fs::remove_file(&f.source).unwrap();
    deferred_purge(&f, "first-purge", &p);
    deferred_purge(&f, "second-purge", &p);
    f.store.retry_removal_purges();
    assert!(f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .is_err());
    let count: i64 = f
        .store
        .read(|c| c.query_row("SELECT count(*) FROM file_removal", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn trash_deferred_purge_does_not_guard_a_reused_path() {
    let f = Fixture::new(false);
    let p = plan(&f);
    deferred_purge(&f, "deferred", &p);
    assert!(!f.store.file_recovery_pending(&f.source).unwrap());
    f.store
        .project_access("open", Some(f.source.to_string_lossy().into()), None, None)
        .unwrap();
    // Simulate reconciliation of the returned file before planning again.
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET retired=0 WHERE id=?1",
                [f.exemplar["id"].as_str().unwrap()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    // The original file may be back: a purge-only row must not block a new plan.
    let again = plan(&f);
    assert_eq!(
        again.targets[0].source_path,
        crate::support::paths::path_for_frontend(&f.source)
    );
}

// A different, empty card has a deferred purge blocked by the real operation's
// durable evidence. Completion must retry it in this process, without startup.
fn seed_purge_blocked_by(f: &Fixture, p: &FilePlan) -> String {
    let id = "deferred-empty-card";
    let mut target = p.targets[0].clone();
    target.fiche_id = id.into();
    target.exemplar_id = "gone-exemplar".into();
    let evidence = json!({"plan":{"action":"deletePermanently","targets":[target]}}).to_string();
    f.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO fiche(id,created_at,revision) VALUES (?1,0,0)",
                [id],
            )
            .map_err(error)?;
            tx.execute(
                "INSERT INTO file_removal VALUES ('deferred-empty',?1,'purgePending')",
                [evidence],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    id.into()
}

#[test]
fn trash_deferred_purge_retries_at_file_operation_completion_without_startup() {
    let f = Fixture::new(false);
    let p = plan(&f);
    let id = seed_purge_blocked_by(&f, &p);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let token = confirm(&f, &p, "trash", None);
    // Hold the real worker while installing and observing its durable blocker.
    let hold = f.store.scans.heavy.lock().unwrap();
    let receipt = launch(&f, &p, vec![token], "purge-on-completion").unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE file_operation SET signature=?1 WHERE id=?2",
                rusqlite::params![
                    json!({"ficheId":id}).to_string(),
                    receipt["operationId"].as_str().unwrap()
                ],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    f.store.retry_removal_purges();
    assert!(f.store.get_card(&id).is_ok());
    drop(hold);
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(f.store.get_card(&id).is_err());
}

// Real indexed archives: all I/O stays under the isolated fixture root.
type Entries = Vec<(String, Vec<u8>)>;
fn zip_bytes(entries: &Entries) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        if let Some(dir) = name.strip_suffix('/') {
            w.add_directory(dir, zip::write::SimpleFileOptions::default())
                .unwrap();
        } else {
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(bytes).unwrap();
        }
    }
    w.finish().unwrap().into_inner()
}
fn zip_entries(bytes: Vec<u8>) -> Entries {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|i| {
            let mut entry = archive.by_index(i).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (entry.name().to_owned(), bytes)
        })
        .collect()
}
fn prefixed(prefix: &str, entries: &Entries) -> Entries {
    entries
        .iter()
        .map(|(name, bytes)| (format!("{prefix}{name}"), bytes.clone()))
        .collect()
}
fn second_story(entries: &Entries) -> Entries {
    entries
        .iter()
        .map(|(name, bytes)| {
            let mut bytes = bytes.clone();
            if name == "story.json" {
                let mut story: Value = serde_json::from_slice(&bytes).unwrap();
                story["stageNodes"][0]["uuid"] = json!("bda17862-0d71-41f6-974a-222222222222");
                bytes = serde_json::to_vec(&story).unwrap();
            }
            (name.clone(), bytes)
        })
        .collect()
}
fn rescan(f: &Fixture) {
    let source = f.store.list_sources().unwrap().items[0].clone();
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
/// `build` receives the fixture pack's entries (`story.json` at the root) and
/// returns the source archive's content. The first available exemplar of the
/// archive (member, or direct pack when `member` is false) is selected.
fn indexed_archive(name: &str, member: bool, build: impl FnOnce(&Entries) -> Vec<u8>) -> Fixture {
    let mut f = Fixture::new(false);
    f.store
        .retire_exemplar(
            f.card["ficheId"].as_str().unwrap(),
            f.exemplar["id"].as_str().unwrap(),
        )
        .unwrap();
    let pack = zip_entries(fs::read(&f.source).unwrap());
    let bytes = build(&pack);
    if name != "Original.zip" {
        fs::remove_file(&f.source).unwrap();
        f.source = f.source.with_file_name(name);
    }
    fs::write(&f.source, bytes).unwrap();
    rescan(&f);
    let path = crate::support::paths::path_for_frontend(&f.source);
    let pick = |e: &Value, locator: &Value| {
        e["state"] == "available"
            && locator["path"] == path
            && locator["member"].is_null() != member
    };
    let page = serde_json::to_value(f.store.list_entries(100, None).unwrap()).unwrap();
    let card = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["exemplars"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| pick(e, &e["locator"]))
        })
        .expect("indexed archive exemplar");
    f.card = f.store.get_card(card["id"].as_str().unwrap()).unwrap();
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| pick(e, &json!({"path":e["path"],"member":e["member"]})))
        .unwrap()
        .clone();
    f
}
fn archive_fixture(packs: usize, nested: bool) -> Fixture {
    indexed_archive("Original.zip", true, |pack| {
        if nested {
            let inner = zip_bytes(&prefixed("pack/", pack));
            return zip_bytes(&vec![("inner.zip".into(), inner)]);
        }
        let mut entries = Vec::new();
        for n in 0..packs {
            let pack = if n > 0 {
                second_story(pack)
            } else {
                pack.clone()
            };
            entries.extend(prefixed(&format!("pack-{n}/"), &pack));
        }
        zip_bytes(&entries)
    })
}
fn inspected(f: &Fixture) -> Value {
    let mut card = f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .unwrap();
    f.store.inspect_archive_removals(&mut card).unwrap();
    card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == f.exemplar["id"])
        .unwrap()["archiveRemoval"]
        .clone()
}
fn plan_error(f: &Fixture) -> crate::support::user_message::UserMessage {
    f.store
        .plan_file_operation("trash".into(), request(f), options())
        .unwrap_err()
}
/// Plan, confirm and run the trash: the whole source archive leaves, nothing else.
fn trash_whole_archive(f: &Fixture, key: &str) {
    let neighbour = f.source.with_file_name("neighbour.txt");
    fs::write(&neighbour, b"kept").unwrap();
    let p = plan(f);
    assert_eq!(
        p.targets[0].source_path,
        crate::support::paths::path_for_frontend(&f.source)
    );
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let token = confirm(f, &p, "trash", None);
    let receipt = launch(f, &p, vec![token], key).unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
    assert!(neighbour.exists() && f.source.parent().unwrap().is_dir());
}
fn device_pack(root: &str) -> Entries {
    zip_entries(
        crate::services::catalogue::analyze::fs_archive::tests::fixture(&[root], None, false),
    )
}

#[test]
fn trash_single_archive_pack_targets_container_and_reconciles() {
    let f = archive_fixture(1, false);
    assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
    let p = plan(&f);
    assert_eq!(
        p.targets[0].source_path,
        crate::support::paths::path_for_frontend(&f.source)
    );
    assert_eq!(p.targets[0].member_chain.len(), 1);
    injections()
        .lock()
        .unwrap()
        .insert(f.source.clone(), Outcome::Removed);
    let token = confirm(&f, &p, "trash", None);
    let receipt = launch(&f, &p, vec![token], "single-archive").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
    let active: i64 = f.store.read(|c| c.query_row("SELECT count(*) FROM exemplar WHERE retired=0 AND json_extract(anchor_json,'$.path')=?1", [crate::support::paths::path_for_frontend(&f.source)], |r| r.get(0))).unwrap();
    assert_eq!(active, 0);
}

#[test]
fn trash_shared_archive_across_cards_is_refused() {
    let f = archive_fixture(2, false);
    assert_eq!(f.exemplar["archiveRemoval"]["packCount"], 2);
    assert_eq!(f.exemplar["archiveRemoval"]["reason"], "shared");
    assert_eq!(
        f.store
            .plan_file_operation("trash".into(), request(&f), options())
            .unwrap_err()
            .code,
        codes::CATALOG_TRASH_ARCHIVE_SHARED
    );
    assert!(f.source.exists());
}

#[test]
fn trash_archive_new_active_exemplar_invalidates_confirmed_plan() {
    let f = archive_fixture(1, false);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    f.store.write(|tx| {
        tx.execute("INSERT INTO fiche(id,created_at,revision) VALUES ('another-card',0,0)", []).map_err(error)?;
        tx.execute("INSERT INTO exemplar(id,fiche_id,anchor_json,proof_json,content_revision,retired) SELECT 'new-member','another-card',anchor_json,proof_json,content_revision,0 FROM exemplar WHERE id=?1", [f.exemplar["id"].as_str().unwrap()]).map_err(error)?;
        tx.execute("UPDATE catalogue SET revision=revision+1", []).map_err(error)?;
        Ok(())
    }).unwrap();
    assert_eq!(
        launch(&f, &p, vec![token], "new-sibling").unwrap_err().code,
        codes::CATALOG_TRASH_ARCHIVE_SHARED
    );
    assert!(f.source.exists());
}

#[test]
fn trash_archive_retired_exemplar_reports_changed_source() {
    let f = archive_fixture(1, false);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET retired=1 WHERE id=?1",
                [f.exemplar["id"].as_str().unwrap()],
            )
            .map_err(error)?;
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        launch(&f, &p, vec![token], "retired-member")
            .unwrap_err()
            .code,
        codes::CATALOG_FILE_SOURCE_CHANGED
    );
    assert!(f.source.exists());
}

#[test]
fn trash_archive_offline_and_outside_source_are_refused() {
    // Deliberate change (rule of 28 Oct.): a nested member is no longer
    // refused as such; see trash_nested_sole_pack_targets_outer_archive.
    let offline = archive_fixture(1, false);
    fs::rename(&offline.source, offline.root.join("disconnected.zip")).unwrap();
    assert!(offline
        .store
        .plan_file_operation("trash".into(), request(&offline), options())
        .is_err());
    let outside = archive_fixture(1, false);
    outside
        .store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert!(outside
        .store
        .plan_file_operation("trash".into(), request(&outside), options())
        .is_err());
    assert!(outside.source.exists());
}

#[test]
fn trash_single_archive_native_unavailable_keeps_double_confirmation_fallback() {
    let f = archive_fixture(1, false);
    let p = unavailable(&f);
    assert_eq!(
        p.targets[0].source_path,
        crate::support::paths::path_for_frontend(&f.source)
    );
    let first = confirm(&f, &p, "targets", None);
    assert_eq!(
        launch(&f, &p, vec![first.clone()], "archive-incomplete")
            .unwrap_err()
            .code,
        codes::CATALOG_DELETE_CONFIRMATION_REQUIRED
    );
    let second = confirm(&f, &p, "irreversible", Some(first.clone()));
    let receipt = launch(&f, &p, vec![first, second], "archive-permanent").unwrap();
    assert_eq!(
        f.wait(receipt["operationId"].as_str().unwrap()).status,
        "success"
    );
    assert!(!f.source.exists());
}

#[test]
fn trash_archive_new_scanned_pack_refuses_execution_before_revision_conflict() {
    use std::io::Write;
    let f = archive_fixture(1, false);
    let p = plan(&f);
    let token = confirm(&f, &p, "trash", None);
    let mut w = zip::ZipWriter::new_append(
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&f.source)
            .unwrap(),
    )
    .unwrap();
    w.start_file(
        "second/story.json",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    w.write_all(&serde_json::to_vec(&json!({"title":"Second","stageNodes":[{"uuid":"bda17862-0d71-41f6-974a-333333333333","squareOne":true}],"actionNodes":[]})).unwrap()).unwrap();
    w.finish().unwrap();
    let source = f.store.list_sources().unwrap().items[0].clone();
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
    assert_eq!(
        launch(&f, &p, vec![token], "scanned-sibling")
            .unwrap_err()
            .code,
        codes::CATALOG_TRASH_ARCHIVE_SHARED
    );
    assert!(f.source.exists());
}

#[test]
fn trash_archive_outside_source_and_offline_observation_are_refused() {
    let f = archive_fixture(1, false);
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET state='unavailable' WHERE exemplar_id=?1",
                [f.exemplar["id"].as_str().unwrap()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.store
            .get_card(f.card["ficheId"].as_str().unwrap())
            .unwrap()["exemplars"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == f.exemplar["id"])
            .unwrap()["archiveRemoval"]["reason"],
        "unavailable"
    );
    assert!(f
        .store
        .plan_file_operation("trash".into(), request(&f), options())
        .is_err());
    let f = archive_fixture(1, false);
    let outside = f.root.join("outside.zip");
    fs::copy(&f.source, &outside).unwrap();
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE exemplar SET anchor_json=json_set(anchor_json,'$.path',?2) WHERE id=?1",
                rusqlite::params![
                    f.exemplar["id"].as_str().unwrap(),
                    crate::support::paths::path_for_frontend(&outside)
                ],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    assert!(f
        .store
        .plan_file_operation("trash".into(), request(&f), options())
        .is_err());
    assert!(outside.exists());
    assert!(f.source.exists());
}

#[test]
fn trash_pack_with_pdf_targets_the_whole_zip() {
    let f = indexed_archive("Bundle.zip", true, |pack| {
        let mut entries = prefixed("A/", pack);
        entries.push(("notice.pdf".into(), b"%PDF-1.4".to_vec()));
        entries.push(("A/backup.bak".into(), b"old".to_vec()));
        zip_bytes(&entries)
    });
    assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
    assert_eq!(inspected(&f)["enabled"], true);
    trash_whole_archive(&f, "pack-with-pdf");
}

#[test]
fn trash_studio_and_device_packs_in_one_zip_is_refused() {
    let f = indexed_archive("Mixed.zip", true, |pack| {
        let mut entries = prefixed("A/", pack);
        entries.extend(device_pack("B"));
        zip_bytes(&entries)
    });
    // The analyzer only indexes A: the catalogue alone believes in one pack.
    assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
    assert_eq!(
        inspected(&f),
        json!({"enabled":false,"reason":"multiple","packCount":2})
    );
    let error = plan_error(&f);
    assert_eq!(error.code, codes::CATALOG_TRASH_ARCHIVE_MULTIPLE);
    assert_eq!(error.params["count"], 2);
    assert!(f.source.exists());
}

#[test]
fn trash_uninspectable_nested_7z_is_refused() {
    let f = indexed_archive("WithSeven.zip", true, |pack| {
        let mut entries = prefixed("A/", pack);
        entries.push(("B.7z".into(), b"7z\xBC\xAF\x27\x1C".to_vec()));
        zip_bytes(&entries)
    });
    assert_eq!(inspected(&f)["reason"], "uninspectable");
    assert_eq!(
        plan_error(&f).code,
        codes::CATALOG_TRASH_ARCHIVE_UNINSPECTABLE
    );
    assert!(f.source.exists());
}

#[test]
fn trash_direct_zip_with_a_second_story_is_refused() {
    let f = indexed_archive("Direct.zip", false, |pack| {
        let mut entries = pack.clone();
        entries.extend(prefixed("X/", &second_story(pack)));
        zip_bytes(&entries)
    });
    assert!(f.exemplar["member"].is_null());
    assert_eq!(
        inspected(&f),
        json!({"enabled":false,"reason":"multiple","packCount":2})
    );
    assert_eq!(plan_error(&f).code, codes::CATALOG_TRASH_ARCHIVE_MULTIPLE);
    assert!(f.source.exists());
}

#[test]
fn trash_nested_sole_pack_targets_outer_archive() {
    for folder in ["", "pack/"] {
        let f = indexed_archive("Outer.zip", true, |pack| {
            let inner = zip_bytes(&prefixed(folder, pack));
            zip_bytes(&vec![("inner.zip".into(), inner)])
        });
        assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
        assert_eq!(inspected(&f)["enabled"], true);
        let p = plan(&f);
        assert_eq!(p.targets[0].source_format, "zip");
        assert!(!p.targets[0].member_chain.is_empty());
        trash_whole_archive(&f, &format!("nested-{}", folder.len()));
    }
    let f = indexed_archive("Deeper.zip", true, |pack| {
        let inner = zip_bytes(&prefixed("pack/", pack));
        let middle = zip_bytes(&vec![("inner.zip".into(), inner)]);
        zip_bytes(&vec![("middle.zip".into(), middle)])
    });
    assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
    trash_whole_archive(&f, "nested-deeper");
}

#[test]
fn trash_outer_zip_with_two_inner_zips_is_refused() {
    let f = indexed_archive("TwoInner.zip", true, |pack| {
        zip_bytes(&vec![
            ("a.zip".into(), zip_bytes(&prefixed("pack/", pack))),
            (
                "b.zip".into(),
                zip_bytes(&prefixed("pack/", &second_story(pack))),
            ),
        ])
    });
    assert_eq!(f.exemplar["archiveRemoval"]["reason"], "shared");
    assert_eq!(f.exemplar["archiveRemoval"]["packCount"], 2);
    assert_eq!(plan_error(&f).code, codes::CATALOG_TRASH_ARCHIVE_SHARED);
    assert!(f.source.exists());
}

#[test]
fn trash_unreadable_member_has_its_own_reason() {
    let f = archive_fixture(1, false);
    f.store
        .write(|tx| {
            tx.execute(
                "UPDATE cache.observation SET state='corruptArchive' WHERE exemplar_id=?1",
                [f.exemplar["id"].as_str().unwrap()],
            )
            .map_err(error)?;
            Ok(())
        })
        .unwrap();
    let card = f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .unwrap();
    let removal = &card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == f.exemplar["id"])
        .unwrap()["archiveRemoval"];
    assert_eq!(removal["reason"], "unreadable");
    assert!(f
        .store
        .plan_file_operation("trash".into(), request(&f), options())
        .is_err());
    assert!(f.source.exists());
}

#[test]
fn trash_7z_with_a_sole_nested_pack_targets_the_7z() {
    let f = indexed_archive("Outer.7z", true, |pack| {
        let inner = zip_bytes(&prefixed("pack/", pack));
        crate::services::catalogue::analyze::pack_count::tests::seven_bytes(&[(
            "inner.zip".into(),
            inner,
        )])
    });
    assert_eq!(f.exemplar["archiveRemoval"]["enabled"], true);
    let p = plan(&f);
    assert_eq!(p.targets[0].source_format, "7z");
    trash_whole_archive(&f, "seven-nested");
    let f = indexed_archive("Two.7z", true, |pack| {
        let mut entries = prefixed("A/", pack);
        entries.extend(device_pack("B"));
        crate::services::catalogue::analyze::pack_count::tests::seven_bytes(&entries)
    });
    assert_eq!(plan_error(&f).code, codes::CATALOG_TRASH_ARCHIVE_MULTIPLE);
    assert!(f.source.exists());
}
