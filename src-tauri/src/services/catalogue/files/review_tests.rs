use super::*;

pub(super) fn reindex(f: &mut Fixture) {
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
    let card = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|card| {
            card["exemplars"].as_array().unwrap().iter().any(|e| {
                e["locator"]["path"] == crate::support::paths::path_for_frontend(&f.source).as_str()
                    && e["state"] == "available"
                    && !e["retired"].as_bool().unwrap_or(false)
            })
        })
        .unwrap();
    f.card = f.store.get_card(card["id"].as_str().unwrap()).unwrap();
    f.exemplar = f.card["exemplars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["path"] == crate::support::paths::path_for_frontend(&f.source).as_str()
                && e["state"] == "available"
        })
        .unwrap()
        .clone();
}
pub(super) fn write_story(f: &Fixture, text: &str) {
    if f.source.is_dir() {
        fs::write(f.source.join("story.json"), text).unwrap();
    } else {
        let temp = f.root.join(format!("rewrite-{}", uuid::Uuid::new_v4()));
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .unwrap();
        crate::services::community_pack_checker::write_metadata_zip(
            &f.source,
            file,
            Some(text),
            None,
            &AtomicBool::new(false),
        )
        .unwrap();
        publish::replace(&temp, &f.source).unwrap();
    }
}

#[test]
fn cross_review_owned_cleanup_rejects_recreated_files_and_partial_directories() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let expected = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        let held = f.root.join("held-owned");
        fs::rename(&f.source, &held).unwrap();
        if directory {
            fs::create_dir(&f.source).unwrap();
            fs::copy(held.join("story.json"), f.source.join("story.json")).unwrap();
        } else {
            fs::copy(&held, &f.source).unwrap();
        }
        let foreign = patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            recovery::remove_owned(&f.source, &expected)
                .unwrap_err()
                .code,
            codes::CATALOG_FILE_RECOVERY_REQUIRED
        );
        assert_eq!(
            patch::snapshot(&f.source, &AtomicBool::new(false)).unwrap(),
            foreign
        );
    }
}

#[test]
fn lunii_missing_cover_displays_the_existing_pack_image() {
    let mut f = official_cover_fixture();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(24, 24)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let temp = f.root.join("with-cover.zip");
    prepare_fixture_zip(
        &f.source,
        &temp,
        &BTreeMap::new(),
        Some(png.get_ref()),
        &AtomicBool::new(false),
    )
    .unwrap();
    publish::replace(&temp, &f.source).unwrap();
    reindex(&mut f);
    let id = f.card["ficheId"].as_str().unwrap();
    assert!(f.store.lunii_thumbnail(id).unwrap().is_none());
    assert_eq!(
        f.store.get_thumbnail(None, Some(id), None).unwrap().state,
        "ready"
    );
}

#[test]
fn lunii_pending_cover_keeps_absent_status_while_the_pack_image_is_displayed() {
    let mut f = official_cover_fixture();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(24, 24)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let temp = f.root.join("pending-with-cover.zip");
    prepare_fixture_zip(
        &f.source,
        &temp,
        &BTreeMap::new(),
        Some(png.get_ref()),
        &AtomicBool::new(false),
    )
    .unwrap();
    publish::replace(&temp, &f.source).unwrap();
    reindex(&mut f);
    let id = f.card["ficheId"].as_str().unwrap();
    let (ready, started) = std::sync::mpsc::channel();
    let (release, finish) = std::sync::mpsc::channel();
    let (changed, retained) = std::sync::mpsc::channel();
    f.store.lunii_cover_test_response(png.into_inner());
    f.store.lunii_cover_test_pause(ready, finish);
    f.store.download_lunii_covers(Arc::new(move |_, _| {
        changed.send(()).unwrap();
    }));
    started
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    // Release the worker even when checking the pending state finds a regression.
    let status = f.store.lunii_thumbnail(id).unwrap().map(|t| t.state);
    let displayed = f.store.get_thumbnail(None, Some(id), None).unwrap().state;
    release.send(()).unwrap();
    retained
        .recv_timeout(crate::test_support::timeout())
        .unwrap();
    assert_eq!(status, Some("absent"));
    assert_eq!(displayed, "ready");
}
