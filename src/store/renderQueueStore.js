import { useState, useCallback } from 'react';

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Job shape:
// {
//   id: string,
//   projectName: string,
//   savePath: string | null,
//   projectJson: string,
//   outputFolder: string,
//   status: 'pending' | 'running' | 'done' | 'error' | 'canceled',
//   cancelRequested: boolean,
//   logs: string[],
//   resultPath: string | null,
//   errorMessage: string | null,
//   createdAt: number,
// }

export function useRenderQueueStore() {
  const [jobs, setJobs] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);

  const addJob = useCallback(({ projectName, savePath, projectJson, outputFolder }) => {
    const job = {
      id: genId(),
      projectName: projectName || '(sans nom)',
      savePath: savePath ?? null,
      projectJson,
      outputFolder,
      status: 'pending',
      cancelRequested: false,
      logs: [],
      resultPath: null,
      errorMessage: null,
      createdAt: Date.now(),
    };
    setJobs(prev => [...prev, job]);
    setPanelOpen(true);
    return job.id;
  }, []);

  const updateJob = useCallback((id, fields) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...fields } : j));
  }, []);

  const appendLog = useCallback((id, line) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, logs: [...j.logs, line] } : j));
  }, []);

  const removeJob = useCallback((id) => {
    setJobs(prev => prev.filter(j => j.id !== id));
  }, []);

  const cancelJob = useCallback((id) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== id) return j;
      if (j.status === 'pending') {
        return {
          ...j,
          status: 'canceled',
          cancelRequested: false,
          errorMessage: null,
        };
      }
      if (j.status === 'running') {
        return {
          ...j,
          cancelRequested: true,
        };
      }
      return j;
    }));
  }, []);

  const clearDone = useCallback(() => {
    setJobs(prev => prev.filter(j => j.status !== 'done' && j.status !== 'error' && j.status !== 'canceled'));
  }, []);

  const activeCount = jobs.filter(j => j.status === 'pending' || j.status === 'running').length;
  const hasResults = jobs.some(j => j.status === 'done');
  const runningJob = jobs.find(j => j.status === 'running') ?? null;

  return {
    jobs,
    addJob,
    updateJob,
    appendLog,
    removeJob,
    cancelJob,
    clearDone,
    activeCount,
    hasResults,
    runningJob,
    panelOpen,
    setPanelOpen,
  };
}
