import { useRef, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { useLocalFile } from '../../store/useLocalFile';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Play, Pause, Square, SkipBack, SkipForward, Scissors, RotateCcw, Crop } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import './AudioEditorModal.css';

const NUDGE_STEP = 0.05;
const SKIP_STEP = 5;
const ZOOM_MIN = 1;
const ZOOM_MAX = 600;
const WHEEL_ZOOM_SENSITIVITY = 0.04;
const KEYBOARD_ZOOM_STEP = 12;
const SCRUB_DURATION = 0.06;
const SHUTTLE_RATES = [1, 2, 4, 8];

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const cc = String(cs).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${cc}` : `${mm}:${ss}.${cc}`;
}

export function AudioEditorModal({ filePath, savePath, workspaceDir, onConfirm, onCancel }) {
  const [sourcePath, setSourcePath] = useState(filePath);
  const [previewPath, setPreviewPath] = useState(null);
  const audioUrl = useLocalFile(previewPath || sourcePath || filePath);
  const [fadePopover, setFadePopover] = useState(null);
  const [fadeContextMenu, setFadeContextMenu] = useState(null);
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const durationRef = useRef(0);
  const isClampingRef = useRef(false);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const initialEditRef = useRef(null);
  const preStagedSelectionRef = useRef(null);
  const preStagedCutMarkersRef = useRef([]);
  const skipNextZoomEffectRef = useRef(false);
  const actionBasePathRef = useRef(filePath);
  const pendingViewportRef = useRef(null);
  const audioCtxRef = useRef(null);
  const shuttleRef = useRef(null);
  const reverseBufferRef = useRef(null);

  const [editInfo, setEditInfo] = useState(null);
  const [stagedEdit, setStagedEdit] = useState(null);
  const [hasChainedPreview, setHasChainedPreview] = useState(false);
  const [cutMarkers, setCutMarkers] = useState([]);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [fadeInSec, setFadeInSec] = useState(0);
  const [fadeOutSec, setFadeOutSec] = useState(0);
  const [cutFadeSec, setCutFadeSec] = useState(0);
  const [zoom, setZoom] = useState(80);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [applyMode, setApplyMode] = useState(null); // 'trim' | 'cut' | 'preview' | 'restore' | null
  const [currentTime, setCurrentTime] = useState(0);
  const [shuttleStatus, setShuttleStatus] = useState(null);
  const [error, setError] = useState(null);

  const isApplying = applyMode !== null;
  const isPreviewingEdit = !!previewPath;
  const filename = filePath?.split(/[\\/]/).pop() ?? '';
  const trimDuration = Math.max(0, trimEnd - trimStart);
  const canOperate = !isLoading && !isApplying && trimEnd > trimStart + 0.01;
  const canCut = canOperate && trimDuration < duration - 0.01;
  const fadeMax = Math.max(0, Math.min(10, trimDuration / 2));
  const outputFadeMax = isPreviewingEdit ? Math.max(0, Math.min(10, duration / 2)) : fadeMax;
  const cutFadeAnchor = stagedEdit?.mode === 'cut' ? stagedEdit.startSec : trimStart;
  const cutFadeMax = Math.max(0, Math.min(5, cutFadeAnchor));
  const canValidate = !!stagedEdit && !isApplying;

  useEscapeKey(!isApplying, onCancel);

  useEffect(() => {
    let cancelled = false;
    setSourcePath(filePath);
    setPreviewPath(null);
    setStagedEdit(null);
    setEditInfo(null);
    setHasChainedPreview(false);
    setCutMarkers([]);
    actionBasePathRef.current = filePath;
    preStagedSelectionRef.current = null;
    preStagedCutMarkersRef.current = [];
    setFadeInSec(0);
    setFadeOutSec(0);
    setCutFadeSec(0);
    initialEditRef.current = null;
    invoke('audio_edit_info', {
      inputPath: filePath,
      savePath: savePath ?? null,
      workspaceDir: workspaceDir ?? null,
    }).then((info) => {
      if (cancelled) return;
      setEditInfo(info);
      if (info?.source_path) setSourcePath(info.source_path);
      if (info?.mode === 'cut' || info?.mode === 'trim') {
        setStagedEdit({
          mode: info.mode,
          startSec: Number(info?.start_sec ?? 0),
          endSec: Number(info?.end_sec ?? 0),
          fadeInSec: Number(info?.fade_in_sec ?? 0),
          fadeOutSec: Number(info?.fade_out_sec ?? 0),
          cutFadeSec: Number(info?.cut_fade_sec ?? 0),
        });
      }
      setFadeInSec(Number(info?.fade_in_sec ?? 0));
      setFadeOutSec(Number(info?.fade_out_sec ?? 0));
      setCutFadeSec(Number(info?.cut_fade_sec ?? 0));
      const hasSavedSelection = Number.isFinite(Number(info?.start_sec))
        && Number.isFinite(Number(info?.end_sec))
        && Number(info.end_sec) > Number(info.start_sec);
      initialEditRef.current = hasSavedSelection
        ? {
            start: Number(info.start_sec),
            end: Number(info.end_sec),
          }
        : null;
    }).catch(() => {
      if (!cancelled) setSourcePath(filePath);
    });
    return () => { cancelled = true; };
  }, [filePath, savePath]);

  useEffect(() => {
    if (!fadePopover && !fadeContextMenu) return undefined;
    function handlePointerDown(e) {
      if (e.target.closest?.('.audio-editor-fade-popover')) return;
      if (e.target.closest?.('.audio-editor-fade-context-menu')) return;
      setFadePopover(null);
      setFadeContextMenu(null);
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [fadePopover, fadeContextMenu]);

  useEffect(() => {
    if (!audioUrl || !containerRef.current) return;

    let mounted = true;
    const wsRegions = RegionsPlugin.create();
    setIsLoading(true);
    setError(null);
    wsRef.current = null;
    reverseBufferRef.current = null;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      waveColor: '#64748B',
      progressColor: '#94A3B8',
      cursorColor: '#F59E0B',
      height: 96,
      plugins: [wsRegions],
      interact: true,
      dragToSeek: true,
      hideScrollbar: false,
    });

    ws.on('ready', (dur) => {
      if (!mounted) return;
      wsRef.current = ws;
      const showingStagedPreview = !!previewPath && !!stagedEdit;
      const initial = initialEditRef.current ?? {};
      const initialStart = Math.max(0, Math.min(Number(initial.start ?? 0), dur));
      const initialEnd = Math.max(initialStart + 0.1, Math.min(Number(initial.end ?? dur), dur));
      durationRef.current = dur;
      setDuration(dur);

      const containerWidth = containerRef.current?.clientWidth ?? 600;
      const fitZoom = Math.max(1, Math.min(200, Math.floor(containerWidth / dur)));
      const pendingViewport = pendingViewportRef.current;
      pendingViewportRef.current = null;
      const initialZoom = pendingViewport?.zoom ?? fitZoom;
      if (pendingViewport) skipNextZoomEffectRef.current = true;
      setZoom(initialZoom);
      applyWaveZoom(initialZoom, ws);
      restoreWaveViewport(ws, pendingViewport, initialZoom, containerWidth);
      if (pendingViewport) {
        requestAnimationFrame(() => {
          if (!mounted || wsRef.current !== ws) return;
          restoreWaveViewport(ws, pendingViewport, initialZoom, containerWidth);
        });
        window.setTimeout(() => {
          if (!mounted || wsRef.current !== ws) return;
          restoreWaveViewport(ws, pendingViewport, initialZoom, containerWidth);
        }, 40);
      }

      if (showingStagedPreview) {
        trimStartRef.current = 0;
        trimEndRef.current = parseFloat(dur.toFixed(3));
        setTrimStart(trimStartRef.current);
        setTrimEnd(trimEndRef.current);

        const previewSelection = wsRegions.addRegion({
          id: 'audio-selection-region',
          start: trimStartRef.current,
          end: trimEndRef.current,
          color: 'rgba(37, 99, 235, 0.2)',
          drag: false,
          resize: true,
        });
        styleRegionHandles(previewSelection, '#60a5fa');
        regionRef.current = previewSelection;

        const previewFadeMax = Math.max(0, Math.min(10, dur / 2));
        const stagedFadeIn = Math.min(Number(stagedEdit.fadeInSec ?? 0), previewFadeMax);
        const stagedFadeOut = Math.min(Number(stagedEdit.fadeOutSec ?? 0), previewFadeMax);
        if (stagedFadeIn > 0.01) {
          const fadeInRegion = wsRegions.addRegion({
            id: 'audio-fade-in-region',
            start: 0,
            end: Math.min(dur, stagedFadeIn),
            color: 'rgba(34, 197, 94, 0.28)',
            drag: false,
            resize: true,
            resizeStart: false,
            resizeEnd: true,
          });
          styleRegionHandles(fadeInRegion, '#4ade80');
        }
        if (stagedFadeOut > 0.01) {
          const fadeOutRegion = wsRegions.addRegion({
            id: 'audio-fade-out-region',
            start: Math.max(0, dur - stagedFadeOut),
            end: dur,
            color: 'rgba(34, 197, 94, 0.28)',
            drag: false,
            resize: true,
            resizeStart: true,
            resizeEnd: false,
          });
          styleRegionHandles(fadeOutRegion, '#4ade80');
        }
        const visibleCutMarkers = cutMarkers.length > 0
          ? cutMarkers
          : stagedEdit.mode === 'cut'
            ? [{ time: Number(stagedEdit.startSec ?? 0), fadeSec: Number(stagedEdit.cutFadeSec ?? 0) }]
            : [];
        visibleCutMarkers.forEach((marker) => {
          const join = Math.max(0, Math.min(Number(marker.time ?? 0), dur));
          const isCurrentCutMarker = stagedEdit.mode === 'cut'
            && Math.abs(join - Number(stagedEdit.startSec ?? -1)) < 0.02;
          const markerFadeMax = Math.max(0, Math.min(5, join));
          const fade = Math.min(Number(marker.fadeSec ?? 0), markerFadeMax);
          const markerStart = Math.max(0, join - Math.max(0.04, fade));
          const cutRegion = wsRegions.addRegion({
            id: isCurrentCutMarker ? 'audio-cut-region' : 'audio-cut-history-region',
            start: markerStart,
            end: Math.max(markerStart + 0.01, join),
            color: 'rgba(245, 158, 11, 0.5)',
            drag: false,
            resize: isCurrentCutMarker,
            resizeStart: true,
            resizeEnd: false,
          });
          styleRegionHandles(cutRegion, '#f59e0b');
        });
        setIsLoading(false);
        return;
      }

      trimStartRef.current = parseFloat(initialStart.toFixed(3));
      trimEndRef.current = parseFloat(initialEnd.toFixed(3));
      setTrimStart(trimStartRef.current);
      setTrimEnd(trimEndRef.current);

      const region = wsRegions.addRegion({
        id: 'audio-selection-region',
        start: trimStartRef.current,
        end: trimEndRef.current,
        color: 'rgba(37, 99, 235, 0.32)',
        drag: false,
        resize: true,
      });
      styleRegionHandles(region, '#60a5fa');
      regionRef.current = region;
      setIsLoading(false);
    });

    ws.on('error', () => {
      if (!mounted) return;
      if (wsRef.current === ws) wsRef.current = null;
      setIsLoading(false);
      setError('Impossible de charger le fichier audio.');
    });

    ws.on('play', () => { if (mounted) setIsPlaying(true); });
    ws.on('pause', () => { if (mounted) setIsPlaying(false); });
    ws.on('finish', () => { if (mounted) setIsPlaying(false); });
    ws.on('timeupdate', (t) => { if (mounted) setCurrentTime(t); });

    wsRegions.on('region-updated', (region) => {
      if (!mounted || isClampingRef.current) return;
      const dur = durationRef.current;
      let { start, end } = region;
      if (region.id === 'audio-fade-in-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(end, dur / 2, 10)).toFixed(3));
        setFadeInSec(nextFade);
        void regenerateFadePreview({ fadeInSec: nextFade });
        return;
      }
      if (region.id === 'audio-fade-out-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(dur - start, dur / 2, 10)).toFixed(3));
        setFadeOutSec(nextFade);
        void regenerateFadePreview({ fadeOutSec: nextFade });
        return;
      }
      if (region.id === 'audio-cut-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(end - start, 5, end)).toFixed(3));
        const normalizedFade = nextFade <= 0.06 ? 0 : nextFade;
        setCutFadeSec(normalizedFade);
        void regenerateFadePreview({ cutFadeSec: normalizedFade }, 'cut');
        return;
      }
      if (region.id !== 'audio-selection-region') return;
      const cs = Math.max(0, Math.min(start, dur));
      const ce = Math.max(0, Math.min(end, dur));
      if (cs !== start || ce !== end) {
        isClampingRef.current = true;
        region.setOptions({ start: cs, end: ce });
        isClampingRef.current = false;
        start = cs;
        end = ce;
      }
      trimStartRef.current = start;
      trimEndRef.current = end;
      setTrimStart(parseFloat(start.toFixed(3)));
      setTrimEnd(parseFloat(end.toFixed(3)));
    });

    function handleWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const pointer = getWavePointer(e);
      setZoom((z) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z - e.deltaY * WHEEL_ZOOM_SENSITIVITY));
        skipNextZoomEffectRef.current = true;
        zoomAtPointer(next, pointer);
        return next;
      });
    }
    containerRef.current?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      mounted = false;
      stopShuttle();
      containerRef.current?.removeEventListener('wheel', handleWheel);
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
      regionRef.current = null;
    };
  }, [audioUrl, sourcePath, previewPath, stagedEdit, cutMarkers]);

  useEffect(() => {
    if (skipNextZoomEffectRef.current) {
      skipNextZoomEffectRef.current = false;
      return;
    }
    if (!isLoading) applyWaveZoom(zoom);
  }, [zoom, isLoading]);

  useEffect(() => {
    if (isLoading) return;
    function handleKey(e) {
      const target = e.target;
      if (
        target?.tagName === 'TEXTAREA'
        || target?.tagName === 'INPUT'
        || target?.tagName === 'SELECT'
        || target?.isContentEditable
      ) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (stagedEdit || previewPath) {
          e.preventDefault();
          undoStagedEdit();
        }
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && isKeyboardZoomKey(e)) {
        e.preventDefault();
        const direction = isKeyboardZoomOutKey(e) ? -1 : 1;
        zoomAtCurrentCursor(direction * KEYBOARD_ZOOM_STEP);
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        clearStartPoint();
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        clearEndPoint();
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        if (canOperate) void handleStageAction('trim');
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        if (canCut) void handleStageAction('cut');
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        nudgeWithScrub(-NUDGE_STEP);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nudgeWithScrub(NUDGE_STEP);
      } else if (e.key === 'Home') {
        e.preventDefault();
        stopShuttle();
        setWaveTime(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        stopShuttle();
        setWaveTime(durationRef.current);
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        bumpShuttle(-1);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        stopShuttle();
        wsRef.current?.pause();
        setIsPlaying(false);
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        bumpShuttle(1);
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        if (e.shiftKey) { previewIn(); } else { markStartHere(); }
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        if (e.shiftKey) { previewOut(); } else { markEndHere(); }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isLoading, stagedEdit, previewPath, canOperate, canCut]); // eslint-disable-line react-hooks/exhaustive-deps

  function handlePlayPause() {
    if (shuttleRef.current) {
      stopShuttle();
      return;
    }
    wsRef.current?.playPause();
  }

  function stopPlayback() {
    stopShuttle();
    wsRef.current?.stop();
    setCurrentTime(0);
  }

  function markStartHere() {
    const region = regionRef.current;
    if (!region) return;
    const cur = getCurrentAudioTime();
    const next = parseFloat(Math.max(0, Math.min(cur, region.end - 0.1)).toFixed(3));
    trimStartRef.current = next;
    region.setOptions({ start: next });
    setTrimStart(next);
  }

  function clearStartPoint() {
    const region = regionRef.current;
    if (!region) return;
    trimStartRef.current = 0;
    region.setOptions({ start: 0 });
    setTrimStart(0);
  }

  function markEndHere() {
    const region = regionRef.current;
    if (!region) return;
    const cur = getCurrentAudioTime();
    const next = parseFloat(Math.max(region.start + 0.1, Math.min(cur, durationRef.current)).toFixed(3));
    trimEndRef.current = next;
    region.setOptions({ end: next });
    setTrimEnd(next);
  }

  function clearEndPoint() {
    const region = regionRef.current;
    if (!region) return;
    const end = parseFloat((durationRef.current || duration).toFixed(3));
    trimEndRef.current = end;
    region.setOptions({ end });
    setTrimEnd(end);
  }

  function previewIn() {
    stopShuttle();
    wsRef.current?.play(trimStartRef.current);
  }

  function previewOut() {
    stopShuttle();
    wsRef.current?.play(trimEndRef.current);
  }

  function styleRegionHandles(region, color) {
    window.setTimeout(() => {
      const left = region?.element?.querySelector?.('[part*="region-handle-left"]');
      const right = region?.element?.querySelector?.('[part*="region-handle-right"]');
      if (left) {
        left.style.borderLeftColor = color;
        left.dataset.audioEditorRegionId = region.id ?? '';
        left.dataset.audioEditorHandle = 'left';
      }
      if (right) {
        right.style.borderRightColor = color;
        right.dataset.audioEditorRegionId = region.id ?? '';
        right.dataset.audioEditorHandle = 'right';
      }
    }, 0);
  }

  function clampAudioTime(value) {
    const dur = durationRef.current || 0;
    return Math.max(0, Math.min(Number(value) || 0, dur));
  }

  function setWaveTime(time) {
    const next = clampAudioTime(time);
    wsRef.current?.setTime(next);
    setCurrentTime(next);
    return next;
  }

  function getCurrentAudioTime() {
    if (shuttleRef.current) return currentShuttleTime();
    return clampAudioTime(wsRef.current?.getCurrentTime?.() ?? currentTime);
  }

  function getAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  function createReverseBuffer(buffer) {
    const ctx = getAudioContext();
    if (!ctx || !buffer) return null;
    const reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const input = buffer.getChannelData(channel);
      const output = reversed.getChannelData(channel);
      for (let i = 0, j = input.length - 1; i < input.length; i += 1, j -= 1) {
        output[i] = input[j];
      }
    }
    return reversed;
  }

  function getPlaybackBuffer(direction) {
    const buffer = wsRef.current?.getDecodedData?.();
    if (!buffer) return null;
    if (direction >= 0) return buffer;
    if (!reverseBufferRef.current || reverseBufferRef.current.length !== buffer.length) {
      reverseBufferRef.current = createReverseBuffer(buffer);
    }
    return reverseBufferRef.current;
  }

  function currentShuttleTime() {
    const active = shuttleRef.current;
    const ctx = audioCtxRef.current;
    if (!active) return clampAudioTime(wsRef.current?.getCurrentTime?.() ?? currentTime);
    if (!ctx) return active.startTime;
    const elapsed = Math.max(0, ctx.currentTime - active.startedAt) * active.rate;
    return clampAudioTime(active.startTime + active.direction * elapsed);
  }

  function stopShuttle({ sync = true } = {}) {
    const active = shuttleRef.current;
    if (!active) {
      setShuttleStatus(null);
      return;
    }
    const nextTime = sync ? currentShuttleTime() : active.startTime;
    shuttleRef.current = null;
    if (active.rafId) cancelAnimationFrame(active.rafId);
    try {
      active.source.onended = null;
      active.source.stop();
    } catch (_) {
      // Source may already be stopped by the Web Audio clock.
    }
    try {
      active.source.disconnect();
    } catch (_) {
      // Already disconnected.
    }
    setWaveTime(nextTime);
    setIsPlaying(false);
    setShuttleStatus(null);
  }

  function startBufferPlayback({ direction, rate, startTime, duration: playDuration = null, status = null }) {
    const ctx = getAudioContext();
    const buffer = getPlaybackBuffer(direction);
    if (!ctx || !buffer) {
      setWaveTime(startTime);
      return false;
    }

    stopShuttle({ sync: true });
    wsRef.current?.pause();

    const dur = durationRef.current || buffer.duration;
    const clampedStart = clampAudioTime(startTime);
    const offset = direction >= 0 ? clampedStart : Math.max(0, dur - clampedStart);
    const maxDuration = direction >= 0 ? dur - clampedStart : clampedStart;
    if (maxDuration <= 0.005) {
      setWaveTime(clampedStart);
      return false;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(Math.max(0.25, rate), ctx.currentTime);
    source.connect(ctx.destination);

    const active = {
      source,
      direction,
      rate,
      startTime: clampedStart,
      startedAt: ctx.currentTime,
      rafId: null,
      scrub: playDuration !== null,
    };
    shuttleRef.current = active;
    setIsPlaying(true);
    setShuttleStatus(status);

    const syncCursor = () => {
      if (shuttleRef.current !== active) return;
      const next = currentShuttleTime();
      setWaveTime(next);
      const atEnd = direction >= 0 ? next >= dur - 0.001 : next <= 0.001;
      if (atEnd) {
        stopShuttle({ sync: true });
        return;
      }
      active.rafId = requestAnimationFrame(syncCursor);
    };
    if (!active.scrub) {
      active.rafId = requestAnimationFrame(syncCursor);
    }
    source.onended = () => {
      if (shuttleRef.current === active) stopShuttle({ sync: !active.scrub });
    };
    source.start(0, Math.max(0, Math.min(offset, buffer.duration)), Math.max(0.01, Math.min(playDuration ?? maxDuration, maxDuration)));
    return true;
  }

  function nudgeWithScrub(delta) {
    stopShuttle({ sync: !shuttleRef.current?.scrub });
    const next = setWaveTime(getCurrentAudioTime() + delta);
    startBufferPlayback({
      direction: 1,
      rate: 1,
      startTime: next,
      duration: Math.min(SCRUB_DURATION, Math.max(0.01, (durationRef.current || 0) - next)),
      status: null,
    });
  }

  function bumpShuttle(direction) {
    const active = shuttleRef.current;
    const sameDirection = active && !active.scrub && active.direction === direction;
    const currentRate = sameDirection ? active.rate : 0;
    const currentIndex = SHUTTLE_RATES.findIndex((rate) => rate === currentRate);
    const nextRate = SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, currentIndex + 1)] ?? SHUTTLE_RATES[0];
    const startTime = active ? currentShuttleTime() : getCurrentAudioTime();
    startBufferPlayback({
      direction,
      rate: nextRate,
      startTime,
      status: `${direction > 0 ? 'L' : 'J'} ×${nextRate}`,
    });
  }

  function getWavePointer(e) {
    const ws = wsRef.current;
    const wrapper = ws?.getWrapper?.();
    const scroller = wrapper?.parentElement;
    const fallback = containerRef.current;
    const rect = (scroller ?? wrapper ?? fallback)?.getBoundingClientRect?.();
    const dur = durationRef.current || 0;
    if (!rect || !dur) return null;
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const scroll = ws?.getScroll?.() ?? scroller?.scrollLeft ?? 0;
    const totalWidth = wrapper?.scrollWidth || wrapper?.clientWidth || rect.width;
    const pxPerSec = totalWidth / dur;
    if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return null;
    return {
      x,
      time: Math.max(0, Math.min((scroll + x) / pxPerSec, dur)),
      pxPerSec,
      scroller,
      clientWidth: scroller?.clientWidth ?? rect.width,
    };
  }

  function applyWaveZoom(nextZoom, instance = wsRef.current) {
    if (!instance) return false;
    try {
      if ((instance.getDuration?.() ?? 0) <= 0) return false;
      instance.zoom(nextZoom);
      return true;
    } catch (err) {
      if (!String(err).includes('No audio loaded')) {
        setError(String(err));
      }
      return false;
    }
  }

  function zoomAtPointer(nextZoom, pointer) {
    const ws = wsRef.current;
    if (!ws) return;
    if (!applyWaveZoom(nextZoom, ws)) return;
    if (!pointer) return;
    const dur = durationRef.current || 0;
    const clientWidth = pointer.clientWidth || pointer.scroller?.clientWidth || 0;
    if (!dur || !clientWidth) return;
    if (nextZoom * dur <= clientWidth) {
      ws.setScroll?.(0);
      if (pointer.scroller) pointer.scroller.scrollLeft = 0;
      return;
    }
    const nextScroll = Math.max(0, pointer.time * nextZoom - pointer.x);
    ws.setScroll?.(nextScroll);
    if (pointer.scroller) pointer.scroller.scrollLeft = nextScroll;
  }

  function isKeyboardZoomOutKey(e) {
    return e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract';
  }

  function isKeyboardZoomKey(e) {
    return isKeyboardZoomOutKey(e)
      || e.key === '+'
      || e.key === '='
      || e.code === 'Equal'
      || e.code === 'NumpadAdd';
  }

  function getCursorZoomAnchor() {
    const ws = wsRef.current;
    const wrapper = ws?.getWrapper?.();
    const scroller = wrapper?.parentElement;
    const dur = durationRef.current || 0;
    const current = getCurrentAudioTime();
    const width = scroller?.clientWidth ?? containerRef.current?.clientWidth ?? 0;
    if (!ws || !wrapper || !dur || !width) return null;
    const totalWidth = wrapper.scrollWidth || wrapper.clientWidth || width;
    const pxPerSec = totalWidth / dur;
    const scroll = ws.getScroll?.() ?? scroller?.scrollLeft ?? 0;
    const x = Math.max(0, Math.min(current * pxPerSec - scroll, width));
    return {
      x,
      time: current,
      pxPerSec,
      scroller,
      clientWidth: width,
    };
  }

  function rememberWaveViewport() {
    const ws = wsRef.current;
    const wrapper = ws?.getWrapper?.();
    const scroller = wrapper?.parentElement;
    const dur = durationRef.current || 0;
    const width = scroller?.clientWidth ?? containerRef.current?.clientWidth ?? 0;
    if (!ws || !wrapper || !dur || !width) return;
    const totalWidth = wrapper.scrollWidth || wrapper.clientWidth || width;
    const pxPerSec = totalWidth / dur;
    const scroll = ws.getScroll?.() ?? scroller?.scrollLeft ?? 0;
    const x = width / 2;
    const actualZoom = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : zoom;
    pendingViewportRef.current = {
      zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, actualZoom)),
      x,
      time: clampAudioTime((scroll + x) / pxPerSec),
    };
  }

  function restoreWaveViewport(instance, viewport, fallbackZoom, fallbackWidth = 0) {
    if (!instance || !viewport || !Number.isFinite(viewport.time)) return;
    const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(viewport.zoom ?? fallbackZoom)));
    if (!applyWaveZoom(nextZoom, instance)) return;

    const wrapper = instance.getWrapper?.();
    const scroller = wrapper?.parentElement;
    const dur = durationRef.current || instance.getDuration?.() || 0;
    const width = scroller?.clientWidth ?? fallbackWidth ?? containerRef.current?.clientWidth ?? 0;
    if (!wrapper || !dur || !width) return;

    const totalWidth = Math.max(wrapper.scrollWidth || 0, wrapper.clientWidth || 0, nextZoom * dur);
    const maxScroll = Math.max(0, totalWidth - width);
    const anchorX = Math.max(0, Math.min(Number(viewport.x ?? width / 2), width));
    const nextScroll = Math.max(0, Math.min(maxScroll, viewport.time * nextZoom - anchorX));

    instance.setScroll?.(nextScroll);
    if (scroller) scroller.scrollLeft = nextScroll;
  }

  function zoomAtCurrentCursor(delta) {
    setZoom((z) => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + delta));
      skipNextZoomEffectRef.current = true;
      zoomAtPointer(next, getCursorZoomAnchor());
      return next;
    });
  }

  function undoStagedEdit() {
    wsRef.current?.stop();
    const previousSelection = preStagedSelectionRef.current;
    initialEditRef.current = previousSelection
      ? {
          start: previousSelection.start,
          end: previousSelection.end,
        }
      : null;
    setPreviewPath(null);
    setStagedEdit(null);
    setHasChainedPreview(false);
    setCutMarkers(preStagedCutMarkersRef.current ?? []);
    actionBasePathRef.current = filePath;
    setApplyMode(null);
    setError(null);
  }

  function openFadePopover(target, e) {
    e.preventDefault();
    e.stopPropagation();
    setFadeContextMenu(null);
    const value = target === 'in' ? fadeInSec : target === 'out' ? fadeOutSec : cutFadeSec;
    setFadePopover({
      target,
      x: e.clientX,
      y: e.clientY,
      value,
    });
  }

  function openContextFadePopover(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = fadeContextMenu?.target ?? 'cut';
    const limit = fadeLimit(target);
    const current = currentFadeValue(target);
    const defaultValue = limit > 0 ? Math.min(1, limit) : 0;
    const nextValue = current > 0 ? Math.min(current, limit) : defaultValue;
    const x = fadeContextMenu?.x ?? e.clientX;
    const y = fadeContextMenu?.y ?? e.clientY;
    setFadeValue(target, nextValue);
    setFadeContextMenu(null);
    setFadePopover({
      target,
      x,
      y,
      value: nextValue,
    });
  }

  function handleWaveformContextMenu(e) {
    const target = fadeTargetFromPointer(e);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    setFadePopover(null);
    setFadeContextMenu({
      target,
      x: e.clientX,
      y: e.clientY,
    });
  }

  function handleWaveformClick(e) {
    if (e.button !== 0) return;
    if (!isFadeHandleClick(e)) return;
    const target = fadeTargetFromPointer(e, { existingOnly: true });
    if (!target) return;
    openFadePopover(target, e);
  }

  function isFadeHandleClick(e) {
    const path = e.nativeEvent?.composedPath?.() ?? [];
    return path.some((node) => {
      const regionId = node?.dataset?.audioEditorRegionId ?? '';
      return regionId === 'audio-fade-in-region'
        || regionId === 'audio-fade-out-region'
        || regionId === 'audio-cut-region';
    });
  }

  function currentFadeValue(target) {
    if (target === 'in') return fadeInSec;
    if (target === 'out') return fadeOutSec;
    return cutFadeSec;
  }

  function fadeLimit(target) {
    if (target === 'cut') return cutFadeMax;
    return outputFadeMax;
  }

  function fadeTargetFromPointer(e, { existingOnly = false } = {}) {
    const pointer = getWavePointer(e);
    if (!pointer) return null;
    const dur = durationRef.current || 0;
    const tolerance = Math.max(0.15, 16 / pointer.pxPerSec);
    const candidates = [];
    const addCandidate = (target, point, rangeStart = point, rangeEnd = point, value = 0) => {
      if (existingOnly && value <= 0) return;
      const start = Math.min(rangeStart, rangeEnd) - tolerance;
      const end = Math.max(rangeStart, rangeEnd) + tolerance;
      if (pointer.time < start || pointer.time > end) return;
      const distance = pointer.time >= Math.min(rangeStart, rangeEnd) && pointer.time <= Math.max(rangeStart, rangeEnd)
        ? 0
        : Math.abs(pointer.time - point);
      candidates.push({ target, distance });
    };

    if (previewPath && stagedEdit) {
      const fadeIn = Math.min(fadeInSec, outputFadeMax);
      const fadeOut = Math.min(fadeOutSec, outputFadeMax);
      addCandidate('in', 0, 0, fadeIn > 0 ? fadeIn : 0, fadeIn);
      addCandidate('out', dur, fadeOut > 0 ? Math.max(0, dur - fadeOut) : dur, dur, fadeOut);
      if (stagedEdit.mode === 'cut') {
        const join = Math.max(0, Math.min(Number(stagedEdit.startSec ?? 0), dur));
        const cutFade = Math.min(cutFadeSec, cutFadeMax);
        addCandidate('cut', join, cutFade > 0 ? Math.max(0, join - cutFade) : join, join, cutFade);
      }
    } else if (regionRef.current) {
      const start = trimStartRef.current;
      const end = trimEndRef.current;
      const fadeIn = Math.min(fadeInSec, fadeMax);
      const fadeOut = Math.min(fadeOutSec, fadeMax);
      addCandidate('in', start, start, fadeIn > 0 ? Math.min(end, start + fadeIn) : start, fadeIn);
      addCandidate('out', end, fadeOut > 0 ? Math.max(start, end - fadeOut) : end, end, fadeOut);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].target;
  }

  function setFadeValue(target, value) {
    const next = Number(value);
    const clamped = Math.min(next, fadeLimit(target));
    if (target === 'in') setFadeInSec(clamped);
    if (target === 'out') setFadeOutSec(clamped);
    if (target === 'cut') setCutFadeSec(clamped);
    setFadePopover((popover) => popover ? { ...popover, value: clamped } : popover);
    if (!stagedEdit) {
      setPreviewPath(null);
    }
  }

  function fadeConfig(target) {
    if (target === 'in') {
      return { label: 'Fondu entrée', value: Math.min(fadeInSec, outputFadeMax), max: outputFadeMax };
    }
    if (target === 'out') {
      return { label: 'Fondu sortie', value: Math.min(fadeOutSec, outputFadeMax), max: outputFadeMax };
    }
    return { label: 'Fondu de coupe', value: Math.min(cutFadeSec, cutFadeMax), max: cutFadeMax };
  }

  async function handleFadePopoverOk() {
    stopShuttle();
    const target = fadePopover?.target;
    setFadePopover(null);
    await regenerateFadePreview({}, target);
  }

  async function regenerateFadePreview(overrides = {}, target = null) {
    const fullDuration = durationRef.current || duration;
    if (!fullDuration || fullDuration <= 0) return;
    const edit = {
      ...(stagedEdit ?? {
        mode: 'trim',
        startSec: 0,
        endSec: fullDuration,
        cutFadeSec: 0,
      }),
      fadeInSec: Math.min(overrides.fadeInSec ?? fadeInSec, outputFadeMax),
      fadeOutSec: Math.min(overrides.fadeOutSec ?? fadeOutSec, outputFadeMax),
      cutFadeSec: Math.min(overrides.cutFadeSec ?? cutFadeSec, cutFadeMax),
    };
    rememberWaveViewport();
    setApplyMode('preview');
    setError(null);
    try {
      const sourcePathForPreview = actionBasePathRef.current || filePath;
      const path = await invoke('preview_audio_edit', {
        inputPath: sourcePathForPreview,
        mode: edit.mode,
        startSec: edit.startSec,
        endSec: edit.endSec,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
        fadeInSec: edit.fadeInSec,
        fadeOutSec: edit.fadeOutSec,
        cutFadeSec: edit.cutFadeSec,
      });
      if (target === 'cut') {
        setCutMarkers(markersAfterAction(
          preStagedCutMarkersRef.current ?? [],
          edit.mode,
          edit.startSec,
          edit.endSec,
          edit.cutFadeSec,
        ));
      } else if (!stagedEdit) {
        actionBasePathRef.current = sourcePathForPreview;
        setCutMarkers([]);
      }
      setStagedEdit(edit);
      setPreviewPath(path);
      setApplyMode(null);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  async function handleRestoreOriginal() {
    stopShuttle();
    setApplyMode('restore');
    setError(null);
    try {
      const result = await invoke('restore_audio_original', {
        inputPath: filePath,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
      });
      onConfirm(result.output_path);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  function markersAfterAction(markers, mode, start, end, newCutFadeSec = 0) {
    const selectionStart = Number(start);
    const selectionEnd = Number(end);
    if (!Number.isFinite(selectionStart) || !Number.isFinite(selectionEnd) || selectionEnd <= selectionStart) {
      return markers;
    }
    if (mode === 'trim') {
      return markers
        .filter((marker) => marker.time >= selectionStart && marker.time <= selectionEnd)
        .map((marker) => ({
          ...marker,
          time: Math.max(0, marker.time - selectionStart),
        }));
    }

    if (mode === 'cut') {
      const removedDuration = selectionEnd - selectionStart + Math.max(0, Number(newCutFadeSec) || 0);
      const shifted = markers
        .filter((marker) => marker.time < selectionStart || marker.time > selectionEnd)
        .map((marker) => ({
          ...marker,
          time: marker.time > selectionEnd ? Math.max(0, marker.time - removedDuration) : marker.time,
        }));
      if (selectionStart > 0.01 && selectionEnd < durationRef.current - 0.01) {
        shifted.push({ time: selectionStart, fadeSec: Math.max(0, Number(newCutFadeSec) || 0) });
      }
      return shifted.sort((a, b) => a.time - b.time);
    }

    return markers;
  }

  async function handleStageAction(mode) {
    stopShuttle();
    setApplyMode('preview');
    setError(null);
    const sourcePathForPreview = previewPath || filePath;
    const willChainPreview = !!previewPath || hasChainedPreview;
    const nextCutMarkers = markersAfterAction(cutMarkers, mode, trimStart, trimEnd, 0);
    preStagedCutMarkersRef.current = cutMarkers;
    preStagedSelectionRef.current = {
      start: trimStart,
      end: trimEnd,
    };
    const edit = {
      mode,
      startSec: trimStart,
      endSec: mode === 'cut' && trimEnd >= duration - 0.01 ? 1_000_000 : trimEnd,
      fadeInSec,
      fadeOutSec,
      cutFadeSec: 0,
    };
    try {
      const path = await invoke('preview_audio_edit', {
        inputPath: sourcePathForPreview,
        mode,
        startSec: edit.startSec,
        endSec: edit.endSec,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
        fadeInSec: edit.fadeInSec,
        fadeOutSec: edit.fadeOutSec,
        cutFadeSec: edit.cutFadeSec,
      });
      actionBasePathRef.current = sourcePathForPreview;
      setHasChainedPreview(willChainPreview);
      setCutFadeSec(0);
      setCutMarkers(nextCutMarkers);
      setStagedEdit(edit);
      initialEditRef.current = null;
      setPreviewPath(path);
      setApplyMode(null);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  async function handleApply() {
    if (!stagedEdit) return;
    stopShuttle();
    setApplyMode(stagedEdit.mode);
    setError(null);
    try {
      const result = hasChainedPreview && previewPath
        ? await invoke('commit_audio_preview', {
            inputPath: filePath,
            previewPath,
            savePath: savePath ?? null,
            workspaceDir: workspaceDir ?? null,
          })
        : await invoke('apply_audio_edit', {
            inputPath: filePath,
            mode: stagedEdit.mode,
            startSec: stagedEdit.startSec,
            endSec: stagedEdit.endSec,
            savePath: savePath ?? null,
            workspaceDir: workspaceDir ?? null,
            fadeInSec: stagedEdit.fadeInSec,
            fadeOutSec: stagedEdit.fadeOutSec,
            cutFadeSec: stagedEdit.cutFadeSec,
          });
      onConfirm(result.output_path);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={isApplying ? undefined : onCancel}>
      <div className="modal-box audio-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Éditer l'audio — {filename}</span>
          {shuttleStatus && <span className="audio-editor-shuttle-status">{shuttleStatus}</span>}
          <span className="audio-editor-cursor-time">{formatTime(currentTime)}</span>
          <button className="modal-close" onClick={onCancel} disabled={isApplying}>×</button>
        </div>

        <div className="audio-editor-body">
          {/* Waveform */}
          <div
            className="audio-editor-waveform-wrap"
            onClickCapture={handleWaveformClick}
            onContextMenu={handleWaveformContextMenu}
          >
            {isLoading && (
              <div className="audio-editor-loading">
                {audioUrl ? "Analyse de la forme d'onde…" : 'Chargement du fichier…'}
              </div>
            )}
            <div ref={containerRef} className="audio-editor-waveform" />
          </div>

          {/* Barre d'outils transport */}
          <div className="audio-tb-row">
            <span className="audio-editor-trim-stat" onContextMenu={(e) => openFadePopover('in', e)}>
              Entrée&nbsp;{formatTime(trimStart)}
              <button
                className={`audio-editor-fade-chip${fadeInSec > 0 ? ' is-active' : ''}`}
                onClick={(e) => openFadePopover('in', e)}
                onContextMenu={(e) => openFadePopover('in', e)}
                disabled={isApplying}
              >
                ↗{fadeInSec > 0 ? ` ${formatTime(Math.min(fadeInSec, fadeMax))}` : ''}
              </button>
            </span>
          <div className="audio-tb">
            <Tooltip text="Marquer le point d'entrée à la position du curseur (i)">
              <button className="audio-tb-btn audio-tb-btn-marker" onClick={markStartHere} disabled={isLoading}>{`{`}</button>
            </Tooltip>
            <Tooltip text="Marquer le point de sortie à la position du curseur (o)">
              <button className="audio-tb-btn audio-tb-btn-marker" onClick={markEndHere} disabled={isLoading}>{`}`}</button>
            </Tooltip>

            <div className="audio-tb-sep" />

            <Tooltip text={isPlaying ? 'Pause (Espace)' : 'Play / Pause (Espace)'}>
              <button className={`audio-tb-btn${isPlaying ? ' is-active' : ''}`} onClick={handlePlayPause} disabled={isLoading}>
                {isPlaying ? <Pause /> : <Play />}
              </button>
            </Tooltip>
            <Tooltip text="Stop">
              <button className="audio-tb-btn" onClick={stopPlayback} disabled={isLoading}><Square /></button>
            </Tooltip>
            <Tooltip text="Reculer de 5s">
              <button className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(-SKIP_STEP); }} disabled={isLoading}><SkipBack /></button>
            </Tooltip>
            <Tooltip text="Avancer de 5s">
              <button className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(SKIP_STEP); }} disabled={isLoading}><SkipForward /></button>
            </Tooltip>

            <div className="audio-tb-sep" />

            <Tooltip text="Lire depuis le point d'entrée (Shift+I)">
              <button className="audio-tb-btn audio-tb-btn-text" onClick={previewIn} disabled={isLoading}>|▶</button>
            </Tooltip>
            <Tooltip text="Lire depuis le point de sortie (Shift+O)">
              <button className="audio-tb-btn audio-tb-btn-text" onClick={previewOut} disabled={isLoading}>▶|</button>
            </Tooltip>

            <div className="audio-tb-sep" />

            <Tooltip text="Garder la sélection (Ctrl+G)">
              <button
                className="audio-tb-btn"
                onClick={() => handleStageAction('trim')}
                disabled={!canOperate}
              >
                <Crop />
              </button>
            </Tooltip>
            <Tooltip text="Supprimer la sélection (Ctrl+X)">
              <button
                className="audio-tb-btn audio-tb-btn-danger"
                onClick={() => handleStageAction('cut')}
                disabled={!canCut}
              >
                <Scissors />
              </button>
            </Tooltip>
          </div>
            <span className="audio-editor-trim-stat" onContextMenu={(e) => openFadePopover('out', e)}>
              Sortie&nbsp;{formatTime(trimEnd)}
              <button
                className={`audio-editor-fade-chip${fadeOutSec > 0 ? ' is-active' : ''}`}
                onClick={(e) => openFadePopover('out', e)}
                onContextMenu={(e) => openFadePopover('out', e)}
                disabled={isApplying}
              >
                ↘{fadeOutSec > 0 ? ` ${formatTime(Math.min(fadeOutSec, fadeMax))}` : ''}
              </button>
            </span>
          </div>

          {/* Zoom */}
          <div className="audio-editor-row audio-editor-zoom-row">
            <span className="audio-editor-label">Zoom</span>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={5}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="audio-editor-zoom-slider"
              disabled={isLoading}
            />
            <span className="audio-editor-zoom-val">×{(zoom / 20).toFixed(1)}</span>
            <span className="audio-editor-hint">Ctrl+molette / +/- · ← → 50ms · Début/Fin</span>
          </div>

          {editInfo?.original_available && (
            <div className="audio-editor-restore-row">
              <Tooltip text="Restaurer le fichier avant édition">
                <button className="audio-editor-restore-btn" onClick={handleRestoreOriginal} disabled={isApplying}>
                  <RotateCcw />
                  Restaurer l'original
                </button>
              </Tooltip>
            </div>
          )}

          {error && <div className="audio-editor-error">{error}</div>}
        </div>

        <div className="audio-editor-footer">
          <button className="btn" onClick={onCancel} disabled={isApplying}>Annuler</button>
          <button className="btn btn-primary" onClick={handleApply} disabled={!canValidate}>
            {applyMode === 'trim' || applyMode === 'cut' ? 'Application…' : 'Valider les modifications'}
          </button>
        </div>

        {fadeContextMenu && (
          <div
            className="audio-editor-fade-context-menu"
            style={{ left: fadeContextMenu.x, top: fadeContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button className="audio-editor-fade-context-item" onClick={openContextFadePopover}>
              {currentFadeValue(fadeContextMenu.target) > 0
                ? 'Modifier le fondu'
                : fadeContextMenu.target === 'in'
                  ? 'Ajouter un fondu en entrée'
                  : fadeContextMenu.target === 'out'
                    ? 'Ajouter un fondu en sortie'
                    : 'Ajouter un fondu'}
            </button>
          </div>
        )}

        {fadePopover && (() => {
          const config = fadeConfig(fadePopover.target);
          return (
            <div
              className="audio-editor-fade-popover"
              style={{ left: fadePopover.x, top: fadePopover.y }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="audio-editor-fade-popover-title">{config.label}</div>
              <div className="audio-editor-row">
                <input
                  type="range"
                  min={0}
                  max={config.max}
                  step={0.05}
                  value={config.value}
                  onChange={(e) => setFadeValue(fadePopover.target, e.target.value)}
                  autoFocus
                />
                <span className="audio-editor-zoom-val">{formatTime(config.value)}</span>
              </div>
              <div className="audio-editor-fade-popover-actions">
                <button className="btn btn-xs" onClick={() => setFadeValue(fadePopover.target, 0)}>Retirer</button>
                <button className="btn btn-xs btn-primary" onClick={handleFadePopoverOk}>OK</button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
