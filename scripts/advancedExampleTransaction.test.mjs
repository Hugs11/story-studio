import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleSubgraph, initialRootUuid, prepareExampleInsertion, exampleInsertionAnchor } from '../src/store/advancedExamples/transaction.js';
import { createAdvancedAuthoringSession } from '../src/store/advancedAuthoring/authoringSession.js';

const example = {
  id: 'test', title: 'Mon exemple nommé', entryRank: 0,
  stages: [{ name: 'Mon entrée', controls: { wheel: false, ok: true, home: false, pause: false, autoplay: false }, offset: { x: 10, y: 20 }, mediaIntent: { image: true, audio: false } }],
  actions: [{ name: 'Mes choix', options: [], offset: { x: 300, y: 20 } }],
  transitions: [],
};
const value = (v) => ({ presence: 'value', value: v });
const root = {
  uuid: 'old-root', squareOne: value(true), name: value('Écran 1'),
  controls: { presence: 'value', wheel: value(false), ok: value(true), home: value(false), pause: value(false), autoplay: value(false) },
  personalColor: null, audio: { presence: 'null' }, image: { presence: 'null' },
};

function harness({ view = { stages: [root], actions: [] }, failAt = null, gate = null } = {}) {
  const state = { epoch: 1, project: { revision: 'initial', identity: 'same-pack' }, commits: [], calls: [] };
  const applyGesture = async (project, gesture) => {
    state.calls.push(gesture);
    if (gate && state.calls.length === 1) await gate;
    if (gesture.gesture === failAt) throw new Error('Refus natif');
    return { project: { ...project, revision: `${project.revision}/${gesture.gesture}` }, report: gesture.gesture === 'paste-subgraph'
      ? { construction: { stages: ['new-entry'], actions: ['new-action'] } } : {} };
  };
  const session = createAdvancedAuthoringSession({
    readProject: () => state.project,
    readTicket: () => ({ projectEpoch: state.epoch, document: state.project.revision }),
    applyGesture,
    commit: ({ project }) => { state.project = project; state.commits.push(project); },
  });
  const run = () => session.run({ execute: (project, context) => prepareExampleInsertion(project, example, {
    ...context, readView: async () => view, anchor: { x: 500, y: 600 },
  }) });
  return { state, session, run };
}

test('la demande garde les positions et ne fabrique pas de médias selon les intentions', () => {
  const subgraph = exampleSubgraph(example, { x: 100, y: 200 });
  assert.deepEqual(subgraph.stages[0].position, { x: 110, y: 220 });
  assert.equal(subgraph.stages[0].image, null);
  assert.equal(subgraph.stages[0].audio, null);
  assert.equal('mediaIntent' in subgraph.stages[0], false);
  assert.equal('role' in subgraph.stages[0], false);
  assert.throws(() => exampleSubgraph({ ...example, entryRank: 5 }));
  assert.throws(() => exampleSubgraph(example, { x: NaN, y: 0 }));
});

test('une entrée solitaire avec média ou raccord est préservée', () => {
  assert.equal(initialRootUuid({ stages: [root], actions: [] }), 'old-root');
  for (const field of ['audio', 'image', 'okTransition', 'homeTransition']) {
    assert.equal(initialRootUuid({ stages: [{ ...root, [field]: { presence: 'value' } }], actions: [] }), null);
  }
  assert.equal(initialRootUuid({ stages: [root], actions: [{}] }), null);
});

test('une entrée solitaire renommée, réglée ou colorée par l’auteur n’est pas remplacée', () => {
  assert.equal(initialRootUuid({ stages: [{ ...root, name: value('  Écran 1 ') }], actions: [] }), 'old-root');
  for (const stage of [
    { ...root, name: value('Ma première page') },
    { ...root, name: { presence: 'null', value: null } },
    { ...root, controls: { ...root.controls, wheel: value(true) } },
    { ...root, controls: { ...root.controls, autoplay: { presence: 'absent', value: null } } },
    { ...root, controls: undefined },
    { ...root, personalColor: '#ff8800' },
  ]) {
    assert.equal(initialRootUuid({ stages: [stage], actions: [] }), null);
  }
});

test('une entrée renommée reste en place : l’exemple s’ajoute à côté, sans la supprimer', async () => {
  const { state, run } = harness({ view: { stages: [{ ...root, name: value('Mon histoire') }], actions: [] } });
  const outcome = await run();
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(state.calls.map((g) => g.gesture), ['paste-subgraph']);
  assert.equal(outcome.report.example.replacedInitialRoot, false);
});

