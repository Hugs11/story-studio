import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { graphRenderTier, GRAPH_RENDER_TIERS } from '../src/components/AdvancedGraphCanvas/useGraphCanvasEngine.js';
import {
  NODE_GEOMETRY,
  nodePortOffsets,
  optionPortOffset,
  PORT_RADIUS,
  PORT_ROLES,
  portLayerBox,
  toEngineElements,
} from '../src/components/AdvancedGraphCanvas/engines/engineContract.js';
import {
  actionCountFontPx,
  linkHandlePx,
  nodeLabelWidthPx,
  portDotPx,
  REVEALED_HANDLE,
  revealedHandleOffset,
} from '../src/components/AdvancedGraphCanvas/nodeOverlayMetrics.js';
import { nodeRoles } from '../src/store/advancedGraphView/graphRoles.js';
import { searchGraph, SEARCH_SCOPES } from '../src/store/advancedGraphView/graphSearch.js';

const { mountSurface } = await import('./chromeBench.mjs');
const { GraphGroupOverlays, GraphNodeOverlays } = await import('../src/components/AdvancedGraphCanvas/GraphNodeOverlays.jsx');

test('les quatre régimes visuels changent aux trois seuils du handoff', () => {
  assert.equal(graphRenderTier(1), GRAPH_RENDER_TIERS.FULL);
  assert.equal(graphRenderTier(0.30), GRAPH_RENDER_TIERS.FULL);
  assert.equal(graphRenderTier(0.299), GRAPH_RENDER_TIERS.NO_LABELS);
  assert.equal(graphRenderTier(0.051), GRAPH_RENDER_TIERS.NO_LABELS);
  assert.equal(graphRenderTier(0.049), GRAPH_RENDER_TIERS.NO_THUMBS);
  assert.equal(graphRenderTier(0.03), GRAPH_RENDER_TIERS.NO_THUMBS);
  assert.equal(graphRenderTier(0.029), GRAPH_RENDER_TIERS.SIMPLIFIED);
});

test('noms, compteur et poignées gardent une taille utile jusqu’à 30 %', () => {
  // Le nom ne déborde jamais sur son voisin : 180 unités sur un pas de 200.
  assert.equal(nodeLabelWidthPx(1), 112);
  assert.equal(nodeLabelWidthPx(0.45), 81);
  assert.equal(nodeLabelWidthPx(0.30), 54);
  // Le compteur ne suit plus le losange : 11 px à 100 %, jamais sous 8 px.
  assert.equal(actionCountFontPx(1), 11);
  assert.equal(actionCountFontPx(0.30), 8);
  // La poignée rétrécit avec la carte, sans descendre sous 12 px.
  assert.equal(linkHandlePx(1), 22);
  assert.equal(linkHandlePx(0.40), 16);
  assert.equal(linkHandlePx(0.30), 12);
  assert.equal(linkHandlePx(Number.NaN), 22);
});

test('la pastille d’une poignée garde sa taille peinte, jamais sous 8 px', () => {
  assert.equal(portDotPx(1), 9);
  assert.equal(portDotPx(2), 18);
  // 2,7 px peints à 30 % : la pastille visible est relevée.
  assert.equal(portDotPx(0.30), 8);
  assert.equal(portDotPx(Number.NaN), 9);
});

test('une poignée révélée se pose hors de la carte, dans le prolongement de sa prise', () => {
  const card = { width: 21, height: 16 };
  const beyond = (half) => half + REVEALED_HANDLE.GAP + (REVEALED_HANDLE.SIZE / 2);
  // OK à droite, Accueil dessous, prise d'ajout d'une Liste à droite même
  // décalée sur son rail.
  assert.deepEqual(revealedHandleOffset(card, { dx: 11, dy: 0 }), { x: beyond(10.5), y: 0 });
  assert.deepEqual(revealedHandleOffset(card, { dx: 0, dy: 8.3 }), { x: 0, y: beyond(8) });
  assert.deepEqual(revealedHandleOffset(card, { dx: 5.6, dy: 2.2 }), { x: beyond(10.5), y: 0 });
});

