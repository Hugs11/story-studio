// Adaptateur Cytoscape.js — finaliste « robustesse et approvisionnement ».
//
// **Canvas 2D forcé** : aucune extension WebGL n'est chargée. Le canvas 2D est
// le socle de conformité sur les trois plateformes, et le banc
// d'essai compare les deux finalistes à armes égales.
//
// Tout le vocabulaire Cytoscape est enfermé ici. Rien de ce fichier ne remonte
// vers le DTO, la recherche, la sélection ou l'inspecteur.

import {
  assertEngineContract,
  DEFAULT_EDGE_VISIBILITY,
  danglingSourcePaths,
  EDGE_KINDS,
  EDGE_VISIBILITY_GROUPS,
  NODE_KINDS,
  nodePortOffsets,
  plottableEdges,
  PORT_RADIUS,
  PORT_ROLES,
  portLayerBox,
  portLayerOverflow,
} from './engineContract.js';
import { readEngineColors } from './engineColors.js';

// Le fond de la scène est partagé entre CSS, texture du viewport et capture.
// Le relire à chaque reconstruction de style garde ces trois surfaces
// exactement accordées lors d'un changement de thème.
const SURFACE_BACKGROUND_TOKEN = Object.freeze({ bg: ['--bg0', '#15181c'] });

// Les rôles de couleur empruntés au thème, avec le repli employé quand la
// variable est absente **ou** quand la WebView refuse sa valeur.
const COLOR_TOKENS = Object.freeze({
  ...SURFACE_BACKGROUND_TOKEN,
  bg1: ['--bg1', '#18181f'],
  bg2: ['--bg2', '#1e1e27'],
  // La carte d'un Écran sans image. Elle ne suit plus `--bg2` : sur le fond
  // réel du canvas — `#0a0a0e` en sombre, `#EBEEF3` en clair — `--bg2` ne
  // tient que 1,2:1 de contraste, c'est-à-dire un trou au dézoom sur les 32 à
  // 38 % du corpus qui n'ont pas d'image. Le sombre tient 3:1 contre `--bg0` ;
  // le clair est volontairement relâché à 2:1 pour ne pas transformer la
  // surface en damier. Le rapport s'inverse d'un thème à l'autre. Les replis
  // ci-dessous sont ceux du thème sombre : ils ne
  // servent que si la WebView refuse la variable, auquel cas ils sont faux en
  // thème clair — d'où la règle de n'ajouter un token qu'avec ses deux
  // définitions dans `variables.css`.
  cardBg: ['--graph-card-bg', '#5d5c88'],
  cardBorder: ['--graph-card-border', '#7874b7'],
  // L'Action a sa propre famille de teinte, écartée du violet des Écrans en
  // clarté autant qu'en teinte : c'est ce qui la fait reconnaître au dézoom,
  // où le losange n'a plus assez de pixels pour que sa forme le dise.
  actionBg: ['--graph-action-bg', '#52c0b9'],
  actionBorder: ['--graph-action-border', '#83d4ce'],
  actionGlyph: ['--graph-action-glyph', '#031a19'],
  border: ['--border', '#2a2a36'],
  secondary: ['--text-secondary', '#a6a2c0'],
  muted: ['--muted', '#6e6c8a'],
  accent: ['--accent', '#d79b66'],
  accentText: ['--accent-text', '#efb471'],
  accentBorder: ['--accent-border', '#946f4b'],
  focus: ['--focus-ring', '#f0b26f'],
  warning: ['--warning', '#dfc24f'],
  warningBorder: ['--warning-border', '#8c793e'],
  info: ['--info', '#79b8ff'],
  linkReturn: ['--graph-link-return', '#4a7fb5'],
  accent2: ['--accent-2', '#7357b8'],
  accent2Text: ['--accent-2-text', '#c6b4ef'],
});

function surfaceBackground(container) {
  return readEngineColors(container, SURFACE_BACKGROUND_TOKEN).bg;
}

// Nombre de surimpressions HTML posées au plus par image. Les nœuds qui
// portent un repère — entrée, sélection, avertissements, carrefours — sont
// servis **hors budget**, puis le reste remplit la place qui subsiste.
// Tronquer avant de trier faisait perdre son libellé à l'entrée selon le seul
// ordre du document.
const OVERLAY_BUDGET = 600;

// Marge de criblage, en pixels **écran** : la même bande visible quel que soit
// le zoom.
const OVERLAY_MARGIN_PX = 160;

// Espacement dans le repère du graphe. La phase CSS reprend pan modulo le pas
// écran : les traits restent donc sur les mêmes coordonnées que Cytoscape.
const GRID_WORLD_STEP = 32;
const GRID_MAJOR_INTERVALS = 5;

function positiveModulo(value, period) {
  const result = ((value % period) + period) % period;
  return result < 1e-9 || period - result < 1e-9 ? 0 : result;
}

function gridAlpha(spacing, from, to, maximum) {
  const progress = Math.max(0, Math.min(1, (spacing - from) / (to - from)));
  return `${(Math.round(progress * maximum * 100) / 100).toFixed(2)}%`;
}

export function cytoscapeGridStyle({ x = 0, y = 0, zoom = 1 } = {}) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const panX = Number.isFinite(x) ? x : 0;
  const panY = Number.isFinite(y) ? y : 0;
  const minorStep = GRID_WORLD_STEP * scale;
  const majorStep = minorStep * GRID_MAJOR_INTERVALS;

  return {
    '--graph-grid-step': `${minorStep}px`,
    '--graph-grid-major-step': `${majorStep}px`,
    '--graph-grid-x': `${positiveModulo(panX, minorStep)}px`,
    '--graph-grid-y': `${positiveModulo(panY, minorStep)}px`,
    '--graph-grid-major-x': `${positiveModulo(panX, majorStep)}px`,
    '--graph-grid-major-y': `${positiveModulo(panY, majorStep)}px`,
    // Le motif mineur s'efface sous 11 px écran pour limiter le moiré au
    // dézoom ; la majeure disparaît si son pas devient lui aussi trop serré.
    '--graph-grid-minor-alpha': gridAlpha(minorStep, 11, 19, 4),
    '--graph-grid-major-alpha': gridAlpha(majorStep, 13, 36, 8),
  };
}

// Nombre de marques posées au plus au régime éloigné, **avant** regroupement.
//
// Servir les repères hors budget garantissait que l'entrée ne perde jamais le
// sien. Sur un pack lourdement diagnostiqué, cette garantie se retournait : la
// recette Tauri a mesuré 464 anneaux couvrant 13,6 % de la scène et 508 paires
// de noms qui se recouvrent sur le profil p90 de 795 nœuds, et 5 588 anneaux
// couvrant 64 % de la scène sur le maximum de 9 121 — un aplat dans lequel
// l'entrée, pourtant présente et bien dessinée, ne se distinguait plus. Le
// critère de recette est « retrouver l'entrée et les nœuds à corriger sans
// connaître leur nom », et il n'était pas tenu.
//
// Les avertissements sont donc **regroupés par zone d'écran** au-delà de ce
// budget, chaque marque portant le nombre de nœuds qu'elle représente. Le
// nombre de marques devient borné par la taille de la fenêtre au lieu de la
// taille du pack, et l'endroit où les défauts se concentrent reste lisible.
// L'entrée, la sélection et les carrefours ne sont jamais regroupés : ce sont
// les repères qui situent la lecture, et ils sont peu nombreux par
// construction.
const LANDMARK_MARK_BUDGET = 240;

// La zone de regroupement, déduite de la surface visible pour que le compte de
// marques tienne le budget quelle que soit la fenêtre. Jamais sous 24 px : deux
// anneaux plus proches que cela se touchent de toute façon.
function clusterCellPx(width, height) {
  const area = Math.max(1, width * height);
  return Math.max(24, Math.sqrt(area / LANDMARK_MARK_BUDGET));
}

// Largeur du trait d'un lien, en unités de graphe.
const EDGE_WIDTH = 1.7;

