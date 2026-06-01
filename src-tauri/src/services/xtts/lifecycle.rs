use super::client::{health_request, XttsHealthResponse};
use super::XttsSettings;
use crate::support::network::require_local_url;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static XTTS_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn start_server(settings: &XttsSettings) -> Result<(), String> {
    let xtts_dir = PathBuf::from(&settings.xtts_dir);
    let python_path = xtts_dir.join("venv").join("Scripts").join("python.exe");
    let server_path = xtts_dir.join("server.py");
    let models_dir = xtts_dir.join("models");

    if !python_path.exists() {
        return Err(format!(
            "Python XTTS introuvable : {}",
            python_path.display()
        ));
    }
    if !server_path.exists() {
        return Err(format!("server.py introuvable dans {}", xtts_dir.display()));
    }

    let mut cmd = Command::new(&python_path);
    cmd.arg("server.py");
    if settings.force_cpu {
        cmd.arg("--cpu");
    }
    cmd.current_dir(&xtts_dir)
        .env("TTS_HOME", &models_dir)
        .env("COQUI_TTS_HOME", &models_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Impossible de demarrer XTTS : {}", e))
}

pub(super) fn ensure_server_with_log(
    settings: &XttsSettings,
    emit: &dyn Fn(&str),
) -> Result<XttsHealthResponse, String> {
    emit(&format!("Validation URL XTTS : {}", settings.server_url));
    require_local_url(&settings.server_url, "XTTS")?;

    // Vérification rapide hors lock : cas nominal où le serveur est déjà UP.
    if let Ok(health) = health_request(settings, Duration::from_secs(3), emit) {
        emit("XTTS repond deja sur /health.");
        return Ok(health);
    }

    if !settings.auto_start {
        emit("Demarrage automatique XTTS desactive.");
        return Err(format!(
            "Serveur XTTS indisponible sur {}. Lance XTTS ou active le demarrage automatique dans les Preferences.",
            settings.server_url
        ));
    }

    // Un seul thread peut tenter de démarrer le serveur à la fois.
    // Les autres threads qui ont aussi vu le serveur DOWN attendent ici,
    // puis re-vérifient après libération du lock.
    let lock = XTTS_START_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "XTTS : verrou de demarrage corrompu.".to_string())?;

    // Re-vérification après acquisition du lock : un thread concurrent a peut-être
    // déjà démarré le serveur pendant qu'on attendait.
    emit("XTTS ne repond pas, verification apres acquisition du verrou...");
    if let Ok(health) = health_request(settings, Duration::from_secs(3), emit) {
        emit("XTTS deja demarre par un autre thread.");
        return Ok(health);
    }

    emit(&format!(
        "Demarrage XTTS depuis {}{}.",
        settings.xtts_dir,
        if settings.force_cpu {
            " avec --cpu"
        } else {
            ""
        }
    ));
    start_server(settings)?;
    emit("Processus XTTS lance, attente de /health...");

    let mut last_error = String::from("XTTS demarre mais ne repond pas encore.");
    for attempt in 1..=45 {
        std::thread::sleep(Duration::from_secs(1));
        match health_request(settings, Duration::from_secs(3), emit) {
            Ok(health) => {
                emit(&format!("XTTS pret apres {} tentative(s).", attempt));
                return Ok(health);
            }
            Err(err) => {
                last_error = err;
                if attempt == 1 || attempt % 5 == 0 {
                    emit(&format!(
                        "XTTS pas encore pret ({}/45) : {}",
                        attempt, last_error
                    ));
                }
            }
        }
    }

    Err(format!(
        "XTTS ne repond toujours pas apres demarrage automatique. {}",
        last_error
    ))
}
