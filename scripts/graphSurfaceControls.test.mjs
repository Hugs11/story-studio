// Les corrections de fiabilité de la vue du graphe à plat : couleurs
// acceptées par le moteur, miniature fidèle et navigable, zoom ancré au
// centre, capture qui montre le rendu complet.
//
// Ces essais sont des rendus statiques et des appels de gestionnaires sous
// Node : ils établissent la géométrie et les contrats, pas la qualité visuelle
// ni la fluidité du pan/zoom, qui restent à vérifier dans Tauri.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { readEngineColors, resetColorCache, toRenderableColor } from '../src/components/AdvancedGraphCanvas/engines/engineColors.js';
import { buildOverview, overviewCamera } from '../src/store/advancedGraphView/graphOverview.js';
import { nodeRoles } from '../src/store/advancedGraphView/graphRoles.js';
import { paintOverlay } from '../src/components/AdvancedGraphCanvas/graphSurfaceCapture.js';

const { elementByAttribute, mountSurface } = await import('./chromeBench.mjs');
const { GraphSurfaceControls } = await import('../src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx');

// Une WebView d'essai : elle convertit `oklch(...)` et `color-mix(...)` comme
// un navigateur le fait, et refuse ce qu'elle ne connaît pas en laissant le
// témoin en place — le comportement exact du vrai `fillStyle`.
function fakeView(known) {
  let current = [0, 0, 0, 255];
  const context = {
    set fillStyle(value) {
      const resolved = known[value] ?? (/^#[0-9a-f]{6}$/i.test(value) ? hexToRgba(value) : null);
      if (resolved) current = resolved;
    },
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: current }),
  };
  return {
    document: { createElement: () => ({ getContext: () => context }) },
    getComputedStyle: (element) => ({ getPropertyValue: (name) => element.tokens[name] ?? '' }),
  };
}

