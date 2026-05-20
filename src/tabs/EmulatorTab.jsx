import { useState, useRef, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';
import { readFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useLocalFile } from '../store/useLocalFile';
import { decodeNavigationMenuId, decodeNavigationStoryId, isCurrentMenuNavigationTarget, isNextStoryNavigationTarget, isRootNavigationTarget, isStoryNavigationTarget, isStoryPlayNavigationTarget, normalizeNavigationTarget } from '../store/navigationTargets';
import { Tooltip } from '../components/common/Tooltip';
import { getExportPackName } from '../utils/packConvention';
import './EmulatorTab.css';

const TRANSFER_TOOLS = [
  { name: 'STUdio', url: 'https://github.com/DantSu/studio' },
  { name: 'LuniiQt', url: 'https://github.com/o-daneel/Lunii.QT' },
];

// Cache blob URLs partagé (chemin fichier → url, ou "zip:path:asset" → url)
const urlCache = new Map();
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm',
};

function revokeUrlCache() {
  for (const url of urlCache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  urlCache.clear();
}

async function getLocalUrl(path) {
  if (!path) return null;
  if (urlCache.has(path)) return urlCache.get(path);
  try {
    const ext = path.split('.').pop().toLowerCase();
    const data = await readFile(path);
    const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' }));
    urlCache.set(path, url);
    return url;
  } catch { return null; }
}

async function getZipAssetUrl(zipPath, assetName) {
  if (!zipPath || !assetName) return null;
  const key = `zip:${zipPath}:${assetName}`;
  if (urlCache.has(key)) return urlCache.get(key);
  try {
    const bytes = await invoke('get_pack_asset', { zipPath, assetName });
    const ext = assetName.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'application/octet-stream' }));
    urlCache.set(key, url);
    return url;
  } catch { return null; }
}

function findEntryLocation(entries, targetId, menuPath = []) {
  for (let index = 0; index < (entries?.length ?? 0); index += 1) {
    const entry = entries[index];
    if (entry.id === targetId) return { entry, menuPath, entryIdx: index };
    if (entry.type === 'menu') {
      const nested = findEntryLocation(entry.children ?? [], targetId, [...menuPath, entry.id]);
      if (nested) return nested;
    }
  }
  return null;
}

function getMenuBrowseState(entries, targetMenuId) {
  if (targetMenuId === 'root') {
    return {
      state: 'browse',
      menuPath: [],
      entryIdx: 0,
    };
  }
  const location = findEntryLocation(entries, targetMenuId);
  if (!location?.entry || location.entry.type !== 'menu') return null;
  // Navigate to the menu's card in its parent context (not inside it).
  // The menu's audio will play, then autoBlackImage/ok navigates inside.
  return {
    menuPath: location.menuPath,
    entryIdx: location.entryIdx,
  };
}

function resolveStoryReturnTarget(entry, parentMenu, project = null) {
  const directTarget = normalizeNavigationTarget(entry?.returnAfterPlay);
  if (directTarget) {
    if (isRootNavigationTarget(directTarget)) return 'root';
    if (isCurrentMenuNavigationTarget(directTarget)) return parentMenu?.id ?? null;
    if (isNextStoryNavigationTarget(directTarget)) return 'next_story';
    if (isStoryNavigationTarget(directTarget)) return directTarget;
    return decodeNavigationMenuId(directTarget);
  }

  const inheritedTarget = normalizeNavigationTarget(parentMenu?.returnAfterPlay);
  if (inheritedTarget) {
    if (isRootNavigationTarget(inheritedTarget)) return 'root';
    if (isCurrentMenuNavigationTarget(inheritedTarget)) return parentMenu?.id ?? null;
    if (isNextStoryNavigationTarget(inheritedTarget)) return 'next_story';
    if (isStoryNavigationTarget(inheritedTarget)) return inheritedTarget;
    return decodeNavigationMenuId(inheritedTarget);
  }

  if (project?.globalOptions?.autoNext) return 'next_story';
  return null;
}

function resolveStoryHomeTarget(entry, parentMenu) {
  if (entry?.returnOnHome) {
    const normalized = normalizeNavigationTarget(entry.returnOnHome);
    if (normalized) {
      if (isRootNavigationTarget(normalized)) return 'root';
      if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
      if (isNextStoryNavigationTarget(normalized)) return 'next_story';
      if (isStoryNavigationTarget(normalized)) return normalized;
      return decodeNavigationMenuId(normalized);
    }
  }
  return resolveStoryReturnTarget(entry, parentMenu);
}

