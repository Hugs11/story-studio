import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { addProjectPrefix } from '../utils/fileUtils';
import { logger } from '../utils/logger';

const MAX_CONCURRENT_SD_JOBS = 1;

export function useSDJobs(sdStore, workspaceDir = null, onMediaCreated = null) {
  useEffect(() => {
    let cancelled = false;
    let unlisten = null;
    listen('comfyui-progress', (event) => {
      if (cancelled) return;
      const payload = event.payload || {};
      if (!payload.jobId) return;
      if (payload.error) {
        logger.warn('comfyui:progress-error', payload.error);
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
    }).catch((error) => logger.error('comfyui:listen-error', error));

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const active = sdStore.jobs.filter(j => j.status === 'submitting' || j.status === 'running');
    if (active.length >= MAX_CONCURRENT_SD_JOBS) return;
    const next = sdStore.jobs.find(j => j.status === 'pending');
    if (!next) return;
    sdStore.updateJob(next.id, { status: 'submitting', progress: null, progressLabel: null });
    invoke('comfyui_watch_progress', {
      settings: sdStore.sdSettings,
      clientId: next.clientId,
      jobId: next.id,
    }).catch(e => logger.warn('comfyui:watch-progress-error', String(e)));
    invoke('comfyui_submit_job', {
      settings: sdStore.sdSettings,
      request: {
        workflowId: next.workflowId,
        positivePrompt: next.params.positivePrompt,
        negativePrompt: next.params.negativePrompt,
        seed: next.params.seed,
        steps: next.params.steps,
        cfg: next.params.cfg,
        loraStrength: next.params.loraStrength,
        referenceImagePath: next.params.referenceImagePath || null,
        clientId: next.clientId,
      },
    })
      .then(promptId => sdStore.updateJob(next.id, { status: 'running', promptId, progress: null, progressLabel: null }))
      .catch(e => sdStore.updateJob(next.id, { status: 'error', errorMessage: String(e) }));
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
