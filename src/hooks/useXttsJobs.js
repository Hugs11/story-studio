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
    invoke('xtts_generate_audio', {
      settings: next.settings,
      request: { ...next.request, workspaceDir },
    })
      .then(async (path) => {
        let finalPath = path;
        if (next.projectName) {
          try { finalPath = await addProjectPrefix(path, next.projectName); } catch { /* best effort */ }
        }
        xttsStore.updateJob(next.id, { status: 'done', resultPath: finalPath, progress: 1, progressLabel: '100%' });
        onAudioGenerated(next.target, finalPath);
        onMediaCreated?.(finalPath);
      })
      .catch((e) => {
        xttsStore.updateJob(next.id, { status: 'error', errorMessage: String(e) });
      });
  }, [xttsStore.jobs, workspaceDir]);
}
