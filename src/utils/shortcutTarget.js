// À qui une frappe est-elle destinée ? La garde commune des raccourcis de surface.
//
// L'arbre, le diagramme et le graphe écoutent le clavier au niveau de la page :
// on y désigne à la souris, et l'auteur n'a aucune raison d'avoir cliqué avant
// de frapper. La contrepartie est de **rendre** les frappes qui ne leur sont
// pas destinées. Chaque surface réécrivait cette règle à sa façon ; elle vit
// désormais ici, une fois.
//
// Deux façons de ne pas être destinataire :
//
// 1. une **modale** est ouverte — éditeur audio ou d'image, préférences,
//    dialogue du graphe. Son `Ctrl+X` coupe de l'audio, pas des nœuds qu'elle
//    recouvre ;
// 2. la frappe va dans un **champ** — la recherche, un nom dans l'inspecteur,
//    une zone éditable. Un `Ctrl+C` y copie du texte, et une lettre s'y tape :
//    le détourner serait un vol de frappe. Un champ hors de la surface compte
//    autant qu'un champ dedans.

import { isModalSurfaceOpen } from './modalSurfaces.js';

const FIELD_TAGS = Object.freeze(['INPUT', 'TEXTAREA', 'SELECT']);

// Une cible qui reçoit du texte. `isContentEditable` couvre les éditeurs riches
// sans qu'on ait à énumérer leurs balises ; `closest` rattrape un élément posé
// dans un champ, quand le DOM est là pour le dire.
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (FIELD_TAGS.includes(tag)) return true;
  if (typeof target.closest === 'function') {
    return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
  }
  return false;
}

// Vrai quand une surface d'édition doit laisser passer cette frappe.
//
// Une frappe déjà **consommée** par une autre surface — l'arbre, qui a le focus,
// avant qu'elle ne remonte jusqu'au document où le diagramme écoute — n'est pas
// traitée une seconde fois par celle-ci.
export function surfaceShortcutsSuspended(event) {
  if (!event || event.defaultPrevented) return true;
  if (typeof document !== 'undefined' && isModalSurfaceOpen()) return true;
  return isEditableTarget(event.target);
}
