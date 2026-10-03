//! Test de release, étage 1 : chaque entrée du corpus réduit passe par les
//! vraies chaînes de l'app, sans interface.
//!
//! Il est ignoré par défaut et piloté par `e2e/release/release-test.mjs`, qui
//! prépare le plan (chemins absolus, projets exportés par le code JS de l'app),
//! relit ensuite les archives produites avec STUdio et Lunii.QT, et compare le
//! tout au verdict attendu du manifeste. Le corpus est privé : aucun nom de pack
//! n'est écrit ici.
//!
//! ```bash
//! SS_RELEASE_PLAN=/chemin/plan.json SS_RELEASE_OUT=/chemin/sorties \
//! cargo test --lib release_corpus -- --ignored --nocapture
//! ```
//!
//! Pour chaque pack : éditeur d'ouverture (`classify_pack_editability`),
//! acquisition graphe, points « à corriger » par la readiness de l'app,
//! correction proposée appliquée par le vrai geste si le plan la demande,
//! export graphe ; si l'éditeur par menus l'ouvre, génération par menus et
//! passerelle. Pour un projet : génération par menus du projet exporté.
//! Une ligne JSON par entrée, dans `SS_RELEASE_OUT/constats.jsonl`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::project::Project;
use crate::native_pack::advanced_export::{export_advanced_pack_with_cancel, AdvancedAudioOptions};
use crate::native_pack::editing::apply_advanced_gesture;
use crate::native_pack::generate_native_pack_v1_with_cancel;
use crate::native_pack::graph_copy::graph_copy_of_project;
use crate::native_pack::persistence::{decode_authoring_payload, AdvancedMediaBinding};
use crate::native_pack::readiness::assess_graph_document_export_readiness;
use crate::services::pack_reader::{
    classify_pack_editability, import_pack_as_advanced_document, import_pack_as_free_project,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanEntry {
    id: String,
    kind: String,
    /// Pack : l'archive. Projet : le JSON exporté par `projectToRustExport`.
    path: String,
    #[serde(default)]
    after_fix: Option<String>,
    /// Générer une seconde fois et comparer les deux archives octet pour octet.
    #[serde(default)]
    determinism: bool,
}

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} requis")))
}

/// Les codes qui bloquent la génération, tels que la readiness de l'app les
/// rend : ce que « À corriger » liste.
fn blocking_codes(payload: &str) -> Result<(bool, Vec<String>), String> {
    let decoded = decode_authoring_payload(payload).map_err(|error| format!("{error:?}"))?;
    let readiness = assess_graph_document_export_readiness(Ok(&decoded));
    let value = serde_json::to_value(&readiness).map_err(|error| error.to_string())?;
    let mut codes: Vec<String> = value["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|diagnostic| {
            let text = diagnostic.to_string();
            text.contains("ACTION_REQUIRED") || text.contains("\"error\"")
        })
        .filter_map(find_code)
        .collect();
    codes.sort();
    Ok((readiness.blocked, codes))
}

fn find_code(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => map
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| map.values().find_map(find_code)),
        _ => None,
    }
}

/// L'uuid de l'Écran que désigne un chemin de diagnostic
/// (`/stageNodes/@uuid=<uuid>#<n>/…`).
fn stage_of_path(path: &str) -> Option<String> {
    let rest = path.split("@uuid=").nth(1)?;
    Some(rest.split('#').next()?.to_string())
}

