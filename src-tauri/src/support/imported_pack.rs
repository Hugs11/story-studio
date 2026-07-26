use sha1::{Digest, Sha1};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::services::project_files::{validate_existing_dir_path, validate_existing_file_path};
use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};
use crate::support::ffmpeg::{apply_no_window, now_millis};
use crate::support::tool_resolver::{
    path_dirs, push_candidate, push_development_candidates, push_path_candidates,
    push_resource_candidates, resolve_regular_file, resource_dir,
};

const IMPORTED_PACK_CACHE_DIR: &str = "story_studio_imported_pack_cache";
// Incrémenter à chaque évolution du story.json produit par la conversion (voir
// cache_key_for_source) pour ignorer les zips convertis par une version antérieure.
const CONVERSION_FORMAT_VERSION: &str = "v2-root-uuid";
const MAX_TOTAL_EXTRACTED_BYTES: u64 = 5 * 1024 * 1024 * 1024;

pub(crate) fn validate_existing_pack_path(path: &str) -> Result<PathBuf, String> {
    let canonical = validate_existing_file_path(path, "Archive importee")?;
    let extension = pack_extension(&canonical);
    if !matches!(extension.as_deref(), Some("zip" | "7z")) {
        return Err(format!(
            "Le fichier n'est ni un ZIP ni un 7z : {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

pub(crate) fn ensure_studio_pack_zip(path: &str) -> Result<PathBuf, String> {
    let source = validate_existing_pack_path(path)?;
    let extension = pack_extension(&source);
    if extension.as_deref() == Some("zip") && zip_contains_story_json(&source)? {
        return Ok(source);
    }

    let cache_dir = std::env::temp_dir().join(IMPORTED_PACK_CACHE_DIR);
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Impossible de creer le cache des archives importees : {}",
            e
        )
    })?;
    let cache_key = cache_key_for_source(&source)?;
    let cached_zip = cache_dir.join(format!("{}.zip", cache_key));
    if cached_zip.exists() {
        if zip_contains_story_json(&cached_zip).unwrap_or(false) {
            return Ok(cached_zip);
        }
        let _ = fs::remove_file(&cached_zip);
    }

    let workspace = std::env::temp_dir().join(format!(
        "story_studio_imported_pack_{}_{}",
        now_millis(),
        cache_key,
    ));
    let extracted_dir = workspace.join("extracted");
    let converted_zip = workspace.join("converted.zip");
    fs::create_dir_all(&extracted_dir).map_err(|e| {
        format!(
            "Impossible de preparer le dossier temporaire d'import : {}",
            e
        )
    })?;

    let conversion_result = (|| -> Result<(), String> {
        match extension.as_deref() {
            Some("zip") => extract_zip_archive(&source, &extracted_dir)?,
            Some("7z") => extract_7z_archive(&source, &extracted_dir)?,
            _ => {
                return Err(format!(
                    "Format d'archive non pris en charge : {}",
                    source.display()
                ))
            }
        }

        let pack_root = locate_pack_root(&extracted_dir)?;
        convert_pack_root_to_zip(&pack_root, &converted_zip, &fallback_pack_title(&source))
    })();

    if conversion_result.is_err() {
        let _ = fs::remove_dir_all(&workspace);
    }
    conversion_result?;

    if let Some(parent) = cached_zip.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Impossible de finaliser le cache d'import : {}", e))?;
    }
    fs::copy(&converted_zip, &cached_zip).map_err(|e| {
        format!(
            "Impossible de mettre en cache l'archive convertie {} : {}",
            cached_zip.display(),
            e
        )
    })?;
    let _ = fs::remove_dir_all(&workspace);

    Ok(cached_zip)
}

