import { useCallback, useRef, useState } from 'react';

export const SIMULATOR_ASPECT_RATIO = 0.62;

const DEFAULTS = {
  aspectRatio: SIMULATOR_ASPECT_RATIO,
  minWidth: 360,
  maxWidth: 760,
  hostPadding: 24,
  panelClass: 'floating-simulator',
};

export function useFloatingSimulator(hostSelector, options = {}) {
  const { aspectRatio, minWidth, maxWidth, hostPadding, panelClass } = { ...DEFAULTS, ...options };
  const [position, setPosition] = useState(null);
  const [size, setSize] = useState(null);
  const dragRef = useRef(null);

  const reset = useCallback(() => {
    setPosition(null);
    setSize(null);
  }, []);

  const resolveHost = useCallback((event) => {
    const panel = event.currentTarget.closest(`.${panelClass}`);
    const host = hostSelector ? panel?.closest(hostSelector) : panel?.parentElement;
    return { panel, host };
  }, [hostSelector, panelClass]);

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
    }

    function onUp() {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [resolveHost]);

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
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [resolveHost, position, minWidth, maxWidth, hostPadding, aspectRatio]);

  return { position, size, beginDrag, beginResize, reset };
}