/// Applique la correction proposée à chaque diagnostic qui l'offre, par le
/// geste que l'interface enverrait (`diagnosticResolutions.js`).
fn apply_fix(
    payload: String,
    bindings: Vec<AdvancedMediaBinding>,
    resolution: &str,
) -> Result<(String, Vec<AdvancedMediaBinding>, usize), String> {
    let decoded = decode_authoring_payload(&payload).map_err(|error| format!("{error:?}"))?;
    let offering: Vec<String> = crate::native_pack::authoring::diagnose_enriched_metadata(&decoded)
        .into_iter()
        .filter(|diagnostic| {
            serde_json::to_value(&diagnostic.resolutions)
                .map(|value| value.to_string().contains(resolution))
                .unwrap_or(false)
        })
        .map(|diagnostic| diagnostic.path)
        .collect();
    let mut gestures = Vec::new();
    for path in &offering {
        match resolution {
            "clear-home-transition" | "disable-home" => {
                let Some(stage) = stage_of_path(path) else {
                    continue;
                };
                gestures.push(if resolution == "clear-home-transition" {
                    json!({
                        "gesture": "set-stage-transition", "stageUuid": stage,
                        "slot": "home", "update": {"form": "null"}
                    })
                } else {
                    json!({
                        "gesture": "set-stage-controls", "stageUuid": stage,
                        "update": {"form": "members", "members": {"home": {"form": "set", "value": false}}}
                    })
                });
            }
            // Une donnée importée non reconnue : « Préserver la valeur », pour
            // chaque occurrence, comme l'interface l'offre (`opaqueMemberOf`).
            "preserve-opaque-untested" => {
                for member in decoded.context.opaque_members.iter().filter(|member| {
                    let segment = member.key.replace('~', "~0").replace('/', "~1");
                    format!("{}/{segment}", member.path.trim_end_matches('/')) == *path
                }) {
                    gestures.push(json!({
                        "gesture": "set-opaque-export-disposition",
                        "member": {"path": member.path, "key": member.key, "sourceOccurrence": member.source_occurrence},
                        "disposition": "preserve-untested"
                    }));
                }
            }
            other => return Err(format!("correction inconnue : {other}")),
        }
    }
    let targets = gestures.len();
    let (mut payload, mut bindings) = (payload, bindings);
    for gesture in gestures {
        let gesture = serde_json::from_value(gesture).map_err(|error| error.to_string())?;
        let outcome = apply_advanced_gesture(&payload, bindings, &gesture)
            .map_err(|error| format!("{error:?}"))?;
        payload = outcome.payload;
        bindings = outcome.media_bindings;
    }
    Ok((payload, bindings, targets))
}

fn run_pack(entry: &PlanEntry, zip: &str, work: &Path, out: &Path) -> Value {
    let mut observed = json!({});
    observed["open"] = match classify_pack_editability(zip) {
        Ok(report) if report.authoring_editable => json!("menus+graphe"),
        Ok(_) => json!("graphe"),
        Err(error) => {
            observed["openError"] = json!(error);
            return observed;
        }
    };

    // Graphe : acquisition, « à corriger », correction, export.
    let acquired =
        match import_pack_as_advanced_document(zip, &work.join("graph-assets").to_string_lossy()) {
            Ok(acquired) => acquired,
            Err(error) => {
                observed["open"] = json!("refus");
                observed["openError"] = json!(error);
                return observed;
            }
        };
    let (payload, bindings) = (acquired.payload, acquired.media_bindings);
    match blocking_codes(&payload) {
        Ok((blocked, codes)) => {
            observed["blocked"] = json!(blocked);
            observed["blocking"] = json!(codes);
        }
        Err(error) => observed["readinessError"] = json!(error),
    }
    let (payload, bindings) = match entry.after_fix.as_deref() {
        None => (payload, bindings),
        Some(resolution) => match apply_fix(payload, bindings, resolution) {
            Ok((payload, bindings, applied)) => {
                let after = blocking_codes(&payload)
                    .map(|(_, codes)| codes)
                    .unwrap_or_default();
                observed["afterFix"] =
                    json!({"resolution": resolution, "applied": applied, "blocking": after});
                (payload, bindings)
            }
            Err(error) => {
                observed["afterFix"] = json!({"resolution": resolution, "error": error});
                return observed;
            }
        },
    };
    let cover = acquired.thumbnail_image.as_deref().map(Path::new);
    let export = |suffix: &str| match export_advanced_pack_with_cancel(
        &payload,
        &bindings,
        &out.join(format!("{}-graphe{suffix}", entry.id)),
        &AdvancedAudioOptions::default(),
        None,
        None,
        None,
        cover,
        &|_| {},
        &|| false,
    ) {
        Ok(result) => json!({"zip": result.zip_path}),
        Err(error) => json!({"error": format!("{error:?}")}),
    };
    observed["graph"] = with_determinism(entry.determinism, export(""), || export("-2"));

    // Menus : génération et passerelle, seulement si l'éditeur par menus l'ouvre.
    if observed["open"] == "menus+graphe" {
        match import_pack_as_free_project(zip, &work.join("free-import").to_string_lossy()) {
            Ok(mut project) => {
                // Comme l'app (`schema.js`) : une identité neuve si le pack n'en porte pas.
                if project.pack_uuid.trim().is_empty() {
                    project.pack_uuid = uuid::Uuid::new_v4().to_string();
                }
                observed["passerelle"] = match graph_copy_of_project(&project) {
                    Ok(_) => json!("ok"),
                    Err(error) => json!({"error": error}),
                };
                let generate = |suffix: &str| {
                    generate_menus(&project, &out.join(format!("{}-menus{suffix}", entry.id)))
                };
                observed["menus"] =
                    with_determinism(entry.determinism, generate(""), || generate("-2"));
            }
            Err(error) => observed["menus"] = json!({"error": error}),
        }
    }
    observed
}

