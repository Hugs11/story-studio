//! Invocation de l'outil externe, et classement de son issue.
//!
//! Une issue d'invocation se classe par **la phase et l'opération**, pas par le
//! sort du processus seul : un encodeur inexistant et une destination sous un
//! parent absent font sortir FFmpeg en échec sur un WAV parfaitement décodable.
//! Demander à l'auteur de remplacer ce média serait faux. La table de
//! `classify` est donc **totale** sur les quatre issues possibles, et
//! l'opération y entre comme une donnée connue par construction.
//!
//! **Aucun `stderr` n'est lu pour choisir un type.** Sa queue est conservée
//! comme **donnée** dans `detail`, pour que l'auteur voie ce que l'outil a dit ;
//! elle n'entre dans aucune décision.

use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use crate::support::ffmpeg::apply_no_window;

use super::MediaCause;

/// Délai au-delà duquel une invocation est tenue pour bloquée.
///
/// Généreux : il n'existe pas pour cadencer un export, mais pour qu'un outil
/// qui ne rend jamais la main devienne un refus lisible plutôt qu'un blocage.
pub(crate) const DEFAULT_TOOL_DEADLINE: Duration = Duration::from_secs(600);

/// Pas d'attente entre deux constats de fin de processus.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Queue de `stderr` reprise dans le `detail` d'un refus.
const STDERR_TAIL_BYTES: usize = 2048;

/// Plafond de conservation de `stderr`. Les mesures d'enveloppe RMS écrivent
/// une ligne par fenêtre : le flux entier est nécessaire pour les relire, mais
/// il ne doit pas pouvoir croître sans borne.
const STDERR_MAX_BYTES: usize = 8 * 1024 * 1024;

/// L'opération pour laquelle l'outil est invoqué.
///
/// Elle n'est jamais devinée : l'inventaire valide, la préparation convertit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolOperation {
    Validation,
    Conversion,
}

/// Les quatre issues d'une invocation, disjointes et exhaustives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InvocationOutcome {
    /// L'outil n'a pas pu être lancé : absent, non exécutable, échec de départ.
    NotLaunched,
    /// Tué par un signal, ou délai dépassé.
    Interrupted,
    /// Exécuté jusqu'au bout, statut d'échec.
    Failed,
    Succeeded,
}

/// Ce qu'une invocation laisse : son issue, ce que l'outil a dit, ce qu'il a
/// produit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolRun {
    pub(crate) outcome: InvocationOutcome,
    /// Flux d'erreur complet, plafonné. Il porte aussi les **mesures** que
    /// FFmpeg écrit là — enveloppe RMS, résumé EBU R128 — que les analyseurs
    /// déjà éprouvés du mode Libre relisent sans être dupliqués.
    pub(crate) stderr: String,
    /// Octets décodés reçus sur la sortie standard. Nul pour une conversion,
    /// qui écrit dans un fichier.
    pub(crate) produced_bytes: u64,
}

impl ToolRun {
    pub(crate) fn produced_data(&self) -> bool {
        self.produced_bytes > 0
    }

    /// Ce qu'un refus porte dans `detail` : la queue du flux, comme **donnée**.
    pub(crate) fn detail(&self) -> String {
        let wanted = self.stderr.len().saturating_sub(STDERR_TAIL_BYTES);
        let start = (wanted..=self.stderr.len())
            .find(|index| self.stderr.is_char_boundary(*index))
            .unwrap_or(self.stderr.len());
        self.stderr[start..].trim().to_string()
    }
}

/// Classement d'une issue par opération — la table entière.
///
/// `None` signifie « rien à refuser ». `produced_data` n'est consulté que pour
/// une validation : la décodabilité est une propriété du média, et une
/// conversion opère sur un instantané **déjà validé**, donc elle ne peut plus
/// conclure `undecodable`.
pub(crate) fn classify(
    operation: ToolOperation,
    outcome: &InvocationOutcome,
    produced_data: bool,
) -> Option<MediaCause> {
    match (operation, outcome) {
        (_, InvocationOutcome::NotLaunched) => Some(MediaCause::ToolUnavailable),
        (_, InvocationOutcome::Interrupted) => Some(MediaCause::ToolInterrupted),
        (ToolOperation::Validation, InvocationOutcome::Failed) => {
            if produced_data {
                // Du son est sorti, puis le flux a buté : le fichier est
                // probablement endommagé, il n'est pas « indécodable ».
                Some(MediaCause::ValidationFailed)
            } else {
                Some(MediaCause::Undecodable)
            }
        }
        (ToolOperation::Validation, InvocationOutcome::Succeeded) => {
            // Un décodage qui s'achève sans rien produire n'a rien établi.
            if produced_data {
                None
            } else {
                Some(MediaCause::Undecodable)
            }
        }
        (ToolOperation::Conversion, InvocationOutcome::Failed) => {
            Some(MediaCause::ProcessingFailed)
        }
        (ToolOperation::Conversion, InvocationOutcome::Succeeded) => None,
    }
}