test('le contrat prépare degrés, carrefours, détachés et culs-de-sac une seule fois', () => {
  const stage = (path, entry = false) => ({ path, kind: 'stage', label: { label: path, isFallback: false }, node: {
    layout: { x: 0, y: 0 }, squareOne: { value: entry }, uniqueId: true,
  } });
  const entries = [stage('a', true), stage('b'), stage('c'), stage('d')];
  const index = {
    entries, diagnosticsByNode: new Map(),
    view: { edges: [
      { edgeId: 'ab', kind: 'stage-ok', from: 'a', to: 'b' },
      { edgeId: 'cb', kind: 'stage-ok', from: 'c', to: 'b' },
      { edgeId: 'db', kind: 'stage-ok', from: 'd', to: 'b' },
    ] },
  };
  const nodes = toEngineElements(index).nodes;
  assert.equal(nodes.find((node) => node.id === 'b').incomingCount, 3);
  assert.equal(nodes.find((node) => node.id === 'b').deadEnd, true);
  assert.equal(nodes.find((node) => node.id === 'c').noIncoming, true);
  assert.equal(nodes.find((node) => node.id === 'b').isHub, true);
  // Un seul lien ne fait pas un carrefour, même quand il reste des places.
  assert.equal(nodes.find((node) => node.id === 'c').isHub, false);
});

test('une destination réservée sans cible n’est pas comptée comme une sortie', () => {
  // Une Action créée dans le graphe reçoit une première destination vide, pour
  // être raccordée avant que l'Écran suivant existe. Son compteur affichait 1.
  const action = (path) => ({ path, kind: 'action', label: { label: path, isFallback: false }, node: {
    layout: { x: 0, y: 0 }, uniqueId: true,
  } });
  const stage = (path) => ({ path, kind: 'stage', label: { label: path, isFallback: false }, node: {
    layout: { x: 0, y: 0 }, squareOne: { value: true }, uniqueId: true,
  } });
  const index = {
    entries: [stage('s'), action('vide'), action('mixte')],
    diagnosticsByNode: new Map(),
    view: { edges: [
      { edgeId: 'r', kind: 'action-option', from: 'vide', to: null, ordinal: 0 },
      { edgeId: 'm0', kind: 'action-option', from: 'mixte', to: 's', ordinal: 0 },
      { edgeId: 'm1', kind: 'action-option', from: 'mixte', to: null, ordinal: 1 },
    ] },
  };
  const nodes = new Map(toEngineElements(index).nodes.map((node) => [node.id, node]));
  assert.equal(nodes.get('vide').outgoingCount, 0);
  assert.equal(nodes.get('mixte').outgoingCount, 1, 'seule la destination raccordée compte');
  const roles = nodeRoles(index);
  assert.equal(roles.of('vide').dangling, true, 'elle reste signalée à raccorder');
  assert.equal(roles.of('vide').degree, 0);
  assert.equal(roles.of('mixte').dangling, true);
});

test('un nœud de passage n’est pas un carrefour, même sur un petit pack', () => {
  const stage = (path, entry = false) => ({ path, kind: 'stage', label: { label: path, isFallback: false }, node: {
    layout: { x: 0, y: 0 }, squareOne: { value: entry }, uniqueId: true,
  } });
  const index = {
    entries: [stage('a', true), stage('b'), stage('c')],
    diagnosticsByNode: new Map(),
    view: { edges: [
      { edgeId: 'ab', kind: 'stage-ok', from: 'a', to: 'b' },
      { edgeId: 'bc', kind: 'stage-ok', from: 'b', to: 'c' },
    ] },
  };
  assert.deepEqual(toEngineElements(index).nodes.filter((node) => node.isHub), []);
});