function hexToRgba(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

test('les couleurs modernes du thème sont converties avant d’atteindre le moteur', () => {
  resetColorCache();
  const view = fakeView({
    'oklch(0.74 0.115 50)': [215, 155, 102, 255],
    'color-mix(in srgb, oklch(0.82 0.15 92) 55%, #36364a)': [140, 121, 62, 200],
  });
  // Le parseur de Cytoscape refuse ces deux syntaxes telles quelles : la
  // règle entière tombait, et la carte perdait sa couleur alors que la couche
  // HTML, elle, l'affichait.
  assert.equal(toRenderableColor('oklch(0.74 0.115 50)', view), '#d79b66');
  assert.equal(
    toRenderableColor('color-mix(in srgb, oklch(0.82 0.15 92) 55%, #36364a)', view),
    'rgba(140, 121, 62, 0.784)',
  );
});

test('une couleur que la WebView refuse laisse l’adaptateur sur son repli déclaré', () => {
  resetColorCache();
  const view = fakeView({});
  // `fillStyle` ignore une valeur invalide : sans les deux témoins, on aurait
  // pris la couleur précédente pour une conversion réussie.
  assert.equal(toRenderableColor('couleur-inconnue(42)', view), null);

  const container = { tokens: { '--accent': 'couleur-inconnue(42)' }, ownerDocument: { defaultView: view } };
  const colors = readEngineColors(container, { accent: ['--accent', '#d79b66'] });
  assert.equal(colors.accent, '#d79b66');
});

// Une scène et un moteur d'essai : la miniature ne parle qu'à la frontière du
// moteur, jamais à Cytoscape.
function surface({ entries, viewport, host = { width: 800, height: 400 } }) {
  const calls = [];
  const engine = {
    getViewport: () => viewport,
    setViewport: (next) => { calls.push(next); },
    fitContent: () => {},
  };
  const index = graphOf(entries);
  const hostRef = { current: { clientWidth: host.width, clientHeight: host.height } };
  const rendered = mountSurface(React.createElement(GraphSurfaceControls, {
    engineRef: { current: engine }, index, viewport, hostRef,
  }));
  return { ...rendered, calls };
}

const stage = (path, x, y) => ({
  path, kind: 'stage', label: { label: path, isFallback: false },
  node: { layout: { x, y }, squareOne: { value: path === 'a' }, uniqueId: true },
});

const graphOf = (entries) => ({ entries, diagnosticsByNode: new Map(), view: { edges: [] } });

test('la légende filtre les quatre familles de liens et ne présente plus Entrée comme un chemin', () => {
  const changes = [];
  const engine = {
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport() {},
    fitContent() {},
  };
  const index = graphOf([]);
  const rendered = mountSurface(React.createElement(GraphSurfaceControls, {
    engineRef: { current: engine }, index, viewport: { x: 0, y: 0, zoom: 1 },
    hostRef: { current: { clientWidth: 800, clientHeight: 400 } },
    onEdgeVisibilityChange: (visibility) => changes.push(visibility),
  }));
  const filters = rendered.elements.filter((element) => element.props?.type === 'checkbox');
  assert.deepEqual(filters.map((filter) => filter.props['aria-label']), [
    'Afficher les liens de structure',
    'Afficher les retours',
    'Afficher les retours par défaut de la Lunii',
    'Afficher les liens à sélection aléatoire',
  ]);
  assert.ok(filters.every((filter) => filter.props.checked));

  filters[1].props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(changes.at(-1), {
    structure: true, returns: false, 'device-returns': true, random: true,
  });
});

test('la miniature garde un rapport largeur/hauteur commun aux deux axes', () => {
  // Les axes étaient normalisés séparément : un graphe dix fois plus large que
  // haut s'affichait étiré sur toute la hauteur, et la miniature montrait une
  // disposition qui n'était pas celle du canvas.
  const overview = buildOverview(graphOf([stage('a', 0, 0), stage('b', 1000, 0), stage('c', 0, 100)]));
  const byPath = new Map(overview.marks.map((mark) => [mark.path, mark]));
  const horizontal = byPath.get('b').px - byPath.get('a').px;
  const vertical = byPath.get('c').py - byPath.get('a').py;
  assert.ok(horizontal > 0 && vertical > 0);
  // 1000 unités de graphe en X contre 100 en Y : à échelle commune, l'écart
  // horizontal reste exactement dix fois l'écart vertical.
  assert.ok(Math.abs(horizontal / vertical - 10) < 1e-9, `rapport ${horizontal / vertical}`);
});

test('la miniature suit un nœud déplacé avant que le document ne le reprenne', () => {
  const entries = [stage('a', 0, 0), stage('b', 400, 0)];
  const before = buildOverview(graphOf(entries));
  const after = buildOverview(graphOf(entries), new Map([['b', { x: 400, y: 400 }]]));
  const at = (overview, path) => overview.marks.find((mark) => mark.path === path);
  assert.equal(at(before, 'b').py, at(before, 'a').py, 'même ordonnée avant le glisser');
  assert.ok(at(after, 'b').py > at(after, 'a').py, 'la marque a suivi le glisser');
});

test('le cadre de caméra passe par la même projection que les marques', () => {
  const overview = buildOverview(graphOf([stage('a', 0, 0), stage('b', 400, 300)]));
  const camera = overviewCamera(overview, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 400 });
  // Le coin haut-gauche de la caméra est le point (0, 0) du graphe, projeté
  // exactement comme l'est la marque du nœud `a`, qui s'y trouve.
  const origin = overview.project(0, 0);
  assert.ok(Math.abs(camera.x - origin.x) < 1e-9);
  assert.ok(Math.abs(camera.y - origin.y) < 1e-9);
  // Et la largeur suit la même échelle : 800 pixels de scène à zoom 1.
  assert.ok(Math.abs(camera.width - 800 * overview.scale) < 1e-9);
});