test('remplacement du squelette : entrée réassignée, identité conservée et un seul commit', async () => {
  const { state, run } = harness();
  const outcome = await run();
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(state.calls.map((g) => g.gesture), ['paste-subgraph', 'set-square-one', 'delete-stage', 'set-document-metadata']);
  assert.equal(state.calls[1].stageUuid, 'new-entry');
  assert.equal(state.calls[2].stageUuid, 'old-root');
  assert.equal(state.project.identity, 'same-pack');
  assert.equal(state.project.projectName, example.title);
  assert.deepEqual(state.calls[3].update, { title: { form: 'set', value: example.title } });
  assert.equal(state.commits.length, 1);
  assert.equal(state.epoch, 1);
  assert.deepEqual(outcome.report.example, { id: 'test', stages: ['new-entry'], actions: ['new-action'], entryUuid: 'new-entry', replacedInitialRoot: true, anchor: { x: 0, y: 0 } });
});

test('insertion : aucun changement d’entrée ou raccord implicite', async () => {
  const { state, run } = harness({ view: { stages: [root, { uuid: 'content' }], actions: [] } });
  const outcome = await run();
  assert.deepEqual(state.calls.map((g) => g.gesture), ['paste-subgraph']);
  assert.deepEqual(state.calls[0].subgraph.stages[0].position, { x: 510, y: 620 });
  assert.equal(outcome.report.example.replacedInitialRoot, false);
  assert.equal(state.commits.length, 1);
});

test('un refus de la dernière étape ne publie aucun remplacement partiel', async () => {
  const { state, run } = harness({ failAt: 'delete-stage' });
  const before = state.project;
  const outcome = await run();
  assert.equal(outcome.status, 'refused');
  assert.equal(state.project, before);
  assert.equal(state.commits.length, 0);
});

test('changement d’époque ou undo en vol interrompt les étapes sans commit', async () => {
  for (const change of [(state) => { state.epoch += 1; }, (state) => { state.project = { ...state.project, revision: 'undo' }; }]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { state, session, run } = harness({ gate });
    const pending = run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await session.run({ gesture: { gesture: 'other' } })).status, 'busy');
    change(state);
    release();
    assert.equal((await pending).status, 'stale');
    assert.equal(state.calls.length, 1);
    assert.equal(state.commits.length, 0);
  }
});

test('le verrou de production empêche toute préparation de l’exemple', async () => {
  const { session, state, run } = harness();
  session.hold('export');
  assert.equal((await run()).status, 'held');
  assert.equal(state.calls.length, 0);
});

test('une seconde insertion se place hors du premier bloc, avec ses décalages conservés', () => {
  const view = { stages: [{ layout: { x: 0, y: 0 } }], actions: [] };
  const first = exampleInsertionAnchor(view, example, { x: 0, y: 0 });
  const placed = exampleSubgraph(example, first);
  const expanded = {
    stages: [...view.stages, ...placed.stages.map((node) => ({ layout: node.position }))],
    actions: placed.actions.map((node) => ({ layout: node.position })),
  };
  const second = exampleInsertionAnchor(expanded, example, first);
  assert.ok(second.x + 10 >= first.x + 300 + 400);
  assert.equal(second.y, first.y);
});

test('placement borné : repli dessous, gauche puis dessus et refus si rectangle saturé', () => {
  const anchor = exampleInsertionAnchor({ stages: [{ layout: { x: 32760, y: 0 } }], actions: [] }, example);
  // La préférence libre (0,0) reste utilisable, même si le graphe touche le bord.
  assert.deepEqual(anchor, { x: 0, y: 0 });
  const below = exampleInsertionAnchor({ stages: [{ layout: { x: 32760, y: 0 } }], actions: [] }, example, { x: 32760, y: 0 });
  assert.equal(below.y, 380);
  const left = exampleInsertionAnchor({ stages: [{ layout: { x: 32760, y: 32760 } }], actions: [] }, example, { x: 32760, y: 32760 });
  assert.equal(left.x, 32060);
  const above = exampleInsertionAnchor({ stages: [{ layout: { x: -32768, y: 32767 } }, { layout: { x: 32767, y: 32767 } }], actions: [] }, example, { x: 0, y: 32767 });
  assert.equal(above.y, 32347);
  assert.throws(() => exampleInsertionAnchor({ stages: [{ layout: { x: -32768, y: -32768 } }, { layout: { x: 32767, y: 32767 } }], actions: [] }, example), { code: 'EXAMPLE_POSITION_UNAVAILABLE' });
});

test('remplacement : nommer le placeholder et préserver le titre ou nom personnalisé', async () => {
  for (const title of ['', 'Nouveau pack', 'Mon titre personnel']) {
    const { state, run } = harness({ view: { stages: [root], actions: [], metadata: { title: { presence: 'value', value: title } } } });
    state.project.projectName = 'Mon fichier personnel';
    const outcome = await run();
    assert.equal(outcome.status, 'applied');
    assert.equal(state.calls.some((g) => g.gesture === 'set-document-metadata'), title !== 'Mon titre personnel');
    assert.equal(state.project.projectName, 'Mon fichier personnel');
    assert.equal(state.commits.length, 1);
  }
});