test('le contrat classe retour et tirage aléatoire séparément de la structure', () => {
  const stage = (path, entry = false) => ({
    path, kind: 'stage', label: { label: path, isFallback: false },
    node: { layout: { x: 0, y: 0 }, squareOne: { value: entry }, uniqueId: true },
  });
  const index = {
    entries: [stage('a', true), stage('b'), stage('c')],
    diagnosticsByNode: new Map(),
    view: { edges: [
      { edgeId: 'ok', kind: 'stage-ok', from: 'a', to: 'b' },
      { edgeId: 'home', kind: 'stage-home', from: 'b', to: 'a' },
      { edgeId: 'fixed', kind: 'action-option', from: 'c', to: 'a', ordinal: 0, selection: { kind: 'fixed', index: 0 } },
      { edgeId: 'random', kind: 'action-option', from: 'c', to: 'b', ordinal: 1, selection: { kind: 'random' } },
    ] },
  };
  const groups = Object.fromEntries(
    toEngineElements(index).edges.map(({ id, visibilityGroup }) => [id, visibilityGroup]),
  );
  assert.deepEqual(groups, {
    ok: 'structure', home: 'returns', fixed: 'structure', random: 'random',
  });
  const endpoints = Object.fromEntries(
    toEngineElements(index).edges.map(({ id, sourceEndpoint, targetEndpoint }) => (
      [id, [sourceEndpoint, targetEndpoint]]
    )),
  );
  // Les extrémités sont en unités de graphe absolues depuis le centre du nœud,
  // et elles tombent **sur les prises** : Cytoscape ne rabat pas un offset sur
  // la silhouette, ce qui permet à une prise de chevaucher le contour. Un Écran
  // fait 104 × 80 et une Action 52 × 52 ; une prise est posée un tiers de rayon
  // dehors, soit 1,5 unité.
  assert.deepEqual(endpoints, {
    ok: ['53.5 0', '-53.5 0'],
    home: ['0 41.5', '-53.5 0'],
    // Trois crans sur le rail — deux options et l'ajout — au pas de 11 unités.
    fixed: ['27.5 -11', '-53.5 0'],
    random: ['27.5 0', '-53.5 0'],
  });
});

test('le rail d’une Action allonge sa course au lieu de rétrécir ses prises', () => {
  // La règle qui a fait échouer les essais précédents, énoncée à l'envers : une
  // prise garde sa taille, c'est le rail qui s'allonge. Réparties sur la
  // diagonale du losange, dix sorties tenaient 52/11 = 4,7 unités d'écart pour
  // des pastilles de 9 — le chevauchement était arithmétique.
  for (let slots = 1; slots <= 13; slots += 1) {
    const offsets = Array.from({ length: slots }, (_, ordinal) => optionPortOffset(ordinal, slots));
    assert.deepEqual([...new Set(offsets.map((offset) => offset.x))], [offsets[0].x],
      'toutes les prises d’une Action sont alignées sur le même rail');
    for (let ordinal = 1; ordinal < slots; ordinal += 1) {
      assert.ok(
        offsets[ordinal].y - offsets[ordinal - 1].y >= PORT_RADIUS * 2,
        `deux prises voisines se touchent à ${slots} crans`,
      );
    }
    // Le rail est centré sur le nœud, et il ne va pas mordre la rangée voisine :
    // le pas de rangée du placement de secours est de 200 unités.
    assert.equal(Math.round((offsets[0].y + offsets[slots - 1].y) * 1000) / 1000, 0);
    assert.ok(offsets[slots - 1].y - offsets[0].y <= 180);
  }
  // Au-delà de la course, c'est le pas qui cède — la prise, jamais.
  const crowded = Array.from({ length: 40 }, (_, ordinal) => optionPortOffset(ordinal, 40));
  assert.ok(crowded[39].y - crowded[0].y <= 180);
});

