//! Per-fiche display covers served by address (`cover_store`).
use super::*;
use crate::services::catalogue::cover_store::Served;

fn stored_files(f: &Fixture, id: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(f.store.cover_store_dir(id)) else {
        return Vec::new();
    };
    let mut names: Vec<_> = entries
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn ready(served: Served) -> Vec<u8> {
    match served {
        Served::Ready(bytes) => bytes,
        other => panic!("expected a ready cover, got {other:?}"),
    }
}

fn wipe_exemplar_cache(f: &Fixture) {
    for entry in std::fs::read_dir(f.store.thumbnail_root()).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
}

fn set_health(f: &Fixture, availability: Option<&str>) {
    f.store
        .write(|tx| {
            match availability {
                Some(state) => tx.execute(
                    "INSERT OR REPLACE INTO source_health(source_id,availability) VALUES (?1,?2)",
                    rusqlite::params![f.source, state],
                ),
                None => tx.execute("DELETE FROM source_health WHERE source_id=?1", [&f.source]),
            }
            .unwrap();
            tx.execute("UPDATE catalogue SET revision=revision+1", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
}

fn covered(f: &Fixture, name: &str, colour: [u8; 3], modified: i64) -> Scanned {
    let image = f.root.join(format!("{name}.png"));
    coloured_png(&image, colour);
    let mut item = f.item(&format!("{name}.mbah"), Some(name), None, modified);
    item.observation.cover = Some(json!({"kind":"file","path":image}));
    item
}

fn distinct(f: &Fixture, mut item: Scanned, n: u32) -> Scanned {
    let uuid = format!("{n:08x}-1234-4234-8234-123456789abc");
    let identity = item.observation.identity.as_mut().unwrap();
    identity.raw = json!(uuid);
    identity.value = Some(uuid);
    let _ = f;
    item
}

#[test]
fn a_cover_is_made_once_then_read_back_without_source_or_decoder() {
    let f = Fixture::new();
    let item = covered(&f, "pack", [255, 0, 0], 1);
    let id = f.publish(std::slice::from_ref(&item));
    let signature = listed_cover_signatures(&f)[&id].clone();
    let made = ready(f.store.served_cover(&id, &signature).unwrap());
    // The command keeps answering the same image.
    let thumbnail = f.store.get_thumbnail(None, Some(&id), None).unwrap();
    assert_eq!(thumbnail.signature.as_deref(), Some(signature.as_str()));
    assert_eq!(thumbnail.bytes.as_deref(), Some(made.as_slice()));
    assert_eq!(stored_files(&f, &id).len(), 1);
    assert!(stored_files(&f, &id)[0].ends_with(&format!("-{signature}.jpg")));
    // Neither the original image nor the exemplar cache remains: a second
    // answer can only come from the fiche store, without any decoding.
    std::fs::remove_file(f.root.join("pack.png")).unwrap();
    wipe_exemplar_cache(&f);
    assert_eq!(ready(f.store.served_cover(&id, &signature).unwrap()), made);
    assert_eq!(
        f.store.prefabricate_covers().unwrap(),
        crate::services::catalogue::cover_store::PassReport {
            kept: 1,
            ..Default::default()
        }
    );
}

#[test]
fn a_new_signature_replaces_the_image_and_refuses_the_old_address() {
    let f = Fixture::new();
    let mut item = covered(&f, "pack", [255, 0, 0], 1);
    let id = f.publish(std::slice::from_ref(&item));
    let old = listed_cover_signatures(&f)[&id].clone();
    let red = ready(f.store.served_cover(&id, &old).unwrap());
    coloured_png(&f.root.join("pack.png"), [0, 0, 255]);
    item.token = "changed".into();
    item.modified = 2;
    f.publish(std::slice::from_ref(&item));
    let new = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(new, old);
    let blue = ready(f.store.served_cover(&id, &new).unwrap());
    assert_ne!(blue, red);
    assert_eq!(stored_files(&f, &id).len(), 1, "one image per fiche");
    assert!(stored_files(&f, &id)[0].ends_with(&format!("-{new}.jpg")));
    assert_eq!(f.store.served_cover(&id, &old).unwrap(), Served::Stale);
}

#[test]
fn forged_addresses_are_refused() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let signature = listed_cover_signatures(&f)[&id].clone();
    assert_eq!(
        f.store.served_cover("unknown-fiche", &signature).unwrap(),
        Served::UnknownFiche
    );
    assert_eq!(
        f.store.served_cover(&id, &"0".repeat(64)).unwrap(),
        Served::Stale
    );
    assert_eq!(
        f.store.served_cover(&id, "../../etc").unwrap(),
        Served::BadAddress
    );
    assert_eq!(
        f.store.served_cover("../..", &signature).unwrap(),
        Served::UnknownFiche
    );
    assert!(
        stored_files(&f, &id).is_empty(),
        "nothing made for refusals"
    );
    // Directories are digests: no id reaches outside the store.
    assert!(f
        .store
        .cover_store_dir("../../x")
        .starts_with(f.root.join("cache/catalogue/covers")));
}

#[test]
fn correction_official_and_cleared_covers_follow_the_fiche() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let file = listed_cover_signatures(&f)[&id].clone();
    let original = ready(f.store.served_cover(&id, &file).unwrap());

    let green = f.root.join("green.png");
    coloured_png(&green, [0, 255, 0]);
    let stage = f.store.stage_cover(&green).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let corrected = listed_cover_signatures(&f)[&id].clone();
    let correction = ready(f.store.served_cover(&id, &corrected).unwrap());
    assert_ne!(correction, original);
    assert_eq!(stored_files(&f, &id).len(), 1);
    assert_eq!(f.store.served_cover(&id, &file).unwrap(), Served::Stale);

    f.mutate(&id, json!([{"field":"cover","state":"cleared"}]));
    let cleared = listed_cover_signatures(&f)[&id].clone();
    assert_eq!(f.store.served_cover(&id, &cleared).unwrap(), Served::Absent);
    assert!(stored_files(&f, &id).is_empty(), "cleared cover removed");
}

#[test]
fn a_retained_official_cover_is_stored_once() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    official_lunii(&f);
    review1_retained_cover(&f, &id);
    let signature = listed_cover_signatures(&f)[&id].clone();
    let made = ready(f.store.served_cover(&id, &signature).unwrap());
    assert_eq!(stored_files(&f, &id).len(), 1);
    assert_eq!(f.store.lunii_cover_test_requests(), 1, "retention only");
    assert_eq!(ready(f.store.served_cover(&id, &signature).unwrap()), made);
    assert_eq!(f.store.lunii_cover_test_requests(), 1);
}

#[test]
fn missing_or_corrupt_official_cover_falls_back_to_pack() {
    for corrupt in [false, true] {
        let f = Fixture::new();
        let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
        let pack = f.store.fiche_thumbnail(&id, None).unwrap().bytes.unwrap();
        official_lunii(&f);
        review1_retained_cover(&f, &id);
        let sha = field_value(&f.store, &id, "cover")["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let signature = listed_cover_signatures(&f)[&id].clone();
        let retained = f.store.images_root().join(sha);
        if corrupt {
            std::fs::write(&retained, b"corrupt image").unwrap();
        } else {
            std::fs::remove_file(&retained).unwrap();
        }
        assert_eq!(
            f.store.lunii_thumbnail(&id).unwrap().unwrap().state,
            "absent"
        );
        assert_eq!(ready(f.store.served_cover(&id, &signature).unwrap()), pack);
        assert_eq!(listed_cover_signatures(&f)[&id], signature);
    }
}

#[test]
fn missing_correction_is_terminal_and_corrupt_correction_is_remembered() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let path = f.root.join("green.png");
    coloured_png(&path, [0, 255, 0]);
    let stage = f.store.stage_cover(&path).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let sha = stage["sha256"].as_str().unwrap().to_owned();
    let signature = listed_cover_signatures(&f)[&id].clone();
    let retained = f.store.images_root().join(sha);
    let bytes = std::fs::read(&retained).unwrap();
    std::fs::remove_file(&retained).unwrap();
    assert!(f.store.served_cover(&id, &signature).is_err());
    std::fs::write(&retained, &bytes).unwrap();
    ready(f.store.served_cover(&id, &signature).unwrap());
    for name in stored_files(&f, &id) {
        std::fs::remove_file(f.store.cover_store_dir(&id).join(name)).unwrap();
    }
    std::fs::write(&retained, b"corrupt image").unwrap();
    assert_eq!(
        f.store.served_cover(&id, &signature).unwrap(),
        Served::Unreadable
    );
    std::fs::write(&retained, bytes).unwrap();
    assert_eq!(
        f.store.served_cover(&id, &signature).unwrap(),
        Served::Unreadable
    );
    assert_eq!(listed_cover_signatures(&f)[&id], signature);
}

// Windows sharing semantics allow a deterministic lock without changing ACLs.
#[cfg(windows)]
#[test]
fn locked_retained_cover_is_busy_and_not_remembered() {
    use std::os::windows::fs::OpenOptionsExt;
    for official in [false, true] {
        let f = Fixture::new();
        let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
        let sha = if official {
            official_lunii(&f);
            review1_retained_cover(&f, &id);
            field_value(&f.store, &id, "cover")["sha256"]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            let path = f.root.join("green.png");
            coloured_png(&path, [0, 255, 0]);
            let stage = f.store.stage_cover(&path).unwrap();
            f.mutate(&id, json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]));
            stage["sha256"].as_str().unwrap().to_owned()
        };
        let signature = listed_cover_signatures(&f)[&id].clone();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(f.store.images_root().join(sha))
            .unwrap();
        for _ in 0..2 {
            assert_eq!(f.store.served_cover(&id, &signature).unwrap(), Served::Busy);
        }
        drop(lock);
        ready(f.store.served_cover(&id, &signature).unwrap());
        assert_eq!(listed_cover_signatures(&f)[&id], signature);
    }
}

