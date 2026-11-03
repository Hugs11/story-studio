//! Provisionnement yt-dlp multi-plateforme.
//!
//! La dernière release officielle est résolue une fois via l'API GitHub, puis
//! l'asset natif et `SHA2-256SUMS` sont téléchargés depuis ce tag immuable.
//! Le format, l'architecture, le hash et `yt-dlp --version` sont validés avant
//! l'activation atomique. Une copie installée valide reste utilisable si une
//! mise à jour périodique échoue.

use crate::support::executable::{target_for, validate_executable_bytes, validate_executable_file};
use crate::support::ffmpeg::apply_no_window;
use crate::support::network::{public_download_client, require_public_download_url};
use crate::support::user_message;
use crate::support::user_message::codes;
#[cfg(test)]
use crate::support::user_message::MessageTransportAssertions as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use super::process::run_command_with_timeout;

const RELEASE_API_URL: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const SUMS_ASSET: &str = "SHA2-256SUMS";

const API_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const SUMS_TIMEOUT: Duration = Duration::from_secs(60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const UPDATE_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MIN_BINARY_BYTES: u64 = 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_API_BYTES: u64 = 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 1024 * 1024;

static PROVISION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct YtdlpTarget {
    os: &'static str,
    arch: &'static str,
    asset_name: &'static str,
    installed_name: &'static str,
}

const TARGETS: &[YtdlpTarget] = &[
    YtdlpTarget {
        os: "windows",
        arch: "x86_64",
        asset_name: "yt-dlp.exe",
        installed_name: "yt-dlp.exe",
    },
    YtdlpTarget {
        os: "linux",
        arch: "x86_64",
        asset_name: "yt-dlp_linux",
        installed_name: "yt-dlp",
    },
    YtdlpTarget {
        os: "macos",
        arch: "aarch64",
        asset_name: "yt-dlp_macos",
        installed_name: "yt-dlp",
    },
];

fn target_for_pair(os: &str, arch: &str) -> Option<&'static YtdlpTarget> {
    TARGETS
        .iter()
        .find(|target| target.os == os && target.arch == arch)
}

fn current_target() -> Result<&'static YtdlpTarget, String> {
    target_for_pair(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        {
            let _msg_std_env_consts_os = (std::env::consts::OS).to_string();
            let _msg_std_env_consts_arch = (std::env::consts::ARCH).to_string();
            user_message::UserMessage::new(
                codes::YOUTUBE_YTDLP_NOT_AVAILABLE,
            )
                .param(
                    "operatingSystem",
                    user_message::transport_param(_msg_std_env_consts_os.clone()),
                )
                .param(
                    "architecture",
                    user_message::transport_param(_msg_std_env_consts_arch.clone()),
                )
                .with_detail(format!(
                    "yt-dlp n'est pas disponible pour {_msg_std_env_consts_os} / {_msg_std_env_consts_arch}.",
                    _msg_std_env_consts_arch = user_message::transport_detail(&_msg_std_env_consts_arch),
                    _msg_std_env_consts_os = user_message::transport_detail(&_msg_std_env_consts_os),
                ))
                .into_transport()
            }
    })
}

fn bin_dir(home: &Path) -> PathBuf {
    home.join("bin")
}

fn ytdlp_exe(home: &Path) -> PathBuf {
    let name = current_target()
        .map(|target| target.installed_name)
        .unwrap_or(if cfg!(target_os = "windows") {
            "yt-dlp.exe"
        } else {
            "yt-dlp"
        });
    bin_dir(home).join(name)
}

fn update_marker(home: &Path) -> PathBuf {
    bin_dir(home).join(".last-update")
}

fn marker_is_fresh(home: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(update_marker(home)) else {
        return false;
    };
    let Ok(stamp_ms) = text.trim().parse::<u128>() else {
        return false;
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    now_ms.saturating_sub(stamp_ms) < UPDATE_INTERVAL.as_millis()
}

fn touch_marker(home: &Path) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let _ = write_atomic(&update_marker(home), now_ms.to_string().as_bytes());
}

