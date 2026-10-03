// Le menu contextuel du graphe et les commandes de repérage de la surface.
//
// Deux exigences sont éprouvées ici, et elles vont ensemble :
//
// - **une entrée par geste qui existe réellement.** La couleur possède
//   désormais son geste collectif ; le renommage reste dans l'inspecteur et au
//   double-clic, comme dans le Libre, et n'entre pas dans ce menu.
// - **le clic droit n'est jamais le seul accès.** Les commandes de repérage
//   vivent sur la surface, donc joignables même liste et inspecteur fermés.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';

const { mountSurface } = await import('./chromeBench.mjs');
const { buildGraphContextActions, buildGraphSurfaceActions } = await import('../src/components/AdvancedWorkspace/graphContextMenuActions.jsx');
const { GraphSurfaceControls } = await import('../src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx');
const { actionDestinations } = await import('../src/components/AdvancedWorkspace/ListenFromActionDialog.jsx');

const labels = (actions) => actions.filter((a) => a !== 'sep').map((a) => a.label);
const find = (actions, label) => actions.find((a) => a !== 'sep' && a.label === label) ?? null;

function stage(overrides = {}) {
  return {
    kind: 'stage',
    path: '/stageNodes/@uuid=s1#0',
    label: { label: 'Accueil', isFallback: false },
    editableByIdentifier: true,
    node: { uuid: 's1', squareOne: { presence: 'value', value: false } },
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    kind: 'action',
    path: '/actionNodes/@id=a1#0',
    label: { label: 'Choix', isFallback: false },
    editableByIdentifier: true,
    node: { id: 'a1' },
    ...overrides,
  };
}

test('sur un Écran, le menu offre la simulation et le retrait, sans changement de racine', () => {
  const actions = buildGraphContextActions({
    inspected: stage(),
    onSimulateFrom: () => {},
    onGesture: () => {},
    onDelete: () => {},
  });
  assert.deepEqual(labels(actions), [
    'Simuler depuis ici',
    'Retirer…',
  ]);
});

test('le menu ne propose pas Renommer, conformément au geste du Libre', () => {
  const actions = buildGraphContextActions({
    inspected: stage(),
    onSimulateFrom: () => {},
    onGesture: () => {},
    onDelete: () => {},
  });
  const written = labels(actions).join(' ').toLowerCase();
  assert.ok(!written.includes('renommer'), 'pas de renommage');
});

test('la palette du menu applique une couleur à toute la sélection en un geste', () => {
  const sent = [];
  const selectedPaths = ['/stageNodes/@uuid=s1#0', '/actionNodes/@id=a1#0'];
  const index = {
    byPath: new Map([
      [selectedPaths[0], { node: { personalColor: '#e24b4a' } }],
      [selectedPaths[1], { node: { personalColor: '#3d9be9' } }],
    ]),
  };
  const actions = buildGraphContextActions({
    inspected: stage(),
    index,
    selectedPaths,
    onSetColor: (paths, color) => sent.push({ paths, color }),
  });
  const palette = actions.find((entry) => entry?.type === 'node');
  assert.ok(palette, 'la palette est rendue');
  const picker = palette.render();
  assert.equal(picker.props.currentColor, '__mixed__');
  picker.props.onChange('#7c6af7');
  assert.deepEqual(sent, [{ paths: selectedPaths, color: '#7c6af7' }]);
});

// Un index minimal portant une Action et ses occurrences.
function actionIndex(edges) {
  return {
    byPath: new Map([
      ['/s1', { kind: 'stage', path: '/s1', label: { label: 'Forêt', isFallback: false }, node: {} }],
      ['/s2', { kind: 'stage', path: '/s2', label: { label: '', isFallback: true }, node: {} }],
      ['/actionNodes/@id=a1#0', { kind: 'action', path: '/actionNodes/@id=a1#0', node: { id: 'a1' } }],
    ]),
    outgoing: new Map([['/actionNodes/@id=a1#0', edges]]),
    entries: [],
  };
}

test('la simulation d’une Action ouvre un choix, elle ne lance rien', () => {
  const opened = [];
  const actions = buildGraphContextActions({
    inspected: action(),
    index: actionIndex([{ edgeId: 'e0', to: '/s1', ordinal: 0 }]),
    onSimulateFrom: () => { throw new Error('une Action ne doit pas partir directement'); },
    onListenFromAction: (path) => opened.push(path),
    onDelete: () => {},
  });
  assert.deepEqual(labels(actions), ['Simuler depuis ici', 'Retirer…']);
  find(actions, 'Simuler depuis ici').fn();
  assert.deepEqual(opened, ['/actionNodes/@id=a1#0']);
});

