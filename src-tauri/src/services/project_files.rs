use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::support::ffmpeg::{apply_no_window, get_ffmpeg_path, now_millis};
use crate::support::imported_pack::validate_existing_pack_path as validate_supported_pack_path;
use crate::support::paths::path_for_frontend;
use crate::support::temp::TEMP_IMAGES_DIR;

pub(crate) const MANAGED_PROJECT_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "images-generees",
    "fichiers-importes",
];

#[derive(serde::Serialize)]
pub struct CleanupFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(serde::Serialize)]
pub struct CleanupScanResult {
    pub unused_files: Vec<CleanupFile>,
    pub total_size: u64,
}
const MAX_RECORDING_BYTES: usize = 100 * 1024 * 1024;

pub(crate) fn project_dir_from_save_path(save_path: &str) -> Result<PathBuf, String> {
    let save_path = PathBuf::from(save_path);
    save_path
        .parent()
        .map(|dir| dir.to_path_buf())
        .ok_or_else(|| {
            format!(
                "Impossible de determiner le dossier du projet depuis {}",
                save_path.display()
            )
        })
}

pub(crate) fn ensure_managed_project_file(
    path: &str,
    save_path: Option<&str>,
) -> Result<PathBuf, String> {
    let save_path = save_path.ok_or_else(|| {
        "Suppression disque reservee aux fichiers d'un projet sauvegarde.".to_string()
    })?;
    let target = fs::canonicalize(path)
        .map_err(|e| format!("Fichier a supprimer introuvable ou inaccessible : {}", e))?;
    let project_dir = project_dir_from_save_path(save_path)?;

    for dir_name in MANAGED_PROJECT_DIRS {
        let managed_dir = project_dir.join(dir_name);
        if !managed_dir.exists() {
            continue;
        }
        let managed_dir = fs::canonicalize(&managed_dir).map_err(|e| {
            format!(
                "Impossible de verifier le dossier gere {} : {}",
                dir_name, e
            )
        })?;
        if target.starts_with(&managed_dir) {
            return Ok(target);
        }
    }

    Err(format!(
        "Refus de supprimer un fichier hors dossiers geres par Story Studio ({}) : {}",
        MANAGED_PROJECT_DIRS.join(", "),
        target.display()
    ))
}

/// Valide que `dest_dir` est situé directement sous `<workspace_dir>/zips-extraits/`.
/// Retourne le chemin canonique sûr, construit depuis la base validée + le seul
/// composant nom de `dest_dir` (toute tentative de traversée est neutralisée).
pub(crate) fn validate_unpack_dest_dir(
    dest_dir: &str,
    workspace_dir: &str,
) -> Result<PathBuf, String> {
    let zips_base = PathBuf::from(workspace_dir).join("zips-extraits");
    fs::create_dir_all(&zips_base)
        .map_err(|e| format!("Impossible de créer zips-extraits : {}", e))?;
    let zips_base_canonical = fs::canonicalize(&zips_base)
        .map_err(|e| format!("Dossier zips-extraits inaccessible : {}", e))?;

    let subdir_name = Path::new(dest_dir)
        .file_name()
        .ok_or_else(|| "Nom de sous-dossier d'extraction invalide.".to_string())?;
    let subdir_str = subdir_name.to_string_lossy();
    if subdir_str == ".."
        || subdir_str == "."
        || subdir_str.contains('/')
        || subdir_str.contains('\\')
    {
        return Err("Nom de sous-dossier d'extraction invalide.".to_string());
    }

    Ok(zips_base_canonical.join(subdir_name))
}

pub(crate) fn validate_existing_file_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{} vide.", label));
    }
    let canonical = fs::canonicalize(trimmed)
        .map_err(|e| format!("{} introuvable ou inaccessible : {}", label, e))?;
    let metadata =
        fs::metadata(&canonical).map_err(|e| format!("{} inaccessible : {}", label, e))?;
    if !metadata.is_file() {
        return Err(format!("{} invalide : {}", label, canonical.display()));
    }
    Ok(canonical)
}

pub(crate) fn validate_existing_pack_path(path: &str) -> Result<PathBuf, String> {
    validate_supported_pack_path(path)
}

fn validate_recording_filename(filename: &str) -> Result<&str, String> {
    let path = Path::new(filename);
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom d'enregistrement invalide.".to_string())?;
    if file_name != filename || file_name.trim().is_empty() {
        return Err("Nom d'enregistrement invalide.".to_string());
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("Nom d'enregistrement contient des caracteres interdits.".to_string());
    }
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("webm" | "wav")) {
        return Err("Extension d'enregistrement non prise en charge.".to_string());
    }
    Ok(file_name)
}

pub(crate) fn save_recording(
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
    filename: &str,
    data: &[u8],
) -> Result<String, String> {
    if data.is_empty() {
        return Err("Enregistrement vide.".to_string());
    }
    if data.len() > MAX_RECORDING_BYTES {
        return Err(format!(
            "Enregistrement trop volumineux (maximum {} Mo).",
            MAX_RECORDING_BYTES / 1024 / 1024
        ));
    }

    let file_name = validate_recording_filename(filename)?;
    let project_dir = workspace_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            save_path
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| project_dir_from_save_path(value).ok())
        })
        .ok_or_else(|| {
            "Definissez un emplacement de travail ou sauvegardez le projet avant d'enregistrer un audio."
                .to_string()
        })?;
    let recordings_dir = project_dir.join("enregistrements");
    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Impossible de creer le dossier d'enregistrements : {}", e))?;
    let file_path = recordings_dir.join(file_name);

    fs::write(&file_path, data)
        .map_err(|e| format!("Impossible de sauvegarder l'enregistrement : {}", e))?;
    Ok(path_for_frontend(&file_path.to_string_lossy()))
}

pub fn scan_unused_files(
    save_path: &str,
    used_paths: &[String],
) -> Result<CleanupScanResult, String> {
    let project_dir = project_dir_from_save_path(save_path)?;
    let used_normalized: std::collections::HashSet<PathBuf> = used_paths
        .iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();

    let mut unused_files: Vec<CleanupFile> = Vec::new();
    let mut total_size = 0u64;

    for dir_name in MANAGED_PROJECT_DIRS {
        let dir = project_dir.join(dir_name);
        if !dir.is_dir() {
            continue;
        }
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Impossible de lire {} : {}", dir_name, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Erreur lecture {} : {}", dir_name, e))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Les backups visibles `{stem}.original{-N}.{ext}` sont des dérivés d'édition audio :
            // on ne les propose jamais à la suppression, même si aucune entrée projet ne les référence.
            if is_original_backup(&name) {
                continue;
            }
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !used_normalized.contains(&canonical) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total_size += size;
                unused_files.push(CleanupFile {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    size,
                });
            }
        }
    }

    unused_files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(CleanupScanResult {
        unused_files,
        total_size,
    })
}

pub fn delete_unused_files(paths: &[String], save_path: &str) -> Result<usize, String> {
    let mut count = 0;
    for path in paths {
        ensure_managed_project_file(path, Some(save_path))?;
        fs::remove_file(path).map_err(|e| format!("Suppression impossible : {}", e))?;
        count += 1;
    }
    Ok(count)
}

pub fn delete_file(path: &str, save_path: Option<&str>) -> Result<(), String> {
    let validated = ensure_managed_project_file(path, save_path)?;
    fs::remove_file(&validated).map_err(|e| format!("Suppression impossible : {}", e))
}

