// L'historique des révélations volontaires : Précédent et Suivant.
//
// Ce n'est **pas** l'annulation d'édition, et les deux ne doivent jamais se
// mélanger. Défaire un geste rend un document ; revenir en arrière dans cet
// historique ne touche à rien — c'est un déplacement de lecture. Un auteur qui
// a suivi cinq liens puis corrige une faute ne veut pas que son Précédent
// défasse la correction, ni que son annulation le ramène cinq nœuds en amont.
//
// **Ce qui entre ici**, et rien d'autre : une recherche validée, un clic sur une
// connexion, une commande de révélation. **Ce qui n'y entre pas** : les images
// de caméra, le survol, les flèches de la liste de résultats — qui déplacent le
// focus de liste sans bouger la caméra — et les pas automatiques d'une
// simulation. Enregistrer ces quatre-là remplirait l'historique de bruit que
// personne n'a demandé, et Précédent ne ramènerait plus nulle part.
//
// Module pur : aucune dépendance à React, au moteur ni à la session de vue. Il
// range des visites et dit laquelle vient ensuite ; le cadrage est **rendu** à
// l'appelant, qui seul possède la caméra. Il n'en crée pas une seconde.

const EMPTY = Object.freeze({ visits: Object.freeze([]), position: -1 });

export function createRevealHistory() {
  return EMPTY;
}

// Une visite : le nœud révélé et le cadrage d'où on le regardait.
//
// Le cadrage est mémorisé **à l'instant de la révélation**, pas suivi en
// continu : c'est ce qui distingue « se souvenir d'où on regardait » de
// « enregistrer chaque image de caméra ».
function visitOf(path, viewport) {
  return Object.freeze({
    path,
    viewport: viewport ? Object.freeze({ ...viewport }) : null,
  });
}

// Enregistre une révélation.
//
// Deux règles de navigation ordinaire :
//
// - **une visite identique à la courante ne s'empile pas.** Révéler deux fois
//   le même nœud — un double clic, un clic sur le résultat déjà affiché — ne
//   doit pas obliger à appuyer deux fois sur Précédent pour bouger d'un cran.
// - **une nouvelle visite après Précédent coupe la suite.** C'est le
//   comportement d'un historique de navigation : repartir d'un point du passé
//   abandonne le futur qu'on venait de quitter.
export function recordVisit(history, path, viewport = null) {
  if (typeof path !== 'string' || path === '') return history;
  const current = currentVisit(history);
  if (current?.path === path) {
    // Le nœud est le même ; on garde le cadrage le plus récent, qui est celui
    // d'où l'auteur le regarde maintenant.
    const visits = history.visits.slice();
    visits[history.position] = visitOf(path, viewport ?? current.viewport);
    return Object.freeze({ visits: Object.freeze(visits), position: history.position });
  }
  const kept = history.visits.slice(0, history.position + 1);
  kept.push(visitOf(path, viewport));
  return Object.freeze({ visits: Object.freeze(kept), position: kept.length - 1 });
}

export function currentVisit(history) {
  return history.visits[history.position] ?? null;
}

export function canGoBack(history) {
  return history.position > 0;
}

export function canGoForward(history) {
  return history.position >= 0 && history.position < history.visits.length - 1;
}

// Reculer, ou avancer. Rend l'historique déplacé **et** la visite à restaurer,
// pour que l'appelant n'ait pas à relire la position lui-même.
//
// Le déplacement ne doit **pas** être réenregistré : un Précédent qui
// s'empilerait comme une nouvelle visite rendrait Suivant inatteignable.
export function goBack(history) {
  if (!canGoBack(history)) return { history, visit: null };
  const position = history.position - 1;
  return { history: Object.freeze({ ...history, position }), visit: history.visits[position] };
}

export function goForward(history) {
  if (!canGoForward(history)) return { history, visit: null };
  const position = history.position + 1;
  return { history: Object.freeze({ ...history, position }), visit: history.visits[position] };
}

// Écarte les visites dont la cible n'existe plus, en conservant la place de
// l'auteur dans ce qui reste.
//
// Une cible supprimée n'est pas une erreur : c'est la vie d'un document en
// cours d'édition. Elle est retirée **proprement** — sans laisser un Précédent
// qui ne mène nulle part, et sans vider l'historique entier pour un nœud.
export function pruneMissing(history, exists) {
  if (history.visits.length === 0) return history;
  const kept = [];
  let position = -1;
  for (const [rank, visit] of history.visits.entries()) {
    if (!exists(visit.path)) continue;
    kept.push(visit);
    // La position suit le dernier survivant à gauche de l'ancienne position,
    // ou le premier survivant si tout ce qui la précédait a disparu.
    if (rank <= history.position) position = kept.length - 1;
  }
  if (kept.length === 0) return EMPTY;
  return Object.freeze({
    visits: Object.freeze(kept),
    position: position === -1 ? 0 : position,
  });
}
