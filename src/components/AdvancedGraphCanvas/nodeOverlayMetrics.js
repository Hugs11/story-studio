// Les tailles de la couche HTML qui dépendent du zoom, écrites une fois pour
// l'écran (`GraphNodeOverlays`, par variables CSS) et pour la capture
// (`graphSurfaceCapture`), qui doivent peindre la même chose.
//
// Mesurées sur trois packs réels à 1280×800 et 2560×1440 (parcours e2e
// `c7-graphe-zoom-lisibilite`) : à 1280 de large, les panneaux laissent
// environ 470 px au canvas, et « tout cadrer » tombe entre 6 et 20 %. Les noms,
// le compteur et les poignées tombaient à 55 % : sur un portable, on ne les
// voyait presque jamais.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeZoom = (zoom) => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);

// La colonne d'un nom : 112 px au plus, et jamais plus large que la place
// entre deux nœuds voisins. Le pas le plus serré relevé est de 200 unités de
// graphe entre une Liste et l'Écran qui la suit ; à 112 px fixes, deux noms
// longs se recouvraient dès 45 %. 180 unités laissent un blanc entre eux.
const NODE_LABEL_MAX_PX = 112;
const NODE_LABEL_ROOM_UNITS = 180;

export function nodeLabelWidthPx(zoom) {
  return Math.round(Math.min(NODE_LABEL_MAX_PX, NODE_LABEL_ROOM_UNITS * safeZoom(zoom)));
}

// Le compteur de choix d'une Liste. Il suivait la taille du losange, deux fois
// plus petit qu'une carte : 5,5 px de texte à 100 %, 3 px à 55 %. Il a
// désormais sa propre taille, lisible à tous les zooms où il paraît.
const ACTION_COUNT_FONT = Object.freeze({ MIN: 8, MAX: 11, PER_ZOOM: 20 });

export function actionCountFontPx(zoom) {
  return clamp(ACTION_COUNT_FONT.PER_ZOOM * safeZoom(zoom), ACTION_COUNT_FONT.MIN, ACTION_COUNT_FONT.MAX);
}

// La zone de saisie d'une poignée de lien. À 22 px fixes, les poignées d'un
// Écran couvraient 55 % de sa carte à 30 % de zoom : on attrapait un lien en
// voulant déplacer le nœud. Elle rétrécit donc avec la carte, sans descendre
// sous une cible encore visable.
const LINK_HANDLE = Object.freeze({ MIN: 12, MAX: 22, PER_ZOOM: 40 });

export function linkHandlePx(zoom) {
  return clamp(LINK_HANDLE.PER_ZOOM * safeZoom(zoom), LINK_HANDLE.MIN, LINK_HANDLE.MAX);
}

// La pastille visible d'une poignée. La prise peinte par le moteur mesure
// 9 unités de graphe, soit 2,7 px à 30 % : la zone de saisie était là, mais
// rien ne la montrait. La couche HTML repeint donc la pastille par-dessus, à
// sa taille réelle quand elle se voit, et jamais sous une taille lisible.
const PORT_DOT = Object.freeze({ MIN: 8, UNITS: 9 });

export function portDotPx(zoom) {
  return Math.max(PORT_DOT.MIN, Math.round(PORT_DOT.UNITS * safeZoom(zoom) * 10) / 10);
}

// Sous le régime des poignées, celles du nœud survolé ou sélectionné restent
// offertes, à taille fixe et **hors** de la carte : un seul nœud à la fois, et
// rien de posé sur son corps, donc aucun conflit avec son déplacement.
//
// `GAP` est négatif : la poignée mord de 3 px sur le bord. Un interstice de
// canvas entre la carte et elle ferait perdre le survol au pointeur qui le
// traverse, et la poignée disparaîtrait juste avant d'être atteinte. Posée
// par-dessus le canvas, elle garde ensuite le survol : Cytoscape ignore les
// mouvements hors de son conteneur.
export const REVEALED_HANDLE = Object.freeze({ SIZE: 16, DOT: 10, GAP: -3 });

// Le centre d'une poignée révélée, en pixels relatifs au centre du nœud : dans
// le prolongement de sa prise, juste au-delà du bord rendu.
export function revealedHandleOffset(node, anchor) {
  const reach = (half) => half + REVEALED_HANDLE.GAP + (REVEALED_HANDLE.SIZE / 2);
  return Math.abs(anchor.dx) >= Math.abs(anchor.dy)
    ? { x: Math.sign(anchor.dx) * reach(node.width / 2), y: 0 }
    : { x: 0, y: Math.sign(anchor.dy) * reach(node.height / 2) };
}
