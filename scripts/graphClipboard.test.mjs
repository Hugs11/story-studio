// Le presse-papier du graphe avancé : ce qu'une copie retient, et ce qu'elle
// laisse volontairement derrière elle.
//
// La règle qui tient tout le fichier : **une description est autonome**. Aucun
// uuid, aucun chemin d'auteur, aucune référence au document d'origine n'y
// survit. Un uuid recopié désignerait le nœud modèle, et un motif collé se
// raccorderait à sa source au lieu de sa copie — c'est le défaut que ces
// essais interdisent.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  describeGraphSelection,
  pasteLandingPoints,
  pasteSubgraphGesture,
  readGraphClipboard,
  writeGraphClipboard,
  clearGraphClipboard,
} = await import('../src/store/advancedAuthoring/graphClipboard.js');
const { buildGraphIndex } = await import('../src/store/advancedGraphView/graphViewModel.js');

const value = (v) => ({ presence: 'value', value: v });
const absent = () => ({ presence: 'absent', value: null });

function controls({ wheel = false, ok = false, home = false, pause = false, autoplay = false } = {}) {
  return {
    presence: 'value',
    wheel: value(wheel),
    ok: value(ok),
    home: value(home),
    pause: value(pause),
    autoplay: value(autoplay),
    complete: true,
  };
}

function stagePath(uuid) { return `/stageNodes/@uuid=${uuid}#0`; }
function actionPath(id) { return `/actionNodes/@id=${id}#0`; }

function stage(uuid, { name = null, x = 0, y = 0, audio = null, image = null, ok = null, home = null, ...rest } = {}) {
  return {
    path: stagePath(uuid),
    uuid,
    uniqueId: true,
    name: name === null ? absent() : value(name),
    fallbackLabel: '',
    squareOne: value(false),
    controls: rest.controls ?? controls(),
    audio: audio ? { presence: 'value', assetRef: audio } : { presence: 'null', assetRef: null },
    image: image ? { presence: 'value', assetRef: image } : { presence: 'null', assetRef: null },
    okTransition: ok ?? { presence: 'absent', actionId: null, actionPath: null, selection: null, withinBounds: false },
    homeTransition: home ?? { presence: 'absent', actionId: null, actionPath: null, selection: null, withinBounds: false },
    layout: { x, y, source: 'authored' },
  };
}

function transition(id, selection, withinBounds = true) {
  return {
    presence: 'value',
    actionId: id,
    actionPath: actionPath(id),
    selection,
    withinBounds,
    selectedOptionId: null,
    resolvedStagePath: null,
  };
}

function action(id, targets, { name = null, x = 0, y = 0 } = {}) {
  return {
    path: actionPath(id),
    id,
    uniqueId: true,
    name: name === null ? absent() : value(name),
    fallbackLabel: 'Action node',
    options: targets.map((uuid, ordinal) => ({
      optionId: `${id}#${ordinal}`,
      ordinal,
      target: uuid
        ? { presence: 'value', stageUuid: uuid, stagePath: stagePath(uuid), dangling: false }
        : { presence: 'null', stageUuid: null, stagePath: null, dangling: false },
    })),
    layout: { x, y, source: 'authored' },
  };
}

// Le motif type d'un collage : deux Écrans, une Action, plus un Écran **hors**
// sélection vers lequel l'Action pointe aussi.
function sample() {
  const view = {
    stages: [
      stage('s1', { name: 'Clairière', x: 100, y: 200, controls: controls({ ok: true }), ok: transition('a1', { kind: 'fixed', index: 0 }) }),
      stage('s2', { name: 'Rivière', x: 260, y: 240, audio: 'ruisseau.mp3' }),
      stage('dehors', { name: 'Ailleurs', x: 900, y: 900 }),
    ],
    actions: [action('a1', ['s2', 'dehors', null], { name: 'Suite', x: 180, y: 200 })],
    edges: [],
    mediaRefs: [],
    diagnostics: [],
  };
  return buildGraphIndex(view);
}

const MOTIF = [stagePath('s1'), stagePath('s2'), actionPath('a1')];

test('une description ne porte ni uuid, ni chemin d’auteur, ni référence au modèle', () => {
  const description = describeGraphSelection(sample(), MOTIF);
  const written = JSON.stringify({ ...description, anchor: null });
  for (const token of ['s1', 's2', 'a1', 'dehors', 'stageNodes', 'actionNodes']) {
    assert.ok(!written.includes(token), `la description ne doit pas porter « ${token} » : ${written}`);
  }
});

test('les raccords internes sont recopiés par rang, ceux qui sortent sont perdus', () => {
  const { stages, actions, transitions } = describeGraphSelection(sample(), MOTIF);
  assert.equal(stages.length, 2);
  assert.equal(actions.length, 1);
  // L'occurrence 0 vise un Écran copié : elle garde sa destination, par rang.
  // L'occurrence 1 visait un Écran laissé dehors : elle **garde son rang** et
  // perd sa destination, sans quoi les rangs suivants glisseraient dans la roue.
  assert.deepEqual(actions[0].options, [
    { target: 'stage', stage: 1 },
    { target: 'null' },
    { target: 'null' },
  ]);
  assert.deepEqual(transitions, [{ stage: 0, slot: 'ok', action: 0, optionIndex: 0 }]);
});

