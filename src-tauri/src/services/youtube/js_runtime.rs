//! Moteur JavaScript de yt-dlp : Deno, épinglé par version et SHA-256.
//!
//! yt-dlp résout les défis JavaScript de YouTube (signature, paramètre `n`) avec
//! un moteur externe, Deno par défaut. Sans lui, le support YouTube est dégradé
//! et casse dès que YouTube impose ces défis. Deno est provisionné au premier
//! usage depuis sa release officielle ; son absence n'est jamais bloquante :
//! yt-dlp tourne alors sans moteur, comme avant.

use crate::support::user_message;
use crate::support::user_message::codes;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::process::run_command_with_timeout;
use super::provision::{download_bytes, replace_file, set_executable_permissions};
use crate::support::executable::{target_for, validate_executable_bytes};
use crate::support::ffmpeg::apply_no_window;

const DENO_VERSION: &str = "2.9.7";
const DENO_DOWNLOAD_BASE: &str = "https://github.com/denoland/deno/releases/download";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ARCHIVE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
const MIN_BINARY_BYTES: u64 = 8 * 1024 * 1024;
/// Après un échec, les vidéos suivantes d'un lot ne relancent pas un
/// téléchargement de ~40 Mo voué à échouer.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DenoTarget {
    os: &'static str,
    arch: &'static str,
    asset_name: &'static str,
    archive_sha256: &'static str,
    binary_name: &'static str,
}

/// Empreintes publiées avec la release officielle `v2.9.7` (fichiers
/// `*.zip.sha256sum`). Changer de version impose de les remplacer ensemble.
const TARGETS: &[DenoTarget] = &[
    DenoTarget {
        os: "windows",
        arch: "x86_64",
        asset_name: "deno-x86_64-pc-windows-msvc.zip",
        archive_sha256: "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
        binary_name: "deno.exe",
    },
    DenoTarget {
        os: "linux",
        arch: "x86_64",
        asset_name: "deno-x86_64-unknown-linux-gnu.zip",
        archive_sha256: "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490",
        binary_name: "deno",
    },
    DenoTarget {
        os: "macos",
        arch: "aarch64",
        asset_name: "deno-aarch64-apple-darwin.zip",
        archive_sha256: "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
        binary_name: "deno",
    },
];

#[derive(Default)]
struct RuntimeState {
    ready: Option<PathBuf>,
    failed_at: Option<Instant>,
}

static STATE: OnceLock<Mutex<RuntimeState>> = OnceLock::new();

fn target_for_pair(os: &str, arch: &str) -> Option<&'static DenoTarget> {
    TARGETS
        .iter()
        .find(|target| target.os == os && target.arch == arch)
}

fn current_target() -> Option<&'static DenoTarget> {
    target_for_pair(std::env::consts::OS, std::env::consts::ARCH)
}

fn install_dir(home: &Path) -> PathBuf {
    home.join("deno").join(DENO_VERSION)
}

fn asset_url(target: &DenoTarget) -> String {
    format!("{DENO_DOWNLOAD_BASE}/v{DENO_VERSION}/{}", target.asset_name)
}

/// Chemin de Deno prêt à l'emploi, ou `None` si le moteur n'a pas pu être
/// préparé (yt-dlp fonctionne alors en mode dégradé).
pub(super) fn ensure_js_runtime(home: &Path, emit: &dyn Fn(&str)) -> Option<PathBuf> {
    let target = current_target()?;
    let state = STATE.get_or_init(|| Mutex::new(RuntimeState::default()));
    let mut state = state.lock().ok()?;
    if let Some(path) = state.ready.as_ref().filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    if state
        .failed_at
        .is_some_and(|at| at.elapsed() < RETRY_AFTER_FAILURE)
    {
        return None;
    }

    let installed = install_dir(home).join(target.binary_name);
    let result = verify_runtime(&installed).or_else(|_| install(home, target, emit));
    match result {
        Ok(path) => {
            state.ready = Some(path.clone());
            state.failed_at = None;
            Some(path)
        }
        Err(error) => {
            log::warn!(target: "youtube", "deno unavailable, yt-dlp runs without JS runtime: {error}");
            emit(codes::YOUTUBE_DENO_OPTIONAL_UNAVAILABLE_TRANSPORT);
            state.failed_at = Some(Instant::now());
            None
        }
    }
}