// Demi-largeur de la gaine. Cytoscape peint la sous-couche d'une arête en trait
// **plein** de `largeur + 2 × underlay-padding`, juste avant le trait lui-même
// et avant ses flèches : une seule passe suffit donc là où le handoff en
// décrivait deux, et le motif de tiret du trait laisse voir la gaine au lieu du
// décor.
//
// Le « largeur + 3 » du handoff réservait à chaque trait un couloir de 4,7
// unités, soit 2,8 fois sa propre largeur. Dans un faisceau — celui de
// l'entrée en compte plusieurs centaines — les traits voisins sont plus serrés
// que ce couloir : les gaines se recouvrent, et comme chacune est peinte juste
// avant son propre trait, **ce sont les derniers dessinés qui gagnent**. Le
// faisceau se lisait donc en peigne, avec un motif de rayures qui dépendait de
// l'ordre du document, au lieu de se lire comme une densité. À 0,7 le couloir
// tombe à 3,1 unités : les croisements restent séparés au zoom de travail, et
// un faisceau dense fond en un lavis.
const EDGE_SHEATH_PADDING = 0.7;

// Échelle d'une terminaison, depuis la taille voulue en unités de graphe.
//
// Cytoscape dessine une flèche dans un carré normalisé de 0,3 d'arête, mis à
// l'échelle par `max(pow(largeur × 13,37 ; 0,9) ; 29) × arrow-scale`. À la
// largeur de 1,7 le premier terme reste sous le plancher de 29 : une forme
// mesure donc `0,3 × 29 × arrow-scale` unités. Les tailles du handoff sont
// données en pixels à 100 % de zoom, où une unité de graphe vaut un pixel.
const ARROW_UNIT = 0.3 * 29;
const arrowScale = (units) => Math.round((units / ARROW_UNIT) * 100) / 100;

// Les terminaisons sont ramenées **aux deux tiers** des tailles du handoff.
//
// Elles y étaient calibrées seules, sans rapport au trait qu'elles terminent :
// 10,5 unités de triangle pour 1,7 de trait, c'est 6,2 fois la largeur du
// trait, 8,2 pour le té et 5,8 pour le disque, là où l'usage du dessin
// technique tient entre 3 et 5. La tête pesait donc plus que son trait, et
// comme une extrémité atterrit exactement sur une prise, huit à dix liens
// formaient une grappe pleine au bord du nœud plutôt qu'un raccord lisible.
//
// Le facteur est unique et s'applique aux trois familles : leurs tailles
// relatives étaient justes — un té a besoin de plus de course qu'un triangle
// pour se voir — c'est l'échelle d'ensemble qui ne l'était pas. Cytoscape ne
// connaît qu'un `arrow-scale` par règle : le chevron médian, qui pose la
// seconde masse de chaque trait, suit donc la même réduction.
const ARROW_TRIM = 2 / 3;
const trimmedArrow = (units) => arrowScale(Math.round(units * ARROW_TRIM * 10) / 10);

// Zoom à partir duquel la couche HTML pose des poignées sur les prises. Il
// coïncide avec celui des libellés : c'est le régime où l'on câble. Sous 30 %,
// la carte d'un Écran mesure moins de 31 px, et même réduites à 12 px ses
// poignées en couvriraient plus de la moitié.
const PORT_HANDLE_ZOOM = 0.30;

// En dessous, et jusqu'à ce plancher, le nœud survolé ou sélectionné garde des
// poignées : posées hors de sa carte par la couche HTML, elles ne mordent plus
// sur le corps qu'on attrape pour le déplacer. « Tout cadrer » tombe entre 6 et
// 20 % sur un portable : c'est là qu'on voit les deux bouts d'un raccord. Sous
// 5 %, les vignettes tombent et le régime éloigné commence.
const PORT_REVEAL_ZOOM = 0.05;
const inRevealBand = (zoom) => zoom >= PORT_REVEAL_ZOOM && zoom < PORT_HANDLE_ZOOM;

// Les tons de groupe restent hors des deux familles de nœuds : un bandeau teal
// sur un Écran le ferait lire comme une Action, un bandeau violet se fondrait
// dans sa carte. Même liste dans `graphSurfaceCapture.js` et dans la feuille
// `AdvancedGraphCanvas.css`.
const GROUP_TONES = Object.freeze(['#6b8f5e', '#8f7d68', '#87904e', '#a86a86', '#5f87a8', '#7a8494']);
// Le logo de la Liste tombe avec les prises peintes : il mesure encore 4,3 px
// à 20 % et se lit, puis devient une tache (3,2 px à 15 %).
const DECORATION_THRESHOLDS = Object.freeze({
  THUMBS: 0.05, DETAILS: 0.12, PORTS: 0.20, ACTION_GLYPH: 0.20,
});

// Le régime éloigné des nœuds.
//
// Sous 12 %, une carte de 104 × 80 mesure moins de 12 pixels et un losange de
// 52 moins de 6 : c'est là que l'Action disparaissait. Les nœuds y sont peints
// en aplat de leur famille, et **agrandis autour de leur centre**, sans que
// leur position bouge. L'Action est agrandie davantage, parce qu'elle part
// d'une surface six fois plus petite que celle d'une carte.
//
// Les deux natures ne sont pas agrandies au même seuil. L'Action l'est dès
// 12 %. L'Écran attend 5 %, que ses vignettes soient retirées : entre les deux,
// agrandir des cartes qui portent encore leur image faisait redessiner ces
// images sur une surface 2,25 fois plus grande. La recette Tauri sur 9 121
// nœuds a mesuré le cadrage large, à 5,45 %, tomber de 19 à 12 images par
// seconde deux fois sur quatre, et revenir à 18 sur trois passes sur trois
// quand l'Écran attend ses 5 %. Il reste lisible dans l'intervalle : il mesure
// encore 6 à 12 pixels, en aplat violet.
//
// Aucun plafond n'est calculé d'après les voisins : sur un graphe rangé, le pas
// de 239 entre un Écran et une Action et celui de 200 entre deux rangées
// laissent encore 109 et 80 unités d'air, et un chevauchement sur une mise en
// page manuelle ne gêne pas à ce zoom.
//
// Les extrémités des liens restent aux prises de la taille normale, donc à
// l'intérieur du nœud agrandi. Elles y sont cachées : les liens passent sous
// les nœuds, et ils sont déjà en retrait à ce régime.
const NODE_FAR_ZOOM = Object.freeze({
  FLAT: DECORATION_THRESHOLDS.DETAILS,
  [NODE_KINDS.ACTION]: DECORATION_THRESHOLDS.DETAILS,
  [NODE_KINDS.STAGE]: DECORATION_THRESHOLDS.THUMBS,
});
const NODE_FAR_SIZE = Object.freeze({
  [NODE_KINDS.STAGE]: Object.freeze({ width: 156, height: 120 }),
  [NODE_KINDS.ACTION]: Object.freeze({ width: 104, height: 104 }),
});

// Le régime d'encre des liens.
//
// Cytoscape ne sait pas faire varier un style avec le zoom : la feuille est
// donc reconstruite aux deux seuils où l'encre d'un lien cesse d'informer. Ils
// sont ceux des décorations — un franchissement ne déclenche jamais deux passes
// complètes à deux endroits différents du dézoom.
//
// **Les terminaisons tombent avec les prises, à 20 %.** Une flèche de 10,5
// unités mesure 1,6 pixel à 15 % : elle ne dit plus le sens du trait, mais elle
// s'agglutine sur les sommets du losange qu'elle désigne, et elle est peinte à
// 3,9:1 sur le fond — c'est-à-dire plus visible que le carrefour lui-même. La
// gaine part avec elles : 0,7 pixel de fond sous chaque trait ne sépare plus
// deux croisements, il ne reste que la charge.
//
// **Les traits s'effacent à 12 %**, là où la vignette d'un Écran est encore
// lisible et où la masse des liens devient un lavage. Les nœuds redeviennent la
// figure, les liens le fond. Le survol, la trace de présentation et la mise en
// retrait gardent leur propre opacité : leurs règles sont déclarées après.
const EDGE_INK_THRESHOLDS = Object.freeze({
  ARROWS: DECORATION_THRESHOLDS.PORTS,
  FADE: DECORATION_THRESHOLDS.DETAILS,
});
const EDGE_FAR_OPACITY = 0.5;

function edgeInk(zoom) {
  return { arrows: zoom >= EDGE_INK_THRESHOLDS.ARROWS, faded: zoom < EDGE_INK_THRESHOLDS.FADE };
}