test('un clic dans la miniature amène le point visé au centre de la scène', () => {
  const { elements, calls } = surface({
    entries: [stage('a', 0, 0), stage('b', 1000, 500)],
    viewport: { x: 0, y: 0, zoom: 2 },
  });
  const svg = elementByAttribute(elements, 'role', 'application');
  assert.ok(svg, 'la miniature est un contrôle, pas un dessin aria-hidden');
  svg.props.onPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 106,
    clientY: 52,
    currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 212, height: 104 }) },
  });
  assert.equal(calls.length, 1, 'la caméra a bougé');
  // Le centre de la miniature est le centre du graphe : ramené au centre de
  // la scène, il donne une caméra où (500, 250) tombe à (400, 200).
  const moved = calls[0];
  assert.equal(moved.zoom, 2, 'le déplacement ne change jamais l’échelle');
  assert.ok(Math.abs(500 * moved.zoom + moved.x - 400) < 0.5, `x = ${moved.x}`);
  assert.ok(Math.abs(250 * moved.zoom + moved.y - 200) < 0.5, `y = ${moved.y}`);
});

test('le zoom des boutons garde le centre visible stable', () => {
  const viewport = { x: -100, y: -50, zoom: 1 };
  const { elements, calls } = surface({ entries: [stage('a', 0, 0), stage('b', 400, 300)], viewport });
  const before = elementByAttribute(elements, 'aria-label', 'Agrandir');
  before.props.onClick();
  const next = calls[0];
  // Le point du graphe qui était au centre de la scène y reste : c'est ce que
  // la multiplication seule du zoom ne faisait pas, elle ancrait la vue sur
  // l'origine écran.
  const centerBefore = { x: (400 - viewport.x) / viewport.zoom, y: (200 - viewport.y) / viewport.zoom };
  assert.ok(Math.abs(centerBefore.x * next.zoom + next.x - 400) < 0.001);
  assert.ok(Math.abs(centerBefore.y * next.zoom + next.y - 200) < 0.001);
  assert.ok(next.zoom > viewport.zoom);
});

test('la borne basse du zoom ne remonte pas une vue déjà cadrée à 1 %', () => {
  const { elements, calls } = surface({
    entries: [stage('a', 0, 0), stage('b', 376960, 400)],
    viewport: { x: 0, y: 0, zoom: 0.01 },
  });
  elementByAttribute(elements, 'aria-label', 'Réduire').props.onClick();
  assert.ok(calls[0].zoom < 0.01, `zoom ${calls[0].zoom} : un plancher à 2 % faisait sauter la vue`);
});

test('la capture compose le rendu du moteur et la couche de surimpressions', () => {
  // Le PNG du moteur seul perdait noms, pastilles et zones de groupe : ce
  // n'était plus la preuve du rendu qu'il annonçait.
  const painted = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {}, translate() {}, scale() {},
    measureText: () => ({ width: 40 }),
    fillText: (text) => painted.push(text),
  };
  paintOverlay(context, {
    detailLevel: 'full',
    groups: [{ id: 'forêt', x: 0, y: 0, width: 200, height: 100 }],
    nodes: [
      { path: '/a', kind: 'stage', label: 'Accueil', x: 60, y: 60, width: 104, height: 80, isEntry: true },
      { path: '/b', kind: 'action', label: 'Choix', x: 220, y: 60, width: 52, height: 52, outgoingCount: 3 },
    ],
  });
  assert.ok(painted.includes('FORÊT'), 'la zone de groupe est peinte avec son nom');
  assert.ok(painted.includes('RACINE'), 'la pastille de rôle est peinte');
  assert.ok(painted.includes('Accueil'), 'le nom sous la carte est peint');
  assert.ok(painted.includes('3'), 'le compte de sorties de l’Action est peint au-dessus du losange');
});

test('la capture masque le badge d’entrée avec les autres libellés', () => {
  const painted = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {}, translate() {}, scale() {},
    measureText: () => ({ width: 40 }),
    fillText: (text) => painted.push(text),
  };
  const node = { path: '/a', kind: 'stage', label: 'Accueil', x: 60, y: 60, width: 104, height: 80, isEntry: true };

  paintOverlay(context, { detailLevel: 'noLabels', groups: [], nodes: [node] });
  assert.deepEqual(painted, [], 'ni le badge ni le nom ne survivent à noLabels');

  paintOverlay(context, { detailLevel: 'simplified', groups: [], nodes: [node] });
  assert.deepEqual(painted, ['RACINE'], 'le repère d’entrée reste peint en vue très éloignée');
});