/// Convertit un **dossier brut** de pack Lunii (pris directement sur la carte SD :
/// pack filesystem `ri/si/li/ni/...` ou pack Studio `story.json + assets/`) en un
/// ZIP Studio mis en cache sous `temp/`, et renvoie son chemin. Aucune archive
/// intermédiaire : on localise la racine du pack dans le dossier puis on convertit.
pub(crate) fn ensure_studio_pack_zip_from_dir(dir: &str) -> Result<PathBuf, String> {
    let source = validate_existing_dir_path(dir, "Dossier de pack importe")?;

    let cache_dir = std::env::temp_dir().join(IMPORTED_PACK_CACHE_DIR);
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Impossible de creer le cache des archives importees : {}",
            e
        )
    })?;
    let cache_key = cache_key_for_source(&source)?;
    let cached_zip = cache_dir.join(format!("{}.zip", cache_key));
    if cached_zip.exists() {
        if zip_contains_story_json(&cached_zip).unwrap_or(false) {
            return Ok(cached_zip);
        }
        let _ = fs::remove_file(&cached_zip);
    }

    let workspace = std::env::temp_dir().join(format!(
        "story_studio_imported_pack_{}_{}",
        now_millis(),
        cache_key,
    ));
    let converted_zip = workspace.join("converted.zip");
    fs::create_dir_all(&workspace).map_err(|e| {
        format!(
            "Impossible de preparer le dossier temporaire d'import : {}",
            e
        )
    })?;

    let conversion_result = (|| -> Result<(), String> {
        let pack_root = locate_pack_root(&source)?;
        convert_pack_root_to_zip(&pack_root, &converted_zip, &fallback_pack_title(&source))
    })();

    if conversion_result.is_err() {
        let _ = fs::remove_dir_all(&workspace);
    }
    conversion_result?;

    fs::copy(&converted_zip, &cached_zip).map_err(|e| {
        format!(
            "Impossible de mettre en cache l'archive convertie {} : {}",
            cached_zip.display(),
            e
        )
    })?;
    let _ = fs::remove_dir_all(&workspace);

    Ok(cached_zip)
}

/// Convertit une racine de pack déjà localisée (Studio ou filesystem) en ZIP Studio.
fn convert_pack_root_to_zip(
    pack_root: &Path,
    output_zip: &Path,
    fallback_title: &str,
) -> Result<(), String> {
    if looks_like_studio_pack_directory(pack_root) {
        zip_directory_to_file(pack_root, output_zip)
    } else if looks_like_fs_pack_directory(pack_root) {
        convert_fs_pack_directory_to_zip(pack_root, output_zip, fallback_title)
    } else {
        Err(format!(
            "Archive importee non reconnue : {}",
            pack_root.display()
        ))
    }
}

fn pack_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase())
}

fn cache_key_for_source(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| {
        format!(
            "Impossible de lire les metadonnees de {} : {}",
            path.display(),
            e
        )
    })?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let mut hasher = Sha1::new();
    // Version du format de conversion : à incrémenter quand le story.json généré change
    // (ici : ajout de l'UUID racine pour les packs natifs), pour invalider les caches
    // convertis avant le changement.
    hasher.update(CONVERSION_FORMAT_VERSION.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_string().as_bytes());
    hasher.update(modified.to_string().as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

fn fallback_pack_title(source: &Path) -> String {
    source
        .file_stem()
        .and_then(OsStr::to_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Archive importee".to_string())
}

fn zip_contains_story_json(path: &Path) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|e| format!("Impossible d'ouvrir l'archive {} : {}", path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP invalide {} : {}", path.display(), e))?;
    ensure_archive_entry_count(archive.len(), path)?;
    let has_story_json = archive.by_name("story.json").is_ok();
    Ok(has_story_json)
}

fn ensure_archive_entry_count(len: usize, source: &Path) -> Result<(), String> {
    if len > ARCHIVE_MAX_ENTRIES {
        return Err(format!(
            "Archive trop volumineuse : {} entrees dans {} (maximum {}).",
            len,
            source.display(),
            ARCHIVE_MAX_ENTRIES
        ));
    }
    Ok(())
}

fn ensure_extracted_entry_size(name: &str, size: u64) -> Result<(), String> {
    if size > ARCHIVE_MAX_FILE_BYTES {
        return Err(format!(
            "Fichier trop volumineux dans l'archive : {} fait {} Mo (maximum {} Mo).",
            name,
            size / 1024 / 1024,
            ARCHIVE_MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn extract_zip_archive(source: &Path, output_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(source)
        .map_err(|e| format!("Impossible d'ouvrir le ZIP {} : {}", source.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP invalide {} : {}", source.display(), e))?;
    ensure_archive_entry_count(archive.len(), source)?;
    let mut total_extracted_bytes = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Lecture ZIP impossible {} : {}", source.display(), e))?;
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            format!(
                "Entree ZIP invalide ou dangereuse dans {} : {}",
                source.display(),
                entry.name()
            )
        })?;
        let target = output_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| {
                format!(
                    "Impossible de creer le dossier extrait {} : {}",
                    target.display(),
                    e
                )
            })?;
            continue;
        }
        ensure_extracted_entry_size(entry.name(), entry.size())?;
        total_extracted_bytes = total_extracted_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Taille totale extraite trop volumineuse.".to_string())?;
        if total_extracted_bytes > MAX_TOTAL_EXTRACTED_BYTES {
            return Err(format!(
                "Archive trop volumineuse : {} Mo a extraire (maximum {} Mo).",
                total_extracted_bytes / 1024 / 1024,
                MAX_TOTAL_EXTRACTED_BYTES / 1024 / 1024
            ));
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Impossible de preparer le dossier d'extraction {} : {}",
                    parent.display(),
                    e
                )
            })?;
        }

        let mut out = fs::File::create(&target).map_err(|e| {
            format!(
                "Impossible de creer le fichier extrait {} : {}",
                target.display(),
                e
            )
        })?;
        std::io::copy(&mut entry, &mut out).map_err(|e| {
            format!(
                "Impossible d'extraire {} depuis {} : {}",
                target.display(),
                source.display(),
                e
            )
        })?;
    }

    Ok(())
}