/// La stabilité : la même entrée, générée une seconde fois, doit rendre le même
/// **contenu**. Deux variations connues et sans effet pour le lecteur sont
/// neutralisées : la date d'enregistrement de chaque fichier dans le zip, et
/// les identifiants internes des Écrans et des listes, tirés à chaque
/// génération par menus. L'identité du pack (l'uuid de l'Écran d'entrée) doit,
/// elle, rester la même.
fn with_determinism(wanted: bool, first: Value, second: impl FnOnce() -> Value) -> Value {
    let (true, Some(first_zip)) = (wanted, first["zip"].as_str().map(str::to_string)) else {
        return first;
    };
    let mut first = first;
    let second = second();
    first["determinism"] = match second["zip"].as_str() {
        None => json!({"error": second["error"].clone()}),
        Some(second_zip) => {
            let differing = differing_entries(Path::new(&first_zip), Path::new(second_zip));
            json!({"identical": differing.is_empty(), "differing": differing})
        }
    };
    first
}

/// `story.json` dont les identifiants internes sont remplacés par leur rang ;
/// l'uuid de l'Écran d'entrée est gardé tel quel.
fn canonical_story(bytes: &[u8]) -> Option<Value> {
    let mut story: Value = serde_json::from_slice(bytes).ok()?;
    let mut renamed = std::collections::HashMap::new();
    for (index, stage) in story["stageNodes"].as_array()?.iter().enumerate() {
        if stage["squareOne"] != Value::Bool(true) {
            renamed.insert(
                stage["uuid"].as_str()?.to_string(),
                format!("ecran-{index}"),
            );
        }
    }
    for (index, action) in story["actionNodes"].as_array()?.iter().enumerate() {
        renamed.insert(action["id"].as_str()?.to_string(), format!("liste-{index}"));
    }
    fn rename(value: &mut Value, renamed: &std::collections::HashMap<String, String>) {
        match value {
            Value::String(text) => {
                if let Some(new) = renamed.get(text.as_str()) {
                    *text = new.clone();
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| rename(item, renamed)),
            Value::Object(map) => map.values_mut().for_each(|item| rename(item, renamed)),
            _ => {}
        }
    }
    rename(&mut story, &renamed);
    Some(story)
}

fn zip_entries(path: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    use std::io::Read;
    let mut entries = std::collections::BTreeMap::new();
    let Ok(file) = std::fs::File::open(path) else {
        return entries;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return entries;
    };
    for index in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(index) {
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_ok() {
                entries.insert(entry.name().to_string(), bytes);
            }
        }
    }
    entries
}