test('la couche des prises contient toutes les prises qu’elle doit peindre', () => {
  for (const [kind, slots] of [['stage', 1], ['action', 1], ['action', 4], ['action', 12]]) {
    const box = portLayerBox(kind, slots);
    const geometry = NODE_GEOMETRY[kind];
    assert.ok(box.width >= geometry.halfWidth * 2 && box.height >= geometry.halfHeight * 2,
      'la couche couvre au moins le nœud lui-même');
    for (const port of nodePortOffsets(kind, slots)) {
      assert.ok(Math.abs(port.x) + PORT_RADIUS <= box.width / 2,
        `${kind} à ${slots} crans : une prise déborde de sa couche en largeur`);
      assert.ok(Math.abs(port.y) + PORT_RADIUS <= box.height / 2,
        `${kind} à ${slots} crans : une prise déborde de sa couche en hauteur`);
    }
  }
  // Une prise chevauche le contour : son centre est dehors, mais de moins d'un
  // rayon. C'est ce qui la détache de la vignette sans la faire flotter.
  const [arrival] = nodePortOffsets('stage', 1);
  assert.equal(arrival.role, PORT_ROLES.ARRIVAL);
  const outset = Math.abs(arrival.x) - NODE_GEOMETRY.stage.halfWidth;
  assert.ok(outset > 0 && outset < PORT_RADIUS);
});

test('aucune disposition automatique : les positions reçues sont les positions posées', () => {
  // Le moteur natif place déjà, à la lecture, les nœuds sans position : une
  // grille déterministe, en bandes séparées, jamais écrite dans le document.
  // Une disposition automatique de vue déplaçait **aussi** les nœuds
  // positionnés par l'auteur, et le rangement volontaire reste un geste.
  const entry = (path, x, source, origin) => ({
    path, kind: 'stage', label: { label: path, isFallback: false },
    node: { layout: { x, y: 12, source, origin }, squareOne: { value: path === 'a' }, uniqueId: true },
  });
  const graph = (entries) => ({ entries, diagnosticsByNode: new Map(), view: { edges: [] } });
  const mixed = toEngineElements(graph([
    entry('a', 900, 'authored', 'source-studio'),
    entry('b', 0, 'editor-position', 'projection-derived'),
    entry('c', 240, 'fallback', null),
  ]));
  assert.equal(mixed.presentationLayout, undefined, 'plus de disposition de vue à appliquer');
  assert.deepEqual(mixed.nodes.map((node) => [node.id, node.x, node.y]), [
    ['a', 900, 12], ['b', 0, 12], ['c', 240, 12],
  ]);
});

test('les rôles du canvas et ceux des filtres sortent du même calcul', () => {
  const stage = (path, entry = false) => ({
    path, kind: 'stage', label: { label: path, isFallback: false },
    node: { layout: { x: 0, y: 0 }, squareOne: { value: entry }, uniqueId: true },
  });
  // `a` est l'entrée, `b` en dépend, `c` ne mène qu'à `b` sans que rien ne
  // l'atteigne, `d` n'a aucun lien du tout.
  const index = {
    entries: [stage('a', true), stage('b'), stage('c'), stage('d')],
    diagnosticsByNode: new Map(),
    view: { edges: [
      { edgeId: 'ab', kind: 'stage-ok', from: 'a', to: 'b' },
      { edgeId: 'cb', kind: 'stage-ok', from: 'c', to: 'b' },
    ] },
  };
  const byId = new Map(toEngineElements(index).nodes.map((node) => [node.id, node]));
  const listRoles = nodeRoles(index);

  // « Détaché » veut dire la même chose des deux côtés : ni entrant ni
  // sortant. `c`, lui, est « sans entrée », pas « isolé ».
  assert.equal(byId.get('d').isolated, true);
  assert.equal(byId.get('c').isolated, false);
  assert.equal(byId.get('c').noIncoming, true);
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.DETACHED }).total, 1);
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.DETACHED }).results[0].path, 'd');
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.NO_INCOMING }).results[0].path, 'c');

  // Une fin de parcours n'est pas un défaut : elle n'est pas diagnostiquée, et
  // le filtre « À corriger » ne la ramasse pas.
  assert.equal(byId.get('b').deadEnd, true);
  assert.equal(byId.get('b').diagnosed, false);
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.DIAGNOSED }).total, 0);
  assert.equal(searchGraph(index, { scope: SEARCH_SCOPES.DEAD_END }).total, 2, 'b et d ne mènent nulle part');

  // Ce que le canvas peint est ce que le filtre retrouve, chemin par chemin.
  for (const [path, node] of byId) {
    const role = listRoles.of(path);
    assert.equal(node.isolated, role.isolated, path);
    assert.equal(node.noIncoming, role.noIncoming, path);
    assert.equal(node.deadEnd, role.deadEnd, path);
    assert.equal(node.unreachable, role.unreachable, path);
  }
  assert.equal(listRoles.of('c').unreachable, true, 'rien ne mène à c depuis l’entrée');
});

