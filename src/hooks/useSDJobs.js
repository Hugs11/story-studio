import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { addProjectPrefix } from '../utils/fileUtils';

export function useSDJobs(sdStore, workspaceDir = null, onMediaCreated = null) {
  useEffect(() => {
    let cancelled = false;
    let unlisten = null;
    listen('comfyui-progress', (event) => {
      if (cancelled) return;
      const payload = event.payload || {};
      if (!payload.jobId) return;
      if (payload.error) {
        console.debug('[ComfyUI progress]', payload.error);
        return;
      }
      if (typeof payload.progress === 'number') {
        sdStore.updateJob(payload.jobId, {
          progress: payload.progress,
          progressLabel: payload.progressLabel || null,
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const pending = sdStore.jobs.filter(j => j.status === 'pending');
    if (pending.length === 0) return;
    for (const job of pending) {
      sdStore.updateJob(job.id, { status: 'submitting', progress: null, progressLabel: null });
      invoke('comfyui_watch_progress', {
        settings: sdStore.sdSettings,
        clientId: job.clientId,
        jobId: job.id,
      }).catch(e => console.debug('[ComfyUI progress]', String(e)));
      invoke('comfyui_submit_job', {
        settings: sdStore.sdSettings,
        request: {
          workflowId: job.workflowId,
          positivePrompt: job.params.positivePrompt,
          negativePrompt: job.params.negativePrompt,
          seed: job.params.seed,
          steps: job.params.steps,
          cfg: job.params.cfg,
          loraStrength: job.params.loraStrength,
          referenceImagePath: job.params.referenceImagePath || null,
          clientId: job.clientId,
        },
      })
        .then(promptId => sdStore.updateJob(job.id, { status: 'running', promptId, progress: null, progressLabel: null }))
        .catch(e => sdStore.updateJob(job.id, { status: 'error', errorMessage: String(e) }));
    }
  }, [sdStore.jobs]);

  useEffect(() => {
    const running = sdStore.jobs.filter(j => j.status === 'running' && j.promptId);
    if (running.length === 0) return;
    const interval = setInterval(async () => {
      for (const job of running) {
        try {
          const result = await invoke('comfyui_poll_job', {
            settings: sdStore.sdSettings,
            promptId: job.promptId,
          });
          if (result.status === 'pending' || result.status === 'running') {
            const fields = { status: 'running' };
            if (typeof result.progress === 'number') {
              fields.progress = result.progress;
              fields.progressLabel = result.progressLabel || null;
            }
            sdStore.updateJob(job.id, fields);
          }
          if (result.status === 'done') {
            const downloaded = await Promise.all(
              result.outputFiles.map(f =>
                invoke('comfyui_download_output', {
                  settings: sdStore.sdSettings,
                  filename: f.filename,
                  subfolder: f.subfolder,
                  promptId: job.promptId,
                  workspaceDir,
                })
              )
            );
            const paths = job.projectName
              ? await Promise.all(downloaded.map(p => addProjectPrefix(p, job.projectName).catch(() => p)))
              : downloaded;
            sdStore.updateJob(job.id, { status: 'done', resultPaths: paths, progress: 1, progressLabel: '100%' });
            for (const p of paths) onMediaCreated?.(p);
          } else if (result.status === 'error') {
            sdStore.updateJob(job.id, { status: 'error', errorMessage: result.error || 'Erreur ComfyUI', progress: null, progressLabel: null });
          }
        } catch (e) {
          sdStore.updateJob(job.id, { status: 'error', errorMessage: String(e) });
        }
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [sdStore.jobs, workspaceDir]);
}
