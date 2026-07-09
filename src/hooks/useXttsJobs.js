import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { addProjectPrefix } from '../utils/fileUtils';

export function useXttsJobs(xttsStore, onAudioGenerated, workspaceDir = null, onMediaCreated = null) {
  useEffect(() => {
    const isRunning = xttsStore.jobs.some(j => j.status === 'running');
    if (isRunning) return;
    const next = xttsStore.jobs.find(j => j.status === 'pending');
    if (!next) return;
    xttsStore.updateJob(next.id, { status: 'running', errorMessage: null, progress: null, progressLabel: null });
    // Routage backend : Piper (défaut zéro-config) ou XTTS (opt-in). La file
    // de jobs reste commune ; seule la commande Rust invoquée diffère.
    const command = next.settings?.backend === 'piper' ? 'piper_generate_audio' : 'xtts_generate_audio';
    invoke(command, {
      settings: next.settings,
      request: { ...next.request, workspaceDir },
    })
      .then(async (path) => {
        let finalPath = path;
        if (next.projectName) {
          try { finalPath = await addProjectPrefix(path, next.projectName); } catch { /* au mieux */ }
        }
        xttsStore.updateJob(next.id, { status: 'done', resultPath: finalPath, progress: 1, progressLabel: '100%' });
        onAudioGenerated(next.target, finalPath, next);
        onMediaCreated?.(finalPath);
      })
      .catch((e) => {
        xttsStore.updateJob(next.id, { status: 'error', errorMessage: String(e) });
      });
  }, [xttsStore.jobs, workspaceDir]);
}