test('une Action garde son compte de sorties en pastille au-dessus de sa silhouette', () => {
  const { html, elements } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', nodes: [{
      path: '/actions/0', kind: 'action', label: 'Choix du monde',
      x: 100, y: 80, width: 104, height: 80, outgoingCount: 3,
    }] },
  }));
  assert.match(html, /advanced-node-overlay--action/);
  assert.match(html, /advanced-node-overlay__action-count">3<\/span>/);
  assert.ok(elements.some((element) => element.props?.text === '3 choix dans cette liste'));
  assert.match(html, />Choix du monde<\/span>/);
});

test('une poignée de raccord se pose sur la prise que le moteur a publiée', () => {
  // La couche HTML ne mesure rien et ne calcule aucune position : elle
  // transpose ce que le moteur lui donne, en pixels écran relatifs au centre de
  // la carte. C'est la réponse au défaut des essais précédents — une pastille
  // HTML placée par ses propres calculs est, pendant un zoom, dans un autre
  // espace que le canvas, qui montre alors une texture étirée.
  const ports = nodePortOffsets('stage', 1).map((port) => ({
    id: port.id, role: port.role, ordinal: port.ordinal, dx: port.x, dy: port.y,
  }));
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', zoom: 1, nodes: [{
      path: '/stages/0', kind: 'stage', label: 'Accueil',
      x: 100, y: 80, width: 104, height: 80, selected: true, ports,
      linkPorts: [
        { id: 'stage-ok', active: true, label: 'Raccorder par OK', control: 'ok' },
        { id: 'stage-home', active: true, label: 'Raccorder par HOME', control: 'home' },
      ],
    }] },
    onLinkPortPointerDown: () => {},
  }));
  const ok = ports.find((port) => port.role === PORT_ROLES.OK);
  const home = ports.find((port) => port.role === PORT_ROLES.HOME);
  const placed = (port) => new RegExp(
    `style="left:calc\\(50% \\+ ${port.dx}px\\);top:calc\\(50% \\+ ${port.dy}px\\)"[^>]*is-${port.id}"`,
  );
  assert.match(html, placed(ok));
  assert.match(html, placed(home));
});

test('une prise révélée pose sa poignée hors de la carte', () => {
  const zoom = 0.2;
  const ports = nodePortOffsets('stage', 1).map((port) => ({
    id: port.id, role: port.role, ordinal: port.ordinal, dx: port.x * zoom, dy: port.y * zoom, revealed: true,
  }));
  const node = {
    path: '/stages/0', kind: 'stage', label: 'Accueil',
    x: 100, y: 80, width: 104 * zoom, height: 80 * zoom, selected: true, ports,
    linkPorts: [{ id: 'stage-ok', active: true, label: 'Raccorder par OK', control: 'ok' }],
  };
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'noLabels', zoom, nodes: [node] },
    onLinkPortPointerDown: () => {},
  }));
  const ok = ports.find((port) => port.role === PORT_ROLES.OK);
  const { x } = revealedHandleOffset(node, ok);
  // Son centre est au-delà du bord droit, et elle le chevauche : aucun
  // interstice où le survol se perdrait.
  assert.ok(x > node.width / 2, 'la poignée est centrée au-delà du bord droit');
  assert.ok(x - (REVEALED_HANDLE.SIZE / 2) < node.width / 2, 'la poignée mord sur le bord');
  assert.ok(html.includes(`style="left:calc(50% + ${x}px);top:calc(50% + 0px)" class="is-active is-stage-ok is-revealed"`));
});