function resolveSequenceTarget(target, parentMenu) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
  if (isNextStoryNavigationTarget(normalized)) return 'next_story';
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

function formatPlaybackTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const rounded = Math.floor(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function useAudioTimeline(audioRef) {
  const [timeline, setTimeline] = useState({ hasAudio: false, currentTime: 0, duration: 0 });

  useEffect(() => {
    function readTimeline() {
      const audio = audioRef.current;
      if (!audio) {
        setTimeline((prev) => (
          prev.hasAudio || prev.currentTime !== 0 || prev.duration !== 0
            ? { hasAudio: false, currentTime: 0, duration: 0 }
            : prev
        ));
        return;
      }

      const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const nextCurrentTime = Number.isFinite(audio.currentTime) && audio.currentTime >= 0
        ? Math.min(audio.currentTime, nextDuration || audio.currentTime)
        : 0;

      setTimeline((prev) => (
        prev.hasAudio
        && Math.abs(prev.currentTime - nextCurrentTime) < 0.1
        && Math.abs(prev.duration - nextDuration) < 0.1
          ? prev
          : { hasAudio: true, currentTime: nextCurrentTime, duration: nextDuration }
      ));
    }

    readTimeline();
    const timer = setInterval(readTimeline, 200);
    return () => clearInterval(timer);
  }, [audioRef]);

  const seekTo = useCallback((nextTime) => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const clamped = Math.max(0, Math.min(duration || Math.max(nextTime, 0), nextTime));
    try {
      audio.currentTime = clamped;
      setTimeline({
        hasAudio: true,
        currentTime: clamped,
        duration,
      });
    } catch {}
  }, [audioRef]);

  return { timeline, seekTo };
}

function useLuniiChromeControls() {
  const [autoPlaybackEnabled, setAutoPlaybackEnabled] = useState(true);
  const [transparentPreview, setTransparentPreview] = useState(false);
  return {
    autoPlaybackEnabled,
    transparentPreview,
    toggleAutoPlayback: () => setAutoPlaybackEnabled((value) => !value),
    toggleTransparentPreview: () => setTransparentPreview((value) => !value),
  };
}

// ── Composants image ─────────────────────────────────────────────────────────

function LocalImage({ file }) {
  const url = useLocalFile(file);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}

function ZipImage({ zipPath, assetName }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!zipPath || !assetName) { setUrl(null); return; }
    let cancelled = false;
    getZipAssetUrl(zipPath, assetName)
      .then(nextUrl => {
        if (cancelled) return;
        setUrl(nextUrl);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [zipPath, assetName]);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}

// ── Shell Lunii partagé ───────────────────────────────────────────────────────

