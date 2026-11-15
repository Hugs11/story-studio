//! Optional private corpus probe; no corpus paths or expected content are versioned.
use super::*;
use serde_json::Value;

#[test]
fn recipe_external_archives_keep_legacy_projection() {
    let Ok(manifest) = std::env::var("RECIPE_ARCHIVES") else {
        return;
    };
    let archives: Vec<Value> = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    assert_eq!(archives.len(), 48);
    let baseline: Vec<Value> = serde_json::from_slice(
        &fs::read(std::env::var("RECIPE_ARCHIVES_BASELINE").unwrap()).unwrap(),
    )
    .unwrap();
    let mut third_party = 0;
    let mut legacy = 0;
    let mut legacy_menus = 0;
    for pack in archives {
        let source = pack["path"].as_str().unwrap();
        let previous = baseline
            .iter()
            .find(|b| b["name"] == pack["name"] && b["source"] == pack["source"])
            .unwrap();
        let imported = match ensure_studio_pack_zip(source) {
            Ok(p) => p,
            Err(error) => {
                let expected: Value =
                    serde_json::from_str(previous["error"].as_str().unwrap()).unwrap();
                let actual: Value = serde_json::from_str(&error).unwrap();
                assert_eq!(actual["code"], expected["code"]);
                assert!(classify_pack_editability(source).is_err());
                third_party += 1;
                continue;
            }
        };
        let story = read_story_json_from_zip(&imported.zip_path).unwrap();
        let decoded = match decode_imported_pack(&imported, &story) {
            Ok(d) => d,
            Err(_) => {
                assert!(
                    !classify_pack_editability(source)
                        .unwrap()
                        .authoring_editable
                );
                third_party += 1;
                continue;
            }
        };
        assert!(super::super::recipe::resolve(&imported.zip_path, &decoded.source_value).is_none());
        let verdict = classify_pack_editability(source).unwrap();
        let dest = std::env::temp_dir().join(format!("recipe-baseline-{}", uuid::Uuid::new_v4()));
        let actual = unpack_zip_to_entries_unchecked(source, dest.to_str().unwrap()).unwrap();
        // The lot B projection is unchanged. Compare its complete output with
        // the production wrapper, using the exact extracted media paths.
        let assets: HashMap<_, _> = presence_faithful_asset_map(&decoded.source_value)
            .into_keys()
            .map(|name| {
                let path = dest.join(&name);
                (name, path)
            })
            .collect();
        let expected = walk_story_doc_to_entries(&decoded.source_value, &assets).unwrap();
        for (key, value) in expected.as_object().unwrap() {
            assert_eq!(
                &actual[key], value,
                "legacy projection {} / {key}",
                pack["name"]
            );
        }
        fs::remove_dir_all(&dest).unwrap();
        if pack["source"] == "0.9.11" {
            legacy += 1;
            legacy_menus += usize::from(verdict.authoring_editable);
        } else {
            let previous = baseline
                .iter()
                .find(|b| b["name"] == pack["name"] && b["source"] == pack["source"])
                .unwrap();
            assert_eq!(
                verdict.authoring_editable,
                previous["menus"].as_bool().unwrap(),
                "third-party verdict {}",
                pack["name"]
            );
            assert_eq!(
                verdict.round_trip_faithful,
                previous["faithful"].as_bool().unwrap(),
                "third-party fidelity {}",
                pack["name"]
            );
            third_party += 1;
        }
    }
    assert_eq!((third_party, legacy), (31, 17));
    assert_eq!(legacy_menus, 15);
    eprintln!("no-recipe archives: {third_party}/31 third-party verdicts unchanged; {legacy}/17 legacy projections unchanged ({legacy_menus} menus)");
}