test('une transition vers une Action hors sélection n’est pas recopiée', () => {
  const index = sample();
  const description = describeGraphSelection(index, [stagePath('s1'), stagePath('s2')]);
  assert.deepEqual(description.transitions, [], 'l’Action n’est pas du voyage');
  assert.equal(description.actions.length, 0);
});

test('une sélection déjà hors bornes est laissée derrière, jamais propagée', () => {
  // Le geste natif la refuserait, et un collage n'a pas à fabriquer une erreur
  // bloquante que l'auteur n'a pas demandée.
  const view = {
    stages: [stage('s1', { ok: transition('a1', { kind: 'fixed', index: 7 }, false) })],
    actions: [action('a1', ['s1'])],
    edges: [], mediaRefs: [], diagnostics: [],
  };
  const description = describeGraphSelection(buildGraphIndex(view), [stagePath('s1'), actionPath('a1')]);
  assert.deepEqual(description.transitions, []);
});

test('une sélection aléatoire traverse la copie comme telle', () => {
  const view = {
    stages: [stage('s1', { ok: transition('a1', { kind: 'random' }) })],
    actions: [action('a1', ['s1'])],
    edges: [], mediaRefs: [], diagnostics: [],
  };
  const description = describeGraphSelection(buildGraphIndex(view), [stagePath('s1'), actionPath('a1')]);
  // `-1` est `Random` dans le dialecte : il n'est jamais rabattu vers `0`.
  assert.deepEqual(description.transitions, [{ stage: 0, slot: 'ok', action: 0, optionIndex: -1 }]);
});

// Un projet réduit à ses liaisons médias : c'est tout ce que la copie et le
// collage en lisent.
function projectWith(bindings) {
  return { authoring: { mediaBindings: bindings } };
}
const bound = (assetRef, path, status = 'resolved') => ({ assetRef, path, status });
const SOURCE = projectWith([bound('ruisseau.mp3', '/projets/A/ruisseau.mp3')]);

test('la copie emporte le fichier de chaque média', () => {
  const { stages } = describeGraphSelection(sample(), MOTIF, SOURCE);
  assert.deepEqual(stages[1].audio, {
    assetRef: 'ruisseau.mp3',
    file: { path: '/projets/A/ruisseau.mp3', present: true },
  });
  assert.equal(stages[1].image, null);
});

function pastedAudio(description, target) {
  return pasteSubgraphGesture(description, null, target).subgraph.stages.map((one) => one.audio);
}

test('coller dans le projet de la copie partage la liaison, sans emplacement', () => {
  const description = describeGraphSelection(sample(), MOTIF, SOURCE);
  // Un emplacement exigerait une référence **libre** côté natif : le collage
  // partage la liaison existante, il ne la re-pointe pas.
  assert.deepEqual(pastedAudio(description, SOURCE)[1], { assetRef: 'ruisseau.mp3' });
});

// Le cas qui justifie tout : les références dérivent du nom de fichier, et un
// autre projet peut porter la même référence vers un autre fichier.
test('une référence homonyme d’un autre projet n’est jamais rebranchée', () => {
  const description = describeGraphSelection(sample(), MOTIF, SOURCE);
  const other = projectWith([bound('ruisseau.mp3', '/projets/B/ruisseau.mp3')]);
  assert.deepEqual(pastedAudio(description, other)[1], {
    assetRef: 'ruisseau-2.mp3',
    location: { path: '/projets/A/ruisseau.mp3', present: true },
  });
});

test('un autre projet qui porte déjà le fichier le partage', () => {
  const description = describeGraphSelection(sample(), MOTIF, SOURCE);
  const other = projectWith([bound('eau.mp3', '/projets/A/ruisseau.mp3')]);
  assert.deepEqual(pastedAudio(description, other)[1], { assetRef: 'eau.mp3' });
});

test('un projet qui ignore le fichier reçoit une liaison neuve', () => {
  const description = describeGraphSelection(sample(), MOTIF, SOURCE);
  assert.deepEqual(pastedAudio(description, projectWith([]))[1], {
    assetRef: 'ruisseau.mp3',
    location: { path: '/projets/A/ruisseau.mp3', present: true },
  });
});

