import { useRef, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { useLocalFile } from '../../hooks/useLocalFile';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Play, Pause, Square, SkipBack, SkipForward, Scissors, RotateCcw, Crop } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { basename } from '../../utils/fileUtils';
import {
  NUDGE_STEP,
  SKIP_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
  WHEEL_ZOOM_SENSITIVITY,
  KEYBOARD_ZOOM_STEP,
  formatTime,
} from './audioEditorConstants';
import { markersAfterAction } from './audioEditorMarkers';
import { createAudioEditorWaveformOptions, styleRegionHandles } from './audioEditorWaveform';
import {
  currentFadeValue as currentFadeValuePure,
  fadeConfig as fadeConfigPure,
  fadeLimit as fadeLimitPure,
  fadeTargetFromPointer as fadeTargetFromPointerPure,
  isFadeHandleClick,
} from './fadeUtils';
import { useAudioEditorShortcuts } from './useAudioEditorShortcuts';
import { useShuttlePlayback } from './useShuttlePlayback';
import './AudioEditorModal.css';

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
  const auditionEndRef = useRef(null);

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
  const [isLoading, setIsLoading] = useState(true);
  const [applyMode, setApplyMode] = useState(null); // 'trim' | 'cut' | 'preview' | 'restore' | null
  const [error, setError] = useState(null);

  const {
    shuttleRef,
    currentTime,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    shuttleStatus,
    clampAudioTime,
    setWaveTime,
    getCurrentAudioTime,
    stopShuttle,
    nudgeWithScrub,
    bumpShuttle,
    resetReverseBuffer,
  } = useShuttlePlayback({ wsRef, durationRef });

  const isApplying = applyMode !== null;
  const isPreviewingEdit = !!previewPath;
  const filename = basename(filePath);
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

  // reason: ces 5 deps changent en pratique TOUJOURS EN GROUPE -- chaque
  // mutation de stagedEdit / cutMarkers / previewPath passe par
  // regenerateFadePreview ou handleStageAction qui appelle
  // invoke('preview_audio_edit', ...) -> setPreviewPath(newPath) -> audioUrl
  // change. Le re-decode audio est donc inherent au workflow (le user
  // bouge un fade -> ffmpeg regenere un preview -> waveform recharge).
  // Lot 11 P3 : analyse approfondie a montre que separer en 2 useEffects
  // coordonnes via wsReady ne procurerait aucun gain pratique. On garde
  // le pattern actuel ; la presence des 5 deps est une securite pour
  // les cas hypothetiques ou stagedEdit/cutMarkers changerait sans
  // changement audio.
  useEffect(() => {
    if (!audioUrl || !containerRef.current) return;

    let mounted = true;
    const wsRegions = RegionsPlugin.create();
    setIsLoading(true);
    setError(null);
    wsRef.current = null;
    resetReverseBuffer();

    const ws = WaveSurfer.create(createAudioEditorWaveformOptions({
      container: containerRef.current,
      url: audioUrl,
      plugins: [wsRegions],
    }));

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
    ws.on('pause', () => {
      if (!mounted) return;
      setIsPlaying(false);
      if (auditionEndRef.current !== null) {
        auditionEndRef.current = null;
      }
    });
    ws.on('finish', () => {
      if (!mounted) return;
      setIsPlaying(false);
      auditionEndRef.current = null;
    });
    ws.on('timeupdate', (t) => {
      if (!mounted) return;
      const auditionEnd = auditionEndRef.current;
      if (auditionEnd !== null && t >= auditionEnd - 0.01) {
        auditionEndRef.current = null;
        ws.pause();
        ws.setTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        setCurrentTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        return;
      }
      setCurrentTime(t);
    });

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
      auditionEndRef.current = null;
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

  useAudioEditorShortcuts({
    isLoading,
    canOperate,
    canCut,
    stagedEdit,
    previewPath,
    actions: {
      undo: undoStagedEdit,
      zoomIn: () => zoomAtCurrentCursor(KEYBOARD_ZOOM_STEP),
      zoomOut: () => zoomAtCurrentCursor(-KEYBOARD_ZOOM_STEP),
      clearStart: clearStartPoint,
      clearEnd: clearEndPoint,
      trimSelection: () => { void handleStageAction('trim'); },
      cutSelection: () => { void handleStageAction('cut'); },
      playPause: handlePlayPause,
      nudgeBack: () => nudgeWithScrub(-NUDGE_STEP),
      nudgeForward: () => nudgeWithScrub(NUDGE_STEP),
      goToStart: () => { stopShuttle(); setWaveTime(0); },
      goToEnd: () => { stopShuttle(); setWaveTime(durationRef.current); },
      shuttleBack: () => bumpShuttle(-1),
      shuttleStop: () => { stopShuttle(); wsRef.current?.pause(); setIsPlaying(false); },
      shuttleForward: () => bumpShuttle(1),
      markStart: markStartHere,
      markEnd: markEndHere,
      previewIn: goToTrimStart,
      previewOut: goToTrimEnd,
    },
  });

  function handlePlayPause() {
    if (shuttleRef.current) {
      stopShuttle();
      return;
    }
    wsRef.current?.playPause();
  }

  function stopPlayback() {
    auditionEndRef.current = null;
    stopShuttle();
    wsRef.current?.stop();
    setCurrentTime(0);
  }

  function previewSelectionRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const dur = durationRef.current || duration;
    const safeStart = Math.max(0, Math.min(start, dur));
    const safeEnd = Math.max(safeStart, Math.min(end, dur));
    stopShuttle();
    auditionEndRef.current = safeEnd;
    setWaveTime(safeStart);
    void wsRef.current?.play();
  }

  function previewCurrentSelection() {
    previewSelectionRange(trimStartRef.current, trimEndRef.current);
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

  function goToTrimStart() {
    stopShuttle();
    setWaveTime(trimStartRef.current);
  }

  function goToTrimEnd() {
    stopShuttle();
    setWaveTime(trimEndRef.current);
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

  const currentFadeValue = (target) => currentFadeValuePure(target, { fadeInSec, fadeOutSec, cutFadeSec });
  const fadeLimit = (target) => fadeLimitPure(target, { outputFadeMax, cutFadeMax });
  const fadeConfig = (target) => fadeConfigPure(target, { fadeInSec, fadeOutSec, cutFadeSec, outputFadeMax, cutFadeMax });

  function fadeTargetFromPointer(e, options = {}) {
    return fadeTargetFromPointerPure(
      getWavePointer(e),
      {
        durationRef, regionRef, previewPath, stagedEdit,
        fadeInSec, fadeOutSec, cutFadeSec,
        outputFadeMax, cutFadeMax, fadeMax,
        trimStartRef, trimEndRef,
      },
      options,
    );
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
          durationRef.current,
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
      await invoke('restore_audio_original', {
        inputPath: filePath,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
      });
      // Le chemin ne change pas (le fichier est ecrase par la copie de
      // l'original) -- on reset l'etat d'edition et on force useLocalFile a
      // relire (le mtime a change).
      setPreviewPath(null);
      setStagedEdit(null);
      setEditInfo(null);
      setHasChainedPreview(false);
      setCutMarkers([]);
      setFadeInSec(0);
      setFadeOutSec(0);
      setCutFadeSec(0);
      actionBasePathRef.current = filePath;
      preStagedSelectionRef.current = null;
      preStagedCutMarkersRef.current = [];
      initialEditRef.current = null;
      window.dispatchEvent(new Event('focus'));
      setApplyMode(null);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  async function handleStageAction(mode) {
    stopShuttle();
    setApplyMode('preview');
    setError(null);
    const sourcePathForPreview = previewPath || filePath;
    const willChainPreview = !!previewPath || hasChainedPreview;
    const nextCutMarkers = markersAfterAction(cutMarkers, mode, trimStart, trimEnd, durationRef.current, 0);
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
      onConfirm(result);
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
          <Button variant="icon" className="modal-close" onClick={onCancel} disabled={isApplying}>×</Button>
        </div>

        <div className="audio-editor-body">
          <div className="audio-editor-time-row">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
            {shuttleStatus && <span className="audio-editor-shuttle-status">{shuttleStatus}</span>}
          </div>

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
          <div className="audio-tb-row audio-editor-controls-row">
            <div className="audio-editor-fade-slot is-left">
              <Tooltip text={fadeInSec > 0 ? `Fondu entrée ${formatTime(Math.min(fadeInSec, fadeMax))}` : 'Ajouter un fondu en entrée'}>
                <Button
                  variant="icon"
                  className={`audio-tb-btn audio-editor-fade-chip${fadeInSec > 0 ? ' is-active' : ''}`}
                  onClick={(e) => openFadePopover('in', e)}
                  onContextMenu={(e) => openFadePopover('in', e)}
                  disabled={isApplying}
                >
                  ↗
                </Button>
              </Tooltip>
            </div>
            <div className="audio-tb">
              <Tooltip text="Marquer le point d'entrée à la position du curseur (i)">
                <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={markStartHere} disabled={isLoading}>{`{`}</Button>
              </Tooltip>
              <Tooltip text="Marquer le point de sortie à la position du curseur (o)">
                <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={markEndHere} disabled={isLoading}>{`}`}</Button>
              </Tooltip>

              <div className="audio-tb-sep" />

              <Tooltip text={isPlaying ? 'Pause (Espace)' : 'Play / Pause (Espace)'}>
                <Button variant="icon" className={`audio-tb-btn${isPlaying ? ' is-active' : ''}`} onClick={handlePlayPause} disabled={isLoading}>
                  {isPlaying ? <Pause /> : <Play />}
                </Button>
              </Tooltip>
              <Tooltip text="Stop">
                <Button variant="icon" className="audio-tb-btn" onClick={stopPlayback} disabled={isLoading}><Square /></Button>
              </Tooltip>
              <Tooltip text="Reculer de 5s">
                <Button variant="icon" className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(-SKIP_STEP); }} disabled={isLoading}><SkipBack /></Button>
              </Tooltip>
              <Tooltip text="Avancer de 5s">
                <Button variant="icon" className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(SKIP_STEP); }} disabled={isLoading}><SkipForward /></Button>
              </Tooltip>

              <div className="audio-tb-sep" />

              <Tooltip text="Aller au point d'entrée (Shift+I)">
                <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={goToTrimStart} disabled={isLoading}>|▶</Button>
              </Tooltip>
              <Tooltip text="Aller au point de sortie (Shift+O)">
                <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={goToTrimEnd} disabled={isLoading}>▶|</Button>
              </Tooltip>

              <div className="audio-tb-sep" />

              <Tooltip text="Garder la sélection (Ctrl+K)">
                <Button
                  variant="icon"
                  className="audio-tb-btn"
                  onClick={() => handleStageAction('trim')}
                  disabled={!canOperate}
                >
                  <Crop />
                </Button>
              </Tooltip>
              <Tooltip text="Supprimer la sélection (Ctrl+X)">
                <Button
                  variant="icon"
                  className="audio-tb-btn audio-tb-btn-danger"
                  onClick={() => handleStageAction('cut')}
                  disabled={!canCut}
                >
                  <Scissors />
                </Button>
              </Tooltip>
            </div>
            <div className="audio-editor-fade-slot is-right">
              <Tooltip text={fadeOutSec > 0 ? `Fondu sortie ${formatTime(Math.min(fadeOutSec, fadeMax))}` : 'Ajouter un fondu en sortie'}>
                <Button
                  variant="icon"
                  className={`audio-tb-btn audio-editor-fade-chip${fadeOutSec > 0 ? ' is-active' : ''}`}
                  onClick={(e) => openFadePopover('out', e)}
                  onContextMenu={(e) => openFadePopover('out', e)}
                  disabled={isApplying}
                >
                  ↘
                </Button>
              </Tooltip>
            </div>
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

          <section className="audio-editor-selection">
            <div className="audio-editor-selection-stats">
              <span>Entrée <strong>{formatTime(trimStart)}</strong></span>
              <span>Sortie <strong>{formatTime(trimEnd)}</strong></span>
              <span>Durée <strong>{formatTime(trimDuration)}</strong></span>
            </div>
            <Button
              className="audio-editor-preview-btn"
              onClick={previewCurrentSelection}
              disabled={!canOperate || applyMode === 'preview'}
            >
              Prévisualiser l'extrait
            </Button>
          </section>

          {editInfo?.original_available && (
            <div className="audio-editor-restore-row">
              <Tooltip text="Restaurer le fichier avant édition">
                <Button size="sm" className="audio-editor-restore-btn" onClick={handleRestoreOriginal} disabled={isApplying}>
                  <RotateCcw />
                  Restaurer l'original
                </Button>
              </Tooltip>
            </div>
          )}

          {error && <div className="audio-editor-error">{error}</div>}
        </div>

        <div className="audio-editor-footer">
          <Button onClick={onCancel} disabled={isApplying}>Annuler</Button>
          <Tooltip text={canValidate ? 'Valider les modifications' : 'Aucune modification à valider'} placement="above">
            <Button variant="primary" onClick={handleApply} disabled={!canValidate}>
              {applyMode === 'trim' || applyMode === 'cut'
                ? 'Application…'
                : canValidate
                  ? 'Valider les modifications'
                  : 'Aucune modification'}
            </Button>
          </Tooltip>
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
                <Button size="sm" onClick={() => setFadeValue(fadePopover.target, 0)}>Retirer</Button>
                <Button size="sm" variant="primary" onClick={handleFadePopoverOk}>OK</Button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