/// Sous-dossiers du workspace dans lesquels la suppression disque est autorisée.
/// `zips-extraits` est volontairement exclu : il contient des extractions de packs
/// importés que l'utilisateur ne doit pas pouvoir purger via la médiathèque.
pub(crate) const DELETABLE_WORKSPACE_DIRS: [&str; 4] = [
    "fichiers-importes",
    "enregistrements",
    "voix-generees",
    "images-generees",
];

pub fn delete_workspace_media_file(path: &str, workspace_dir: &str) -> Result<(), String> {
    let workspace_dir = workspace_dir.trim();
    if workspace_dir.is_empty() {
        return Err("Workspace non défini : suppression disque refusée.".to_string());
    }
    let path_trimmed = path.trim();
    if path_trimmed.is_empty() {
        return Err("Chemin du fichier à supprimer vide.".to_string());
    }

    let workspace_canonical = fs::canonicalize(workspace_dir)
        .map_err(|e| format!("Workspace introuvable ou inaccessible : {}", e))?;
    let target_canonical = fs::canonicalize(path_trimmed)
        .map_err(|e| format!("Fichier à supprimer introuvable ou inaccessible : {}", e))?;

    let metadata = fs::metadata(&target_canonical)
        .map_err(|e| format!("Fichier à supprimer inaccessible : {}", e))?;
    if !metadata.is_file() {
        return Err(format!(
            "Suppression refusée : la cible n'est pas un fichier ({}).",
            target_canonical.display()
        ));
    }

    for dir_name in DELETABLE_WORKSPACE_DIRS {
        let managed_dir = workspace_canonical.join(dir_name);
        let managed_canonical = match fs::canonicalize(&managed_dir) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if target_canonical.starts_with(&managed_canonical) {
            fs::remove_file(&target_canonical)
                .map_err(|e| format!("Suppression impossible : {}", e))?;
            cascade_delete_audio_edit_artifacts(&target_canonical, &managed_canonical);
            return Ok(());
        }
    }

    Err(format!(
        "Suppression disque refusée : le fichier doit être sous workspace/{} (reçu : {}).",
        DELETABLE_WORKSPACE_DIRS.join(", workspace/"),
        target_canonical.display()
    ))
}

/// Après suppression d'un média édité, nettoie les artefacts liés :
/// - les sauvegardes originales siblings (`{stem}.original{-N}.{ext}`) dans le même dossier ;
/// - le sidecar JSON `.story-studio-audio-edits/{filename}.edit.json` ;
/// - les anciennes sauvegardes legacy `.story-studio-audio-edits/{filename}.original*`;
/// - le dot-folder `.story-studio-audio-edits/` s'il devient vide.
///
/// Toutes les opérations sont strictement bornées au dossier managé (`managed_canonical`)
/// pour éviter toute fuite hors du workspace. Les erreurs sont best-effort : si un artefact
/// ne peut pas être supprimé, on continue silencieusement.
fn cascade_delete_audio_edit_artifacts(target: &Path, managed_canonical: &Path) {
    let Some(parent) = target.parent() else {
        return;
    };
    // Garantie supplémentaire : le parent doit être à l'intérieur du dossier managé validé.
    if !parent.starts_with(managed_canonical) {
        return;
    }
    let Some(stem) = target.file_stem().and_then(OsStr::to_str) else {
        return;
    };
    let target_ext = target.extension().and_then(OsStr::to_str).unwrap_or("");
    let Some(file_name) = target.file_name().and_then(OsStr::to_str) else {
        return;
    };

    // 1) Sauvegardes siblings `{stem}.original{-N}.{ext}` dans le même dossier.
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if !is_original_backup(name) {
                continue;
            }
            // Vérifie que le stem du backup correspond au stem du média supprimé,
            // et que l'extension est la même (évite de supprimer un backup d'un autre fichier).
            let backup_stem = match path.file_stem().and_then(OsStr::to_str) {
                Some(value) => value,
                None => continue,
            };
            let backup_base = backup_stem
                .rsplit_once('.')
                .map(|(base, _)| base)
                .unwrap_or(backup_stem);
            let backup_ext = path.extension().and_then(OsStr::to_str).unwrap_or("");
            if backup_base == stem && backup_ext.eq_ignore_ascii_case(target_ext) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    // 2) Sidecar `.story-studio-audio-edits/{filename}.edit.json` + sauvegardes legacy.
    let dot_folder = parent.join(AUDIO_EDIT_DIR);
    if let Ok(dot_canonical) = fs::canonicalize(&dot_folder) {
        if dot_canonical.starts_with(managed_canonical) {
            let sidecar = dot_canonical.join(format!("{}.edit.json", file_name));
            let _ = fs::remove_file(&sidecar);
            // Legacy : tout fichier `{file_name}.original*` dans le dot-folder.
            if let Ok(entries) = fs::read_dir(&dot_canonical) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                        continue;
                    };
                    if name.starts_with(&format!("{}.original", file_name)) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
            // Nettoyage best-effort : retirer le dot-folder s'il est vide.
            let _ = fs::remove_dir(&dot_canonical);
        }
    }
}

const AUDIO_ASSEMBLY_EXTENSIONS: &[&str] = &["mp3", "ogg", "wav", "m4a", "webm", "flac", "aac"];

fn validate_audio_assembly_filename(output_file_name: &str) -> Result<String, String> {
    let trimmed = output_file_name.trim();
    let path = Path::new(trimmed);
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom du fichier final invalide.".to_string())?;
    if file_name != trimmed || file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err("Nom du fichier final invalide.".to_string());
    }
    if file_name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("Nom du fichier final contient des caractères interdits.".to_string());
    }

    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Nom du fichier final invalide.".to_string())?;
    Ok(format!("{}.mp3", stem))
}

fn unique_audio_assembly_path(target_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("audio_assemble");
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("mp3");

    let first = target_dir.join(file_name);
    if !first.exists() {
        return Ok(first);
    }

    let stamp = now_millis();
    for index in 0..1000 {
        let suffix = if index == 0 {
            format!("--{}", stamp)
        } else {
            format!("--{}-{}", stamp, index)
        };
        let candidate = target_dir.join(format!("{}{}.{}", stem, suffix, ext));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Impossible de trouver un nom de fichier disponible.".to_string())
}

fn validate_audio_assembly_input(path: &str) -> Result<PathBuf, String> {
    let input = validate_existing_file_path(path, "Fichier audio")?;
    let ext = input
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !AUDIO_ASSEMBLY_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Format audio non pris en charge pour l'assemblage : {}",
            input.display()
        ));
    }
    Ok(input)
}

fn compact_ffmpeg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "Erreur FFmpeg inconnue.".to_string();
    }
    let start = lines.len().saturating_sub(10);
    lines[start..].join("\n")
}

fn run_ffmpeg_normalize_audio(ffmpeg: &Path, input: &Path, output: &Path) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-ar")
        .arg("44100")
        .arg("-ac")
        .arg("2")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Préparation audio échouée :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

fn run_ffmpeg_make_silence(ffmpeg: &Path, duration_sec: f64, output: &Path) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("anullsrc=r=44100:cl=stereo")
        .arg("-t")
        .arg(format!("{:.3}", duration_sec))
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Création du silence échouée :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

fn concat_list_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("file '{}'\n", escaped)
}

fn run_ffmpeg_concat_audio(ffmpeg: &Path, list_path: &Path, output: &Path) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);
    cmd.arg("-y")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(list_path)
        .arg("-vn")
        .arg("-c:a")
        .arg("libmp3lame")
        .arg("-q:a")
        .arg("4")
        .arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Assemblage audio échoué :\n{}",
            compact_ffmpeg_error(&out.stderr)
        ));
    }
    Ok(())
}

