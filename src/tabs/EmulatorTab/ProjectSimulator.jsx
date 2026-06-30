import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { decodeNavigationStoryId, isStoryNavigationTarget, isStoryPlayNavigationTarget, refTargetEntryId } from '../../store/navigationTargets';
import { getEffectiveEndBehavior, getGeneratedStoryNavigation } from '../../store/generatedNavigation';
import { getGeneratedMenuControls } from '../../store/generatedPlayback';
import { getExportPackName } from '../../utils/packConvention';
import { LocalImage } from './LocalImage';
import { ZipImage } from './ZipImage';
import { LuniiShell } from './LuniiShell';
import { getLocalUrl, MIME } from './useUrlCache';
import { useAudioTimeline } from './useAudioTimeline';
import { useLuniiChromeControls } from './useLuniiChromeControls';
import { findEntryLocation, getMenuBrowseState, normalizeHomeTarget, resolveSequenceTarget, resolveStoryHomeTarget, resolveStoryReturnTarget } from './navigationResolvers';
import { toPackAssetName } from '../../utils/zipAssetName';

export function ProjectSimulator({
  project,
  onOpenZip,
  initialSelectionId = null,
  onActiveNodeChange = null,
  onClose = null,
  dragHandleProps = null,
}) {
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const playSeqRef = useRef(0);
  const [state, setState] = useState('cover');
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [menuPath, setMenuPath] = useState([]);
  const [entryIdx, setEntryIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const { timeline, seekTo } = useAudioTimeline(audioRef);
  const chromeControls = useLuniiChromeControls();
  const { autoPlaybackEnabled } = chromeControls;

  const isSimple = project.projectType === 'simple';
  const rootEntries = !isSimple ? (project.rootEntries ?? []) : [];
  let currentEntries = rootEntries;
  const currentMenus = [];
  for (const menuId of menuPath) {
    const nextMenu = currentEntries.find((entry) => entry.id === menuId && entry.type === 'menu');
    if (!nextMenu) break;
    currentMenus.push(nextMenu);
    currentEntries = nextMenu.children ?? [];
  }
  const currentMenu = currentMenus[currentMenus.length - 1] ?? null;
  const currentEntry = currentEntries[entryIdx] || currentEntries[0] || null;
  const simpleStory = project.rootEntries?.find((entry) => entry.type === 'story') ?? null;
  const activeStory = isSimple ? simpleStory : currentEntry;
  const activeSequence = activeStory?.type === 'story' ? (activeStory.afterPlaybackSequence ?? []) : [];
  const activeSequenceStep = state === 'sequence' ? activeSequence[sequenceIndex] : null;

  // rootEntries change a chaque edition du projet (frappe dans un champ). On ne
  // doit re-synchroniser le simulateur sur son ancre que lorsque l'ancre change,
  // pas a chaque edition -- sinon la frappe replace le simulateur sur l'ancre,
  // qui repousse ensuite la selection de l'arbre via onActiveNodeChange.
  const rootEntriesRef = useRef(rootEntries);
  rootEntriesRef.current = rootEntries;

  useEffect(() => {
    if (isSimple) return;
    if (!initialSelectionId || initialSelectionId === 'root') {
      setState('cover');
      setMenuPath([]);
      setEntryIdx(0);
      return;
    }

    const location = findEntryLocation(rootEntriesRef.current, initialSelectionId);
    if (!location) return;

    setState(location.entry?.type === 'story' ? 'playing' : 'browse');
    setMenuPath(location.menuPath);
    setEntryIdx(location.entryIdx);
  }, [initialSelectionId, isSimple]);

  useEffect(() => {
    if (!isSimple && currentEntries.length > 0 && entryIdx >= currentEntries.length) {
      setEntryIdx(0);
    }
  }, [currentEntries, entryIdx, isSimple]);

  const navigateToTarget = useCallback((target) => {
    if (isStoryNavigationTarget(target)) {
      const storyId = decodeNavigationStoryId(target);
      const loc = findEntryLocation(rootEntries, storyId);
      if (loc) {
        setMenuPath(loc.menuPath);
        setEntryIdx(loc.entryIdx);
        setState(isStoryPlayNavigationTarget(target) ? 'playing' : 'browse');
        return true;
      }
      return false;
    }
    const targetState = getMenuBrowseState(rootEntries, target);
    if (targetState) {
      setMenuPath(targetState.menuPath);
      setEntryIdx(targetState.entryIdx);
      setState(targetState.state ?? 'browse');
      return true;
    }
    return false;
  }, [rootEntries]);

  const navigateToNextStory = useCallback(() => {
    const nextIdx = currentEntries.slice(entryIdx + 1).findIndex((e) => e.type === 'story');
    if (nextIdx >= 0) {
      setEntryIdx(entryIdx + 1 + nextIdx);
      setState('playing');
      return true;
    }
    return false;
  }, [currentEntries, entryIdx]);

  const navigateAfterStory = useCallback(() => {
    const story = isSimple ? simpleStory : currentEntry;
    if (story?.type !== 'story') {
      setState('browse');
      return;
    }

    const navigation = getGeneratedStoryNavigation(story, currentMenu, project, rootEntries);
    const target = state === 'endnode'
      ? (navigation.endNodeReturn.effectiveTargetId ?? navigation.directReturn.targetId)
      : navigation.directReturn.targetId;
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
      setMenuPath(menuPath);
      setEntryIdx(entryIdx);
      setState('browse');
      return;
    }
    if (target && navigateToTarget(target)) return;

    setMenuPath(menuPath);
    setEntryIdx(entryIdx);
    setState('browse');
  }, [currentEntry, currentMenu, entryIdx, isSimple, menuPath, navigateToNextStory, navigateToTarget, project, rootEntries, simpleStory, state]);

  const navigateHomeFromStory = useCallback(() => {
    if (isSimple || currentEntry?.type !== 'story') {
      setState('browse');
      return;
    }

    const target = resolveStoryHomeTarget(currentEntry, currentMenu, project);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
      setMenuPath(menuPath);
      setEntryIdx(entryIdx);
      setState('browse');
      return;
    }
    if (target && navigateToTarget(target)) return;

    setMenuPath(menuPath);
    setEntryIdx(entryIdx);
    setState('browse');
  }, [currentEntry, currentMenu, entryIdx, isSimple, menuPath, navigateToNextStory, navigateToTarget, project]);

  const navigateSequenceOk = useCallback(() => {
    const step = activeSequence[sequenceIndex];
    const target = resolveSequenceTarget(step?.okTarget, currentMenu) ?? resolveStoryReturnTarget(activeStory, currentMenu, project);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateAfterStory();
  }, [activeSequence, activeStory, currentMenu, navigateAfterStory, navigateToNextStory, navigateToTarget, sequenceIndex]);

  const navigateSequenceHome = useCallback(() => {
    const step = activeSequence[sequenceIndex];
    if (step?.homeNone) return;
    if (step?.homeFollowsOk && sequenceIndex + 1 < activeSequence.length) {
      setSequenceIndex((index) => index + 1);
      return;
    }
    const target = step?.homeFollowsOk
      ? (resolveSequenceTarget(step?.okTarget, currentMenu) ?? resolveStoryReturnTarget(activeStory, currentMenu, project))
      : (normalizeHomeTarget(resolveSequenceTarget(step?.homeTarget, currentMenu)) ?? resolveStoryHomeTarget(activeStory, currentMenu, project));
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateHomeFromStory();
  }, [activeSequence, activeStory, currentMenu, navigateHomeFromStory, navigateToNextStory, navigateToTarget, project, sequenceIndex]);

  const navigatePromptOk = useCallback(() => {
    const target = resolveSequenceTarget(activeStory?.afterPlaybackPromptOkTarget, currentMenu)
      ?? resolveStoryReturnTarget(activeStory, currentMenu, project);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateAfterStory();
  }, [activeStory, currentMenu, navigateAfterStory, navigateToNextStory, navigateToTarget, project]);

  const navigatePromptHome = useCallback(() => {
    if (activeStory?.afterPlaybackPromptHomeNone) return;
    const target = normalizeHomeTarget(resolveSequenceTarget(activeStory?.afterPlaybackPromptHomeTarget, currentMenu))
      ?? resolveSequenceTarget(activeStory?.afterPlaybackPromptOkTarget, currentMenu)
      ?? resolveStoryHomeTarget(activeStory, currentMenu, project);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateHomeFromStory();
  }, [activeStory, currentMenu, navigateHomeFromStory, navigateToNextStory, navigateToTarget, project]);

  const advanceSequence = useCallback(() => {
    if (sequenceIndex + 1 < activeSequence.length) {
      setSequenceIndex((index) => index + 1);
      return;
    }
    navigateSequenceOk();
  }, [activeSequence.length, navigateSequenceOk, sequenceIndex]);

  const startAfterPlaybackSequence = useCallback(() => {
    if (project?.globalOptions?.autoNext) return false;
    const sequence = isSimple
      ? (simpleStory?.afterPlaybackSequence ?? [])
      : (currentEntry?.afterPlaybackSequence ?? []);
    if (sequence.length > 0) {
      setSequenceIndex(0);
      setState('sequence');
      return true;
    }
    return false;
  }, [currentEntry, isSimple, project?.globalOptions?.autoNext, simpleStory]);

  const startAfterPlaybackPrompt = useCallback(() => {
    if (project?.globalOptions?.autoNext) return false;
    const sequence = isSimple
      ? (simpleStory?.afterPlaybackSequence ?? [])
      : (currentEntry?.afterPlaybackSequence ?? []);
    if (sequence.length > 0) return false;
    const promptAudio = isSimple
      ? simpleStory?.afterPlaybackPromptAudio
      : currentEntry?.afterPlaybackPromptAudio;
    if (promptAudio) {
      setState('postplay');
      return true;
    }
    return false;
  }, [currentEntry, isSimple, project?.globalOptions?.autoNext, simpleStory]);

  const startEndNode = useCallback(() => {
    if (project?.globalOptions?.autoNext) return false;
    if (!project.nightModeAudio) return false;
    const story = isSimple ? simpleStory : currentEntry;
    const navigation = story?.type === 'story'
      ? getGeneratedStoryNavigation(story, currentMenu, project, rootEntries)
      : null;
    if (!navigation?.usesEndNode) return false;
    setState('endnode');
    return true;
  }, [currentEntry, currentMenu, isSimple, project, rootEntries, simpleStory]);

  const playAudio = useCallback(async (path) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPaused(false);
    const seq = ++playSeqRef.current;
    const url = await getLocalUrl(path);
    if (!mountedRef.current || seq !== playSeqRef.current) return;
    if (url) {
      const audio = new Audio(url);
      audio.play().catch(() => {});
      audioRef.current = audio;
    }
  }, []);

  const playZipItemAudio = useCallback(async (zipPath, assetHash) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPaused(false);
    if (!zipPath || !assetHash) return;
    try {
      const assetName = toPackAssetName(assetHash);
      const bytes = await invoke('get_pack_asset', { zipPath, assetName });
      // Si le composant a été démonté pendant l'await, ne pas créer l'Audio
      if (!mountedRef.current) return;
      const ext = assetHash.split('.').pop().toLowerCase();
      const blob = new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'audio/mpeg' });
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play().catch(() => {});
      audioRef.current = audio;
    } catch {}
  }, []);

  function handlePause() {
    if (!audioRef.current) return;
    if (paused) { audioRef.current.play().catch(() => {}); setPaused(false); }
    else { audioRef.current.pause(); setPaused(true); }
  }

  useEffect(() => {
    // Remettre mountedRef à true au montage pour survivre au cycle StrictMode
    // (StrictMode fait mount→cleanup→mount ; sans ce reset, current resterait false)
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (state === 'cover') playAudio(project.rootAudio);
    else if (state === 'browse') {
      if (currentEntry?.type === 'menu') playAudio(currentEntry?.audio);
      else if (currentEntry?.type === 'zip' && currentEntry?.coverAudio) playZipItemAudio(currentEntry.zipPath, currentEntry.coverAudio);
      else if (currentEntry?.type === 'story') playAudio(currentEntry?.itemAudio);
    }
    else if (state === 'playing') playAudio(isSimple ? simpleStory?.audio : currentEntry?.audio);
    else if (state === 'postplay') {
      playAudio(isSimple ? simpleStory?.afterPlaybackPromptAudio : currentEntry?.afterPlaybackPromptAudio);
    }
    else if (state === 'sequence') {
      playAudio(activeSequenceStep?.audio);
    }
    else if (state === 'endnode') playAudio(project.nightModeAudio);
  // reason: re-jouer l'audio uniquement sur changement d'etat logique du simulateur.
  // On depend d'identifiants stables (id du noeud, index de sequence) et non des
  // objets currentEntry / simpleStory / activeSequenceStep, dont la reference change
  // a chaque edition du projet (frappe dans un champ) et relancerait l'audio.
  // Les helpers playAudio / playZipItemAudio capturent les valeurs courantes via
  // closures stables.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, currentEntry?.id, simpleStory?.id, sequenceIndex]);

  // On ne pousse la selection vers l'arbre que lorsque le noeud actif du
  // simulateur change reellement (navigation), pas a chaque re-rendu provoque
  // par une edition du projet -- sinon le simulateur ecrase une selection en
  // cours d'edition portant sur un autre noeud.
  const lastEmittedActiveIdRef = useRef(null);
  useEffect(() => {
    const activeId =
      state === 'cover' ? 'root' :
      state === 'sequence' || state === 'postplay' || state === 'endnode' ? activeStory?.id :
      isSimple ? simpleStory?.id :
      currentEntry?.id;
    if (activeId && activeId !== lastEmittedActiveIdRef.current) {
      lastEmittedActiveIdRef.current = activeId;
      onActiveNodeChange?.(activeId);
    }
  }, [activeStory, currentEntry, isSimple, onActiveNodeChange, simpleStory, state]);

  useEffect(() => {
    const menuControls = currentEntry?.type === 'menu'
      ? getGeneratedMenuControls(currentEntry, currentMenu, project)
      : null;
    if (isSimple || state !== 'browse' || currentEntry?.type !== 'menu' || !menuControls?.autoplay || !autoPlaybackEnabled) return undefined;

    function advance() {
      if (!mountedRef.current) return;
      setMenuPath((path) => {
        if (path[path.length - 1] === currentEntry.id) return path;
        return [...path, currentEntry.id];
      });
      setEntryIdx(0);
    }

    if (!currentEntry.audio) {
      const timer = setTimeout(advance, 300);
      return () => clearTimeout(timer);
    }

    let pollTimer;
    let waited = 0;
    const maxWait = 15000;

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
  }, [currentEntry, currentMenu, isSimple, project, state, autoPlaybackEnabled]);

  // Transition de fin de lecture : prompt intermediaire puis retour, ou retour direct.
  useEffect(() => {
    if (state !== 'playing' || !autoPlaybackEnabled) return undefined;
    const story = isSimple ? simpleStory : currentEntry;
    const behavior = story?.type === 'story'
      ? getEffectiveEndBehavior(story, currentMenu, project, rootEntries)
      : null;
    const shouldAutoFinish = !!behavior?.autoContinuation;
    if (!shouldAutoFinish) return undefined;

    let pollTimer;
    let waited = 0;
    const maxWait = 15000;
    let endedHandler = null;

    function tryAttach() {
      if (!mountedRef.current) return;
      const audio = audioRef.current;
      if (audio) {
        endedHandler = () => {
          if (!startAfterPlaybackSequence() && !startAfterPlaybackPrompt()) {
            if (!startEndNode()) navigateAfterStory();
          }
        };
        if (audio.ended) { endedHandler(); }
        else { audio.addEventListener('ended', endedHandler, { once: true }); }
        return;
      }
      waited += 100;
      if (waited < maxWait) pollTimer = setTimeout(tryAttach, 100);
    }

    pollTimer = setTimeout(tryAttach, 100);
    return () => {
      clearTimeout(pollTimer);
      if (audioRef.current && endedHandler) audioRef.current.removeEventListener('ended', endedHandler);
    };
  }, [state, currentEntry, currentMenu, isSimple, navigateAfterStory, project, rootEntries, simpleStory, startAfterPlaybackPrompt, startAfterPlaybackSequence, startEndNode, autoPlaybackEnabled]);

  useEffect(() => {
    if (
      state !== 'postplay'
      || !autoPlaybackEnabled
      || activeStory?.afterPlaybackPromptControlSettings?.autoplay === false
    ) return undefined;

    let pollTimer;
    let waited = 0;
    const maxWait = 15000;

    function handler() {
      if (!mountedRef.current) return;
      navigatePromptOk();
    }

    function tryAttach() {
      if (!mountedRef.current) return;
      const audio = audioRef.current;
      if (audio) {
        if (audio.ended) { handler(); }
        else { audio.addEventListener('ended', handler, { once: true }); }
        return;
      }
      waited += 100;
      if (waited < maxWait) pollTimer = setTimeout(tryAttach, 100);
    }

    pollTimer = setTimeout(tryAttach, 100);
    return () => {
      clearTimeout(pollTimer);
      if (audioRef.current) audioRef.current.removeEventListener('ended', handler);
    };
  }, [activeStory, navigatePromptOk, state, autoPlaybackEnabled]);

  useEffect(() => {
    if (state !== 'sequence' || !activeSequenceStep?.controlSettings?.autoplay || !autoPlaybackEnabled) return undefined;

    let pollTimer;
    let waited = 0;
    const maxWait = 15000;

    function handler() {
      if (!mountedRef.current) return;
      advanceSequence();
    }

    if (!activeSequenceStep.audio) {
      const timer = setTimeout(handler, 300);
      return () => clearTimeout(timer);
    }

    function tryAttach() {
      if (!mountedRef.current) return;
      const audio = audioRef.current;
      if (audio) {
        if (audio.ended) { handler(); }
        else { audio.addEventListener('ended', handler, { once: true }); }
        return;
      }
      waited += 100;
      if (waited < maxWait) pollTimer = setTimeout(tryAttach, 100);
    }

    pollTimer = setTimeout(tryAttach, 100);
    return () => {
      clearTimeout(pollTimer);
      if (audioRef.current) audioRef.current.removeEventListener('ended', handler);
    };
  }, [activeSequenceStep, advanceSequence, state, autoPlaybackEnabled]);

  useEffect(() => {
    if (state !== 'endnode' || !autoPlaybackEnabled) return undefined;

    let pollTimer;
    let waited = 0;
    const maxWait = 15000;

    function tryAttach() {
      if (!mountedRef.current) return;
      const audio = audioRef.current;
      if (audio) {
        if (audio.ended) { navigateAfterStory(); }
        else { audio.addEventListener('ended', navigateAfterStory, { once: true }); }
        return;
      }
      waited += 100;
      if (waited < maxWait) pollTimer = setTimeout(tryAttach, 100);
    }

    pollTimer = setTimeout(tryAttach, 100);
    return () => {
      clearTimeout(pollTimer);
      if (audioRef.current) audioRef.current.removeEventListener('ended', navigateAfterStory);
    };
  }, [navigateAfterStory, state, autoPlaybackEnabled]);

  function handleOk() {
    if (isSimple && state === 'playing' && simpleStory?.controlSettings?.ok === false) {
      return;
    }
    if (state === 'endnode') {
      navigateAfterStory();
      return;
    }
    if (state === 'sequence') {
      if (activeSequenceStep?.controlSettings?.ok === false) return;
      advanceSequence();
      return;
    }
    if (state === 'postplay') {
      if (activeStory?.afterPlaybackPromptControlSettings?.ok === false) return;
      navigatePromptOk();
      return;
    }
    if (state === 'playing' && currentEntry?.type === 'story' && currentEntry?.controlSettings?.ok === false) {
      return;
    }
    if (isSimple) {
      if (state === 'cover') setState('playing');
      else setState('cover');
      return;
    }
    if (state === 'cover') {
      setState('browse');
    } else if (state === 'browse') {
      if (currentEntry?.type === 'menu') {
        setMenuPath((path) => [...path, currentEntry.id]);
        setEntryIdx(0);
      } else if (currentEntry?.type === 'zip') {
        if (currentEntry.zipPath) onOpenZip(currentEntry.zipPath);
      } else if (currentEntry?.type === 'ref') {
        // Un nœud de référence saute vers la cible existante (comme à l'export).
        navigateToTarget(currentEntry.target);
      } else if (currentEntry?.type === 'story') {
        setState('playing');
      }
    } else if (state === 'playing') {
      if (!startAfterPlaybackSequence() && !startAfterPlaybackPrompt()) {
        if (!startEndNode()) navigateAfterStory();
      }
    }
  }

  function handleHome() {
    if (isSimple && state === 'playing' && simpleStory?.controlSettings?.home === false) {
      return;
    }
    if (state === 'sequence') {
      if (activeSequenceStep?.controlSettings?.home === false) return;
      navigateSequenceHome();
      return;
    }
    if (state === 'endnode') {
      navigateAfterStory();
      return;
    }
    if (state === 'postplay') {
      if (activeStory?.afterPlaybackPromptControlSettings?.home === false) return;
      navigatePromptHome();
      return;
    }
    if (!isSimple && state === 'playing' && currentEntry?.type === 'story' && currentEntry?.controlSettings?.home === false) {
      return;
    }
    if (!isSimple && state === 'playing' && currentEntry?.type === 'story') {
      navigateHomeFromStory();
      return;
    }
    setState('cover');
    setMenuPath([]);
    setEntryIdx(0);
  }

  const displayTitle =
    state === 'cover' ? (
      project.packMetadata?.title
        ? getExportPackName(project.packMetadata)
        : (project.projectName || 'Nom de mon histoire')
    ) :
    state === 'sequence' ? (activeSequenceStep?.name || activeStory?.name || 'Fin de lecture') :
    isSimple ? (simpleStory?.name || '—') :
    currentEntry?.type === 'ref'
      ? (currentEntry.label?.trim()
        || `→ ${findEntryLocation(rootEntries, refTargetEntryId(currentEntry.target))?.entry?.name || 'lien'}`)
    : (currentEntry?.name || '—');

  const displaySub =
    state === 'cover' ? 'Appuie sur OK' :
    state === 'browse' ? `${Math.min(entryIdx + 1, Math.max(currentEntries.length, 1))} / ${Math.max(currentEntries.length, 1)}${currentMenu ? ` · ${currentMenu.name}` : ''}` :
    state === 'sequence' ? `▶ Sequence de fin ${Math.min(sequenceIndex + 1, Math.max(activeSequence.length, 1))} / ${Math.max(activeSequence.length, 1)}` :
    state === 'postplay' ? '▶ Fin de lecture...' :
    state === 'endnode' ? '▶ Message de fin...' :
    '▶ Lecture en cours...';

  const imageFile =
    (state === 'playing' || state === 'postplay' || state === 'sequence' || state === 'endnode') ? null :
    isSimple ? project.rootImage :
    state === 'cover' ? project.rootImage :
    currentEntry?.type === 'menu'
      ? (currentEntry?.autoBlackImage ? null : currentEntry?.image)
      : currentEntry?.itemImage;

  const zipItemForImage =
    ((state === 'browse' || state === 'playing' || state === 'postplay') && currentEntry?.type === 'zip') ? currentEntry :
    null;

  const okDisabled =
    state === 'sequence'
      ? activeSequenceStep?.controlSettings?.ok === false
      : state === 'postplay'
      ? activeStory?.afterPlaybackPromptControlSettings?.ok === false
      :
    isSimple && state === 'playing'
      ? simpleStory?.controlSettings?.ok === false
      : state === 'playing' && currentEntry?.type === 'story'
      ? currentEntry?.controlSettings?.ok === false
      : false;

  const homeDisabled =
    state === 'sequence'
      ? activeSequenceStep?.controlSettings?.home === false || !!activeSequenceStep?.homeNone
      : state === 'postplay'
      ? activeStory?.afterPlaybackPromptControlSettings?.home === false || !!activeStory?.afterPlaybackPromptHomeNone
      :
    isSimple && state === 'playing'
      ? simpleStory?.controlSettings?.home === false
      : state === 'playing' && currentEntry?.type === 'story'
      ? currentEntry?.controlSettings?.home === false
      : false;

  return (
    <LuniiShell
      image={
        zipItemForImage?.coverImage
          ? <ZipImage zipPath={zipItemForImage.zipPath} assetName={toPackAssetName(zipItemForImage.coverImage)} />
          : <LocalImage file={imageFile} />
      }
      title={displayTitle}
      sub={displaySub}
      onOk={handleOk}
      onHome={handleHome}
      onLeft={() => {
        if (state === 'browse') setEntryIdx((i) => Math.max(0, i - 1));
      }}
      onRight={() => {
        if (state === 'browse') setEntryIdx((i) => Math.min(Math.max(currentEntries.length - 1, 0), i + 1));
      }}
      paused={paused}
      onPause={handlePause}
      okDisabled={okDisabled}
      homeDisabled={homeDisabled}
      chromeControls={chromeControls}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      playbackControls={{
        visible: (state === 'playing' || state === 'postplay' || state === 'sequence') && timeline.hasAudio,
        currentTime: timeline.currentTime,
        duration: timeline.duration,
        onSeek: seekTo,
      }}
    />
  );
}
