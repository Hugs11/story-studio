use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::projection::walk_story_doc_to_entries;
use super::validation::*;
use crate::domain::project::{GlobalOptions, Project, ProjectEntry};
use crate::native_pack::canonicalize_project;
use crate::native_pack::fidelity_judge::{canonical_roundtrip_is_faithful, FidelityReport};
use crate::support::imported_pack::ensure_studio_pack_zip;
pub fn load_pack_zip(zip_path: &str) -> Result<String, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    read_story_json_from_zip(&zip_path)
}

pub fn get_pack_asset(zip_path: &str, asset_name: &str) -> Result<Vec<u8>, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let asset_name = validate_pack_asset_name(asset_name)?;
    let file =
        fs::File::open(&zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), &zip_path)?;
    let mut entry = archive
        .by_name(&asset_name)
        .map_err(|_| format!("Asset introuvable : {}", asset_name))?;
    ensure_zip_entry_size("Asset", &asset_name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Dézipe un ZIP/7z Lunii et retourne `{ rootAudio, rootImage, entries }`.
/// Les fichiers audio et image sont copiés dans `dest_dir`.
pub fn unpack_zip_to_entries(zip_path: &str, dest_dir: &str) -> Result<serde_json::Value, String> {
    let editability = classify_pack_editability(zip_path)?;
    if !editability.editable {
        return Err(format!(
            "Pack non éditable dans Story Studio : {}",
            editability.reason
        ));
    }
    unpack_zip_to_entries_unchecked(zip_path, dest_dir)
}

/// Projection brute d'un pack, réservée aux tests et outils de mesure. Les chemins
/// produit doivent passer par `unpack_zip_to_entries`, qui applique le verdict
/// d'éditabilité avant de transformer un ZIP en arbre modifiable.
pub(crate) fn unpack_zip_to_entries_unchecked(
    zip_path: &str,
    dest_dir: &str,
) -> Result<serde_json::Value, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let dest = Path::new(dest_dir);
    fs::create_dir_all(dest)
        .map_err(|e| format!("Impossible de créer le dossier de destination : {}", e))?;

    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;

    let asset_map = extract_all_zip_assets(&zip_path, dest)?;
    let thumbnail_path = extract_zip_thumbnail(&zip_path, dest)?;

    let mut result = walk_story_doc_to_entries(&doc, &asset_map)?;
    if let Some(thumb) = thumbnail_path {
        result["thumbnailImage"] = serde_json::Value::String(thumb.to_string_lossy().to_string());
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
pub struct PackEditabilityReport {
    pub editable: bool,
    pub reason: String,
    pub fidelity: Option<FidelityReport>,
    pub projected_entry_count: usize,
    pub has_native_graph: bool,
}

/// Classe un pack selon la règle produit "éditable seulement si le canonique
/// régénère fidèlement le story.json oracle" et si chaque asset référencé par
/// les stages existe réellement dans le ZIP.
pub fn classify_pack_editability(zip_path: &str) -> Result<PackEditabilityReport, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;
    let missing_assets = missing_referenced_assets(&zip_path, &doc)?;
    if !missing_assets.is_empty() {
        let rendered = missing_assets
            .iter()
            .map(|name| format!("assets/{name}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(PackEditabilityReport {
            editable: false,
            reason: format!("Asset(s) référencé(s) absent(s) du ZIP : {rendered}"),
            fidelity: None,
            projected_entry_count: 0,
            has_native_graph: false,
        });
    }
    let assets = presence_faithful_asset_map(&doc);
    let imported = match walk_story_doc_to_entries(&doc, &assets) {
        Ok(imported) => imported,
        Err(error) => {
            return Ok(PackEditabilityReport {
                editable: false,
                reason: format!("Projection Story Studio impossible : {error}"),
                fidelity: None,
                projected_entry_count: 0,
                has_native_graph: false,
            })
        }
    };

    let title = doc
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Pack importé");
    let mut project = project_from_imported_entries(&imported, title)?;
    let projected_entry_count = count_project_entries(&project.root_entries);
    let has_native_graph = imported
        .get("nativeGraph")
        .filter(|value| !value.is_null())
        .is_some();
    project.native_graph = Some(serde_json::json!({
        "preserveForRoundTrip": true,
        "document": doc,
    }));

    let canonical = canonicalize_project(&project);
    let fidelity = canonical_roundtrip_is_faithful(&canonical)?;
    let editable = projected_entry_count > 0 && fidelity.faithful;
    let reason = if editable {
        "Génération canonique fidèle au story.json d'origine.".to_string()
    } else if projected_entry_count == 0 {
        "Aucune entrée éditable projetée depuis le story.json.".to_string()
    } else {
        fidelity.gaps.first().cloned().unwrap_or_else(|| {
            "Génération canonique non fidèle au story.json d'origine.".to_string()
        })
    };

    Ok(PackEditabilityReport {
        editable,
        reason,
        fidelity: Some(fidelity),
        projected_entry_count,
        has_native_graph,
    })
}

/// Teste « à sec » si un pack est éditable par Story Studio. Retourne :
///  - `Ok(true)`  : pack fidèle → ouvrable en édition.
///  - `Ok(false)` : pack valide mais non fidèle → simulable seulement (D31).
///  - `Err(_)`    : archive invalide / illisible (ni éditable ni simulable).
pub fn check_pack_editability(zip_path: &str) -> Result<bool, String> {
    classify_pack_editability(zip_path).map(|report| report.editable)
}

fn presence_faithful_asset_map(doc: &serde_json::Value) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let Some(stages) = doc.get("stageNodes").and_then(|value| value.as_array()) else {
        return map;
    };
    for stage in stages {
        for key in ["audio", "image"] {
            let Some(raw) = stage.get(key).and_then(|value| value.as_str()) else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let short = trimmed.strip_prefix("assets/").unwrap_or(trimmed);
            if short.is_empty() {
                continue;
            }
            map.entry(short.to_string())
                .or_insert_with(|| PathBuf::from(short));
        }
    }
    map
}

