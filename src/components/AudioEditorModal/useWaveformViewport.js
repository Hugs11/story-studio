import { useEffect, useRef, useState } from 'react';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  WHEEL_ZOOM_SENSITIVITY,
} from './audioEditorConstants';

// Zoom et viewport de la waveform : molette ancrée au pointeur, zoom clavier
// ancré au curseur de lecture, et mémoire du viewport à travers les
// rechargements audio (chaque preview ffmpeg recrée l'instance WaveSurfer).
export function useWaveformViewport({
  wsRef,
  durationRef,
  containerRef,
  getCurrentAudioTime,
  clampAudioTime,
  isLoading,
  onError,
}) {
  const [zoom, setZoom] = useState(80);
  const skipNextZoomEffectRef = useRef(false);
  const pendingViewportRef = useRef(null);

  useEffect(() => {
    if (skipNextZoomEffectRef.current) {
      skipNextZoomEffectRef.current = false;
      return;
    }
    if (!isLoading) applyWaveZoom(zoom);
  }, [zoom, isLoading]);

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
        onError(String(err));
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

  // À l'événement `ready` d'une nouvelle instance : zoom d'ajustement à la
  // largeur, ou restauration du viewport mémorisé — ré-appliquée après layout
  // (rAF + timeout), le scroll n'étant pas fiable immédiatement.
  function applyReadyViewport(ws, dur, isStillCurrent) {
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
        if (!isStillCurrent()) return;
        restoreWaveViewport(ws, pendingViewport, initialZoom, containerWidth);
      });
      window.setTimeout(() => {
        if (!isStillCurrent()) return;
        restoreWaveViewport(ws, pendingViewport, initialZoom, containerWidth);
      }, 40);
    }
  }

  return {
    zoom,
    setZoom,
    getWavePointer,
    zoomAtCurrentCursor,
    rememberWaveViewport,
    applyReadyViewport,
    handleWheel,
  };
}