test('sans prise publiée, aucune poignée ne se pose', () => {
  // Le seuil n'est écrit qu'à un endroit, dans le moteur : la couche HTML
  // dessine une poignée si on lui en a publié une, elle ne refait pas le test
  // de zoom. Deux tests de seuil auraient fini par diverger.
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', zoom: 0.3, nodes: [{
      path: '/stages/0', kind: 'stage', label: 'Accueil',
      x: 100, y: 80, width: 104, height: 80, selected: true, ports: null,
      linkPorts: [{ id: 'stage-ok', active: true, label: 'Raccorder par OK', control: 'ok' }],
    }] },
    onLinkPortPointerDown: () => {},
  }));
  assert.doesNotMatch(html, /advanced-node-overlay__ports/);
});

test("un Écran expose sa vignette liée et, sans média, ne pose plus d'icône de remplacement", () => {
  const stage = {
    path: '/stages/0', kind: 'stage', label: { label: 'Accueil', isFallback: false },
    node: {
      layout: { x: 0, y: 0 }, squareOne: { value: true }, uniqueId: true,
      image: { presence: 'value', assetRef: 'accueil.png' },
    },
  };
  const graph = { entries: [stage], diagnosticsByNode: new Map(), view: { edges: [] } };
  assert.equal(toEngineElements(graph).nodes[0].imageAssetRef, 'accueil.png');
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', nodes: [{
      path: stage.path, kind: 'stage', label: 'Accueil', x: 0, y: 0,
      width: 104, height: 80, outgoingCount: 0, isEntry: true, hasImage: false,
    }] },
  }));
  // L'icône de remplacement est retirée : elle mesurait 2,6 px à 11 % de zoom,
  // donc n'était vue à aucune échelle utile, et désignait une absence là où il
  // n'y en a pas — le format rend l'image facultative, un écran purement
  // sonore est normal. C'est la carte, repeinte en `--graph-card-bg`, qui
  // porte l'Écran ; rien ne la remplace dans la couche HTML.
  assert.doesNotMatch(html, /advanced-node-overlay__image-placeholder/);
  assert.match(html, />RACINE<\/span>/);
});

test('le badge d’entrée suit la disparition des libellés', () => {
  const overlay = (detailLevel) => ({ detailLevel, nodes: [{
    path: '/stages/0', kind: 'stage', label: 'Accueil', x: 0, y: 0,
    width: 104, height: 80, isEntry: true,
  }] });
  const full = mountSurface(React.createElement(GraphNodeOverlays, { overlay: overlay('full') })).html;
  assert.match(full, /advanced-node-overlay__badge is-entry/);

  for (const detailLevel of ['noLabels', 'noThumbs']) {
    const html = mountSurface(React.createElement(GraphNodeOverlays, { overlay: overlay(detailLevel) })).html;
    assert.doesNotMatch(html, /advanced-node-overlay__badge/, `badge absent à ${detailLevel}`);
    assert.doesNotMatch(html, />Accueil<\/span>/, `libellé absent à ${detailLevel}`);
  }

  const simplified = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: overlay('simplified'),
  })).html;
  assert.match(simplified, /advanced-landmark--entry/);
  assert.match(simplified, />RACINE</, 'le repère fixe reste disponible au régime très éloigné');
});