pub fn concat_audio_files(
    save_path: &str,
    input_paths: &[String],
    output_file_name: &str,
    silence_between_sec: f64,
    workspace_dir: Option<&str>,
) -> Result<String, String> {
    let has_workspace = workspace_dir.map(|s| !s.trim().is_empty()).unwrap_or(false);
    if save_path.trim().is_empty() && !has_workspace {
        return Err("Enregistrez le projet avant de créer un fichier assemblé.".to_string());
    }
    if input_paths.len() < 2 {
        return Err("Sélectionnez au moins deux audios à assembler.".to_string());
    }
    if !silence_between_sec.is_finite() || !(0.0..=30.0).contains(&silence_between_sec) {
        return Err("La durée du silence doit être comprise entre 0 et 30 secondes.".to_string());
    }

    let inputs: Vec<PathBuf> = input_paths
        .iter()
        .map(|path| validate_audio_assembly_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    let output_name = validate_audio_assembly_filename(output_file_name)?;
    let target_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
        Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
        None => project_dir_from_save_path(save_path)?.join("fichiers-importes"),
    };
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
    let target_dir = fs::canonicalize(&target_dir)
        .map_err(|e| format!("Dossier fichiers-importes inaccessible : {}", e))?;
    let output_path = unique_audio_assembly_path(&target_dir, &output_name)?;

    let ffmpeg = get_ffmpeg_path()?;
    let temp_dir = std::env::temp_dir().join(format!(
        "story_studio_audio_assembly_{}_{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Impossible de créer le dossier temporaire audio : {}", e))?;

    let result = (|| {
        let silence_enabled = silence_between_sec > 0.001;
        let mut concat_entries: Vec<PathBuf> = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let wav_path = temp_dir.join(format!("part_{:03}.wav", index));
            run_ffmpeg_normalize_audio(&ffmpeg, input, &wav_path)?;
            concat_entries.push(wav_path);

            if silence_enabled && index + 1 < inputs.len() {
                let silence_path = temp_dir.join(format!("silence_{:03}.wav", index));
                run_ffmpeg_make_silence(&ffmpeg, silence_between_sec, &silence_path)?;
                concat_entries.push(silence_path);
            }
        }

        let list_path = temp_dir.join("concat.txt");
        let list_content: String = concat_entries
            .iter()
            .map(|path| concat_list_line(path))
            .collect();
        fs::write(&list_path, list_content)
            .map_err(|e| format!("Impossible de préparer la liste d'assemblage : {}", e))?;

        run_ffmpeg_concat_audio(&ffmpeg, &list_path, &output_path)?;
        Ok(path_for_frontend(&output_path.to_string_lossy()))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    if result.is_err() {
        let _ = fs::remove_file(&output_path);
    }
    result
}

fn looks_like_missing_embedded_image(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("matches no streams")
        || lower.contains("does not contain any stream")
        || lower.contains("stream map '0:v:0'")
}

pub fn extract_audio_embedded_image(audio_path: &str) -> Result<Option<String>, String> {
    let source = validate_existing_file_path(audio_path, "Fichier audio")?;
    let ffmpeg = get_ffmpeg_path()?;

    let temp_dir = std::env::temp_dir().join(TEMP_IMAGES_DIR);
    fs::create_dir_all(&temp_dir).map_err(|e| {
        format!(
            "Impossible de creer le dossier temporaire des images : {}",
            e
        )
    })?;

    let output_path = temp_dir.join(format!("metadata_{}.png", now_millis()));

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-i")
        .arg(&source)
        .arg("-an")
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg("-c:v")
        .arg("png")
        .arg(&output_path);
    apply_no_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Impossible d'extraire l'image embarquee : {}", e))?;

    if output.status.success() {
        if output_path.exists() {
            return Ok(Some(output_path.to_string_lossy().to_string()));
        }
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if looks_like_missing_embedded_image(&stderr) {
        return Ok(None);
    }

    Err(format!(
        "Impossible d'extraire l'image embarquee depuis {} : {}",
        source.display(),
        stderr.trim()
    ))
}

// ── Audio trim ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, Default)]
struct AudioEditSidecar {
    original_path: String,
    mode: String,
    start_sec: f64,
    end_sec: f64,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
}

#[derive(serde::Serialize)]
pub struct TrimAudioResult {
    pub output_path: String,
    pub path_changed: bool,
    pub original_path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AudioEditInfo {
    pub original_available: bool,
    pub original_path: Option<String>,
    pub source_path: String,
    pub mode: Option<String>,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
    pub cut_fade_sec: f64,
}

/// Dossiers gérés où un trim peut écraser le fichier en place.
/// (différent de MANAGED_PROJECT_DIRS qui exclut zips-extraits)
const TRIM_IN_PLACE_DIRS: [&str; 4] = [
    "enregistrements",
    "voix-generees",
    "fichiers-importes",
    "zips-extraits",
];

const AUDIO_EDIT_DIR: &str = ".story-studio-audio-edits";

fn audio_edit_dir_for(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Impossible de déterminer le dossier audio.".to_string())?;
    Ok(parent.join(AUDIO_EDIT_DIR))
}

fn audio_edit_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|value| value.to_string())
        .ok_or_else(|| "Nom de fichier audio invalide.".to_string())
}

fn audio_edit_sidecar_path(path: &Path) -> Result<PathBuf, String> {
    Ok(audio_edit_dir_for(path)?.join(format!("{}.edit.json", audio_edit_file_name(path)?)))
}

/// Chemin de sauvegarde de l'original, en sibling visible du fichier édité.
///
/// Convention : `{stem}.original.{ext}` à côté du fichier édité, ignoré par la
/// médiathèque et les flux d'import/scan (cf. `isOriginalBackup` côté JS et
/// `is_original_backup` côté Rust).
///
/// En cas de collision (le fichier existe déjà — autre édité du même stem, ou fichier
/// utilisateur légitime), on bascule sur `{stem}.original-2.{ext}`, puis `-3`, etc.
fn audio_edit_original_path(path: &Path, source_ext: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Impossible de déterminer le dossier audio.".to_string())?;
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Nom de fichier audio invalide.".to_string())?;
    let ext = source_ext.trim().trim_start_matches('.');

    let build = |suffix: &str| -> PathBuf {
        let name = if ext.is_empty() {
            format!("{}.original{}", stem, suffix)
        } else {
            format!("{}.original{}.{}", stem, suffix, ext)
        };
        parent.join(name)
    };

    let preferred = build("");
    if !preferred.exists() {
        return Ok(preferred);
    }
    for n in 2..=999 {
        let candidate = build(&format!("-{}", n));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Trop de variantes d'originaux existent déjà pour ce fichier audio.".to_string())
}

/// Détecte si un nom de fichier correspond à la convention de backup `{stem}.original{-N}.{ext}`.
///
/// Utilisé pour exclure ces fichiers des scans et imports.
pub fn is_original_backup(file_name: &str) -> bool {
    // On cherche un segment ".original" ou ".original-<chiffres>" juste avant l'extension finale.
    let trimmed = file_name;
    let dot = match trimmed.rfind('.') {
        Some(pos) => pos,
        None => return false,
    };
    let stem = &trimmed[..dot];
    let last_dot = match stem.rfind('.') {
        Some(pos) => pos,
        None => return false,
    };
    let candidate = &stem[last_dot + 1..];
    if candidate == "original" {
        return true;
    }
    if let Some(rest) = candidate.strip_prefix("original-") {
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

fn read_audio_edit_sidecar(path: &Path) -> Option<AudioEditSidecar> {
    let sidecar_path = audio_edit_sidecar_path(path).ok()?;
    let data = fs::read_to_string(sidecar_path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_audio_edit_sidecar(path: &Path, sidecar: &AudioEditSidecar) -> Result<(), String> {
    let dir = audio_edit_dir_for(path)?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Impossible de créer le dossier d'édition audio : {}", e))?;
    let sidecar_path = audio_edit_sidecar_path(path)?;
    let json = serde_json::to_string_pretty(sidecar)
        .map_err(|e| format!("Impossible de sérialiser l'édition audio : {}", e))?;
    fs::write(&sidecar_path, json)
        .map_err(|e| format!("Impossible d'écrire l'édition audio : {}", e))
}

fn audio_edit_source_for(input: &Path) -> PathBuf {
    read_audio_edit_sidecar(input)
        .filter(|sidecar| sidecar.mode != "chain")
        .map(|sidecar| PathBuf::from(sidecar.original_path))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| input.to_path_buf())
}

fn is_expected_audio_original_path(input: &Path, original: &Path) -> bool {
    let Some(input_parent) = input.parent() else {
        return false;
    };
    let Some(input_file_name) = input.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let Some(input_stem) = input.file_stem().and_then(OsStr::to_str) else {
        return false;
    };

    let Ok(input_parent_canonical) = fs::canonicalize(input_parent) else {
        return false;
    };
    let Ok(original_canonical) = fs::canonicalize(original) else {
        return false;
    };

    if original_canonical.parent() == Some(input_parent_canonical.as_path()) {
        let Some(original_name) = original_canonical.file_name().and_then(OsStr::to_str) else {
            return false;
        };
        if !is_original_backup(original_name) {
            return false;
        }
        let Some(original_stem) = original_canonical.file_stem().and_then(OsStr::to_str) else {
            return false;
        };
        let original_base = original_stem
            .rsplit_once('.')
            .map(|(base, _)| base)
            .unwrap_or(original_stem);
        return original_base == input_stem;
    }

    let legacy_dir = input_parent_canonical.join(AUDIO_EDIT_DIR);
    if original_canonical.parent() == Some(legacy_dir.as_path()) {
        let Some(original_name) = original_canonical.file_name().and_then(OsStr::to_str) else {
            return false;
        };
        return original_name.starts_with(&format!("{}.original", input_file_name));
    }

    false
}

fn clamp_fade(value: f64, max_duration: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else {
        value.min(max_duration.max(0.0)).min(10.0)
    }
}

fn filter_number(value: f64) -> String {
    format!("{:.3}", value.max(0.0))
}

pub fn trim_audio(
    input_path: &str,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    if start_sec < 0.0 {
        return Err("Le point de départ ne peut pas être négatif.".to_string());
    }
    if end_sec <= start_sec {
        return Err("Le point de fin doit être après le point de départ.".to_string());
    }

    let input = Path::new(input_path);
    if !input.exists() {
        return Err(format!("Fichier audio introuvable : {}", input_path));
    }

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();

    let ffmpeg = get_ffmpeg_path()?;

    let in_place = is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_trim_tmp_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_trim(
            &ffmpeg,
            input_path,
            &tmp_path.to_string_lossy(),
            start_sec,
            end_sec,
            &ext,
        )?;

        match fs::rename(&tmp_path, input) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }

        Ok(TrimAudioResult {
            output_path: path_for_frontend(input_path),
            path_changed: false,
            original_path: None,
        })
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour découper un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_trim_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_trim(
            &ffmpeg,
            input_path,
            &out_path.to_string_lossy(),
            start_sec,
            end_sec,
            &ext,
        )?;

        Ok(TrimAudioResult {
            output_path: path_for_frontend(&out_path.to_string_lossy()),
            path_changed: true,
            original_path: None,
        })
    }
}

pub fn cut_audio(
    input_path: &str,
    cut_start: f64,
    cut_end: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    if cut_start < 0.001 {
        return Err("Le point d'entrée doit être après le début du fichier.".to_string());
    }
    if cut_end <= cut_start {
        return Err("Le point de sortie doit être après le point d'entrée.".to_string());
    }

    let input = Path::new(input_path);
    if !input.exists() {
        return Err(format!("Fichier audio introuvable : {}", input_path));
    }

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();

    let ffmpeg = get_ffmpeg_path()?;

    let filter = format!(
        "[0:a]atrim=end={cs:.3},asetpts=PTS-STARTPTS[a1];\
         [0:a]atrim=start={ce:.3},asetpts=PTS-STARTPTS[a2];\
         [a1][a2]concat=n=2:v=0:a=1[out]",
        cs = cut_start,
        ce = cut_end,
    );

    let in_place = is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_cut_tmp_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_cut(
            &ffmpeg,
            input_path,
            &tmp_path.to_string_lossy(),
            &filter,
            &ext,
        )?;

        match fs::rename(&tmp_path, input) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }

        Ok(TrimAudioResult {
            output_path: path_for_frontend(input_path),
            path_changed: false,
            original_path: None,
        })
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour couper un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_cut_{}.{}", stem, now_millis(), ext));

        run_ffmpeg_cut(
            &ffmpeg,
            input_path,
            &out_path.to_string_lossy(),
            &filter,
            &ext,
        )?;

        Ok(TrimAudioResult {
            output_path: path_for_frontend(&out_path.to_string_lossy()),
            path_changed: true,
            original_path: None,
        })
    }
}

pub fn audio_edit_info(
    input_path: &str,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<AudioEditInfo, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    if save_path.is_some() || workspace_dir.is_some() {
        let _ = is_in_trim_dir(input_path, workspace_dir, save_path)?;
    }
    let sidecar = read_audio_edit_sidecar(&input);
    let original_path = sidecar
        .as_ref()
        .map(|value| PathBuf::from(&value.original_path))
        .filter(|path| path.is_file());
    let source_path = if sidecar.as_ref().map(|value| value.mode.as_str()) == Some("chain") {
        path_for_frontend(&input.to_string_lossy())
    } else {
        path_for_frontend(&original_path.as_ref().unwrap_or(&input).to_string_lossy())
    };

    Ok(AudioEditInfo {
        original_available: original_path.is_some(),
        original_path: original_path.map(|path| path_for_frontend(&path.to_string_lossy())),
        source_path,
        mode: sidecar.as_ref().map(|value| value.mode.clone()),
        start_sec: sidecar.as_ref().map(|value| value.start_sec),
        end_sec: sidecar.as_ref().map(|value| value.end_sec),
        fade_in_sec: sidecar
            .as_ref()
            .map(|value| value.fade_in_sec)
            .unwrap_or(0.0),
        fade_out_sec: sidecar
            .as_ref()
            .map(|value| value.fade_out_sec)
            .unwrap_or(0.0),
        cut_fade_sec: sidecar
            .as_ref()
            .map(|value| value.cut_fade_sec)
            .unwrap_or(0.0),
    })
}

pub fn restore_audio_original(
    input_path: &str,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    if !is_in_trim_dir(input_path, workspace_dir, save_path)? {
        return Err(
            "La restauration est réservée aux fichiers audio gérés par le projet.".to_string(),
        );
    }
    let sidecar = read_audio_edit_sidecar(&input)
        .ok_or_else(|| "Aucun original enregistré pour cet audio.".to_string())?;
    // L'original peut être soit en sibling visible (nouvelle convention),
    // soit dans `.story-studio-audio-edits/` (legacy). Les deux cas sont gérés
    // par `validate_existing_file_path` qui canonicalise et vérifie l'existence.
    let original = validate_existing_file_path(&sidecar.original_path, "Audio original")?;
    fs::copy(&original, &input)
        .map_err(|e| format!("Impossible de restaurer l'audio original : {}", e))?;
    let sidecar_parent = audio_edit_sidecar_path(&input)
        .ok()
        .and_then(|sidecar_path| {
            let parent = sidecar_path.parent().map(Path::to_path_buf);
            let _ = fs::remove_file(&sidecar_path);
            parent
        });
    // Nettoyage du fichier original désormais redondant (best-effort), uniquement
    // si le chemin correspond bien à une sauvegarde générée par Story Studio.
    if is_expected_audio_original_path(&input, &original) {
        let _ = fs::remove_file(&original);
    }
    if let Some(parent) = sidecar_parent {
        let _ = fs::remove_dir(parent); // best-effort si vide
    }
    Ok(TrimAudioResult {
        output_path: path_for_frontend(&input.to_string_lossy()),
        path_changed: false,
        original_path: Some(path_for_frontend(&original.to_string_lossy())),
    })
}

#[allow(clippy::too_many_arguments)]
pub fn preview_audio_edit(
    input_path: &str,
    mode: &str,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
) -> Result<String, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    if save_path.is_some() || workspace_dir.is_some() {
        let _ = is_in_trim_dir(input_path, workspace_dir, save_path)?;
    }
    let source = audio_edit_source_for(&input);
    let output =
        std::env::temp_dir().join(format!("story_studio_audio_preview_{}.wav", now_millis()));
    let ffmpeg = get_ffmpeg_path()?;
    run_ffmpeg_audio_edit(
        &ffmpeg,
        &source.to_string_lossy(),
        &output.to_string_lossy(),
        mode,
        start_sec,
        end_sec,
        fade_in_sec,
        fade_out_sec,
        cut_fade_sec,
        "wav",
    )?;
    Ok(path_for_frontend(&output.to_string_lossy()))
}

