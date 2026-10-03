// Domaine numérique de la vue et bornes d'un glisser.

// Le domaine que le moteur traite comme sûr pour les deux passerelles.
export const SHORT_MIN = -32_768;
export const SHORT_MAX = 32_767;

// Coordonnées finies, zoom fini strictement positif. Une valeur hors
// domaine fait ignorer **le seul `viewport`**, pas la sélection.
export function isUsableViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') return false;
  return Number.isFinite(viewport.x)
    && Number.isFinite(viewport.y)
    && Number.isFinite(viewport.zoom)
    && viewport.zoom > 0;
}

// Zoome autour du point du geste, en pixels de la surface. La même caméra est
// utilisée par la molette, les contrôles et la vue mémorisée.
export function zoomViewportAt(viewport, factor, point, { minZoom = 0.001, maxZoom = 4 } = {}) {
  if (!isUsableViewport(viewport) || !Number.isFinite(factor) || factor <= 0
    || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * factor));
  if (zoom === viewport.zoom) return null;
  const ratio = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
    zoom,
  };
}

// Un glisser dont le résultat sortirait de `[-32768, 32767]` est
// empêché : le canvas borne la valeur qu'il *envoie*, et l'affiche comme une
// butée visible.
//
// Motif : le moteur refuse l'option « accepter une perte d'affichage STUdio »
// pour une valeur que Story Studio vient de créer, et laisser passer la valeur
// poserait un `ACTION_REQUIRED` sans dimension d'interopérabilité, à chaque
// glisser un peu long, sur un document jusqu'ici sain.
//
// La mise à l'échelle explicite reste offerte là où elle a un sens : au geste
// « appliquer cette disposition aux métadonnées », qui porte sur un ensemble et
// propose un aperçu.
export function clampAuthoredPosition({ x, y }) {
  const clampedX = clampCoordinate(x);
  const clampedY = clampCoordinate(y);
  return {
    x: clampedX.value,
    y: clampedY.value,
    // La butée est rendue visible plutôt que silencieuse : l'auteur doit voir
    // que le nœud a cessé de suivre le pointeur, et pourquoi.
    clamped: clampedX.clamped || clampedY.clamped,
    axes: {
      x: clampedX.clamped,
      y: clampedY.clamped,
    },
  };
}

function clampCoordinate(value) {
  if (!Number.isFinite(value)) return { value: 0, clamped: true };
  // La position est **arrondie** avant d'être bornée. Un moteur de rendu rend
  // une position flottante à la fin d'un glisser, et l'écrire telle quelle
  // faisait poser par le moteur natif un `POSITION_FRACTIONAL` — « fidélité
  // d'affichage STUdio réduite » — sur le nœud que l'auteur venait de
  // déplacer, qui passait aussitôt « à corriger ».
  //
  // C'est la même règle que celle appliquée plus bas : Story Studio
  // ne crée pas une valeur dont il faudra ensuite signaler la perte. Le
  // sous-pixel n'a aucun sens à l'échelle d'une disposition d'auteur, et le
  // domaine sûr est de toute façon entier.
  const rounded = Math.round(value);
  if (rounded < SHORT_MIN) return { value: SHORT_MIN, clamped: true };
  if (rounded > SHORT_MAX) return { value: SHORT_MAX, clamped: true };
  return { value: rounded, clamped: false };
}

