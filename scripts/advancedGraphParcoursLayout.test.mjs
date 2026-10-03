// La Vue parcours : le graphe de mise en page, les rangs, et le domaine des
// positions d'auteur.
//
// Tout est **pur** : aucun moteur d'affichage n'est chargé. Si l'un de ces
// tests avait besoin de Cytoscape, le rangement ne serait pas calculable hors
// du moteur, et il faudrait l'écrire une fois par moteur.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  FOLD_PARTS,
  NO_FOLD,
  PARCOURS_STEPS,
  buildLayoutGraph,
  needsInitialLayout,
  parcoursLayout,
} from '../src/store/advancedGraphView/graphParcoursLayout.js';
import { SHORT_MAX, SHORT_MIN } from '../src/store/advancedGraphView/graphGeometry.js';
import { action, presence, stage } from './advancedViewFixtures.mjs';

const stagePath = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const actionPath = (id) => `/actionNodes/@id=${id}#0`;

function okEdge(from, to) {
  return {
    edgeId: `${stagePath(from)}::ok`,
    kind: 'stage-ok',
    from: stagePath(from),
    to: actionPath(to),
    optionId: null,
    ordinal: 0,
    selection: { kind: 'fixed', index: 0 },
    dangling: false,
  };
}

function homeEdge(from, to) {
  return {
    edgeId: `${stagePath(from)}::home`,
    kind: 'stage-home',
    from: stagePath(from),
    to: actionPath(to),
    optionId: null,
    ordinal: 0,
    selection: { kind: 'fixed', index: 0 },
    dangling: false,
  };
}

function optionEdge(from, to, ordinal = 0) {
  return {
    edgeId: `${actionPath(from)}/options#${ordinal}`,
    kind: 'action-option',
    from: actionPath(from),
    to: stagePath(to),
    optionId: `${actionPath(from)}/options#${ordinal}`,
    ordinal,
    selection: null,
    dangling: false,
  };
}

// Une vue minimale, construite à partir des seules listes utiles au rangement.
function viewOf({ stages, actions, edges, entry = null }) {
  return {
    viewVersion: 1,
    entry: entry
      ? { status: 'unique', stagePath: stagePath(entry), candidates: [stagePath(entry)] }
      : { status: 'missing', stagePath: null, candidates: [] },
    counts: { stages: stages.length, actions: actions.length, options: 0, edges: edges.length },
    stages: stages.map((uuid) => stage(uuid, uuid === entry ? { squareOne: presence(true) } : {})),
    actions: actions.map(([id, targets]) => action(id, targets)),
    edges,
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  };
}

function indexOf(shape) {
  return buildGraphIndex(viewOf(shape));
}

// Une histoire droite : entrée → Action → Écran → Action → Écran.
function chain() {
  return indexOf({
    entry: 'a',
    stages: ['a', 'b', 'c'],
    actions: [['x', ['b']], ['y', ['c']]],
    edges: [okEdge('a', 'x'), optionEdge('x', 'b'), okEdge('b', 'y'), optionEdge('y', 'c')],
  });
}

// ── Le graphe de mise en page ────────────────────────────────────────────────

test('une Action qui n’appartient qu’à un Écran ne prend pas de rang à elle', () => {
  const graph = buildLayoutGraph(chain());
  // Trois Écrans, trois unités : les deux Actions ont rejoint leur Écran.
  assert.equal(graph.units.length, 3);
  const carrying = graph.units.filter((unit) => unit.satellite !== null);
  assert.equal(carrying.length, 2);
  assert.equal(graph.unitOf.get(actionPath('x')), graph.unitOf.get(stagePath('a')));
});

test('une Action partagée garde un rang propre', () => {
  // Deux Écrans mènent à la même Action : c’est une convergence réelle, et la
  // taire ferait disparaître du graphe ce que le pack dit.
  const index = indexOf({
    entry: 'a',
    stages: ['a', 'b', 'c'],
    actions: [['partagee', ['c']]],
    edges: [okEdge('a', 'partagee'), okEdge('b', 'partagee'), optionEdge('partagee', 'c')],
  });
  const graph = buildLayoutGraph(index);
  assert.equal(graph.units.length, 4);
  assert.notEqual(graph.unitOf.get(actionPath('partagee')), graph.unitOf.get(stagePath('a')));
  assert.equal(parcoursLayout(index).shared, 1);
});

