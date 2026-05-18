use sha1::{Digest, Sha1};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::services::project_files::validate_existing_file_path;
use crate::support::archive_limits::{ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_FILE_BYTES};
use crate::support::ffmpeg::{apply_no_window, now_millis};

const IMPORTED_PACK_CACHE_DIR: &str = "story_studio_imported_pack_cache";
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
        if looks_like_studio_pack_directory(&pack_root) {
            zip_directory_to_file(&pack_root, &converted_zip)?;
        } else if looks_like_fs_pack_directory(&pack_root) {
            convert_fs_pack_directory_to_zip(
                &pack_root,
                &converted_zip,
                &fallback_pack_title(&source),
            )?;
        } else {
            return Err(format!(
                "Archive importee non reconnue : {}",
                source.display()
            ));
        }

        Ok(())
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

fn resolve_7z_path() -> Result<PathBuf, String> {
    // Override via variable d'environnement — développement uniquement.
    // En release, seul le binaire bundlé est accepté.
    #[cfg(debug_assertions)]
    if let Ok(override_path) = std::env::var("STORY_STUDIO_7Z_PATH") {
        let path = PathBuf::from(override_path);
        if path.exists() {
            return Ok(path);
        }
    }

    // Binaire bundlé (priorité absolue en release et en debug)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools").join("7z.exe");
            if bundled.exists() {
                return Ok(bundled);
            }
            let sibling = dir.join("7z.exe");
            if sibling.exists() {
                return Ok(sibling);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for base in cwd.ancestors() {
            let candidate = base.join("tools").join("7z.exe");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Fallbacks système — debug uniquement.
    // En release le binaire bundlé dans tools/ est requis.
    #[cfg(debug_assertions)]
    {
        for candidate in [
            PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
            PathBuf::from(r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe"),
        ] {
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        if let Some(found) = find_in_path("7z.exe") {
            return Ok(found);
        }
    }

    Err("7z.exe introuvable. Installez 7-Zip ou placez 7z.exe dans tools/.".to_string())
}

#[cfg(debug_assertions)]
fn find_in_path(executable: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let dir_str = dir.to_string_lossy();
        if dir_str.contains("WindowsApps") {
            continue;
        }
        let candidate = dir.join(executable);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
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
