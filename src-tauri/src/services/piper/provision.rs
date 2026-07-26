//! Provisionnement Piper multi-plateforme : télécharge une fois le binaire
//! officiel correspondant à la cible et les voix demandées dans app-data.
//!
//! Les archives et modèles sont bornés, les archives binaires sont vérifiées
//! par SHA-256, et l'exécutable extrait doit réellement correspondre au format
//! et à l'architecture de la cible avant de remplacer une installation valide.

use super::catalog::{self, ArchiveKind, BinaryEntry, VoiceEntry};
use crate::support::executable::{target_for, validate_executable_file};
use crate::support::network::{public_download_client, require_public_download_url};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

const MAX_BINARY_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BINARY_ENTRIES: usize = 4096;
const MAX_BINARY_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VOICE_MODEL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VOICE_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

static PROVISION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn bin_dir(home: &Path) -> PathBuf {
    home.join("bin")
}

fn voices_dir(home: &Path) -> PathBuf {
    home.join("voices")
}

fn current_binary() -> Result<&'static BinaryEntry, String> {
    catalog::binary_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        format!(
            "Piper n'est pas disponible pour {} / {}.",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })
}

pub(super) fn piper_exe(home: &Path) -> PathBuf {
    let name = current_binary()
        .map(|entry| entry.executable_name)
        .unwrap_or(if cfg!(target_os = "windows") {
            "piper.exe"
        } else {
            "piper"
        });
    bin_dir(home).join(name)
}

fn version_marker_in(bin: &Path) -> PathBuf {
    bin.join(".binary-version")
}

fn version_marker(home: &Path) -> PathBuf {
    version_marker_in(&bin_dir(home))
}

pub(super) fn voice_paths(home: &Path, voice_id: &str) -> (PathBuf, PathBuf) {
    let dir = voices_dir(home);
    (
        dir.join(format!("{voice_id}.onnx")),
        dir.join(format!("{voice_id}.onnx.json")),
    )
}

pub(super) fn is_binary_installed(home: &Path) -> bool {
    validate_binary_install(home).is_ok()
}

pub(super) fn is_voice_installed(home: &Path, voice_id: &str) -> bool {
    validate_voice_install(home, voice_id).is_ok()
}

fn download_bytes(
    url: &str,
    max_bytes: u64,
    service: &'static str,
    emit: &dyn Fn(&str),
) -> Result<Vec<u8>, String> {
    require_public_download_url(url, service)?;
    emit(&format!("Téléchargement {service} en cours…"));
    let client = public_download_client(DOWNLOAD_TIMEOUT, service)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("Échec du téléchargement {service} : {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Téléchargement {service} refusé (HTTP {}).",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("Téléchargement {service} anormalement volumineux."));
    }

    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Lecture du flux {service} impossible : {error}"))?;
    if bytes.is_empty() {
        return Err(format!("Téléchargement {service} vide."));
    }
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Téléchargement {service} anormalement volumineux."));
    }
    Ok(bytes)
}

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "Intégrité de {label} invalide (SHA-256 inattendu)."
        ))
    }
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Création du dossier impossible : {error}"))?;
    }
    let tmp = dest.with_extension(format!("part-{}", Uuid::new_v4()));
    std::fs::write(&tmp, bytes)
        .map_err(|error| format!("Écriture temporaire impossible : {error}"))?;
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            format!("Remplacement du fichier existant impossible : {error}")
        })?;
    }
    std::fs::rename(&tmp, dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("Finalisation du fichier impossible : {error}")
    })
}

fn validate_binary_install(home: &Path) -> Result<(), String> {
    let binary = current_binary()?;
    let exe = bin_dir(home).join(binary.executable_name);
    if !exe.is_file() {
        return Err(format!("{} introuvable.", binary.executable_name));
    }
    let version = std::fs::read_to_string(version_marker(home))
        .map_err(|_| "Version Piper locale introuvable.".to_string())?;
    if version.trim() != catalog::BINARY_VERSION {
        return Err("Version Piper locale obsolète.".to_string());
    }
    let target = target_for(binary.os, binary.arch)
        .ok_or_else(|| "Cible Piper non prise en charge.".to_string())?;
    validate_executable_file(&exe, target)?;
    let data_dir = bin_dir(home).join("espeak-ng-data");
    if !data_dir.is_dir() {
        return Err("Données espeak-ng Piper introuvables.".to_string());
    }
    Ok(())
}