fn referenced_asset_names(doc: &serde_json::Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Some(stages) = doc.get("stageNodes").and_then(|value| value.as_array()) else {
        return names;
    };
    for stage in stages {
        for key in ["audio", "image"] {
            let Some(raw) = stage.get(key).and_then(|value| value.as_str()) else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let short = trimmed.strip_prefix("assets/").unwrap_or(trimmed);
            if !short.trim().is_empty() {
                names.insert(short.to_string());
            }
        }
    }
    names
}

fn zip_asset_names(zip_path: &Path) -> Result<HashSet<String>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP assets : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Erreur lecture ZIP index {} : {}", index, e))?;
        let name = entry.name().replace('\\', "/");
        let Some(short) = name.strip_prefix("assets/") else {
            continue;
        };
        if short.is_empty() || short.ends_with('/') || short.contains('/') || short.contains("..") {
            continue;
        }
        names.insert(short.to_string());
    }
    Ok(names)
}

fn missing_referenced_assets(
    zip_path: &Path,
    doc: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let available = zip_asset_names(zip_path)?;
    Ok(referenced_asset_names(doc)
        .into_iter()
        .filter(|name| !available.contains(name))
        .collect())
}

fn project_from_imported_entries(
    imported: &serde_json::Value,
    title: &str,
) -> Result<Project, String> {
    let root_audio = imported
        .get("rootAudio")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let root_image = imported
        .get("rootImage")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode = imported
        .get("nightMode")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let auto_next = imported
        .get("autoNext")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let night_mode_audio = imported
        .get("nightModeAudio")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode_return = imported
        .get("nightModeReturn")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let night_mode_home_return = imported
        .get("nightModeHomeReturn")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let wrapper_id = imported
        .get("rootId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();

    let mut entries: Vec<ProjectEntry> =
        serde_json::from_value(imported.get("entries").cloned().unwrap_or_default())
            .map_err(|error| format!("Entrées importées invalides : {error}"))?;
    for entry in &mut entries {
        rewrite_imported_root_targets(entry, &wrapper_id);
    }

    Ok(Project {
        name: title.to_string(),
        project_type: Some("pack".to_string()),
        root_audio: root_audio.clone(),
        root_image: root_image.clone(),
        thumbnail_image: root_image,
        night_mode_audio: if night_mode { night_mode_audio } else { None },
        night_mode_return: if night_mode { night_mode_return } else { None },
        night_mode_home_return: if night_mode {
            night_mode_home_return
        } else {
            None
        },
        native_graph: imported
            .get("nativeGraph")
            .filter(|value| !value.is_null())
            .cloned(),
        pack_version: imported
            .get("packVersion")
            .and_then(|value| value.as_i64())
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or(1),
        pack_description: imported
            .get("packDescription")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        root_entries: entries,
        global_options: GlobalOptions {
            add_silence: false,
            silence_mode: None,
            add_silence_duration_sec: 1.0,
            auto_next,
            night_mode,
            harmonize_loudness: true,
        },
    })
}

fn rewrite_imported_navigation_target(target: Option<String>, wrapper_id: &str) -> Option<String> {
    let target = target?;
    if target.is_empty() {
        return None;
    }
    if target == format!("menu:{wrapper_id}") {
        Some("root".to_string())
    } else {
        Some(target)
    }
}

fn rewrite_imported_root_targets(entry: &mut ProjectEntry, wrapper_id: &str) {
    entry.return_after_play =
        rewrite_imported_navigation_target(entry.return_after_play.take(), wrapper_id);
    entry.return_on_home =
        rewrite_imported_navigation_target(entry.return_on_home.take(), wrapper_id);
    entry.title_return_on_home =
        rewrite_imported_navigation_target(entry.title_return_on_home.take(), wrapper_id);
    entry.after_playback_prompt_ok_target = rewrite_imported_navigation_target(
        entry.after_playback_prompt_ok_target.take(),
        wrapper_id,
    );
    entry.after_playback_prompt_home_target = rewrite_imported_navigation_target(
        entry.after_playback_prompt_home_target.take(),
        wrapper_id,
    );
    for step in &mut entry.after_playback_sequence {
        step.ok_target = rewrite_imported_navigation_target(step.ok_target.take(), wrapper_id);
        step.home_target = rewrite_imported_navigation_target(step.home_target.take(), wrapper_id);
    }
    for child in &mut entry.children {
        rewrite_imported_root_targets(child, wrapper_id);
    }
}

fn count_project_entries(entries: &[ProjectEntry]) -> usize {
    entries
        .iter()
        .map(|entry| 1 + count_project_entries(&entry.children))
        .sum()
}

fn read_story_json_from_zip(zip_path: &Path) -> Result<String, String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Impossible d'ouvrir le ZIP : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut entry = archive
        .by_name("story.json")
        .map_err(|_| "story.json introuvable dans le ZIP".to_string())?;
    ensure_zip_entry_size(
        "story.json",
        "story.json",
        entry.size(),
        MAX_STORY_JSON_BYTES,
    )?;
    let mut content = String::new();
    entry
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    Ok(content)
}