fn custom_path_valid(custom: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = custom.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let target = current_target()?;
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_EXECUTABLE_FILE_MISSING)
                .with_detail("le fichier n'existe pas.".to_string())
                .into_transport(),
        );
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let lowercase = name.to_ascii_lowercase();
    if !lowercase.starts_with("yt-dlp") {
        return Err({
            let _msg_target_installed_name = (target.installed_name).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_EXECUTABLE_FILE_REQUIRED)
                .param(
                    "targetInstalledName",
                    user_message::transport_param(_msg_target_installed_name.clone()),
                )
                .with_detail(format!(
                    "le fichier doit être un exécutable {_msg_target_installed_name}.",
                    _msg_target_installed_name =
                        user_message::transport_detail(&_msg_target_installed_name)
                ))
                .into_transport()
        });
    }
    if target.os == "windows" {
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
        {
            return Err(
                user_message::UserMessage::new(codes::YOUTUBE_YTDLP_EXE_REQUIRED)
                    .with_detail("le fichier doit être un exécutable yt-dlp.exe.".to_string())
                    .into_transport(),
            );
        }
    } else if path.extension().is_some() {
        return Err({
            let _msg_target_installed_name = (target.installed_name).to_string();
            user_message::UserMessage::new(
                codes::YOUTUBE_YTDLP_NATIVE_NAME_REQUIRED,
            )
                .param(
                    "targetInstalledName",
                    user_message::transport_param(_msg_target_installed_name.clone()),
                )
                .with_detail(format!(
                    "le fichier doit porter le nom natif {_msg_target_installed_name} sans extension.",
                    _msg_target_installed_name = user_message::transport_detail(&_msg_target_installed_name),
                ))
                .into_transport()
        });
    }
    validate_target_file(&path, target)?;
    Ok(Some(path))
}

pub(super) fn ensure_ytdlp(
    home: &Path,
    custom: Option<&str>,
    emit: &dyn Fn(&str),
) -> Result<PathBuf, String> {
    if let Some(raw) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        match custom_path_valid(Some(raw)).and_then(verify_ytdlp) {
            Ok(Some(path)) => return Ok(path),
            Ok(None) => {}
            Err(error) => emit(&{
                let _msg_error = (error).to_string();
                user_message::UserMessage::new(codes::YOUTUBE_CUSTOM_YTDLP_PATH_IGNORED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Chemin yt-dlp personnalisé ignoré : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            }),
        }
    }

    if marker_is_fresh(home) {
        if let Ok(Some(path)) = verify_ytdlp(Some(ytdlp_exe(home))) {
            return Ok(path);
        }
    }

    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_LOCK_CORRUPTED)
            .with_detail("yt-dlp : verrou de provisionnement corrompu.".to_string())
            .into_transport()
    })?;

    if marker_is_fresh(home) {
        if let Ok(Some(path)) = verify_ytdlp(Some(ytdlp_exe(home))) {
            return Ok(path);
        }
    }

    let installed = verify_ytdlp(Some(ytdlp_exe(home))).ok().flatten();
    match download_latest(home, emit) {
        Ok(path) => Ok(path),
        Err(error) if installed.is_some() => {
            log::warn!(target: "youtube", "yt-dlp refresh failed, keeping installed copy: {error}");
            emit(codes::YOUTUBE_YTDLP_UPDATE_FAILED_TRANSPORT);
            Ok(installed.expect("installed copy checked above"))
        }
        Err(error) => Err(error),
    }
}

/// yt-dlp déjà présent, sans aucun téléchargement ni mise à jour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InstalledYtdlp {
    pub(super) path: PathBuf,
    /// Copie gérée par l'application dont la mise à jour périodique est due.
    /// Toujours `false` pour un chemin personnalisé, que l'application ne met
    /// pas à jour.
    pub(super) update_due: bool,
}

/// Mode « outils installés uniquement » : chemin personnalisé valide, sinon
/// copie installée valide même si son marqueur de mise à jour est périmé.
/// Ne télécharge jamais ; `None` si aucun yt-dlp utilisable n'est présent.
pub(super) fn installed_ytdlp(
    home: &Path,
    custom: Option<&str>,
    emit: &dyn Fn(&str),
) -> Option<InstalledYtdlp> {
    installed_ytdlp_with(
        home,
        custom,
        emit,
        &|raw| custom_path_valid(Some(raw)).and_then(verify_ytdlp),
        &|path| verify_ytdlp(Some(path)),
    )
}