#[test]
fn forgetting_a_fiche_removes_its_cover_only() {
    let f = Fixture::new();
    let mut a = covered(&f, "a", [255, 0, 0], 1);
    a.observation.identity = None;
    let mut b = covered(&f, "b", [0, 0, 255], 1);
    b.observation.identity = None;
    f.publish(&[a, b]);
    let signatures = listed_cover_signatures(&f);
    let ids: Vec<_> = signatures.keys().cloned().collect();
    for id in &ids {
        ready(f.store.served_cover(id, &signatures[id]).unwrap());
    }
    f.store
        .write(|tx| {
            tx.execute("UPDATE source SET status='removed'", [])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    let card = f.store.get_card(&ids[0]).unwrap();
    execute(&f,json!({"kind":"forgetUnreferencedCards","requestKey":"forget-cover","ficheIds":[ids[0]],"expectedFicheRevisions":{&ids[0]:card["ficheRevision"]}})).unwrap();
    assert!(!f.store.cover_store_dir(&ids[0]).exists());
    assert_eq!(
        stored_files(&f, &ids[1]).len(),
        1,
        "a surviving fiche keeps its cover, even with its source removed"
    );
    // Its signature changed (source removed) but not its content.
    let now = listed_cover_signatures(&f)[&ids[1]].clone();
    assert_ne!(now, signatures[&ids[1]]);
    wipe_exemplar_cache(&f);
    ready(f.store.served_cover(&ids[1], &now).unwrap());
}

#[test]
fn an_offline_supplier_is_never_read_and_keeps_its_stored_image() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let online = listed_cover_signatures(&f)[&id].clone();
    set_health(&f, Some("unavailable"));
    let offline = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(offline, online);
    let report = f.store.prefabricate_covers().unwrap();
    assert_eq!((report.fabricated, report.skipped), (0, 1), "{report:?}");
    assert_eq!(
        f.store.served_cover(&id, &offline).unwrap(),
        Served::Offline
    );
    assert!(stored_files(&f, &id).is_empty());

    set_health(&f, None);
    let made = ready(f.store.served_cover(&id, &online).unwrap());
    set_health(&f, Some("unavailable"));
    // Same content under the offline signature: renamed, nothing read.
    std::fs::remove_file(f.root.join("pack.png")).unwrap();
    wipe_exemplar_cache(&f);
    assert_eq!(ready(f.store.served_cover(&id, &offline).unwrap()), made);
    assert_eq!(stored_files(&f, &id).len(), 1);
    assert_eq!(f.store.prefabricate_covers().unwrap().kept, 1);
}

#[test]
fn prefabrication_yields_to_interactive_requests_and_can_be_cancelled() {
    let f = Fixture::new();
    let items: Vec<_> = (0..3)
        .map(|n| {
            distinct(
                &f,
                covered(&f, &format!("p{n}"), [n as u8 * 80, 0, 0], 1),
                n,
            )
        })
        .collect();
    f.publish(&items);
    let signatures = listed_cover_signatures(&f);
    assert_eq!(signatures.len(), 3);
    let (first, signature) = signatures.iter().next().unwrap();
    std::thread::scope(|scope| {
        let held = f.store.hold_interactive_cover();
        let pass = scope.spawn(|| f.store.prefabricate_covers().unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(signatures.keys().all(|id| stored_files(&f, id).is_empty()));
        // An interactive request is served while the pass waits.
        ready(f.store.served_cover(first, signature).unwrap());
        f.store.cancel_cover_prefabrication();
        let report = pass.join().unwrap();
        assert!(report.cancelled);
        assert_eq!(report.fabricated, 0);
        drop(held);
    });
    let report = f.store.prefabricate_covers().unwrap();
    assert_eq!((report.fabricated, report.kept), (2, 1), "{report:?}");
    for (id, signature) in &signatures {
        assert!(stored_files(&f, id)[0].ends_with(&format!("-{signature}.jpg")));
    }
}

#[test]
fn one_failing_fiche_does_not_stop_the_pass() {
    let f = Fixture::new();
    let items: Vec<_> = (0..2)
        .map(|n| {
            distinct(
                &f,
                covered(&f, &format!("p{n}"), [0, n as u8 * 90, 0], 1),
                n,
            )
        })
        .collect();
    f.publish(&items);
    let ids: Vec<_> = listed_cover_signatures(&f).into_keys().collect();
    // The first fiche of the pass (ordered by id) gets a defined correction
    // whose retained image has disappeared: reading it is an error.
    let broken = ids.iter().min().unwrap().clone();
    let green = f.root.join("green.png");
    coloured_png(&green, [0, 255, 0]);
    let stage = f.store.stage_cover(&green).unwrap();
    f.mutate(
        &broken,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let sha: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT image_sha256 FROM correction WHERE fiche_id=?1 AND field='cover'",
                [&broken],
                |r| r.get(0),
            )
        })
        .unwrap();
    std::fs::remove_file(f.store.images_root().join(sha)).unwrap();
    let report = f.store.prefabricate_covers().unwrap();
    assert_eq!((report.fabricated, report.skipped), (1, 1), "{report:?}");
    let other = ids.iter().find(|id| **id != broken).unwrap();
    assert_eq!(stored_files(&f, other).len(), 1);
    assert!(stored_files(&f, &broken).is_empty());
}

