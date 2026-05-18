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
//   status: 'pending' | 'running' | 'done' | 'error',
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

  const clearDone = useCallback(() => {
    setJobs(prev => prev.filter(j => j.status !== 'done' && j.status !== 'error'));
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
    clearDone,
    activeCount,
    hasResults,
    runningJob,
    panelOpen,
    setPanelOpen,
  };
}