fn extract_7z_archive(source: &Path, output_dir: &Path) -> Result<(), String> {
    let seven_zip = resolve_7z_path()?;
    let mut cmd = Command::new(&seven_zip);
    apply_no_window(&mut cmd);
    let output = cmd
        .arg("x")
        .arg("-y")
        .arg(format!("-o{}", output_dir.display()))
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            format!(
                "Impossible de lancer 7z pour extraire {} : {}",
                source.display(),
                e
            )
        })?;

    if output.status.success() {
        validate_extracted_tree_limits(output_dir)?;
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "Extraction 7z impossible pour {}.\n{}\n{}",
        source.display(),
        stdout.trim(),
        stderr.trim()
    ))
}

fn validate_extracted_tree_limits(root: &Path) -> Result<(), String> {
    let mut stack = vec![root.to_path_buf()];
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)
            .map_err(|e| format!("Impossible de verifier {} : {}", dir.display(), e))?
        {
            let entry = entry.map_err(|e| format!("Lecture dossier impossible : {}", e))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|e| format!("Metadonnees inaccessibles {} : {}", path.display(), e))?;
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            file_count += 1;
            if file_count > ARCHIVE_MAX_ENTRIES {
                return Err(format!(
                    "Archive trop volumineuse apres extraction : plus de {} fichiers.",
                    ARCHIVE_MAX_ENTRIES
                ));
            }
            ensure_extracted_entry_size(&path.to_string_lossy(), metadata.len())?;
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "Taille totale extraite trop volumineuse.".to_string())?;
            if total_bytes > MAX_TOTAL_EXTRACTED_BYTES {
                return Err(format!(
                    "Archive trop volumineuse apres extraction : {} Mo (maximum {} Mo).",
                    total_bytes / 1024 / 1024,
                    MAX_TOTAL_EXTRACTED_BYTES / 1024 / 1024
                ));
            }
        }
    }

    Ok(())
}

fn seven_zip_binary_names(platform: &str) -> &'static [&'static str] {
    if platform == "windows" {
        &["7z.exe"]
    } else {
        &["7zz", "7z"]
    }
}

struct SevenZipResolutionContext<'a> {
    platform: &'a str,
    debug: bool,
    override_path: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    current_exe: Option<PathBuf>,
    cwd: Option<PathBuf>,
    path_dirs: Vec<PathBuf>,
}

