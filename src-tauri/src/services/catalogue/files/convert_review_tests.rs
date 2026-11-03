use super::*;

fn current(f: &mut Fixture, path: PathBuf) {
    f.source = path;
    f.card = f
        .store
        .get_card(f.card["ficheId"].as_str().unwrap())
        .unwrap();
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
fn refresh(f: &Fixture, path: &Path) {
    let source = f.store.list_sources().unwrap().items[0].clone();
    f.store
        .refresh_paths(
            &Root {
                source_id: source.id,
                path: source.native_path,
            },
            &[Change {
                path: path.to_owned(),
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
fn native_fixture() -> Fixture {
    let mut f = Fixture::new(false);
    let native = f
        .source
        .parent()
        .unwrap()
        .join(crate::support::fs_pack_reader::fs_fixtures::DIALECT_PACK_UUID);
    crate::support::fs_pack_reader::fs_fixtures::write_dialect_fixture_pack(&native);
    refresh(&f, &native);
    let id:String=f.store.read(|c|c.query_row("SELECT fiche_id FROM exemplar WHERE retired=0 AND json_extract(anchor_json,'$.path')=?1",[crate::support::paths::path_for_frontend(&native).as_str()],|r|r.get(0))).unwrap();
    f.card = f.store.get_card(&id).unwrap();
    current(&mut f, native);
    f
}

#[test]
fn directory_conversion_bytes_do_not_depend_on_wall_clock() {
    let f = Fixture::new(true);
    let cancel = AtomicBool::new(false);
    let first = f.root.join("first.zip");
    let second = f.root.join("second.zip");
    super::super::convert::prepare(None, &f.source, "studioDirectory", &[], &first, &cancel)
        .unwrap();
    // ZIP timestamps have a two-second resolution. Cross a complete tick so
    // otherwise identical conversions cannot accidentally share the same time.
    std::thread::sleep(Duration::from_millis(2100));
    super::super::convert::prepare(None, &f.source, "studioDirectory", &[], &second, &cancel)
        .unwrap();
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    // Les fichiers étrangers à la racine du dossier ne font pas partie du pack converti.
    assert_eq!(
        patch::inventory(&first, &cancel).unwrap(),
        pack_only(patch::inventory(&f.source, &cancel).unwrap())
    );
}

fn device_zip_fixture(member: bool) -> Fixture {
    use std::io::Write;
    fn append(zip: &mut zip::ZipWriter<std::fs::File>, dir: &Path, prefix: &str) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
                    .unwrap();
                append(zip, &entry.path(), &format!("{name}/"));
            } else {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(&fs::read(entry.path()).unwrap()).unwrap();
            }
        }
    }
    let mut f = native_fixture();
    let path = f.source.with_extension("zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let prefix = if member {
        format!("{}/", f.source.file_name().unwrap().to_string_lossy())
    } else {
        String::new()
    };
    append(&mut writer, &f.source, &prefix);
    writer.finish().unwrap();
    refresh(&f, &path);
    let card_id:String=f.store.read(|c|c.query_row("SELECT fiche_id FROM exemplar WHERE retired=0 AND json_extract(anchor_json,'$.path')=?1",[crate::support::paths::path_for_frontend(&path).as_str()],|r|r.get(0))).unwrap();
    f.card = f.store.get_card(&card_id).unwrap();
    current(&mut f, path);
    f
}

#[test]
fn device_zip_duplicate_search_has_no_hash_failure() {
    for member in [false, true] {
        let f = device_zip_fixture(member);
        let receipt = f
            .store
            .find_duplicates(
                super::super::duplicates::Scope { fiche_id: None },
                "device-duplicate-search".into(),
                Arc::new(|_, _| {}),
            )
            .unwrap();
        let progress = f.wait(receipt["operationId"].as_str().unwrap());
        assert_eq!(progress.status, "success", "{:?}", progress.error);
        let page = f
            .store
            .duplicate_results(receipt["operationId"].as_str().unwrap(), 0, 100)
            .unwrap();
        assert_eq!(page["issues"], json!([]));
    }
}

#[test]
fn device_zip_trash_plan_accepts_direct_pack_and_single_member_container() {
    for member in [false, true] {
        let f = device_zip_fixture(member);
        let before = fs::read(&f.source).unwrap();
        let plan = f.store.plan_file_operation(
            "trash".into(),
            vec![TargetRequest {
                fiche_id: f.card["ficheId"].as_str().unwrap().into(),
                exemplar_id: f.exemplar["id"].as_str().unwrap().into(),
                expected_revision: f.store.list_sources().unwrap().catalogue_revision,
            }],
            serde_json::from_value(json!({"mode":"replace"})).unwrap(),
        );
        // Deliberate QZb relaxation: a sole direct pack targets its entire archive.
        let plan = plan.unwrap();
        assert_eq!(
            plan.targets[0].source_format,
            if member { "zip" } else { "fsZip" }
        );
        assert_eq!(
            plan.targets[0].source_path,
            crate::support::paths::path_for_frontend(&f.source)
        );
        assert_eq!(plan.targets[0].capability.state, "available");
        assert_eq!(fs::read(&f.source).unwrap(), before);
    }
}

#[test]
fn device_zip_checker_owns_conversion_and_preserves_source() {
    use crate::services::catalogue::open::editor_extractions;
    for member in [false, true] {
        let f = device_zip_fixture(member);
        let before = fs::read(&f.source).unwrap();
        let registry = Arc::new(editor_extractions::Registry::new(f.root.join("checker")));
        let entry = f
            .store
            .prepare_checker_entry(
                &registry,
                f.exemplar["id"].as_str().unwrap(),
                f.store.list_sources().unwrap().catalogue_revision,
            )
            .unwrap();
        assert!(entry.temporary);
        assert!(patch::read_story(Path::new(&entry.zip_path)).is_ok());
        registry.release(&entry.preparation_id).unwrap();
        assert!(!Path::new(&entry.zip_path).exists());
        assert_eq!(fs::read(&f.source).unwrap(), before);
    }
}

#[test]
fn official_catalogue_conversion_and_assembly_intermediate_preserve_identity() {
    for directory in [false, true] {
        let f = Fixture::new(directory);
        let cancel = AtomicBool::new(false);
        let before = patch::snapshot(&f.source, &cancel).unwrap();
        let source: Value =
            serde_json::from_slice(&patch::story_bytes(&f.source).unwrap()).unwrap();
        let uuid = crate::native_pack::pack_identity_from_story(&source).unwrap();
        // Synthetic fixture identity declared official only in this isolated catalogue.
        f.store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO lunii_pack(uuid,document_json) VALUES (?1,'{}')",
                    [&uuid],
                )
                .map_err(crate::services::catalogue::store::error)?;
                Ok(())
            })
            .unwrap();
        let format = if directory { "studioDirectory" } else { "zip" };
        for assembly in [false, true] {
            let output = f.root.join(format!("official-{assembly}.zip"));
            if assembly {
                super::super::assembly_convert(&f.store, &f.source, format, &[], &output, &cancel)
                    .unwrap();
            } else {
                super::super::convert::prepare(
                    Some(&*f.store),
                    &f.source,
                    format,
                    &[],
                    &output,
                    &cancel,
                )
                .unwrap();
            }
            let story: Value =
                serde_json::from_slice(&patch::story_bytes(&output).unwrap()).unwrap();
            assert_eq!(story["uuid"], uuid);
            assert_eq!(story["official"], true);
            assert_eq!(
                crate::native_pack::pack_identity_from_story(&story).unwrap(),
                uuid
            );
        }
        assert!(recovery::matches(&f.source, &before));
    }
}