function LuniiShell({
  image,
  title,
  sub,
  onOk,
  onHome,
  onLeft,
  onRight,
  paused,
  onPause,
  okDisabled,
  homeDisabled,
  playbackControls,
  chromeControls,
  onClose,
  dragHandleProps = null,
}) {
  return (
    <div className={`lunii-sim${chromeControls?.transparentPreview ? ' is-transparent-preview' : ''}`}>
      {(chromeControls || onClose) && (
        <div className="lunii-top-controls">
          <div className="lunii-top-controls-left">
            {dragHandleProps && (
              <Tooltip text="Déplacer le simulateur">
                <button
                  type="button"
                  className="lunii-drag-handle"
                  aria-label="Déplacer le simulateur"
                  {...dragHandleProps}
                >
                  ⋮⋮
                </button>
              </Tooltip>
            )}
            {chromeControls && (
              <>
                <Tooltip text={chromeControls.autoPlaybackEnabled ? "Désactiver les transitions automatiques dans le simulateur" : "Réactiver les transitions automatiques dans le simulateur"}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.autoPlaybackEnabled ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleAutoPlayback}
                  >
                    Auto
                  </button>
                </Tooltip>
                <Tooltip text={chromeControls.transparentPreview ? "Rendre l'aperçu opaque" : "Rendre l'aperçu transparent"}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.transparentPreview ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleTransparentPreview}
                  >
                    Transparence
                  </button>
                </Tooltip>
              </>
            )}
          </div>
          {onClose && (
            <button type="button" className="lunii-close-btn" onClick={onClose} aria-label="Fermer le simulateur">
              ×
            </button>
          )}
        </div>
      )}
      {playbackControls?.visible && (
        <div className="lunii-playback-bar">
          <Tooltip text="Reculer de 10 secondes">
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime - 10)}
            >
              -10s
            </button>
          </Tooltip>
          <span className="lunii-playback-time">{formatPlaybackTime(playbackControls.currentTime)}</span>
          <input
            className="lunii-playback-slider"
            type="range"
            min={0}
            max={Math.max(playbackControls.duration, 0)}
            step={0.1}
            value={Math.min(playbackControls.currentTime, playbackControls.duration || playbackControls.currentTime)}
            onChange={(event) => playbackControls.onSeek(Number(event.target.value))}
            disabled={playbackControls.duration <= 0}
          />
          <span className="lunii-playback-time">{formatPlaybackTime(playbackControls.duration)}</span>
          <Tooltip text="Avancer de 10 secondes">
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime + 10)}
            >
              +10s
            </button>
          </Tooltip>
        </div>
      )}
      <div className="lunii-body">
        <div className="lunii-wheel-zone">
          <div className="lunii-wheel" onClick={onOk}>
            <div className="lunii-wheel-left" onClick={e => { e.stopPropagation(); onLeft?.(); }} />
            <div className="lunii-wheel-right" onClick={e => { e.stopPropagation(); onRight?.(); }} />
          </div>
        </div>
        <div className="lunii-screen-zone">
          <div className="lunii-screen">
            {image}
            <div className="lunii-screen-text">
              <div className="lunii-screen-title">{title}</div>
              <div className="lunii-screen-sub">{sub}</div>
            </div>
          </div>
        </div>
        <div className="lunii-buttons">
          <Tooltip text="Accueil">
            <button className="lunii-btn-round" onClick={onHome} disabled={homeDisabled}>⌂</button>
          </Tooltip>
          <Tooltip text={paused ? 'Reprendre' : 'Pause'}>
            <button className="lunii-btn-round" onClick={onPause}>
              {paused ? '▶' : '⏸'}
            </button>
          </Tooltip>
          <Tooltip text="OK">
            <button className="lunii-btn-round lunii-btn-ok" onClick={onOk} disabled={okDisabled}>OK</button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

