import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

  useEffect(() => {
    // Un job est déjà en cours d'exécution dans cette instance
    if (executingRef.current) return;

    // Un job est 'running' dans le store (ex: remontage du composant)
    const hasRunning = jobs.some(j => j.status === 'running');
    if (hasRunning) return;

    // Prochain job en attente
    const nextJob = jobs.find(j => j.status === 'pending');
    if (!nextJob) return;

    executingRef.current = true;
    updateJob(nextJob.id, { status: 'running' });

    (async () => {
      let unlisten;
      try {
        unlisten = await listen('generate-log', (event) => {
          appendLog(nextJob.id, event.payload);
        });

        const resultPath = await invoke('generate_pack', {
          projectJson: nextJob.projectJson,
          outputFolder: nextJob.outputFolder,
        });

        updateJob(nextJob.id, { status: 'done', resultPath: resultPath ?? null });
        playNotification('done');
      } catch (err) {
        updateJob(nextJob.id, { status: 'error', errorMessage: String(err) });
        playNotification('error');
      } finally {
        if (unlisten) unlisten();
        executingRef.current = false;
      }
    })();
  }, [jobs, updateJob, appendLog]);
}