test('un retour Home ne compte pas dans la contraction ni dans les rangs', () => {
  // Le cas mesuré sur un pack réel : une Action de convergence qui reçoit
  // presque tous ses entrants par des retours Home. Sans le filtre, elle
  // cesserait d’être privée à son Écran, et remonterait au premier rang.
  const withHome = indexOf({
    entry: 'a',
    stages: ['a', 'b', 'c'],
    actions: [['x', ['b']], ['y', ['c']]],
    edges: [
      okEdge('a', 'x'), optionEdge('x', 'b'), okEdge('b', 'y'), optionEdge('y', 'c'),
      homeEdge('b', 'x'), homeEdge('c', 'x'),
    ],
  });
  const graph = buildLayoutGraph(withHome);
  // `x` reste l’Action privée de `a`, malgré ses deux retours entrants.
  assert.equal(graph.unitOf.get(actionPath('x')), graph.unitOf.get(stagePath('a')));
  // Et les rangs sont ceux de l’histoire sans les retours.
  const layout = parcoursLayout(withHome);
  const plain = parcoursLayout(chain());
  assert.deepEqual([...layout.positions.entries()].sort(), [...plain.positions.entries()].sort());
});

// ── Les rangs ────────────────────────────────────────────────────────────────

test('l’entrée du pack ouvre le parcours, et non le nœud le plus relié', () => {
  // `carrefour` est l’Action la plus reliée. C’est elle que « Par niveaux »
  // portait au sommet ; la racine doit rester l’Écran d’entrée.
  const index = indexOf({
    entry: 'depart',
    stages: ['depart', 'p', 'q', 'r'],
    actions: [['carrefour', ['p', 'q', 'r']], ['premier', ['p']]],
    edges: [
      okEdge('depart', 'premier'), optionEdge('premier', 'p'),
      okEdge('p', 'carrefour'), okEdge('q', 'carrefour'), okEdge('r', 'carrefour'),
      optionEdge('carrefour', 'p', 0), optionEdge('carrefour', 'q', 1), optionEdge('carrefour', 'r', 2),
    ],
  });
  const layout = parcoursLayout(index);
  assert.equal(layout.root, stagePath('depart'));
  const depart = layout.positions.get(stagePath('depart'));
  const carrefour = layout.positions.get(actionPath('carrefour'));
  assert.ok(depart.x < carrefour.x, 'l’entrée est à gauche du carrefour');
});

test('l’Écran, son Action et l’Écran suivant tiennent sur une même ligne', () => {
  // L’intention relevée sur un pack positionné à la main dans STUdio.
  const layout = parcoursLayout(chain());
  const a = layout.positions.get(stagePath('a'));
  const x = layout.positions.get(actionPath('x'));
  const b = layout.positions.get(stagePath('b'));
  assert.equal(a.y, x.y);
  assert.equal(a.y, b.y);
  assert.ok(a.x < x.x && x.x < b.x, 'le récit se lit de la gauche vers la droite');
});

test('sans entrée unique, aucune racine n’est élue', () => {
  const index = indexOf({
    stages: ['a', 'b'],
    actions: [['x', ['b']]],
    edges: [okEdge('a', 'x'), optionEdge('x', 'b')],
  });
  const layout = parcoursLayout(index);
  assert.equal(layout.root, null);
  // Le rangement reste utilisable : chaque composante est rangée pour elle-même.
  assert.equal(layout.positions.size, 3);
});

test('les nœuds inaccessibles sont rangés à part, jamais mêlés au parcours', () => {
  const index = indexOf({
    entry: 'a',
    stages: ['a', 'b', 'orphelin'],
    actions: [['x', ['b']]],
    edges: [okEdge('a', 'x'), optionEdge('x', 'b')],
  });
  const layout = parcoursLayout(index);
  assert.equal(layout.components, 2);
  const parcours = layout.positions.get(stagePath('a')).y;
  const orphelin = layout.positions.get(stagePath('orphelin')).y;
  assert.ok(Math.abs(orphelin - parcours) >= PARCOURS_STEPS.COMPONENT_GAP * layout.scale);
});

