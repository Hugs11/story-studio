//! Provisionnement des seules voix Piper dans l'app-data. Le moteur 1.6 est
//! résolu depuis les ressources en lecture seule du bundle.

use super::catalog::{self, VoiceEntry};
use super::runtime::{resolve_piper_runtime, PiperRuntime};
use crate::support::network::{public_download_client, require_public_download_url};
use crate::support::user_message;
use crate::support::user_message::codes;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

const MAX_VOICE_MODEL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VOICE_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

static PROVISION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn voices_dir(home: &Path) -> PathBuf {
    home.join("voices")
}

pub(super) fn voice_paths(home: &Path, voice_id: &str) -> (PathBuf, PathBuf) {
    let dir = voices_dir(home);
    (
        dir.join(format!("{voice_id}.onnx")),
        dir.join(format!("{voice_id}.onnx.json")),
    )
}

pub(super) fn is_voice_installed(home: &Path, voice_id: &str) -> bool {
    let Some(voice) = catalog::find_voice(voice_id) else {
        return false;
    };
    validate_voice_install(home, voice).is_ok()
}

fn download_bytes(
    url: &str,
    max_bytes: u64,
    service: &str,
    emit: &dyn Fn(&str),
) -> Result<Vec<u8>, String> {
    require_public_download_url(url, service)?;
    emit(&{
        let _msg_service = (service).to_string();
        user_message::UserMessage::new(codes::PIPER_DOWNLOAD_STARTED)
            .param(
                "service",
                user_message::transport_param(_msg_service.clone()),
            )
            .with_detail(format!(
                "Téléchargement {_msg_service} en cours…",
                _msg_service = user_message::transport_detail(&_msg_service)
            ))
            .into_transport()
    });
    let client = public_download_client(DOWNLOAD_TIMEOUT, service)?;
    let mut response = client.get(url).send().map_err(|error| {
        let _msg_service = (service).to_string();
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::PIPER_DOWNLOAD_REQUEST_FAILED)
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
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_HTTP_REFUSED)
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
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_SIZE_LIMIT)
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
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_STREAM_UNREADABLE)
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
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_CONTENT_EMPTY)
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
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_SIZE_LIMIT)
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

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err({
            let _msg_label = (label).to_string();
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_CHECKSUM_INVALID)
                .param("label", user_message::transport_param(_msg_label.clone()))
                .with_detail(format!(
                    "Intégrité de {_msg_label} invalide (SHA-256 inattendu).",
                    _msg_label = user_message::transport_detail(&_msg_label)
                ))
                .into_transport()
        })
    }
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_FOLDER_CREATE_FAILED)
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
        user_message::UserMessage::new(codes::PIPER_DOWNLOAD_TEMP_WRITE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Écriture temporaire impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            {
                let _msg_error = (error).to_string();
                user_message::UserMessage::new(codes::PIPER_DOWNLOAD_FILE_REPLACE_FAILED)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Remplacement du fichier existant impossible : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            }
        })?;
    }
    std::fs::rename(&tmp, dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        {
            let _msg_error = (error).to_string();
            user_message::UserMessage::new(codes::PIPER_DOWNLOAD_FILE_FINALIZE_FAILED)
                .param("error", user_message::transport_param(_msg_error.clone()))
                .with_detail(format!(
                    "Finalisation du fichier impossible : {_msg_error}",
                    _msg_error = user_message::transport_detail(&_msg_error)
                ))
                .into_transport()
        }
    })
}