/// Extrait tous les fichiers `assets/*` du ZIP dans `dest_dir`.
/// Retourne une map nom_court → chemin absolu sur disque.
fn extract_all_zip_assets(
    zip_path: &Path,
    dest: &Path,
) -> Result<HashMap<String, PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP assets : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    ensure_zip_entry_count(archive.len(), zip_path)?;
    let mut map = HashMap::new();
    let mut total_asset_bytes = 0_u64;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Erreur lecture ZIP index {} : {}", i, e))?;
        let name = entry.name().to_string();
        if !name.starts_with("assets/") || name.ends_with('/') {
            continue;
        }
        let short = &name["assets/".len()..];
        if short.is_empty() || short.contains('/') || short.contains("..") {
            continue;
        }
        ensure_zip_entry_size("Asset", &name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
        total_asset_bytes = total_asset_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Taille totale des assets ZIP trop volumineuse.".to_string())?;
        ensure_total_asset_size(total_asset_bytes)?;
        let out_path = dest.join(short);
        if !out_path.exists() {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Lecture asset {} impossible : {}", name, e))?;
            fs::write(&out_path, &buf)
                .map_err(|e| format!("Écriture asset {} impossible : {}", short, e))?;
        }
        map.insert(short.to_string(), out_path);
    }
    Ok(map)
}

