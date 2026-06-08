import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../utils/tauriRuntime';

function playNotification(type) {
  try {
    const ctx = new AudioContext();
    const notes = type === 'done'
      ? [{ f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.13, d: 0.12 }, { f: 784, t: 0.26, d: 0.2 }]
      : [{ f: 400, t: 0, d: 0.15 }, { f: 280, t: 0.16, d: 0.25 }];
    notes.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = type === 'done' ? 'sine' : 'sawtooth';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.18, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + d);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

// Exécute les jobs de rendu un par un dans l'ordre de la file.
// Un seul job est en status 'running' à l'instant T.
// Les logs generate-log sont routés vers le job en cours.
export function useRenderQueueExecutor({ jobs, updateJob, appendLog }) {
  const executingRef = useRef(false);
  const runningJobIdRef = useRef(null);
  const jobsRef = useRef(jobs);
  const cancelSentForRef = useRef(null);

  useEffect(() => {
    jobsRef.current = jobs;
    runningJobIdRef.current = jobs.find(j => j.status === 'running')?.id ?? null;
  }, [jobs]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;

    let cancelled = false;
    let unlisten = null;
    listen('generate-log', (event) => {
      const runningJobId = runningJobIdRef.current;
      if (!runningJobId || event.payload == null) return;
      appendLog(runningJobId, String(event.payload));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [appendLog]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const runningCancelJob = jobs.find(j => j.status === 'running' && j.cancelRequested);
    if (!runningCancelJob || cancelSentForRef.current === runningCancelJob.id) return;
    cancelSentForRef.current = runningCancelJob.id;
    appendLog(runningCancelJob.id, '⏹ Demande d’annulation envoyée…');
    invoke('cancel_generate_pack').catch((err) => {
      appendLog(runningCancelJob.id, `⚠️ Impossible de demander l’annulation : ${String(err)}`);
      cancelSentForRef.current = null;
    });
  }, [jobs, appendLog]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    // Un job est déjà en cours d'exécution dans cette instance
    if (executingRef.current) return;

    // Un job est 'running' dans le store (ex: remontage du composant)
    const hasRunning = jobs.some(j => j.status === 'running');
    if (hasRunning) return;

    // Prochain job en attente
    const nextJob = jobs.find(j => j.status === 'pending');
    if (!nextJob) return;

    executingRef.current = true;
    runningJobIdRef.current = nextJob.id;
    updateJob(nextJob.id, { status: 'running' });
    appendLog(nextJob.id, `▶ Démarrage génération : ${nextJob.projectName}`);
    appendLog(nextJob.id, `  Dossier de sortie : ${nextJob.outputFolder}`);

    (async () => {
      try {
        const resultPath = await invoke('generate_pack', {
          projectJson: nextJob.projectJson,
          outputFolder: nextJob.outputFolder,
        });

        const currentJob = jobsRef.current.find(j => j.id === nextJob.id);
        if (currentJob?.cancelRequested) {
          updateJob(nextJob.id, { status: 'canceled', cancelRequested: false, resultPath: null });
          appendLog(nextJob.id, '⏹ Génération annulée.');
          return;
        }
        updateJob(nextJob.id, { status: 'done', resultPath: resultPath ?? null });
        playNotification('done');
      } catch (err) {
        const message = String(err);
        const currentJob = jobsRef.current.find(j => j.id === nextJob.id);
        if (currentJob?.cancelRequested || message.toLowerCase().includes('annul')) {
          updateJob(nextJob.id, { status: 'canceled', cancelRequested: false, errorMessage: null });
          appendLog(nextJob.id, '⏹ Génération annulée.');
        } else {
          updateJob(nextJob.id, { status: 'error', errorMessage: message });
          playNotification('error');
        }
      } finally {
        cancelSentForRef.current = null;
        executingRef.current = false;
      }
    })();
  }, [jobs, updateJob, appendLog]);
}
