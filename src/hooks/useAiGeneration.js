import { useState } from 'react';
import { sanitizeImportedName } from '../store/projectStore';
import { getImageJobTargetLabel } from '../store/aiJobLabels';
import { getProjectFilePrefix } from '../utils/projectPrefix';
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

  function handleSDGenerate(workflowId, workflowName, params) {
    sdStore.addJob(workflowId, workflowName, params, {
      projectName: getProjectFilePrefix(store.project, store.savePath),
      fieldId: sdGenerateContext?.fieldId || null,
      targetLabel: getImageJobTargetLabel(sdGenerateContext, projectIndex),
    });
    handleOpenAiQueue();
  }

  function applyGeneratedAudioToTarget(target, path, job = null) {
    return dispatchGeneratedAudioToTarget({ target, path, job, store, projectIndex, getStoryName: getTtsStoryName });
  }

  async function handleQueueXttsGenerate(job) {
    xttsStore.addJob({
      label: job.targetLabel || 'Audio IA',
      targetLabel: job.targetLabel || 'Audio IA',
      voiceLabel: job.voiceLabel || 'XTTS',
      target: job.target || null,
      request: job.request,
      settings: { ...xttsSettings },
      projectName: getProjectFilePrefix(store.project, store.savePath),
    });
    handleOpenAiQueue();
  }

  return {
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