/// Deno déjà installé et valide, sans jamais le télécharger. `None` s'il
/// manque : yt-dlp tourne alors en mode dégradé.
pub(super) fn installed_js_runtime(home: &Path) -> Option<PathBuf> {
    let target = current_target()?;
    let state = STATE.get_or_init(|| Mutex::new(RuntimeState::default()));
    let mut state = state.lock().ok()?;
    if let Some(path) = state.ready.as_ref().filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    let path = verify_runtime(&install_dir(home).join(target.binary_name)).ok()?;
    state.ready = Some(path.clone());
    Some(path)
}

fn install(home: &Path, target: &DenoTarget, emit: &dyn Fn(&str)) -> Result<PathBuf, String> {
    emit(&{
        let _msg_deno_version = (DENO_VERSION).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_DENO_DOWNLOAD_STARTED)
            .param(
                "denoVersion",
                user_message::transport_param(_msg_deno_version.clone()),
            )
            .with_detail(format!(
                "Téléchargement du moteur JavaScript (Deno {_msg_deno_version}, ~40 Mo)…",
                _msg_deno_version = user_message::transport_detail(&_msg_deno_version),
            ))
            .into_transport()
    });
    let archive = download_bytes(
        &asset_url(target),
        MAX_ARCHIVE_BYTES,
        DOWNLOAD_TIMEOUT,
        codes::YOUTUBE_DENO_ENGINE_LABEL_TRANSPORT,
    )?;
    emit(codes::YOUTUBE_DENO_INTEGRITY_CHECK_TRANSPORT);
    verify_archive_sha256(&archive, target.archive_sha256)?;
    let binary = extract_binary(&archive, target.binary_name)?;
    let executable_target = target_for(target.os, target.arch).ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_UNSUPPORTED_DENO_TARGET)
            .with_detail("Cible Deno non prise en charge.".to_string())
            .into_transport()
    })?;
    validate_executable_bytes(&binary, executable_target).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_INCOMPATIBLE_DENO_BINARY)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Binaire Deno incompatible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;

    let dir = install_dir(home);
    std::fs::create_dir_all(&dir).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_DENO_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Création du dossier Deno impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let staging = dir.join(format!(".deno-installing-{}", Uuid::new_v4()));
    std::fs::write(&staging, &binary).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_DENO_TEMP_WRITE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Écriture temporaire de Deno impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    set_executable_permissions(&staging)?;
    if let Err(error) = verify_runtime(&staging) {
        let _ = std::fs::remove_file(&staging);
        return Err(error);
    }
    let dest = dir.join(target.binary_name);
    replace_file(&staging, &dest)?;
    remove_other_versions(home);
    emit(codes::YOUTUBE_DENO_ENGINE_READY_TRANSPORT);
    Ok(dest)
}

fn verify_archive_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(
            user_message::UserMessage::new(codes::YOUTUBE_DENO_CHECKSUM_INVALID)
                .with_detail("Intégrité de Deno invalide (SHA-256 inattendu).".to_string())
                .into_transport(),
        )
    }
}

/// L'archive officielle contient un unique exécutable à la racine. Toute autre
/// forme est refusée, et la décompression est bornée.
fn extract_binary(archive: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_UNREADABLE_DENO_ARCHIVE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Archive Deno illisible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let mut entry = zip.by_name(binary_name).map_err(|_| {
        let _msg_binary_name = (binary_name).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_DENO_ARCHIVE_MISSING)
            .param(
                "binaryName",
                user_message::transport_param(_msg_binary_name.clone()),
            )
            .with_detail(format!(
                "Archive Deno sans {_msg_binary_name}.",
                _msg_binary_name = user_message::transport_detail(&_msg_binary_name)
            ))
            .into_transport()
    })?;
    if !entry.is_file() || entry.size() > MAX_BINARY_BYTES {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_UNEXPECTED_DENO_ARCHIVE)
                .with_detail("Archive Deno inattendue.".to_string())
                .into_transport(),
        );
    }
    let mut bytes = Vec::new();
    entry
        .by_ref()
        .take(MAX_BINARY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DENO_EXTRACTION_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Extraction de Deno impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    if bytes.len() as u64 > MAX_BINARY_BYTES || (bytes.len() as u64) < MIN_BINARY_BYTES {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_DENO_BINARY_UNEXPECTED_SIZE)
                .with_detail("Binaire Deno de taille inattendue.".to_string())
                .into_transport(),
        );
    }
    Ok(bytes)
}