pub fn commit_audio_preview(
    input_path: &str,
    preview_path: &str,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    let preview = validate_existing_file_path(preview_path, "Aperçu audio")?;
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    let ffmpeg = get_ffmpeg_path()?;

    let in_place = is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    let (output, final_path, path_changed) = if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_edit_tmp_{}.{}", stem, now_millis(), ext));
        (tmp_path, input.clone(), false)
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour éditer un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_edit_{}.{}", stem, now_millis(), ext));
        (out_path.clone(), out_path, true)
    };

    let existing_sidecar = read_audio_edit_sidecar(&final_path);
    let original_path = if let Some(sidecar) = existing_sidecar {
        PathBuf::from(sidecar.original_path)
    } else {
        let source_ext = input
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(&ext);
        let original_path = audio_edit_original_path(&final_path, source_ext)?;
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier original audio : {}", e))?;
        }
        fs::copy(&input, &original_path)
            .map_err(|e| format!("Impossible de sauvegarder l'audio original : {}", e))?;
        original_path
    };

    run_ffmpeg_transcode(
        &ffmpeg,
        &preview.to_string_lossy(),
        &output.to_string_lossy(),
        &ext,
    )?;

    if !path_changed {
        match fs::rename(&output, &final_path) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&output);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }
    }

    write_audio_edit_sidecar(
        &final_path,
        &AudioEditSidecar {
            original_path: original_path.to_string_lossy().to_string(),
            mode: "chain".to_string(),
            start_sec: 0.0,
            end_sec: 0.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            cut_fade_sec: 0.0,
        },
    )?;

    Ok(TrimAudioResult {
        output_path: path_for_frontend(&final_path.to_string_lossy()),
        path_changed,
        original_path: Some(path_for_frontend(&original_path.to_string_lossy())),
    })
}