fn validate_binary_staging(bin: &Path, binary: &BinaryEntry) -> Result<(), String> {
    let exe = bin.join(binary.executable_name);
    if !exe.is_file() {
        return Err(format!(
            "Archive Piper invalide : {} introuvable.",
            binary.executable_name
        ));
    }
    if !bin.join("espeak-ng-data").is_dir() {
        return Err("Archive Piper invalide : espeak-ng-data introuvable.".to_string());
    }
    let target = target_for(binary.os, binary.arch)
        .ok_or_else(|| "Cible Piper non prise en charge.".to_string())?;
    validate_executable_file(&exe, target)
        .map_err(|error| format!("Archive Piper {} refusée : {error}", binary.archive_name))
}

fn validate_voice_install(home: &Path, voice_id: &str) -> Result<(), String> {
    let (onnx, json) = voice_paths(home, voice_id);
    let metadata =
        std::fs::metadata(&onnx).map_err(|_| "Modèle Piper local introuvable.".to_string())?;
    if !metadata.is_file() || metadata.len() < 1024 * 1024 {
        return Err("Modèle Piper local incomplet.".to_string());
    }
    let json_bytes =
        std::fs::read(&json).map_err(|_| "Configuration Piper locale introuvable.".to_string())?;
    validate_voice_config(&json_bytes)
}

pub(super) fn ensure_binary(home: &Path, emit: &dyn Fn(&str)) -> Result<(), String> {
    if is_binary_installed(home) {
        return Ok(());
    }
    let binary = current_binary()?;
    emit("Préparation du moteur de voix (téléchargement unique)…");
    let bytes = download_bytes(
        binary.url,
        MAX_BINARY_ARCHIVE_BYTES,
        "du moteur Piper",
        emit,
    )?;
    verify_sha256(&bytes, binary.sha256, "l'archive Piper")?;

    let staging = home.join(format!(".bin-installing-{}", Uuid::new_v4()));
    if let Err(error) = std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Création du dossier Piper impossible : {error}"))
        .and_then(|_| extract_binary_archive(&bytes, &staging, binary.archive_kind, emit))
        .and_then(|_| validate_binary_staging(&staging, binary))
        .and_then(|_| {
            write_atomic(
                &version_marker_in(&staging),
                catalog::BINARY_VERSION.as_bytes(),
            )
        })
        .and_then(|_| replace_binary_dir(home, &staging))
    {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    emit("Moteur de voix prêt.");
    Ok(())
}

fn replace_binary_dir(home: &Path, staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(home)
        .map_err(|error| format!("Création du dossier Piper impossible : {error}"))?;
    let bin = bin_dir(home);
    let backup = home.join(format!(".bin-backup-{}", Uuid::new_v4()));

    if bin.exists() {
        std::fs::rename(&bin, &backup)
            .map_err(|error| format!("Sauvegarde de l'ancien Piper impossible : {error}"))?;
    }
    if let Err(error) = std::fs::rename(staging, &bin) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &bin);
        }
        return Err(format!("Activation de Piper impossible : {error}"));
    }
    if backup.exists() {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

fn extract_binary_archive(
    bytes: &[u8],
    dest: &Path,
    kind: ArchiveKind,
    emit: &dyn Fn(&str),
) -> Result<(), String> {
    match kind {
        ArchiveKind::Zip => extract_binary_zip(bytes, dest)?,
        ArchiveKind::TarGz => extract_binary_tar_gz(bytes, dest)?,
    }
    emit("Extraction du moteur terminée.");
    Ok(())
}

fn safe_archive_path(path: &Path) -> Result<PathBuf, String> {
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Archive Piper refusée : chemin non sûr ({}).",
                    path.display()
                ));
            }
        }
    }
    safe.strip_prefix("piper")
        .map(Path::to_path_buf)
        .or(Ok(safe))
}

fn extract_binary_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Archive Piper illisible : {error}"))?;
    if archive.len() > MAX_BINARY_ENTRIES {
        return Err("Archive Piper anormalement volumineuse (trop d'entrées).".to_string());
    }

    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Lecture entrée {index} impossible : {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Archive Piper refusée : chemin ZIP non sûr.".to_string())?;
        let stripped = safe_archive_path(&enclosed)?;
        if stripped.as_os_str().is_empty() {
            continue;
        }

        if let Some(mode) = entry.unix_mode() {
            let file_type = mode & 0o170_000;
            if file_type != 0 && file_type != 0o040_000 && file_type != 0o100_000 {
                return Err(format!(
                    "Archive Piper refusée : lien ou fichier spécial ({}).",
                    enclosed.display()
                ));
            }
        }

        let out_path = dest.join(&stripped);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|error| format!("Création dossier extrait impossible : {error}"))?;
            continue;
        }
        total_bytes = total_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Archive Piper anormalement volumineuse.".to_string())?;
        if total_bytes > MAX_BINARY_TOTAL_BYTES {
            return Err("Archive Piper anormalement volumineuse.".to_string());
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Création dossier extrait impossible : {error}"))?;
        }
        let mut output = std::fs::File::create(&out_path)
            .map_err(|error| format!("Écriture {} impossible : {error}", stripped.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Extraction {} impossible : {error}", stripped.display()))?;
    }
    Ok(())
}

