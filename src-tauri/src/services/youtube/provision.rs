//! Provisionnement yt-dlp (D22) : télécharge **la dernière version** du binaire
//! Windows dans un dossier app-data inscriptible, vérifie son intégrité contre le
//! `SHA2-256SUMS` officiel de la même release, puis le **maintient à jour**
//! (re-téléchargement périodique). YouTube bloque les versions périmées, donc on
//! ne fige aucune version : on suit toujours la dernière release officielle.
//!
//! Intégrité : URL officielles HTTPS (releases GitHub yt-dlp), refus de tout autre
//! hôte (`require_public_download_url`), hash SHA-256 vérifié, écriture atomique.
//! Fallback : un chemin yt-dlp personnalisé (Préférences) court-circuite tout le
//! provisionnement.

use crate::support::network::{public_download_client, require_public_download_url};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::process::run_command_with_timeout;
use crate::support::ffmpeg::apply_no_window;

/// Dernière version (le suffixe `latest/download` redirige vers la release
/// courante ; les redirections sont validées hôte par hôte).
const BINARY_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const SUMS_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
const ASSET_NAME: &str = "yt-dlp.exe";

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const SUMS_TIMEOUT: Duration = Duration::from_secs(60);
const CUSTOM_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
// Au-delà, on retente un téléchargement de la dernière version au prochain usage.
const UPDATE_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
// Garde-fous de taille (le binaire fait ~15 Mo ; le SHASUMS quelques Ko).
const MIN_BINARY_BYTES: usize = 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 1024 * 1024;

static PROVISION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn bin_dir(home: &Path) -> PathBuf {
    home.join("bin")
}

fn ytdlp_exe(home: &Path) -> PathBuf {
    bin_dir(home).join("yt-dlp.exe")
}

/// Horodatage (ms epoch) du dernier provisionnement réussi, pour la fraîcheur.
fn update_marker(home: &Path) -> PathBuf {
    bin_dir(home).join(".last-update")
}

fn is_installed(home: &Path) -> bool {
    ytdlp_exe(home).is_file()
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
        .map(|d| d.as_millis())
        .unwrap_or(0);
    now_ms.saturating_sub(stamp_ms) < UPDATE_INTERVAL.as_millis()
}

fn touch_marker(home: &Path) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = write_atomic(&update_marker(home), now_ms.to_string().as_bytes());
}

/// Valide un chemin yt-dlp personnalisé fourni par l'utilisateur (Préférences).
fn custom_path_valid(custom: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = custom.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err("le fichier n'existe pas.".to_string());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !name.starts_with("yt-dlp") || ext != "exe" {
        return Err("le fichier doit être un exécutable yt-dlp.exe.".to_string());
    }
    let header =
        std::fs::read(&path).map_err(|e| format!("lecture du fichier impossible : {}", e))?;
    if header.first_chunk::<2>() != Some(b"MZ") {
        return Err("le fichier n'est pas un exécutable Windows valide.".to_string());
    }
    Ok(Some(path))
}

/// Garantit la présence d'un yt-dlp utilisable et renvoie son chemin.
/// - chemin perso valide → utilisé tel quel (jamais de téléchargement) ;
/// - sinon binaire provisionné, téléchargé au 1er usage puis rafraîchi
///   périodiquement (best-effort : un échec de rafraîchissement conserve la
///   version installée).
pub(super) fn ensure_ytdlp(
    home: &Path,
    custom: Option<&str>,
    emit: &dyn Fn(&str),
) -> Result<PathBuf, String> {
    if let Some(raw) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        match custom_path_valid(Some(raw)).and_then(verify_custom_ytdlp) {
            Ok(Some(path)) => return Ok(path),
            Ok(None) => {}
            Err(err) => emit(&format!("Chemin yt-dlp personnalisé ignoré : {}", err)),
        }
    }

    // Chemin rapide : binaire présent et récent.
    if is_installed(home) && marker_is_fresh(home) {
        return Ok(ytdlp_exe(home));
    }

    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "yt-dlp : verrou de provisionnement corrompu.".to_string())?;

    // Re-vérifie après acquisition (un thread concurrent a pu finir entre-temps).
    if is_installed(home) && marker_is_fresh(home) {
        return Ok(ytdlp_exe(home));
    }

    let already_installed = is_installed(home);
    match download_latest(home, emit) {
        Ok(path) => Ok(path),
        Err(err) if already_installed => {
            // Rafraîchissement raté mais une version existe déjà : on continue
            // avec elle plutôt que de bloquer le funnel.
            log::warn!(target: "youtube", "yt-dlp refresh failed, keeping installed copy: {}", err);
            emit("Mise à jour de yt-dlp impossible, utilisation de la version déjà installée.");
            Ok(ytdlp_exe(home))
        }
        Err(err) => Err(err),
    }
}

fn verify_custom_ytdlp(path: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let mut cmd = Command::new(&path);
    apply_no_window(&mut cmd);
    cmd.arg("--version");
    let output = run_command_with_timeout(cmd, CUSTOM_VERSION_TIMEOUT, "Validation yt-dlp")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp --version a échoué : {}",
            stderr.trim().lines().last().unwrap_or("erreur inconnue")
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout);
    if !version.chars().any(|c| c.is_ascii_digit()) {
        return Err("yt-dlp --version n'a pas renvoyé de version lisible.".to_string());
    }
    Ok(Some(path))
}