function nodesFar(zoom) {
  return {
    flat: zoom < NODE_FAR_ZOOM.FLAT,
    action: zoom < NODE_FAR_ZOOM[NODE_KINDS.ACTION],
    stage: zoom < NODE_FAR_ZOOM[NODE_KINDS.STAGE],
  };
}

// L'état de la feuille de style : le régime d'encre des liens et celui des
// nœuds. Leurs seuils coïncident à 12 % et 20 %, et celui des Écrans à 5 %
// est celui des vignettes : la feuille n'est reconstruite qu'à trois
// franchissements sur toute la plage de zoom.
function zoomStyleState(zoom) {
  const ink = edgeInk(zoom);
  const far = nodesFar(zoom);
  return `${ink.arrows}:${ink.faded}:${far.flat}:${far.action}:${far.stage}`;
}

// Une terminaison qui n'est plus lisible n'est pas rétrécie : elle est retirée.
const arrowShape = (shape, ink) => (ink.arrows ? shape : 'none');

// **Les bouts d'un lien sont avivés, son milieu garde la teinte de sa famille.**
// Un trait droit croise parfois un nœud sur son chemin, pile sur ses prises :
// il semblait en partir. Accroché, un lien quitte et rejoint ses nœuds dans la
// teinte vive ; en passant, il ne croise un nœud qu'avec son milieu terne.
// Retiré au régime éloigné, avec les terminaisons, où l'on ne lit plus les
// accroches et où un dégradé par lien coûterait sans rien montrer.
const EDGE_END_STOPS = ['0%', '14%', '86%', '100%'];
const edgeEnds = (ink, end, middle) => (ink.arrows
  ? {
    'line-fill': 'linear-gradient',
    'line-gradient-stop-colors': [end, middle, middle, end],
    'line-gradient-stop-positions': EDGE_END_STOPS,
  }
  : { 'line-fill': 'solid' });

function groupTone(groupId) {
  let hash = 0;
  for (const character of String(groupId)) hash = ((hash * 31) + character.codePointAt(0)) | 0;
  return GROUP_TONES[Math.abs(hash) % GROUP_TONES.length];
}