fn extract_zip_thumbnail(zip_path: &Path, dest: &Path) -> Result<Option<PathBuf>, String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP thumbnail : {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for name in &["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"] {
        if let Ok(mut entry) = archive.by_name(name) {
            ensure_zip_entry_size("Thumbnail", name, entry.size(), ARCHIVE_MAX_FILE_BYTES)?;
            let file_name = Path::new(name).file_name().unwrap_or_default();
            let out_path = dest.join(file_name);
            if !out_path.exists() {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Lecture thumbnail impossible : {}", e))?;
                fs::write(&out_path, &buf)
                    .map_err(|e| format!("Écriture thumbnail impossible : {}", e))?;
            }
            return Ok(Some(out_path));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{check_pack_editability, classify_pack_editability, unpack_zip_to_entries};
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "story_studio_editability_test_{}_{}_{}",
            name,
            std::process::id(),
            nanos
        ))
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create zip parent");
        }
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).expect("start zip file");
            writer.write_all(bytes).expect("write zip file");
        }
        writer.finish().expect("finish zip");
    }

    fn write_story_zip(path: &Path, story: &serde_json::Value) {
        let raw = serde_json::to_vec(story).expect("serialize story");
        write_zip(
            path,
            &[
                ("story.json", raw.as_slice()),
                ("assets/root.mp3", b"root"),
                ("assets/cover.png", b"cover"),
                ("assets/item.mp3", b"item"),
                ("assets/item.png", b"item-image"),
                ("assets/story.mp3", b"story"),
                ("assets/extra.mp3", b"extra"),
            ],
        );
    }

    fn editable_story_json() -> serde_json::Value {
        serde_json::json!({
            "title": "Pack editable",
            "version": 1,
            "description": "",
            "format": "v1",
            "nightModeAvailable": false,
            "stageNodes": [
                {
                    "uuid": "cover", "name": "Cover", "type": "stage", "squareOne": true,
                    "audio": "root.mp3", "image": "cover.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": false, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "root-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "title", "name": "Titre", "type": "stage", "squareOne": false,
                    "audio": "item.mp3", "image": "item.png",
                    "controlSettings": { "wheel": true, "ok": true, "home": true, "pause": false, "autoplay": false },
                    "okTransition": { "actionNode": "play-action", "optionIndex": 0 },
                    "homeTransition": null
                },
                {
                    "uuid": "play", "name": "Lecture", "type": "stage", "squareOne": false,
                    "audio": "story.mp3", "image": null,
                    "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                    "okTransition": null,
                    "homeTransition": { "actionNode": "root-action", "optionIndex": 0 }
                }
            ],
            "actionNodes": [
                { "id": "root-action", "name": "Root", "options": ["title"] },
                { "id": "play-action", "name": "Play", "options": ["play"] }
            ]
        })
    }

    #[test]
    fn faithful_pack_is_editable() {
        let dir = temp_dir("editable");
        let zip_path = dir.join("pack.zip");
        write_story_zip(&zip_path, &editable_story_json());

        let editable = check_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(editable);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn projectable_but_unfaithful_pack_is_not_editable() {
        let dir = temp_dir("unfaithful");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"]
            .as_array_mut()
            .expect("stages")
            .push(serde_json::json!({
                "uuid": "unreachable", "name": "Inatteignable", "type": "stage", "squareOne": false,
                "audio": "extra.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": null
            }));
        write_story_zip(&zip_path, &story);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!report.editable);
        assert!(report.fidelity.as_ref().is_some_and(|f| !f.faithful));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn canonical_generation_failure_is_not_editable() {
        let dir = temp_dir("canonical_failure");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"][1]["audio"] = serde_json::Value::Null;
        story["stageNodes"][1]["image"] = serde_json::Value::Null;
        story["stageNodes"][2]["audio"] = serde_json::Value::Null;
        write_story_zip(&zip_path, &story);

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!report.editable);
        assert!(
            report.reason.contains("échec de génération canonique")
                || report
                    .fidelity
                    .as_ref()
                    .is_some_and(|fidelity| !fidelity.faithful),
            "diagnostic inattendu : {}",
            report.reason,
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn referenced_but_missing_asset_is_not_editable() {
        let dir = temp_dir("missing_asset");
        let zip_path = dir.join("pack.zip");
        let raw = serde_json::to_vec(&editable_story_json()).expect("serialize story");
        write_zip(
            &zip_path,
            &[
                ("story.json", raw.as_slice()),
                ("assets/root.mp3", b"root"),
                ("assets/cover.png", b"cover"),
                ("assets/item.mp3", b"item"),
                ("assets/item.png", b"item-image"),
            ],
        );

        let report = classify_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");

        assert!(!report.editable);
        assert!(
            report.reason.contains("assets/story.mp3"),
            "diagnostic inattendu : {}",
            report.reason,
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn public_unpack_refuses_unfaithful_pack() {
        let dir = temp_dir("unpack_refuses_unfaithful");
        let zip_path = dir.join("pack.zip");
        let mut story = editable_story_json();
        story["stageNodes"]
            .as_array_mut()
            .expect("stages")
            .push(serde_json::json!({
                "uuid": "unreachable", "name": "Inatteignable", "type": "stage", "squareOne": false,
                "audio": "extra.mp3", "image": null,
                "controlSettings": { "wheel": false, "ok": false, "home": true, "pause": true, "autoplay": false },
                "okTransition": null,
                "homeTransition": null
            }));
        write_story_zip(&zip_path, &story);

        let error = unpack_zip_to_entries(
            zip_path.to_str().expect("utf8"),
            dir.join("out").to_str().expect("utf8"),
        )
        .expect_err("public extraction must enforce editability");

        assert!(
            error.contains("Pack non éditable"),
            "diagnostic inattendu : {error}",
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn non_pack_archive_errors() {
        let dir = temp_dir("invalid");
        let zip_path = dir.join("pack.zip");
        write_zip(&zip_path, &[("readme.txt", b"not a pack")]);

        assert!(check_pack_editability(zip_path.to_str().expect("utf8")).is_err());

        fs::remove_dir_all(dir).expect("cleanup");
    }
}
