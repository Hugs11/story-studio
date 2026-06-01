// Helpers purs pour la gestion des fondus (fade in / fade out / fade de cut)
// dans la modale d'edition audio. Extraits de AudioEditorModal.jsx.

// Verifie si un click DOM provient d'une poignee de region fade ou cut.
// Utilise composedPath pour traverser les shadow boundaries de wavesurfer.
export function isFadeHandleClick(e) {
  const path = e.nativeEvent?.composedPath?.() ?? [];
  return path.some((node) => {
    const regionId = node?.dataset?.audioEditorRegionId ?? '';
    return regionId === 'audio-fade-in-region'
      || regionId === 'audio-fade-out-region'
      || regionId === 'audio-cut-region';
  });
}

// Selectionne la valeur de fade courante a partir du target ('in', 'out', 'cut').
export function currentFadeValue(target, { fadeInSec, fadeOutSec, cutFadeSec }) {
  if (target === 'in') return fadeInSec;
  if (target === 'out') return fadeOutSec;
  return cutFadeSec;
}

// Limite max selon le target ('cut' a une borne distincte).
export function fadeLimit(target, { outputFadeMax, cutFadeMax }) {
  if (target === 'cut') return cutFadeMax;
  return outputFadeMax;
}

// Config UI (label, value clampe, max) pour le popover.
export function fadeConfig(target, { fadeInSec, fadeOutSec, cutFadeSec, outputFadeMax, cutFadeMax }) {
  if (target === 'in') {
    return { label: 'Fondu entrée', value: Math.min(fadeInSec, outputFadeMax), max: outputFadeMax };
  }
  if (target === 'out') {
    return { label: 'Fondu sortie', value: Math.min(fadeOutSec, outputFadeMax), max: outputFadeMax };
  }
  return { label: 'Fondu de coupe', value: Math.min(cutFadeSec, cutFadeMax), max: cutFadeMax };
}

// Determine le target ('in' / 'out' / 'cut') le plus proche du pointeur dans
// la waveform, parmi les zones existantes (selection editee, preview, ou
// region de coupe stagee). Si existingOnly = true, on ne propose pas un
// fade encore vide.
//
// Inputs :
//   pointer : { time, pxPerSec } depuis getWavePointer
//   ctx :     { durationRef, regionRef, previewPath, stagedEdit, fadeInSec,
//               fadeOutSec, cutFadeSec, outputFadeMax, cutFadeMax, fadeMax,
//               trimStartRef, trimEndRef }
export function fadeTargetFromPointer(pointer, ctx, { existingOnly = false } = {}) {
  if (!pointer) return null;
  const {
    durationRef, regionRef, previewPath, stagedEdit,
    fadeInSec, fadeOutSec, cutFadeSec,
    outputFadeMax, cutFadeMax, fadeMax,
    trimStartRef, trimEndRef,
  } = ctx;

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
