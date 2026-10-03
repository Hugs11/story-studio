// Le simulateur de graphe à plat — Écrans, Actions, options, boucles.
//
// Il s'appelait `ZipSimulator` tant qu'il n'avait qu'une provenance. Il en a
// deux : une archive produite, et le document en cours d'écriture.
// **Une seconde source, pas une seconde implémentation** — tout ce qui suit est
// écrit une fois et vaut pour les deux. Le graphe lui arrive déjà assemblé par
// `flatGraph.js`, dans la même forme des deux côtés ; ce composant ne sait pas
// d'où il vient et n'a pas à le savoir.
//
// Le tirage d'une option aléatoire est consulté **à chaque entrée** dans une
// Action, jamais figé à l'ouverture. La source d'aléa est
// injectée ici pour rester remplaçable.

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../../utils/logger';
import { FlatImage } from './FlatImage';
import { LuniiShell } from './LuniiShell';
import { useAudioTimeline } from './useAudioTimeline';
import { useLuniiChromeControls } from './useLuniiChromeControls';
import { disposeAudioPlayerRef } from '../../utils/audioPlayer';
import { createMediaRequestLifecycle } from './mediaRequestLifecycle';
import { getCircularSelectionIndex } from './navigationResolvers';
import { mediaRequestKey, packFlatGraph, resolveInitialStage } from './flatGraph.js';
import { createFlatAudio, loadFlatMedia } from './flatMedia.js';
import { createOptionDrawSource, resolveTransitionEntry } from '../../store/optionSelection.js';