// ── Mode Projet (comportement existant) ───────────────────────────────────────

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

  useEffect(() => {
    if (isSimple) return;
    if (!initialSelectionId || initialSelectionId === 'root') {
      setState('cover');
      setMenuPath([]);
      setEntryIdx(0);
      return;
    }

    const location = findEntryLocation(rootEntries, initialSelectionId);
    if (!location) return;

    setState(location.entry?.type === 'story' ? 'playing' : 'browse');
    setMenuPath(location.menuPath);
    setEntryIdx(location.entryIdx);
  }, [initialSelectionId, isSimple, rootEntries]);

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
    if (isSimple || currentEntry?.type !== 'story') {
      setState('browse');
      return;
    }

    const target = resolveStoryReturnTarget(currentEntry, currentMenu, project);
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
  }, [currentEntry, currentMenu, entryIdx, isSimple, menuPath, navigateToNextStory, navigateToTarget]);

  const navigateHomeFromStory = useCallback(() => {
    if (isSimple || currentEntry?.type !== 'story') {
      setState('browse');
      return;
    }

    const target = resolveStoryHomeTarget(currentEntry, currentMenu);
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
  }, [currentEntry, currentMenu, entryIdx, isSimple, menuPath, navigateToNextStory, navigateToTarget]);

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
    const target = resolveSequenceTarget(step?.homeTarget, currentMenu) ?? resolveStoryHomeTarget(activeStory, currentMenu);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateHomeFromStory();
  }, [activeSequence, activeStory, currentMenu, navigateHomeFromStory, navigateToNextStory, navigateToTarget, sequenceIndex]);

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
    const target = resolveSequenceTarget(activeStory?.afterPlaybackPromptHomeTarget, currentMenu)
      ?? resolveSequenceTarget(activeStory?.afterPlaybackPromptOkTarget, currentMenu)
      ?? resolveStoryHomeTarget(activeStory, currentMenu);
    if (target === 'next_story') {
      if (navigateToNextStory()) return;
    } else if (target && navigateToTarget(target)) {
      return;
    }
    navigateHomeFromStory();
  }, [activeStory, currentMenu, navigateHomeFromStory, navigateToNextStory, navigateToTarget]);

  const advanceSequence = useCallback(() => {
    if (sequenceIndex + 1 < activeSequence.length) {
      setSequenceIndex((index) => index + 1);
      return;
    }
    navigateSequenceOk();
  }, [activeSequence.length, navigateSequenceOk, sequenceIndex]);

  const startAfterPlaybackSequence = useCallback(() => {
    const sequence = isSimple
      ? (simpleStory?.afterPlaybackSequence ?? [])
      : (currentEntry?.afterPlaybackSequence ?? []);
    if (sequence.length > 0) {
      setSequenceIndex(0);
      setState('sequence');
      return true;
    }
    return false;
  }, [currentEntry, isSimple, simpleStory]);

  const startAfterPlaybackPrompt = useCallback(() => {
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
  }, [currentEntry, isSimple, simpleStory]);

  const startEndNode = useCallback(() => {
    if (!project.nightModeAudio) return false;
    setState('endnode');
    return true;
  }, [project.nightModeAudio]);

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
      const assetName = `assets/${assetHash}`;
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
  }, [state, currentEntry, simpleStory, activeSequenceStep]); // eslint-disable-line

  useEffect(() => {
    const activeId =
      state === 'cover' ? 'root' :
      state === 'sequence' || state === 'postplay' || state === 'endnode' ? activeStory?.id :
      isSimple ? simpleStory?.id :
      currentEntry?.id;
    if (activeId) onActiveNodeChange?.(activeId);
  }, [activeStory, currentEntry, isSimple, onActiveNodeChange, simpleStory, state]);

  useEffect(() => {
    if (isSimple || state !== 'browse' || currentEntry?.type !== 'menu' || !currentEntry?.autoBlackImage || !autoPlaybackEnabled) return undefined;

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
  }, [currentEntry, isSimple, state, autoPlaybackEnabled]);

  // Transition de fin de lecture : prompt intermediaire puis retour, ou retour direct.
  useEffect(() => {
    if (state !== 'playing' || !currentEntry?.controlSettings?.autoplay || !autoPlaybackEnabled) return undefined;

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
  }, [state, currentEntry, navigateAfterStory, startAfterPlaybackPrompt, startAfterPlaybackSequence, autoPlaybackEnabled]);

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
    (currentEntry?.name || '—');

  const displaySub =
    state === 'cover' ? 'Appuie sur OK' :
    state === 'browse' ? `${Math.min(entryIdx + 1, Math.max(currentEntries.length, 1))} / ${Math.max(currentEntries.length, 1)}${currentMenu ? ` · ${currentMenu.name}` : ''}` :
    state === 'sequence' ? `▶ Sequence de fin ${Math.min(sequenceIndex + 1, Math.max(activeSequence.length, 1))} / ${Math.max(activeSequence.length, 1)}` :
    state === 'postplay' ? '▶ Fin de lecture...' :
    state === 'endnode' ? '▶ Nœud de fin...' :
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
          ? <ZipImage zipPath={zipItemForImage.zipPath} assetName={`assets/${zipItemForImage.coverImage}`} />
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