function svgDataUri(width, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Le SVG de la couche des prises, en repère **centré sur le nœud** : ses
// coordonnées sont alors exactement celles que `nodePortOffsets` publie, donc
// rien ne se traduit entre la géométrie partagée et le dessin.
//
// Sa taille est portée par les attributs `width`/`height` du SVG lui-même. Un
// fond posé en `background-fit: none` prend la taille naturelle de son image :
// il n'y a donc pas à piloter `background-width` en données, ce qui aurait
// imposé un tableau mêlant `auto` et des nombres sur les fonds d'un Écran.
function centeredSvgDataUri(width, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="${-width / 2} ${-height / 2} ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function nodeTone(node, color) {
  return node.personalColor || (node.groupId ? groupTone(node.groupId) : color.secondary);
}

function personalTint(node) {
  if (!node.personalColor) return '';
  if (node.kind === NODE_KINDS.ACTION) {
    return `<path d="M26 0 52 26 26 52 0 26Z" fill="${node.personalColor}" fill-opacity=".36" stroke="${node.personalColor}" stroke-opacity=".58"/>`;
  }
  return `<rect x=".5" y=".5" width="103" height="79" rx="9.5" fill="${node.personalColor}" fill-opacity=".36" stroke="${node.personalColor}" stroke-opacity=".58"/>`;
}

// La couche des prises, peinte **par-dessus** la silhouette et hors d'elle.
//
// Elle est séparée de la décoration interne pour une raison précise : la
// décoration porte le bandeau de groupe et la teinte personnelle, qui doivent
// rester découpés au contour arrondi de la carte. Sortir tout le dessin
// de la découpe aurait fait ressortir les coins carrés du bandeau hors des
// angles arrondis. Seules les prises débordent, et elles seules.
//
// Une prise chevauche le contour aux deux tiers : elle ne couvre plus la
// vignette, et elle offre une cible franche au geste de raccord. Le rail d'une
// Action relie ses emplacements pour qu'ils restent visiblement attachés au
// losange, dont la silhouette ne les porte plus au-delà de ses pointes : il est
// donc peint dans la teinte de son contour.
function nodePortLayer(node, color, zoom) {
  if (zoom < DECORATION_THRESHOLDS.PORTS) return null;
  const slots = Math.max(1, node.optionSlots ?? 1);
  const offsets = nodePortOffsets(node.kind, slots);
  const { width, height } = portLayerBox(node.kind, slots);
  const options = offsets.filter((port) => port.ordinal !== null);
  // Le rail ne se dessine qu'à partir de deux emplacements : à un seul, la
  // pastille chevauche déjà la pointe du losange et n'a rien à rejoindre.
  const rail = options.length >= 2
    ? `<rect x="${options[0].x - 1}" y="${options[0].y}" width="2" `
      + `height="${options[options.length - 1].y - options[0].y}" fill="${color.actionBorder}"/>`
    : '';
  const marks = offsets.map((port) => {
    if (port.role === PORT_ROLES.ARRIVAL) {
      // L'arrivée est un repère, pas une poignée : rien ne s'y tire.
      return `<circle cx="${port.x}" cy="${port.y}" r="${PORT_RADIUS - 1}" fill="${color.muted}"/>`;
    }
    if (port.role === PORT_ROLES.HOME) {
      return `<circle cx="${port.x}" cy="${port.y}" r="${PORT_RADIUS}" fill="${color.info}"/>`;
    }
    // Le dernier cran d'une Action est la prise d'ajout : elle est creuse, pour
    // se distinguer des options déjà raccordées sans emprunter de couleur.
    const isAdd = port.role === PORT_ROLES.OPTION && port.ordinal === options.length - 1;
    return isAdd
      ? `<circle cx="${port.x}" cy="${port.y}" r="${PORT_RADIUS - 0.75}" fill="none" `
        + `stroke="${color.secondary}" stroke-width="1.5"/>`
      : `<circle cx="${port.x}" cy="${port.y}" r="${PORT_RADIUS}" fill="${color.secondary}"/>`;
  }).join('');
  return centeredSvgDataUri(width, height, `${rail}${marks}`);
}

// Le motif d'aiguillage peint dans le losange d'une Action.
//
// Ce sont **les coordonnées exactes** de l'icône `Waypoints` du jeu partagé,
// reprises telles quelles et seulement ramenées du carré de 24 à celui de 52 :
// c'est ce qui garantit que le glyphe du canvas et l'icône du bouton « Créer
// une Action » ne peuvent pas diverger. Aucun chiffre n'est re-dérivé à la
// main — la tentation de le faire avait déjà produit deux dessins différents
// de la même intention ailleurs dans cette surface.
//
// L'échelle réduit aussi l'épaisseur du trait, donc elle la compense : le
// glyphe garde les 2,4 unités des autres décorations. Il est tracé dans la
// teinte faite pour tenir sur l'aplat teal du losange, pas dans celle du texte.
const ACTION_GLYPH_SCALE = 0.9;
const ACTION_GLYPH_STROKE = 2.4;
const ACTION_GLYPH_MARKS = [
  '<path d="m10.586 5.414-5.172 5.172"/>',
  '<path d="m18.586 13.414-5.172 5.172"/>',
  '<path d="M6 12h12"/>',
  '<circle cx="12" cy="20" r="2"/>',
  '<circle cx="12" cy="4" r="2"/>',
  '<circle cx="20" cy="12" r="2"/>',
  '<circle cx="4" cy="12" r="2"/>',
].join('');

function actionGlyph(color) {
  return `<g transform="translate(26 26) scale(${ACTION_GLYPH_SCALE}) translate(-12 -12)" `
    + `fill="none" stroke="${color.actionGlyph}" `
    + `stroke-width="${(ACTION_GLYPH_STROKE / ACTION_GLYPH_SCALE).toFixed(2)}" `
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + `${ACTION_GLYPH_MARKS}</g>`;
}

// Même tracé que `Fullscreen` du jeu partagé, inscrit dans la texture du
// canvas. Les formes sont recopiées comme celles de l'Action : l'adaptateur
// reste un module JS pur, chargeable aussi par le banc Node hors React.
const STAGE_GLYPH_MARKS = [
  '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>',
  '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>',
  '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>',
  '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  '<rect width="10" height="8" x="7" y="8" rx="1"/>',
].join('');

function stageGlyph(color) {
  return `<g transform="translate(52 40) scale(1.8) translate(-12 -12)" `
    + `fill="none" stroke="${color}" stroke-width="1.22" `
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + `${STAGE_GLYPH_MARKS}</g>`;
}

function nodeDecoration(node, color, zoom, hasImage) {
  if (node.kind === NODE_KINDS.ACTION) {
    const glyph = zoom >= DECORATION_THRESHOLDS.ACTION_GLYPH ? actionGlyph(color) : '';
    return svgDataUri(52, 52, `${personalTint(node)}${glyph}`);
  }
  const groupBand = node.groupId ? `<rect width="104" height="6" fill="${groupTone(node.groupId)}"/>` : '';
  // Le cadre reste reconnaissable sous le seuil des prises (20 %). Sous 12 %,
  // il devient trop petit pour être lu, et il n'est pas remplacé : c'est l'aplat
  // de la carte, peint par la feuille de style, qui porte alors l'Écran.
  const glyph = !hasImage && zoom >= DECORATION_THRESHOLDS.DETAILS
    ? stageGlyph(nodeTone(node, color))
    : '';
  return svgDataUri(104, 80, `${personalTint(node)}${groupBand}${glyph}`);
}

function decorationState(zoom) {
  return [
    zoom >= DECORATION_THRESHOLDS.THUMBS,
    zoom >= DECORATION_THRESHOLDS.DETAILS,
    zoom >= DECORATION_THRESHOLDS.PORTS,
    zoom >= DECORATION_THRESHOLDS.ACTION_GLYPH,
  ].join(':');
}

// Les fonds d'un nœud, dans leur ordre de peinture.
//
// Les trois couches n'ont pas le même régime, et c'est tout l'intérêt de les
// séparer : la vignette est cadrée en `cover` et découpée au contour, la
// décoration interne est inscrite dans le nœud et découpée elle aussi, la
// couche des prises est posée à sa taille naturelle, sans découpe, et
// **par-dessus** la silhouette. Cytoscape peint les fonds `over` dans une
// seconde passe, après la forme et le contour : une prise ne peut donc pas
// passer sous la carte qu'elle sert.
//
// `background-fit: none` prend la taille naturelle de l'image — celle que le
// SVG déclare. C'est ce qui évite d'avoir à piloter `background-width` en
// données, et donc un tableau mêlant `auto` et des nombres.
function decoratedNodeData(node, imageUrl, color, zoom) {
  const hasImage = Boolean(imageUrl);
  const showImage = hasImage && zoom >= DECORATION_THRESHOLDS.THUMBS;
  const decoration = nodeDecoration(node, color, zoom, hasImage);
  const portLayer = nodePortLayer(node, color, zoom);
  const images = [];
  const fits = [];
  const clips = [];
  const containments = [];
  if (showImage) {
    images.push(imageUrl);
    fits.push('cover');
    clips.push('node');
    containments.push('inside');
  }
  images.push(decoration);
  fits.push('contain');
  clips.push('node');
  containments.push('inside');
  if (portLayer) {
    images.push(portLayer);
    fits.push('none');
    clips.push('none');
    containments.push('over');
  }
  return {
    renderedImages: images,
    renderedImageFits: fits,
    renderedImageClips: clips,
    renderedImageContainments: containments,
  };
}

// Le style est volontairement plat : le banc d'essai mesure un moteur, pas une
// feuille de style. Les deux adaptateurs portent la même charge visuelle —
// même nombre de traits, mêmes libellés, mêmes formes — sans quoi la
// comparaison n'en serait plus une.
function stylesheet(color, ink = edgeInk(1), far = nodesFar(1)) {
  return [
    {
      // Pendant pan/zoom, la texture de Cytoscape ne doit pas masquer le fond
      // CSS du conteneur : il porte la grille ancrée à la caméra.
      selector: 'core',
      style: {
        'outside-texture-bg-color': color.bg,
        'outside-texture-bg-opacity': 0,
      },
    },
    {
      selector: 'node',
      style: {
        // Les textes et les marqueurs sont posés par la couche HTML du stage :
        // Cytoscape ne sait pas rendre fidèlement les cartes du handoff.
        label: '',
        width: 104,
        height: 80,
        shape: 'round-rectangle',
        'background-color': color.cardBg,
        'border-width': 1,
        'border-color': color.cardBorder,
        color: color.secondary,
        'background-image': 'data(renderedImages)',
        'background-fit': 'data(renderedImageFits)',
        'background-clip': 'data(renderedImageClips)',
        'background-image-containment': 'data(renderedImageContainments)',
        // La couche des prises déborde de la silhouette, et Cytoscape doit le
        // savoir : sans cette déclaration, la tuile de cache d'un nœud est
        // taillée à sa boîte englobante et coupe les pastilles — visible à
        // l'arrêt seulement, puisque pendant un mouvement la scène est peinte
        // d'un bloc sans passer par ce cache.
        'bounds-expansion': 'data(boundsExpansion)',
        // Le nœud doit gagner quand un lien le traverse : Cytoscape utilise
        // aussi cet ordre de peinture pour départager les cibles du pointeur.
        // Les prises HTML restent au-dessus des cartes sélectionnées.
        'z-index-compare': 'manual',
        'z-index': 1,
      },
    },
    {
      // Écran : rectangle arrondi. Sous 12 %, la carte est peinte de la teinte
      // de son contour : sa carte claire ne tient que 2:1 en thème clair, trop
      // peu pour une marque de quelques pixels, et son pictogramme n'y est plus
      // lisible. Une vignette, tant qu'elle reste, couvre cet aplat. Sous 5 %,
      // la carte est agrandie.
      selector: `node[kind = "${NODE_KINDS.STAGE}"]`,
      style: {
        ...(far.stage ? NODE_FAR_SIZE[NODE_KINDS.STAGE] : {}),
        'background-color': far.flat ? color.cardBorder : color.cardBg,
        'border-color': color.cardBorder,
      },
    },
    {
      // L'Action est un aiguillage, en aplat teal à tous les zooms : c'est sa
      // teinte, et non plus sa seule silhouette, qui la fait reconnaître quand
      // le losange ne mesure plus que quelques pixels. Elle passe **devant**
      // les Écrans, pour qu'un Écran agrandi au dézoom ne la recouvre jamais.
      selector: `node[kind = "${NODE_KINDS.ACTION}"]`,
      style: {
        ...(far.action ? NODE_FAR_SIZE[NODE_KINDS.ACTION] : { width: 52, height: 52 }),
        shape: 'diamond',
        // Les halos d'un nœud — sélection, survol d'un lien attenant, lecture
        // en cours — sont peints par Cytoscape dans la forme que dit
        // `overlay-shape`, et non dans celle du nœud. Un losange héritait donc
        // du rectangle arrondi par défaut, et se retrouvait encadré. La
        // propriété ne connaît que le rectangle arrondi et l'ellipse : c'est
        // l'ellipse qui épouse le moins mal une silhouette en pointe, et qui
        // évite surtout l'angle droit posé sur une diagonale.
        'overlay-shape': 'ellipse',
        'overlay-padding': 4,
        'background-color': color.actionBg,
        'background-opacity': 1,
        'border-width': 1.5,
        'border-color': color.actionBorder,
        color: color.secondary,
        'z-index': 2,
      },
    },
    {
      // L'entrée est repérée par un contour épais, lisible sans couleur.
      selector: 'node[?isEntry]',
      style: { 'border-width': 3, 'border-color': color.accent },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': 2, 'border-color': color.focus, 'overlay-color': color.accent, 'overlay-opacity': 0.12, 'overlay-padding': 7 },
    },
    {
      selector: 'node.presentation-dim',
      style: { opacity: 0.12 },
    },
    {
      selector: 'edge',
      style: {
        width: EDGE_WIDTH,
        'curve-style': 'bezier',
        // **L'arrivée est marquée.** Le chevron médian portait seul le sens du
        // trait : rien ne distinguait un lien qui aboutit sur un nœud d'un lien
        // qui passe derrière. La terminaison marque l'arrivée, le chevron garde
        // le sens en cours de trait — l'un ne remplace pas l'autre. Le chevron
        // devient creux pour ne pas se confondre avec le triangle plein posé à
        // l'arrivée d'un lien OK.
        'target-arrow-shape': arrowShape('triangle', ink),
        'target-arrow-color': color.muted,
        'mid-target-arrow-shape': arrowShape('chevron', ink),
        'mid-target-arrow-color': color.muted,
        'arrow-scale': trimmedArrow(10.5),
        'line-color': color.muted,
        opacity: ink.faded ? EDGE_FAR_OPACITY : 1,
        // Les liens restent sous les cartes pour ne pas masquer leur vignette
        // ni capter le clic à leur place dans les graphes denses.
        'z-index-compare': 'manual',
        'z-index': 0,
        // La gaine sépare encore les croisements entre liens, mais ne couvre
        // plus les cartes grâce à l'ordre de peinture ci-dessus. Elle s'arrête
        // au régime éloigné, où sa demi-largeur passe sous le pixel.
        'underlay-color': color.bg,
        'underlay-opacity': ink.arrows ? 1 : 0,
        'underlay-padding': EDGE_SHEATH_PADDING,
      },
    },
    {
      selector: 'edge[sourceEndpoint][targetEndpoint]',
      style: {
        'source-endpoint': 'data(sourceEndpoint)',
        'target-endpoint': 'data(targetEndpoint)',
      },
    },
    {
      // Trois natures de lien, **trois terminaisons** : triangle plein pour le
      // OK, barre perpendiculaire pour le retour, disque pour une option. La
      // forme suffit à les séparer, donc chaque famille de la légende reste
      // identifiable quand les deux autres sont masquées — la contrainte du
      // projet, que ni la couleur ni le seul motif de tiret ne tiennent.
      //
      // OK : trait plein, triangle plein.
      selector: `edge[kind = "${EDGE_KINDS.STAGE_OK}"]`,
      style: {
        ...edgeEnds(ink, color.secondary, color.muted),
        'line-style': 'solid',
        'line-color': color.muted,
        'mid-target-arrow-color': color.muted,
        'target-arrow-shape': arrowShape('triangle', ink),
        'target-arrow-color': color.muted,
        'arrow-scale': trimmedArrow(10.5),
      },
    },
    {
      // HOME : trait **tireté** et barre perpendiculaire. La différence OK/HOME
      // ne repose donc pas sur la couleur, comme le protocole l'exige. Le motif
      // s'exprime en unités de graphe : il se met à l'échelle tout seul, et le
      // pas du handoff tient au dézoom là où l'ancien `[7, 5]` se refermait en
      // trait plein dès le premier palier.
      selector: `edge[kind = "${EDGE_KINDS.STAGE_HOME}"]`,
      style: {
        ...edgeEnds(ink, color.info, color.linkReturn),
        'line-style': 'dashed',
        'line-color': color.linkReturn,
        'mid-target-arrow-color': color.linkReturn,
        'target-arrow-shape': arrowShape('tee', ink),
        'target-arrow-color': color.linkReturn,
        'arrow-scale': trimmedArrow(14),
        'line-dash-pattern': [14, 10],
      },
    },
    {
      // Retour par défaut de la Lunii : la barre du retour, mais un pointillé
      // serré et un trait estompé. Ce lien n'est pas dans le pack — c'est
      // l'appareil qui le fait — et il ne doit pas se lire comme un raccord
      // enregistré. Le survol dit pourquoi.
      selector: `edge[kind = "${EDGE_KINDS.STAGE_HOME_DEFAULT}"]`,
      style: {
        'line-fill': 'solid',
        'line-style': 'dashed',
        'line-dash-pattern': [4, 8],
        'line-color': color.linkReturn,
        'mid-target-arrow-shape': 'none',
        'target-arrow-shape': arrowShape('tee', ink),
        'target-arrow-color': color.linkReturn,
        'arrow-scale': trimmedArrow(14),
        opacity: ink.faded ? EDGE_FAR_OPACITY : 0.55,
      },
    },
    {
      // Option d'Action : trait plein, **disque**. Elle partage la couleur du
      // OK — les deux sont la structure de l'histoire — et c'est la terminaison
      // qui les sépare.
      selector: `edge[kind = "${EDGE_KINDS.ACTION_OPTION}"]`,
      style: {
        ...edgeEnds(ink, color.secondary, color.muted),
        'line-style': 'solid',
        'target-arrow-shape': arrowShape('circle', ink),
        'arrow-scale': trimmedArrow(9.8),
      },
    },
    {
      // Une option tirée au sort ne désigne aucune occurrence : elle est
      // pointillée, pour ne pas la rendre comme un choix figé. Elle garde le
      // disque de son rôle et la couleur de son rôle — la légende le dit de la
      // même façon. Le pointillé est posé en tirets courts plutôt qu'avec
      // `line-style: dotted`, dont le pas est figé à une unité de graphe et
      // disparaît donc dès le premier dézoom.
      selector: 'edge[?random]',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [3.6, 9] },
    },
    // --- États ------------------------------------------------------------
    //
    // Ils sont déclarés **après** les familles, et c'est une correction : chez
    // Cytoscape, la dernière règle qui touche une propriété gagne, sans notion
    // de spécificité. Les règles d'état venant avant les familles, et chaque
    // arête portant une famille, la recoloration du survol était réécrite
    // aussitôt — elle n'a jamais rien peint. Seule sa largeur passait.
    {
      // Le survol **ravive** le lien au lieu de le déguiser : sa famille est
      // précisément ce qu'on cherche à lire quand on l'inspecte. La teinte
      // franche de chaque famille est donc réservée à cet instant, et l'accent
      // violet reste sur les deux nœuds reliés, où il dit ce que le trait
      // joint.
      selector: 'edge.pointer-hover',
      style: {
        // Uni : sous un dégradé, la couleur du trait ne peint rien.
        'line-fill': 'solid',
        opacity: 1,
        width: 2.6,
        'line-color': color.secondary,
        'mid-target-arrow-color': color.secondary,
        'target-arrow-color': color.secondary,
      },
    },
    {
      selector: `edge[kind = "${EDGE_KINDS.STAGE_HOME}"].pointer-hover, edge[kind = "${EDGE_KINDS.STAGE_HOME_DEFAULT}"].pointer-hover`,
      style: {
        'line-color': color.info,
        'mid-target-arrow-color': color.info,
        'target-arrow-color': color.info,
      },
    },
    {
      selector: 'node.pointer-endpoint',
      style: {
        'overlay-color': color.accent2Text,
        'overlay-opacity': 0.16,
        'overlay-padding': 8,
      },
    },
    // La gaine s'efface avec son trait. Cytoscape peint la sous-couche d'une
    // arête à son `underlay-opacity` **brut**, sans le multiplier par l'opacité
    // de l'élément : sans ces deux lignes, un lien mis en retrait garderait une
    // gaine opaque, c'est-à-dire une traînée à la couleur du fond posée par-
    // dessus les cartes que la présentation cherche justement à montrer.
    { selector: 'edge.presentation-dim', style: { opacity: 0.06, 'underlay-opacity': 0.06 } },
    { selector: 'edge.presentation-dim.pointer-hover', style: { opacity: 0.06, 'underlay-opacity': 0.06 } },
    { selector: 'node.presentation-dim.pointer-endpoint', style: { opacity: 0.12 } },
    {
      selector: 'edge.presentation-trace',
      style: {
        'line-fill': 'solid',
        opacity: 1,
        width: 3,
        'line-color': color.accent2,
        'mid-target-arrow-color': color.accent2,
        'target-arrow-color': color.accent2,
      },
    },
    { selector: 'edge.legend-hidden', style: { display: 'none' } },
    // Sous 3 %, les nœuds **gardent** leur aplat typé et leur taille du régime
    // éloigné ; seuls les liens et les images tombent. Ils étaient réduits à
    // 10 × 6 unités de graphe, soit 0,2 pixel à 2 % : le pack disparaissait,
    // et avec lui la distinction entre Écrans et Actions.
    //
    // Les repères — anneau de l'entrée, carrefours, sélection — restent posés
    // par la couche HTML, qui travaille en pixels écran : un anneau de 56 unités
    // mesurerait 0,56 pixel à 1 % de zoom.
    { selector: 'node.simplified', style: { label: '', 'background-image': 'none' } },
    { selector: 'edge.simplified', style: { opacity: 0, 'underlay-opacity': 0 } },
    {
      selector: 'node.simplified[?isEntry]',
      style: { 'background-color': color.accent },
    },
  ];
}