fn installed_ytdlp_with(
    home: &Path,
    custom: Option<&str>,
    emit: &dyn Fn(&str),
    verify_custom: &dyn Fn(&str) -> Result<Option<PathBuf>, String>,
    verify_installed: &dyn Fn(PathBuf) -> Result<Option<PathBuf>, String>,
) -> Option<InstalledYtdlp> {
    if let Some(raw) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        match verify_custom(raw) {
            Ok(Some(path)) => {
                return Some(InstalledYtdlp {
                    path,
                    update_due: false,
                })
            }
            Ok(None) => {}
            Err(error) => emit(&{
                let _msg_error = (error).to_string();
                user_message::UserMessage::new(codes::YOUTUBE_CUSTOM_YTDLP_PATH_IGNORED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Chemin yt-dlp personnalisé ignoré : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            }),
        }
    }
    let path = verify_installed(ytdlp_exe(home)).ok().flatten()?;
    Some(InstalledYtdlp {
        path,
        update_due: !marker_is_fresh(home),
    })
}

fn verify_ytdlp(path: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.is_file() {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_LOCAL_YTDLP_NOT_FOUND)
                .with_detail("yt-dlp local introuvable.".to_string())
                .into_transport(),
        );
    }
    validate_target_file(&path, current_target()?)?;
    let mut command = Command::new(&path);
    apply_no_window(&mut command);
    command.arg("--version");
    let output = run_command_with_timeout(
        command,
        VERSION_TIMEOUT,
        codes::YOUTUBE_YTDLP_VALIDATION_TRANSPORT,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err({
            let ytdlp_stderr_message = (stderr
                .trim()
                .lines()
                .last()
                .unwrap_or(codes::YOUTUBE_UNKNOWN_ERROR_TRANSPORT))
            .to_string();
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_VERSION_FAILED)
                .param(
                    "error",
                    user_message::transport_param(ytdlp_stderr_message.clone()),
                )
                .with_detail(format!(
                    "yt-dlp --version a échoué : {ytdlp_stderr_message}",
                    ytdlp_stderr_message = user_message::transport_detail(&ytdlp_stderr_message)
                ))
                .into_transport()
        });
    }
    let version = String::from_utf8_lossy(&output.stdout);
    if !version.chars().any(|character| character.is_ascii_digit()) {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_VERSION_UNREADABLE)
                .with_detail("yt-dlp --version n'a pas renvoyé de version lisible.".to_string())
                .into_transport(),
        );
    }
    Ok(Some(path))
}

pub(crate) fn update_ytdlp(home: &Path, emit: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_LOCK_CORRUPTED)
            .with_detail("yt-dlp : verrou de provisionnement corrompu.".to_string())
            .into_transport()
    })?;
    download_latest(home, emit)
}

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
}

fn latest_release_tag() -> Result<String, String> {
    let bytes = download_bytes(
        RELEASE_API_URL,
        MAX_API_BYTES,
        API_TIMEOUT,
        codes::YOUTUBE_YTDLP_RELEASE_LABEL_TRANSPORT,
    )?;
    let release: LatestRelease = serde_json::from_slice(&bytes).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_RELEASE_UNREADABLE)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Réponse de release yt-dlp illisible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    validate_release_tag(&release.tag_name)?;
    Ok(release.tag_name)
}

fn validate_release_tag(tag: &str) -> Result<(), String> {
    let valid = !tag.is_empty()
        && tag.len() <= 32
        && tag
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, '.' | '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_RELEASE_TAG_INVALID)
                .with_detail("Tag de release yt-dlp invalide.".to_string())
                .into_transport(),
        )
    }
}

fn release_asset_url(tag: &str, asset: &str) -> Result<String, String> {
    validate_release_tag(tag)?;
    if asset.is_empty()
        || asset.len() > 64
        || !asset.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_ASSET_NAME_INVALID)
                .with_detail("Nom d'asset yt-dlp invalide.".to_string())
                .into_transport(),
        );
    }
    Ok(format!("{RELEASE_DOWNLOAD_BASE}/{tag}/{asset}"))
}