#[allow(clippy::too_many_arguments)]
pub fn apply_audio_edit(
    input_path: &str,
    mode: &str,
    start_sec: f64,
    end_sec: f64,
    save_path: Option<&str>,
    workspace_dir: Option<&str>,
    fade_in_sec: f64,
    fade_out_sec: f64,
    cut_fade_sec: f64,
) -> Result<TrimAudioResult, String> {
    let input = validate_existing_file_path(input_path, "Fichier audio")?;
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_lowercase();
    let source = audio_edit_source_for(&input);
    let ffmpeg = get_ffmpeg_path()?;

    let in_place = is_in_trim_dir(input_path, workspace_dir, save_path).unwrap_or(false);

    let (output, final_path, path_changed) = if in_place {
        let parent = input.parent().unwrap_or(Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let tmp_path = parent.join(format!("{}_edit_tmp_{}.{}", stem, now_millis(), ext));
        (tmp_path, input.clone(), false)
    } else {
        let importes_dir = match workspace_dir.filter(|s| !s.trim().is_empty()) {
            Some(ws) => PathBuf::from(ws).join("fichiers-importes"),
            None => {
                let sp = save_path.ok_or_else(|| {
                    "Définissez un emplacement de travail pour éditer un fichier externe."
                        .to_string()
                })?;
                project_dir_from_save_path(sp)?.join("fichiers-importes")
            }
        };
        fs::create_dir_all(&importes_dir)
            .map_err(|e| format!("Impossible de créer fichiers-importes : {}", e))?;
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let out_path = importes_dir.join(format!("{}_edit_{}.{}", stem, now_millis(), ext));
        (out_path.clone(), out_path, true)
    };

    let existing_sidecar = read_audio_edit_sidecar(&final_path);
    let original_path = if let Some(sidecar) = existing_sidecar {
        PathBuf::from(sidecar.original_path)
    } else {
        let source_ext = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(&ext);
        let original_path = audio_edit_original_path(&final_path, source_ext)?;
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer le dossier original audio : {}", e))?;
        }
        fs::copy(&source, &original_path)
            .map_err(|e| format!("Impossible de sauvegarder l'audio original : {}", e))?;
        original_path
    };

    run_ffmpeg_audio_edit(
        &ffmpeg,
        &source.to_string_lossy(),
        &output.to_string_lossy(),
        mode,
        start_sec,
        end_sec,
        fade_in_sec,
        fade_out_sec,
        cut_fade_sec,
        &ext,
    )?;

    if !path_changed {
        match fs::rename(&output, &final_path) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&output);
                return Err(format!(
                    "Impossible de remplacer le fichier original : {}",
                    e
                ));
            }
        }
    }

    write_audio_edit_sidecar(
        &final_path,
        &AudioEditSidecar {
            original_path: original_path.to_string_lossy().to_string(),
            mode: mode.to_string(),
            start_sec,
            end_sec,
            fade_in_sec: clamp_fade(fade_in_sec, end_sec - start_sec),
            fade_out_sec: clamp_fade(fade_out_sec, end_sec - start_sec),
            cut_fade_sec: clamp_fade(cut_fade_sec, 10.0),
        },
    )?;

    Ok(TrimAudioResult {
        output_path: path_for_frontend(&final_path.to_string_lossy()),
        path_changed,
        original_path: Some(path_for_frontend(&original_path.to_string_lossy())),
    })
}

