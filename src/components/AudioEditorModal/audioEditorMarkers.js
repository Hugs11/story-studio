// Helpers purs pour la transformation des marqueurs de cut/trim.
// Extrait de AudioEditorModal.jsx pour reduire la surface de l'orchestrateur
// et permettre un test unitaire eventuel.

export function markersAfterAction(markers, mode, start, end, duration, newCutFadeSec = 0) {
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
    const fade = Math.max(0, Number(newCutFadeSec) || 0);
    const removedDuration = selectionEnd - selectionStart + fade;
    const shifted = markers
      .filter((marker) => marker.time < selectionStart || marker.time > selectionEnd)
      .map((marker) => ({
        ...marker,
        time: marker.time > selectionEnd ? Math.max(0, marker.time - removedDuration) : marker.time,
      }));
    const dur = Number(duration) || 0;
    if (selectionStart > 0.01 && selectionEnd < dur - 0.01) {
      shifted.push({ time: selectionStart, fadeSec: fade });
    }
    return shifted.sort((a, b) => a.time - b.time);
  }

  return markers;
}
