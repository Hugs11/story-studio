use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::projection::walk_story_doc_to_entries;
use super::validation::*;
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

/// Teste « à sec » si un pack est éditable (projetable) par Story Studio, sans
/// rien extraire sur disque : la projetabilité ne dépend que de la structure du
/// `story.json`, pas des fichiers d'assets (d'où la map vide). Retourne :
///  - `Ok(true)`  : pack projetable → ouvrable en édition.
///  - `Ok(false)` : pack valide mais non projetable → simulable seulement (D31).
///  - `Err(_)`    : archive invalide / illisible (ni éditable ni simulable).
pub fn check_pack_editability(zip_path: &str) -> Result<bool, String> {
    let zip_path = ensure_studio_pack_zip(zip_path)?;
    let story_json = read_story_json_from_zip(&zip_path)?;
    let doc: serde_json::Value =
        serde_json::from_str(&story_json).map_err(|e| format!("story.json invalide : {}", e))?;
    let empty_assets: HashMap<String, PathBuf> = HashMap::new();
    let editable = match walk_story_doc_to_entries(&doc, &empty_assets) {
        Ok(result) => result
            .get("entries")
            .and_then(|entries| entries.as_array())
            .map(|entries| !entries.is_empty())
            .unwrap_or(false),
        Err(_) => false,
    };
    Ok(editable)
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
    use super::check_pack_editability;
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

    #[test]
    fn projectable_pack_is_editable() {
        let dir = temp_dir("editable");
        let zip_path = dir.join("pack.zip");
        // squareOne → action à 2 options → 2 stories feuilles = projetable.
        let story = br#"{"title":"Pack editable","stageNodes":[{"uuid":"sq","squareOne":true,"okTransition":{"actionNode":"rootAct"}},{"uuid":"s1","name":"Histoire 1"},{"uuid":"s2","name":"Histoire 2"}],"actionNodes":[{"id":"rootAct","options":["s1","s2"]}]}"#;
        write_zip(&zip_path, &[("story.json", story)]);

        let editable = check_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(editable);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn valid_pack_without_squareone_is_not_editable() {
        let dir = temp_dir("not_editable");
        let zip_path = dir.join("pack.zip");
        write_zip(&zip_path, &[("story.json", br#"{"title":"x","stageNodes":[]}"#)]);

        let editable = check_pack_editability(zip_path.to_str().expect("utf8")).expect("ok");
        assert!(!editable);

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