fn run_ffmpeg_cut(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    filter: &str,
    ext: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args([
        "-y",
        "-i",
        input,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
    ]);

    match ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Suppression audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

fn audio_edit_filter(
    mode: &str,
    start: f64,
    end: f64,
    fade_in: f64,
    fade_out: f64,
    cut_fade: f64,
) -> Result<(String, String), String> {
    if start < 0.0 || !start.is_finite() || !end.is_finite() || end <= start {
        return Err("La sélection audio est invalide.".to_string());
    }

    let body_duration = (end - start).max(0.001);
    let fade_in = clamp_fade(fade_in, body_duration / 2.0);
    let fade_out = clamp_fade(fade_out, body_duration / 2.0);
    let mut post_filters = Vec::new();
    if fade_in > 0.0 {
        post_filters.push(format!("afade=t=in:st=0:d={}", filter_number(fade_in)));
    }
    if fade_out > 0.0 {
        let fade_start = (body_duration - fade_out).max(0.0);
        post_filters.push(format!(
            "afade=t=out:st={}:d={}",
            filter_number(fade_start),
            filter_number(fade_out)
        ));
    }
    let post = if post_filters.is_empty() {
        String::new()
    } else {
        format!(",{}", post_filters.join(","))
    };

    match mode {
        "trim" => Ok((
            format!(
                "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS{}[out]",
                filter_number(start),
                filter_number(end),
                post
            ),
            "out".to_string(),
        )),
        "cut" => {
            if start < 0.001 {
                if end >= 999_999.0 {
                    return Err("La suppression ne peut pas vider tout l'audio.".to_string());
                }
                let mut filters = vec![
                    format!("atrim=start={}", filter_number(end)),
                    "asetpts=PTS-STARTPTS".to_string(),
                ];
                if fade_in > 0.0 {
                    filters.push(format!("afade=t=in:st=0:d={}", filter_number(fade_in)));
                }
                return Ok((
                    format!("[0:a]{}[out]", filters.join(",")),
                    "out".to_string(),
                ));
            }
            if end >= 999_999.0 {
                return Ok((
                    format!(
                        "[0:a]atrim=end={},asetpts=PTS-STARTPTS{}[out]",
                        filter_number(start),
                        post
                    ),
                    "out".to_string(),
                ));
            }
            let cut_fade = clamp_fade(cut_fade, start.min(10.0));
            let join = if cut_fade > 0.0 {
                format!(
                    "[a1][a2]acrossfade=d={}:c1=tri:c2=tri[body];",
                    filter_number(cut_fade)
                )
            } else {
                "[a1][a2]concat=n=2:v=0:a=1[body];".to_string()
            };
            let tail = if post.is_empty() {
                "[body]anull[out]".to_string()
            } else {
                format!("[body]{}[out]", post.trim_start_matches(','))
            };
            Ok((
                format!(
                    "[0:a]atrim=end={},asetpts=PTS-STARTPTS[a1];\
                     [0:a]atrim=start={},asetpts=PTS-STARTPTS[a2];\
                     {}{}",
                    filter_number(start),
                    filter_number(end),
                    join,
                    tail
                ),
                "out".to_string(),
            ))
        }
        _ => Err("Mode d'édition audio inconnu.".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_ffmpeg_audio_edit(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    mode: &str,
    start: f64,
    end: f64,
    fade_in: f64,
    fade_out: f64,
    cut_fade: f64,
    ext: &str,
) -> Result<(), String> {
    let (filter, map_label) = audio_edit_filter(mode, start, end, fade_in, fade_out, cut_fade)?;
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args(["-y", "-i", input, "-filter_complex", &filter, "-map"]);
    cmd.arg(format!("[{}]", map_label));

    match ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        "m4a" | "aac" => {
            cmd.args(["-c:a", "aac", "-b:a", "160k"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Édition audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

fn run_ffmpeg_transcode(ffmpeg: &Path, input: &str, output: &str, ext: &str) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.args(["-y", "-i", input, "-vn"]);

    match ext {
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        "wav" => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
        "ogg" => {
            cmd.args(["-c:a", "libvorbis", "-q:a", "4"]);
        }
        "m4a" | "aac" => {
            cmd.args(["-c:a", "aac", "-b:a", "160k"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Validation audio échouée :\n{}", stderr.trim()));
    }

    Ok(())
}

fn is_in_trim_dir(
    file_path: &str,
    workspace_dir: Option<&str>,
    save_path: Option<&str>,
) -> Result<bool, String> {
    let target =
        fs::canonicalize(file_path).map_err(|e| format!("Fichier inaccessible : {}", e))?;

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(ws) = workspace_dir.filter(|s| !s.trim().is_empty()) {
        bases.push(PathBuf::from(ws));
    }
    if let Some(sp) = save_path.filter(|s| !s.trim().is_empty()) {
        if let Ok(dir) = project_dir_from_save_path(sp) {
            bases.push(dir);
        }
    }

    for base in bases {
        for dir_name in TRIM_IN_PLACE_DIRS {
            let dir = base.join(dir_name);
            if !dir.exists() {
                continue;
            }
            if let Ok(canonical) = fs::canonicalize(&dir) {
                if target.starts_with(&canonical) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn run_ffmpeg_trim(
    ffmpeg: &Path,
    input: &str,
    output: &str,
    start: f64,
    end: f64,
    ext: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    apply_no_window(&mut cmd);

    cmd.arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-ss")
        .arg(format!("{:.3}", start))
        .arg("-to")
        .arg(format!("{:.3}", end));

    match ext {
        "wav" | "flac" => {
            cmd.args(["-c", "copy"]);
        }
        "mp3" => {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "4"]);
        }
        _ => {}
    }

    cmd.arg(output);

    let out = cmd
        .output()
        .map_err(|e| format!("Impossible de lancer ffmpeg : {}", e))?;

    if !out.status.success() {
        let _ = fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Découpage audio échoué :\n{}", stderr.trim()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "luniipack_project_files_test_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ))
    }

    #[test]
    fn save_recording_requires_saved_project() {
        let err = save_recording(None, None, "recording.webm", b"audio").unwrap_err();
        assert!(err.contains("emplacement de travail"));
    }

    #[test]
    fn save_recording_rejects_unsafe_filename() {
        let err = validate_recording_filename("../recording.webm").unwrap_err();
        assert!(err.contains("invalide"));

        let err = validate_recording_filename("recording.mp3").unwrap_err();
        assert!(err.contains("Extension"));
    }

    #[test]
    fn save_recording_writes_inside_recordings_dir() {
        let project_dir = temp_project_dir("writes_inside");
        fs::create_dir_all(&project_dir).expect("create temp project dir");
        let save_path = project_dir.join("story.lunii");

        let written = save_recording(
            Some(save_path.to_str().expect("save path utf8")),
            None,
            "recording.webm",
            b"audio",
        )
        .expect("save recording");
        let written_path = PathBuf::from(&written);
        let expected_recordings_dir = project_dir.join("enregistrements");

        assert!(
            !written.starts_with(r"\\?\"),
            "path must not have UNC prefix"
        );
        assert_eq!(
            written_path.parent(),
            Some(expected_recordings_dir.as_path())
        );
        assert_eq!(fs::read(&written_path).expect("read recording"), b"audio");

        fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
    }

    #[test]
    fn audio_assembly_filename_forces_mp3_and_rejects_paths() {
        assert_eq!(
            validate_audio_assembly_filename("histoire_complete").unwrap(),
            "histoire_complete.mp3"
        );
        assert_eq!(
            validate_audio_assembly_filename("histoire_complete.wav").unwrap(),
            "histoire_complete.mp3"
        );
        let err = validate_audio_assembly_filename("../histoire.mp3").unwrap_err();
        assert!(err.contains("invalide"));
        let err = validate_audio_assembly_filename("histoire:complete.mp3").unwrap_err();
        assert!(err.contains("interdits"));
    }

    #[test]
    fn audio_assembly_unique_path_never_overwrites() {
        let project_dir = temp_project_dir("assembly_unique");
        fs::create_dir_all(&project_dir).expect("create temp project dir");
        let existing = project_dir.join("histoire.mp3");
        fs::write(&existing, b"audio").expect("write existing file");

        let next = unique_audio_assembly_path(&project_dir, "histoire.mp3").unwrap();
        assert_ne!(next, existing);
        assert_eq!(
            next.file_name()
                .and_then(OsStr::to_str)
                .unwrap()
                .split('.')
                .next()
                .unwrap(),
            next.file_stem().and_then(OsStr::to_str).unwrap()
        );
        assert!(next
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap()
            .starts_with("histoire--"));

        fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
    }

    #[test]
    fn concat_audio_files_requires_two_inputs_before_ffmpeg() {
        let err =
            concat_audio_files("C:/projet/test.mbah", &[], "sortie.mp3", 0.0, None).unwrap_err();
        assert!(err.contains("au moins deux"));
    }

    fn path_without_windows_extended_prefix(path: &Path) -> String {
        let value = path.to_string_lossy().into_owned();
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }

    #[test]
    fn concat_audio_files_smoke_with_ffmpeg_when_available() {
        let Ok(ffmpeg) = get_ffmpeg_path() else {
            return;
        };
        let project_dir = temp_project_dir("assembly_smoke");
        fs::create_dir_all(&project_dir).expect("create temp project dir");
        let input_a = project_dir.join("partie_1.wav");
        let input_b = project_dir.join("partie_2.wav");
        run_ffmpeg_make_silence(&ffmpeg, 0.05, &input_a).expect("create first wav");
        run_ffmpeg_make_silence(&ffmpeg, 0.05, &input_b).expect("create second wav");
        let save_path = project_dir.join("story.mbah");

        let output = concat_audio_files(
            save_path.to_str().unwrap(),
            &[
                input_a.to_string_lossy().to_string(),
                input_b.to_string_lossy().to_string(),
            ],
            "histoire_complete.wav",
            0.05,
            None,
        )
        .expect("concat audio files");
        let output_path = PathBuf::from(output);
        assert!(output_path.is_file());
        let expected_dir =
            fs::canonicalize(project_dir.join("fichiers-importes")).expect("canonical output dir");
        let actual_dir = output_path.parent().expect("output parent");
        assert_eq!(
            path_without_windows_extended_prefix(actual_dir),
            path_without_windows_extended_prefix(&expected_dir),
        );
        assert_eq!(
            output_path.file_name().and_then(OsStr::to_str),
            Some("histoire_complete.mp3")
        );

        fs::remove_dir_all(project_dir).expect("cleanup temp project dir");
    }

    #[test]
    fn audio_edit_filter_builds_trim_with_fades() {
        let (filter, map) =
            audio_edit_filter("trim", 1.0, 6.0, 0.5, 0.75, 0.0).expect("trim filter");
        assert_eq!(map, "out");
        assert_eq!(
            filter,
            "[0:a]atrim=start=1.000:end=6.000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.500,afade=t=out:st=4.250:d=0.750[out]"
        );
    }

    #[test]
    fn audio_edit_filter_builds_cut_with_crossfade() {
        let (filter, map) = audio_edit_filter("cut", 2.0, 4.0, 0.0, 0.0, 0.25).expect("cut filter");
        assert_eq!(map, "out");
        assert_eq!(
            filter,
            "[0:a]atrim=end=2.000,asetpts=PTS-STARTPTS[a1];[0:a]atrim=start=4.000,asetpts=PTS-STARTPTS[a2];[a1][a2]acrossfade=d=0.250:c1=tri:c2=tri[body];[body]anull[out]"
        );
    }

    #[test]
    fn audio_edit_filter_builds_cut_to_end() {
        let (filter, map) =
            audio_edit_filter("cut", 2.0, 1_000_000.0, 0.0, 0.0, 0.0).expect("cut to end filter");
        assert_eq!(map, "out");
        assert_eq!(filter, "[0:a]atrim=end=2.000,asetpts=PTS-STARTPTS[out]");
    }

    #[test]
    fn audio_edit_filter_builds_cut_from_start() {
        let (filter, map) =
            audio_edit_filter("cut", 0.0, 2.0, 0.0, 0.0, 0.0).expect("cut from start filter");
        assert_eq!(map, "out");
        assert_eq!(filter, "[0:a]atrim=start=2.000,asetpts=PTS-STARTPTS[out]");
    }

    fn temp_workspace_with_dirs(name: &str) -> PathBuf {
        let workspace = temp_project_dir(name);
        for dir in DELETABLE_WORKSPACE_DIRS {
            fs::create_dir_all(workspace.join(dir)).expect("create managed workspace dir");
        }
        fs::create_dir_all(workspace.join("zips-extraits")).expect("create zips-extraits dir");
        workspace
    }

    fn write_temp_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn delete_workspace_media_file_accepts_images_generees() {
        let workspace = temp_workspace_with_dirs("delete_images");
        let target = workspace.join("images-generees").join("img.png");
        write_temp_file(&target, b"png");

        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");
        assert!(!target.exists());

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_accepts_fichiers_importes() {
        let workspace = temp_workspace_with_dirs("delete_imports");
        let target = workspace.join("fichiers-importes").join("audio.mp3");
        write_temp_file(&target, b"mp3");

        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");
        assert!(!target.exists());

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_accepts_enregistrements() {
        let workspace = temp_workspace_with_dirs("delete_recordings");
        let target = workspace.join("enregistrements").join("rec.webm");
        write_temp_file(&target, b"rec");

        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");
        assert!(!target.exists());

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_accepts_voix_generees() {
        let workspace = temp_workspace_with_dirs("delete_voices");
        let target = workspace.join("voix-generees").join("voice.wav");
        write_temp_file(&target, b"wav");

        delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");
        assert!(!target.exists());

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_rejects_external_path() {
        let workspace = temp_workspace_with_dirs("delete_external_ws");
        let outside = temp_project_dir("delete_external_target");
        fs::create_dir_all(&outside).expect("create outside dir");
        let target = outside.join("external.mp3");
        write_temp_file(&target, b"data");

        let err =
            delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
                .unwrap_err();
        assert!(err.contains("refusée"));
        assert!(target.exists(), "external file must not be deleted");

        fs::remove_dir_all(workspace).expect("cleanup workspace");
        fs::remove_dir_all(outside).expect("cleanup outside");
    }

    #[test]
    fn delete_workspace_media_file_rejects_zips_extraits() {
        let workspace = temp_workspace_with_dirs("delete_zips");
        let target = workspace.join("zips-extraits").join("pack.json");
        write_temp_file(&target, b"{}");

        let err =
            delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
                .unwrap_err();
        assert!(err.contains("refusée"));
        assert!(target.exists(), "zips-extraits file must not be deleted");

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_rejects_directory() {
        let workspace = temp_workspace_with_dirs("delete_dir");
        let target = workspace.join("images-generees").join("subdir");
        fs::create_dir_all(&target).expect("create subdir");

        let err =
            delete_workspace_media_file(target.to_str().unwrap(), workspace.to_str().unwrap())
                .unwrap_err();
        assert!(err.contains("n'est pas un fichier"));
        assert!(target.exists(), "directory must not be deleted");

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_rejects_empty_workspace() {
        let workspace = temp_workspace_with_dirs("delete_empty_ws");
        let target = workspace.join("images-generees").join("img.png");
        write_temp_file(&target, b"png");

        let err = delete_workspace_media_file(target.to_str().unwrap(), "   ").unwrap_err();
        assert!(err.contains("Workspace non défini"));
        assert!(
            target.exists(),
            "file must not be deleted when workspace empty"
        );

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_rejects_missing_file() {
        let workspace = temp_workspace_with_dirs("delete_missing");
        let missing = workspace.join("images-generees").join("missing.png");

        let err =
            delete_workspace_media_file(missing.to_str().unwrap(), workspace.to_str().unwrap())
                .unwrap_err();
        assert!(err.contains("introuvable") || err.contains("inaccessible"));

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn is_original_backup_matches_convention() {
        assert!(is_original_backup("song.original.mp3"));
        assert!(is_original_backup("song.original-2.mp3"));
        assert!(is_original_backup("song.original-42.flac"));
        assert!(is_original_backup(r"C:\path\to\song.original.mp3"));

        assert!(!is_original_backup("song.mp3"));
        assert!(!is_original_backup("song.originals.mp3"));
        assert!(!is_original_backup("song.original-.mp3"));
        assert!(!is_original_backup("song.original-a.mp3"));
        assert!(!is_original_backup("original.mp3"));
        assert!(!is_original_backup(""));
    }

    #[test]
    fn audio_edit_original_path_returns_visible_sibling() {
        let dir = temp_project_dir("orig_sibling");
        fs::create_dir_all(&dir).expect("create dir");
        let edited = dir.join("song.mp3");
        write_temp_file(&edited, b"edited");

        let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
        assert_eq!(path, dir.join("song.original.mp3"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn audio_edit_original_path_handles_collision() {
        let dir = temp_project_dir("orig_collision");
        fs::create_dir_all(&dir).expect("create dir");
        let edited = dir.join("song.mp3");
        write_temp_file(&edited, b"edited");
        // Simule un original déjà présent.
        write_temp_file(&dir.join("song.original.mp3"), b"existing");

        let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
        assert_eq!(path, dir.join("song.original-2.mp3"));

        // Et avec deux collisions :
        write_temp_file(&dir.join("song.original-2.mp3"), b"existing-2");
        let path = audio_edit_original_path(&edited, "mp3").expect("compute original path");
        assert_eq!(path, dir.join("song.original-3.mp3"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_cascade_removes_sibling_backup_and_sidecar() {
        let workspace = temp_workspace_with_dirs("delete_cascade");
        let imports = workspace.join("fichiers-importes");
        let edited = imports.join("song.mp3");
        let backup = imports.join("song.original.mp3");
        let dot_folder = imports.join(AUDIO_EDIT_DIR);
        fs::create_dir_all(&dot_folder).expect("create dot folder");
        let sidecar = dot_folder.join("song.mp3.edit.json");
        write_temp_file(&edited, b"edited");
        write_temp_file(&backup, b"original");
        fs::write(&sidecar, b"{}").expect("write sidecar");

        delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");

        assert!(!edited.exists(), "main file removed");
        assert!(!backup.exists(), "sibling backup cascade-removed");
        assert!(!sidecar.exists(), "sidecar cascade-removed");
        assert!(!dot_folder.exists(), "empty dot folder cleaned up");

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_cascade_removes_legacy_hidden_backup() {
        let workspace = temp_workspace_with_dirs("delete_cascade_legacy");
        let imports = workspace.join("fichiers-importes");
        let edited = imports.join("song.mp3");
        let dot_folder = imports.join(AUDIO_EDIT_DIR);
        fs::create_dir_all(&dot_folder).expect("create dot folder");
        let legacy_backup = dot_folder.join("song.mp3.original.mp3");
        let sidecar = dot_folder.join("song.mp3.edit.json");
        write_temp_file(&edited, b"edited");
        write_temp_file(&legacy_backup, b"legacy original");
        fs::write(&sidecar, b"{}").expect("write sidecar");

        delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");

        assert!(!edited.exists());
        assert!(
            !legacy_backup.exists(),
            "legacy hidden backup cascade-removed"
        );
        assert!(!sidecar.exists());
        assert!(!dot_folder.exists());

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn delete_workspace_media_file_does_not_touch_unrelated_originals() {
        let workspace = temp_workspace_with_dirs("delete_isolation");
        let imports = workspace.join("fichiers-importes");
        let edited = imports.join("song.mp3");
        let unrelated_backup = imports.join("other.original.mp3");
        write_temp_file(&edited, b"edited");
        write_temp_file(&unrelated_backup, b"unrelated");

        delete_workspace_media_file(edited.to_str().unwrap(), workspace.to_str().unwrap())
            .expect("delete should succeed");

        assert!(!edited.exists());
        assert!(
            unrelated_backup.exists(),
            "backup of an unrelated file must NOT be touched"
        );

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn restore_audio_original_supports_legacy_hidden_backup() {
        let workspace = temp_workspace_with_dirs("restore_legacy");
        let imports = workspace.join("fichiers-importes");
        let edited = imports.join("song.mp3");
        let legacy_backup = imports.join(AUDIO_EDIT_DIR).join("song.mp3.original.mp3");
        write_temp_file(&edited, b"edited");
        write_temp_file(&legacy_backup, b"original");
        write_audio_edit_sidecar(
            &edited,
            &AudioEditSidecar {
                original_path: legacy_backup.to_string_lossy().to_string(),
                mode: "trim".to_string(),
                start_sec: 0.0,
                end_sec: 1.0,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                cut_fade_sec: 0.0,
            },
        )
        .expect("write sidecar");
        let sidecar = audio_edit_sidecar_path(&edited).expect("sidecar path");

        restore_audio_original(
            edited.to_str().unwrap(),
            None,
            Some(workspace.to_str().unwrap()),
        )
        .expect("restore original");

        assert_eq!(fs::read(&edited).expect("read restored"), b"original");
        assert!(!legacy_backup.exists(), "legacy backup should be consumed");
        assert!(!sidecar.exists(), "sidecar should be removed");
        assert!(
            !imports.join(AUDIO_EDIT_DIR).exists(),
            "empty legacy dot folder should be cleaned"
        );

        fs::remove_dir_all(workspace).expect("cleanup");
    }

    #[test]
    fn restore_audio_original_does_not_delete_unexpected_external_original() {
        let workspace = temp_workspace_with_dirs("restore_external_guard");
        let imports = workspace.join("fichiers-importes");
        let outside = temp_project_dir("restore_external_source");
        let edited = imports.join("song.mp3");
        let external_original = outside.join("external.mp3");
        write_temp_file(&edited, b"edited");
        write_temp_file(&external_original, b"external original");
        write_audio_edit_sidecar(
            &edited,
            &AudioEditSidecar {
                original_path: external_original.to_string_lossy().to_string(),
                mode: "trim".to_string(),
                start_sec: 0.0,
                end_sec: 1.0,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
                cut_fade_sec: 0.0,
            },
        )
        .expect("write sidecar");

        restore_audio_original(
            edited.to_str().unwrap(),
            None,
            Some(workspace.to_str().unwrap()),
        )
        .expect("restore original");

        assert_eq!(
            fs::read(&edited).expect("read restored"),
            b"external original"
        );
        assert!(
            external_original.exists(),
            "restore must not delete a sidecar path outside expected backup locations"
        );

        fs::remove_dir_all(workspace).expect("cleanup workspace");
        fs::remove_dir_all(outside).expect("cleanup outside");
    }

    #[test]
    fn scan_unused_files_skips_original_backups() {
        let dir = temp_project_dir("scan_unused");
        fs::create_dir_all(dir.join("fichiers-importes")).expect("create imports");
        let save_path = dir.join("story.mbah");
        fs::write(&save_path, b"{}").expect("create mbah");

        let used = dir.join("fichiers-importes").join("song.mp3");
        let backup = dir.join("fichiers-importes").join("song.original.mp3");
        let unused = dir.join("fichiers-importes").join("orphan.mp3");
        write_temp_file(&used, b"a");
        write_temp_file(&backup, b"b");
        write_temp_file(&unused, b"c");

        let result = scan_unused_files(
            save_path.to_str().unwrap(),
            &[used.to_string_lossy().into()],
        )
        .expect("scan");

        let names: Vec<&str> = result
            .unused_files
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        assert!(names.contains(&"orphan.mp3"), "orphan must be flagged");
        assert!(
            !names.contains(&"song.original.mp3"),
            "backup must not be flagged as unused"
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }
}