test('au régime éloigné, la capture peint les repères en pixels écran', () => {
  const painted = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {},
    measureText: () => ({ width: 40 }),
    fillText: (text) => painted.push(text),
  };
  paintOverlay(context, {
    detailLevel: 'simplified',
    groups: [{ id: 'forêt', x: 0, y: 0, width: 200, height: 100 }],
    nodes: [
      { path: '/a', kind: 'stage', label: 'Accueil', x: 60, y: 60, width: 10, height: 6, isEntry: true },
      { path: '/h', kind: 'stage', label: 'Carrefour', x: 300, y: 60, width: 10, height: 6, isHub: true, degree: 31 },
      { path: '/x', kind: 'stage', label: 'Quelconque', x: 120, y: 60, width: 10, height: 6 },
    ],
  });
  assert.deepEqual(painted, ['RACINE', 'Carrefour · 31 liens']);
});

test('la capture peint la couche de surimpressions avec la palette du thème', () => {
  // Le PNG du moteur prend le fond du thème courant. La couche peinte, elle,
  // gardait des couleurs sombres écrites en dur : une capture en thème clair
  // composait un rendu clair avec des pastilles et des noms peints pour le
  // sombre — moitié d'un thème, moitié de l'autre.
  const strokes = [];
  const fills = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() { strokes.push(context.strokeStyle); }, fill() { fills.push(context.fillStyle); },
    fillRect() {}, setLineDash() {},
    measureText: (text) => ({ width: String(text).length * 4 }),
    fillText() {},
    strokeStyle: null, fillStyle: null, globalAlpha: 1,
  };
  const clair = {
    surface: '#ebeef3', secondary: '#4a4a5e', accent: '#a8603a', accentText: '#8a4a28',
    accentBorder: '#c79a78', focus: '#b8703f', warning: '#8a6f10', warningBorder: '#c0a95a',
  };
  paintOverlay(context, {
    detailLevel: 'full',
    groups: [],
    nodes: [
      { path: '/a', kind: 'stage', label: 'Accueil', x: 300, y: 300, width: 104, height: 80, isEntry: true, selected: true },
    ],
  }, clair);
  assert.ok(fills.includes(clair.surface), 'le fond de la pastille vient du thème');
  assert.ok(strokes.includes(clair.accentBorder), 'le contour de la pastille vient du thème');
  assert.ok(strokes.includes(clair.accent), 'le cadre de sélection vient du thème');
  assert.ok(
    !fills.includes('rgba(10, 10, 14, .82)'),
    'plus aucune couleur sombre écrite en dur',
  );
});

test('au régime éloigné, les diagnostics ne laissent que les repères de navigation', () => {
  const painted = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {},
    measureText: (text) => ({ width: String(text).length * 8 }),
    fillText: (text) => painted.push(text),
  };
  paintOverlay(context, {
    detailLevel: 'simplified',
    groups: [],
    nodes: [
      { path: '/a', kind: 'stage', label: 'Accueil', x: 60, y: 60, width: 10, height: 6, isEntry: true },
      // Une zone qui rassemble dix-sept nœuds à corriger.
      { path: '/w', kind: 'stage', label: 'Écran 3867', x: 200, y: 60, width: 10, height: 6, diagnosed: true, clusterCount: 17 },
      // Un avertissement isolé : anneau seul, sans nom.
      { path: '/s', kind: 'stage', label: 'Écran 4001', x: 260, y: 60, width: 10, height: 6, diagnosed: true },
      { path: '/h', kind: 'stage', label: 'Carrefour', x: 320, y: 60, width: 10, height: 6, isHub: true, degree: 31 },
    ],
  });
  assert.deepEqual(painted, ['RACINE', 'Carrefour · 31 liens']);
});