test('sous 3 %, seuls les repères de navigation restent sur le graphe', () => {
  // Le défaut corrigé : les tailles 56/20/11 étaient des unités **du graphe**,
  // donc 0,56 pixel à 1 % de zoom. Les repères sont désormais posés par la
  // couche HTML, qui travaille en pixels écran.
  const node = (path, extra) => ({
    path, kind: 'stage', label: path, x: 10, y: 10, width: 10, height: 6,
    outgoingCount: 0, degree: 31, ...extra,
  });
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: {
      detailLevel: 'simplified',
      nodes: [
        node('/entree', { isEntry: true }),
        node('/faute', { diagnosed: true }),
        // Hors de l'anneau de l'entrée, où aucun nom ne se pose.
        node('/carrefour', { isHub: true, label: 'Carrefour océan', x: 300 }),
        node('/quelconque', {}),
      ],
    },
  }));
  assert.match(html, /advanced-landmark--entry/);
  assert.match(html, />RACINE</, 'le libellé RACINE ne tombe plus au régime éloigné');
  assert.doesNotMatch(html, /advanced-landmark--warning/);
  assert.doesNotMatch(html, /faute/);
  assert.match(html, /Carrefour océan · 31 liens/);
  assert.doesNotMatch(html, /quelconque/, 'un nœud sans rôle ne porte aucun repère');
});

test('les zones de groupe tombent au régime éloigné, pas avant', () => {
  const overlay = (detailLevel) => ({ detailLevel, nodes: [], groups: [{ id: 'foret', x: 0, y: 0, width: 80, height: 40 }] });
  assert.match(
    mountSurface(React.createElement(GraphGroupOverlays, { overlay: overlay('noLabels') })).html,
    /advanced-group-overlay/,
  );
  assert.equal(
    mountSurface(React.createElement(GraphGroupOverlays, { overlay: overlay('simplified') })).html,
    '',
  );
});

test('la couche HTML abandonne le glyphe au canvas et ne garde le compte qu’au palier full', () => {
  const overlay = (detailLevel) => ({
    detailLevel,
    nodes: [{
      path: '/actions/0', kind: 'action', label: 'Choix du monde',
      x: 100, y: 80, width: 104, height: 80, outgoingCount: 3,
    }],
  });
  const full = mountSurface(React.createElement(GraphNodeOverlays, { overlay: overlay('full') })).html;
  assert.match(full, /advanced-node-overlay__action-count/);
  const noLabels = mountSurface(React.createElement(GraphNodeOverlays, { overlay: overlay('noLabels') })).html;
  assert.doesNotMatch(noLabels, /advanced-node-overlay__action-count/);
  assert.doesNotMatch(noLabels, />Choix du monde</, 'le nom, lui, tombe bien à 30 %');
  const noThumbs = mountSurface(React.createElement(GraphNodeOverlays, { overlay: overlay('noThumbs') })).html;
  assert.doesNotMatch(noThumbs, /advanced-node-overlay__action-count/);
});

test('la sélection ne dessine plus de poignée de câblage', () => {
  // Quatre carrés sans gestionnaire promettaient un geste que la surface ne
  // sait pas tenir. Le cadre de sélection, lui, reste.
  const { html } = mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', nodes: [{
      path: '/stages/0', kind: 'stage', label: 'Accueil',
      x: 0, y: 0, width: 104, height: 80, outgoingCount: 1, selected: true,
    }] },
  }));
  assert.match(html, /advanced-node-overlay__selection/);
  assert.doesNotMatch(html, /<i class="is-top"/);
});

test('les erreurs ne produisent plus de pastille sur les nœuds', () => {
  const card = (extra) => mountSurface(React.createElement(GraphNodeOverlays, {
    overlay: { detailLevel: 'full', nodes: [{
      path: '/n', kind: 'stage', label: 'N', x: 0, y: 0,
      width: 104, height: 80, outgoingCount: 0, ...extra,
    }] },
  })).html;
  assert.doesNotMatch(card({ deadEnd: true }), />CUL-DE-SAC</);
  assert.doesNotMatch(card({ diagnosed: true }), />À CORRIGER</);
  assert.doesNotMatch(card({ isolated: true }), />ISOLÉ</);
  assert.doesNotMatch(card({ noIncoming: true }), />SANS ENTRÉE</);
  assert.match(card({ isEntry: true }), />RACINE</);
});