fn seven_zip_candidates(context: &SevenZipResolutionContext<'_>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = seven_zip_binary_names(context.platform);

    if context.debug {
        if let Some(path) = &context.override_path {
            push_candidate(&mut candidates, path.clone());
        }
    }

    push_resource_candidates(&mut candidates, context.resource_dir.as_deref(), names);

    if context.platform == "windows" {
        if let Some(exe_dir) = context.current_exe.as_deref().and_then(Path::parent) {
            for name in names {
                push_candidate(&mut candidates, exe_dir.join("tools").join(name));
                push_candidate(&mut candidates, exe_dir.join(name));
            }
        }
    }

    if context.debug {
        push_development_candidates(
            &mut candidates,
            context.cwd.as_deref(),
            context.platform,
            names,
        );
        if context.platform == "windows" {
            for candidate in [
                PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
                PathBuf::from(r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe"),
            ] {
                push_candidate(&mut candidates, candidate);
            }
        }
        let filtered_path_dirs = context
            .path_dirs
            .iter()
            .filter(|dir| !dir.to_string_lossy().contains("WindowsApps"))
            .cloned()
            .collect::<Vec<_>>();
        push_path_candidates(&mut candidates, &filtered_path_dirs, names);
    }

    candidates
}

fn resolve_7z_path() -> Result<PathBuf, String> {
    let context = SevenZipResolutionContext {
        platform: std::env::consts::OS,
        debug: cfg!(debug_assertions),
        override_path: std::env::var_os("STORY_STUDIO_7Z_PATH").map(PathBuf::from),
        resource_dir: resource_dir(),
        current_exe: std::env::current_exe().ok(),
        cwd: std::env::current_dir().ok(),
        path_dirs: path_dirs(std::env::var_os("PATH")),
    };
    resolve_regular_file("7-Zip", seven_zip_candidates(&context))
}

fn locate_pack_root(extracted_dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    collect_pack_candidates(extracted_dir, 3, &mut candidates)?;
    candidates.sort_by_key(|path| path.components().count());
    candidates.dedup();

    match candidates.len() {
        0 => Err(format!(
            "Aucun pack Lunii reconnu apres extraction dans {}",
            extracted_dir.display()
        )),
        1 => Ok(candidates.remove(0)),
        _ => Err(format!(
            "Plusieurs packs ont ete detectes dans la meme archive ({}). Une seule histoire par archive est prise en charge.",
            extracted_dir.display()
        )),
    }
}

fn collect_pack_candidates(
    dir: &Path,
    depth: usize,
    candidates: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if looks_like_studio_pack_directory(dir) || looks_like_fs_pack_directory(dir) {
        candidates.push(dir.to_path_buf());
        return Ok(());
    }

    if depth == 0 {
        return Ok(());
    }

    for entry in fs::read_dir(dir)
        .map_err(|e| format!("Impossible de parcourir {} : {}", dir.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Lecture dossier impossible : {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_pack_candidates(&path, depth - 1, candidates)?;
        }
    }

    Ok(())
}

fn looks_like_studio_pack_directory(dir: &Path) -> bool {
    dir.join("story.json").is_file() && dir.join("assets").is_dir()
}

fn looks_like_fs_pack_directory(dir: &Path) -> bool {
    dir.join("ri").is_file()
        && dir.join("si").is_file()
        && dir.join("li").is_file()
        && dir.join("ni").is_file()
        && dir.join("rf").is_dir()
        && dir.join("sf").is_dir()
}

fn zip_directory_to_file(source_dir: &Path, output_zip: &Path) -> Result<(), String> {
    let out_file = fs::File::create(output_zip)
        .map_err(|e| format!("Impossible de creer {} : {}", output_zip.display(), e))?;
    let mut writer = zip::ZipWriter::new(out_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut stack = vec![source_dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)
            .map_err(|e| format!("Impossible de lire {} : {}", current.display(), e))?
        {
            let entry = entry.map_err(|e| format!("Lecture dossier impossible : {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(source_dir)
                .map_err(|e| format!("Chemin archive invalide {} : {}", path.display(), e))?;
            let entry_name = relative
                .components()
                .filter_map(component_to_archive_part)
                .collect::<Vec<_>>()
                .join("/");

            let bytes = fs::read(&path)
                .map_err(|e| format!("Impossible de lire {} : {}", path.display(), e))?;
            writer
                .start_file(entry_name, options)
                .map_err(|e| format!("Impossible d'ecrire ZIP {} : {}", output_zip.display(), e))?;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("Impossible d'ecrire ZIP {} : {}", output_zip.display(), e))?;
        }
    }

    writer.finish().map_err(|e| {
        format!(
            "Finalisation ZIP impossible {} : {}",
            output_zip.display(),
            e
        )
    })?;
    Ok(())
}

fn component_to_archive_part(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(value) => Some(value.to_string_lossy().replace('\\', "/")),
        _ => None,
    }
}

fn convert_fs_pack_directory_to_zip(
    pack_dir: &Path,
    output_zip: &Path,
    fallback_title: &str,
) -> Result<(), String> {
    crate::support::fs_pack_reader::read_fs_pack_to_studio_zip(pack_dir, output_zip, fallback_title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_import_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "story_studio_imported_pack_test_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
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

    fn seven_zip_context(platform: &'static str) -> SevenZipResolutionContext<'static> {
        SevenZipResolutionContext {
            platform,
            debug: true,
            override_path: None,
            resource_dir: None,
            current_exe: None,
            cwd: None,
            path_dirs: Vec::new(),
        }
    }

    #[test]
    fn seven_zip_names_match_platform() {
        assert_eq!(seven_zip_binary_names("windows"), &["7z.exe"]);
        assert_eq!(seven_zip_binary_names("linux"), &["7zz", "7z"]);
    }

    #[test]
    fn seven_zip_override_precedes_packaged_resource() {
        let dir = temp_import_dir("seven_zip_override");
        let override_path = dir.join("custom 7z");
        let resource_path = dir.join("resources/tools/7z");
        fs::create_dir_all(resource_path.parent().expect("resource parent"))
            .expect("create resource dir");
        fs::write(&override_path, b"override").expect("write override");
        fs::write(&resource_path, b"resource").expect("write resource");

        let mut context = seven_zip_context("linux");
        context.override_path = Some(override_path.clone());
        context.resource_dir = Some(dir.join("resources"));
        let resolved = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect("resolve override");
        assert_eq!(resolved, override_path);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn seven_zip_packaged_resource_precedes_development_and_path() {
        let dir = temp_import_dir("seven_zip_resource");
        let resource_path = dir.join("resources/tools/7z");
        let dev_path = dir.join("src-tauri/tools/linux/7z");
        let path_binary = dir.join("bin/7z");
        for path in [&resource_path, &dev_path, &path_binary] {
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, b"tool").expect("write tool");
        }

        let mut context = seven_zip_context("linux");
        context.resource_dir = Some(dir.join("resources"));
        context.cwd = Some(dir.clone());
        context.path_dirs = vec![dir.join("bin")];
        let resolved = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect("resolve resource");
        assert_eq!(resolved, resource_path);

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn seven_zip_missing_error_lists_candidates() {
        let dir = temp_import_dir("seven_zip_missing");
        let mut context = seven_zip_context("linux");
        context.resource_dir = Some(dir.join("resources"));
        let error = resolve_regular_file("7-Zip", seven_zip_candidates(&context))
            .expect_err("missing tool");
        assert!(error.contains("7-Zip introuvable"));
        assert!(error.contains("resources/tools/7zz"));
        assert!(error.contains("resources/tools/7z"));
    }

    #[test]
    fn extracts_small_seven_zip_fixture_when_tool_is_available() {
        let Ok(seven_zip) = resolve_7z_path() else {
            return;
        };
        let dir = temp_import_dir("seven_zip_fixture").join("Dossier Été");
        let source_dir = dir.join("source avec espaces");
        let archive = dir.join("Pack Été.7z");
        let extracted = dir.join("extrait avec espaces");
        fs::create_dir_all(source_dir.join("assets/Médias été")).expect("create fixture source");
        fs::write(
            source_dir.join("story.json"),
            br#"{"title":"Fixture 7z","stageNodes":[]}"#,
        )
        .expect("write fixture story");
        fs::write(source_dir.join("assets/Médias été/A.txt"), b"upper")
            .expect("write uppercase fixture asset");
        fs::write(source_dir.join("assets/Médias été/a.txt"), b"lower")
            .expect("write lowercase fixture asset");
        fs::create_dir_all(&extracted).expect("create extraction dir");

        let mut create = Command::new(&seven_zip);
        apply_no_window(&mut create);
        let output = create
            .current_dir(&source_dir)
            .args(["a", "-y"])
            .arg(&archive)
            .arg("story.json")
            .arg("assets")
            .output()
            .expect("launch 7-Zip fixture creation");
        assert!(
            output.status.success(),
            "7-Zip fixture creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        extract_7z_archive(&archive, &extracted).expect("extract fixture");
        assert!(extracted.join("story.json").is_file());
        assert_eq!(
            fs::read(extracted.join("assets/Médias été/A.txt")).expect("read uppercase asset"),
            b"upper"
        );
        assert_eq!(
            fs::read(extracted.join("assets/Médias été/a.txt")).expect("read lowercase asset"),
            b"lower"
        );

        fs::remove_dir_all(dir.parent().expect("temp import parent"))
            .expect("cleanup temp import dir");
    }

    #[test]
    fn extracts_zip_with_spaces_accents_and_case_distinct_entries() {
        let dir = temp_import_dir("zip_unicode_case").join("Dossier Été");
        let archive = dir.join("Pack Été.zip");
        let extracted = dir.join("extrait avec espaces");
        write_zip(
            &archive,
            &[
                ("story.json", br#"{"title":"Fixture ZIP","stageNodes":[]}"#),
                ("assets/Médias été/A.txt", b"upper"),
                ("assets/Médias été/a.txt", b"lower"),
            ],
        );
        fs::create_dir_all(&extracted).expect("create zip extraction dir");

        extract_zip_archive(&archive, &extracted).expect("extract unicode zip fixture");

        assert_eq!(
            fs::read(extracted.join("assets/Médias été/A.txt")).expect("read uppercase zip asset"),
            b"upper"
        );
        assert_eq!(
            fs::read(extracted.join("assets/Médias été/a.txt")).expect("read lowercase zip asset"),
            b"lower"
        );

        fs::remove_dir_all(dir.parent().expect("temp import parent"))
            .expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_returns_valid_studio_zip_source() {
        let dir = temp_import_dir("studio_zip");
        let zip_path = dir.join("pack.zip");
        write_zip(
            &zip_path,
            &[
                ("story.json", br#"{"title":"Pack test","stageNodes":[]}"#),
                ("assets/image.png", b"png"),
            ],
        );

        let resolved =
            ensure_studio_pack_zip(zip_path.to_str().expect("zip path utf8")).expect("valid zip");
        assert_eq!(
            resolved,
            fs::canonicalize(&zip_path).expect("canonical zip")
        );

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_rejects_non_archive_file() {
        let dir = temp_import_dir("non_archive");
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("pack.txt");
        fs::write(&path, b"not an archive").expect("write file");

        let err =
            ensure_studio_pack_zip(path.to_str().expect("path utf8")).expect_err("reject txt");
        assert!(err.contains("ni un ZIP ni un 7z"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn validate_existing_pack_path_accepts_7z_extension_before_conversion() {
        let dir = temp_import_dir("seven_zip_extension");
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("pack.7z");
        fs::write(&path, b"not a real 7z").expect("write fake 7z");

        let resolved = validate_existing_pack_path(path.to_str().expect("path utf8"))
            .expect("7z extension accepted before conversion");
        assert_eq!(resolved, fs::canonicalize(&path).expect("canonical 7z"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_rejects_zip_without_pack_shape() {
        let dir = temp_import_dir("zip_without_story");
        let zip_path = dir.join("pack.zip");
        write_zip(&zip_path, &[("readme.txt", b"not a story pack")]);

        let err = ensure_studio_pack_zip(zip_path.to_str().expect("zip path utf8"))
            .expect_err("reject unrecognized zip");
        assert!(err.contains("non reconnue") || err.contains("Aucun pack Lunii reconnu"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_from_dir_converts_studio_directory() {
        let dir = temp_import_dir("studio_dir");
        let pack_dir = dir.join("pack");
        fs::create_dir_all(pack_dir.join("assets")).expect("create pack dir");
        fs::write(
            pack_dir.join("story.json"),
            br#"{"title":"Dir pack","stageNodes":[]}"#,
        )
        .expect("write story.json");
        fs::write(pack_dir.join("assets").join("a.png"), b"png").expect("write asset");

        let zip = ensure_studio_pack_zip_from_dir(pack_dir.to_str().expect("path utf8"))
            .expect("convert studio directory");
        assert!(zip_contains_story_json(&zip).expect("converted zip has story.json"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn ensure_studio_pack_zip_from_dir_rejects_non_pack_directory() {
        let dir = temp_import_dir("non_pack_dir");
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::write(dir.join("readme.txt"), b"not a pack").expect("write file");

        let err = ensure_studio_pack_zip_from_dir(dir.to_str().expect("path utf8"))
            .expect_err("reject non-pack directory");
        assert!(err.contains("Aucun pack Lunii reconnu") || err.contains("non reconnue"));

        fs::remove_dir_all(dir).expect("cleanup temp import dir");
    }

    #[test]
    fn archive_limits_report_explicit_errors() {
        let err = ensure_archive_entry_count(ARCHIVE_MAX_ENTRIES + 1, Path::new("large.zip"))
            .unwrap_err();
        assert!(err.contains("Archive trop volumineuse"));

        let err = ensure_extracted_entry_size("assets/audio.mp3", ARCHIVE_MAX_FILE_BYTES + 1)
            .unwrap_err();
        assert!(err.contains("Fichier trop volumineux"));
    }
}