test('la capture écrête ses textes comme la feuille de style', () => {
  // La couche HTML borne le nom d'une carte à 112 px avec `text-overflow`.
  // `fillText` ne borne rien : un libellé de repli qui vaut un UUID de 36
  // caractères était peint sur trois fois la largeur de sa carte, et la capture
  // montrait un enchevêtrement que l'écran n'a jamais affiché. Une preuve de
  // recette qui charge le rendu est aussi fausse qu'une preuve qui le flatte.
  const painted = [];
  // Une police de mesure simple et explicite : 8 px par caractère. Le nom tient
  // donc 14 caractères dans ses 112 px.
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {},
    measureText: (text) => ({ width: String(text).length * 8 }),
    fillText: (text) => painted.push(text),
  };
  const uuid = '0f0e2441-1d3e-4a8b-9c77-000000000ec0';
  paintOverlay(context, {
    detailLevel: 'full',
    groups: [],
    nodes: [
      {
        path: '/a', kind: 'stage', label: uuid, x: 300, y: 300,
        width: 104, height: 80, hasDangling: true,
      },
    ],
  });
  const label = painted.find((text) => text.startsWith('0f0e2441'));
  assert.ok(label, 'le nom de la carte est peint');
  assert.ok(label.length < uuid.length, `le nom est écrêté : ${label}`);
  assert.ok(label.endsWith('…'), `le nom écrêté porte des points de suspension : ${label}`);
  assert.ok(context.measureText(label).width <= 112, 'le nom tient dans les 112 px de la feuille de style');

  assert.equal(painted.find((text) => text.startsWith('DESTINATI')), undefined,
    'la capture ne répète plus les blocages de la pastille commune');
});

test('au régime éloigné, le nom d’un repère est écrêté à sa borne', () => {
  const painted = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc() {}, stroke() {}, fill() {}, fillRect() {}, setLineDash() {},
    measureText: (text) => ({ width: String(text).length * 8 }),
    fillText: (text) => painted.push(text),
  };
  paintOverlay(context, {
    detailLevel: 'simplified',
    groups: [],
    nodes: [
      {
        path: '/h', kind: 'stage', label: 'Un carrefour au nom interminable qui dépasse la borne',
        x: 90, y: 60, width: 10, height: 6, isHub: true, degree: 31,
      },
    ],
  });
  assert.equal(painted.length, 1);
  assert.ok(painted[0].endsWith('…'), `le repère est écrêté : ${painted[0]}`);
  assert.ok(context.measureText(painted[0]).width <= 220, 'le repère tient dans ses 220 px');
});

test('un pack sans entrée exploitable ne transforme pas la miniature en aplat', () => {
  // « Inaccessible » peut désigner presque tous les nœuds quand l'entrée est
  // cassée. Ce rôle reste compté et filtrable dans la liste, mais ne pose
  // aucune marque de repère — et le budget de marques tient quoi qu'il
  // arrive.
  const entries = Array.from({ length: 3000 }, (_, position) => ({
    path: `n${position}`,
    kind: 'stage',
    label: { label: `n${position}`, isFallback: false },
    node: { layout: { x: position * 12, y: (position % 40) * 12 }, squareOne: { value: position === 0 }, uniqueId: true },
  }));
  const overview = buildOverview(graphOf(entries));
  assert.ok(overview.marks.length <= 400, `marques rendues : ${overview.marks.length}`);
  assert.equal(overview.total, 3000, 'le compte total reste dit');
  // Les 2 999 nœuds isolés portent bien le rôle ; ce sont les marques qui
  // sont bornées, pas le diagnostic.
  assert.equal(nodeRoles(graphOf(entries)).counts.isolated, 3000);
});

function toolbar(props = {}) {
  return mountSurface(React.createElement(GraphSurfaceControls, {
    engineRef: { current: { getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport() {}, fitContent() {} } },
    index: graphOf([stage('a', 0, 0), stage('b', 200, 0)]),
    viewport: { x: 0, y: 0, zoom: 1 },
    hostRef: { current: { clientWidth: 800, clientHeight: 400 } },
    ...props,
  }));
}