fn extract_binary_tar_gz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Archive Piper illisible : {error}"))?;
    let mut count = 0_usize;
    let mut total_bytes = 0_u64;

    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Lecture d'une entrée Piper impossible : {error}"))?;
        count += 1;
        if count > MAX_BINARY_ENTRIES {
            return Err("Archive Piper anormalement volumineuse (trop d'entrées).".to_string());
        }
        let archive_path = entry
            .path()
            .map_err(|error| format!("Chemin d'archive Piper illisible : {error}"))?
            .into_owned();
        let stripped = safe_archive_path(&archive_path)?;
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        let entry_type = entry.header().entry_type();

        if entry_type.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|error| format!("Création dossier extrait impossible : {error}"))?;
            continue;
        }
        if entry_type.is_symlink() {
            extract_safe_symlink(&mut entry, dest, &out_path)?;
            continue;
        }
        if !entry_type.is_file() {
            return Err(format!(
                "Archive Piper refusée : fichier spécial ({}).",
                archive_path.display()
            ));
        }

        let size = entry.size();
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| "Archive Piper anormalement volumineuse.".to_string())?;
        if total_bytes > MAX_BINARY_TOTAL_BYTES {
            return Err("Archive Piper anormalement volumineuse.".to_string());
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Création dossier extrait impossible : {error}"))?;
        }
        let mut output = std::fs::File::create(&out_path)
            .map_err(|error| format!("Écriture {} impossible : {error}", stripped.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Extraction {} impossible : {error}", stripped.display()))?;
        apply_unix_mode(&out_path, entry.header().mode().unwrap_or(0o644))?;
    }
    Ok(())
}

fn extract_safe_symlink<R: Read>(
    entry: &mut tar::Entry<'_, R>,
    root: &Path,
    out_path: &Path,
) -> Result<(), String> {
    let target = entry
        .link_name()
        .map_err(|error| format!("Lien Piper illisible : {error}"))?
        .ok_or_else(|| "Archive Piper refusée : lien sans cible.".to_string())?;
    let safe_target = safe_link_target(&target)?;
    let parent = out_path
        .parent()
        .ok_or_else(|| "Archive Piper refusée : lien sans dossier parent.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Création dossier extrait impossible : {error}"))?;
    let resolved = normalize_join(parent, &safe_target)?;
    if !resolved.starts_with(root) {
        return Err("Archive Piper refusée : lien sortant du dossier d'installation.".to_string());
    }
    create_symlink(&safe_target, out_path)
}

fn safe_link_target(target: &Path) -> Result<PathBuf, String> {
    let mut safe = PathBuf::new();
    for component in target.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Archive Piper refusée : cible de lien non sûre ({}).",
                    target.display()
                ));
            }
        }
    }
    if safe.as_os_str().is_empty() {
        Err("Archive Piper refusée : cible de lien vide.".to_string())
    } else {
        Ok(safe)
    }
}

fn normalize_join(base: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut path = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            _ => return Err("Chemin relatif non sûr.".to_string()),
        }
    }
    Ok(path)
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|error| format!("Création du lien Piper impossible : {error}"))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link: &Path) -> Result<(), String> {
    Err("Cette archive Piper contient un lien non pris en charge sur cette plateforme.".to_string())
}

#[cfg(unix)]
fn apply_unix_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let safe_mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(safe_mode))
        .map_err(|error| format!("Permissions Unix Piper impossibles : {error}"))
}

#[cfg(not(unix))]
fn apply_unix_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

pub(super) fn ensure_voice(
    home: &Path,
    voice: &VoiceEntry,
    emit: &dyn Fn(&str),
) -> Result<(), String> {
    if is_voice_installed(home, voice.id) {
        return Ok(());
    }
    emit(&format!("Préparation de la voix « {} »…", voice.label));
    let (onnx_path, json_path) = voice_paths(home, voice.id);

    let onnx_bytes = download_bytes(&voice.onnx_url(), MAX_VOICE_MODEL_BYTES, "de la voix", emit)?;
    if onnx_bytes.len() < 1024 * 1024 {
        return Err("Modèle de voix incomplet ou corrompu.".to_string());
    }
    let json_bytes = download_bytes(
        &voice.json_url(),
        MAX_VOICE_CONFIG_BYTES,
        "de la configuration de voix",
        emit,
    )?;
    validate_voice_config(&json_bytes)?;

    write_atomic(&onnx_path, &onnx_bytes)?;
    write_atomic(&json_path, &json_bytes)?;
    emit("Voix prête.");
    Ok(())
}

