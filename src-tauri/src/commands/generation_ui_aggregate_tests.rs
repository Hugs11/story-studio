//! Real aggregation of generated packs, reread from the output archive.

use super::*;

/// Génère un projet et rend le chemin de l'archive publiée.
fn generate(project: serde_json::Value, output: &Path) -> String {
    let project = parse_project_json(&project.to_string()).expect("projet lisible par Rust");
    validate_project_for_generation(&project).expect("validation avant génération");
    let result = crate::native_pack::generate_native_pack_v1_with_cancel(
        &project,
        output.to_str().expect("sortie UTF-8"),
        &|_| {},
        &|| false,
    )
    .unwrap_or_else(|error| panic!("génération refusée : {error}"));
    assert!(
        result
            .gate_observations
            .iter()
            .all(|observation| observation.outcome == GateOutcome::Passed),
        "{:#?}",
        result.gate_observations
    );
    let report = validate_lunii_zip(&result.zip_path);
    assert!(report.valid, "archive invalide : {:#?}", report.issues);
    result.zip_path
}

/// Les noms des Écrans que la molette propose après OK sur `name`.
fn wheel_choices_after_ok(pack: &serde_json::Value, name: &str) -> Vec<String> {
    let transition = &stage(pack, name)["okTransition"];
    let action = pack["actionNodes"]
        .as_array()
        .expect("actions relues")
        .iter()
        .find(|action| action["id"] == transition["actionNode"])
        .unwrap_or_else(|| panic!("« {name} » : action introuvable"));
    action["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|target| {
            pack["stageNodes"]
                .as_array()
                .expect("écrans relus")
                .iter()
                .find(|stage| &stage["uuid"] == target)
                .and_then(|stage| stage["name"].as_str())
                .unwrap_or("?")
                .to_string()
        })
        .collect()
}

/// Deux packs produits par Story Studio (deux histoires à la racine), puis
/// agrégés avec cinq autres exemplaires : génération réelle, archive relue.
#[test]
fn real_aggregate_of_story_studio_packs_keeps_every_story_on_the_wheel() {
    let workspace = Workspace::new("aggregate");
    let media = workspace.dir.join("media");
    let path = |name: &str| media.join(name).to_string_lossy().to_string();
    for (rank, name) in ["menu", "un-titre", "un", "deux-titre", "deux"]
        .iter()
        .enumerate()
    {
        write_tone_wav(&media.join(format!("{name}.wav")), rank);
        write_flat_png(&media.join(format!("{name}.png")), rank);
    }
    let story = |id: &str, name: &str| {
        serde_json::json!({
            "id": id, "type": "story", "name": name,
            "audio": path(&format!("{name}.wav")),
            "itemAudio": path(&format!("{name}-titre.wav")),
            "itemImage": path(&format!("{name}.png")),
            "controlSettings": {"autoplay": true, "wheel": false, "pause": true, "ok": false, "home": true}
        })
    };
    let options = serde_json::json!({"autoNext": false, "nightMode": false, "harmonizeLoudness": true, "silenceMode": "normalize"});
    let source = |uuid: &str, title: &str| {
        serde_json::json!({
            "name": title, "projectType": "pack", "packUuid": uuid,
            "rootAudio": path("menu.wav"), "rootImage": path("menu.png"), "thumbnailImage": path("menu.png"),
            "rootEntries": [story("s1", "un"), story("s2", "deux")],
            "globalOptions": options.clone()
        })
    };
    let sources = workspace.dir.join("sources");
    fs::create_dir_all(&sources).expect("dossier des sources");
    let pack_a = generate(
        source("aaaaaaaa-0000-4000-8000-000000000001", "Source A"),
        &sources,
    );
    let pack_b = generate(
        source("bbbbbbbb-0000-4000-8000-000000000002", "Source B"),
        &sources,
    );
    let reread_a: serde_json::Value = serde_json::from_str(
        &crate::services::pack_reader::load_pack_zip(&pack_a).expect("source relue"),
    )
    .expect("JSON");
    let source_choices = wheel_choices_after_ok(&reread_a, "Cover node");
    assert_eq!(source_choices.len(), 2, "témoin : {source_choices:?}");

    // Sept entrées : A, B, puis cinq exemplaires de A (même UUID, mêmes noms
    // de ressources), dans cet ordre.
    let mut entries = Vec::new();
    for index in 0..7 {
        let zip = match index {
            0 => pack_a.clone(),
            1 => pack_b.clone(),
            _ => {
                let copy = sources.join(format!("copie-{index}.zip"));
                fs::copy(&pack_a, &copy).expect("exemplaire");
                copy.to_string_lossy().to_string()
            }
        };
        entries.push(serde_json::json!({
            "id": format!("zip-{index}"), "type": "zip",
            "name": format!("Pack {} été", index + 1), "zipPath": zip
        }));
    }
    let aggregate_project = serde_json::json!({
        "name": "Agrégat été", "projectType": "pack",
        "packUuid": "cccccccc-0000-4000-8000-000000000003",
        "rootAudio": path("menu.wav"), "rootImage": path("menu.png"), "thumbnailImage": path("menu.png"),
        "rootEntries": entries, "globalOptions": options
    });
    let projection = crate::native_pack::simulation::project_story_for_simulation(
        &parse_project_json(&aggregate_project.to_string()).expect("simulation project"),
    )
    .expect("aggregate simulation");
    let simulated = serde_json::to_value(&projection.story).expect("simulation document");
    for index in 1..=7 {
        assert_eq!(
            wheel_choices_after_ok(&simulated, &format!("Pack {index} été")),
            source_choices,
            "simulation keeps every source choice"
        );
    }
    let aggregate = generate(aggregate_project, &workspace.dir.join("sortie"));
    let pack: serde_json::Value = serde_json::from_str(
        &crate::services::pack_reader::load_pack_zip(&aggregate).expect("agrégat relu"),
    )
    .expect("JSON");

    // Ordre du menu d'agrégation = ordre choisi ; identifiants tous distincts.
    assert_eq!(
        wheel_choices_after_ok(&pack, "Cover node"),
        (1..=7)
            .map(|index| format!("Pack {index} été"))
            .collect::<Vec<_>>()
    );
    let stages = pack["stageNodes"].as_array().expect("écrans");
    let unique: std::collections::HashSet<&str> = stages
        .iter()
        .map(|stage| stage["uuid"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(unique.len(), stages.len(), "UUID d'Écran en double");
    assert_eq!(
        stages
            .iter()
            .filter(|stage| stage["name"] == "Histoire - deux")
            .count(),
        7,
        "chaque pack garde sa deuxième histoire : {:?}",
        stage_names(&pack)
    );

    // Le défaut : après OK sur un pack du menu, la molette doit proposer les
    // mêmes choix que la couverture du pack source.
    assert_eq!(
        wheel_choices_after_ok(&pack, "Pack 1 été"),
        source_choices,
        "après OK sur « Pack 1 été », seule la première histoire est proposée"
    );
}