fn validate_voice_install(home: &Path, voice: &VoiceEntry) -> Result<(), String> {
    let (onnx, json) = voice_paths(home, voice.id);
    let onnx_metadata = std::fs::symlink_metadata(&onnx).map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_LOCAL_MODEL_MISSING)
            .with_detail("Modèle Piper local introuvable.".to_string())
            .into_transport()
    })?;
    if onnx_metadata.file_type().is_symlink()
        || !onnx_metadata.is_file()
        || onnx_metadata.len() < 1024 * 1024
    {
        return Err(
            user_message::UserMessage::new(codes::PIPER_LOCAL_MODEL_INCOMPLETE)
                .with_detail("Modèle Piper local incomplet.".to_string())
                .into_transport(),
        );
    }
    let onnx_bytes = std::fs::read(&onnx).map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_LOCAL_MODEL_UNREADABLE)
            .with_detail("Modèle Piper local illisible.".to_string())
            .into_transport()
    })?;
    verify_sha256(
        &onnx_bytes,
        voice.onnx_sha256,
        codes::PIPER_LOCAL_MODEL_LABEL_TRANSPORT,
    )?;

    let json_metadata = std::fs::symlink_metadata(&json).map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_LOCAL_CONFIG_MISSING)
            .with_detail("Configuration Piper locale introuvable.".to_string())
            .into_transport()
    })?;
    if json_metadata.file_type().is_symlink() || !json_metadata.is_file() {
        return Err(
            user_message::UserMessage::new(codes::PIPER_LOCAL_CONFIG_INVALID)
                .with_detail("Configuration Piper locale invalide.".to_string())
                .into_transport(),
        );
    }
    let json_bytes = std::fs::read(&json).map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_LOCAL_CONFIG_UNREADABLE)
            .with_detail("Configuration Piper locale illisible.".to_string())
            .into_transport()
    })?;
    verify_sha256(
        &json_bytes,
        voice.json_sha256,
        codes::PIPER_LOCAL_CONFIG_LABEL_TRANSPORT,
    )?;
    validate_voice_config(&json_bytes)
}

fn cleanup_legacy_binary_cache(home: &Path) -> Result<bool, String> {
    let legacy = home.join("bin");
    let metadata = match std::fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err({
                let _msg_error = (error).to_string();
                user_message::UserMessage::new(codes::PIPER_OLD_CACHE_UNREADABLE)
                    .param("error", user_message::transport_param(_msg_error.clone()))
                    .with_detail(format!(
                        "Ancien cache Piper illisible : {_msg_error}",
                        _msg_error = user_message::transport_detail(&_msg_error)
                    ))
                    .into_transport()
            })
        }
    };
    let removing = home.join(format!(".legacy-bin-removing-{}", Uuid::new_v4()));
    std::fs::rename(&legacy, &removing).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::PIPER_OLD_CACHE_MIGRATE_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Migration de l'ancien cache Piper impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })?;
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(&removing)
    } else {
        std::fs::remove_file(&removing)
    };
    result.map(|_| true).map_err(|error| {
        let _msg_error = (error).to_string();
        user_message::UserMessage::new(codes::PIPER_OLD_CACHE_CLEAN_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Nettoyage de l'ancien cache Piper impossible : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

pub(super) fn ensure_voice(
    home: &Path,
    voice: &VoiceEntry,
    emit: &dyn Fn(&str),
) -> Result<(), String> {
    if is_voice_installed(home, voice.id) {
        return Ok(());
    }
    emit(&{
        let _msg_voice_label = (voice.label).to_string();
        user_message::UserMessage::new(codes::PIPER_PREPARING_VOICE)
            .param(
                "voiceLabel",
                user_message::transport_param(_msg_voice_label.clone()),
            )
            .with_detail(format!(
                "Préparation de la voix « {_msg_voice_label} »…",
                _msg_voice_label = user_message::transport_detail(&_msg_voice_label)
            ))
            .into_transport()
    });
    let (onnx_path, json_path) = voice_paths(home, voice.id);

    let onnx_bytes = download_bytes(
        voice.onnx_url(),
        MAX_VOICE_MODEL_BYTES,
        &user_message::UserMessage::new(codes::LABEL_PIPER_VOICE_DOWNLOAD).into_transport(),
        emit,
    )?;
    if onnx_bytes.len() < 1024 * 1024 {
        return Err(
            user_message::UserMessage::new(codes::PIPER_VOICE_MODEL_INCOMPLETE_CORRUPTED)
                .with_detail("Modèle de voix incomplet ou corrompu.".to_string())
                .into_transport(),
        );
    }
    verify_sha256(
        &onnx_bytes,
        voice.onnx_sha256,
        codes::PIPER_VOICE_MODEL_LABEL_TRANSPORT,
    )?;

    let json_bytes = download_bytes(
        voice.json_url(),
        MAX_VOICE_CONFIG_BYTES,
        codes::PIPER_VOICE_CONFIG_LABEL_TRANSPORT,
        emit,
    )?;
    verify_sha256(
        &json_bytes,
        voice.json_sha256,
        codes::PIPER_VOICE_CONFIG_LABEL_TRANSPORT,
    )?;
    validate_voice_config(&json_bytes)?;

    write_atomic(&onnx_path, &onnx_bytes)?;
    write_atomic(&json_path, &json_bytes)?;
    emit(codes::PIPER_VOICE_READY_TRANSPORT);
    Ok(())
}

fn validate_voice_config(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_VOICE_CONFIG_JSON_INVALID)
            .with_detail("Configuration de voix invalide (JSON illisible).".to_string())
            .into_transport()
    })?;
    let ok = value
        .get("audio")
        .and_then(|audio| audio.get("sample_rate"))
        .is_some_and(serde_json::Value::is_number);
    if ok {
        Ok(())
    } else {
        Err(
            user_message::UserMessage::new(codes::PIPER_VOICE_CONFIG_AUDIO_MISSING)
                .with_detail("Configuration de voix invalide (champ audio manquant).".to_string())
                .into_transport(),
        )
    }
}

