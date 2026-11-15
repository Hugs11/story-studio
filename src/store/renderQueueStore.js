// La file de rendu : ce qui est demandé, ce qui tourne, ce qui reste.
//
// Elle sert **deux natures de travail** — un document Libre confié à
// `generate_pack`, un document graphe confié à `export_advanced_pack`. Ce n'est
// pas une fusion de moteurs : les deux commandes partagent le poste natif.
// L'auteur n'a pas à savoir quelle chaîne a fabriqué son pack pour savoir où en
// suivre l'avancement.
//
// La forme d'un travail et les décisions qu'on prend dessus vivent dans
// `production/renderQueueWork.js`, sans React : l'ordonnancement et l'annulation
// s'éprouvent sans monter d'écran.

import { useState, useCallback, useRef } from 'react';
import { releaseProjectMediaJob } from './projectMediaOutput';

import {
  JOB_STATUS,
  hasActiveAdvancedWork,
  isActiveStatus,
  isTerminalStatus,
  newRenderJob,
} from './production/renderQueueWork.js';

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useRenderQueueStore() {
  const [jobs, setJobs] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const jobsRef = useRef(jobs);
  const mutateJobs = useCallback((transform) => {
    jobsRef.current = transform(jobsRef.current);
    setJobs(jobsRef.current);
  }, []);

  const addJob = useCallback((descriptor) => {
    const job = newRenderJob({ ...descriptor, id: genId(), createdAt: Date.now() });
    mutateJobs(prev => [...prev, job]);
    setPanelOpen(true);
    return job.id;
  }, [mutateJobs]);

  const updateJob = useCallback((id, fields) => {
    if (isTerminalStatus(fields.status)) releaseProjectMediaJob(jobsRef.current.find(j => j.id === id));
    mutateJobs(prev => prev.map(j => j.id === id ? { ...j, ...fields } : j));
  }, [mutateJobs]);

  const appendLog = useCallback((id, line) => {
    mutateJobs(prev => prev.map(j => j.id === id ? { ...j, logs: [...j.logs, line] } : j));
  }, [mutateJobs]);

  const removeJob = useCallback((id) => {
    mutateJobs(prev => prev.filter(j => j.id !== id));
  }, [mutateJobs]);

  const cancelJob = useCallback((id) => {
    const job = jobsRef.current.find(j => j.id === id);
    if (job?.status === JOB_STATUS.PENDING) releaseProjectMediaJob(job);
    mutateJobs(prev => prev.map(j => {
      if (j.id !== id) return j;
      // Un travail en attente n'a jamais rien lancé : il passe directement à
      // « annulé », sans rien demander au moteur. C'est vrai des deux natures,
      // et c'est ce qui remplace la garde « annulation pendant la préparation »
      // que la session d'export tenait à part.
      if (j.status === JOB_STATUS.PENDING) {
        return {
          ...j,
          status: JOB_STATUS.CANCELED,
          cancelRequested: false,
          errorMessage: null,
        };
      }
      if (j.status === JOB_STATUS.RUNNING) {
        return {
          ...j,
          cancelRequested: true,
        };
      }
      return j;
    }));
  }, [mutateJobs]);

  const clearDone = useCallback(() => {
    mutateJobs(prev => prev.filter(j => !isTerminalStatus(j.status)));
  }, [mutateJobs]);

  const activeCount = jobs.filter(j => isActiveStatus(j.status)).length;
  const hasResults = jobs.some(j => j.status === JOB_STATUS.DONE);
  const runningJob = jobs.find(j => j.status === JOB_STATUS.RUNNING) ?? null;
  // La suspension de l'édition d'un projet graphe est dérivée de la file, jamais
  // tenue à côté : c'est ce qui la fait survivre à une annulation, à une panne
  // et au démontage d'un composant.
  const advancedWorkActive = hasActiveAdvancedWork(jobs);

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
    advancedWorkActive,
    panelOpen,
    setPanelOpen,
  };
}