// ── Le domaine des positions d’auteur ────────────────────────────────────────

test('le rangement tient dans le domaine des positions d’auteur, sans rien demander', () => {
  // Une histoire assez longue pour sortir de la borne si rien ne la ramenait :
  // 400 rangs à 500 pixels font 200 000, six fois le domaine.
  const stages = [];
  const actions = [];
  const edges = [];
  for (let step = 0; step < 400; step += 1) {
    stages.push(`s${String(step).padStart(4, '0')}`);
  }
  for (let step = 0; step < 399; step += 1) {
    const id = `a${String(step).padStart(4, '0')}`;
    actions.push([id, [stages[step + 1]]]);
    edges.push(okEdge(stages[step], id), optionEdge(id, stages[step + 1]));
  }
  const layout = parcoursLayout(indexOf({ entry: stages[0], stages, actions, edges }));
  // Le repli ramène déjà la plus grande part du débordement ; la mise à
  // l'échelle finit le travail s'il en reste. Ce qui compte n'est pas
  // lequel des deux a agi, mais que le résultat soit écrivable tel quel.
  for (const { x, y } of layout.positions.values()) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y), 'les positions sont entières');
    assert.ok(x >= SHORT_MIN && x <= SHORT_MAX, `x hors borne : ${x}`);
    assert.ok(y >= SHORT_MIN && y <= SHORT_MAX, `y hors borne : ${y}`);
  }
});

test('un rangement qui tient déjà n’est pas mis à l’échelle', () => {
  const layout = parcoursLayout(chain());
  assert.equal(layout.scale, 1);
});

test('deux lectures du même document rendent les mêmes positions', () => {
  // L’invariant que le reste de la vue avancée tient déjà. Sans lui, un
  // rangement ne pourrait pas servir de position d’auteur : le document
  // changerait à chaque ouverture.
  const first = parcoursLayout(chain());
  const second = parcoursLayout(chain());
  assert.deepEqual([...first.positions.entries()], [...second.positions.entries()]);
});

test('tous les nœuds reçoivent une position, y compris les isolés', () => {
  const index = indexOf({
    entry: 'a',
    stages: ['a', 'b', 'seul'],
    actions: [['x', ['b']], ['orpheline', []]],
    edges: [okEdge('a', 'x'), optionEdge('x', 'b')],
  });
  const layout = parcoursLayout(index);
  assert.equal(layout.positions.size, index.entries.length);
  for (const entry of index.entries) {
    assert.ok(layout.positions.has(entry.path), `sans position : ${entry.path}`);
  }
});

test('un index vide ne range rien et ne lève pas', () => {
  const layout = parcoursLayout(indexOf({ stages: [], actions: [], edges: [] }));
  assert.equal(layout.positions.size, 0);
  assert.equal(layout.root, null);
});

test('une arête pendante ne fait pas échouer le rangement', () => {
  const index = indexOf({
    entry: 'a',
    stages: ['a'],
    actions: [['x', [null]]],
    edges: [
      okEdge('a', 'x'),
      {
        edgeId: `${actionPath('x')}/options#0`,
        kind: 'action-option',
        from: actionPath('x'),
        to: null,
        optionId: `${actionPath('x')}/options#0`,
        ordinal: 0,
        selection: null,
        dangling: true,
      },
    ],
  });
  const layout = parcoursLayout(index);
  assert.equal(layout.positions.size, 2);
});

// ── Le repli ─────────────────────────────────────────────────────────────────

// Un profil quasi linéaire : beaucoup de rangs, très peu de large.
function ribbon(length) {
  const stages = [];
  const actions = [];
  const edges = [];
  for (let step = 0; step < length; step += 1) stages.push(`s${String(step).padStart(3, '0')}`);
  for (let step = 0; step < length - 1; step += 1) {
    const id = `a${String(step).padStart(3, '0')}`;
    actions.push([id, [stages[step + 1]]]);
    edges.push(okEdge(stages[step], id), optionEdge(id, stages[step + 1]));
  }
  return indexOf({ entry: stages[0], stages, actions, edges });
}