test('deux Écrans qui partageaient un fichier le partagent encore une fois collés', () => {
  const view = {
    stages: [
      stage('s1', { audio: 'voix.flac' }),
      stage('s2', { audio: 'voix.flac' }),
      stage('s3', { audio: 'voix-2.flac' }),
    ],
    actions: [], edges: [], mediaRefs: [], diagnostics: [],
  };
  // Deux fichiers différents au même nom de base : ils restent deux liaisons.
  const source = projectWith([
    bound('voix.flac', '/a/voix.flac'),
    bound('voix-2.flac', '/b/voix.flac'),
  ]);
  const description = describeGraphSelection(
    buildGraphIndex(view), [stagePath('s1'), stagePath('s2'), stagePath('s3')], source,
  );
  assert.deepEqual(pastedAudio(description, projectWith([bound('voix.flac', '/ailleurs/voix.flac')])), [
    { assetRef: 'voix-2.flac', location: { path: '/a/voix.flac', present: true } },
    { assetRef: 'voix-2.flac' },
    { assetRef: 'voix-3.flac', location: { path: '/b/voix.flac', present: true } },
  ]);
});

test('une référence sans liaison dans la source part comme un média manquant', () => {
  const description = describeGraphSelection(sample(), MOTIF, projectWith([]));
  assert.deepEqual(description.stages[1].audio.file, { path: null, present: false });
  const other = projectWith([bound('ruisseau.mp3', '/projets/B/ruisseau.mp3')]);
  assert.deepEqual(pastedAudio(description, other)[1], {
    assetRef: 'ruisseau-2.mp3',
    location: { path: null, present: false },
  });
});

test('les cinq contrôles partent complets, même si la source est partielle', () => {
  const view = {
    stages: [stage('s1', { controls: { presence: 'value', wheel: value(true), ok: absent(), home: value(false), pause: absent(), autoplay: value(true), complete: false } })],
    actions: [], edges: [], mediaRefs: [], diagnostics: [],
  };
  const { stages } = describeGraphSelection(buildGraphIndex(view), [stagePath('s1')]);
  // Les cinq booléens sont exigés de qui crée un Écran, et Story
  // Studio ne fabrique jamais d'objet partiel. Un contrôle absent est collé à
  // faux, comme l'Écran créé depuis l'en-tête l'est déjà.
  assert.deepEqual(stages[0].controls, {
    wheel: true, ok: false, home: false, pause: false, autoplay: true,
  });
});

test('les positions sont relatives à l’ancre, et l’ancre est le coin haut-gauche', () => {
  const { stages, actions, anchor } = describeGraphSelection(sample(), MOTIF);
  assert.deepEqual(anchor, { x: 100, y: 200 });
  assert.deepEqual(stages.map((one) => one.offset), [{ x: 0, y: 0 }, { x: 160, y: 40 }]);
  assert.deepEqual(actions[0].offset, { x: 80, y: 0 });
});

test('le collage repose la forme telle quelle au point demandé', () => {
  const description = describeGraphSelection(sample(), MOTIF);
  const gesture = pasteSubgraphGesture(description, { x: -50, y: 10 });
  assert.equal(gesture.gesture, 'paste-subgraph');
  assert.deepEqual(gesture.subgraph.stages.map((one) => one.position), [
    { x: -50, y: 10 }, { x: 110, y: 50 },
  ]);
  assert.deepEqual(gesture.subgraph.actions[0].position, { x: 30, y: 10 });
  // La forme est conservée : les écarts entre les cartes sont ceux du modèle.
  assert.deepEqual(gesture.subgraph.transitions, description.transitions);
  // L'ancre reste hors de la demande : elle dit d'où le motif vient, pas ce
  // qu'il faut créer.
  for (const node of [...gesture.subgraph.stages, ...gesture.subgraph.actions]) {
    assert.ok(!Object.hasOwn(node, 'offset'));
    assert.ok(!Object.hasOwn(node, 'anchor'));
  }
});

test('sans ancre, le collage laisse la disposition placer les nœuds', () => {
  const gesture = pasteSubgraphGesture(describeGraphSelection(sample(), MOTIF), null);
  for (const node of [...gesture.subgraph.stages, ...gesture.subgraph.actions]) {
    assert.equal(node.position, null);
  }
});

test('les places qu’un collage occupera sont énumérables avant qu’il parte', () => {
  const description = describeGraphSelection(sample(), MOTIF);
  assert.deepEqual(pasteLandingPoints(description, { x: 0, y: 0 }), [
    { x: 0, y: 0 }, { x: 160, y: 40 }, { x: 80, y: 0 },
  ]);
  assert.deepEqual(pasteLandingPoints(description, null), []);
});

test('une sélection vide ou introuvable ne remplit pas le presse-papier', () => {
  const index = sample();
  assert.equal(describeGraphSelection(index, []), null);
  assert.equal(describeGraphSelection(index, ['/nulle/part']), null);
  assert.equal(describeGraphSelection(null, MOTIF), null);
  assert.equal(pasteSubgraphGesture(null, { x: 0, y: 0 }), null);
});

test('le presse-papier survit au démontage du panneau', () => {
  clearGraphClipboard();
  assert.equal(readGraphClipboard(), null);
  const description = describeGraphSelection(sample(), MOTIF);
  writeGraphClipboard(description);
  assert.equal(readGraphClipboard(), description);
  clearGraphClipboard();
  assert.equal(readGraphClipboard(), null);
});

