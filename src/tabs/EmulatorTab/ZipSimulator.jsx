import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../../utils/logger';
import { ZipImage } from './ZipImage';
import { LuniiShell } from './LuniiShell';
import { MIME } from './useUrlCache';
import { useAudioTimeline } from './useAudioTimeline';
import { useLuniiChromeControls } from './useLuniiChromeControls';
import { toPackAssetName } from '../../utils/zipAssetName';

export function ZipSimulator({ zipPath, fromProject, onExit, onClose = null, dragHandleProps = null }) {
  const [graph, setGraph] = useState(null);   // { stageNodes: Map, actionNodes: Map, squareOneId, title }
  const [loadError, setLoadError] = useState(null);
  const [stageId, setStageId] = useState(null);
  const [entryStageId, setEntryStageId] = useState(null); // nœud de départ (après skip squareOne si fromProject)
  const [context, setContext] = useState(null); // { actionNodeId, optionIdx }
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const playSeqRef = useRef(0); // guard contre les charges audio tardives
  const [paused, setPaused] = useState(false);
  const { timeline, seekTo } = useAudioTimeline(audioRef);
  const chromeControls = useLuniiChromeControls();
  const { autoPlaybackEnabled } = chromeControls;

  // ── Chargement story.json ──
  useEffect(() => {
    if (!zipPath) return;
    let cancelled = false;
    setLoadError(null);
    setGraph(null);
    setStageId(null);
    setEntryStageId(null);
    setContext(null);
    invoke('load_pack_zip', { zipPath })
      .then(json => {
        if (cancelled) return;
        const story = typeof json === 'string' ? JSON.parse(json) : json;
        const nodes = story.stageNodes || [];
        const stageNodes = new Map(nodes.map(n => [n.uuid || n.id, n]));
        const actionNodes = new Map((story.actionNodes || []).map(n => [n.id, n]));
        const squareOne = nodes.find(n => n.squareOne === true);
        if (!squareOne) throw new Error('Nœud de départ (squareOne) introuvable');
        const squareOneId = squareOne.uuid || squareOne.id;

        // En simulation directe (fromProject=false) : démarrer sur le squareOne.
        // Depuis le ProjectSimulator (fromProject=true) : sauter le squareOne et
        // l'éventuel nœud autoplay intermédiaire pour arriver sur la liste d'histoires.
        let initialStageId = squareOneId;
        let initialContext = null;

        if (fromProject) {
          // D'abord, sauter le squareOne via okTransition.
          const ok = squareOne.okTransition;
          if (ok) {
            const an = actionNodes.get(ok.actionNode);
            if (an?.options?.length) {
              const idx = ok.optionIndex >= 0 ? Math.min(ok.optionIndex, an.options.length - 1) : 0;
              initialStageId = an.options[idx];
              initialContext = { actionNodeId: ok.actionNode, optionIdx: idx };
            }
          }

          // Puis, sauter un éventuel nœud autoplay intermédiaire (ex : night-mode).
          {
            const stage = stageNodes.get(initialStageId);
            if (stage?.controlSettings?.autoplay && stage.okTransition) {
              const ok2 = stage.okTransition;
              const an = actionNodes.get(ok2.actionNode);
              if (an?.options?.length) {
                const idx = ok2.optionIndex >= 0 ? Math.min(ok2.optionIndex, an.options.length - 1) : 0;
                const nextStage = stageNodes.get(an.options[idx]);
                if (nextStage && !nextStage.controlSettings?.autoplay) {
                  initialStageId = an.options[idx];
                  initialContext = { actionNodeId: ok2.actionNode, optionIdx: idx };
                }
              }
            }
          }
        }

        setGraph({ stageNodes, actionNodes, squareOneId, title: story.title || '' });
        setStageId(initialStageId);
        setEntryStageId(initialStageId);
        setContext(initialContext);
      })
      .catch(e => { if (!cancelled) setLoadError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  // reason: re-charger uniquement quand le ZIP change ; les setters useState sont stables.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zipPath]);

  const currentStage = graph?.stageNodes.get(stageId);

  // ── Audio ──
  const playZipAudio = useCallback(async (assetHash) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPaused(false);
    if (!assetHash || !zipPath) return;
    const seq = ++playSeqRef.current; // numéro de séquence pour détecter les charges tardives
    try {
      const assetName = toPackAssetName(assetHash);
      const bytes = await invoke('get_pack_asset', { zipPath, assetName });
      // Ignorer si démontage ou si une autre lecture a démarré entre-temps
      if (!mountedRef.current || seq !== playSeqRef.current) return;
      const ext = assetHash.split('.').pop().toLowerCase();
      const blob = new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(e => logger.error('zip-simulator:audio-play-error', e));
      audioRef.current = audio;
    } catch (e) { logger.error('zip-simulator:play-audio-error', assetHash, e); }
  }, [zipPath]);

  // reason: recharger l'audio uniquement au changement de stage ; currentStage et playZipAudio
  // derivent de stageId/graph et restent stables tant que le stage ne bouge pas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (currentStage?.audio) playZipAudio(currentStage.audio);
    else if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }, [stageId]);

  // Auto-avance sur les nœuds autoplay (comportement Lunii réel) :
  // affiche le nœud + joue l'audio, puis avance automatiquement à la fin de l'audio.
  useEffect(() => {
    if (!graph || !currentStage) return;
    if (!currentStage.controlSettings?.autoplay || !autoPlaybackEnabled) return;
    const t = currentStage.okTransition;
    if (!t) return;

    function advance() {
      if (!mountedRef.current) return;
      const an = graph.actionNodes.get(t.actionNode);
      if (!an?.options?.length) return;
      const idx = t.optionIndex >= 0 ? Math.min(t.optionIndex, an.options.length - 1) : 0;
      setStageId(an.options[idx]);
      setContext({ actionNodeId: t.actionNode, optionIdx: idx });
    }

    // Pas d'audio sur ce nœud → avancer après 300ms
    if (!currentStage.audio) {
      const timer = setTimeout(advance, 300);
      return () => clearTimeout(timer);
    }

    // Ce nœud a un audio — playZipAudio est async (invoke Rust).
    // On poll toutes les 100ms jusqu'à ce que audioRef.current soit défini,
    // puis on attache l'écouteur 'ended'. Jamais d'avance prématurée.
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
      if (audioRef.current) audioRef.current.removeEventListener('ended', advance);
    };
  // reason: re-evaluer l'autoplay sur changement de stage/graph/setting uniquement.
  // currentStage est derive de stageId+graph, audioRef est stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, graph, autoPlaybackEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, []);

  function handlePause() {
    if (!audioRef.current) return;
    if (paused) { audioRef.current.play().catch(() => {}); setPaused(false); }
    else { audioRef.current.pause(); setPaused(true); }
  }

  // ── Navigation ──
  function followTransition(t) {
    if (!t || !graph) return;
    const an = graph.actionNodes.get(t.actionNode);
    if (!an?.options?.length) return;
    const idx = t.optionIndex >= 0 ? Math.min(t.optionIndex, an.options.length - 1) : 0;
    setStageId(an.options[idx]);
    setContext({ actionNodeId: t.actionNode, optionIdx: idx });
  }

  function handleOk() { followTransition(currentStage?.okTransition); }

  function handleHome() {
    if (!graph) return;
    // fromProject : au nœud d'entrée ou au squareOne → remonter vers ProjectSimulator
    if (fromProject && (stageId === entryStageId || stageId === graph.squareOneId)) {
      onExit?.();
      return;
    }
    if (currentStage?.homeTransition) {
      followTransition(currentStage.homeTransition);
    } else {
      setStageId(graph.squareOneId);
      setContext(null);
    }
  }

  function handleWheel(dir) {
    if (!context || !graph) return;
    const an = graph.actionNodes.get(context.actionNodeId);
    if (!an?.options?.length) return;
    const newIdx = Math.max(0, Math.min(an.options.length - 1, context.optionIdx + dir));
    if (newIdx === context.optionIdx) return;
    setStageId(an.options[newIdx]);
    setContext({ ...context, optionIdx: newIdx });
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

  const cs = currentStage?.controlSettings ?? {};
  const isAtEntry = fromProject && (stageId === entryStageId || stageId === graph.squareOneId);
  const imageAsset = toPackAssetName(currentStage?.image);

  const siblings = context
    ? (graph.actionNodes.get(context.actionNodeId)?.options ?? [])
    : [];

  const stageName = currentStage?.name || '';
  const displayTitle = currentStage?.squareOne
    ? (graph.title || stageName || '—')
    : (stageName || graph.title || '—');

  const posLabel = siblings.length > 1
    ? `${context.optionIdx + 1} / ${siblings.length}`
    : (currentStage?.squareOne ? graph.title ? 'Couverture' : '' : '▶');

  return (
    <LuniiShell
      image={imageAsset
        ? <ZipImage zipPath={zipPath} assetName={imageAsset} />
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
      okDisabled={!cs.ok}
      homeDisabled={isAtEntry ? false : !cs.home}
      chromeControls={chromeControls}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      playbackControls={{
        visible: !!currentStage && timeline.hasAudio,
        currentTime: timeline.currentTime,
        duration: timeline.duration,
        onSeek: seekTo,
      }}
    />
  );
}
