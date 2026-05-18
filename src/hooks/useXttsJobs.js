import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { addProjectPrefix } from '../utils/fileUtils';

export function useXttsJobs(xttsStore, onAudioGenerated, workspaceDir = null, onMediaCreated = null) {
  useEffect(() => {
    const pending = xttsStore.jobs.filter(j => j.status === 'pending');
    if (pending.length === 0) return;
    for (const job of pending) {
      xttsStore.updateJob(job.id, { status: 'running', errorMessage: null, progress: null, progressLabel: null });
      invoke('xtts_generate_audio', {
        settings: job.settings,
        request: { ...job.request, workspaceDir },
      })
        .then(async (path) => {
          let finalPath = path;
          if (job.projectName) {
            try { finalPath = await addProjectPrefix(path, job.projectName); } catch { /* best effort */ }
          }
          xttsStore.updateJob(job.id, { status: 'done', resultPath: finalPath, progress: 1, progressLabel: '100%' });
          onAudioGenerated(job.target, finalPath);
          onMediaCreated?.(finalPath);
        })
        .catch((e) => {
          xttsStore.updateJob(job.id, { status: 'error', errorMessage: String(e) });
        });
    }
  }, [xttsStore.jobs, workspaceDir]);
}