/// Décode entièrement un média audio pour constater deux faits séparés : le
/// décodage s'est-il **achevé avec succès**, et a-t-il **produit des données**.
///
/// Le flux décodé est compté puis jeté : rien n'est conservé en mémoire, et
/// aucune de ces deux constatations n'est un texte à interpréter.
pub(crate) fn decode_probe(ffmpeg: &Path, input: &Path, deadline: Duration) -> ToolRun {
    let args = [
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-i",
        &input.to_string_lossy(),
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-",
    ]
    .map(str::to_string);
    run_tool(ffmpeg, &args, deadline, StdoutHandling::Count)
}

/// Ce que l'invocation fait de la sortie standard de l'outil.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StdoutHandling {
    /// Comptée puis jetée — c'est le volume décodé.
    Count,
    /// Ignorée : l'outil écrit dans un fichier.
    Discard,
}

/// Lance l'outil, draine ses deux flux, et attend sa fin sous délai.
///
/// Les deux flux sont drainés par des fils dédiés : sans cela un tube plein
/// bloquerait l'outil, et le délai mesurerait notre propre blocage plutôt que
/// le sien.
pub(crate) fn run_tool(
    tool: &Path,
    args: &[String],
    deadline: Duration,
    stdout_handling: StdoutHandling,
) -> ToolRun {
    let mut command = Command::new(tool);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(match stdout_handling {
            StdoutHandling::Count => Stdio::piped(),
            StdoutHandling::Discard => Stdio::null(),
        });
    apply_no_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ToolRun {
                outcome: InvocationOutcome::NotLaunched,
                stderr: format!("{} : {error}", tool.display()),
                produced_bytes: 0,
            }
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    std::thread::scope(|scope| {
        let counter = scope.spawn(move || match stdout {
            Some(mut stream) => drain_counting(&mut stream),
            None => 0,
        });
        let collector = scope.spawn(move || match stderr {
            Some(mut stream) => drain_capped(&mut stream),
            None => String::new(),
        });

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if started.elapsed() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(_) => {
                    let _ = child.kill();
                    break None;
                }
            }
        };

        let produced_bytes = counter.join().unwrap_or(0);
        let stderr = collector.join().unwrap_or_default();

        let outcome = match status {
            None => InvocationOutcome::Interrupted,
            Some(status) if was_terminated_by_signal(&status) => InvocationOutcome::Interrupted,
            Some(status) if status.success() => InvocationOutcome::Succeeded,
            Some(_) => InvocationOutcome::Failed,
        };

        ToolRun {
            outcome,
            stderr,
            produced_bytes,
        }
    })
}

fn drain_counting(stream: &mut impl Read) -> u64 {
    let mut scratch = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        match stream.read(&mut scratch) {
            Ok(0) | Err(_) => break,
            Ok(read) => total += read as u64,
        }
    }
    total
}

fn drain_capped(stream: &mut impl Read) -> String {
    let mut collected = Vec::new();
    let mut scratch = [0_u8; 8 * 1024];
    loop {
        match stream.read(&mut scratch) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if collected.len() < STDERR_MAX_BYTES {
                    collected.extend_from_slice(&scratch[..read]);
                }
            }
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

/// Adaptateur de frontière : seul Unix expose le signal qui a tué un processus.
///
/// `ExitStatusExt::signal` n'existe pas sur Windows, dont l'API ne distingue pas
/// une terminaison forcée d'un code de sortie ordinaire. La divergence est donc
/// imposée par le système, pas par un symptôme : sur Windows un processus tué
/// retombe dans `Failed`, et seul le dépassement de délai — que nous mesurons
/// nous-mêmes, sur les trois plateformes — produit `tool-interrupted`.
#[cfg(unix)]
fn was_terminated_by_signal(status: &ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    status.signal().is_some()
}

#[cfg(not(unix))]
fn was_terminated_by_signal(_status: &ExitStatus) -> bool {
    false
}