test('Ranger et la vue d’ensemble rejoignent la colonne des commandes', () => {
  const arrangement = { busy: false, failure: null, disabled: false, arrange: async () => true };
  const { html } = toolbar({ arrangement, onToggleOverview: () => {} });
  const column = html.slice(html.indexOf('advanced-graph-camera'), html.indexOf('advanced-graph-legend'));
  assert.match(column, /advanced-graph-tools/);
  assert.match(column, /aria-label="Ranger le graphe"/);
  assert.match(column, /aria-label="Vue d’ensemble"/);
  // Le rangement ne flotte plus seul hors de la colonne.
  assert.doesNotMatch(html.slice(html.indexOf('advanced-graph-legend')), /advanced-layout-control/);
});

test('la vue d’ensemble se replie par sa bascule ou par sa croix', () => {
  let toggles = 0;
  const onToggleOverview = () => { toggles += 1; };

  const open = toolbar({ overviewOpen: true, onToggleOverview });
  const toggle = open.elements.find((element) => element.props?.className?.includes('advanced-graph-tools__overview'));
  assert.equal(toggle.props['aria-pressed'], true);
  assert.match(open.html, /advanced-graph-overview__title/);
  assert.doesNotMatch(open.html, /advanced-graph-overview__count/);
  const close = open.elements.find((element) => element.props?.['aria-label'] === 'Fermer la vue d’ensemble');
  close.props.onClick();
  toggle.props.onClick();
  assert.equal(toggles, 2);

  const folded = toolbar({ overviewOpen: false, onToggleOverview });
  assert.doesNotMatch(folded.html, /advanced-graph-overview__title/, 'repliée, elle n’est pas montée');
  const pressed = folded.elements.find((element) => element.props?.className?.includes('advanced-graph-tools__overview'));
  assert.equal(pressed.props['aria-pressed'], false);
});

test('sans bascule, la vue d’ensemble reste ouverte et ne propose ni bouton ni croix', () => {
  const { html } = toolbar();
  assert.match(html, /advanced-graph-overview__title/);
  assert.doesNotMatch(html, /advanced-graph-tools__overview/);
  assert.doesNotMatch(html, /Fermer la vue d’ensemble/);
});

test('les boutons de la colonne annoncent la touche effective de leur commande', () => {
  const arrangement = { busy: false, failure: null, disabled: false, arrange: async () => true };
  const { elements } = toolbar({ arrangement, onToggleOverview: () => {} });
  // Sans fournisseur, ce sont les libellés par défaut ; l'application fournit
  // ceux que l'auteur a configurés, par le même contexte. Ils vivent dans les
  // bulles de l'application, pas dans un `title` natif.
  const bubbles = elements.filter((element) => element.props?.asChild).map((element) => element.props.text);
  assert.ok(bubbles.includes('Agrandir (+)'));
  assert.ok(bubbles.includes('Réduire (-)'));
  assert.ok(bubbles.includes('Cadrer tout le graphe (0)'));
  assert.ok(bubbles.includes('Ranger le graphe en suivant le parcours de l’histoire (Ctrl+Shift+R)'));
  assert.ok(!elements.some((element) => typeof element.props?.title === 'string' && element.type === 'button'));
  assert.ok(bubbles.includes('Replier la vue d’ensemble (M)'));
});

test('un rangement en cours ou refusé se lit sur le bouton, quel que soit son déclencheur', () => {
  const busy = toolbar({ arrangement: { busy: true, failure: null, disabled: false, arrange: async () => true } });
  assert.match(busy.html, /aria-label="Rangement…"/);
  const refused = toolbar({
    arrangement: { busy: false, failure: 'Le rangement a été refusé : rien n’a été modifié.', disabled: false, arrange: async () => false },
  });
  assert.match(refused.html, /role="alert"[^>]*>Le rangement a été refusé/);
});