fn download_latest(home: &Path, emit: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let target = current_target()?;
    emit(codes::YOUTUBE_YTDLP_RELEASE_SEARCH_TRANSPORT);
    let tag = latest_release_tag()?;
    let binary_url = release_asset_url(&tag, target.asset_name)?;
    let sums_url = release_asset_url(&tag, SUMS_ASSET)?;

    emit(&{
        let _msg_tag = (tag).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_PREPARE_START)
            .param("tag", user_message::transport_param(_msg_tag.clone()))
            .with_detail(format!(
                "Préparation de yt-dlp {_msg_tag}…",
                _msg_tag = user_message::transport_detail(&_msg_tag)
            ))
            .into_transport()
    });
    let bytes = download_bytes(&binary_url, MAX_BINARY_BYTES, DOWNLOAD_TIMEOUT, "de yt-dlp")?;
    if (bytes.len() as u64) < MIN_BINARY_BYTES {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_BINARY_INCOMPLETE)
                .with_detail(
                    "Binaire yt-dlp anormalement petit (téléchargement incomplet ?).".to_string(),
                )
                .into_transport(),
        );
    }
    validate_target_bytes(&bytes, target)?;

    emit(codes::YOUTUBE_YTDLP_INTEGRITY_CHECK_TRANSPORT);
    let sums = download_bytes(
        &sums_url,
        MAX_SUMS_BYTES,
        SUMS_TIMEOUT,
        codes::YOUTUBE_YTDLP_CHECKSUM_LABEL_TRANSPORT,
    )?;
    let expected = parse_sha256_sum(&String::from_utf8_lossy(&sums), target.asset_name)
        .ok_or_else(|| {
            let _msg_target_asset_name = (target.asset_name).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_CHECKSUM_NOT_FOUND)
                .param(
                    "targetAssetName",
                    user_message::transport_param(_msg_target_asset_name.clone()),
                )
                .with_detail(format!(
                    "Somme de contrôle yt-dlp introuvable pour {_msg_target_asset_name}.",
                    _msg_target_asset_name =
                        user_message::transport_detail(&_msg_target_asset_name)
                ))
                .into_transport()
        })?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(
            user_message::UserMessage::new(codes::YOUTUBE_YTDLP_CHECKSUM_INVALID)
                .with_detail(
                    "Intégrité de yt-dlp invalide (la somme de contrôle ne correspond pas)."
                        .to_string(),
                )
                .into_transport(),
        );
    }

    let exe = ytdlp_exe(home);
    let parent = exe.parent().ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_INVALID_YTDLP_FOLDER)
            .with_detail("Dossier yt-dlp invalide.".to_string())
            .into_transport()
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_FOLDER_CREATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Création du dossier impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let staging = parent.join(format!(".yt-dlp-installing-{}", Uuid::new_v4()));
    std::fs::write(&staging, &bytes).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_TEMP_WRITE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Écriture temporaire de yt-dlp impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    set_executable_permissions(&staging)?;

    if let Err(error) = verify_ytdlp(Some(staging.clone())) {
        let _ = std::fs::remove_file(&staging);
        return Err(error);
    }
    replace_file(&staging, &exe)?;
    touch_marker(home);
    emit(codes::YOUTUBE_YTDLP_READY_TRANSPORT);
    Ok(exe)
}

fn validate_target_bytes(bytes: &[u8], target: &YtdlpTarget) -> Result<(), String> {
    let executable_target = target_for(target.os, target.arch).ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_UNSUPPORTED_YTDLP_TARGET)
            .with_detail("Cible yt-dlp non prise en charge.".to_string())
            .into_transport()
    })?;
    validate_executable_bytes(bytes, executable_target).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_INCOMPATIBLE_YTDLP_BINARY)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Binaire yt-dlp incompatible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

fn validate_target_file(path: &Path, target: &YtdlpTarget) -> Result<(), String> {
    let executable_target = target_for(target.os, target.arch).ok_or_else(|| {
        user_message::UserMessage::new(codes::YOUTUBE_UNSUPPORTED_YTDLP_TARGET)
            .with_detail("Cible yt-dlp non prise en charge.".to_string())
            .into_transport()
    })?;
    validate_executable_file(path, executable_target).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_INCOMPATIBLE_YTDLP_BINARY)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Binaire yt-dlp incompatible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

fn parse_sha256_sum(text: &str, asset: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next().unwrap_or("");
        let file = name.rsplit(['/', '*']).next().unwrap_or(name);
        if file == asset && hash.len() == 64 && hash.chars().all(|value| value.is_ascii_hexdigit())
        {
            return Some(hash.to_string());
        }
    }
    None
}

