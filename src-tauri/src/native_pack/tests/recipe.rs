use super::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
// Independent test prototype: two inverse maps for BOTH kinds, all option edges,
// including options not selected by a fixed transition; no name/array-order oracle.
fn pair(a: &Value, b: &Value) -> Result<(usize, usize), String> {
    if a["nightModeAvailable"] != b["nightModeAvailable"] {
        return Err("night flag".into());
    }
    let mut queue = VecDeque::new();
    let entry = |d: &Value| {
        d["stageNodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["squareOne"] == true)
            .unwrap()["uuid"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    queue.push_back((false, entry(a), entry(b)));
    let mut forward = BTreeMap::new();
    let mut reverse = BTreeMap::new();
    while let Some((action, left, right)) = queue.pop_front() {
        let lk = (action, left.clone());
        let rk = (action, right.clone());
        if let Some(previous) = forward.get(&lk) {
            if previous != &rk {
                return Err("forward contradiction".into());
            }
            continue;
        }
        if reverse.contains_key(&rk) {
            return Err("reverse contradiction".into());
        }
        forward.insert(lk.clone(), rk.clone());
        reverse.insert(rk, lk);
        let (array, id) = if action {
            ("actionNodes", "id")
        } else {
            ("stageNodes", "uuid")
        };
        let lookup = |d: &Value, key: &str| {
            d[array]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n[id] == key)
                .cloned()
        };
        let x = lookup(a, &left).ok_or("missing left")?;
        let y = lookup(b, &right).ok_or("missing right")?;
        if action {
            let xo = x["options"].as_array().ok_or("options left")?;
            let yo = y["options"].as_array().ok_or("options right")?;
            if xo.len() != yo.len() {
                return Err("option count".into());
            }
            for (u, v) in xo.iter().zip(yo) {
                queue.push_back((
                    false,
                    u.as_str().ok_or("option left")?.into(),
                    v.as_str().ok_or("option right")?.into(),
                ));
            }
        } else {
            for field in ["controlSettings", "squareOne", "type", "audio", "image"] {
                if x[field] != y[field] {
                    return Err(format!("stage {field}"));
                }
            }
            for field in ["okTransition", "homeTransition"] {
                if x[field].is_object() != y[field].is_object() {
                    return Err(format!("presence {field}"));
                }
                if x[field].is_object() {
                    if x[field]["optionIndex"] != y[field]["optionIndex"] {
                        return Err("selection index".into());
                    }
                    queue.push_back((
                        true,
                        x[field]["actionNode"].as_str().unwrap().into(),
                        y[field]["actionNode"].as_str().unwrap().into(),
                    ));
                }
            }
        }
    }
    let ns = forward.keys().filter(|(action, _)| !action).count();
    let na = forward.len() - ns;
    if [a, b].iter().any(|d| {
        d["stageNodes"].as_array().unwrap().len() != ns
            || d["actionNodes"].as_array().unwrap().len() != na
    }) {
        return Err(format!(
            "unreachable: visited {ns}/{} stages, {na}/{} actions",
            a["stageNodes"].as_array().unwrap().len(),
            a["actionNodes"].as_array().unwrap().len()
        ));
    }
    Ok((ns, na))
}

fn permute(d: &mut Value, seed: usize) {
    let mut ids = BTreeMap::new();
    for (array, key) in [("stageNodes", "uuid"), ("actionNodes", "id")] {
        for n in d[array].as_array().unwrap() {
            ids.insert(
                n[key].as_str().unwrap().to_owned(),
                uuid::Uuid::new_v4().to_string(),
            );
        }
    }
    for s in d["stageNodes"].as_array_mut().unwrap() {
        s["uuid"] = json!(ids[s["uuid"].as_str().unwrap()]);
        for field in ["okTransition", "homeTransition"] {
            if s[field].is_object() {
                s[field]["actionNode"] = json!(ids[s[field]["actionNode"].as_str().unwrap()]);
            }
        }
    }
    for n in d["actionNodes"].as_array_mut().unwrap() {
        n["id"] = json!(ids[n["id"].as_str().unwrap()]);
        for o in n["options"].as_array_mut().unwrap() {
            *o = json!(ids[o.as_str().unwrap()]);
        }
    }
    for array in ["stageNodes", "actionNodes"] {
        let v = d[array].as_array_mut().unwrap();
        let len = v.len();
        v.rotate_left(seed % len);
        if seed.is_multiple_of(2) {
            v.reverse();
        }
    }
}

#[test]
fn recipe_pairing_rejects_mutations() {
    let d = build(&cases()[0]["dto"]);
    assert!(pair(&d, &d).is_ok());
    let mut changed = d.clone();
    changed["nightModeAvailable"] = json!(!d["nightModeAvailable"].as_bool().unwrap());
    assert!(pair(&d, &changed).is_err());
    let mut changed = d.clone();
    changed["stageNodes"][0]["controlSettings"]["ok"] = json!(!d["stageNodes"][0]
        ["controlSettings"]["ok"]
        .as_bool()
        .unwrap());
    assert!(pair(&d, &changed).is_err());
    let mut changed = d.clone();
    changed["actionNodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|a| a["options"].as_array().unwrap().len() > 1)
        .unwrap()["options"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert!(pair(&d, &changed).is_err());
    let mut changed = d.clone();
    let orphan = changed["actionNodes"][0].clone();
    changed["actionNodes"].as_array_mut().unwrap().push(orphan);
    assert!(pair(&d, &changed).is_err());
}

#[test]
fn recipe_pairing_sees_two_swapped_roles() {
    // A reconstruction that swaps the play and title sounds of a story keeps the
    // same structure and sharing pattern: only path-derived media names reveal it.
    use super::super::recipe::{adapt, reconstruct};
    let original = source(&cases()[0]["dto"]);
    let reference = build(&cases()[0]["dto"]);
    let recipe = adapt(&original, &canonicalize_project(&original)).unwrap();
    let mut roles = role_media(&original, &recipe);
    let mut faithful = reconstruct(&recipe, |r| roles.get(r).cloned()).unwrap();
    faithful.thumbnail_image = original.thumbnail_image.clone();
    let fresh = serde_json::to_value(build_story_document(&report(&faithful)).unwrap()).unwrap();
    assert!(pair(&reference, &fresh).is_ok());
    let play = roles.remove("entry/0/audio").unwrap();
    let title = roles.insert("entry/0/titleAudio".into(), play).unwrap();
    roles.insert("entry/0/audio".into(), title);
    let mut swapped = reconstruct(&recipe, |r| roles.get(r).cloned()).unwrap();
    swapped.thumbnail_image = original.thumbnail_image.clone();
    let fresh = serde_json::to_value(build_story_document(&report(&swapped)).unwrap()).unwrap();
    assert_eq!(pair(&reference, &fresh), Err("stage audio".into()));
}

#[test]
fn recipe_pairing_random_selection() {
    // Menu generation emits only fixed selections (builder/transitions.rs).
    // A random selection is nevertheless a real imported pack shape.
    let mut random = build(&cases()[0]["dto"]);
    let entry = random["stageNodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["squareOne"] == true)
        .unwrap();
    entry["okTransition"]["optionIndex"] = json!(-1);
    let mut fresh = random.clone();
    permute(&mut fresh, 7);
    assert!(pair(&random, &fresh).is_ok());
    fresh["stageNodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["squareOne"] == true)
        .unwrap()["okTransition"]["optionIndex"] = json!(0);
    assert!(pair(&random, &fresh).is_err());
}

fn cases() -> Vec<Value> {
    static CASES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    CASES
        .get_or_init(|| {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"));
            let output = std::process::Command::new("node")
                .arg(root.join("../scripts/recipeRoundtripCases.mjs"))
                .output()
                .expect("node case generator");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice(&fs::read(root.join("target/recipe/cases.json")).unwrap())
                .unwrap()
        })
        .clone()
}
fn source(dto: &Value) -> Project {
    serde_json::from_value(dto.clone()).unwrap()
}
fn report(project: &Project) -> NativeAssetPreparationReport {
    let canonical = canonicalize_project(project);
    // The prepared name derives from the source path, not from the order of first
    // appearance: a media moved to another role changes the stage, and the pairing sees
    // it. Sharing (global prompts, combined title/play) keeps one name.
    let assets = collect_asset_requests(&canonical, 0.0, 0.0)
        .into_iter()
        .map(|request| {
            let stem: String = request
                .source_path
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            let ext = match request.source_kind {
                AssetSourceKind::Image => "bmp",
                _ => "mp3",
            };
            prepared_asset(&request.role, &format!("{stem}.{ext}"))
        })
        .collect();
    report_for(canonical, assets, vec![])
}
fn build(dto: &Value) -> Value {
    serde_json::to_value(build_story_document(&report(&source(dto))).unwrap()).unwrap()
}
fn role_media(
    project: &Project,
    recipe: &super::super::recipe::Recipe,
) -> BTreeMap<String, String> {
    use super::super::recipe::Entry;
    let mut map = BTreeMap::new();
    fn add(map: &mut BTreeMap<String, String>, role: String, media: &Option<String>) {
        if let Some(media) = media {
            map.insert(role, media.clone());
        }
    }
    fn entries(map: &mut BTreeMap<String, String>, raw: &[ProjectEntry], recipes: &[Entry]) {
        for (s, r) in raw.iter().zip(recipes) {
            let id = match r {
                Entry::Menu(m) => m.id,
                Entry::Story(s) => s.id,
            };
            let p = format!("entry/{id}");
            add(map, format!("{p}/audio"), &s.audio);
            match r {
                Entry::Menu(m) => {
                    add(map, format!("{p}/image"), &s.image);
                    entries(map, &s.children, &m.children);
                }
                Entry::Story(r) => {
                    add(map, format!("{p}/titleAudio"), &s.item_audio);
                    add(map, format!("{p}/titleImage"), &s.item_image);
                    add(
                        map,
                        format!("{p}/promptAudio"),
                        &s.after_playback_prompt_audio,
                    );
                    for (step, r) in s.after_playback_sequence.iter().zip(&r.sequence) {
                        add(map, format!("{p}/sequence/{}/audio", r.id), &step.audio);
                        add(map, format!("{p}/sequence/{}/image", r.id), &step.image);
                    }
                    if let Some(step) = &s.after_playback_home_step {
                        add(map, format!("{p}/homeStep/audio"), &step.audio);
                        add(map, format!("{p}/homeStep/image"), &step.image);
                    }
                }
            }
        }
    }
    add(&mut map, "rootAudio".into(), &project.root_audio);
    add(&mut map, "rootImage".into(), &project.root_image);
    add(&mut map, "nightModeAudio".into(), &project.night_mode_audio);
    entries(&mut map, &project.root_entries, &recipe.entries);
    map
}
fn colours(entries: &[ProjectEntry]) -> Vec<(String, Option<String>)> {
    entries
        .iter()
        .flat_map(|e| {
            std::iter::once((e.name.clone(), e.tree_color.clone())).chain(colours(&e.children))
        })
        .collect()
}
fn zip_bytes(path: &Path, entry: &str) -> Vec<u8> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut bytes = vec![];
    zip.by_name(entry).unwrap().read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn recipe_roundtrip_matrix_and_unchanged_story_bytes() {
    use super::super::recipe::{adapt, reconstruct, Recipe, FILE_NAME};
    let cases = cases();
    assert_eq!(cases.len(), 1440);
    let dir = TestDir::new();
    let media_file = dir.path().join("media");
    fs::write(&media_file, b"prepared test bytes").unwrap();
    let thumbnail = dir.path().join("thumbnail.png");
    write_test_png(&thumbnail);
    let mut passed = 0;
    let mut refused = vec![];
    let mut failures = vec![];
    let mut largest = (0, String::new());
    let mut global_prompts = 0;
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let original = source(&case["dto"]);
        let original_report = report(&original);
        let reference = match build_story_document(&original_report) {
            Ok(d) => d,
            Err(e) => {
                refused.push((name.to_owned(), e));
                continue;
            }
        };
        let result = (|| -> Result<(), String> {
            let recipe =
                adapt(&original, &original_report.project).map_err(|e| format!("adapt: {e:?}"))?;
            let bytes = serde_json::to_vec(&recipe).unwrap();
            if bytes.len() > largest.0 {
                largest = (bytes.len(), name.into());
            }
            if String::from_utf8_lossy(&bytes).contains(r#""promptAudio":"global""#) {
                global_prompts += 1;
            }
            let recipe: Recipe = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let roles = role_media(&original, &recipe);
            let mut rebuilt = reconstruct(&recipe, |r| roles.get(r).cloned())
                .map_err(|e| format!("reconstruct: {e:?}"))?;
            // Author intent absent from story.json (S2, S3, tree colours).
            if (
                &rebuilt.root_name,
                &rebuilt.end_node_name,
                &rebuilt.tree_color,
                rebuilt.global_options.end_node,
            ) != (
                &original.root_name,
                &original.end_node_name,
                &original.tree_color,
                original.global_options.end_node,
            ) || colours(&rebuilt.root_entries) != colours(&original.root_entries)
            {
                return Err("author names, colours or end node lost".into());
            }
            // Pack metadata comes from the pack, never from the recipe.
            rebuilt.name = original.name.clone();
            rebuilt.pack_uuid = original.pack_uuid.clone();
            rebuilt.thumbnail_image = original.thumbnail_image.clone();
            crate::domain::validation::validate_project_structure_for_generation(&rebuilt)
                .map_err(|e| format!("validation: {e}"))?;
            let mut physical_project = reconstruct(&recipe, |r| {
                roles
                    .get(r)
                    .map(|_| media_file.to_string_lossy().into_owned())
            })
            .map_err(|e| format!("validation media: {e:?}"))?;
            physical_project.pack_uuid = original.pack_uuid.clone();
            physical_project.thumbnail_image = Some(thumbnail.to_string_lossy().into());
            crate::domain::validation::validate_project_for_generation(&physical_project)
                .map_err(|e| format!("disk validation: {e}"))?;
            let rebuilt_report = report(&rebuilt);
            let fresh = build_story_document(&rebuilt_report)?;
            let mut fresh = serde_json::to_value(fresh).unwrap();
            permute(&mut fresh, passed);
            pair(&serde_json::to_value(&reference).unwrap(), &fresh)?;
            // Same document with fixed UUIDs enters both writers: only the sidecar changes.
            let mut physical = original_report;
            physical.project.thumbnail_image = Some(thumbnail.to_string_lossy().into());
            for a in &mut physical.assets {
                a.staged_asset_path = media_file.to_string_lossy().into();
            }
            let story = super::super::writer::serialize_story_with_pack_uuid(
                &reference,
                &physical.pack_uuid,
            )?;
            let identity = super::super::output_identity::for_story(
                &serde_json::from_str(&story).unwrap(),
                super::super::output_identity::OutputForm::Rewritten,
                None,
            )
            .map_err(|e| format!("{e:?}"))?;
            let without = super::super::writer::write_native_pack_archive_authorized(
                &physical,
                &reference,
                &dir.path().join("without"),
                &identity,
            )?;
            let with = super::super::writer::write_native_pack_archive_with_recipe(
                &physical,
                &reference,
                &dir.path().join("with"),
                &identity,
                Some(bytes.clone()),
            )?;
            assert_eq!(
                zip_bytes(&without.zip_path, "story.json"),
                zip_bytes(&with.zip_path, "story.json")
            );
            assert_eq!(zip_bytes(&with.zip_path, FILE_NAME), bytes);
            fs::remove_file(without.zip_path).unwrap();
            fs::remove_file(with.zip_path).unwrap();
            Ok(())
        })();
        match result {
            Ok(()) => passed += 1,
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    eprintln!(
        "recipe roundtrip {passed}/1420; {global_prompts} with a global prompt (S1); {} original builder refusals; largest {} bytes ({})",
        refused.len(),
        largest.0,
        largest.1
    );
    for (name, cause) in &refused {
        eprintln!("original refusal {name}: {cause}");
    }
    assert_eq!(refused.len(), 20);
    assert!(refused.iter().all(
        |(n, e)| n.starts_with("simple/") && e.contains("VALIDATION_STAGE_PLAY_TARGET_MISSING")
    ));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(passed, 1420);
    // The attach-to-global gesture (lAttach with an emitted global sound) is exercised.
    assert!(global_prompts > 0);
}

// Archives réelles rouvertes par les points d’entrée publics de production.
fn archive_for_reopening(p: &Project, dir: &Path) -> (std::path::PathBuf, Value) {
    let mut prepared = report(p);
    let document = build_story_document(&prepared).unwrap();
    let media = dir.join("media");
    fs::write(&media, b"prepared test bytes").unwrap();
    let thumbnail = dir.join("thumbnail.png");
    write_test_png(&thumbnail);
    prepared.project.thumbnail_image = Some(thumbnail.to_string_lossy().into());
    for a in &mut prepared.assets {
        a.staged_asset_path = media.to_string_lossy().into();
    }
    let story =
        super::super::writer::serialize_story_with_pack_uuid(&document, &prepared.pack_uuid)
            .unwrap();
    let identity = super::super::output_identity::for_story(
        &serde_json::from_str(&story).unwrap(),
        super::super::output_identity::OutputForm::Rewritten,
        None,
    )
    .unwrap();
    let recipe = super::super::recipe::adapt(p, &prepared.project).unwrap();
    let archive = super::super::writer::write_native_pack_archive_with_recipe(
        &prepared,
        &document,
        &dir.join("out"),
        &identity,
        Some(serde_json::to_vec(&recipe).unwrap()),
    )
    .unwrap();
    (archive.zip_path, serde_json::to_value(document).unwrap())
}

fn reopen_for_test(zip: &Path, dir: &Path) -> (Value, Project) {
    let verdict =
        crate::services::pack_reader::classify_pack_editability(zip.to_str().unwrap()).unwrap();
    assert!(verdict.authoring_editable, "{verdict:?}");
    assert!(verdict.round_trip_faithful);
    assert!(!verdict.has_native_graph);
    let value = crate::services::pack_reader::unpack_zip_to_entries(
        zip.to_str().unwrap(),
        dir.to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(value["recipeReopened"], true);
    assert_eq!(
        serde_json::to_value(&verdict).unwrap()["projectType"],
        value["projectType"]
    );
    assert!(value["nativeGraph"].is_null());
    let mut dto = value.clone();
    dto["rootEntries"] = dto["entries"].take();
    dto["name"] = dto["title"].clone();
    dto["packUuid"] = dto["uuid"].clone();
    (value, source(&dto))
}

#[test]
fn recipe_production_js_entry_types() {
    let dir = TestDir::new();
    let audio = dir.path().join("sound.wav");
    fs::write(&audio, reopening_wav(440.0)).unwrap();
    let image = dir.path().join("cover.png");
    write_test_png(&image);
    let mut results = vec![];
    for kind in ["simple", "pack"] {
        let mut dto = json!({
            "name": "Recipe JS types", "projectType": kind,
            "packUuid": "11111111-2222-4333-8444-555566667777",
            "rootAudio": audio, "rootImage": image,
            "globalOptions": {"autoNext": false, "nightMode": false,
                "silenceMode": "off", "harmonizeLoudness": false},
            "rootEntries": [{"id": "s", "type": "story", "name": "Story", "audio": audio}]
        });
        if kind == "pack" {
            dto["rootEntries"].as_array_mut().unwrap().push(json!({
                "id": "m", "type": "menu", "name": "Folder", "audio": audio, "image": image,
                "children": [{"id": "nested", "type": "story", "name": "Nested", "audio": audio}]
            }));
        }
        let generated = generate_native_pack_v1_with_cancel(
            &source(&dto),
            dir.path().join(kind).to_str().unwrap(),
            &|_| {},
            &|| false,
        )
        .unwrap();
        let (value, _) = reopen_for_test(
            Path::new(&generated.zip_path),
            &dir.path().join(format!("open-{kind}")),
        );
        assert_eq!(value["entries"][0]["type"], "story");
        assert!(value["entries"][0].get("children").is_none());
        if kind == "pack" {
            assert_eq!(value["entries"][1]["type"], "menu");
            let child = &value["entries"][1]["children"][0];
            assert_eq!(child["type"], "story");
            assert!(child.get("children").is_none());
        }
        results.push(value);
    }
    if let Some(path) = std::env::var_os("STORY_STUDIO_RECIPE_JS_OUTPUT") {
        fs::write(path, serde_json::to_vec(&results).unwrap()).unwrap();
    }
}

fn compare_reopened(original: &Project, reopened: &Project, reference: &Value) {
    use super::super::recipe::{adapt, reconstruct};
    let recipe = adapt(original, &canonicalize_project(original)).unwrap();
    let original_roles = role_media(original, &recipe);
    let reopened_roles = role_media(reopened, &recipe);
    // Source-derived names are an independent media association oracle (LC R1).
    for (role, actual) in &reopened_roles {
        let expected = &original_roles[role];
        let stem: String = expected
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let actual = Path::new(actual).file_stem().unwrap().to_str().unwrap();
        assert_eq!(actual, stem, "media role {role}");
    }
    let intended = reconstruct(&recipe, |r| original_roles.get(r).cloned()).unwrap();
    let mut expected = serde_json::to_value(intended).unwrap();
    let mut actual = serde_json::to_value(reopened).unwrap();
    fn strip(v: &mut Value) {
        if let Some(o) = v.as_object_mut() {
            for (key, val) in o {
                if matches!(
                    key.as_str(),
                    "audio"
                        | "image"
                        | "itemAudio"
                        | "itemImage"
                        | "afterPlaybackPromptAudio"
                        | "rootAudio"
                        | "rootImage"
                        | "nightModeAudio"
                        | "thumbnailImage"
                        | "packUuid"
                        | "packVersion"
                        | "packDescription"
                        | "name"
                ) {
                    // Names of entries ARE author intent; only strip the pack name below.
                    if key != "name" {
                        *val = Value::Null;
                    }
                } else {
                    strip(val);
                }
            }
        } else if let Some(a) = v.as_array_mut() {
            a.iter_mut().for_each(strip);
        }
    }
    expected["name"] = Value::Null;
    actual["name"] = Value::Null;
    strip(&mut expected);
    strip(&mut actual);
    assert_eq!(actual, expected, "tree and author settings");
    // Build with the exact extracted basenames; the independent pairing compares media too.
    let canonical = canonicalize_project(reopened);
    let assets = collect_asset_requests(&canonical, 0.0, 0.0)
        .into_iter()
        .map(|r| {
            prepared_asset(
                &r.role,
                Path::new(&r.source_path)
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            )
        })
        .collect();
    let fresh =
        serde_json::to_value(build_story_document(&report_for(canonical, assets, vec![])).unwrap())
            .unwrap();
    pair(reference, &fresh).unwrap();
}

#[test]
fn recipe_production_reopening_matrix() {
    let mut reopened = 0;
    let mut failures = vec![];
    for case in cases() {
        let p = source(&case["dto"]);
        if build_story_document(&report(&p)).is_err() {
            continue;
        }
        let dir = TestDir::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (zip, reference) = archive_for_reopening(&p, dir.path());
            let (_, project) = reopen_for_test(&zip, &dir.path().join("extracted"));
            compare_reopened(&p, &project, &reference);
            fs::remove_file(zip).unwrap();
            fs::remove_dir_all(dir.path().join("extracted")).unwrap();
        }));
        if outcome.is_ok() {
            reopened += 1;
        } else {
            failures.push(case["name"].clone());
        }
    }
    eprintln!("production recipe reopening: {reopened}/1420; failures: {failures:?}");
    assert_eq!(reopened, 1420);
}

fn edited_archive(
    original: &Path,
    output: &Path,
    edit: impl FnOnce(&mut BTreeMap<String, Vec<u8>>),
) {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(fs::File::open(original).unwrap()).unwrap();
    let mut files = BTreeMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        let mut bytes = vec![];
        entry.read_to_end(&mut bytes).unwrap();
        files.insert(entry.name().to_owned(), bytes);
    }
    edit(&mut files);
    let mut writer = zip::ZipWriter::new(fs::File::create(output).unwrap());
    for (name, bytes) in files {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn recipe_production_reopens_simple_story_name_from_pack() {
    let dir = TestDir::new();
    let p = cases()
        .iter()
        .map(|case| source(&case["dto"]))
        .find(|p| p.project_type.as_deref() == Some("simple"))
        .unwrap();
    let (zip, _) = archive_for_reopening(&p, dir.path());
    let changed = dir.path().join("simple-name.zip");
    edited_archive(&zip, &changed, |files| {
        let mut doc: Value = serde_json::from_slice(&files["story.json"]).unwrap();
        let stage = doc["stageNodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["name"] == "histoire")
            .unwrap();
        stage["name"] = json!("Histoire retouchée");
        files.insert("story.json".into(), serde_json::to_vec(&doc).unwrap());
    });
    let (_, reopened) = reopen_for_test(&changed, &dir.path().join("simple-name"));
    assert_eq!(reopened.root_entries[0].name, "Histoire retouchée");
}

#[test]
fn recipe_production_reopens_renamed_screens_from_pack() {
    let dir = TestDir::new();
    let p = cases()
        .iter()
        .map(|case| source(&case["dto"]))
        .find(|p| {
            p.root_entries[0].entry_type == "menu"
                && p.root_entries[0]
                    .children
                    .first()
                    .is_some_and(|s| !s.after_playback_sequence.is_empty())
        })
        .unwrap();
    let menu = &p.root_entries[0];
    let story = &menu.children[0];
    let (zip, _) = archive_for_reopening(&p, dir.path());
    for (index, (screen, replacement, expected)) in [
        (menu.name.clone(), "Dossier retouché", "Dossier retouché"),
        (
            format!("Histoire - {}", story.name),
            "Histoire - Le loup",
            "Le loup",
        ),
        (
            format!("Titre - {}", story.name),
            "Un titre retouché",
            "Un titre retouché",
        ),
        (
            story.after_playback_sequence[0].name.clone(),
            "Étape retouchée",
            "Étape retouchée",
        ),
        (
            story
                .after_playback_home_step
                .as_ref()
                .unwrap()
                .name
                .clone(),
            "Accueil retouché",
            "Accueil retouché",
        ),
        (
            format!("Histoire - {}", story.name),
            "Histoire - ",
            story.name.as_str(),
        ),
        (
            format!("Histoire - {}", story.name),
            "Histoire - Le/loup\u{0007}",
            "Le/loup\u{0007}",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let changed = dir.path().join(format!("name-{index}.zip"));
        edited_archive(&zip, &changed, |files| {
            let mut doc: Value = serde_json::from_slice(&files["story.json"]).unwrap();
            let stage = doc["stageNodes"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|s| s["name"] == screen)
                .unwrap();
            stage["name"] = json!(replacement);
            // Names must follow structural pairing, never array order or UUIDs.
            permute(&mut doc, 7);
            files.insert("story.json".into(), serde_json::to_vec(&doc).unwrap());
        });
        let (value, reopened) =
            reopen_for_test(&changed, &dir.path().join(format!("names-{index}")));
        let menu = &reopened.root_entries[0];
        let story = &menu.children[0];
        let actual = match index {
            0 => &menu.name,
            1 | 2 | 5 | 6 => &story.name,
            3 => &story.after_playback_sequence[0].name,
            4 => &story.after_playback_home_step.as_ref().unwrap().name,
            _ => unreachable!(),
        };
        assert_eq!(actual, expected, "renamed screen {screen}");
        if index == 5 {
            assert_eq!(value["restoredPackNameIds"], json!([]));
        } else if index == 6 {
            assert_eq!(value["restoredPackNameIds"], json!([story.id]));
        }
    }
}

#[test]
fn recipe_production_mutations_and_silent_fallback() {
    use crate::services::pack_reader::{
        classify_pack_editability, unpack_zip_to_entries_unchecked,
    };
    let dir = TestDir::new();
    let p = source(&cases()[0]["dto"]);
    let (zip, _) = archive_for_reopening(&p, dir.path());
    // Retouches to content and identity are authoritative, including renamed audio.
    for mutation in ["uuid", "title", "audio", "renamed", "swapped"] {
        let changed = dir.path().join(format!("{mutation}.zip"));
        edited_archive(&zip, &changed, |files| {
            let mut story: Value = serde_json::from_slice(&files["story.json"]).unwrap();
            match mutation {
                "uuid" => permute(&mut story, 9),
                "title" => {
                    story["title"] = json!("Titre retouché");
                    story["description"] = json!("Description retouchée");
                }
                "audio" => {
                    let name = story["stageNodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find_map(|s| s["audio"].as_str())
                        .unwrap();
                    files.insert(format!("assets/{name}"), b"replacement sound".to_vec());
                }
                "renamed" => {
                    let old = story["stageNodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find_map(|s| s["audio"].as_str())
                        .unwrap()
                        .to_owned();
                    files.insert("assets/renamed.mp3".into(), b"renamed replacement".to_vec());
                    files.remove(&format!("assets/{old}"));
                    for s in story["stageNodes"].as_array_mut().unwrap() {
                        if s["audio"] == old {
                            s["audio"] = json!("renamed.mp3");
                        }
                    }
                }
                "swapped" => {
                    let stages = story["stageNodes"].as_array_mut().unwrap();
                    let indices: Vec<_> = stages
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| s["audio"].is_string())
                        .map(|(i, _)| i)
                        .collect();
                    let a = stages[indices[0]]["audio"].clone();
                    files.insert(
                        format!("assets/{}", a.as_str().unwrap()),
                        reopening_wav(440.0),
                    );
                    files.insert(
                        format!("assets/{}", stages[indices[1]]["audio"].as_str().unwrap()),
                        reopening_wav(660.0),
                    );
                    stages[indices[0]]["audio"] = stages[indices[1]]["audio"].clone();
                    stages[indices[1]]["audio"] = a;
                }
                _ => unreachable!(),
            }
            files.insert("story.json".into(), serde_json::to_vec(&story).unwrap());
        });
        let (value, project) = reopen_for_test(&changed, &dir.path().join(mutation));
        if mutation == "title" {
            assert_eq!(value["title"], "Titre retouché");
            assert_eq!(value["packDescription"], "Description retouchée");
        }
        if mutation == "renamed" {
            assert_eq!(
                fs::read(project.root_audio.as_ref().unwrap()).unwrap(),
                b"renamed replacement"
            );
        }
        if mutation == "audio" {
            assert_eq!(
                fs::read(project.root_audio.as_ref().unwrap()).unwrap(),
                b"replacement sound"
            );
        }
        if mutation == "swapped" {
            assert_eq!(
                fs::read(project.root_audio.as_ref().unwrap()).unwrap(),
                reopening_wav(660.0)
            );
            assert_eq!(
                fs::read(project.root_entries[0].item_audio.as_ref().unwrap()).unwrap(),
                reopening_wav(440.0)
            );
            assert!(project.root_audio.unwrap().contains("a_t"));
            assert!(project.root_entries[0]
                .item_audio
                .as_ref()
                .unwrap()
                .contains("root"));
        }
    }
    let mut fallback = 0;
    for mutation in [
        "absent",
        "version",
        "convention",
        "json",
        "unknown",
        "option",
        "target",
    ] {
        let changed = dir.path().join(format!("{mutation}.zip"));
        edited_archive(&zip, &changed, |files| {
            use super::super::recipe::FILE_NAME;
            if mutation == "absent" {
                files.remove(FILE_NAME);
                return;
            }
            if mutation == "json" {
                files.insert(FILE_NAME.into(), b"{broken".to_vec());
                return;
            }
            if matches!(mutation, "option" | "target") {
                let mut story: Value = serde_json::from_slice(&files["story.json"]).unwrap();
                let opts = story["actionNodes"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|a| a["options"].as_array().unwrap().len() > 1)
                    .unwrap()["options"]
                    .as_array_mut()
                    .unwrap();
                if mutation == "option" {
                    opts.pop();
                } else {
                    opts[0] = opts[1].clone();
                }
                files.insert("story.json".into(), serde_json::to_vec(&story).unwrap());
            } else {
                let mut recipe: Value = serde_json::from_slice(&files[FILE_NAME]).unwrap();
                recipe[match mutation {
                    "version" => "recipeVersion",
                    "convention" => "generationConventionVersion",
                    _ => "unknown",
                }] = json!(2);
                files.insert(FILE_NAME.into(), serde_json::to_vec(&recipe).unwrap());
            }
        });
        let no_recipe = dir.path().join(format!("{mutation}-without.zip"));
        edited_archive(&changed, &no_recipe, |files| {
            files.remove(super::super::recipe::FILE_NAME);
        });
        let current = classify_pack_editability(changed.to_str().unwrap()).unwrap();
        let expected = classify_pack_editability(no_recipe.to_str().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::to_value(expected).unwrap(),
            "verdict fallback {mutation}"
        );
        // Same destination, emptied between calls: byte-for-byte projection equality.
        let dest = dir.path().join("fallback");
        let actual =
            unpack_zip_to_entries_unchecked(changed.to_str().unwrap(), dest.to_str().unwrap())
                .unwrap();
        fs::remove_dir_all(&dest).unwrap();
        let expected =
            unpack_zip_to_entries_unchecked(no_recipe.to_str().unwrap(), dest.to_str().unwrap())
                .unwrap();
        assert_eq!(actual, expected, "projection fallback {mutation}");
        fs::remove_dir_all(dest).unwrap();
        fallback += 1;
    }
    eprintln!("recipe content edits 5/5; silent fallback {fallback}/7");
}

#[test]
fn recipe_production_shared_media_and_divergent_role() {
    let dir = TestDir::new();
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "root3/gEnd/lAttach/c0")
        .unwrap();
    let mut p = source(&case["dto"]);
    // Non-injective role -> media, including title/play and root/story sharing.
    p.root_entries[0].item_audio = p.root_entries[0].audio.clone();
    p.root_entries[1].audio = p.root_audio.clone();
    let (zip, reference) = archive_for_reopening(&p, dir.path());
    let (_, project) = reopen_for_test(&zip, &dir.path().join("shared"));
    compare_reopened(&p, &project, &reference);
    assert_eq!(
        project.root_entries[0].audio,
        project.root_entries[0].item_audio
    );
    assert_eq!(project.root_audio, project.root_entries[1].audio);
    assert_eq!(
        project.night_mode_audio,
        project.root_entries[0].after_playback_prompt_audio
    );
    for equal in [true, false] {
        let changed = dir.path().join(format!("shared-{equal}.zip"));
        edited_archive(&zip, &changed, |files| {
            let mut story: Value = serde_json::from_slice(&files["story.json"]).unwrap();
            let global: String = p
                .night_mode_audio
                .as_ref()
                .unwrap()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            let stage = story["stageNodes"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|s| s["audio"] == format!("{global}.mp3"))
                .unwrap();
            let bytes = if equal {
                files[&format!("assets/{}", stage["audio"].as_str().unwrap())].clone()
            } else {
                b"divergent bytes".to_vec()
            };
            files.insert("assets/shared-copy.mp3".into(), bytes);
            stage["audio"] = json!("shared-copy.mp3");
            files.insert("story.json".into(), serde_json::to_vec(&story).unwrap());
        });
        let dest = dir.path().join(format!("shared-extract-{equal}"));
        let result = crate::services::pack_reader::unpack_zip_to_entries_unchecked(
            changed.to_str().unwrap(),
            dest.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(result["recipeReopened"] == true, equal);
    }

    // Sharing title/play media can change topology, even with unchanged transitions.
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "root3/gEnd/l0/c0")
        .unwrap();
    let mut dto = case["dto"].clone();
    dto["rootEntries"][0]["titleControlSettings"] = Value::Null;
    dto["rootEntries"][0]["controlSettings"] =
        json!({"wheel":true,"autoplay":true,"ok":true,"home":false,"pause":false});
    let p = source(&dto);
    assert_ne!(p.root_entries[0].item_audio, p.root_entries[0].audio);
    let (zip, reference) = archive_for_reopening(&p, dir.path());
    reopen_for_test(&zip, &dir.path().join("distinct"));
    let mut combined = source(&dto);
    combined.root_entries[0].item_audio = combined.root_entries[0].audio.clone();
    assert_eq!(
        build(&serde_json::to_value(combined).unwrap())["stageNodes"]
            .as_array()
            .unwrap()
            .len()
            + 1,
        reference["stageNodes"].as_array().unwrap().len()
    );
    let changed = dir.path().join("title-uses-play.zip");
    edited_archive(&zip, &changed, |files| {
        let mut story: Value = serde_json::from_slice(&files["story.json"]).unwrap();
        let title = story["stageNodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["audio"] == "C__message_fin_a_t_mp3.mp3")
            .unwrap();
        title["audio"] = json!("C__message_fin_a_mp3.mp3");
        files.insert("story.json".into(), serde_json::to_vec(&story).unwrap());
    });
    let without = dir.path().join("title-uses-play-without.zip");
    edited_archive(&changed, &without, |files| {
        files.remove(super::super::recipe::FILE_NAME);
    });
    use crate::services::pack_reader::{
        classify_pack_editability, unpack_zip_to_entries_unchecked,
    };
    let dest = dir.path().join("title-uses-play");
    let actual =
        unpack_zip_to_entries_unchecked(changed.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
    assert_ne!(
        actual["recipeReopened"], true,
        "unsafe final project certified"
    );
    fs::remove_dir_all(&dest).unwrap();
    let expected =
        unpack_zip_to_entries_unchecked(without.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
    assert_eq!(actual, expected, "complete silent fallback projection");
    assert_eq!(
        serde_json::to_value(classify_pack_editability(changed.to_str().unwrap()).unwrap())
            .unwrap(),
        serde_json::to_value(classify_pack_editability(without.to_str().unwrap()).unwrap())
            .unwrap(),
        "silent fallback verdict"
    );
}

#[test]
fn recipe_production_silent_title_and_transparent_menu() {
    let dir = TestDir::new();
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "folder/g0/l0/c0")
        .unwrap();
    let mut project = source(&case["dto"]);
    project.root_entries[0].auto_black_image = true;
    project.root_entries[0].image = None;
    project.root_entries[0].children[0].item_audio = None;
    project.root_entries[0].children[0].silent_title_stage = true;
    let (zip, reference) = archive_for_reopening(&project, dir.path());
    let (_, reopened) = reopen_for_test(&zip, &dir.path().join("open"));
    assert!(reopened.root_entries[0].auto_black_image);
    assert!(reopened.root_entries[0].children[0].silent_title_stage);
    compare_reopened(&project, &reopened, &reference);
}

fn reopening_wav(frequency: f64) -> Vec<u8> {
    let samples: Vec<u8> = (0..22050)
        .flat_map(|i| {
            (((i as f64 * frequency * std::f64::consts::TAU / 22050.0).sin() * 8000.0) as i16)
                .to_le_bytes()
        })
        .collect();
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    for n in [16u32, 65537, 22050, 44100, 1048578] {
        wav.extend_from_slice(&n.to_le_bytes());
    }
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(&samples);
    wav
}

#[test]
fn recipe_production_realistic_simple_and_checker() {
    use crate::services::community_pack_checker::{create_fixed_pack_with_log, PackMetadataPatch};
    let dir = TestDir::new();
    let audio = dir.path().join("tone.wav");
    fs::write(&audio, reopening_wav(440.0)).unwrap();
    let image = dir.path().join("cover.png");
    write_test_png(&image);
    let mut count = 0;
    let mut source_zip = None;
    let _ = cases();
    let simple_cases: Vec<Value> = serde_json::from_slice(
        &fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("target/recipe/simple-cases.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(simple_cases.len(), 6);
    for mut dto in simple_cases {
        dto["rootAudio"] = json!(audio);
        dto["rootImage"] = json!(image);
        dto["thumbnailImage"] = json!(image);
        dto["rootEntries"][0]["audio"] = json!(audio);
        if dto["nightModeAudio"].is_string() {
            dto["nightModeAudio"] = json!(audio);
        }
        let output = generate_native_pack_v1_with_cancel(
            &source(&dto),
            dir.path().join(format!("simple-{count}")).to_str().unwrap(),
            &|_| {},
            &|| false,
        )
        .unwrap();
        let zip = Path::new(&output.zip_path);
        let (_, project) = reopen_for_test(zip, &dir.path().join(format!("simple-open-{count}")));
        assert_eq!(project.project_type.as_deref(), Some("simple"));
        assert_eq!(
            project.global_options.night_mode,
            dto["globalOptions"]["nightMode"].as_bool().unwrap()
        );
        assert_eq!(
            project.global_options.end_message_autoplay,
            dto["globalOptions"]["endMessageAutoplay"]
                .as_bool()
                .unwrap()
        );
        assert!(project.root_entries[0].item_audio.is_none());
        assert!(project.root_entries[0].item_image.is_none());
        generate_native_pack_v1_with_cancel(
            &project,
            dir.path()
                .join(format!("simple-regenerated-{count}"))
                .to_str()
                .unwrap(),
            &|_| {},
            &|| false,
        )
        .unwrap();
        source_zip = Some(output.zip_path);
        count += 1;
    }
    eprintln!(
        "realistic simple: {count}/6 reopened simple and regenerated through production gates"
    );
    // Force an actual audio correction, rather than just a metadata-only checker pass.
    let bad_audio = dir.path().join("needs-checker.zip");
    edited_archive(
        Path::new(source_zip.as_ref().unwrap()),
        &bad_audio,
        |files| {
            let names: Vec<_> = files
                .keys()
                .filter(|name| name.starts_with("assets/") && name.ends_with(".mp3"))
                .cloned()
                .collect();
            let mut story: Value = serde_json::from_slice(&files["story.json"]).unwrap();
            for name in names {
                let renamed = name.replace(".mp3", ".wav");
                files.remove(&name);
                files.insert(renamed.clone(), reopening_wav(660.0));
                for stage in story["stageNodes"].as_array_mut().unwrap() {
                    if stage["audio"] == name.strip_prefix("assets/").unwrap() {
                        stage["audio"] = json!(renamed.strip_prefix("assets/").unwrap());
                    }
                }
            }
            files.insert("story.json".into(), serde_json::to_vec(&story).unwrap());
        },
    );
    for mask in 1..=3 {
        let patch = PackMetadataPatch {
            title: (mask & 1 != 0).then(|| "Titre corrigé".into()),
            uuid: (mask & 2 != 0).then(|| "aaaaaaaa-2222-4333-8444-555566667777".into()),
            ..Default::default()
        };
        let fixed = create_fixed_pack_with_log(
            &bad_audio,
            Some(&dir.path().join(format!("checker-{mask}"))),
            Some(patch),
            None,
            &|_| {},
        )
        .unwrap();
        assert!(fixed.audio_fixed > 0);
        let (value, _) = reopen_for_test(
            Path::new(&fixed.fixed_zip_path),
            &dir.path().join(format!("checker-open-{mask}")),
        );
        if mask & 1 != 0 {
            assert_eq!(value["title"], "Titre corrigé");
        }
        if mask & 2 != 0 {
            assert_eq!(value["uuid"], "aaaaaaaa-2222-4333-8444-555566667777");
        }
        let story: Value =
            serde_json::from_slice(&zip_bytes(Path::new(&fixed.fixed_zip_path), "story.json"))
                .unwrap();
        let before: Value = serde_json::from_slice(&zip_bytes(&bad_audio, "story.json")).unwrap();
        assert_ne!(
            story["stageNodes"][0]["audio"], before["stageNodes"][0]["audio"],
            "checker renames corrected audio"
        );
    }
    eprintln!("community checker: 3/3 corrected audio/title/UUID packs reopened");
}

#[test]
fn recipe_production_root_intent_survives_reordering() {
    for target in ["root", "story:a"] {
        let dir = TestDir::new();
        let mut p = source(&cases()[0]["dto"]);
        p.root_entries[1].return_on_home = Some(target.into());
        let (zip, _) = archive_for_reopening(&p, dir.path());
        let (_, mut reopened) = reopen_for_test(&zip, &dir.path().join("open"));
        let expected = if target == "root" {
            "root"
        } else {
            "story:recipe-0"
        };
        assert_eq!(
            reopened.root_entries[1].return_on_home.as_deref(),
            Some(expected)
        );
        reopened.root_entries.swap(0, 2);
        p.root_entries.swap(0, 2);
        let reference = serde_json::to_value(build_story_document(&report(&p)).unwrap()).unwrap();
        let canonical = canonicalize_project(&reopened);
        let assets = collect_asset_requests(&canonical, 0.0, 0.0)
            .into_iter()
            .map(|r| {
                prepared_asset(
                    &r.role,
                    Path::new(&r.source_path)
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap(),
                )
            })
            .collect();
        let fresh = serde_json::to_value(
            build_story_document(&report_for(canonical, assets, vec![])).unwrap(),
        )
        .unwrap();
        pair(&reference, &fresh).unwrap();
    }
}

#[test]
fn recipe_production_external_projects() {
    let Ok(path) = std::env::var("RECIPE_CORPUS_CASES") else {
        return;
    };
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(cases.len(), 2);
    for case in cases {
        let dir = TestDir::new();
        let project = source(&case["dto"]);
        let (zip, reference) = archive_for_reopening(&project, dir.path());
        let (_, reopened) = reopen_for_test(&zip, &dir.path().join("open"));
        assert_eq!(reopened.project_type, project.project_type);
        compare_reopened(&project, &reopened, &reference);
    }
    eprintln!("external projects: 2/2 generated with recipe and reopened in the expected editor");
}

#[test]
fn recipe_production_extracted_folder_and_cache() {
    use crate::support::imported_pack::ensure_studio_pack_zip_from_dir;
    let dir = TestDir::new();
    let project = source(&cases()[0]["dto"]);
    let (zip, reference) = archive_for_reopening(&project, dir.path());
    let folder = dir.path().join("folder");
    zip::ZipArchive::new(fs::File::open(zip).unwrap())
        .unwrap()
        .extract(&folder)
        .unwrap();
    let imported =
        ensure_studio_pack_zip_from_dir(folder.to_str().unwrap(), &dir.path().join("cache"))
            .unwrap();
    let (_, reopened) = reopen_for_test(&imported.zip_path, &dir.path().join("open-folder"));
    compare_reopened(&project, &reopened, &reference);
    let recipe = folder.join(super::super::recipe::FILE_NAME);
    let mut value: Value = serde_json::from_slice(&fs::read(&recipe).unwrap()).unwrap();
    value["recipeVersion"] = json!(2);
    fs::write(recipe, serde_json::to_vec(&value).unwrap()).unwrap();
    let imported =
        ensure_studio_pack_zip_from_dir(folder.to_str().unwrap(), &dir.path().join("cache"))
            .unwrap();
    let fallback = crate::services::pack_reader::unpack_zip_to_entries_unchecked(
        imported.zip_path.to_str().unwrap(),
        dir.path().join("open-folder-changed").to_str().unwrap(),
    )
    .unwrap();
    assert_ne!(
        fallback["recipeReopened"], true,
        "folder cache includes the optional recipe"
    );
    // A sidecar too large to read is optional during folder conversion too.
    fs::OpenOptions::new()
        .write(true)
        .open(folder.join(super::super::recipe::FILE_NAME))
        .unwrap()
        .set_len(crate::services::pack_reader::MAX_STORY_JSON_BYTES + 1)
        .unwrap();
    let imported =
        ensure_studio_pack_zip_from_dir(folder.to_str().unwrap(), &dir.path().join("cache"))
            .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(imported.zip_path).unwrap()).unwrap();
    assert!(archive.by_name(super::super::recipe::FILE_NAME).is_err());
}

#[test]
fn recipe_production_without_recipe_matrix() {
    let mut generated = 0;
    let mut menus = 0;
    for case in cases() {
        let project = source(&case["dto"]);
        if build_story_document(&report(&project)).is_err() {
            continue;
        }
        let dir = TestDir::new();
        let (with_recipe, _) = archive_for_reopening(&project, dir.path());
        let without = dir.path().join("without.zip");
        edited_archive(&with_recipe, &without, |files| {
            files.remove(super::super::recipe::FILE_NAME);
        });
        let verdict =
            crate::services::pack_reader::classify_pack_editability(without.to_str().unwrap())
                .unwrap();
        menus += usize::from(verdict.authoring_editable);
        let legacy = crate::services::pack_reader::unpack_zip_to_entries_unchecked(
            without.to_str().unwrap(),
            dir.path().join("open").to_str().unwrap(),
        )
        .unwrap();
        assert_ne!(legacy["recipeReopened"], true);
        generated += 1;
    }
    eprintln!("no-recipe matrix: {generated}/1420 legacy imports; {menus} menus (reference: 645)");
    assert_eq!((generated, menus), (1420, 645));
}

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("recipe-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn recipe_private_sentinels_and_author_names() {
    use super::super::recipe::adapt;
    let private = "__PRIVATE_SENTINEL__";
    let mut dto = cases()[0]["dto"].clone();
    for field in [
        "name",
        "packDescription",
        "packUuid",
        "officialOriginUuid",
        "thumbnailImage",
        "rootAudio",
        "rootImage",
        "nightModeAudio",
    ] {
        dto[field] = json!(format!("{private}/{field}"));
    }
    dto["nativeGraph"] = json!({"poison":private});
    // Numeric private settings: a distinctive value that must not appear either.
    dto["packVersion"] = json!(987_654);
    dto["globalOptions"]["addSilenceDurationSec"] = json!(9.87654);
    dto["rootName"] = json!("Author / root \\ name");
    dto["endNodeName"] = json!("Author end name");
    dto["treeColor"] = json!("#aBc123");
    dto["globalOptions"]["endNode"] = json!(true);
    let mut entry = dto["rootEntries"][0].clone();
    for field in [
        "id",
        "nativeStageId",
        "audio",
        "image",
        "itemAudio",
        "itemImage",
        "afterPlaybackPromptAudio",
        "zipPath",
        "packUuid",
        "officialOriginUuid",
    ] {
        entry[field] = json!(format!("{private}/{field}"));
    }
    entry["name"] = json!("Author / story \\ name");
    entry["treeColor"] = json!("#123456");
    let step = json!({"id":format!("{private}/step-id"),"name":"Author step","audio":format!("{private}/step-audio"),"image":format!("{private}/step-image")});
    entry["afterPlaybackSequence"] = json!([step.clone(), step.clone()]);
    entry["afterPlaybackHomeStep"] = step;
    dto["rootEntries"] = json!([{"id":format!("{private}/menu-id"),"type":"menu","name":"Author menu","audio":format!("{private}/menu-audio"),"image":format!("{private}/menu-image"),"treeColor":"#abcdef","children":[entry]}]);
    let project = source(&dto);
    let recipe = adapt(&project, &canonicalize_project(&project)).unwrap();
    let json = serde_json::to_string(&recipe).unwrap();
    assert!(!json.contains(private), "private value escaped: {json}");
    assert!(
        !json.contains("987654") && !json.contains("9.87654"),
        "{json}"
    );
    assert_eq!(recipe.root_name, "Author / root \\ name");
    assert_eq!(recipe.end_name, "Author end name");
    assert!(recipe.global_end.present);
    for name in ["Author menu", "Author step", "Author / story"] {
        assert!(json.contains(name));
    }
    assert!(json.contains("#aBc123"));
    assert!(json.contains("#abcdef"));
}

#[test]
fn recipe_closed_schema_at_every_object_and_variant() {
    use super::super::recipe::{adapt, Recipe};
    let mut objects = 0;
    fn poison(value: &Value, path: &mut Vec<String>, root: &Value, count: &mut usize) {
        match value {
            Value::Object(map) => {
                let mut changed = root.clone();
                let mut cursor = &mut changed;
                for key in path.iter() {
                    cursor = if cursor.is_array() {
                        &mut cursor[key.parse::<usize>().unwrap()]
                    } else {
                        &mut cursor[key]
                    };
                }
                cursor
                    .as_object_mut()
                    .unwrap()
                    .insert("__unknown".into(), json!(true));
                assert!(
                    serde_json::from_value::<Recipe>(changed).is_err(),
                    "unknown key accepted at {path:?}"
                );
                *count += 1;
                for (key, v) in map {
                    path.push(key.clone());
                    poison(v, path, root, count);
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (i, v) in items.iter().enumerate() {
                    path.push(i.to_string());
                    poison(v, path, root, count);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    // All matrix forms exercise nested settings, roles, both entries, steps, controls and targets.
    for case in cases() {
        let p = source(&case["dto"]);
        let recipe = adapt(&p, &canonicalize_project(&p)).unwrap();
        let root = serde_json::to_value(&recipe).unwrap();
        poison(&root, &mut vec![], &root, &mut objects);
    }
    // Include all Target variants, even those the finite matrix does not select.
    for target in [
        json!({"kind":"root"}),
        json!({"kind":"currentMenu"}),
        json!({"kind":"nextStory"}),
        json!({"kind":"menu","entry":0}),
        json!({"kind":"storyTitle","entry":0}),
        json!({"kind":"storyPlay","entry":0}),
        json!({"kind":"storyHomeStep","entry":0}),
    ] {
        let mut changed = target;
        changed["unknown"] = json!(true);
        assert!(serde_json::from_value::<super::super::recipe::Target>(changed).is_err());
    }
    let p = source(&cases()[0]["dto"]);
    let root = serde_json::to_value(adapt(&p, &canonicalize_project(&p)).unwrap()).unwrap();
    for field in ["recipeVersion", "generationConventionVersion"] {
        let mut changed = root.clone();
        changed[field] = json!(2);
        assert!(serde_json::from_value::<Recipe>(changed).is_err());
    }
    let mut changed = root.clone();
    changed["treeColor"] = json!("red");
    assert!(serde_json::from_value::<Recipe>(changed).is_err());
    let mut changed = root.clone();
    changed.as_object_mut().unwrap().remove("treeColor");
    assert!(serde_json::from_value::<Recipe>(changed).is_err());
    eprintln!("closed schema: {objects} poisoned objects rejected");
}

#[test]
fn recipe_refusals_and_silent_title() {
    use super::super::recipe::{adapt, reconstruct};
    let dto = cases()[0]["dto"].clone();
    let mut p = source(&dto);
    p.root_entries[0].entry_type = "zip".into();
    assert!(adapt(&p, &canonicalize_project(&p)).is_err());
    let mut p = source(&dto);
    p.shared_entries.push(p.root_entries[0].clone());
    assert!(adapt(&p, &canonicalize_project(&p)).is_err());
    for target in ["menu:orphan", "menu:a", "story_home_step:a"] {
        let mut p = source(&dto);
        p.night_mode_return = Some(target.into());
        assert!(adapt(&p, &canonicalize_project(&p)).is_err(), "{target}");
    }
    let mut p = source(&dto);
    p.root_entries[0].item_audio = None;
    p.root_entries[0].silent_title_stage = true;
    let recipe = adapt(&p, &canonicalize_project(&p)).unwrap();
    let roles = role_media(&p, &recipe);
    let mut rebuilt = reconstruct(&recipe, |r| roles.get(r).cloned()).unwrap();
    assert!(rebuilt.root_entries[0].silent_title_stage);
    rebuilt.thumbnail_image = p.thumbnail_image.clone();
    crate::domain::validation::validate_project_structure_for_generation(&rebuilt).unwrap();
    assert!(reconstruct(&recipe, |_| None).is_err());
}
// Optional real-project size probe; corpus stays outside the code repository.
#[test]
fn recipe_corpus_size() {
    let Ok(path) = std::env::var("RECIPE_CORPUS_CASES") else {
        return;
    };
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    for case in cases {
        let p = source(&case["dto"]);
        let recipe = super::super::recipe::adapt(&p, &canonicalize_project(&p)).unwrap();
        eprintln!(
            "recipe size {}: {} bytes",
            case["name"],
            serde_json::to_vec(&recipe).unwrap().len()
        );
    }
}

#[test]
fn recipe_production_writer_pack_simple_and_aggregate_fallback() {
    let dir = TestDir::new();
    let image = dir.path().join("cover.png");
    write_test_png(&image);
    let audio = dir.path().join("sound.wav");
    let samples: Vec<u8> = (0..22050)
        .flat_map(|i| {
            (((i as f64 * 440.0 * std::f64::consts::TAU / 22050.0).sin() * 8000.0) as i16)
                .to_le_bytes()
        })
        .collect();
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&22050u32.to_le_bytes());
    wav.extend_from_slice(&44100u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(&samples);
    fs::write(&audio, wav).unwrap();
    let generate = |dto: &Value, out: &str| {
        generate_native_pack_v1_with_cancel(
            &source(dto),
            dir.path().join(out).to_str().unwrap(),
            &|_| {},
            &|| false,
        )
        .unwrap()
    };
    let mut pack_path = String::new();
    for kind in ["pack", "simple"] {
        let result = generate(
            &json!({"name":"Recipe writer","rootName":"Author root","endNodeName":"Author end","projectType":kind,"packUuid":"11111111-2222-4333-8444-555566667777","rootAudio":audio,"rootImage":image,"globalOptions":{"autoNext":false,"nightMode":false,"silenceMode":"off","harmonizeLoudness":false},"rootEntries":[{"id":"s","type":"story","name":"Story","audio":audio}]}),
            kind,
        );
        let bytes = zip_bytes(Path::new(&result.zip_path), super::super::recipe::FILE_NAME);
        let recipe: super::super::recipe::Recipe = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(recipe.root_name, "Author root");
        assert_eq!(
            recipe.project_type,
            if kind == "pack" {
                super::super::recipe::ProjectType::Pack
            } else {
                super::super::recipe::ProjectType::Simple
            }
        );
        if kind == "pack" {
            pack_path = result.zip_path;
        }
    }
    let result = generate(
        &json!({"name":"Aggregate recipe fallback","projectType":"pack","packUuid":"aaaaaaaa-2222-4333-8444-555566667777","rootAudio":audio,"rootImage":image,"globalOptions":{"autoNext":false,"nightMode":false,"silenceMode":"off","harmonizeLoudness":false},"rootEntries":[{"id":"zip","type":"zip","name":"Embedded","zipPath":pack_path}]}),
        "aggregate",
    );
    assert!(
        zip::ZipArchive::new(fs::File::open(result.zip_path).unwrap())
            .unwrap()
            .by_name(super::super::recipe::FILE_NAME)
            .is_err()
    );
}
