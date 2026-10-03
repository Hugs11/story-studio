import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_LINK_DROP,
  GRAPH_LINK_PORTS,
  buildExistingGraphLinkGesture,
  graphLinkPorts,
  isGraphLinkAutoApplyable,
  layoutEntriesFromPositions,
  resolveGraphLinkDrop,
  startGraphLinkDraft,
} from '../src/store/advancedAuthoring/graphLinkDraft.js';
import { action, sampleView, stage } from './advancedViewFixtures.mjs';
import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';

function indexWithControls() {
  const view = sampleView();
  view.stages = [stage('s1', {
    controls: {
      presence: 'value', complete: true,
      ok: { presence: 'value', value: true },
      home: { presence: 'value', value: false },
      autoplay: { presence: 'value', value: false },
    },
  }), stage('s2')];
  view.actions = [action('a1', ['s2', 's2'])];
  view.edges = [];
  return buildGraphIndex(view);
}

test('la prise HOME prépare l’activation explicite du contrôle', () => {
  const index = indexWithControls();
  const stageEntry = index.byPath.get('/stageNodes/@uuid=s1#0');
  assert.deepEqual(graphLinkPorts(stageEntry).map(({ id, active }) => ({ id, active })), [
    { id: GRAPH_LINK_PORTS.STAGE_OK, active: true },
    { id: GRAPH_LINK_PORTS.STAGE_HOME, active: true },
  ]);
  const draft = startGraphLinkDraft(index, stageEntry.path, GRAPH_LINK_PORTS.STAGE_HOME, { x: 1, y: 2 });
  assert.equal(draft.activateControl, true);
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, { selection: '0' }), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'home',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 }, activateControl: true,
  });
});

test('la prise HOME allume la touche avec le raccord, sans confirmation', () => {
  const index = indexWithControls();
  index.byPath.get('/actionNodes/@id=a1#0').node.options.pop();
  const draft = startGraphLinkDraft(index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_HOME, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'home',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 }, activateControl: true,
  });
});

test('la prise OK d’un Écran sans OK ni lecture automatique allume OK avec le raccord', () => {
  const index = indexWithControls();
  const source = index.byPath.get('/stageNodes/@uuid=s1#0');
  source.node.controls.ok = { presence: 'value', value: false };
  index.byPath.get('/actionNodes/@id=a1#0').node.options.pop();
  const okPort = graphLinkPorts(source).find((port) => port.id === GRAPH_LINK_PORTS.STAGE_OK);
  assert.equal(okPort.active, true);
  assert.equal(okPort.activateControl, true);
  const draft = startGraphLinkDraft(index, source.path, GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  assert.equal(draft.kind, 'draft');
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'ok',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 }, activateControl: true,
  });
});

test('la prise OK n’allume rien quand OK ou la lecture automatique joue déjà', () => {
  const index = indexWithControls();
  const source = index.byPath.get('/stageNodes/@uuid=s1#0');
  const okPort = () => graphLinkPorts(source).find((port) => port.id === GRAPH_LINK_PORTS.STAGE_OK);
  assert.equal(okPort().activateControl, false);
  source.node.controls.ok = { presence: 'value', value: false };
  source.node.controls.autoplay = { presence: 'value', value: true };
  assert.equal(okPort().activateControl, false);
});

test('un Écran sans objet de contrôles garde ses prises inactives', () => {
  const index = indexWithControls();
  const source = index.byPath.get('/stageNodes/@uuid=s1#0');
  source.node.controls = { presence: 'absent' };
  assert.deepEqual(graphLinkPorts(source).map(({ id, active }) => ({ id, active })), [
    { id: GRAPH_LINK_PORTS.STAGE_OK, active: false },
    { id: GRAPH_LINK_PORTS.STAGE_HOME, active: false },
  ]);
  const refused = startGraphLinkDraft(index, source.path, GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  assert.equal(refused.kind, GRAPH_LINK_DROP.INACTIVE);
});

test('une transition existante est remplacée sans confirmation', () => {
  const index = indexWithControls();
  const source = index.byPath.get('/stageNodes/@uuid=s1#0');
  source.node.okTransition = { presence: 'value', actionNode: 'a1', optionIndex: 0 };
  // Une seule destination : rien d'autre à demander que le remplacement.
  index.byPath.get('/actionNodes/@id=a1#0').node.options.pop();
  const draft = startGraphLinkDraft(index, source.path, GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'ok',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 },
  });
});

test('Écran vers Action conserve le choix fixe ou aléatoire', () => {
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, { selection: '1' }), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'ok',
    update: { form: 'set', actionNode: 'a1', optionIndex: 1 },
  });
  assert.equal(buildExistingGraphLinkGesture(intent, { selection: 'random' }).update.optionIndex, -1);
});

test('Écran vers Action vide réserve sa première sortie et reste raccordable', () => {
  const index = indexWithControls();
  index.byPath.get('/actionNodes/@id=a1#0').node.options = [];
  const draft = startGraphLinkDraft(index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'connect-stage-to-empty-action',
    stageUuid: 's1', slot: 'ok', actionNode: 'a1',
  });
  assert.equal(isGraphLinkAutoApplyable(intent), true);
});

