// Ce que le simulateur calcule lui-même — et il n'en reste que deux choses.
//
// Ce module portait la navigation de l'arbre du mode Libre : cibles de retour,
// volet Home des messages de fin, séquences, `next_story`. Elle a disparu avec
// le lecteur d'arbre : le simulateur joue désormais le **graphe produit par le
// générateur**, dans les trois modes d'édition. Cette navigation-là n'est plus
// redérivée en JavaScript, elle est projetée par Rust.
//
// Le miroir `store/generatedNavigation.js` reste, lui : il sert l'arbre, le
// diagramme et les éditeurs, qui doivent montrer ce que la production fera
// **avant** de la lancer. Il n'a simplement plus de consommateur côté lecture.

export function getCircularSelectionIndex(currentIndex, direction, itemCount) {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return currentIndex;
  return ((currentIndex + direction) % itemCount + itemCount) % itemCount;
}

export function formatPlaybackTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const rounded = Math.floor(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
