use super::client::{health_request, XttsHealthResponse};
use super::XttsSettings;
use crate::support::network::require_local_url;
use crate::support::user_message;
use crate::support::user_message::codes;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static XTTS_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn xtts_python_path(xtts_dir: &Path, platform: &str) -> PathBuf {
    if platform == "windows" {
        xtts_dir.join("venv").join("Scripts").join("python.exe")
    } else {
        xtts_dir.join("venv").join("bin").join("python")
    }
}

fn xtts_server_args(force_cpu: bool) -> Vec<&'static str> {
    let mut args = vec!["server.py"];
    if force_cpu {
        args.push("--cpu");
    }
    args
}

fn start_server(settings: &XttsSettings) -> Result<(), String> {
    let xtts_dir = PathBuf::from(&settings.xtts_dir);
    let python_path = xtts_python_path(&xtts_dir, std::env::consts::OS);
    let server_path = xtts_dir.join("server.py");
    let models_dir = xtts_dir.join("models");

    if !python_path.is_file() {
        return Err({
            let _msg_python_path = (python_path.display()).to_string();
            user_message::UserMessage::new(codes::XTTS_PYTHON_NOT_FOUND)
                .param(
                    "pythonPath",
                    user_message::transport_param(_msg_python_path.clone()),
                )
                .with_detail(format!(
                    "Python XTTS introuvable : {_msg_python_path}",
                    _msg_python_path = user_message::transport_detail(&_msg_python_path)
                ))
                .into_transport()
        });
    }
    if !server_path.is_file() {
        return Err({
            let _msg_xtts_dir = (xtts_dir.display()).to_string();
            user_message::UserMessage::new(codes::XTTS_SERVER_PY_NOT_FOUND)
                .param(
                    "xttsDir",
                    user_message::transport_param(_msg_xtts_dir.clone()),
                )
                .with_detail(format!(
                    "server.py introuvable dans {_msg_xtts_dir}",
                    _msg_xtts_dir = user_message::transport_detail(&_msg_xtts_dir)
                ))
                .into_transport()
        });
    }

    let mut cmd = Command::new(&python_path);
    cmd.args(xtts_server_args(settings.force_cpu));
    cmd.current_dir(&xtts_dir)
        .env("TTS_HOME", &models_dir)
        .env("COQUI_TTS_HOME", &models_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn().map(|_| ()).map_err(|e| {
        let _msg_error = (e).to_string();
        user_message::UserMessage::new(codes::XTTS_PROCESS_START_FAILED)
            .param("error", user_message::transport_param(_msg_error.clone()))
            .with_detail(format!(
                "Impossible de demarrer XTTS : {_msg_error}",
                _msg_error = user_message::transport_detail(&_msg_error)
            ))
            .into_transport()
    })
}

pub(super) fn ensure_server_with_log(
    settings: &XttsSettings,
    emit: &dyn Fn(&str),
) -> Result<XttsHealthResponse, String> {
    emit(&{
        let _msg_settings_server_url = (settings.server_url).to_string();
        user_message::UserMessage::new(codes::XTTS_URL_VALIDATION)
            .param(
                "serverUrl",
                user_message::transport_param(_msg_settings_server_url.clone()),
            )
            .with_detail(format!(
                "Validation URL XTTS : {_msg_settings_server_url}",
                _msg_settings_server_url =
                    user_message::transport_detail(&_msg_settings_server_url)
            ))
            .into_transport()
    });
    require_local_url(&settings.server_url, "XTTS")?;

    // Vérification rapide hors lock : cas nominal où le serveur est déjà UP.
    if let Ok(health) = health_request(settings, Duration::from_secs(3), emit) {
        emit(codes::XTTS_HEALTH_ALREADY_RESPONDING_TRANSPORT);
        return Ok(health);
    }

    if !settings.auto_start {
        emit(codes::XTTS_AUTO_STARTUP_DISABLED_TRANSPORT);
        return Err({
            let _msg_settings_server_url = (settings.server_url).to_string();
            user_message::UserMessage::new(
                codes::XTTS_SERVER_START_REQUIRED,
            )
                .param(
                    "serverUrl",
                    user_message::transport_param(_msg_settings_server_url.clone()),
                )
                .with_detail(format!(
                    "Serveur XTTS indisponible sur {_msg_settings_server_url}. Lance XTTS ou active le demarrage automatique dans les Preferences.",
                    _msg_settings_server_url = user_message::transport_detail(&_msg_settings_server_url),
                ))
                .into_transport()
        });
    }

    // Un seul thread peut tenter de démarrer le serveur à la fois.
    // Les autres threads qui ont aussi vu le serveur DOWN attendent ici,
    // puis re-vérifient après libération du lock.
    let lock = XTTS_START_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        user_message::UserMessage::new(codes::XTTS_STARTUP_LOCK_CORRUPTED)
            .with_detail("XTTS : verrou de demarrage corrompu.".to_string())
            .into_transport()
    })?;

    // Re-vérification après acquisition du lock : un thread concurrent a peut-être
    // déjà démarré le serveur pendant qu'on attendait.
    emit(codes::XTTS_STARTUP_LOCK_RECHECK_TRANSPORT);
    if let Ok(health) = health_request(settings, Duration::from_secs(3), emit) {
        emit(codes::XTTS_STARTUP_THREAD_ALREADY_STARTED_TRANSPORT);
        return Ok(health);
    }

    emit(&{
        let _msg_settings_xtts_dir = (settings.xtts_dir).to_string();
        let cpu_mode_label = (if settings.force_cpu {
            codes::XTTS_WITH_CPU_TRANSPORT
        } else {
            ""
        })
        .to_string();
        user_message::UserMessage::new(codes::XTTS_PROCESS_START_DIRECTORY)
            .param(
                "xttsDirectory",
                user_message::transport_param(_msg_settings_xtts_dir.clone()),
            )
            .param(
                "cpuLabel",
                user_message::transport_param(cpu_mode_label.clone()),
            )
            .with_detail(format!(
                "Demarrage XTTS depuis {_msg_settings_xtts_dir}{cpu_mode_label}.",
                cpu_mode_label = user_message::transport_detail(&cpu_mode_label),
                _msg_settings_xtts_dir = user_message::transport_detail(&_msg_settings_xtts_dir),
            ))
            .into_transport()
    });
    start_server(settings)?;
    emit(codes::XTTS_PROCESS_HEALTH_WAITING_TRANSPORT);

    let mut last_error = String::from(codes::XTTS_SERVER_START_PENDING_TRANSPORT);
    for attempt in 1..=45 {
        std::thread::sleep(Duration::from_secs(1));
        match health_request(settings, Duration::from_secs(3), emit) {
            Ok(health) => {
                emit(&{
                    let _msg_attempt = (attempt).to_string();
                    user_message::UserMessage::new(codes::XTTS_HEALTH_ATTEMPTS_READY)
                        .param(
                            "attempt",
                            user_message::transport_param(_msg_attempt.clone()),
                        )
                        .with_detail(format!(
                            "XTTS pret apres {_msg_attempt} tentative(s).",
                            _msg_attempt = user_message::transport_detail(&_msg_attempt)
                        ))
                        .into_transport()
                });
                return Ok(health);
            }
            Err(err) => {
                last_error = err;
                if attempt == 1 || attempt % 5 == 0 {
                    emit(&{
                        let _msg_attempt = (attempt).to_string();
                        let _msg_last_error = (last_error).to_string();
                        user_message::UserMessage::new(codes::XTTS_HEALTH_ATTEMPTS_PENDING)
                            .param(
                                "attempt",
                                user_message::transport_param(_msg_attempt.clone()),
                            )
                            .param(
                                "lastError",
                                user_message::transport_param(_msg_last_error.clone()),
                            )
                            .with_detail(format!(
                                "XTTS pas encore pret ({_msg_attempt}/45) : {_msg_last_error}",
                                _msg_attempt = user_message::transport_detail(&_msg_attempt),
                                _msg_last_error = user_message::transport_detail(&_msg_last_error)
                            ))
                            .into_transport()
                    });
                }
            }
        }
    }

    Err({
        let _msg_last_error = (last_error).to_string();
        user_message::UserMessage::new(codes::XTTS_SERVER_START_FAILED)
            .param(
                "lastError",
                user_message::transport_param(_msg_last_error.clone()),
            )
            .with_detail(format!(
                "XTTS ne repond toujours pas apres demarrage automatique. {_msg_last_error}",
                _msg_last_error = user_message::transport_detail(&_msg_last_error),
            ))
            .into_transport()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_path_matches_windows_and_linux_virtualenvs() {
        let root = PathBuf::from("XTTS root");
        assert_eq!(
            xtts_python_path(&root, "windows"),
            root.join("venv/Scripts/python.exe")
        );
        assert_eq!(
            xtts_python_path(&root, "linux"),
            root.join("venv/bin/python")
        );
    }

    #[test]
    fn force_cpu_is_forwarded_as_a_separate_argument() {
        assert_eq!(xtts_server_args(false), vec!["server.py"]);
        assert_eq!(xtts_server_args(true), vec!["server.py", "--cpu"]);
    }
}