fn validate_voice_config(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Configuration de voix invalide (JSON illisible).".to_string())?;
    let ok = value
        .get("audio")
        .and_then(|audio| audio.get("sample_rate"))
        .is_some_and(serde_json::Value::is_number);
    if ok {
        Ok(())
    } else {
        Err("Configuration de voix invalide (champ audio manquant).".to_string())
    }
}

pub(super) fn ensure_piper(home: &Path, voice_id: &str, emit: &dyn Fn(&str)) -> Result<(), String> {
    let voice =
        catalog::find_voice(voice_id).ok_or_else(|| format!("Voix Piper inconnue : {voice_id}"))?;

    if is_binary_installed(home) && is_voice_installed(home, voice_id) {
        return Ok(());
    }

    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Piper : verrou de provisionnement corrompu.".to_string())?;
    ensure_binary(home, emit)?;
    ensure_voice(home, voice, emit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::executable::{ExecutableArchitecture, ExecutableFormat, ExecutableTarget};
    use std::io::Write;

    fn temp_home() -> PathBuf {
        std::env::temp_dir().join(format!("story_studio_piper_test_{}", Uuid::new_v4()))
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let home = temp_home();
        let dest = home.join("file.txt");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&dest, b"old").unwrap();
        write_atomic(&dest, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn voice_install_validation_rejects_partial_model() {
        let home = temp_home();
        let (onnx, json) = voice_paths(&home, "fr_FR-siwis-medium");
        std::fs::create_dir_all(onnx.parent().unwrap()).unwrap();
        std::fs::write(&onnx, b"partial").unwrap();
        std::fs::write(&json, br#"{"audio":{"sample_rate":22050}}"#).unwrap();
        assert!(!is_voice_installed(&home, "fr_FR-siwis-medium"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn zip_extraction_rejects_traversal_and_symlinks() {
        let home = temp_home();
        std::fs::create_dir_all(&home).unwrap();

        let traversal = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(traversal);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("../outside", options).unwrap();
        writer.write_all(b"no").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(extract_binary_zip(&bytes, &home).is_err());

        let symlink = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(symlink);
        writer
            .add_symlink(
                "piper/link",
                "target",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(extract_binary_zip(&bytes, &home).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tar_extraction_accepts_internal_links_and_rejects_escaping_links() {
        let home = temp_home();
        std::fs::create_dir_all(&home).unwrap();

        let mut safe_tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(3);
        header.set_mode(0o755);
        header.set_cksum();
        safe_tar
            .append_data(&mut header, "piper/piper", Cursor::new(b"bin"))
            .unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        link.set_mode(0o777);
        link.set_link_name("piper").unwrap();
        link.set_cksum();
        safe_tar
            .append_data(&mut link, "piper/piper-link", std::io::empty())
            .unwrap();
        let tar_bytes = safe_tar.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        let bytes = encoder.finish().unwrap();
        assert!(extract_binary_tar_gz(&bytes, &home).is_ok());

        let unsafe_home = temp_home();
        std::fs::create_dir_all(&unsafe_home).unwrap();
        let mut unsafe_tar = tar::Builder::new(Vec::new());
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        link.set_mode(0o777);
        link.set_link_name("../../outside").unwrap();
        link.set_cksum();
        unsafe_tar
            .append_data(&mut link, "piper/link", std::io::empty())
            .unwrap();
        let tar_bytes = unsafe_tar.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        let bytes = encoder.finish().unwrap();
        assert!(extract_binary_tar_gz(&bytes, &unsafe_home).is_err());

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&unsafe_home);
    }

    #[test]
    fn executable_validation_rejects_wrong_architecture() {
        let mut elf_aarch64 = vec![0_u8; 64];
        elf_aarch64[..4].copy_from_slice(b"\x7fELF");
        elf_aarch64[4] = 2;
        elf_aarch64[5] = 1;
        elf_aarch64[18..20].copy_from_slice(&183_u16.to_le_bytes());
        assert!(crate::support::executable::validate_executable_bytes(
            &elf_aarch64,
            ExecutableTarget::new(ExecutableFormat::Elf, ExecutableArchitecture::X86_64)
        )
        .is_err());
    }
}
