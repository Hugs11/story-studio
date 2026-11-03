import { releaseProjectMediaJob } from './projectMediaOutput';
import { useCallback, useState, useRef } from 'react';

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useXttsStore() {
  const [jobs, setJobs] = useState([]);

  const jobsRef = useRef(jobs);
  const mutateJobs = useCallback((transform) => {
    jobsRef.current = transform(jobsRef.current);
    setJobs(jobsRef.current);
  }, []);

  const addJob = useCallback((job) => {
    const nextJob = {
      id: genId(),
      kind: 'audio',
      status: 'pending',
      resultPath: null,
      errorMessage: null,
      progress: null,
      progressLabel: null,
      createdAt: Date.now(),
      ...job,
    };
    mutateJobs(prev => [...prev, nextJob]);
    return nextJob.id;
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
    mutateJobs(prev => prev.filter(job => job.status !== 'done' && job.status !== 'error'));
  }, [mutateJobs]);

  const pendingCount = jobs.filter(job =>
    job.status === 'pending' || job.status === 'submitting' || job.status === 'running'
  ).length;
  const hasResults = jobs.some(job => job.status === 'done' && job.resultPath);

  return {
    jobs,
    addJob,
    updateJob,
    removeJob,
    clearDone,
    pendingCount,
    hasResults,
  };
}