// L'autre profil : un seul rang, très large.
function fan(width) {
  const stages = ['depart'];
  const targets = [];
  for (let branch = 0; branch < width; branch += 1) {
    const uuid = `b${String(branch).padStart(3, '0')}`;
    stages.push(uuid);
    targets.push(uuid);
  }
  const edges = [okEdge('depart', 'eventail')];
  targets.forEach((uuid, ordinal) => edges.push(optionEdge('eventail', uuid, ordinal)));
  return indexOf({ entry: 'depart', stages, actions: [['eventail', targets]], edges });
}

function extentOf(layout) {
  const xs = [...layout.positions.values()].map((position) => position.x);
  const ys = [...layout.positions.values()].map((position) => position.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

test('aucun repli n’est appliqué sans demande', () => {
  // La forme du rangement est celle de l'histoire, et c'est une lecture
  // exacte : le module ne la corrige pas de lui-même.
  const plain = extentOf(parcoursLayout(ribbon(60)));
  assert.equal(plain.height, 0, 'un ruban reste un ruban tant qu’on ne le replie pas');
  assert.deepEqual(parcoursLayout(ribbon(60)).fold, NO_FOLD);
});

test('replier les rangs empile la suite de l’histoire en bandes', () => {
  const plain = extentOf(parcoursLayout(ribbon(60)));
  for (const parts of FOLD_PARTS) {
    const folded = extentOf(parcoursLayout(ribbon(60), { bands: parts }));
    assert.ok(folded.width < plain.width, `${parts} bandes ne raccourcissent pas`);
    assert.ok(folded.height > 0, `${parts} bandes ne descendent pas`);
  }
  // Plus de bandes, plus court et plus haut : la relation est monotone.
  const deux = extentOf(parcoursLayout(ribbon(60), { bands: 2 }));
  const quatre = extentOf(parcoursLayout(ribbon(60), { bands: 4 }));
  assert.ok(quatre.width < deux.width && quatre.height > deux.height);
});

test('replier un rang le range en colonnes voisines', () => {
  const plain = extentOf(parcoursLayout(fan(90)));
  assert.equal(plain.width > 0, true);
  for (const parts of FOLD_PARTS) {
    const folded = extentOf(parcoursLayout(fan(90), { lanes: parts }));
    assert.ok(folded.height < plain.height, `${parts} colonnes ne raccourcissent pas la pile`);
    assert.ok(folded.width > plain.width, `${parts} colonnes n’élargissent pas`);
  }
});

test('un repli reste dans le domaine des positions d’auteur', () => {
  for (const fold of [{ bands: 3 }, { lanes: 3 }]) {
    const layout = parcoursLayout(ribbon(400), fold);
    for (const { x, y } of layout.positions.values()) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.ok(x >= SHORT_MIN && x <= SHORT_MAX && y >= SHORT_MIN && y <= SHORT_MAX);
    }
  }
});

test('un repli absurde est ramené à une valeur utilisable', () => {
  // L'interface n'offre que 2, 3 et 4 ; le module ne suppose pas qu'elle soit
  // le seul appelant.
  assert.deepEqual(parcoursLayout(ribbon(10), { bands: 0 }).fold, NO_FOLD);
  assert.deepEqual(parcoursLayout(ribbon(10), { bands: 99 }).fold, { bands: 4, lanes: 1 });
  assert.deepEqual(parcoursLayout(ribbon(10), null).fold, NO_FOLD);
});

test('un repli ne perd ni ne duplique aucun nœud', () => {
  const index = ribbon(60);
  for (const fold of [NO_FOLD, { bands: 2 }, { bands: 4 }, { lanes: 3 }]) {
    const layout = parcoursLayout(index, fold);
    assert.equal(layout.positions.size, index.entries.length);
  }
});

test('deux replis identiques rendent les mêmes positions', () => {
  const first = parcoursLayout(ribbon(60), { bands: 3 });
  const second = parcoursLayout(ribbon(60), { bands: 3 });
  assert.deepEqual([...first.positions.entries()], [...second.positions.entries()]);
});

// ── Le rangement à l'ouverture ───────────────────────────────────────────────

// Réécrit la disposition de chaque nœud, dans l'ordre des entrées.
function withLayouts(index, layouts) {
  index.view.documentOrigin = 'imported-studio';
  index.entries.forEach((entry, rank) => {
    entry.node.layout = layouts[rank % layouts.length];
  });
  return index;
}

test('un pack sans aucune position est rangé à l’ouverture', () => {
  // Le placement de secours et le quadrillage de projection sont des lectures,
  // pas des dispositions d’auteur.
  assert.equal(needsInitialLayout(withLayouts(chain(), [
    { x: 0, y: 0, source: 'fallback', origin: null },
    { x: 240, y: 0, source: 'fallback', origin: null },
  ])), true);
  const projected = withLayouts(chain(), [
    { x: 160, y: 160, source: 'editor-position', origin: 'projection-derived' },
    { x: 320, y: 160, source: 'editor-position', origin: 'projection-derived' },
  ]);
  assert.equal(needsInitialLayout(projected), true);
});

test('un pack dont toutes les positions sont au même point est rangé', () => {
  const stacked = withLayouts(chain(), [
    { x: 0, y: 0, source: 'authored', origin: 'source-studio' },
  ]);
  assert.equal(needsInitialLayout(stacked), true);
});

test('un pack qui porte une disposition n’est jamais rangé seul', () => {
  const authored = withLayouts(chain(), [
    { x: 0, y: 0, source: 'authored', origin: 'source-studio' },
    { x: 240, y: 0, source: 'authored', origin: 'source-studio' },
  ]);
  assert.equal(needsInitialLayout(authored), false);
});

test('un document vide ou d’un seul nœud n’a rien à ranger', () => {
  assert.equal(needsInitialLayout(null), false);
  assert.equal(needsInitialLayout(indexOf({ entry: 'a', stages: ['a'], actions: [], edges: [] })), false);
});

test('un projet créé dans l’éditeur n’est jamais rangé seul', () => {
  // Trois nœuds posés à la main, enregistrés puis rouverts : leurs positions
  // d’éditeur ressemblent à une projection, mais ce sont celles de l’auteur.
  const created = withLayouts(chain(), [
    { x: 39, y: 33, source: 'editor-position', origin: 'projection-derived' },
    { x: 214.5, y: 181.5, source: 'editor-position', origin: 'projection-derived' },
    { x: 0, y: 0, source: 'fallback', origin: null },
  ]);
  created.view.documentOrigin = 'created';
  assert.equal(needsInitialLayout(created), false);
  const stacked = withLayouts(chain(), [{ x: 0, y: 0, source: 'authored', origin: 'authored' }]);
  stacked.view.documentOrigin = 'created';
  assert.equal(needsInitialLayout(stacked), false);
});

test('un pack natif importé sans position est rangé', () => {
  const native = withLayouts(chain(), [
    { x: 160, y: 160, source: 'editor-position', origin: 'projection-derived' },
    { x: 320, y: 160, source: 'editor-position', origin: 'projection-derived' },
  ]);
  native.view.documentOrigin = 'imported-fs';
  assert.equal(needsInitialLayout(native), true);
});

// ── Les nœuds sans aucun lien ────────────────────────────────────────────────

test('des nœuds sans lien restent proches, comme des nœuds reliés', () => {
  const stages = ['a', 'b', 'c', 'd', 'e', 'f'];
  const layout = parcoursLayout(indexOf({ stages, actions: [], edges: [] }));
  const ys = stages.map((uuid) => layout.positions.get(stagePath(uuid)).y);
  const spread = Math.max(...ys) - Math.min(...ys);
  // Six nœuds en colonne à un pas de ligne chacun : 5 pas, pas 5 000 unités.
  assert.ok(spread <= 5 * PARCOURS_STEPS.ROW * layout.scale, `écart ${spread}`);
});

test('un graphe relié garde exactement ses positions', () => {
  const layout = parcoursLayout(chain());
  assert.equal(layout.scale, 1);
  const got = [...layout.positions.entries()].sort(([l], [r]) => l.localeCompare(r));
  assert.deepEqual(got, [
    [actionPath('x'), { x: -209, y: 0 }],
    [actionPath('y'), { x: 239, y: 0 }],
    [stagePath('a'), { x: -448, y: 0 }],
    [stagePath('b'), { x: 0, y: 0 }],
    [stagePath('c'), { x: 448, y: 0 }],
  ]);
});