// Le cadrage d'ouverture, calculé sur l'étendue **mesurée** de la disposition.
//
// On ne reprend pas les limites de zoom du diagramme Libre sans avoir mesuré
// les étendues reçues : un quadrillage FS atteint `x = 376 960` là où un pack
// STUdio tient dans quelques milliers de pixels, et un facteur de zoom plancher
// inventé rendrait le premier illisible.
export function fitViewport(extent, { width, height, padding = 48, maxZoom = 1.5 } = {}) {
  if (!extent || extent.empty || width <= 0 || height <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  // Une étendue nulle sur un axe (une seule colonne, un seul nœud) ne doit pas
  // produire une division par zéro ni un zoom infini.
  const zoomX = extent.width > 0 ? usableWidth / extent.width : maxZoom;
  const zoomY = extent.height > 0 ? usableHeight / extent.height : maxZoom;
  const zoom = Math.min(maxZoom, Math.max(Number.MIN_VALUE, Math.min(zoomX, zoomY)));
  const centerX = (extent.minX + extent.maxX) / 2;
  const centerY = (extent.minY + extent.maxY) / 2;
  return {
    x: width / 2 - centerX * zoom,
    y: height / 2 - centerY * zoom,
    zoom,
  };
}

// La demi-taille peinte d'une carte, en unités de graphe.
//
// Elle reprend ce que la surface dessine et ce que le placement de secours du
// moteur natif calibre déjà : une carte de 104 × 80 centrée sur la position,
// surmontée de rien et suivie de son nom, haut de 14 et posé 5 sous la carte.
// Un nœud n'est « à l'écran » que si **tout** cela y est.
const NODE_BOUNDS = Object.freeze({
  stage: Object.freeze({ halfWidth: 52, halfHeight: 40 + 5 + 14 }),
  action: Object.freeze({ halfWidth: 26, halfHeight: 26 + 5 + 14 }),
});
// Compatibilité des consommateurs qui parlent encore du gabarit maximal.
export const NODE_HALF_WIDTH = NODE_BOUNDS.stage.halfWidth;
export const NODE_HALF_HEIGHT = NODE_BOUNDS.stage.halfHeight;

function nodeHalfBounds(node) {
  return NODE_BOUNDS[node?.kind] ?? NODE_BOUNDS.stage;
}

// Le nœud est-il entièrement visible dans la fenêtre courante ?
//
// Elle existe pour qu'un déplacement de lecture ne bouge la caméra que
// lorsqu'il le faut : recadrer sur un nœud déjà sous les yeux de l'auteur est
// un mouvement qu'il n'a pas demandé, et qui lui fait perdre ses repères pour
// rien. Hors de l'écran, en revanche, il faut bien aller le chercher.
//
// `padding` est une marge d'écran : un nœud collé au bord est traité comme
// absent, parce qu'il est illisible là où il est.
//
// Une fenêtre inutilisable ou une position non finie rendent `false` — donc on
// recadre. C'est le sens le plus sûr : au pire la caméra bouge, au mieux elle
// ne laisse pas l'auteur devant un nœud qu'il ne trouve pas.
export function isNodeOnScreen(viewport, node, { width, height, padding = 24 } = {}) {
  if (!isUsableViewport(viewport)) return false;
  if (!(width > 0) || !(height > 0)) return false;
  const x = node?.layout?.x;
  const y = node?.layout?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { zoom } = viewport;
  const { halfWidth, halfHeight } = nodeHalfBounds(node);
  const left = viewport.x + (x - halfWidth) * zoom;
  const right = viewport.x + (x + halfWidth) * zoom;
  const top = viewport.y + (y - halfHeight) * zoom;
  const bottom = viewport.y + (y + halfHeight) * zoom;
  return left >= padding
    && top >= padding
    && right <= width - padding
    && bottom <= height - padding;
}

// Centre la caméra sur un nœud sans changer le zoom : cadrer un résultat de
// recherche ne doit pas déranger l'échelle que l'auteur a choisie.
export function centerOnNode(viewport, node, { width, height }) {
  const zoom = isUsableViewport(viewport) ? viewport.zoom : 1;
  return {
    x: width / 2 - node.layout.x * zoom,
    y: height / 2 - node.layout.y * zoom,
    zoom,
  };
}

// Le point du graphe qu'on voit au **milieu** de la surface.
//
// C'est l'inverse exact de `centerOnNode` : celle-ci répond « quelle caméra
// pour mettre ce nœud au centre », celle-là « quel point est au centre de cette
// caméra ».
//
// Créer un nœud depuis l'en-tête du panneau s'en sert. Un clic droit désigne un
// point ; l'en-tête, non — et sans point, le nœud naît où la disposition le
// met, souvent hors de l'écran sur un gros pack. Le seul endroit que l'auteur
// puisse prévoir sans qu'on le lui dise est celui qu'il regarde.
//
// Une caméra hors domaine ne rend **rien** plutôt qu'un point inventé : la
// création se fera alors sans position, comme avant, au lieu de poser le nœud
// à un endroit tiré d'une valeur dont on sait qu'elle est fausse.
export function viewportCenter(viewport, { width, height }) {
  if (!isUsableViewport(viewport)) return null;
  return {
    x: ((width / 2) - viewport.x) / viewport.zoom,
    y: ((height / 2) - viewport.y) / viewport.zoom,
  };
}

// Le pas des commandes de zoom du graphe — boutons et clavier.
export const GRAPH_ZOOM_STEP = 1.2;

// Aucune borne basse « ronde » : un pack projeté se cadre à 1 %, et un
// plancher de 2 % faisait sauter la vue au premier appui sur « − ».
const GRAPH_ZOOM_MIN = 0.001;
const GRAPH_ZOOM_MAX = 4;

function clampGraphZoom(zoom) {
  return Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, zoom));
}

// La caméra après un zoom qui garde le **centre visible** stable. En ne
// multipliant que le facteur, l'agrandissement s'ancrait sur l'origine écran :
// la vue partait de côté à chaque appui. `null` quand rien ne change — la
// borne est déjà atteinte — ou que la caméra est inutilisable.
export function zoomedViewport(viewport, { width, height }, factor) {
  if (!isUsableViewport(viewport)) return null;
  const next = clampGraphZoom(viewport.zoom * factor);
  if (next === viewport.zoom) return null;
  const centerX = width / 2;
  const centerY = height / 2;
  const graphX = (centerX - viewport.x) / viewport.zoom;
  const graphY = (centerY - viewport.y) / viewport.zoom;
  return { x: centerX - graphX * next, y: centerY - graphY * next, zoom: next };
}

// Un point de la surface, en pixels relatifs à son coin, ramené en coordonnées
// de graphe. C'est la conversion du clic droit et de la création au clavier.
export function surfacePointToGraph(viewport, point) {
  if (!isUsableViewport(viewport) || !point) return null;
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}
