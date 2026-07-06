// Convention de détection des surfaces modales (plan 21).
//
// Une surface modale ouverte suspend les raccourcis globaux. Sont reconnues :
// les trois conventions d'overlay de l'app (portail commun `app-modal-overlay`,
// modales artisanales `modal-overlay`, dialogues `dialog-overlay`) et le
// marqueur `data-modal-surface` pour les overlays qui ne peuvent pas porter ces
// classes (styles inline dédiés). Toute nouvelle modale doit rentrer dans l'une
// de ces conventions. Le diagramme complet reste une surface d'édition :
// volontairement hors liste.
const MODAL_SURFACE_SELECTOR = '.app-modal-overlay, .modal-overlay, .dialog-overlay, [data-modal-surface]';

export function isModalSurfaceOpen() {
  return !!document.querySelector(MODAL_SURFACE_SELECTOR);
}