pub(super) fn download_bytes(
    url: &str,
    max_bytes: u64,
    timeout: Duration,
    service: &str,
) -> Result<Vec<u8>, String> {
    require_public_download_url(url, service)?;
    let client = public_download_client(timeout, service)?;
    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "Story-Studio")
        .send()
        .map_err(|error| {
            let _msg_service = (service).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_REQUEST_FAILED)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Échec du téléchargement {_msg_service} : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        })?;
    if !response.status().is_success() {
        return Err({
            let _msg_service = (service).to_string();
            let _msg_response = (response.status()).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_HTTP_REFUSED)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .param(
                    "response",
                    user_message::transport_param(_msg_response.clone()),
                )
                .with_detail(format!(
                    "Téléchargement {_msg_service} refusé (HTTP {_msg_response}).",
                    _msg_response = user_message::transport_detail(&_msg_response),
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err({
            let _msg_service = (service).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_SIZE_LIMIT)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .with_detail(format!(
                    "Téléchargement {_msg_service} anormalement volumineux.",
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        });
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| {
            let _msg_service = (service).to_string();
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_STREAM_UNREADABLE)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Lecture du flux {_msg_service} impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error),
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        })?;
    if bytes.is_empty() {
        return Err({
            let _msg_service = (service).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_CONTENT_EMPTY)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .with_detail(format!(
                    "Téléchargement {_msg_service} vide.",
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        });
    }
    if bytes.len() as u64 > max_bytes {
        return Err({
            let _msg_service = (service).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_SIZE_LIMIT)
                .param(
                    "service",
                    user_message::transport_param(_msg_service.clone()),
                )
                .with_detail(format!(
                    "Téléchargement {_msg_service} anormalement volumineux.",
                    _msg_service = user_message::transport_detail(&_msg_service)
                ))
                .into_transport()
        });
    }
    Ok(bytes)
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_FOLDER_CREATE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Création du dossier impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    }
    let tmp = dest.with_extension(format!("part-{}", Uuid::new_v4()));
    std::fs::write(&tmp, bytes).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_FILE_WRITE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Écriture impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    replace_file(&tmp, dest)
}

