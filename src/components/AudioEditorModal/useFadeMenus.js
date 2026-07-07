import { useEffect, useState } from 'react';
import {
  currentFadeValue as currentFadeValuePure,
  fadeConfig as fadeConfigPure,
  fadeLimit as fadeLimitPure,
  fadeTargetFromPointer as fadeTargetFromPointerPure,
  isFadeHandleClick,
} from './fadeUtils';

// UI des fondus : popover de réglage et menu contextuel (clic droit sur la
// waveform), ouverture depuis les poignées/chips, et application de la valeur
// choisie via la régénération de preview.
export function useFadeMenus({
  fadeInSec,
  fadeOutSec,
  cutFadeSec,
  setFadeInSec,
  setFadeOutSec,
  setCutFadeSec,
  fadeMax,
  outputFadeMax,
  cutFadeMax,
  stagedEdit,
  previewPath,
  discardPreviewPath,
  regenerateFadePreview,
  stopShuttle,
  getWavePointer,
  durationRef,
  regionRef,
  trimStartRef,
  trimEndRef,
}) {
  const [fadePopover, setFadePopover] = useState(null);
  const [fadeContextMenu, setFadeContextMenu] = useState(null);

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

  function setFadeValue(target, value) {
    const next = Number(value);
    const clamped = Math.min(next, fadeLimit(target));
    if (target === 'in') setFadeInSec(clamped);
    if (target === 'out') setFadeOutSec(clamped);
    if (target === 'cut') setCutFadeSec(clamped);
    setFadePopover((popover) => popover ? { ...popover, value: clamped } : popover);
    if (!stagedEdit) {
      discardPreviewPath();
    }
  }

  async function handleFadePopoverOk() {
    stopShuttle();
    const target = fadePopover?.target;
    setFadePopover(null);
    await regenerateFadePreview({}, target);
  }

  return {
    fadePopover,
    fadeContextMenu,
    currentFadeValue,
    fadeConfig,
    openFadePopover,
    openContextFadePopover,
    handleWaveformContextMenu,
    handleWaveformClick,
    setFadeValue,
    handleFadePopoverOk,
  };
}
