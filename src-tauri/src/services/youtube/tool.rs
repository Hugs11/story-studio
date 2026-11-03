//! Invocation commune de yt-dlp : binaire provisionné, moteur JavaScript et
//! arguments partagés, plus l'espacement des requêtes vers YouTube.

use crate::support::user_message::codes;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::error::{YoutubeError, YoutubeErrorCode};
use super::js_runtime::{ensure_js_runtime, installed_js_runtime};
use super::provision::{ensure_ytdlp, installed_ytdlp};
use crate::support::ffmpeg::apply_no_window;

/// Pause entre deux requêtes d'une même analyse (valeur du préréglage
/// `--preset-alias sleep` de yt-dlp).
pub(super) const SLEEP_REQUESTS: &str = "0.75";
/// Écart minimal entre deux processus qui interrogent l'API de lecture.
const MIN_GAP_BETWEEN_ANALYSES: Duration = Duration::from_secs(3);

static LAST_ANALYSIS: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

/// Préparation des outils avant un appel à yt-dlp.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ToolMode {
    /// Comportement des imports manuels : installe ou met à jour yt-dlp et
    /// Deno au besoin.
    #[default]
    Provision,
    /// Vérification de fond : n'utilise que les outils déjà présents et ne
    /// télécharge jamais rien.
    InstalledOnly,
}

impl ToolMode {
    pub fn from_installed_only(installed_only: Option<bool>) -> Self {
        if installed_only == Some(true) {
            Self::InstalledOnly
        } else {
            Self::Provision
        }
    }
}

/// État des outils constaté en mode [`ToolMode::InstalledOnly`], pour
/// proposer explicitement une installation ou une mise à jour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ytdlp_missing: bool,
    pub ytdlp_update_due: bool,
    pub js_runtime_missing: bool,
}

pub(super) const TOOL_MISSING_MESSAGE: &str = codes::YOUTUBE_TOOL_MISSING_TRANSPORT;

pub(super) struct Ytdlp {
    exe: PathBuf,
    js_runtime: Option<PathBuf>,
}

impl Ytdlp {
    pub(super) fn prepare(
        home: &Path,
        custom: Option<&str>,
        emit: &dyn Fn(&str),
    ) -> Result<Self, String> {
        let exe = ensure_ytdlp(home, custom, emit)?;
        let js_runtime = ensure_js_runtime(home, emit);
        Ok(Self { exe, js_runtime })
    }

    /// Prépare yt-dlp selon `mode`. En mode installé uniquement, retourne
    /// aussi l'état des outils, et une erreur `ToolMissing` sans yt-dlp.
    pub(super) fn prepare_for(
        mode: ToolMode,
        home: &Path,
        custom: Option<&str>,
        emit: &dyn Fn(&str),
    ) -> Result<(Self, Option<ToolStatus>), YoutubeError> {
        match mode {
            ToolMode::Provision => Ok((Self::prepare(home, custom, emit)?, None)),
            ToolMode::InstalledOnly => {
                let installed = installed_ytdlp(home, custom, emit).ok_or_else(|| {
                    YoutubeError::new(YoutubeErrorCode::ToolMissing, TOOL_MISSING_MESSAGE)
                })?;
                let js_runtime = installed_js_runtime(home);
                let status = ToolStatus {
                    ytdlp_missing: false,
                    ytdlp_update_due: installed.update_due,
                    js_runtime_missing: js_runtime.is_none(),
                };
                Ok((
                    Self {
                        exe: installed.path,
                        js_runtime,
                    },
                    Some(status),
                ))
            }
        }
    }

    /// Commande sans fenêtre, sans configuration utilisateur, avec le moteur
    /// JavaScript quand il est disponible.
    pub(super) fn command(&self) -> Command {
        let mut cmd = Command::new(&self.exe);
        apply_no_window(&mut cmd);
        cmd.args(common_args(self.js_runtime.as_deref()));
        cmd
    }
}

pub(super) fn common_args(js_runtime: Option<&Path>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--ignore-config".into(), "--no-warnings".into()];
    if let Some(path) = js_runtime {
        // yt-dlp découpe `RUNTIME:PATH` au premier `:` : un chemin Windows
        // (`C:\…`) reste donc intact.
        let mut value = OsString::from("deno:");
        value.push(path.as_os_str());
        args.push("--js-runtimes".into());
        args.push(value);
    }
    args
}

/// Espace les analyses successives d'un même lot, pour ne pas enchaîner des
/// dizaines de requêtes en rafale depuis la même adresse.
pub(super) fn pace_analysis() {
    let lock = LAST_ANALYSIS.get_or_init(|| Mutex::new(None));
    let Ok(mut last) = lock.lock() else {
        return;
    };
    if let Some(wait) = last.and_then(|at| MIN_GAP_BETWEEN_ANALYSES.checked_sub(at.elapsed())) {
        std::thread::sleep(wait);
    }
    *last = Some(Instant::now());
}

#[cfg(test)]
mod tests {
    use super::{common_args, ToolMode, ToolStatus, Ytdlp};
    use crate::services::youtube::error::YoutubeErrorCode;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn default_mode_keeps_provisioning_for_manual_imports() {
        assert_eq!(ToolMode::default(), ToolMode::Provision);
        assert_eq!(ToolMode::from_installed_only(None), ToolMode::Provision);
        assert_eq!(
            ToolMode::from_installed_only(Some(false)),
            ToolMode::Provision
        );
        assert_eq!(
            ToolMode::from_installed_only(Some(true)),
            ToolMode::InstalledOnly
        );
    }

    #[test]
    fn installed_only_reports_a_typed_soft_error_without_downloading() {
        let home = std::env::temp_dir().join(format!(
            "story_studio_ytdlp_installed_only_{}",
            uuid::Uuid::new_v4()
        ));
        let messages = std::cell::RefCell::new(Vec::new());
        let emit = |message: &str| messages.borrow_mut().push(message.to_string());
        let error = match Ytdlp::prepare_for(ToolMode::InstalledOnly, &home, None, &emit) {
            Err(error) => error,
            Ok(_) => panic!("yt-dlp absent"),
        };
        assert_eq!(error.code, YoutubeErrorCode::ToolMissing);
        assert!(!home.exists(), "rien n'a été téléchargé");
        assert!(messages.borrow().is_empty(), "aucune préparation annoncée");
        assert_eq!(
            serde_json::to_value(error.code).unwrap(),
            serde_json::json!("tool_missing")
        );
    }

    #[test]
    fn tool_status_serializes_for_the_frontend() {
        let status = ToolStatus {
            ytdlp_missing: false,
            ytdlp_update_due: true,
            js_runtime_missing: true,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({ "ytdlpMissing": false, "ytdlpUpdateDue": true, "jsRuntimeMissing": true })
        );
    }

    #[test]
    fn passes_the_js_runtime_path_only_when_available() {
        assert_eq!(
            common_args(None),
            vec![
                OsString::from("--ignore-config"),
                OsString::from("--no-warnings")
            ]
        );
        let args = common_args(Some(Path::new("/data/yt-dlp/deno/2.9.7/deno")));
        assert_eq!(args[2], OsString::from("--js-runtimes"));
        assert_eq!(args[3], OsString::from("deno:/data/yt-dlp/deno/2.9.7/deno"));
    }
}
