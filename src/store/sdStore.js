import { useState, useCallback, useEffect } from 'react';
import { loadSdSettings, saveSdSettings } from './sdSettings';
import { KEYS, read, write } from './persistentSettings';

function loadPersistedJobs() {
  const jobs = read(KEYS.SD_RESULTS, { parse: JSON.parse, defaultValue: [] });
  return Array.isArray(jobs) ? jobs : [];
}

function persistDoneJobs(jobs) {
  const toSave = jobs.filter(j => j.status === 'done' && j.resultPaths.length > 0);
  write(KEYS.SD_RESULTS, toSave, { serialize: JSON.stringify });
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Structure d'un job :
// {
//   id: string,           // uuid côté client
//   workflowId: string,
//   workflowName: string,
//   status: 'pending' | 'submitting' | 'running' | 'done' | 'error',
//   params: { positivePrompt, negativePrompt, seed, steps, cfg, loraStrength, referenceImagePath },
//   clientId: string,
//   promptId: string | null,
//   resultPaths: string[],
//   errorMessage: string | null,
//   progress: number | null,
//   progressLabel: string | null,
//   targetLabel: string,
//   createdAt: number,
// }

export function useSdStore() {
  const [sdSettings, setSdSettings] = useState(() => loadSdSettings());
  const [jobs, setJobs] = useState(() => loadPersistedJobs());
  const [queueOpen, setQueueOpen] = useState(false);

  const updateSdSettings = useCallback((fields) => {
    setSdSettings(prev => {
      const next = { ...prev, ...fields };
      saveSdSettings(next);
      return next;
    });
  }, []);

  const addJob = useCallback((workflowId, workflowName, params, options = {}) => {
    const job = {
      id: genId(),
      workflowId,
      workflowName,
      status: 'pending',
      params,
      clientId: crypto.randomUUID?.() ?? genId(),
      promptId: null,
      resultPaths: [],
      errorMessage: null,
      progress: null,
      progressLabel: null,
      createdAt: Date.now(),
      projectName: options.projectName || '',
      fieldId: options.fieldId || null,
      targetLabel: options.targetLabel || '',
    };
    setJobs(prev => [...prev, job]);
    return job.id;
  }, []);

  const updateJob = useCallback((id, fields) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...fields } : j));
  }, []);

  const removeJob = useCallback((id) => {
    setJobs(prev => prev.filter(j => j.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setJobs(prev => prev.filter(j => j.status !== 'done' && j.status !== 'error'));
  }, []);

  const removeResult = useCallback((jobId, resultPath) => {
    setJobs(prev => prev
      .map(j => j.id === jobId ? { ...j, resultPaths: j.resultPaths.filter(p => p !== resultPath) } : j)
      .filter(j => j.status !== 'done' || j.resultPaths.length > 0),
    );
  }, []);

  useEffect(() => {
    persistDoneJobs(jobs);
  }, [jobs]);

  const pendingCount = jobs.filter(j => j.status === 'pending' || j.status === 'submitting' || j.status === 'running').length;
  const hasResults = jobs.some(j => j.status === 'done' && j.resultPaths.length > 0);

  return {
    sdSettings,
    updateSdSettings,
    jobs,
    addJob,
    updateJob,
    removeJob,
    clearDone,
    removeResult,
    pendingCount,
    hasResults,
    queueOpen,
    setQueueOpen,
  };
}
