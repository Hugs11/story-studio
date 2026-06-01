// Constantes et helpers purs partages par la modale d'edition audio.
// Extrait de AudioEditorModal.jsx pour reduire la surface du composant orchestrateur.

export const NUDGE_STEP = 0.05;
export const SKIP_STEP = 5;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 600;
export const WHEEL_ZOOM_SENSITIVITY = 0.04;
export const KEYBOARD_ZOOM_STEP = 12;
export const SCRUB_DURATION = 0.06;
export const SHUTTLE_RATES = [1, 2, 4, 8];

export function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const cc = String(cs).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${cc}` : `${mm}:${ss}.${cc}`;
}
