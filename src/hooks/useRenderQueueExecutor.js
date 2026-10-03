// L'exécuteur de la file de rendu : il sert les travaux un par un, dans l'ordre.
//
// Il sert **deux natures** de travail. Un travail Libre part sur
// `generate_pack` avec son document sérialisé ; un travail graphe part sur
// `export_advanced_pack` avec la demande capturée au clic. Les deux commandes
// Rust émettent sur le même canal `generate-log`, obéissent au même drapeau
// d'annulation et occupent le même poste de travail natif. Ce n'est donc pas
// une fusion de moteurs : c'est un seul ordonnanceur pour un poste qui n'en
// avait jamais eu qu'un.
//
// Trois choses ne vivent pas ici, exprès :
//
// - **l'ordonnancement et l'interprétation des retours** sont dans
//   `store/production/renderQueueWork.js`, purs, éprouvables sans machine ;
// - **ce qu'un travail graphe est** est dans
//   `store/production/advancedRenderWork.js` — capture, ticket, refus typé ;
// - **le poste natif** est dans `store/nativeGenerationLock.js`, hors React,
//   parce qu'il est plus large qu'un composant.
//
// Les dépendances Tauri sont injectables : c'est ce qui permet d'éprouver
// l'ordre de service et l'annulation sans runtime.

import { useEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { nativeGenerationLock } from '../store/nativeGenerationLock';
import {
  JOB_STATUS,
  WORK_NATURE,
  freeJobOutcome,
  jobAwaitingCancelSignal,
  nativeOwnerOf,
  nextStartableJob,
  readsAsCancellation,
} from '../store/production/renderQueueWork';
import { ADVANCED_WORK, runAdvancedWork } from '../store/production/advancedRenderWork';
import { releaseTauriListener } from '../utils/tauriListener';

function playNotification(type) {
  try {
    const ctx = new AudioContext();
    const notes = type === 'done'
      ? [{ f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.13, d: 0.12 }, { f: 784, t: 0.26, d: 0.2 }]
      : [{ f: 400, t: 0, d: 0.15 }, { f: 280, t: 0.16, d: 0.25 }];
    notes.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = type === 'done' ? 'sine' : 'sawtooth';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.18, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + d);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

function defaultProgressSubscription(onLine) {
  let disposed = false;
  let unlisten = null;
  listen('generate-log', (event) => {
    if (event.payload == null) return;
    onLine(String(event.payload));
  }).then((fn) => {
    if (disposed) releaseTauriListener(fn);
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    disposed = true;
    releaseTauriListener(unlisten);
  };
}

export function useRenderQueueExecutor({
  jobs,
  updateJob,
  appendLog,
  lock = nativeGenerationLock,
  // Le témoin du document ouvert, relu au retour d'un travail graphe. Sans
  // projet avancé ouvert, il n'y a rien à comparer : l'archive existe, elle
  // n'appartient simplement plus au document courant.
  readAdvancedTicket = () => ({ projectEpoch: null, document: null }),
  isRuntime = isTauriRuntime,
  invoke = tauriInvoke,
  subscribeProgress = defaultProgressSubscription,
  notify = playNotification,
} = {}) {
  const executingRef = useRef(false);
  const runningJobIdRef = useRef(null);
  const cancelSentForRef = useRef(null);
  const [lockTick, setLockTick] = useState(0);

  // Réveil à la libération : sans cet abonnement, un travail mis en attente
  // parce que le poste était tenu attendrait le prochain rendu fortuit.
  useEffect(() => lock.subscribe((holder) => {
    if (holder === null) setLockTick((tick) => tick + 1);
  }), [lock]);

  useEffect(() => {
    runningJobIdRef.current = jobs.find(j => j.status === JOB_STATUS.RUNNING)?.id ?? null;
  }, [jobs]);

  // La progression des **deux** natures arrive sur le même canal, et elle est
  // routée vers le travail en cours — il n'y en a qu'un. C'est ce qui remplace
  // l'abonnement que la session d'export tenait pour elle seule : deux
  // abonnements auraient écrit deux fois la même ligne.
  useEffect(() => {
    if (!isRuntime()) return undefined;
    return subscribeProgress((line) => {
      const runningJobId = runningJobIdRef.current;
      if (!runningJobId) return;
      appendLog(runningJobId, line);
    });
  }, [appendLog, isRuntime, subscribeProgress]);

  useEffect(() => {
    if (!isRuntime()) return;

    // Seul un travail **en cours** a quelque chose à arrêter. Un travail en
    // attente est déjà passé à « annulé » par la file, sans rien demander.
    const target = jobAwaitingCancelSignal(jobs, cancelSentForRef.current);
    if (!target) return;
    cancelSentForRef.current = target.id;
    appendLog(target.id, '⏹ Demande d’annulation envoyée…');
    // Le même geste pour les deux natures : côté Rust, `cancel_generate_pack`
    // bascule le drapeau que `generate_pack` **et** `export_advanced_pack`
    // relisent. Ce n'est pas une déduction de commentaire — les deux commandes
    // lisent `GenerationCancelState`.
    invoke('cancel_generate_pack').catch((err) => {
      appendLog(target.id, `⚠️ Impossible de demander l’annulation : ${String(err)}`);
      cancelSentForRef.current = null;
    });
  }, [jobs, appendLog, isRuntime, invoke]);

  useEffect(() => {
    if (!isRuntime()) return;

    // Un travail est déjà en cours d'exécution dans cette instance.
    if (executingRef.current) return;

    const nextJob = nextStartableJob(jobs);
    if (!nextJob) return;

    // Le poste natif est-il libre ? S'il est tenu, ce travail reste en attente :
    // le démarrer mêlerait sa progression à celle de l'autre et lui ferait
    // partager son annulation.
    const held = lock.acquire({ owner: nativeOwnerOf(nextJob.nature), label: nextJob.projectName });
    if (!held) return;

    executingRef.current = true;
    runningJobIdRef.current = nextJob.id;
    updateJob(nextJob.id, { status: JOB_STATUS.RUNNING });
    appendLog(nextJob.id, `▶ Démarrage de la fabrication : ${nextJob.projectName}`);
    appendLog(nextJob.id, `  Dossier de sortie : ${nextJob.outputFolder}`);

    (async () => {
      try {
        if (nextJob.nature === WORK_NATURE.ADVANCED) {
          await serveAdvanced(nextJob);
        } else {
          await serveFree(nextJob);
        }
      } finally {
        cancelSentForRef.current = null;
        executingRef.current = false;
        held.release();
      }
    })();

    function markCancelled(jobId) {
      updateJob(jobId, { status: JOB_STATUS.CANCELED, cancelRequested: false, resultPath: null, errorMessage: null });
      appendLog(jobId, '⏹ Fabrication annulée.');
    }

    async function serveFree(job) {
      try {
        const outcome = freeJobOutcome(await invoke('generate_pack', {
          projectJson: job.projectJson,
          outputFolder: job.outputFolder,
        }));
        // Comme pour le graphe : une annulation revenue trop tard ne déclasse
        // pas une archive publiée, le moteur a rendu son chemin.
        updateJob(job.id, { status: JOB_STATUS.DONE, cancelRequested: false, ...outcome });
        notify('done');
      } catch (err) {
        // Seul le moteur dit l'abandon. Une autre panne arrivée pendant une
        // annulation (nettoyage du `.partial` impossible…) reste une panne.
        const message = String(err);
        if (readsAsCancellation(message)) markCancelled(job.id);
        else {
          updateJob(job.id, { status: JOB_STATUS.ERROR, cancelRequested: false, errorMessage: message });
          notify('error');
        }
      }
    }

    async function serveAdvanced(job) {
      const outcome = await runAdvancedWork({
        job,
        invokeExport: (request) => invoke('export_advanced_pack', request),
        readTicket: readAdvancedTicket,
        lock,
      });
      if (outcome.outcome === ADVANCED_WORK.SUCCEEDED) {
        // Une annulation revenue trop tard ne déclasse pas une archive
        // publiée : le moteur a rendu son chemin, le fichier existe.
        updateJob(job.id, {
          status: JOB_STATUS.DONE,
          cancelRequested: false,
          resultPath: outcome.result.zipPath ?? null,
          result: outcome.result,
          ownership: outcome.ownership,
          refusal: null,
        });
        notify('done');
        return;
      }
      // Le refus porte lui-même son annulation : `export-cancelled` est la
      // réponse du moteur à un abandon, et la ranger dans les erreurs ferait
      // lire une panne là où il n'y en a pas.
      const refusal = outcome.refusal;
      if (refusal?.cancelled === true) {
        updateJob(job.id, {
          status: JOB_STATUS.CANCELED,
          cancelRequested: false,
          refusal,
          errorMessage: null,
        });
        appendLog(job.id, '⏹ Fabrication annulée.');
        return;
      }
      updateJob(job.id, {
        status: JOB_STATUS.ERROR,
        cancelRequested: false,
        refusal,
        errorMessage: refusal?.message ?? null,
      });
      notify('error');
    }
  }, [jobs, updateJob, appendLog, lock, lockTick, isRuntime, invoke, readAdvancedTicket, notify]);
}
