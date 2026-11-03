import { useMessageLanguage } from '../i18n/useMessageLanguage.js';
import { aiRef } from '../i18n/aiPresentation.js';
import { useEffect, useRef, useState } from 'react';
import { remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

import { useProjectContext } from '../store/ProjectContext';
import { exampleMediaPlan, exampleVoicePlan, generateExampleMedia } from '../store/advancedExamples/media.js';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { createExampleHistory } from '../store/advancedExamples/exampleHistory.js';
import { generateTextImage } from '../components/TextImageGenerator/generateTextImage';
import { generateUuid } from '../utils/uuid.js';

// Le projet reçoit d'abord le motif atomique, puis uniquement les médias
// prévus. Les TTS restent dans la file commune et s'appliquent par UUID/époque.
//
// Historique : les médias se fondent dans l'étape d'insertion tant que
// l'auteur n'a rien fait d'autre ; sinon chacun devient une étape ordinaire
// (règle détaillée dans `advancedExamples/exampleHistory.js`).
//
// Arrêt : `stop` invalide la boucle des médias par la même garde que le
// changement de projet. Le graphe inséré reste en place, l'image en cours de
// fabrication est jetée, et les audios déjà confiés à la file IA y restent
// (annulables depuis cette file).
//
// Langue : l'exemple arrive déjà résolu dans la langue capturée au choix
// (`example.language`). Ses audios sont demandés dans cette langue, avec une
// voix compatible choisie pour l'exemple seulement (`exampleVoicePlan`) ;
// aucune préférence TTS générale n'est écrite. Une voix Piper absente n'est
// jamais téléchargée sans le choix explicite « Installer la voix » ; « Générer
// sans audio » reste toujours possible, y compris hors ligne.
const nativeVoices = {
  // Hors Tauri, aucun moteur ne peut télécharger : `null` = rien à installer.
  list: async () => (isTauriRuntime() ? (await invoke('piper_list_voices'))?.voices ?? [] : null),
  ensure: (voice) => invoke('piper_ensure_voice', { voice }),
};

export function useAdvancedExamples({ authoring, projectEpoch, onAssignMedia, onInserted, voices = nativeVoices }) {
  const context = useProjectContext();
  const latest = useRef(null);
  latest.current = { authoring, projectEpoch, onAssignMedia, onInserted, context, voices };
  const mounted = useRef(true);
  useMessageLanguage();
  const [state, setState] = useState(null);
  const activeRef = useRef(null);
  const historyRef = useRef(null);
  historyRef.current ??= createExampleHistory();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    activeRef.current = null;
    historyRef.current.release();
    setState(null);
  }, [projectEpoch]);

  function open(example) {
    if (activeRef.current?.busy) return;
    const draft = {
      example, language: example.language ?? 'fr', busy: false, inserted: false, stopped: false,
      result: null, error: '', progress: null, voices: undefined, voiceChoice: false, voiceError: null,
    };
    // Lecture locale de l'état d'installation des voix Piper, sans réseau.
    draft.voicesReady = Promise.resolve()
      .then(() => latest.current.voices.list())
      .then((voices) => voices, () => false)
      .then((voices) => {
        draft.voices = voices;
        if (mounted.current && activeRef.current === draft) setState({ ...draft });
      });
    activeRef.current = draft;
    setState(draft);
  }

  function close() {
    if (activeRef.current?.busy) return;
    activeRef.current = null;
    setState(null);
  }

  // Seule la phase des médias est interruptible : l'insertion du graphe est
  // un geste unique, déjà atomique.
  function stop() {
    const draft = activeRef.current;
    if (!draft?.busy || !draft.inserted || draft.stopped) return;
    Object.assign(draft, { stopped: true, busy: false, progress: null });
    setState({ ...draft });
  }

  async function confirm({ images, audios, anchor, installVoice = false }) {
    const draft = activeRef.current;
    if (!draft || draft.busy || draft.inserted) return;
    const epoch = latest.current.projectEpoch;
    const captured = latest.current.context;
    const current = () => mounted.current && latest.current.projectEpoch === epoch
      && activeRef.current === draft && !draft.stopped;
    const update = (patch) => {
      if (!current()) return;
      Object.assign(draft, patch);
      setState({ ...draft });
    };
    if (audios && draft.voices === undefined) {
      draft.busy = true;
      await draft.voicesReady;
      draft.busy = false;
      if (!current()) return;
    }
    // La voix et la langue sont figées ici : un changement de langue de
    // l'interface pendant la génération ne modifie aucune requête envoyée.
    const voicePlan = exampleVoicePlan({ settings: captured.xttsSettings, language: draft.language, voices: draft.voices });
    if (audios && voicePlan.status === 'unavailable') {
      update({ error: { key: 'examples:error.voice.required' } });
      return;
    }
    if (audios && voicePlan.status === 'missing') {
      if (!installVoice) {
        update({ voiceChoice: true, voiceError: null, error: '' });
        return;
      }
      update({ busy: true, error: '', voiceError: null, progress: { completed: 0, total: 0, label: { key: 'examples:progress.voice.installing' } } });
      try {
        await latest.current.voices.ensure(voicePlan.voice);
      } catch (error) {
        // Hors ligne ou téléchargement refusé : le choix reste proposé.
        update({ busy: false, progress: null, voiceChoice: true, voiceError: error });
        return;
      }
      if (!current()) return;
      const installed = Array.isArray(draft.voices) ? draft.voices : [];
      draft.voices = [...installed.filter((voice) => voice.id !== voicePlan.voice), {
        ...(installed.find((voice) => voice.id === voicePlan.voice) ?? { id: voicePlan.voice, language: voicePlan.voice.split('-')[0] }),
        installed: true,
      }];
    }
    const voice = voicePlan.voice;
    update({ busy: true, error: '', voiceChoice: false, voiceError: null, progress: { completed: 0, total: 0, label: { key: 'examples:progress.graph.creating' } } });
    try {
      let committed = null;
      const outcome = await latest.current.authoring.runExample(draft.example, {
        anchor, onCommitted: (commit) => { committed = commit; },
      });
      if (!current()) return;
      if (outcome.status !== 'applied') {
        update({ error: outcome.error || { key: 'examples:error.insertion.notApplied' } });
        return;
      }
      const report = outcome.report.example;
      const exampleHistory = historyRef.current;
      // Sans repère de commit, aucun média ne sera fondu : étapes ordinaires.
      const history = committed ? exampleHistory.historyFor(exampleHistory.claim(committed)) : true;
      update({ inserted: true, report });
      latest.current.onInserted?.({ ...report, projectEpoch: epoch });
      const plan = exampleMediaPlan(draft.example, report.stages);
      const result = await generateExampleMedia({
        plan, images, audios, isCurrent: current,
        onProgress: (progress) => update({ progress }),
        generateImage: (text) => generateTextImage(text, captured.workspaceDir, {
          filename: `exemple-${generateUuid()}.png`,
          mediaStorage: captured.mediaStorage,
        }),
        discardImage: (path) => remove(path),
        assignImage: async (uuid, path) => {
          if (!current()) return null;
          const assigned = await latest.current.onAssignMedia(uuid, 'image', path, { projectEpoch: epoch, history });
          // Une image affectée juste avant l'arrêt reste dans le document : elle
          // est donc déclarée, tant que le projet est encore celui de l'exemple.
          if (assigned?.status === 'applied' && latest.current.projectEpoch === epoch) {
            // L'image est déjà référencée : un échec de la déclaration ne doit
            // pas la faire passer pour non affectée, donc supprimée.
            try {
              captured.onMediaCreated?.(path);
            } catch {
              // Déclaration accessoire : l'image reste affectée dans le document.
            }
          }
          return assigned;
        },
        queueAudio: ({ stageUuid, text }) => captured.onQueueXttsGenerate({
          target: {
            kind: 'advancedStage', projectEpoch: epoch,
            apply: (path) => latest.current.projectEpoch === epoch
              ? latest.current.onAssignMedia(stageUuid, 'audio', path, { projectEpoch: epoch, history })
              : null,
          },
          targetLabelRef: aiRef('ai:queue.example.target', { name: text }), voiceLabel: voice,
          request: {
            text, language: voicePlan.language,
            speaker: null, voice, savePath: captured.savePath,
            filenameHint: `exemple-${stageUuid}`,
          },
        }),
      });
      if (!current() || result.stale) return;
      update({ result, progress: null });
    } catch (error) {
      update({ error });
    } finally {
      update({ busy: false });
    }
  }

  // L'erreur reste une valeur (descripteur ou cause IPC) : le dialogue la
  // présente dans la langue courante, détail technique replié. Le plan de voix
  // est relu à chaque rendu tant que rien n'est envoyé.
  return {
    state: state ? {
      ...state,
      voice: exampleVoicePlan({ settings: context.xttsSettings, language: state.language, voices: state.voices }),
    } : null,
    open, close, stop, confirm,
  };
}
