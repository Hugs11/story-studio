use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn file_ext(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("bin")
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(target_os = "windows")]
pub(crate) fn apply_no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn apply_no_window(_cmd: &mut Command) {}

pub(crate) fn get_ffmpeg_path() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools").join("ffmpeg.exe");
            if bundled.exists() {
                return Ok(bundled);
            }
            let sibling = dir.join("ffmpeg.exe");
            if sibling.exists() {
                return Ok(sibling);
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for base in cwd.ancestors() {
        let candidate = base.join("tools").join("ffmpeg.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("ffmpeg introuvable.\n\
         En production, placez ffmpeg.exe dans tools/ à côté de l'application.\n\
         En développement, placez ffmpeg.exe dans le dossier tools/ du dépôt."
        .to_string())
}

/// Mesures loudnorm (EBU R128) issues d'une passe d'analyse, nécessaires pour
/// une seconde passe en mode `linear` (normalisation précise et non dynamique).
#[derive(Debug, Clone, Copy)]
pub(crate) struct LoudnormStats {
    pub measured_i: f64,
    pub measured_tp: f64,
    pub measured_lra: f64,
    pub measured_thresh: f64,
    pub offset: f64,
}

/// Première passe : mesure l'audio après `pre_filters` (ex. mono, trim des
/// bords) et renvoie les statistiques loudnorm. Renvoie `None` si la mesure
/// échoue ou n'est pas finie (silence pur, audio illisible) — l'appelant
/// retombe alors sur une normalisation une passe dynamique.
pub(crate) fn measure_loudnorm(
    ffmpeg: &Path,
    input: &Path,
    pre_filters: &[String],
    target_i: f64,
    target_tp: f64,
    target_lra: f64,
) -> Option<LoudnormStats> {
    let mut chain: Vec<String> = pre_filters.to_vec();
    chain.push(format!(
        "loudnorm=I={}:TP={}:LRA={}:print_format=json",
        fmt_loudnorm_num(target_i),
        fmt_loudnorm_num(target_tp),
        fmt_loudnorm_num(target_lra)
    ));
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:a:0")
        .arg("-af")
        .arg(chain.join(","))
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let out = cmd.output().ok()?;
    parse_loudnorm_stats(&String::from_utf8_lossy(&out.stderr))
}

/// Construit le filtre loudnorm : seconde passe `linear` si `stats` est fourni
/// (mesures de la première passe), sinon une passe dynamique en repli.
pub(crate) fn loudnorm_filter(
    stats: Option<LoudnormStats>,
    target_i: f64,
    target_tp: f64,
    target_lra: f64,
) -> String {
    let base = format!(
        "loudnorm=I={}:TP={}:LRA={}",
        fmt_loudnorm_num(target_i),
        fmt_loudnorm_num(target_tp),
        fmt_loudnorm_num(target_lra)
    );
    match stats {
        Some(s) => format!(
            "{}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true",
            base, s.measured_i, s.measured_tp, s.measured_lra, s.measured_thresh, s.offset
        ),
        None => base,
    }
}

fn parse_loudnorm_stats(stderr: &str) -> Option<LoudnormStats> {
    let start = stderr.find('{')?;
    let end = stderr.rfind('}')?;
    let value: serde_json::Value = serde_json::from_str(&stderr[start..=end]).ok()?;
    let get = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(parse_finite_f64)
    };
    Some(LoudnormStats {
        measured_i: get("input_i")?,
        measured_tp: get("input_tp")?,
        measured_lra: get("input_lra")?,
        measured_thresh: get("input_thresh")?,
        offset: get("target_offset")?,
    })
}

fn parse_finite_f64(raw: &str) -> Option<f64> {
    let value = raw.trim().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn fmt_loudnorm_num(value: f64) -> String {
    let formatted = format!("{:.3}", value);
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}