pub(super) fn replace_file(staging: &Path, dest: &Path) -> Result<(), String> {
    let backup = dest.with_extension(format!("backup-{}", Uuid::new_v4()));
    if dest.exists() {
        std::fs::rename(dest, &backup).map_err(|error| {
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_BACKUP_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Sauvegarde du fichier existant impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        })?;
    }
    if let Err(error) = std::fs::rename(staging, dest) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, dest);
        }
        return Err({
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::YOUTUBE_DOWNLOAD_FINALIZE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Finalisation du fichier impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        });
    }
    if backup.exists() {
        let _ = std::fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn set_executable_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::YOUTUBE_YTDLP_PERMISSIONS_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Permissions Unix yt-dlp impossibles : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

#[cfg(not(unix))]
pub(super) fn set_executable_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        std::env::temp_dir().join(format!("story_studio_ytdlp_test_{}", Uuid::new_v4()))
    }

    fn elf_x86_64() -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
        bytes
    }

    #[test]
    fn catalog_covers_supported_targets() {
        assert_eq!(
            target_for_pair("windows", "x86_64")
                .expect("Windows")
                .asset_name,
            "yt-dlp.exe"
        );
        assert_eq!(
            target_for_pair("linux", "x86_64")
                .expect("Linux")
                .asset_name,
            "yt-dlp_linux"
        );
        assert_eq!(
            target_for_pair("macos", "aarch64")
                .expect("macOS")
                .asset_name,
            "yt-dlp_macos"
        );
        assert!(target_for_pair("macos", "x86_64").is_none());
    }

    #[test]
    fn parses_sha256_for_each_native_asset() {
        let sums = "\
1111111111111111111111111111111111111111111111111111111111111111  yt-dlp.exe\n\
2222222222222222222222222222222222222222222222222222222222222222  yt-dlp_linux\n\
3333333333333333333333333333333333333333333333333333333333333333 *yt-dlp_macos\n";
        for target in TARGETS {
            assert!(parse_sha256_sum(sums, target.asset_name).is_some());
        }
        assert!(parse_sha256_sum("abc123  yt-dlp.exe", "yt-dlp.exe").is_none());
    }

    #[test]
    fn release_urls_are_immutable_and_validated() {
        assert_eq!(
            release_asset_url("2026.07.04", "yt-dlp_linux").unwrap(),
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux"
        );
        assert!(release_asset_url("../latest", "yt-dlp_linux").is_err());
        assert!(release_asset_url("2026.07.04", "../asset").is_err());
    }

    #[test]
    fn target_validation_rejects_wrong_architecture() {
        let linux = target_for_pair("linux", "x86_64").unwrap();
        assert!(validate_target_bytes(&elf_x86_64(), linux).is_ok());
        let mut aarch64 = elf_x86_64();
        aarch64[18..20].copy_from_slice(&183_u16.to_le_bytes());
        assert!(validate_target_bytes(&aarch64, linux).is_err());
    }

    #[test]
    fn custom_path_requires_existing_native_file() {
        assert!(custom_path_valid(None).unwrap().is_none());
        assert!(custom_path_valid(Some("   ")).unwrap().is_none());
        assert!(custom_path_valid(Some("/does/not/exist/yt-dlp")).is_err());

        let home = temp_home();
        std::fs::create_dir_all(&home).unwrap();
        let target = current_target().unwrap();
        let executable = home.join(target.installed_name);
        let bytes = match target.os {
            "linux" => elf_x86_64(),
            "windows" => {
                let mut bytes = vec![0_u8; 128];
                bytes[..2].copy_from_slice(b"MZ");
                bytes[0x3c..0x40].copy_from_slice(&64_u32.to_le_bytes());
                bytes[64..68].copy_from_slice(b"PE\0\0");
                bytes[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
                bytes
            }
            "macos" => {
                let mut bytes = vec![0_u8; 64];
                bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
                bytes[4..8].copy_from_slice(&0x0100_000c_u32.to_le_bytes());
                bytes
            }
            _ => unreachable!(),
        };
        std::fs::write(&executable, bytes).unwrap();
        assert_eq!(
            custom_path_valid(Some(executable.to_str().unwrap())).unwrap(),
            Some(executable.clone())
        );
        let wrong_name = home.join(if target.os == "windows" {
            "notepad.exe"
        } else {
            "not-yt-dlp"
        });
        std::fs::write(&wrong_name, b"invalid").unwrap();
        assert!(custom_path_valid(Some(wrong_name.to_str().unwrap())).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    fn fake_verify(path: PathBuf) -> Result<Option<PathBuf>, String> {
        if path.is_file() {
            Ok(Some(path))
        } else {
            Err("yt-dlp local introuvable.".to_string())
        }
    }

    fn no_custom(_: &str) -> Result<Option<PathBuf>, String> {
        Err("le fichier n'existe pas.".to_string())
    }

    #[test]
    fn installed_only_never_creates_a_missing_tool() {
        let home = temp_home();
        let found = installed_ytdlp_with(&home, None, &|_| {}, &no_custom, &fake_verify);
        assert!(found.is_none());
        assert!(!home.exists(), "aucun fichier ni dossier n'est créé");
        // La fonction réelle, sur un dossier vide, ne télécharge pas non plus.
        assert!(installed_ytdlp(&home, None, &|_| {}).is_none());
        assert!(!home.exists());
    }

    #[test]
    fn installed_only_keeps_a_stale_copy_and_reports_the_due_update() {
        let home = temp_home();
        let exe = ytdlp_exe(&home);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"installed").unwrap();
        std::fs::write(update_marker(&home), b"0").unwrap();

        let stale = installed_ytdlp_with(&home, None, &|_| {}, &no_custom, &fake_verify)
            .expect("installed copy");
        assert_eq!(stale.path, exe);
        assert!(stale.update_due);
        assert_eq!(std::fs::read(&exe).unwrap(), b"installed");
        assert_eq!(std::fs::read(update_marker(&home)).unwrap(), b"0");

        touch_marker(&home);
        let fresh = installed_ytdlp_with(&home, None, &|_| {}, &no_custom, &fake_verify)
            .expect("installed copy");
        assert!(!fresh.update_due);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_only_prefers_a_valid_custom_path_without_update_due() {
        let home = temp_home();
        let custom = home.join("custom-yt-dlp");
        let messages = std::cell::RefCell::new(Vec::new());
        let emit = |message: &str| messages.borrow_mut().push(message.to_string());
        let found = installed_ytdlp_with(
            &home,
            Some(custom.to_str().unwrap()),
            &emit,
            &|raw| Ok(Some(PathBuf::from(raw))),
            &fake_verify,
        )
        .expect("custom path");
        assert_eq!(found.path, custom);
        assert!(!found.update_due);

        let ignored = installed_ytdlp_with(&home, Some("/nope"), &emit, &no_custom, &fake_verify);
        assert!(ignored.is_none());
        assert!(messages
            .borrow()
            .iter()
            .any(|m| m.contains_any_code(&[codes::YOUTUBE_CUSTOM_YTDLP_PATH_IGNORED])));
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let home = temp_home();
        let dest = home.join("yt-dlp");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&dest, b"old").unwrap();
        write_atomic(&dest, b"new").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&home);
    }
}
