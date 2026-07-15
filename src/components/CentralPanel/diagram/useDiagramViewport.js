import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { read } from '../../../store/persistentSettings';
import { logger } from '../../../utils/logger';
import { clampZoom } from '../flowDiagramLayout';
import {
  centerDiagramNode,
  fitDiagramViewport,
  getWheelZoomFactor,
  preserveViewportCenter,
} from './viewportGeometry.js';

const DIAGRAM_PERF_KEY = 'storyStudio.diagramPerf';

function isDiagramPerfEnabled() {
  return read(DIAGRAM_PERF_KEY, { defaultValue: 'false' }) === 'true'
    || globalThis.__STORY_STUDIO_DIAGRAM_PERF__ === true;
}

export function useDiagramViewport({
  onStagePanStart = null,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const zoomValueRef = useRef(null);
  const viewportFrameRef = useRef(null);
  const viewportIdleTimerRef = useRef(null);
  const perfEnabledRef = useRef(isDiagramPerfEnabled());
  const viewportPerfRef = useRef({ wheelEvents: 0, transformFrames: 0, maxWheelDelay: 0, lastWheelAt: 0, lastLogAt: 0 });
  const layoutStatsRef = useRef({ nodes: 0, structureEdges: 0, navigationEdges: 0, groups: 0, width: 0, height: 0 });
  const panStateRef = useRef({ active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0 });
  const hasViewportRef = useRef(false);
  const lastFittedLayoutKeyRef = useRef(null);
  const previousContainerSizeRef = useRef({ width: 0, height: 0 });
  const zoomRef = useRef(1);
  const cameraRef = useRef({ x: 0, y: 0 });
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [isPanning, setIsPanning] = useState(false);

  const compactMode = useMemo(() => {
    if (containerWidth > 0 && containerWidth < 900) return 'minimal';
    if (containerWidth > 0 && containerWidth < 1400) return 'compact';
    return 'full';
  }, [containerWidth]);

  const markViewportMoving = useCallback((kind) => {
    const stage = containerRef.current;
    if (!stage) return;
    stage.classList.add('is-viewport-moving');
    // Le masquage des vignettes ne sert qu'au zoom (re-echantillonnage a chaque
    // echelle) ; au pan (translation) elles restent visibles.
    stage.classList.toggle('is-viewport-zooming', kind === 'zoom');
    if (viewportIdleTimerRef.current != null) {
      window.clearTimeout(viewportIdleTimerRef.current);
    }
    viewportIdleTimerRef.current = window.setTimeout(() => {
      viewportIdleTimerRef.current = null;
      const node = containerRef.current;
      node?.classList.remove('is-viewport-moving');
      node?.classList.remove('is-viewport-zooming');
    }, 140);
  }, []);

  const writeViewportTransform = useCallback(() => {
    viewportFrameRef.current = null;
    const canvas = canvasRef.current;
    const { x, y } = cameraRef.current;
    const currentZoom = zoomRef.current;
    if (canvas) {
      canvas.style.transform = `translate(${x}px, ${y}px) scale(${currentZoom})`;
    }
    if (zoomValueRef.current) {
      zoomValueRef.current.textContent = `${Math.round(currentZoom * 100)}%`;
    }

    if (perfEnabledRef.current) {
      const now = performance.now();
      const perf = viewportPerfRef.current;
      perf.transformFrames += 1;
      if (perf.lastWheelAt) {
        perf.maxWheelDelay = Math.max(perf.maxWheelDelay, now - perf.lastWheelAt);
      }
      if (now - perf.lastLogAt > 1000) {
        logger.warn('diagram:viewport-perf', {
          wheelEvents: perf.wheelEvents,
          transformFrames: perf.transformFrames,
          maxWheelDelayMs: Math.round(perf.maxWheelDelay),
          zoom: Number(currentZoom.toFixed(3)),
          ...layoutStatsRef.current,
        });
        perf.wheelEvents = 0;
        perf.transformFrames = 0;
        perf.maxWheelDelay = 0;
        perf.lastLogAt = now;
      }
    }
  }, []);

  const scheduleViewportTransform = useCallback((immediate = false, moveKind = null) => {
    if (moveKind) markViewportMoving(moveKind);
    if (immediate) {
      if (viewportFrameRef.current != null) {
        cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = null;
      }
      writeViewportTransform();
      return;
    }
    if (viewportFrameRef.current == null) {
      viewportFrameRef.current = requestAnimationFrame(writeViewportTransform);
    }
  }, [markViewportMoving, writeViewportTransform]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const node = containerRef.current;
    const update = () => {
      setContainerWidth(node.clientWidth || 0);
      setContainerHeight(node.clientHeight || 0);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const previousSize = previousContainerSizeRef.current;
    const nextSize = { width: containerWidth, height: containerHeight };
    if (hasViewportRef.current && previousSize.width && previousSize.height) {
      cameraRef.current = preserveViewportCenter(cameraRef.current, previousSize, nextSize);
      scheduleViewportTransform(true);
    }
    previousContainerSizeRef.current = nextSize;
  }, [containerHeight, containerWidth, scheduleViewportTransform]);

  const handleZoom = useCallback((scaleFactor, focusPoint = null) => {
    const node = containerRef.current;
    const currentZoom = zoomRef.current || 1;
    const nextZoom = clampZoom(currentZoom * scaleFactor);
    if (!node || nextZoom === currentZoom) return;

    const clientX = focusPoint?.x ?? (node.clientWidth / 2);
    const clientY = focusPoint?.y ?? (node.clientHeight / 2);
    const currentCamera = cameraRef.current;

    const worldX = (clientX - currentCamera.x) / currentZoom;
    const worldY = (clientY - currentCamera.y) / currentZoom;
    const nextCamera = {
      x: clientX - (worldX * nextZoom),
      y: clientY - (worldY * nextZoom),
    };

    zoomRef.current = nextZoom;
    cameraRef.current = nextCamera;
    hasViewportRef.current = true;
    scheduleViewportTransform(false, 'zoom');
  }, [scheduleViewportTransform]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    function handleWheel(event) {
      const rect = node.getBoundingClientRect();
      const path = event.composedPath?.() ?? [];
      const isInside = path.includes(node) || (
        Number.isFinite(event.clientX)
        && Number.isFinite(event.clientY)
        && event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom
      );
      if (!isInside) return;

      event.preventDefault();
      const scaleFactor = getWheelZoomFactor(event, node.clientHeight);
      if (perfEnabledRef.current) {
        const perf = viewportPerfRef.current;
        perf.wheelEvents += 1;
        perf.lastWheelAt = performance.now();
      }
      handleZoom(scaleFactor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }

    // Capture au niveau fenêtre : WebView2 peut envoyer le pincement trackpad à
    // une couche interne du diagramme, voire laisser un composant l'intercepter
    // avant la remontée vers le stage.
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleWheel, true);
  }, [handleZoom]);

  const updateLayoutStats = useCallback((layout, navigationEdgeCount) => {
    layoutStatsRef.current = {
      nodes: layout.nodes.length,
      structureEdges: layout.edges.length,
      navigationEdges: navigationEdgeCount,
      groups: layout.groups?.length ?? 0,
      width: Math.round(layout.width),
      height: Math.round(layout.height),
    };
    if (perfEnabledRef.current) {
      logger.warn('diagram:layout-stats', layoutStatsRef.current);
    }
  }, []);

  const fitViewportToLayout = useCallback((layout, layoutKey) => {
    if (lastFittedLayoutKeyRef.current === layoutKey) return;
    const fitted = fitDiagramViewport({
      containerWidth,
      containerHeight,
      layoutWidth: layout?.width,
      layoutHeight: layout?.height,
    });
    if (!fitted) return;
    zoomRef.current = fitted.zoom;
    cameraRef.current = fitted.camera;
    scheduleViewportTransform(true);
    hasViewportRef.current = true;
    lastFittedLayoutKeyRef.current = layoutKey;
  }, [containerWidth, containerHeight, scheduleViewportTransform]);

  const centerViewportOnNode = useCallback((node) => {
    const camera = centerDiagramNode({
      containerWidth,
      containerHeight,
      zoom: zoomRef.current,
      node,
    });
    if (!camera) return false;
    cameraRef.current = camera;
    hasViewportRef.current = true;
    scheduleViewportTransform(true, 'pan');
    return true;
  }, [containerHeight, containerWidth, scheduleViewportTransform]);

  useEffect(() => () => {
    if (viewportFrameRef.current != null) {
      cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
    }
    if (viewportIdleTimerRef.current != null) {
      window.clearTimeout(viewportIdleTimerRef.current);
      viewportIdleTimerRef.current = null;
    }
  }, []);

  const stopPanning = useCallback((pointerId) => {
    const node = containerRef.current;
    if (node && pointerId != null && node.hasPointerCapture?.(pointerId)) {
      node.releasePointerCapture(pointerId);
    }
    panStateRef.current = { active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0 };
    setIsPanning(false);
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    const node = containerRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    if (event.target.closest?.('.fd-complete-node, .fd-complete-zoom, .fd-complete-topbar, .fd-diagram-search')) return;
    onStagePanStart?.();
    panStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: cameraRef.current.x,
      cameraY: cameraRef.current.y,
    };
    node.setPointerCapture?.(event.pointerId);
    setIsPanning(true);
    event.preventDefault();
  }, [onStagePanStart]);

  const handlePointerMove = useCallback((event) => {
    const panState = panStateRef.current;
    const node = containerRef.current;
    if (!panState.active || !node) return;
    const deltaX = event.clientX - panState.startX;
    const deltaY = event.clientY - panState.startY;
    cameraRef.current = {
      x: panState.cameraX + deltaX,
      y: panState.cameraY + deltaY,
    };
    scheduleViewportTransform(false, 'pan');
    event.preventDefault();
  }, [scheduleViewportTransform]);

  const handlePointerUp = useCallback((event) => {
    stopPanning(event.pointerId);
  }, [stopPanning]);

  return {
    containerRef,
    canvasRef,
    zoomValueRef,
    zoomRef,
    cameraRef,
    containerWidth,
    containerHeight,
    compactMode,
    isPanning,
    handleZoom,
    updateLayoutStats,
    fitViewportToLayout,
    centerViewportOnNode,
    stagePointerHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onLostPointerCapture: handlePointerUp,
    },
  };
}