fn verify_runtime(path: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        user_message::UserMessage::new(codes::YOUTUBE_LOCAL_DENO_NOT_FOUND)
            .with_detail("Deno local introuvable.".to_string())
            .into_transport()
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() < MIN_BINARY_BYTES
    {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_INVALID_LOCAL_DENO)
                .with_detail("Deno local invalide.".to_string())
                .into_transport(),
        );
    }
    let mut command = Command::new(path);
    apply_no_window(&mut command);
    command.arg("--version");
    let output = run_command_with_timeout(
        command,
        VERSION_TIMEOUT,
        codes::YOUTUBE_DENO_VALIDATION_TRANSPORT,
    )?;
    let version = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !version.starts_with(&format!("deno {DENO_VERSION}")) {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_DENO_VERSION_MISMATCH)
                .with_detail("Deno local ne répond pas avec la version attendue.".to_string())
                .into_transport(),
        );
    }
    Ok(path.to_path_buf())
}

/// Une version précédente reste inutilisée une fois la nouvelle validée.
fn remove_other_versions(home: &Path) {
    let Ok(entries) = std::fs::read_dir(home.join("deno")) else {
        return;
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if is_dir && entry.file_name() != DENO_VERSION {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for (name, bytes) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn catalog_pins_every_supported_target() {
        for (os, arch) in [
            ("windows", "x86_64"),
            ("linux", "x86_64"),
            ("macos", "aarch64"),
        ] {
            let target = target_for_pair(os, arch).expect("target");
            assert_eq!(target.archive_sha256.len(), 64);
            assert!(target.archive_sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(target_for(os, arch).is_some());
            assert!(asset_url(target)
                .starts_with("https://github.com/denoland/deno/releases/download/v2.9.7/"));
        }
        assert!(target_for_pair("linux", "aarch64").is_none());
    }

    #[test]
    fn archive_hash_must_match_the_pinned_value() {
        let bytes = b"archive";
        let expected = format!("{:x}", Sha256::digest(bytes));
        assert!(verify_archive_sha256(bytes, &expected).is_ok());
        assert!(verify_archive_sha256(b"other", &expected).is_err());
    }

    #[test]
    fn extracts_only_the_expected_bounded_binary() {
        let binary = vec![7u8; MIN_BINARY_BYTES as usize];
        let archive = zip_with(&[("deno", &binary)]);
        assert_eq!(extract_binary(&archive, "deno").unwrap(), binary);
        assert!(extract_binary(&archive, "deno.exe").is_err());

        let small = zip_with(&[("deno", b"tiny")]);
        assert!(extract_binary(&small, "deno").is_err());
        assert!(extract_binary(b"not a zip", "deno").is_err());
    }

    #[test]
    fn installed_runtime_lookup_never_downloads() {
        let home = std::env::temp_dir().join(format!("story_studio_deno_home_{}", Uuid::new_v4()));
        // L'état partagé peut contenir un Deno préparé par un autre test ;
        // sans lui, l'absence est signalée sans rien créer.
        let ready = STATE
            .get()
            .and_then(|state| state.lock().ok()?.ready.clone())
            .filter(|path| path.is_file());
        assert_eq!(installed_js_runtime(&home), ready);
        assert!(!home.exists(), "aucun téléchargement n'a été tenté");
    }

    #[test]
    fn verify_rejects_missing_or_tiny_files() {
        let dir = std::env::temp_dir().join(format!("story_studio_deno_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(verify_runtime(&dir.join("deno")).is_err());
        std::fs::write(dir.join("deno"), b"x").unwrap();
        assert!(verify_runtime(&dir.join("deno")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
