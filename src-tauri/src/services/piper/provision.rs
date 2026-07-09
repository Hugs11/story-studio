//! Provisionnement Piper : télécharge **une fois** le binaire Windows et
//! la/les voix demandées dans un dossier app-data inscriptible, puis valide
//! structurellement les artefacts. Aucun serveur, aucune dépendance Python.
//!
//! Intégrité : URL officielles HTTPS épinglées (catalogue), refus de tout autre
//! hôte (`require_public_download_url`), extraction protégée contre le zip-slip,
//! et validation structurelle (exe présent, `.onnx` non vide, `.onnx.json`
//! parsable). Idempotent : un artefact déjà valide n'est jamais re-téléchargé.

use super::catalog::{self, VoiceEntry};
use crate::support::network::{public_download_client, require_public_download_url};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// Bornes anti-zip-bomb pour l'archive du binaire.
const MAX_BINARY_ENTRIES: usize = 4096;
const MAX_BINARY_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

static PROVISION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn bin_dir(home: &Path) -> PathBuf {
    home.join("bin")
}

fn voices_dir(home: &Path) -> PathBuf {
    home.join("voices")
}

pub(super) fn piper_exe(home: &Path) -> PathBuf {
    bin_dir(home).join("piper.exe")
}

fn version_marker(home: &Path) -> PathBuf {
    bin_dir(home).join(".binary-version")
}

/// Chemins (onnx, onnx.json) d'une voix une fois installée.
pub(super) fn voice_paths(home: &Path, voice_id: &str) -> (PathBuf, PathBuf) {
    let dir = voices_dir(home);
    (
        dir.join(format!("{}.onnx", voice_id)),
        dir.join(format!("{}.onnx.json", voice_id)),
    )
}

pub(super) fn is_binary_installed(home: &Path) -> bool {
    validate_binary_install(home).is_ok()
}

pub(super) fn is_voice_installed(home: &Path, voice_id: &str) -> bool {
    validate_voice_install(home, voice_id).is_ok()
}

/// Télécharge un fichier depuis une URL officielle épinglée et renvoie ses octets.
fn download_bytes(
    url: &str,
    service: &'static str,
    emit: &dyn Fn(&str),
) -> Result<Vec<u8>, String> {
    require_public_download_url(url, service)?;
    emit(&format!("Téléchargement {} en cours…", service));
    let client = public_download_client(DOWNLOAD_TIMEOUT, service)?;
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

/// Écrit des octets via fichier `.part`, puis remplace l'ancien fichier. Le
/// remplacement explicite évite de rester bloqué sur Windows après un premier
/// provisionnement interrompu qui aurait laissé un fichier partiel.
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

fn validate_binary_install(home: &Path) -> Result<(), String> {
    if !piper_exe(home).is_file() {
        return Err("piper.exe introuvable.".to_string());
    }
    let version = std::fs::read_to_string(version_marker(home))
        .map_err(|_| "Version Piper locale introuvable.".to_string())?;
    if version.trim() != catalog::BINARY_VERSION {
        return Err("Version Piper locale obsolete.".to_string());
    }
    let data_dir = bin_dir(home).join("espeak-ng-data");
    if !data_dir.is_dir() {
        return Err("Données espeak-ng Piper introuvables.".to_string());
    }
    Ok(())
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

// ── Binaire ──────────────────────────────────────────────────────────────────

pub(super) fn ensure_binary(home: &Path, emit: &dyn Fn(&str)) -> Result<(), String> {
    if is_binary_installed(home) {
        return Ok(());
    }
    emit("Préparation du moteur de voix (téléchargement unique)…");
    let bytes = download_bytes(catalog::BINARY_URL, "du moteur Piper", emit)?;

    let bin = bin_dir(home);
    // Repart d'un dossier propre pour éviter de mélanger deux versions.
    if bin.exists() {
        let _ = std::fs::remove_dir_all(&bin);
    }
    std::fs::create_dir_all(&bin)
        .map_err(|e| format!("Création du dossier Piper impossible : {}", e))?;

    extract_binary_zip(&bytes, &bin, emit)?;

    if !piper_exe(home).is_file() {
        let _ = std::fs::remove_dir_all(&bin);
        return Err("Archive Piper invalide : piper.exe introuvable.".to_string());
    }
    write_atomic(&version_marker(home), catalog::BINARY_VERSION.as_bytes())?;
    emit("Moteur de voix prêt.");
    Ok(())
}

/// Extrait l'archive Piper sous `dest`, en aplatissant le dossier racine `piper/`
/// présent dans la release officielle. Protégé contre le zip-slip via
/// `enclosed_name`.
fn extract_binary_zip(bytes: &[u8], dest: &Path, emit: &dyn Fn(&str)) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Archive Piper illisible : {}", e))?;
    if archive.len() > MAX_BINARY_ENTRIES {
        return Err("Archive Piper anormalement volumineuse (trop d'entrées).".to_string());
    }

    let mut total_bytes: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Lecture entrée {} impossible : {}", index, e))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // chemin non sûr (zip-slip) : ignoré.
        };
        // Aplatit le dossier racine `piper/`.
        let stripped: PathBuf = rel
            .strip_prefix("piper")
            .map(Path::to_path_buf)
            .unwrap_or(rel);
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("Création dossier extrait impossible : {}", e))?;
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_BINARY_TOTAL_BYTES {
            return Err("Archive Piper anormalement volumineuse.".to_string());
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Création dossier extrait impossible : {}", e))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Extraction {} impossible : {}", stripped.display(), e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Écriture {} impossible : {}", stripped.display(), e))?;
    }
    emit("Extraction du moteur terminée.");
    Ok(())
}