fn differing_entries(first: &Path, second: &Path) -> Vec<String> {
    let (a, b) = (zip_entries(first), zip_entries(second));
    a.keys()
        .chain(b.keys())
        .filter(|name| match (a.get(*name), b.get(*name)) {
            (Some(x), Some(y)) if name.as_str() == "story.json" => {
                x != y && canonical_story(x) != canonical_story(y)
            }
            (x, y) => x != y,
        })
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn generate_menus(project: &Project, out: &Path) -> Value {
    match generate_native_pack_v1_with_cancel(project, &out.to_string_lossy(), &|_| {}, &|| false) {
        Ok(result) => json!({"zip": result.zip_path}),
        Err(error) => json!({"error": error}),
    }
}

fn run_project(entry: &PlanEntry, out: &Path) -> Value {
    let text = match std::fs::read_to_string(&entry.path) {
        Ok(text) => text,
        Err(error) => return json!({"openError": error.to_string()}),
    };
    match serde_json::from_str::<Project>(&text) {
        Ok(project) => {
            let generate = |suffix: &str| {
                generate_menus(&project, &out.join(format!("{}-menus{suffix}", entry.id)))
            };
            json!({"open": "projet", "menus": with_determinism(entry.determinism, generate(""), || generate("-2"))})
        }
        Err(error) => json!({"openError": format!("JSON invalide : {error}")}),
    }
}

#[test]
#[ignore = "test de release local : SS_RELEASE_PLAN et SS_RELEASE_OUT requis"]
fn release_corpus_runs_every_entry_through_the_real_chains() {
    let plan: Vec<PlanEntry> = serde_json::from_str(
        &std::fs::read_to_string(env_path("SS_RELEASE_PLAN")).expect("plan lisible"),
    )
    .expect("plan valide");
    let out = env_path("SS_RELEASE_OUT");
    std::fs::create_dir_all(&out).expect("dossier de sortie");
    let mut report = std::fs::File::create(out.join("constats.jsonl")).expect("constats.jsonl");

    for (index, entry) in plan.iter().enumerate() {
        println!("[{}/{}] {}", index + 1, plan.len(), entry.id);
        let started = Instant::now();
        let work = std::env::temp_dir().join(format!("ss-release-{}-{index}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).expect("espace de travail");
        // Pile élargie : en debug, les cadres sont bien plus gros qu'en release,
        // et une imbrication profonde y déborderait là où l'app tient.
        let mut observed = std::thread::scope(|scope| {
            std::thread::Builder::new()
                .stack_size(256 * 1024 * 1024)
                .spawn_scoped(scope, || match entry.kind.as_str() {
                    "pack" => run_pack(entry, &entry.path, &work, &out),
                    "projet" => run_project(entry, &out),
                    other => json!({"openError": format!("nature inconnue : {other}")}),
                })
                .expect("fil de mesure")
                .join()
                .unwrap_or_else(|_| json!({"openError": "panique pendant la mesure"}))
        });
        let _ = std::fs::remove_dir_all(&work);
        observed["id"] = json!(entry.id);
        observed["elapsedMs"] = json!(started.elapsed().as_millis());
        writeln!(report, "{observed}").expect("écriture du constat");
        report.flush().expect("vidage du constat");
    }
}

/// Contre-épreuve du contrôle de stabilité : il neutralise les dates du zip et
/// les identifiants internes, mais attrape un octet de son changé, un lien
/// déplacé, et l'identité du pack changée.
#[test]
fn the_stability_check_catches_real_differences() {
    use std::io::Write as _;
    let dir = std::env::temp_dir().join(format!("ss-release-stability-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // `target` choisit l'Écran que vise l'entrée : le déplacer change un lien.
    let story = |entry: &str, inner: &str, target: usize| {
        let options = vec![format!("{inner}-a"), format!("{inner}-b")];
        json!({
            "stageNodes": [
                {"uuid": entry, "squareOne": true, "okTransition": {"actionNode": inner, "optionIndex": target}},
                {"uuid": options[0], "squareOne": false},
                {"uuid": options[1], "squareOne": false}
            ],
            "actionNodes": [{"id": inner, "options": options}]
        })
        .to_string()
    };
    let write = |name: &str, story: String, audio: &[u8], minute: u8| {
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default().last_modified_time(
            zip::DateTime::from_date_and_time(2026, 9, 30, 1, minute, 0).unwrap(),
        );
        zip.start_file("story.json", options).unwrap();
        zip.write_all(story.as_bytes()).unwrap();
        zip.start_file("assets/son.mp3", options).unwrap();
        zip.write_all(audio).unwrap();
        zip.finish().unwrap();
        path
    };
    let reference = write("ref.zip", story("entree", "x1", 0), b"son", 1);
    // Autre date, autres identifiants internes : même contenu.
    let same = write("same.zip", story("entree", "y2", 0), b"son", 2);
    assert!(differing_entries(&reference, &same).is_empty());
    // Un octet de son changé.
    let sound = write("sound.zip", story("entree", "x1", 0), b"sOn", 1);
    assert_eq!(
        differing_entries(&reference, &sound),
        vec!["assets/son.mp3"]
    );
    // Un lien déplacé.
    let link = write("link.zip", story("entree", "x1", 1), b"son", 1);
    assert_eq!(differing_entries(&reference, &link), vec!["story.json"]);
    // L'identité du pack changée.
    let identity = write("identity.zip", story("autre", "x1", 0), b"son", 1);
    assert_eq!(differing_entries(&reference, &identity), vec!["story.json"]);
    let _ = std::fs::remove_dir_all(&dir);
}
