import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { read, remove, write } from '../store/persistentSettings.js';

const SIMULATOR_ASPECT_RATIO = 0.62;

const DEFAULTS = {
  aspectRatio: SIMULATOR_ASPECT_RATIO,
  minWidth: 360,
  maxWidth: 760,
  hostPadding: 24,
  panelClass: 'floating-simulator',
};

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function decodeFloatingSimulatorGeometry(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw);
    if (!finiteNumber(value?.x) || value.x < 0
      || !finiteNumber(value?.y) || value.y < 0
      || !finiteNumber(value?.width) || value.width <= 0) return null;
    return { x: value.x, y: value.y, width: value.width };
  } catch {
    return null;
  }
}

export function encodeFloatingSimulatorGeometry(geometry) {
  return JSON.stringify({ x: geometry.x, y: geometry.y, width: geometry.width });
}

export function clampFloatingSimulatorGeometry(geometry, hostSize, options = {}) {
  const { aspectRatio, minWidth, maxWidth, hostPadding } = { ...DEFAULTS, ...options };
  // `hostPadding` est la marge totale historique utilisée par le geste de
  // redimensionnement, pas une marge appliquée sur chacun des deux côtés.
  // Le recalage d'une valeur relue doit employer exactement la même borne,
  // sinon fermer puis rouvrir réduit une fenêtre pourtant valide.
  const availableWidth = Math.max(1, hostSize.width - hostPadding);
  const availableHeight = Math.max(1, hostSize.height - hostPadding);
  const maximumWidth = Math.max(1, Math.min(maxWidth, availableWidth, availableHeight / aspectRatio));
  const minimumWidth = Math.min(minWidth, maximumWidth);
  const width = Math.round(Math.max(minimumWidth, Math.min(maximumWidth, geometry.width)));
  const height = Math.round(width * aspectRatio);
  const maxX = Math.max(0, hostSize.width - width);
  const maxY = Math.max(0, hostSize.height - height);
  return {
    x: Math.round(Math.max(0, Math.min(maxX, geometry.x))),
    y: Math.round(Math.max(0, Math.min(maxY, geometry.y))),
    width,
    height,
  };
}

export function useFloatingSimulator(hostSelector, options = {}) {
  const {
    aspectRatio, minWidth, maxWidth, hostPadding, panelClass, storageKey = null, active = false,
  } = { ...DEFAULTS, ...options };
  const initialGeometryRef = useRef(null);
  if (initialGeometryRef.current === null) {
    initialGeometryRef.current = storageKey
      ? (decodeFloatingSimulatorGeometry(read(storageKey)) ?? false)
      : false;
  }
  const initialGeometry = initialGeometryRef.current || null;
  const [position, setPosition] = useState(
    () => initialGeometry ? { x: initialGeometry.x, y: initialGeometry.y } : null,
  );
  const [size, setSize] = useState(
    () => initialGeometry
      ? { width: initialGeometry.width, height: initialGeometry.width * aspectRatio }
      : null,
  );
  const panelRef = useRef(null);
  const dragRef = useRef(null);
  const geometryRef = useRef(initialGeometry);

  const persistGeometry = useCallback(() => {
    if (storageKey && geometryRef.current) {
      write(storageKey, encodeFloatingSimulatorGeometry(geometryRef.current));
    }
  }, [storageKey]);

  const reset = useCallback(() => {
    geometryRef.current = null;
    setPosition(null);
    setSize(null);
    if (storageKey) remove(storageKey);
  }, [storageKey]);

  const resolveHost = useCallback((event) => {
    const panel = panelRef.current ?? event.currentTarget.closest(`.${panelClass}`);
    const host = hostSelector ? panel?.closest(hostSelector) : panel?.parentElement;
    return { panel, host };
  }, [hostSelector, panelClass]);

  useLayoutEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    const geometry = geometryRef.current;
    if (!panel || !geometry) return;
    const host = hostSelector ? panel.closest(hostSelector) : panel.parentElement;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const fitted = clampFloatingSimulatorGeometry(
      geometry,
      { width: hostRect.width, height: hostRect.height },
      { aspectRatio, minWidth, maxWidth, hostPadding },
    );
    const nextGeometry = { x: fitted.x, y: fitted.y, width: fitted.width };
    const changed = nextGeometry.x !== geometry.x
      || nextGeometry.y !== geometry.y
      || nextGeometry.width !== geometry.width;
    geometryRef.current = nextGeometry;
    setPosition((current) => (
      current?.x === fitted.x && current?.y === fitted.y
        ? current
        : { x: fitted.x, y: fitted.y }
    ));
    setSize((current) => (
      current?.width === fitted.width && current?.height === fitted.height
        ? current
        : { width: fitted.width, height: fitted.height }
    ));
    if (changed) persistGeometry();
  }, [active, aspectRatio, hostPadding, hostSelector, maxWidth, minWidth, persistGeometry]);

  const beginDrag = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    const { panel, host } = resolveHost(event);
    if (!panel || !host) return;

    const panelRect = panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
      hostRect,
      panelWidth: panelRect.width,
      panelHeight: panelRect.height,
    };

    function onMove(moveEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const maxX = Math.max(0, drag.hostRect.width - drag.panelWidth);
      const maxY = Math.max(0, drag.hostRect.height - drag.panelHeight);
      const x = Math.max(0, Math.min(maxX, moveEvent.clientX - drag.hostRect.left - drag.offsetX));
      const y = Math.max(0, Math.min(maxY, moveEvent.clientY - drag.hostRect.top - drag.offsetY));
      setPosition({ x, y });
      geometryRef.current = { x, y, width: drag.panelWidth };
      persistGeometry();
    }

    function onUp() {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      persistGeometry();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [persistGeometry, resolveHost]);

  const beginResize = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    const { panel, host } = resolveHost(event);
    if (!panel || !host) return;

    const panelRect = panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const startWidth = panelRect.width;
    const startX = event.clientX;
    const startY = event.clientY;
    const minHeight = minWidth * aspectRatio;
    const boundedMaxWidth = Math.min(
      maxWidth,
      Math.max(minWidth, hostRect.width - hostPadding),
      Math.max(minHeight, hostRect.height - hostPadding) / aspectRatio,
    );
    const currentX = position?.x ?? (panelRect.left - hostRect.left);
    const currentY = position?.y ?? (panelRect.top - hostRect.top);

    function onMove(moveEvent) {
      const diagonalDelta = Math.max(moveEvent.clientX - startX, (moveEvent.clientY - startY) / aspectRatio);
      const nextWidth = Math.max(minWidth, Math.min(boundedMaxWidth, startWidth + diagonalDelta));
      const nextHeight = nextWidth * aspectRatio;
      setSize({ width: nextWidth, height: nextHeight });
      setPosition({
        x: Math.max(0, Math.min(Math.max(0, hostRect.width - nextWidth), currentX)),
        y: Math.max(0, Math.min(Math.max(0, hostRect.height - nextHeight), currentY)),
      });
      geometryRef.current = {
        x: Math.max(0, Math.min(Math.max(0, hostRect.width - nextWidth), currentX)),
        y: Math.max(0, Math.min(Math.max(0, hostRect.height - nextHeight), currentY)),
        width: nextWidth,
      };
      persistGeometry();
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      persistGeometry();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [resolveHost, position, minWidth, maxWidth, hostPadding, aspectRatio, persistGeometry]);

  return { position, size, panelRef, beginDrag, beginResize, reset };
}