export function FlatSimulator({
  source,
  onExit,
  // Suivre la lecture dans l'éditeur : l'Écran qui joue est désigné à l'hôte,
  // qui le sélectionne et le recentre. Ce n'est pas une fonction de l'arbre —
  // c'est « suivre la lecture », et ça vaut pour n'importe quel éditeur.
  // L'hôte ne le branche que lorsqu'il regarde le même document : les Écrans
  // d'une archive relue n'existent pas dans l'éditeur ouvert, et il n'y aurait
  // rien à désigner.
  onActiveNodeChange = null,
  onClose = null,
  dragHandleProps = null,
}) {
  const [graph, setGraph] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [stageId, setStageId] = useState(null);
  const [entryStageId, setEntryStageId] = useState(null); // Écran de départ effectif
  const [context, setContext] = useState(null); // { actionNodeId, optionIdx }
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const optionDrawRef = useRef(null);
  if (!optionDrawRef.current) optionDrawRef.current = createOptionDrawSource();
  const [paused, setPaused] = useState(false);
  // L'Écran dont l'audio n'a rien donné à entendre : fichier introuvable,
  // lecture impossible. Il se joue en silence, et l'avance automatique le
  // traite comme un Écran sans audio au lieu d'attendre une fin qui ne viendra
  // jamais.
  const [silentStageId, setSilentStageId] = useState(null);
  const { timeline, seekTo } = useAudioTimeline(audioRef);
  const chromeControls = useLuniiChromeControls();
  const { autoPlaybackEnabled } = chromeControls;
  const audioLifecycleRef = useRef(null);
  if (!audioLifecycleRef.current) {
    audioLifecycleRef.current = createMediaRequestLifecycle({
      clearCurrent() {
        disposeAudioPlayerRef(audioRef);
      },
      load(request) {
        return loadFlatMedia(request);
      },
      createResource(loaded) {
        return createFlatAudio(loaded);
      },
      applyResource(audio) {
        // Un fichier que le disque ne rend plus donne `null` : l'Écran se joue
        // en silence plutôt que d'interrompre l'écoute.
        if (!audio) return;
        audioRef.current = audio;
        audio.play().catch(e => logger.error('flat-simulator:audio-play-error', e));
      },
      discardResource(audio) {
        audio?.destroy();
      },
      onError(error, request) {
        logger.error('flat-simulator:play-audio-error', request?.assetRef, error);
      },
    });
  }

  // `fromProject` : l'archive a-t-elle été atteinte en naviguant dans le
  // simulateur Libre ? Si oui, la couverture est sautée et Home y revient.
  const zipPath = source?.kind === 'pack' ? source.zipPath : null;
  const documentGraph = source?.kind === 'document' ? source.graph : null;
  const fromProject = source?.fromProject === true;
  const startId = source?.startId ?? null;

  // ── Installation du graphe ──
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setGraph(null);
    setStageId(null);
    setEntryStageId(null);
    setContext(null);

    function install(built) {
      const initial = resolveInitialStage(built, {
        startId,
        skipEntry: fromProject,
        drawSource: optionDrawRef.current,
      });
      setGraph(built);
      setStageId(initial.stageId);
      setEntryStageId(initial.stageId);
      setContext(initial.context);
    }

    // Le document en cours est déjà assemblé, et il est **figé** à l'ouverture :
    // l'auteur écoute l'état qu'il a lancé, pas un graphe qui se remplace sous
    // ses pieds à chaque frappe.
    if (documentGraph) {
      install(documentGraph);
      return undefined;
    }
    if (!zipPath) return undefined;

    invoke('load_pack_zip', { zipPath, forSimulation: true })
      .then(json => {
        if (cancelled) return;
        const story = typeof json === 'string' ? JSON.parse(json) : json;
        const built = packFlatGraph(story, zipPath);
        if (!built.entryId) throw new Error('Nœud de départ (squareOne) introuvable');
        install(built);
      })
      .catch(e => { if (!cancelled) setLoadError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  // reason: réinstaller uniquement quand la source change ; les setters
  // useState sont stables.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zipPath, documentGraph, startId, fromProject]);

  const currentStage = graph?.stages.get(stageId);
  const audioKey = mediaRequestKey(currentStage?.audio);

  // On ne pousse l'Écran vers l'éditeur que lorsqu'il change **réellement**
  // (navigation), pas à chaque re-rendu : sinon l'écoute écraserait une
  // sélection que l'auteur vient de faire ailleurs. Même garde que le
  // simulateur de projet, et pour la même raison.
  const lastEmittedStageIdRef = useRef(null);
  useEffect(() => {
    if (!stageId) return;
    const emissionKey = `${stageId}|${context?.actionNodeId ?? ''}|${context?.optionIdx ?? ''}|${context?.slot ?? ''}`;
    if (emissionKey === lastEmittedStageIdRef.current) return;
    lastEmittedStageIdRef.current = emissionKey;
    onActiveNodeChange?.(stageId, context);
  }, [stageId, context, onActiveNodeChange]);

  // ── Audio ──
  useEffect(() => {
    const lifecycle = audioLifecycleRef.current;
    let current = true;
    setPaused(false);
    setSilentStageId(null);
    void lifecycle.request(currentStage?.audio ?? null).then((outcome) => {
      if (!current || !mountedRef.current) return;
      // `applied` sans lecteur : `createFlatAudio` a rendu `null` pour un
      // fichier que le disque ne rend plus.
      if (outcome === 'error' || (outcome === 'applied' && !audioRef.current)) {
        setSilentStageId(stageId);
      }
    });
    return () => {
      current = false;
      lifecycle.invalidate();
    };
  // reason: `audioKey` porte les primitives de la requête ; l'objet est
  // reconstruit à chaque assemblage de graphe et son identité ne prouve rien.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey, stageId]);

  // Auto-avance sur les Écrans autoplay (comportement Lunii réel) :
  // affiche l'Écran + joue l'audio, puis avance à la fin de l'audio.
  useEffect(() => {
    if (!graph || !currentStage) return;
    if (!currentStage.controlSettings?.autoplay || !autoPlaybackEnabled) return;
    const t = currentStage.okTransition;
    if (!t) return;

    function advance() {
      if (!mountedRef.current) return;
      // Nouvelle entrée dans l'Action : une sélection aléatoire retire un
      // index, elle n'est pas figée une fois pour le pack.
      const entry = resolveTransitionEntry(
        t,
        graph.actions.get(t.actionNode),
        optionDrawRef.current,
      );
      if (!entry) return;
      setStageId(entry.target);
      setContext({ actionNodeId: t.actionNode, optionIdx: entry.index, slot: 'ok' });
    }

    // Pas d'audio sur cet Écran, ou un audio qui ne se jouera pas → avancer
    // après 300ms
    if (!currentStage.audio || silentStageId === stageId) {
      const timer = setTimeout(advance, 300);
      return () => clearTimeout(timer);
    }

    // Cet Écran a un audio, et son chargement est asynchrone. On sonde toutes
    // les 100ms jusqu'à ce que `audioRef.current` soit défini, puis on attache
    // l'écouteur 'ended'. Jamais d'avance prématurée.
    let pollTimer;
    let waited = 0;
    const maxWait = 15000; // 15s max (sécurité si l'audio ne charge jamais)

    function tryAttach() {
      if (!mountedRef.current) return;
      const audio = audioRef.current;
      if (audio) {
        if (audio.ended) {
          advance();
        } else {
          audio.addEventListener('ended', advance, { once: true });
          // Un décodage qui échoue n'émet jamais `ended`.
          audio.addEventListener('error', advance, { once: true });
        }
        return;
      }
      waited += 100;
      if (waited < maxWait) {
        pollTimer = setTimeout(tryAttach, 100);
      }
    }

    pollTimer = setTimeout(tryAttach, 100);

    return () => {
      clearTimeout(pollTimer);
      if (audioRef.current) {
        audioRef.current.removeEventListener('ended', advance);
        audioRef.current.removeEventListener('error', advance);
      }
    };
  // reason: réévaluer l'autoplay sur changement d'Écran/graphe/réglage, ou
  // quand l'audio de l'Écran s'avère muet. currentStage est dérivé de
  // stageId+graph, audioRef est stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, graph, autoPlaybackEnabled, silentStageId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      audioLifecycleRef.current.invalidate();
    };
  }, []);

  function handlePause() {
    if (currentStage?.controlSettings?.pause !== true) return;
    if (!audioRef.current) return;
    if (paused) { audioRef.current.play().catch(() => {}); setPaused(false); }
    else { audioRef.current.pause(); setPaused(true); }
  }

  // ── Navigation ──
  function followTransition(t, slot) {
    if (!t || !graph) return;
    const entry = resolveTransitionEntry(
      t,
      graph.actions.get(t.actionNode),
      optionDrawRef.current,
    );
    if (!entry) return;
    setStageId(entry.target);
    setContext({ actionNodeId: t.actionNode, optionIdx: entry.index, slot });
  }

  function handleOk() {
    // Le centre de la molette appuie aussi sur OK : le bouton grisé ne suffit
    // pas, le geste est ignoré quand OK est désactivé sur l'Écran courant. La
    // lecture automatique suit son propre chemin et n'est pas concernée.
    if (currentStage?.controlSettings?.ok !== true) return;
    followTransition(currentStage.okTransition, 'ok');
  }

  function handleHome() {
    if (!graph) return;
    // fromProject : à l'Écran de départ → remonter vers le simulateur Libre
    if (fromProject && (stageId === entryStageId || stageId === graph.entryId)) {
      onExit?.();
      return;
    }
    if (currentStage?.homeTransition) {
      followTransition(currentStage.homeTransition, 'home');
    } else {
      // Aucune transition Home : retour au début de l'écoute. Un document sans
      // entrée désignée revient là où l'auteur l'a lancée.
      setStageId(graph.entryId ?? entryStageId);
      setContext(null);
    }
  }

  function handleWheel(dir) {
    if (!context || !graph) return;
    // Molette désactivée sur l'Écran courant : la Lunii ignore le geste, comme
    // OK et Accueil quand leur contrôle est éteint.
    if (currentStage?.controlSettings?.wheel !== true) return;
    const an = graph.actions.get(context.actionNodeId);
    if (!an?.options?.length) return;
    // Une option pendante garde sa place dans la liste — la retirer décalerait
    // les suivantes — mais la molette cherche la prochaine option résolue.
    let newIdx = context.optionIdx;
    for (let step = 0; step < an.options.length; step += 1) {
      newIdx = getCircularSelectionIndex(newIdx, dir, an.options.length);
      if (newIdx === context.optionIdx) return;
      const target = an.options[newIdx];
      if (typeof target !== 'string' || !graph.stages.has(target)) continue;
      setStageId(target);
      setContext({ ...context, optionIdx: newIdx });
      return;
    }
  }

  // ── Affichage ──
  if (loadError) return (
    <div style={{ padding: 24, color: '#E24B4A', fontSize: 13, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Erreur de chargement</div>
      <div>{loadError}</div>
      <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11 }}>{zipPath}</div>
    </div>
  );
  if (!graph) return (
    <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>
      Chargement du pack…
    </div>
  );
  if (!currentStage) return (
    <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
      {documentGraph
        ? 'Aucun Écran de départ. Choisissez l’Écran racine depuis « À corriger », ou lancez l’écoute depuis l’Écran sélectionné.'
        : 'Ce pack n’a pas d’Écran de départ.'}
    </div>
  );

  const cs = currentStage.controlSettings ?? {};
  const isAtEntry = fromProject && (stageId === entryStageId || stageId === graph.entryId);

  const siblings = context
    ? (graph.actions.get(context.actionNodeId)?.options ?? [])
    : [];

  const stageName = currentStage.name || '';
  const displayTitle = currentStage.squareOne
    ? (graph.title || stageName || '—')
    : (stageName || graph.title || '—');

  const posLabel = siblings.length > 1
    ? `${context.optionIdx + 1} / ${siblings.length}`
    : (currentStage.squareOne ? graph.title ? 'Couverture' : '' : '▶');

  return (
    <LuniiShell
      image={currentStage.image
        ? <FlatImage request={currentStage.image} />
        : <div className="lunii-story-img lunii-story-img--empty" />
      }
      title={displayTitle}
      sub={posLabel}
      onOk={handleOk}
      onHome={handleHome}
      onLeft={() => handleWheel(-1)}
      onRight={() => handleWheel(1)}
      paused={paused}
      onPause={handlePause}
      pauseDisabled={cs.pause !== true}
      okDisabled={!cs.ok}
      homeDisabled={isAtEntry ? false : !cs.home}
      chromeControls={chromeControls}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      playbackControls={{
        visible: timeline.hasAudio,
        currentTime: timeline.currentTime,
        duration: timeline.duration,
        onSeek: seekTo,
      }}
    />
  );
}