// ── Voix ─────────────────────────────────────────────────────────────────────

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

    let onnx_bytes = download_bytes(&voice.onnx_url(), "de la voix", emit)?;
    // Un modèle Piper valide pèse plusieurs Mo : garde-fou structurel minimal.
    if onnx_bytes.len() < 1024 * 1024 {
        return Err("Modèle de voix incomplet ou corrompu.".to_string());
    }
    let json_bytes = download_bytes(&voice.json_url(), "de la configuration de voix", emit)?;
    validate_voice_config(&json_bytes)?;

    write_atomic(&onnx_path, &onnx_bytes)?;
    write_atomic(&json_path, &json_bytes)?;
    emit("Voix prête.");
    Ok(())
}

/// Vérifie que la config `.onnx.json` est un JSON Piper plausible (présence de
/// `audio.sample_rate`). Évite d'installer un fichier d'erreur HTML/redirection.
fn validate_voice_config(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Configuration de voix invalide (JSON illisible).".to_string())?;
    let ok = value
        .get("audio")
        .and_then(|audio| audio.get("sample_rate"))
        .map(|rate| rate.is_number())
        .unwrap_or(false);
    if !ok {
        return Err("Configuration de voix invalide (champ audio manquant).".to_string());
    }
    Ok(())
}

// ── Orchestration ────────────────────────────────────────────────────────────

/// Garantit que le binaire et la voix demandée sont installés et valides.
/// Idempotent et sérialisé : deux générations concurrentes ne téléchargent pas
/// deux fois le même artefact.
pub(super) fn ensure_piper(home: &Path, voice_id: &str, emit: &dyn Fn(&str)) -> Result<(), String> {
    let voice = catalog::find_voice(voice_id)
        .ok_or_else(|| format!("Voix Piper inconnue : {}", voice_id))?;

    // Chemin rapide hors verrou : cas nominal où tout est déjà provisionné.
    if is_binary_installed(home) && is_voice_installed(home, voice_id) {
        return Ok(());
    }

    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Piper : verrou de provisionnement corrompu.".to_string())?;

    // Re-vérifie après acquisition : un thread concurrent a pu finir entre-temps.
    ensure_binary(home, emit)?;
    ensure_voice(home, voice, emit)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_voice_installed, voice_paths, write_atomic};
    use std::path::PathBuf;
    use uuid::Uuid;

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
}
