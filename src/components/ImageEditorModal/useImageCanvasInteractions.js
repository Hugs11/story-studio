// Hook : gere les interactions souris du canvas d'edition d'image
// (pan via drag, zoom au pointeur via wheel).
// Retourne { handleMouseDown, handleMouseMove, handleMouseUp, handleWheel }
// + le ref interne dragRef expose pour les tests/inspection.

import { useRef } from 'react';
import { CANVAS_W } from './useImageEditor';

export function useImageCanvasInteractions({ transform, setTransform, canvasRef, onDirty }) {
  const dragRef = useRef(null);

  function handleMouseDown(e) {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX - transform.offsetX,
      startY: e.clientY - transform.offsetY,
    };
  }

  function handleMouseMove(e) {
    const dragState = dragRef.current;
    if (!dragState) return;
    const nextOffsetX = e.clientX - dragState.startX;
    const nextOffsetY = e.clientY - dragState.startY;
    onDirty?.();
    setTransform((t) => ({
      ...t,
      offsetX: nextOffsetX,
      offsetY: nextOffsetY,
    }));
  }

  function handleMouseUp() {
    dragRef.current = null;
  }

  // Zoom au pointeur : on garde le pixel sous le curseur fixe pendant le zoom.
  function handleWheel(e) {
    e.preventDefault();
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    if (!rect.width || !Number.isFinite(rect.width)) return;
    const cssScale = rect.width / CANVAS_W; // facteur CSS (ex. 640/320 = 2)
    if (!Number.isFinite(cssScale) || cssScale <= 0) return;
    const cursorX = (e.clientX - rect.left) / cssScale;
    const cursorY = (e.clientY - rect.top) / cssScale;
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    onDirty?.();
    setTransform((t) => {
      const currentScale = Number.isFinite(t.scale) && t.scale > 0 ? t.scale : 1;
      const newScale = Math.max(0.05, Math.min(20, currentScale * factor));
      const ratio = newScale / currentScale;
      if (!Number.isFinite(ratio)) return t;
      return {
        scale: newScale,
        offsetX: cursorX - (cursorX - t.offsetX) * ratio,
        offsetY: cursorY - (cursorY - t.offsetY) * ratio,
      };
    });
  }

  return { handleMouseDown, handleMouseMove, handleMouseUp, handleWheel };
}