export function createCytoscapeEngine({
  container,
  cytoscape,
  onSelect = () => {},
  onViewportChange = () => {},
  onNodeDragEnd = () => {},
  onOverlayChange = () => {},
  onHoverChange = () => {},
}) {
  let instance = null;
  // La sélection courante, tenue par l'adaptateur pour ne toucher que le delta.
  let selected = new Set();
  let synchronizingSelection = false;
  // Le nœud survolé, tenu par le criblage **du moteur**. L'adaptateur ne calcule
  // rien : il note ce que Cytoscape lui dit et le rend tel quel.
  let hovered = null;
  let hoveredEdge = null;
  let overlayFrame = null;
  let gridFrame = null;
  let detailLevel = 'full';
  let edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
  let groupBounds = [];
  let decorationZoom = 1;
  let decorationStateKey = decorationState(decorationZoom);
  let zoomStyleStateKey = zoomStyleState(decorationZoom);
  let activeColors = readEngineColors(container, COLOR_TOKENS);
  const frameWindow = container?.ownerDocument?.defaultView;
  const cancelOverlayFrame = () => {
    if (overlayFrame === null) return;
    if (frameWindow?.cancelAnimationFrame) frameWindow.cancelAnimationFrame(overlayFrame);
    else clearTimeout(overlayFrame);
    overlayFrame = null;
  };
  const cancelGridFrame = () => {
    if (gridFrame === null) return;
    if (frameWindow?.cancelAnimationFrame) frameWindow.cancelAnimationFrame(gridFrame);
    else clearTimeout(gridFrame);
    gridFrame = null;
  };
  const publishGrid = () => {
    gridFrame = null;
    if (!instance || typeof container?.style?.setProperty !== 'function') return;
    const pan = instance.pan();
    const styles = cytoscapeGridStyle({ x: pan.x, y: pan.y, zoom: instance.zoom() });
    for (const [property, value] of Object.entries(styles)) container.style.setProperty(property, value);
  };
  const scheduleGrid = () => {
    if (gridFrame !== null) return;
    if (frameWindow?.requestAnimationFrame) gridFrame = frameWindow.requestAnimationFrame(publishGrid);
    else gridFrame = setTimeout(publishGrid, 0);
  };
  // La feuille de style est reconstruite quand le régime d'encre des liens ou
  // celui des nœuds change, et à ce moment-là seulement : deux franchissements
  // sur toute la plage de zoom. C'est la même opération que le changement de
  // thème, dont le coût est déjà connu, et le seul chemin qu'offre Cytoscape
  // pour faire dépendre un style du zoom.
  const refreshZoomStyle = (zoom, { force = false } = {}) => {
    if (!instance || typeof instance.style !== 'function') return;
    const nextState = zoomStyleState(zoom);
    if (!force && nextState === zoomStyleStateKey) return;
    zoomStyleStateKey = nextState;
    instance.style(stylesheet(activeColors, edgeInk(zoom), nodesFar(zoom)));
  };
  const refreshDecorations = (zoom, { force = false } = {}) => {
    if (!instance) return;
    const nextState = decorationState(zoom);
    decorationZoom = zoom;
    if (!force && nextState === decorationStateKey) return;
    decorationStateKey = nextState;
    instance.batch(() => {
      instance.nodes().forEach((node) => {
        const data = decoratedNodeData(node.data(), node.data('imageUrl') || null, activeColors, zoom);
        for (const [name, value] of Object.entries(data)) node.data(name, value);
      });
    });
  };
  // Le point d'entrée du pointeur sur un lien survolé, en pixels du canvas :
  // l'étiquette qui nomme ses deux bouts s'y pose.
  let hoveredEdgePoint = null;
  const publishHover = () => onHoverChange({
    nodePath: hovered,
    edgeId: hoveredEdge,
    edgePoint: hoveredEdge ? hoveredEdgePoint : null,
  });
  const clearHoveredEdge = () => {
    if (!instance || !hoveredEdge) return;
    const edge = instance.$id(hoveredEdge);
    edge.removeClass('pointer-hover');
    edge.source().removeClass('pointer-endpoint');
    edge.target().removeClass('pointer-endpoint');
    hoveredEdge = null;
  };
  // Un nœud dont le repère doit survivre à la troncature : il situe la lecture
  // ou signale un défaut, et le perdre par simple ordre du document rendrait
  // la vue éloignée inutilisable.
  const isLandmark = (node) => Boolean(
    node.data('isEntry') || node.data('isHub') || node.selected(),
  );

  // Les prises d'un nœud, en pixels écran **relatifs à son centre**.
  //
  // Elles viennent de la même géométrie que la pastille peinte et que
  // l'extrémité du lien : la couche HTML ne mesure rien et ne devine rien, elle
  // transpose. C'est ce qui remplace la variable CSS `--port-inset`, jamais
  // définie, qui rendait `calc()` invalide et laissait les zones de glisser au
  // coin supérieur gauche de la carte plutôt que sur les prises.
  //
  // Elles ne sont publiées qu'au régime où la couche HTML pose réellement des
  // poignées. En dessous, rien n'est alloué — et le seuil n'est écrit qu'ici :
  // la couche HTML dessine une poignée si le moteur lui en a publié une, elle
  // ne refait pas le test. Sous ce régime, seul le nœud survolé ou sélectionné
  // en reçoit, marquées `revealed` : la couche les pose hors de la carte.
  const describePorts = (node, zoom) => {
    const revealed = zoom < PORT_HANDLE_ZOOM;
    if (revealed && !(inRevealBand(zoom) && (node.selected() || node.id() === hovered))) return null;
    const offsets = nodePortOffsets(node.data('kind'), node.data('optionSlots') ?? 1);
    return offsets.map((port) => ({
      id: port.id,
      role: port.role,
      ordinal: port.ordinal,
      dx: port.x * zoom,
      dy: port.y * zoom,
      revealed,
    }));
  };

  const describe = (node, clusterCount = 1, zoom = 1) => {
    const position = node.renderedPosition();
    return {
      path: node.id(),
      // Nombre de nœuds que cette marque représente. Un pour une marque
      // ordinaire ; davantage pour un regroupement du régime éloigné.
      clusterCount,
      x: position.x,
      y: position.y,
      width: node.renderedWidth(),
      height: node.renderedHeight(),
      label: node.data('label'),
      kind: node.data('kind'),
      groupId: node.data('groupId'),
      personalColor: node.data('personalColor') || null,
      dimmed: node.hasClass('presentation-dim'),
      degree: node.data('degree') ?? 0,
      outgoingCount: node.data('outgoingCount') ?? 0,
      hasImage: Boolean(node.data('imageUrl')),
      isEntry: Boolean(node.data('isEntry')),
      duplicated: Boolean(node.data('duplicated')),
      diagnosed: Boolean(node.data('diagnosed')),
      noIncoming: Boolean(node.data('noIncoming')),
      isolated: Boolean(node.data('isolated')),
      unreachable: Boolean(node.data('unreachable')),
      hasDangling: Boolean(node.data('hasDangling')),
      deadEnd: Boolean(node.data('deadEnd')),
      isHub: Boolean(node.data('isHub')),
      selected: node.selected(),
      linkPorts: node.data('linkPorts') ?? [],
      ports: describePorts(node, zoom),
    };
  };

  // Regroupement des avertissements par zone d'écran.
  //
  // L'entrée, la sélection et les carrefours sortent intacts : ce sont eux qui
  // situent la lecture, et les noyer dans un regroupement reviendrait à refaire
  // le défaut que ce regroupement corrige. Le parcours est stable — la première
  // marque rencontrée dans une zone la représente, et l'ordre des nœuds ne
  // change pas d'une image à l'autre — pour que deux rendus du même document
  // donnent le même dessin.
  const clusterFarLandmarks = (landmarks, host) => {
    const cell = clusterCellPx(host?.clientWidth ?? 0, host?.clientHeight ?? 0);
    const kept = [];
    const byCell = new Map();
    for (const node of landmarks) {
      if (node.data('isEntry') || node.selected() || node.data('isHub')) {
        kept.push({ node, count: 1 });
        continue;
      }
      const position = node.renderedPosition();
      const key = `${Math.floor(position.x / cell)}:${Math.floor(position.y / cell)}`;
      const existing = byCell.get(key);
      if (existing) existing.count += 1;
      else byCell.set(key, { node, count: 1 });
    }
    return kept.concat([...byCell.values()]);
  };

  const publishOverlays = () => {
    overlayFrame = null;
    // Les doubles de moteur des tests de frontière ne simulent pas la
    // géométrie du renderer. Dans l'application, Cytoscape expose toujours
    // ces primitives.
    if (!instance || typeof instance.extent !== 'function') return;
    const extent = instance.extent();
    const zoom = instance.zoom();
    const margin = OVERLAY_MARGIN_PX / Math.max(zoom, 0.001);
    const landmarks = [];
    const ordinary = [];
    // La boîte du graphe entier, en coordonnées de graphe : au régime éloigné,
    // les étiquettes des carrefours se rangent dans la marge qu'elle laisse.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    instance.nodes().forEach((node) => {
      const position = node.position();
      if (position.x < minX) minX = position.x;
      if (position.x > maxX) maxX = position.x;
      if (position.y < minY) minY = position.y;
      if (position.y > maxY) maxY = position.y;
      const inView = position.x >= extent.x1 - margin && position.x <= extent.x2 + margin
        && position.y >= extent.y1 - margin && position.y <= extent.y2 + margin;
      if (!inView) return;
      (isLandmark(node) ? landmarks : ordinary).push(node);
    });
    const room = Math.max(0, OVERLAY_BUDGET - landmarks.length);
    // Au régime éloigné seulement : une marque regroupée remplace des anneaux
    // qui se recouvriraient. Aux zooms de travail, un repère est une carte, et
    // une carte ne se regroupe pas.
    const marks = detailLevel === 'simplified' && landmarks.length > LANDMARK_MARK_BUDGET
      ? clusterFarLandmarks(landmarks, container).map(({ node, count }) => describe(node, count, zoom))
      : landmarks.map((node) => describe(node, 1, zoom));
    const nodes = marks.concat(ordinary.slice(0, room).map((node) => describe(node, 1, zoom)));
    const pan = instance.pan();
    const groups = groupBounds.map((group) => ({
      ...group,
      x: group.x * zoom + pan.x,
      y: group.y * zoom + pan.y,
      width: group.width * zoom,
      height: group.height * zoom,
    })).filter((group) => (
      group.x + group.width >= -80 && group.y + group.height >= -80
      && group.x <= container.clientWidth + 80 && group.y <= container.clientHeight + 80
    ));
    const bounds = Number.isFinite(minX) ? {
      x1: minX * zoom + pan.x,
      y1: minY * zoom + pan.y,
      x2: maxX * zoom + pan.x,
      y2: maxY * zoom + pan.y,
    } : null;
    const viewport = { width: container.clientWidth, height: container.clientHeight };
    onOverlayChange({ zoom, detailLevel, nodes, groups, bounds, viewport });
  };
  const scheduleOverlays = () => {
    if (overlayFrame !== null) return;
    if (frameWindow?.requestAnimationFrame) overlayFrame = frameWindow.requestAnimationFrame(publishOverlays);
    else overlayFrame = setTimeout(publishOverlays, 0);
  };
  const measureGroups = () => {
    if (!instance) return;
    const measured = new Map();
    const nodes = instance.nodes();
    if (typeof nodes.forEach !== 'function') {
      groupBounds = [];
      return;
    }
    nodes.forEach((node) => {
      const groupId = node.data('groupId');
      if (!groupId) return;
      const { x, y } = node.position();
      const action = node.data('kind') === NODE_KINDS.ACTION;
      const halfWidth = action ? 26 : 52;
      const halfHeight = action ? 26 : 40;
      const current = measured.get(groupId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      current.minX = Math.min(current.minX, x - halfWidth);
      current.minY = Math.min(current.minY, y - halfHeight);
      current.maxX = Math.max(current.maxX, x + halfWidth);
      current.maxY = Math.max(current.maxY, y + halfHeight);
      measured.set(groupId, current);
    });
    groupBounds = [...measured].map(([id, bounds]) => ({
      id,
      x: bounds.minX - 34,
      y: bounds.minY - 34,
      width: bounds.maxX - bounds.minX + 68,
      height: bounds.maxY - bounds.minY + 68,
    }));
  };

  const engine = {
    name: 'cytoscape',
    version: cytoscape?.version ?? 'inconnue',

    // Synchrone chez Cytoscape ; déclarée `async` pour que la frontière ait la
    // même forme chez les deux moteurs et que le banc les attende pareil.
    async mount(elements) {
      const dangling = danglingSourcePaths(elements);
      edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
      decorationZoom = 1;
      decorationStateKey = decorationState(decorationZoom);
      zoomStyleStateKey = zoomStyleState(decorationZoom);
      activeColors = readEngineColors(container, COLOR_TOKENS);
      instance = cytoscape({
        container,
        // Aucune disposition calculée, jamais : les positions viennent du DTO,
        // donc du document, de `context.editorPositions` ou du placement de
        // secours déterministe que le moteur natif calcule à la lecture pour
        // les seuls nœuds sans position. Un layout automatique déplacerait
        // aussi les nœuds **positionnés par l'auteur**, ce qu'il ne faut
        // jamais faire ; le rangement volontaire est un geste, pas une ouverture.
        layout: { name: 'preset' },
        style: stylesheet(activeColors, edgeInk(decorationZoom), nodesFar(decorationZoom)),
        // `textureOnViewport` évite de redessiner chaque nœud pendant un
        // panoramique : c'est l'optimisation que la documentation de
        // performance de Cytoscape met en premier.
        textureOnViewport: true,
        hideEdgesOnViewport: true,
        pixelRatio: 1,
        elements: {
          nodes: elements.nodes.map((node) => {
            const decoration = decoratedNodeData(node, null, activeColors, decorationZoom);
            return {
              data: {
                ...node,
                ...decoration,
                hasDangling: dangling.has(node.id),
                // Ordre des côtés comme en CSS : vertical puis horizontal.
                boundsExpansion: (({ x, y }) => [y, x])(
                  portLayerOverflow(node.kind, node.optionSlots ?? 1),
                ),
              },
              position: { x: node.x, y: node.y },
            };
          }),
          edges: plottableEdges(elements).map((edge) => ({ data: edge })),
        },
      });

      measureGroups();
      instance.on('select unselect', 'node', () => {
        if (synchronizingSelection) return;
        const paths = instance.$('node:selected').map((node) => node.id());
        selected = new Set(paths);
        onSelect(paths);
        scheduleOverlays();
      });
      instance.on('viewport', () => {
        const viewport = engine.getViewport();
        refreshDecorations(viewport.zoom);
        refreshZoomStyle(viewport.zoom);
        onViewportChange(viewport);
        scheduleGrid();
        scheduleOverlays();
      });
      // Au régime des poignées révélées, le survol décide quelles prises sont
      // publiées : la couche est republiée. Aux autres zooms, il ne change
      // rien à ce qu'elle porte.
      instance.on('mouseover', 'node', (event) => {
        hovered = event.target.id();
        publishHover();
        if (inRevealBand(instance.zoom())) scheduleOverlays();
      });
      instance.on('mouseout', 'node', (event) => {
        if (hovered === event.target.id()) {
          hovered = null;
          publishHover();
          if (inRevealBand(instance.zoom())) scheduleOverlays();
        }
      });
      instance.on('mouseover', 'edge', (event) => {
        clearHoveredEdge();
        const edge = event.target;
        hoveredEdge = edge.id();
        hoveredEdgePoint = event.renderedPosition
          ? { x: event.renderedPosition.x, y: event.renderedPosition.y }
          : null;
        edge.addClass('pointer-hover');
        edge.source().addClass('pointer-endpoint');
        edge.target().addClass('pointer-endpoint');
        publishHover();
        scheduleOverlays();
      });
      instance.on('mouseout', 'edge', (event) => {
        if (hoveredEdge !== event.target.id()) return;
        clearHoveredEdge();
        publishHover();
        scheduleOverlays();
      });
      instance.on('dragfree', 'node', (event) => {
        const node = event.target;
        // Un glisser est **local** pendant toute sa durée ; à la fin du geste,
        // **un seul** geste d'auteur part avec la position finale.
        onNodeDragEnd(node.id(), node.position());
        measureGroups();
        scheduleOverlays();
      });
      // Le canvas déplace la zone de clic ; la couche HTML suit le même nœud
      // au prochain frame, sans attendre la fin du geste.
      instance.on('position', 'node', scheduleOverlays);
      scheduleGrid();
      scheduleOverlays();
      return { nodes: instance.nodes().length, edges: instance.edges().length };
    },

    // Le thème a basculé : la feuille de style est **reconstruite**. Elle
    // n'était calculée qu'au montage, si bien qu'un passage clair/sombre
    // laissait le canvas avec la palette de l'autre thème jusqu'au prochain
    // remontage du document.
    refreshTheme() {
      if (!instance || typeof instance.style !== 'function') return;
      activeColors = readEngineColors(container, COLOR_TOKENS);
      refreshZoomStyle(decorationZoom, { force: true });
      refreshDecorations(decorationZoom, { force: true });
      scheduleOverlays();
    },

    async setViewport({ x, y, zoom }) {
      instance?.viewport({ zoom, pan: { x, y } });
      scheduleGrid();
    },

    getViewport() {
      if (!instance) return { x: 0, y: 0, zoom: 1 };
      const pan = instance.pan();
      return { x: pan.x, y: pan.y, zoom: instance.zoom() };
    },

    async focusNode(path) {
      const node = instance?.$id(path);
      if (!node || node.length === 0) return false;
      instance.center(node);
      return true;
    },

    // Le nœud sous le pointeur, tel que le moteur l'a criblé. Rendu synchrone :
    // un dépôt de média l'interroge à la fin d'un glisser, et un aller-retour
    // asynchrone ferait répondre sur un survol déjà périmé.
    nodeAtPointer() {
      return instance ? hovered : null;
    },

    edgeAtPointer() {
      return instance ? hoveredEdge : null;
    },

    // Rejoue chez Cytoscape une molette que la couche HTML a reçue. Le moteur
    // écoute `wheel` sur son conteneur : une copie de l'événement lui est
    // adressée, avec le même point, les mêmes deltas et les mêmes modificateurs
    // (le pincement d'un pavé tactile arrive en ctrl + molette). Cytoscape
    // applique alors son zoom habituel, centré sur le pointeur.
    forwardWheel(event) {
      if (!instance || typeof container?.dispatchEvent !== 'function') return false;
      const WheelCtor = container.ownerDocument?.defaultView?.WheelEvent ?? globalThis.WheelEvent;
      if (typeof WheelCtor !== 'function') return false;
      const copy = new WheelCtor('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      container.dispatchEvent(copy);
      // Cytoscape retient la page de défiler quand il traite la molette.
      if (copy.defaultPrevented) event.preventDefault();
      return true;
    },

    setNodeImage(path, url) {
      const node = instance?.$id(path);
      if (!node || node.length === 0) return;
      node.data('imageUrl', url ?? '');
      const decoration = decoratedNodeData(node.data(), url || null, activeColors, decorationZoom);
      for (const [name, value] of Object.entries(decoration)) node.data(name, value);
      scheduleOverlays();
    },

    async setSelection(paths) {
      if (!instance) return;
      const wanted = new Set(paths);
      // Seul le **delta** est touché. Parcourir les 9 121 nœuds à chaque
      // sélection coûterait une passe complète par clic, et le banc
      // mesurerait alors l'adaptateur au lieu du moteur.
      synchronizingSelection = true;
      try {
        instance.batch(() => {
          for (const path of selected) {
            if (!wanted.has(path)) instance.$id(path).unselect();
          }
          for (const path of wanted) {
            if (!selected.has(path)) instance.$id(path).select();
          }
        });
        selected = wanted;
        scheduleOverlays();
      } finally { synchronizingSelection = false; }
    },

    async setPresentation(presentation = null) {
      if (!instance) return;
      const nodePaths = new Set(presentation?.nodePaths ?? []);
      const edgeIds = new Set(presentation?.edgeIds ?? []);
      const hasFocus = Boolean(presentation?.mode);
      instance.batch(() => {
        const nodes = instance.nodes();
        const edges = instance.edges();
        nodes.removeClass('presentation-dim');
        edges.removeClass('presentation-dim presentation-trace');
        if (hasFocus) {
          nodes.addClass('presentation-dim');
          edges.addClass('presentation-dim');
          for (const path of nodePaths) instance.$id(path).removeClass('presentation-dim');
          for (const id of edgeIds) instance.$id(id).removeClass('presentation-dim');
        }
        if (presentation?.mode === 'playback') {
          for (const id of edgeIds) instance.$id(id).addClass('presentation-trace');
        }
      });
      scheduleOverlays();
    },

    async setEdgeVisibility(visibility = DEFAULT_EDGE_VISIBILITY) {
      if (!instance) return;
      const changedGroups = Object.values(EDGE_VISIBILITY_GROUPS).filter((group) => (
        (visibility?.[group] !== false) !== (edgeVisibility[group] !== false)
      ));
      if (changedGroups.length === 0) return;
      instance.batch(() => {
        for (const group of changedGroups) {
          const edges = instance.edges(`[visibilityGroup = "${group}"]`);
          if (visibility?.[group] === false) edges.addClass('legend-hidden');
          else edges.removeClass('legend-hidden');
        }
      });
      edgeVisibility = Object.fromEntries(Object.values(EDGE_VISIBILITY_GROUPS).map((group) => (
        [group, visibility?.[group] !== false]
      )));
    },

    async setDetailLevel(level) {
      if (!instance) return;
      detailLevel = level;
      instance.batch(() => {
        const nodes = instance.nodes();
        const edges = instance.edges();
        for (const name of ['no-labels', 'no-thumbs', 'simplified']) {
          nodes.removeClass(name);
          edges.removeClass(name);
        }
        const className = { noLabels: 'no-labels', noThumbs: 'no-thumbs', simplified: 'simplified' }[level];
        if (className) {
          nodes.addClass(className);
          edges.addClass(className);
        }
      });
      scheduleOverlays();
    },

    resize() {
      instance?.resize();
      scheduleGrid();
      scheduleOverlays();
    },

    async fitContent(padding = 48) {
      instance?.fit(undefined, padding);
    },

    async exportImage() {
      // `full: false` : la vue telle qu'elle est cadrée, pas le graphe entier.
      // C'est ce que l'auteur voit qui doit être montré.
      //
      // Ce PNG est le rendu **du moteur seul**. Les noms, pastilles, zones de
      // groupe et repères de la maquette vivent dans la couche HTML, et une
      // capture de recette doit les porter aussi : c'est `captureGraphSurface`
      // qui compose les deux, à partir de ce PNG et du même relevé de
      // surimpressions que l'écran affiche.
      //
      // Le fond est **celui du thème courant**, relu sur le conteneur. Il était
      // écrit en dur à la valeur sombre : une capture prise en thème clair
      // rendait des cartes claires sur un fond sombre, c'est-à-dire un rendu qui
      // n'a jamais existé à l'écran. Une preuve de recette ne peut pas être
      // moitié d'un thème et moitié de l'autre.
      return instance?.png({
        output: 'base64uri',
        full: false,
        bg: surfaceBackground(container),
      }) ?? null;
    },

    destroy() {
      // `destroy` retire les écouteurs et libère le canvas. C'est le point que
      // le protocole éprouve par destruction/recréation du composant.
      cancelOverlayFrame();
      cancelGridFrame();
      for (const property of Object.keys(cytoscapeGridStyle())) container?.style?.removeProperty?.(property);
      onOverlayChange({ zoom: 1, detailLevel: 'full', nodes: [], groups: [] });
      instance?.destroy();
      instance = null;
      selected = new Set();
      hovered = null;
      hoveredEdge = null;
      onHoverChange({ nodePath: null, edgeId: null });
      groupBounds = [];
      decorationZoom = 1;
      decorationStateKey = decorationState(decorationZoom);
      zoomStyleStateKey = zoomStyleState(decorationZoom);
    },
  };

  return assertEngineContract(engine);
}