pub(super) fn ensure_piper(
    home: &Path,
    voice_id: &str,
    emit: &dyn Fn(&str),
) -> Result<PiperRuntime, String> {
    let runtime = resolve_piper_runtime()?;
    let voice = catalog::find_voice(voice_id).ok_or_else(|| {
        let _msg_voice_id = (voice_id).to_string();
        user_message::UserMessage::new(codes::PIPER_VOICE_NAME_UNKNOWN)
            .param(
                "voiceId",
                user_message::transport_param(_msg_voice_id.clone()),
            )
            .with_detail(format!(
                "Voix Piper inconnue : {_msg_voice_id}",
                _msg_voice_id = user_message::transport_detail(&_msg_voice_id)
            ))
            .into_transport()
    })?;

    let lock = PROVISION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        user_message::UserMessage::new(codes::PIPER_PROVISIONING_LOCK_CORRUPTED)
            .with_detail("Piper : verrou de provisionnement corrompu.".to_string())
            .into_transport()
    })?;
    if cleanup_legacy_binary_cache(home)? {
        emit(codes::PIPER_LEGACY_ENGINE_REPLACED_TRANSPORT);
    }
    ensure_voice(home, voice, emit)?;
    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn voice_install_validation_rejects_partial_or_tampered_model() {
        let home = temp_home();
        let voice = catalog::find_voice("fr_FR-siwis-medium").unwrap();
        let (onnx, json) = voice_paths(&home, voice.id);
        std::fs::create_dir_all(onnx.parent().unwrap()).unwrap();
        std::fs::write(&onnx, vec![0_u8; 1024 * 1024]).unwrap();
        std::fs::write(&json, br#"{"audio":{"sample_rate":22050}}"#).unwrap();
        assert!(!is_voice_installed(&home, voice.id));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn legacy_binary_cleanup_preserves_downloaded_voices() {
        let home = temp_home();
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir_all(home.join("voices")).unwrap();
        std::fs::write(home.join("bin/piper"), b"legacy").unwrap();
        std::fs::write(home.join("voices/voice.onnx"), b"voice").unwrap();

        assert!(cleanup_legacy_binary_cache(&home).unwrap());
        assert!(!home.join("bin").exists());
        assert_eq!(
            std::fs::read(home.join("voices/voice.onnx")).unwrap(),
            b"voice"
        );
        assert!(!cleanup_legacy_binary_cache(&home).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }
}