test('Écran vers Action à sortie unique ne demande pas un choix ambigu', () => {
  const index = indexWithControls();
  index.byPath.get('/actionNodes/@id=a1#0').node.options = ['s2'];
  const draft = startGraphLinkDraft(index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'ok',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 },
  });
  assert.equal(isGraphLinkAutoApplyable(intent), true);
});

test('Écran vers Action à plusieurs sorties arrive sur la première, sans fenêtre', () => {
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/stageNodes/@uuid=s1#0', GRAPH_LINK_PORTS.STAGE_OK, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-stage-transition', stageUuid: 's1', slot: 'ok',
    update: { form: 'set', actionNode: 'a1', optionIndex: 0 },
  });
});

test('Action vers Écran crée une occurrence au rang explicite sans fusionner les répétitions', () => {
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/actionNodes/@id=a1#0', GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/stageNodes/@uuid=s2#0', null);
  assert.equal(intent.suggestedIndex, 2);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, { insertionIndex: '1' }), {
    gesture: 'insert-action-option', actionId: 'a1', index: 1,
    target: { target: 'stage', uuid: 's2' },
  });
  assert.equal(isGraphLinkAutoApplyable(intent), true);
});

test('un raccord qui s’applique seul sait où ranger sa destination', () => {
  // Le chemin que l'application emploie réellement : quand le raccord
  // s'applique sans dialogue, elle construit le geste avec une décision
  // **vide**. L'essai voisin, lui, passe toujours un rang explicite — c'est par
  // ce trou que toute arrivée sur un Écran levait au relâchement.
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/actionNodes/@id=a1#0', GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/stageNodes/@uuid=s2#0', null);
  assert.equal(isGraphLinkAutoApplyable(intent), true);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'insert-action-option', actionId: 'a1', index: 2,
    target: { target: 'stage', uuid: 's2' },
  }, 'la prise d’ajout range à la fin, comme son dessin l’annonce');
});

test('un trait depuis une Action complète la destination manquante avant d’en ajouter une', () => {
  const index = indexWithControls();
  index.byPath.get('/actionNodes/@id=a1#0').node.options = action('a1', [null, 's2']).options;
  const actionEntry = index.byPath.get('/actionNodes/@id=a1#0');
  assert.equal(graphLinkPorts(actionEntry)[0].label, 'Raccorder le choix manquant');
  const draft = startGraphLinkDraft(index, actionEntry.path, GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/stageNodes/@uuid=s2#0', null);
  assert.equal(intent.missingOptionIndex, 0);
  assert.deepEqual(buildExistingGraphLinkGesture(intent, {}), {
    gesture: 'set-action-option-target', actionId: 'a1', ordinal: 0,
    target: { target: 'stage', uuid: 's2' },
  });
  assert.equal(isGraphLinkAutoApplyable(intent), true);
});

test('sans rang nulle part, le raccord refuse encore', () => {
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/actionNodes/@id=a1#0', GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, '/stageNodes/@uuid=s2#0', null);
  assert.throws(
    () => buildExistingGraphLinkGesture({ ...intent, suggestedIndex: null }, {}),
    TypeError,
  );
});

test('les couples impossibles refusent et le vide conserve le point du graphe', () => {
  const index = indexWithControls();
  const draft = startGraphLinkDraft(index, '/actionNodes/@id=a1#0', GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  assert.equal(resolveGraphLinkDrop(index, draft, '/actionNodes/@id=a1#0', null).kind, GRAPH_LINK_DROP.INVALID);
  assert.deepEqual(resolveGraphLinkDrop(index, draft, null, { x: 42, y: -9 }).graphPoint, { x: 42, y: -9 });
});

test('une disposition emploie les identités métier sans recomposer les chemins', () => {
  const index = indexWithControls();
  assert.deepEqual(layoutEntriesFromPositions(index, [
    { path: '/stageNodes/@uuid=s1#0', x: 12, y: 18 },
    { path: '/actionNodes/@id=a1#0', x: -3, y: 8 },
  ]), [
    { node: { kind: 'stage', id: 's1' }, position: { x: 12, y: 18 } },
    { node: { kind: 'action', id: 'a1' }, position: { x: -3, y: 8 } },
  ]);
});

test('un choix tiré vers l’Écran d’entrée est refusé avant le geste', () => {
  const index = indexWithControls();
  const entry = index.byPath.get('/stageNodes/@uuid=s1#0');
  entry.node.squareOne = { presence: 'value', value: true };
  const draft = startGraphLinkDraft(index, '/actionNodes/@id=a1#0', GRAPH_LINK_PORTS.ACTION_OPTION, { x: 0, y: 0 });
  const intent = resolveGraphLinkDrop(index, draft, entry.path, null);
  assert.equal(intent.kind, GRAPH_LINK_DROP.INVALID);
  assert.match(intent.reason, /Écran d’entrée ne peut pas être le choix d’une liste/);
  assert.equal(isGraphLinkAutoApplyable(intent), false);
  // Un autre Écran reste un choix possible.
  const other = resolveGraphLinkDrop(index, draft, '/stageNodes/@uuid=s2#0', null);
  assert.equal(other.kind, GRAPH_LINK_DROP.EXISTING);
});
