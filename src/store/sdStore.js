import { releaseProjectMediaJob } from './projectMediaOutput';
import { useState, useCallback, useEffect, useRef } from 'react';
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
  const jobsRef = useRef(jobs);
  const mutateJobs = useCallback((transform) => {
    jobsRef.current = transform(jobsRef.current);
    setJobs(jobsRef.current);
  }, []);

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
      mediaOutput: options.mediaOutput,
      projectEpoch: options.projectEpoch,
      fieldId: options.fieldId || null,
      targetLabel: options.targetLabel || '',
      targetLabelRef: options.targetLabelRef || null,
    };
    mutateJobs(prev => [...prev, job]);
    return job.id;
  }, [mutateJobs]);

  const updateJob = useCallback((id, fields) => {
    const terminal = fields.status === 'done' || fields.status === 'error';
    const job = jobsRef.current.find((candidate) => candidate.id === id);
    if (terminal) releaseProjectMediaJob(job);
    mutateJobs(prev => prev.flatMap(candidate => candidate.id !== id ? [candidate]
      : terminal && candidate.removeWhenFinished ? [] : [{ ...candidate, ...fields }]));
  }, [mutateJobs]);

  const removeJob = useCallback((id) => {
    const job = jobsRef.current.find((candidate) => candidate.id === id);
    if (!job) return;
    // Keep a running producer tracked until its native write finishes.
    const running = job.status === 'submitting' || job.status === 'running';
    if (!running) releaseProjectMediaJob(job);
    mutateJobs(prev => prev.flatMap(candidate => candidate.id !== id ? [candidate]
      : running ? [{ ...candidate, removeWhenFinished: true }] : []));
  }, [mutateJobs]);

  const clearDone = useCallback(() => {
    mutateJobs(prev => prev.filter(j => j.status !== 'done' && j.status !== 'error'));
  }, [mutateJobs]);

  const removeResult = useCallback((jobId, resultPath) => {
    mutateJobs(prev => prev
      .map(j => j.id === jobId ? { ...j, resultPaths: j.resultPaths.filter(p => p !== resultPath) } : j)
      .filter(j => j.status !== 'done' || j.resultPaths.length > 0),
    );
  }, [mutateJobs]);

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
