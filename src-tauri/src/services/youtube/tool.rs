//! Invocation commune de yt-dlp : binaire provisionné, moteur JavaScript et
//! arguments partagés, plus l'espacement des requêtes vers YouTube.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::js_runtime::ensure_js_runtime;
use super::provision::ensure_ytdlp;
use crate::support::ffmpeg::apply_no_window;

/// Pause entre deux requêtes d'une même analyse (valeur du préréglage
/// `--preset-alias sleep` de yt-dlp).
pub(super) const SLEEP_REQUESTS: &str = "0.75";
/// Écart minimal entre deux processus qui interrogent l'API de lecture.
const MIN_GAP_BETWEEN_ANALYSES: Duration = Duration::from_secs(3);

static LAST_ANALYSIS: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

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
    use super::common_args;
    use std::ffi::OsString;
    use std::path::Path;

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