#[test]
fn a_conclusive_failure_is_not_retried_until_the_signature_changes() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let green = f.root.join("green.png");
    coloured_png(&green, [0, 255, 0]);
    let stage = f.store.stage_cover(&green).unwrap();
    f.mutate(
        &id,
        json!([{"field":"cover","state":"defined","coverStagingId":stage["coverStagingId"]}]),
    );
    let sha: String = f
        .store
        .read(|c| {
            c.query_row(
                "SELECT image_sha256 FROM correction WHERE fiche_id=?1 AND field='cover'",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    // The retained correction image is damaged: a local, conclusive failure.
    let retained = f.store.images_root().join(sha);
    let original = std::fs::read(&retained).unwrap();
    std::fs::write(&retained, b"not an image").unwrap();
    let signature = listed_cover_signatures(&f)[&id].clone();
    assert_eq!(
        f.store.served_cover(&id, &signature).unwrap(),
        Served::Unreadable
    );
    // Repaired behind the catalogue's back: the session does not retry.
    std::fs::write(&retained, original).unwrap();
    assert_eq!(
        f.store.served_cover(&id, &signature).unwrap(),
        Served::Unreadable
    );
    let report = f.store.prefabricate_covers().unwrap();
    assert_eq!((report.fabricated, report.skipped), (0, 1), "{report:?}");
    // A new signature is a new attempt.
    f.mutate(&id, json!([{"field":"cover","state":"source"}]));
    let source = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(source, signature);
    ready(f.store.served_cover(&id, &source).unwrap());
}

#[test]
fn a_pending_official_cover_is_left_to_its_download() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    official_lunii(&f);
    let report = f.store.prefabricate_covers().unwrap();
    assert_eq!((report.fabricated, report.skipped), (0, 1), "{report:?}");
    assert_eq!(f.store.lunii_cover_test_requests(), 0, "no download");
    assert!(stored_files(&f, &id).is_empty());
    // Stay neutral without reading the pack or starting a download.
    let pending = listed_cover_signatures(&f)[&id].clone();
    let turns = f.store.hold_cover_fabrications();
    assert_eq!(
        f.store.served_cover(&id, &pending).unwrap(),
        Served::OfficialPending
    );
    drop(turns);
    assert_eq!(
        std::fs::read_dir(f.store.thumbnail_root()).unwrap().count(),
        0
    );
    assert_eq!(f.store.lunii_cover_test_requests(), 0);
    review1_retained_cover(&f, &id);
    let retained = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(pending, retained);
    ready(f.store.served_cover(&id, &retained).unwrap());
    assert_eq!(
        std::fs::read_dir(f.store.thumbnail_root()).unwrap().count(),
        0
    );
}

#[test]
fn official_cover_consent_and_conclusive_failure_control_pack_fallback() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let local = listed_cover_signatures(&f)[&id].clone();
    let pack = ready(f.store.served_cover(&id, &local).unwrap());
    official_lunii(&f);
    let pending = listed_cover_signatures(&f)[&id].clone();
    assert_eq!(
        f.store.served_cover(&id, &pending).unwrap(),
        Served::OfficialPending
    );
    f.store.set_lunii_permission(false).unwrap();
    let no_consent = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(no_consent, pending);
    assert_eq!(ready(f.store.served_cover(&id, &no_consent).unwrap()), pack);
    f.store.set_lunii_permission(true).unwrap();
    f.store.lunii_cover_test_response(b"invalid image".to_vec());
    let key = field_value(&f.store, &id, "cover")["key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(f.store.lunii_cover_bytes(&id, &key).is_err());
    let failed = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(failed, pending);
    assert_eq!(ready(f.store.served_cover(&id, &failed).unwrap()), pack);
}

#[test]
fn official_cover_transport_failure_keeps_the_pack_unread() {
    let _network = crate::support::network::bounded::test_network();
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    official_lunii(&f);
    let pending = listed_cover_signatures(&f)[&id].clone();
    let key = field_value(&f.store, &id, "cover")["key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(f.store.lunii_cover_bytes(&id, &key).is_err());
    assert_eq!(listed_cover_signatures(&f)[&id], pending);
    assert_eq!(
        f.store.served_cover(&id, &pending).unwrap(),
        Served::OfficialPending
    );
    assert_eq!(
        std::fs::read_dir(f.store.thumbnail_root()).unwrap().count(),
        0
    );
}

#[test]
fn inherited_exhausted_official_cover_attempts_fall_back_to_the_pack() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let local = listed_cover_signatures(&f)[&id].clone();
    let pack = ready(f.store.served_cover(&id, &local).unwrap());
    official_lunii(&f);
    let pending = listed_cover_signatures(&f)[&id].clone();
    f.store
        .write(|tx| {
            tx.execute("INSERT INTO lunii_image_attempt VALUES (?1,3)", [&id])
                .map_err(crate::services::catalogue::store::error)?;
            Ok(())
        })
        .unwrap();
    assert!(field_value(&f.store, &id, "cover")["downloadFailed"].is_null());
    let exhausted = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(exhausted, pending);
    assert!(f.store.lunii_thumbnail(&id).unwrap().is_none());
    assert_eq!(ready(f.store.served_cover(&id, &exhausted).unwrap()), pack);
    assert_eq!(f.store.lunii_cover_test_requests(), 0);
}

#[test]
fn three_transport_failures_change_the_signature_and_fall_back_to_the_pack() {
    let _network = crate::support::network::bounded::test_network();
    let mut f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let local = listed_cover_signatures(&f)[&id].clone();
    let pack = ready(f.store.served_cover(&id, &local).unwrap());
    official_lunii(&f);
    let pending = listed_cover_signatures(&f)[&id].clone();
    let key = field_value(&f.store, &id, "cover")["key"]
        .as_str()
        .unwrap()
        .to_owned();
    for attempt in 1..=3 {
        let before = f.store.list_sources().unwrap().catalogue_revision;
        let cover_before = f
            .store
            .read(|c| {
                c.query_row("SELECT cover_revision FROM catalogue", [], |r| {
                    r.get::<_, i64>(0)
                })
            })
            .unwrap();
        assert!(f.store.lunii_cover_bytes(&id, &key).is_err());
        let failures = f
            .store
            .read(|c| {
                c.query_row(
                    "SELECT failures FROM lunii_image_attempt WHERE fiche_id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(failures, attempt);
        let signature = listed_cover_signatures(&f)[&id].clone();
        if attempt < 3 {
            assert_eq!(signature, pending);
            assert_eq!(
                f.store.served_cover(&id, &signature).unwrap(),
                Served::OfficialPending
            );
            assert_eq!(f.store.list_sources().unwrap().catalogue_revision, before);
        } else {
            assert_ne!(signature, pending);
            assert_eq!(ready(f.store.served_cover(&id, &signature).unwrap()), pack);
            assert_eq!(
                f.store.list_sources().unwrap().catalogue_revision,
                before + 1
            );
            let cover_after = f
                .store
                .read(|c| {
                    c.query_row("SELECT cover_revision FROM catalogue", [], |r| {
                        r.get::<_, i64>(0)
                    })
                })
                .unwrap();
            assert_eq!(cover_after, cover_before + 1);
            assert_eq!(f.store.served_cover(&id, &pending).unwrap(), Served::Stale);
        }
        // Reopening the store models a new application launch.
        let placeholder =
            Store::open(&f.root.join("unused-data"), &f.root.join("unused-cache")).unwrap();
        drop(std::mem::replace(&mut f.store, placeholder));
        f.store = Store::open(&f.root.join("data"), &f.root.join("cache")).unwrap();
    }
    let exhausted = listed_cover_signatures(&f)[&id].clone();
    assert_ne!(exhausted, pending);
    assert_eq!(ready(f.store.served_cover(&id, &exhausted).unwrap()), pack);
    assert!(f.store.lunii_thumbnail(&id).unwrap().is_none());
    assert!(f.store.lunii_cover_bytes(&id, &key).is_err());
    assert_eq!(f.store.lunii_cover_test_requests(), 0);
}

#[test]
fn unofficial_cover_with_consent_still_reads_the_pack() {
    let f = Fixture::new();
    f.store.set_lunii_permission(true).unwrap();
    let mut item = covered(&f, "community", [255, 0, 0], 1);
    item.observation.identity = None;
    let id = f.publish(&[item]);
    let signature = listed_cover_signatures(&f)[&id].clone();
    ready(f.store.served_cover(&id, &signature).unwrap());
    assert_eq!(
        std::fs::read_dir(f.store.thumbnail_root()).unwrap().count(),
        1
    );
}

#[test]
fn interactive_requests_beyond_the_fabrication_turns_answer_busy() {
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let signature = listed_cover_signatures(&f)[&id].clone();
    let turns = f.store.hold_cover_fabrications();
    assert_eq!(f.store.served_cover(&id, &signature).unwrap(), Served::Busy);
    drop(turns);
    ready(f.store.served_cover(&id, &signature).unwrap());
}

#[test]
fn timed_out_cover_source_is_busy_and_not_remembered() {
    use crate::services::catalogue::thumbnails::{bounded_source_read, SourceReadFailure};
    let f = Fixture::new();
    let id = f.publish(&[covered(&f, "pack", [255, 0, 0], 1)]);
    let signature = listed_cover_signatures(&f)[&id].clone();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    assert_eq!(
        bounded_source_read(
            f.source.clone(),
            std::time::Duration::from_millis(10),
            move || wait.recv()
        ),
        Err(SourceReadFailure::Busy)
    );
    assert_eq!(f.store.served_cover(&id, &signature).unwrap(), Served::Busy);
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + crate::test_support::timeout();
    loop {
        match f.store.served_cover(&id, &signature).unwrap() {
            Served::Ready(_) => break,
            Served::Busy => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            other => panic!("cover did not recover: {other:?}"),
        }
    }
    assert_eq!(listed_cover_signatures(&f)[&id], signature);
}

/// Serving an already made cover against making it, on a synthetic catalogue
/// or a copy of a real one. `CATALOGUE_COVER_BENCH_FICHES` (default 200);
/// `CATALOGUE_COVER_BENCH_DATA` and `CATALOGUE_COVER_BENCH_CACHE` open a copy
/// of an existing catalogue instead (never the live one: covers are written).
#[test]
#[ignore = "explicit measure: cargo test cover_store_serving_measure -- --ignored --nocapture"]
fn cover_store_serving_measure() {
    use std::time::Instant;
    let copy = std::env::var("CATALOGUE_COVER_BENCH_DATA")
        .ok()
        .zip(std::env::var("CATALOGUE_COVER_BENCH_CACHE").ok());
    let f = Fixture::new();
    let opened;
    let store = match &copy {
        Some((data, cache)) => {
            opened = Store::open(std::path::Path::new(data), std::path::Path::new(cache)).unwrap();
            &opened
        }
        None => {
            let count: u32 = std::env::var("CATALOGUE_COVER_BENCH_FICHES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(200);
            let image = f.root.join("bench.png");
            let mut seed = 7u32;
            image::RgbImage::from_fn(1024, 1024, |_, _| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
            })
            .save(&image)
            .unwrap();
            let items: Vec<_> = (0..count)
                .map(|n| {
                    let mut item =
                        distinct(&f, f.item(&format!("b{n}.mbah"), Some("B"), None, 1), n);
                    item.observation.cover = Some(json!({"kind":"file","path":image}));
                    item
                })
                .collect();
            f.publish(&items);
            &f.store
        }
    };
    let entries: Vec<(String, String)> = store
        .query_entries(100_000, None, true)
        .unwrap()
        .items
        .iter()
        .filter_map(|e| {
            Some((
                e["id"].as_str()?.to_owned(),
                e["coverSignature"].as_str()?.to_owned(),
            ))
        })
        .collect();
    for pass in ["first (made or already stored)", "stored"] {
        let started = Instant::now();
        let mut ready = 0;
        let mut slowest = std::time::Duration::ZERO;
        for (id, signature) in &entries {
            let one = Instant::now();
            if matches!(store.served_cover(id, signature).unwrap(), Served::Ready(_)) {
                ready += 1;
            }
            slowest = slowest.max(one.elapsed());
        }
        let total = started.elapsed();
        eprintln!(
            "{pass}: {} covers ({ready} ready) in {total:?}, mean {:?}, slowest {slowest:?}",
            entries.len(),
            total / entries.len().max(1) as u32
        );
    }
}
