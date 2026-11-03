import { aiRef } from '../i18n/aiPresentation.js';
import { useState } from 'react';
import { sanitizeImportedName } from '../store/projectStore';
import { getImageJobTargetRef } from '../store/aiJobLabels';
import { captureProjectMediaJob } from '../store/projectMediaOutput';
import { applyGeneratedAudioToTarget as dispatchGeneratedAudioToTarget } from '../store/generatedAudioTarget';

function getTtsStoryName(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const punctuationIndexes = ['.', '!', '?']
    .map((mark) => normalized.indexOf(mark))
    .filter((index) => index >= 0);
  const firstStop = punctuationIndexes.length > 0 ? Math.min(...punctuationIndexes) : -1;
  const firstSentence = firstStop >= 0 ? normalized.slice(0, firstStop) : normalized;
  const clipped = firstSentence.length > 72 ? `${firstSentence.slice(0, 72).trim()}...` : firstSentence;
  return sanitizeImportedName(clipped, '');
}

// Dispatch de génération IA extrait d'AppContent : ouverture de la file IA,
// génération/régénération d'image (SD/ComfyUI),
// génération de voix (XTTS) et application d'un audio généré à sa cible.
//
// Ordre d'appel critique dans l'hôte : `applyGeneratedAudioToTarget` est passé à
// `useXttsJobs` — ce hook doit donc être appelé AVANT `useSDJobs`/`useXttsJobs`,
// pour que la valeur retournée existe au moment du câblage (fonction jadis
// hoistée, désormais valeur de retour).
export function useAiGeneration({
  store,
  mediaStorageRef,
  sdStore,
  xttsStore,
  projectIndex,
  xttsSettings,
  setBottomPanelOpen,
  setBottomPanelTab,
}) {
  const [sdGenerateOpen, setSdGenerateOpen] = useState(false);
  const [sdGenerateContext, setSdGenerateContext] = useState(null);

  function handleOpenAiQueue() {
    setBottomPanelTab('ai');
    setBottomPanelOpen(true);
  }

  function handleOpenSDGenerate(context = null) {
    setSdGenerateContext(context);
    setSdGenerateOpen(true);
  }

  function handleRegenerateImageJob(job) {
    if (!job) return;
    setSdGenerateContext({ regenerateJob: job });
    setSdGenerateOpen(true);
  }

  async function handleSDGenerate(workflowId, workflowName, params) {
    const projectEpoch = store.workEpochRef.current;
    const mediaOutput = await captureProjectMediaJob(mediaStorageRef.current);
    sdStore.addJob(workflowId, workflowName, params, {
      mediaOutput,
      projectEpoch,
      fieldId: sdGenerateContext?.fieldId || null,
      targetLabelRef: getImageJobTargetRef(sdGenerateContext, projectIndex),
    });
    handleOpenAiQueue();
  }

  function applyGeneratedAudioToTarget(target, path, job = null) {
    return dispatchGeneratedAudioToTarget({ target, path, job, store, projectIndex, getStoryName: getTtsStoryName });
  }

  async function handleQueueXttsGenerate(job) {
    const projectEpoch = store.workEpochRef.current;
    const settings = { ...xttsSettings };
    const target = job.target ? { projectEpoch, ...job.target } : null;
    const mediaOutput = await captureProjectMediaJob(mediaStorageRef.current);
    const labelRef = job.targetLabelRef || (!job.targetLabel ? aiRef("ai:queue.audio.name") : null);
    xttsStore.addJob({
      label: labelRef ? '' : job.targetLabel || '',
      labelRef,
      targetLabel: labelRef ? '' : job.targetLabel || '',
      targetLabelRef: labelRef,
      voiceLabel: job.voiceLabel || 'XTTS',
      // Toute cible est liée au travail qui l'a demandée : une voix revenue
      // après l'ouverture d'un autre projet ne s'y applique pas (garde de
      // `applyGeneratedAudioToTarget`). Une cible qui porte déjà son époque la
      // garde.
      target,
      request: job.request,
      settings,
      mediaOutput,
      projectEpoch,
    });
    handleOpenAiQueue();
  }

  function relocateMediaJobPaths(remap) {
    for (const job of xttsStore.jobs) {
      if (job.resultPath) xttsStore.updateJob(job.id, { resultPath: remap(job.resultPath) });
    }
    for (const job of sdStore.jobs) {
      if (job.resultPaths?.length) sdStore.updateJob(job.id, { resultPaths: job.resultPaths.map(remap) });
    }
  }

  return {
    relocateMediaJobPaths,
    handleOpenAiQueue,
    handleOpenSDGenerate,
    handleRegenerateImageJob,
    handleSDGenerate,
    applyGeneratedAudioToTarget,
    handleQueueXttsGenerate,
    sdGenerate: {
      open: sdGenerateOpen,
      context: sdGenerateContext,
      close: () => {
        setSdGenerateOpen(false);
        setSdGenerateContext(null);
      },
    },
  };
}
