import { useCallback, useState } from 'react';

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useXttsStore() {
  const [jobs, setJobs] = useState([]);

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
    setJobs(prev => [...prev, nextJob]);
    return nextJob.id;
  }, []);

  const updateJob = useCallback((id, fields) => {
    setJobs(prev => prev.map(job => job.id === id ? { ...job, ...fields } : job));
  }, []);

  const removeJob = useCallback((id) => {
    setJobs(prev => prev.filter(job => job.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setJobs(prev => prev.filter(job => job.status !== 'done' && job.status !== 'error'));
  }, []);

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