// ── Mode ZIP — navigation sur le vrai story.json ──────────────────────────────
//
// Modèle de navigation Lunii :
//   stageNode  — nœud affiché (image + audio)
//   actionNode — liste d'options entre lesquelles la molette navigue
//
// State: { stageId, context: { actionNodeId, optionIdx } | null }
//   - stageId    : nœud affiché
//   - context    : position de la molette (null = nœud racine sans parent)
//
// OK  → okTransition  → actionNode → options[optionIndex]
// ⌂   → homeTransition → idem, ou retour squareOne
// ←/→ → navigate dans context.actionNode.options

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
          // Étape 1 : sauter le squareOne via okTransition
          const ok = squareOne.okTransition;
          if (ok) {
            const an = actionNodes.get(ok.actionNode);
            if (an?.options?.length) {
              const idx = ok.optionIndex >= 0 ? Math.min(ok.optionIndex, an.options.length - 1) : 0;
              initialStageId = an.options[idx];
              initialContext = { actionNodeId: ok.actionNode, optionIdx: idx };
            }
          }

          // Étape 2 : sauter un éventuel nœud autoplay intermédiaire (ex : night-mode)
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
  }, [zipPath]); // eslint-disable-line

  const currentStage = graph?.stageNodes.get(stageId);

  // ── Audio ──
  const playZipAudio = useCallback(async (assetHash) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPaused(false);
    if (!assetHash || !zipPath) return;
    const seq = ++playSeqRef.current; // numéro de séquence pour détecter les charges tardives
    try {
      const assetName = `assets/${assetHash}`;
      const bytes = await invoke('get_pack_asset', { zipPath, assetName });
      // Ignorer si démontage ou si une autre lecture a démarré entre-temps
      if (!mountedRef.current || seq !== playSeqRef.current) return;
      const ext = assetHash.split('.').pop().toLowerCase();
      const blob = new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(e => logger.error('[ZipSimulator] audio.play() failed', e));
      audioRef.current = audio;
    } catch (e) { logger.error('[ZipSimulator] playZipAudio failed for', assetHash, e); }
  }, [zipPath]);

  useEffect(() => {
    if (currentStage?.audio) playZipAudio(currentStage.audio);
    else if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }, [stageId]); // eslint-disable-line

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
  }, [stageId, graph, autoPlaybackEnabled]); // eslint-disable-line

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
      <div style={{ marginTop: 8, color: 'var(--color-text-tertiary)', fontSize: 11 }}>{zipPath}</div>
    </div>
  );
  if (!graph) return (
    <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
      Chargement du pack…
    </div>
  );

  const cs = currentStage?.controlSettings ?? {};
  const isAtEntry = fromProject && (stageId === entryStageId || stageId === graph.squareOneId);
  const imageAsset = currentStage?.image ? `assets/${currentStage.image}` : null;

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

// ── EmulatorTab ───────────────────────────────────────────────────────────────

// initialZipPath : chemin passé depuis l'éditeur via clic droit → simuler directement en mode ZIP
export function EmulatorTab({ project, initialZipPath, onConsumeZipPath }) {
  const [mode, setMode] = useState(initialZipPath ? 'zip' : 'project');
  const [zipPath, setZipPath] = useState(initialZipPath ?? null);
  const [zipFromProject, setZipFromProject] = useState(false);

  // Notifier le parent que initialZipPath a été consommé, pour que le prochain
  // montage de l'onglet revienne en mode projet par défaut
  useEffect(() => {
    if (initialZipPath) onConsumeZipPath?.();
  }, []); // eslint-disable-line

  // Révoquer toutes les blob URLs quand l'onglet est démonté
  useEffect(() => () => revokeUrlCache(), []);

  function handleOpenZip(path) {
    setZipPath(path);
    setZipFromProject(true);
    setMode('zip');
  }

  return (
    <div className="screen visible emu-screen">

      {/* Barre de navigation : en mode ZIP, afficher le nom + bouton retour projet */}
      {mode === 'zip' && (
        <div className="emu-mode-bar">
          <Tooltip text="Retour au simulateur projet">
            <button
              className="emu-mode-btn"
              onClick={() => setMode('project')}
            >
              ← Projet
            </button>
          </Tooltip>
          {zipPath && (
            <span className="emu-zip-label">{zipPath.split(/[\\/]/).pop()}</span>
          )}
        </div>
      )}

      {/* Simulateur */}
      {mode === 'project'
        ? <ProjectSimulator project={project} onOpenZip={handleOpenZip} />
        : zipPath
          ? <ZipSimulator key={zipPath} zipPath={zipPath} fromProject={zipFromProject} onExit={() => setMode('project')} />
          : null
      }

      <div className="lunii-hint">
        Roue : gauche/droite = naviguer · OK = valider · ⌂ = accueil
      </div>

      <div className="lunii-transfer-card">
        <span className="lunii-transfer-label">Pour transférer sur votre Boîte à Histoires :</span>
        <div className="lunii-transfer-links">
          {TRANSFER_TOOLS.map(t => (
            <button key={t.name} className="lunii-transfer-link" onClick={() => openUrl(t.url)}>
              {t.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