test('le dialogue d’une liste de choix emploie lui aussi le vocabulaire de simulation', () => {
  const source = readFileSync(
    new URL('../src/components/AdvancedWorkspace/ListenFromActionDialog.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /title=\{`Simuler depuis « \$\{inspected\.label\.label\} »`\}/);
  assert.match(source, /confirmLabel="Simuler"/);
  assert.doesNotMatch(source, /title=\{`Écouter depuis|commencer l’écoute/);
});

test('sans destination exploitable, la simulation d’une Action est désactivée avec sa raison', () => {
  const actions = buildGraphContextActions({
    inspected: action(),
    index: actionIndex([
      { edgeId: 'e0', to: null, ordinal: 0 },
      { edgeId: 'e1', to: '/absent', ordinal: 1, dangling: true },
    ]),
    onListenFromAction: () => {},
  });
  assert.match(
    find(actions, 'Simuler depuis ici').disabledReason,
    /ne mène à un Écran exploitable/,
  );
});

test('les occurrences sont rendues dans l’ordre de leur rang, jamais fondues', () => {
  // Deux occurrences vers le même Écran restent **deux** entrées : le rang fait
  // l'identité d'une occurrence dans le dialecte.
  const destinations = actionDestinations(actionIndex([
    { edgeId: 'e2', to: '/s1', ordinal: 2 },
    { edgeId: 'e0', to: '/s1', ordinal: 0 },
    { edgeId: 'e1', to: '/s2', ordinal: 1 },
  ]), '/actionNodes/@id=a1#0');
  assert.deepEqual(destinations.map((one) => one.ordinal), [0, 1, 2]);
  assert.deepEqual(destinations.map((one) => one.edgeId), ['e0', 'e1', 'e2']);
  assert.equal(destinations.length, 3, 'deux occurrences vers le même Écran ne fusionnent pas');
  assert.equal(destinations[0].label, 'Forêt');
  assert.equal(destinations[1].isFallback, true, 'un repli est exposé comme tel');
});

test('destination nulle, destination manquante et destination prête sont trois états', () => {
  const destinations = actionDestinations(actionIndex([
    { edgeId: 'e0', to: '/s1', ordinal: 0 },
    { edgeId: 'e1', to: null, ordinal: 1 },
    { edgeId: 'e2', to: '/absent', ordinal: 2, dangling: true },
  ]), '/actionNodes/@id=a1#0');
  assert.deepEqual(destinations.map((one) => one.state), ['ready', 'null', 'dangling']);
  assert.equal(destinations[0].targetPath, '/s1');
  assert.equal(destinations[1].targetPath, null, 'une destination nulle n’est pas un point de départ');
  assert.equal(destinations[2].targetPath, null, 'une destination manquante non plus');
});

test('le retrait demande la confirmation du nœud visé, et annonce sa touche', () => {
  const asked = [];
  const actions = buildGraphContextActions({
    inspected: action(),
    onDelete: (paths) => asked.push(paths),
    shortcutLabels: { selectionDelete: 'Suppr' },
  });
  find(actions, 'Retirer…').fn();
  assert.deepEqual(asked, [['/actionNodes/@id=a1#0']]);
  assert.equal(find(actions, 'Retirer…').danger, true);
  assert.equal(find(actions, 'Retirer…').shortcut, 'Suppr');
});

test('dans une sélection, le retrait vise la sélection entière, comme copier et couper', () => {
  const asked = [];
  const actions = buildGraphContextActions({
    inspected: action(),
    selectedPaths: ['/actionNodes/@id=a1#0', '/stageNodes/@uuid=s2#0'],
    onDelete: (paths) => asked.push(paths),
  });
  find(actions, 'Retirer (2 éléments)…').fn();
  assert.deepEqual(asked, [['/actionNodes/@id=a1#0', '/stageNodes/@uuid=s2#0']]);
});

// --- Les commandes de repérage sur la surface -------------------------------

const index = {
  byPath: new Map([
    ['/s1', { kind: 'stage', path: '/s1', label: { label: 'Accueil', isFallback: false } }],
    ['/a1', { kind: 'action', path: '/a1', label: { label: 'Choix', isFallback: false } }],
  ]),
  entries: [],
};

function controls(props) {
  return mountSurface(React.createElement(GraphSurfaceControls, {
    engineRef: { current: null },
    index,
    viewport: { x: 0, y: 0, zoom: 1 },
    hostRef: { current: null },
    onFocusPath: () => {},
    ...props,
  }));
}

test('la surface ne garde que le pas-à-pas des nœuds visités', () => {
  // Trois commandes ont quitté la surface et n'y reviennent pas : l'entrée se
  // cadre depuis le panneau de recherche, l'écoute part du menu contextuel du
  // nœud ou de l'inspecteur, et le cadrage de la sélection ne faisait que
  // recentrer ce qu'on avait déjà sous les yeux.
  const { html } = controls({
    entry: { status: 'unique', stagePath: '/s1' },
    selection: { stages: ['/s1'], actions: ['/a1'] },
    focus: '/s1',
    onSimulateFrom: () => {},
    history: { canBack: true, canForward: true, onBack: () => {}, onForward: () => {} },
  });
  assert.doesNotMatch(html, /Montrer l’entrée/);
  assert.doesNotMatch(html, /Écouter d’ici/);
  assert.doesNotMatch(html, /Revenir à la sélection/);
  // Le pas-à-pas reste, dans la colonne des commandes de caméra : il déplace
  // le regard comme le zoom, et lui seul n'a pas d'équivalent ailleurs.
  assert.match(html, /advanced-graph-camera/);
  assert.match(html, /advanced-graph-steps/);
  assert.match(html, /Nœud visité précédent/);
  assert.match(html, /Nœud visité suivant/);
});

test('un pas-à-pas impossible reste affiché et expliqué', () => {
  // Le faire disparaître laisserait l'auteur sans raison ; désactivé, son
  // infobulle dit pourquoi.
  const { html, elements } = controls({
    history: { canBack: false, canForward: false, onBack: () => {}, onForward: () => {} },
  });
  assert.match(html, /aria-disabled="true"/);
  const tips = elements
    .filter((element) => typeof element.props?.text === 'string')
    .map((element) => element.props.text);
  assert.ok(tips.includes('Aucun nœud visité avant celui-ci.'), tips.join(' | '));
  assert.ok(tips.includes('Aucun nœud visité après celui-ci.'), tips.join(' | '));
});

test('le pas-à-pas appelle les commandes de l’historique, et rien d’autre', () => {
  const steps = [];
  const { elements } = controls({
    history: {
      canBack: true,
      canForward: true,
      onBack: () => steps.push('back'),
      onForward: () => steps.push('forward'),
    },
  });
  const buttons = elements.filter(
    (element) => element.props?.['aria-label']?.startsWith('Nœud visité'),
  );
  assert.equal(buttons.length, 2);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(steps, ['back', 'forward']);
});

test('le clic droit hors de tout nœud propose de créer là, et transmet le point', () => {
  // Le menu de nœud refuse le vide faute de cible ; celui-ci n'agit sur aucun
  // nœud existant, donc le raisonnement ne s'y applique pas.
  const graphPoint = { x: -120.5, y: 340 };
  const vus = [];
  const actions = buildGraphSurfaceActions({
    graphPoint,
    onCreateStage: (point) => vus.push(['stage', point]),
    onCreateAction: (point) => vus.push(['action', point]),
  });
  assert.deepEqual(labels(actions), ['Créer un Écran ici', 'Créer une liste de choix ici']);

  find(actions, 'Créer un Écran ici').fn();
  find(actions, 'Créer une liste de choix ici').fn();
  assert.deepEqual(vus, [['stage', graphPoint], ['action', graphPoint]]);
});

test('sans point, le menu de surface reste vide', () => {
  // Un clic dont la position n'a pas pu être convertie n'ouvre rien, plutôt
  // que d'ouvrir un menu qui créerait le nœud ailleurs.
  assert.deepEqual(buildGraphSurfaceActions({
    graphPoint: null,
    onCreateStage: () => {},
    onCreateAction: () => {},
  }), []);
});

test('édition indisponible : les entrées restent visibles avec leur raison', () => {
  const actions = buildGraphSurfaceActions({
    graphPoint: { x: 0, y: 0 },
    editingDisabled: true,
    onCreateStage: () => {},
    onCreateAction: () => {},
  });
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.equal(action.disabledReason, 'Édition indisponible.');
  }
});

// --- Le presse-papier au clic droit ------------------------------------------

test('le menu d’un nœud offre les gestes du presse-papier, avec les mots du Libre', () => {
  const copied = [];
  const duplicated = [];
  const actions = buildGraphContextActions({
    inspected: stage(),
    onCopy: (paths) => copied.push(paths),
    onDuplicate: (paths) => duplicated.push(paths),
  });
  assert.deepEqual(labels(actions), ['Dupliquer', 'Copier']);
  find(actions, 'Copier').fn();
  find(actions, 'Dupliquer').fn();
  assert.deepEqual(copied, [['/stageNodes/@uuid=s1#0']]);
  assert.deepEqual(duplicated, [['/stageNodes/@uuid=s1#0']]);
});

test('copier et dupliquer agissent sur la sélection quand le nœud visé lui appartient', () => {
  const selectedPaths = ['/stageNodes/@uuid=s1#0', '/actionNodes/@id=a1#0'];
  const copied = [];
  const actions = buildGraphContextActions({
    inspected: stage(),
    selectedPaths,
    onCopy: (paths) => copied.push(paths),
    onDuplicate: () => {},
  });
  // Le compte est dit : un clic droit dans une sélection de six nœuds ne doit
  // pas laisser croire qu'il n'en copie qu'un.
  assert.deepEqual(labels(actions), ['Dupliquer (2 éléments)', 'Copier (2 éléments)']);
  find(actions, 'Copier (2 éléments)').fn();
  assert.deepEqual(copied, [selectedPaths]);
});

test('copier reste offert pendant qu’un geste suspend l’édition, dupliquer non', () => {
  // Copier est une lecture : elle n'écrit rien dans le document.
  const actions = buildGraphContextActions({
    inspected: stage(),
    editingDisabled: true,
    onCopy: () => {},
    onDuplicate: () => {},
  });
  assert.equal(find(actions, 'Copier').disabledReason ?? null, null);
  assert.match(find(actions, 'Dupliquer').disabledReason, /suspendue/);
});

test('« Coller ici » n’apparaît que si le presse-papier porte quelque chose', () => {
  const graphPoint = { x: 12, y: -8 };
  const vide = buildGraphSurfaceActions({
    graphPoint,
    onCreateStage: () => {},
    onCreateAction: () => {},
    onPaste: () => {},
    clipboard: null,
  });
  assert.deepEqual(labels(vide), ['Créer un Écran ici', 'Créer une liste de choix ici']);

  const collés = [];
  const garni = buildGraphSurfaceActions({
    graphPoint,
    onCreateStage: () => {},
    onCreateAction: () => {},
    onPaste: (point) => collés.push(point),
    clipboard: { stages: [{}, {}], actions: [{}], transitions: [] },
  });
  assert.deepEqual(labels(garni), [
    'Créer un Écran ici',
    'Créer une liste de choix ici',
    'Coller ici (3 éléments)',
  ]);
  find(garni, 'Coller ici (3 éléments)').fn();
  assert.deepEqual(collés, [graphPoint], 'le collage porte le point du clic, en coordonnées de graphe');
});

test('un collage d’un seul nœud ne compte pas ses éléments', () => {
  const actions = buildGraphSurfaceActions({
    graphPoint: { x: 0, y: 0 },
    onPaste: () => {},
    clipboard: { stages: [{}], actions: [], transitions: [] },
  });
  assert.deepEqual(labels(actions), ['Coller ici']);
});

test('« Couper » accompagne Copier, et refuse l’Écran d’entrée avec sa raison', () => {
  const cut = [];
  const actions = buildGraphContextActions({
    inspected: stage(),
    onCopy: () => {},
    onCut: (paths) => cut.push(paths),
    onDuplicate: () => {},
  });
  assert.deepEqual(labels(actions), ['Dupliquer', 'Copier', 'Couper']);
  find(actions, 'Couper').fn();
  assert.deepEqual(cut, [['/stageNodes/@uuid=s1#0']]);

  // L'entrée ne se retire pas : le geste natif refuserait le lot entier, et
  // l'expliquer avant vaut mieux que de l'essuyer après.
  const entryPath = '/stageNodes/@uuid=s1#0';
  const onEntry = buildGraphContextActions({
    inspected: stage(),
    index: {
      byPath: new Map([[entryPath, { node: { squareOne: { presence: 'value', value: true } } }]]),
    },
    onCut: () => {},
  });
  assert.match(find(onEntry, 'Couper').disabledReason, /Écran racine/);
});

// Le menu rend `icon` comme enfant React : un composant passé tel quel (`Package`
// au lieu de `<Package />`) lève « Functions are not valid as a React child ».
test('toute icône d’entrée du menu du graphe est un élément React, jamais un composant', () => {
  const noop = () => {};
  const entries = [
    ...buildGraphSurfaceActions({
      graphPoint: { x: 0, y: 0 },
      onCreateStage: noop,
      onCreateAction: noop,
      onPaste: noop,
      clipboard: { stages: [{}], actions: [] },
    }),
    ...buildGraphContextActions({
      inspected: stage(),
      onSimulateFrom: noop,
      onViewConnections: noop,
      onDuplicate: noop,
      onCopy: noop,
      onCut: noop,
      onDelete: noop,
    }),
    ...buildGraphContextActions({
      inspected: action(),
      onListenFromAction: noop,
      onViewConnections: noop,
    }),
  ].filter((entry) => entry !== 'sep');
  assert.ok(entries.length >= 8);
  for (const entry of entries) {
    if (entry.icon === undefined || entry.icon === null) continue;
    assert.equal(typeof entry.icon, 'object', `icône invalide sur « ${entry.label} »`);
    assert.ok(React.isValidElement(entry.icon), `icône invalide sur « ${entry.label} »`);
  }
});