/// Force le téléchargement de la dernière version (action « Mettre à jour »).
pub(crate) fn update_ytdlp(home: &Path, emit: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "yt-dlp : verrou de provisionnement corrompu.".to_string())?;
    download_latest(home, emit)
}

fn download_latest(home: &Path, emit: &dyn Fn(&str)) -> Result<PathBuf, String> {
    emit("Préparation de yt-dlp (téléchargement de la dernière version)…");
    let bytes = download_bytes(BINARY_URL, DOWNLOAD_TIMEOUT, "de yt-dlp")?;
    if bytes.len() < MIN_BINARY_BYTES {
        return Err("Binaire yt-dlp anormalement petit (téléchargement incomplet ?).".to_string());
    }
    // Sanity : un exécutable Windows commence par l'en-tête « MZ ».
    if bytes.first_chunk::<2>() != Some(b"MZ") {
        return Err("Le fichier téléchargé n'est pas un exécutable Windows valide.".to_string());
    }

    emit("Vérification de l'intégrité de yt-dlp…");
    let sums = download_bytes(SUMS_URL, SUMS_TIMEOUT, "de la somme de contrôle yt-dlp")?;
    if sums.len() as u64 > MAX_SUMS_BYTES {
        return Err("Fichier de sommes de contrôle yt-dlp anormalement volumineux.".to_string());
    }
    let expected = parse_sha256_sum(&String::from_utf8_lossy(&sums), ASSET_NAME)
        .ok_or_else(|| "Somme de contrôle yt-dlp introuvable pour yt-dlp.exe.".to_string())?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(
            "Intégrité de yt-dlp invalide (la somme de contrôle ne correspond pas).".to_string(),
        );
    }

    let exe = ytdlp_exe(home);
    write_atomic(&exe, &bytes)?;
    touch_marker(home);
    emit("yt-dlp prêt.");
    Ok(exe)
}

/// Extrait le hash SHA-256 attendu pour `asset` d'un fichier `SHA2-256SUMS`
/// (lignes `<hex>  <nom>`). Compare sur le nom de fichier final.
fn parse_sha256_sum(text: &str, asset: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next().unwrap_or("");
        let file = name.rsplit(['/', '*']).next().unwrap_or(name);
        if file == asset && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_string());
        }
    }
    None
}

fn download_bytes(url: &str, timeout: Duration, service: &'static str) -> Result<Vec<u8>, String> {
    require_public_download_url(url, service)?;
    let client = public_download_client(timeout, service)?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Échec du téléchargement {} : {}", service, e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Téléchargement {} refusé (HTTP {}).",
            service,
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("Lecture du flux {} impossible : {}", service, e))?;
    if bytes.is_empty() {
        return Err(format!("Téléchargement {} vide.", service));
    }
    Ok(bytes.to_vec())
}

/// Écrit via fichier `.part` puis remplace l'ancien fichier (robuste sur Windows
/// après une interruption qui aurait laissé un fichier partiel).
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Création du dossier impossible : {}", e))?;
    }
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Écriture impossible : {}", e))?;
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Remplacement du fichier existant impossible : {}", e)
        })?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Finalisation du fichier impossible : {}", e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{custom_path_valid, parse_sha256_sum, write_atomic};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_home() -> PathBuf {
        std::env::temp_dir().join(format!("story_studio_ytdlp_test_{}", Uuid::new_v4()))
    }

    #[test]
    fn parses_sha256_for_asset() {
        let sums = "abc123  yt-dlp\n\
            1111111111111111111111111111111111111111111111111111111111111111  yt-dlp.exe\n\
            2222222222222222222222222222222222222222222222222222222222222222 *yt-dlp_macos\n";
        assert_eq!(
            parse_sha256_sum(sums, "yt-dlp.exe").as_deref(),
            Some("1111111111111111111111111111111111111111111111111111111111111111")
        );
        assert!(parse_sha256_sum(sums, "yt-dlp_linux").is_none());
        // Hash trop court ignoré.
        assert!(parse_sha256_sum("abc123  yt-dlp.exe", "yt-dlp.exe").is_none());
    }

    #[test]
    fn custom_path_requires_existing_file() {
        assert!(custom_path_valid(None).unwrap().is_none());
        assert!(custom_path_valid(Some("   ")).unwrap().is_none());
        assert!(custom_path_valid(Some("C:/does/not/exist/yt-dlp.exe")).is_err());

        let home = temp_home();
        let exe = home.join("yt-dlp-custom.exe");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&exe, b"MZfake").unwrap();
        assert_eq!(
            custom_path_valid(Some(exe.to_str().unwrap())).unwrap(),
            Some(exe.clone())
        );
        let wrong_name = home.join("notepad.exe");
        std::fs::write(&wrong_name, b"MZfake").unwrap();
        assert!(custom_path_valid(Some(wrong_name.to_str().unwrap())).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let home = temp_home();
        let dest = home.join("yt-dlp.exe");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&dest, b"old").unwrap();
        write_atomic(&dest, b"new").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&home);
    }
}
