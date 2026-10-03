import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ADVANCED_GESTURE_NAMES,
  RANDOM_OPTION_INDEX,
  advancedGestures,
  applyAdvancedGesture,
  graphNode,
  optionResolution,
  optionTarget,
  presence,
  selectionResolution,
} from '../src/store/projectModel.js';

const EDITING_MOD = fileURLToPath(
  new URL('../src-tauri/src/native_pack/editing/mod.rs', import.meta.url),
);

// La façade JS est un miroir de l'énumération Rust, comme `generatedNavigation.js`
// l'est du générateur : un geste ajouté d'un seul côté est une dérive, et ce
// test la fait échouer au lieu de la laisser sortir en refus de désérialisation.
test('la liste des gestes suit exactement celle que Rust accepte', () => {
  const source = readFileSync(EDITING_MOD, 'utf8');
  const block = source.slice(source.indexOf('fn name(&self)'));
  const declared = [...block.matchAll(/=> \{?\s*"([a-z-]+)"/g)].map(([, name]) => name);
  assert.deepEqual([...ADVANCED_GESTURE_NAMES].sort(), [...declared].sort());
  assert.equal(new Set(ADVANCED_GESTURE_NAMES).size, ADVANCED_GESTURE_NAMES.length);
});

test('les trois formes de présence d’un champ (absent, `null`, valeur) restent distinctes', () => {
  assert.deepEqual(presence.value(false), { form: 'set', value: false });
  assert.deepEqual(presence.null(), { form: 'null' });
  assert.deepEqual(presence.absent(), { form: 'absent' });
  // `null` et `absent` ne sont pas interchangeables : le retrait porte sa forme.
  assert.notDeepEqual(presence.null(), presence.absent());
});

test('un contrôle se modifie seul et la complétion nomme les cinq valeurs', () => {
  assert.deepEqual(advancedGestures.setStageControls('s1', { ok: presence.value(false) }), {
    gesture: 'set-stage-controls',
    stageUuid: 's1',
    update: { form: 'members', members: { ok: { form: 'set', value: false } } },
  });
  assert.deepEqual(
    advancedGestures.completeStageControls('s1', {
      wheel: true,
      ok: true,
      home: false,
      pause: false,
      autoplay: false,
    }),
    {
      gesture: 'set-stage-controls',
      stageUuid: 's1',
      update: {
        form: 'complete',
        wheel: true,
        ok: true,
        home: false,
        pause: false,
        autoplay: false,
      },
    },
  );
  // Un geste qui ne nomme aucun contrôle ne part pas : Rust le refuserait, mais
  // le dire ici évite un aller-retour IPC pour une faute d'appel.
  assert.throws(() => advancedGestures.setStageControls('s1', {}), TypeError);
  assert.deepEqual(advancedGestures.setStagesControls(['s1', 's2'], { pause: presence.value(true) }), {
    gesture: 'set-stages-controls',
    stageUuids: ['s1', 's2'],
    update: { form: 'members', members: { pause: { form: 'set', value: true } } },
  });
  assert.throws(() => advancedGestures.setStagesControls([], { pause: presence.value(true) }), TypeError);
  assert.throws(() => advancedGestures.setStagesControls(['s1'], {}), TypeError);
  assert.throws(() => advancedGestures.setStageControls('s1', { volume: presence.value(true) }), TypeError);
});

test('une occurrence d’option est adressée par son rang, jamais par sa cible', () => {
  assert.deepEqual(advancedGestures.insertActionOption('a1', 2, optionTarget.stage('s2')), {
    gesture: 'insert-action-option',
    actionId: 'a1',
    index: 2,
    target: { target: 'stage', uuid: 's2' },
  });
  assert.deepEqual(advancedGestures.setActionOptionTarget('a1', 0, optionTarget.null()), {
    gesture: 'set-action-option-target',
    actionId: 'a1',
    ordinal: 0,
    target: { target: 'null' },
  });
  // La permutation transporte des rangs : deux occurrences de même destination
  // restent deux rangs, et rien ne peut les fusionner en chemin.
  assert.deepEqual(advancedGestures.reorderActionOptions('a1', [1, 2, 3, 0]), {
    gesture: 'reorder-action-options',
    actionId: 'a1',
    newPositionOfOld: [1, 2, 3, 0],
  });
  assert.throws(() => advancedGestures.reorderActionOptions('a1', ['premier']), TypeError);
  assert.throws(() => advancedGestures.insertActionOption('a1', -1, optionTarget.null()), TypeError);
});

test('le nom et la couleur gardent leurs identités propres', () => {
  assert.deepEqual(
    advancedGestures.setNodeName(graphNode.action('a1'), presence.value('Nouveau nom')),
    {
      gesture: 'set-node-name',
      node: { kind: 'action', id: 'a1' },
      update: { form: 'set', value: 'Nouveau nom' },
    },
  );
  const paths = ['/stageNodes/@uuid=s1#0', '/actionNodes/@id=a1#0'];
  assert.deepEqual(advancedGestures.setNodeColor(paths, '#7c6af7'), {
    gesture: 'set-node-color', paths, color: '#7c6af7',
  });
  assert.deepEqual(advancedGestures.setNodeColor([paths[0]], null), {
    gesture: 'set-node-color', paths: [paths[0]], color: null,
  });
  assert.throws(() => advancedGestures.setNodeColor([], null), TypeError);
});

test('le retrait d’une option transporte les décisions qu’il exige', () => {
  assert.deepEqual(
    advancedGestures.removeActionOption('a1', 1, [
      { stageUuid: 's1', slot: 'ok', resolution: selectionResolution.select(0) },
      { stageUuid: 's1', slot: 'home', resolution: selectionResolution.removeAsAbsent() },
    ]),
    {
      gesture: 'remove-action-option',
      actionId: 'a1',
      ordinal: 1,
      selections: [
        { stageUuid: 's1', slot: 'ok', resolution: { form: 'select', optionIndex: 0 } },
        { stageUuid: 's1', slot: 'home', resolution: { form: 'absent' } },
      ],
    },
  );
  // `-1` reste la sentinelle `Random` du dialecte, nommée et jamais rabattue.
  assert.deepEqual(selectionResolution.random(), { form: 'select', optionIndex: RANDOM_OPTION_INDEX });
  assert.equal(RANDOM_OPTION_INDEX, -1);
  assert.throws(
    () => advancedGestures.removeActionOption('a1', 0, [
      { stageUuid: 's1', slot: 'wheel', resolution: selectionResolution.removeAsNull() },
    ]),
    TypeError,
  );
  // Sans décision, la demande part quand même : c'est Rust qui inventorie les
  // transitions concernées, la façade ne devine pas à sa place.
  assert.deepEqual(advancedGestures.removeActionOption('a1', 0).selections, []);
});

test('le média local et le remplacement global sont deux gestes distincts', () => {
  assert.deepEqual(advancedGestures.repointMedia('a1b2c3.mp3', { path: '/m/x.mp3', present: true }), {
    gesture: 'repoint-media',
    assetRef: 'a1b2c3.mp3',
    location: { path: '/m/x.mp3', present: true },
  });
  // Partage d'une référence déjà liée : aucun emplacement, donc aucune liaison
  // re-pointée en silence.
  assert.deepEqual(
    advancedGestures.setStageMedia('s1', 'image', advancedGestures.stageMedia('d4e5f6.png')),
    {
      gesture: 'set-stage-media',
      stageUuid: 's1',
      field: 'image',
      update: { form: 'set', assetRef: 'd4e5f6.png' },
    },
  );
  assert.deepEqual(
    advancedGestures.setStageMedia('s1', 'audio', presence.null()).update,
    { form: 'null' },
  );
  assert.throws(() => advancedGestures.setStageMedia('s1', 'video', presence.null()), TypeError);
});

test('un retrait porte son plan explicite ou part sans, pour être inventorié', () => {
  assert.deepEqual(advancedGestures.deleteStage('s2'), {
    gesture: 'delete-stage',
    stageUuid: 's2',
  });
  const plan = advancedGestures.stageRemovalPlan({
    options: [
      { actionId: 'a1', ordinal: 0, resolution: optionResolution.retarget('s3') },
      { actionId: 'a1', ordinal: 2, resolution: optionResolution.remove() },
    ],
    selections: [{ stageUuid: 's1', slot: 'ok', resolution: selectionResolution.removeAsNull() }],
  });
  assert.deepEqual(advancedGestures.deleteStage('s2', plan), {
    gesture: 'delete-stage',
    stageUuid: 's2',
    plan: {
      options: [
        { actionId: 'a1', ordinal: 0, resolution: { form: 'retarget', uuid: 's3' } },
        { actionId: 'a1', ordinal: 2, resolution: { form: 'remove' } },
      ],
      selections: [{ stageUuid: 's1', slot: 'ok', resolution: { form: 'null' } }],
    },
  });
  assert.deepEqual(
    advancedGestures.deleteAction(
      'a1',
      advancedGestures.actionRemovalPlan([
        { stageUuid: 's1', slot: 'ok', update: advancedGestures.transitionTo('a2', 0) },
      ]),
    ),
    {
      gesture: 'delete-action',
      actionId: 'a1',
      plan: {
        transitions: [
          {
            stageUuid: 's1',
            slot: 'ok',
            update: { form: 'set', actionNode: 'a2', optionIndex: 0 },
          },
        ],
      },
    },
  );
});

test('les positions distinguent la vue, l’auteur et la promotion explicite', () => {
  assert.deepEqual(advancedGestures.setAuthoredPosition(graphNode.stage('s1'), { x: 18.25, y: -40 }), {
    gesture: 'set-authored-position',
    node: { kind: 'stage', id: 's1' },
    position: { x: 18.25, y: -40 },
  });
  assert.deepEqual(
    advancedGestures.setAuthoredPositions([
      { node: graphNode.stage('s1'), position: { x: 1, y: 2 } },
      { node: graphNode.action('a1'), position: { x: 3, y: 4 } },
    ]),
    {
      gesture: 'set-authored-positions',
      positions: [
        { node: { kind: 'stage', id: 's1' }, position: { x: 1, y: 2 } },
        { node: { kind: 'action', id: 'a1' }, position: { x: 3, y: 4 } },
      ],
    },
  );
  assert.throws(() => advancedGestures.setAuthoredPositions([]), TypeError);
  assert.deepEqual(
    advancedGestures.applyViewLayout([
      { node: graphNode.action('a1'), position: { x: 120, y: 0 } },
    ]),
    {
      gesture: 'apply-view-layout',
      positions: [{ node: { kind: 'action', id: 'a1' }, position: { x: 120, y: 0 } }],
    },
  );
  assert.deepEqual(advancedGestures.applyLayoutToAuthoring([], 'scale'), {
    gesture: 'apply-layout-to-authoring',
    nodes: [],
    outOfRange: 'scale',
  });
  // La politique hors borne est requise : créer une valeur hors
  // `[-32768, 32767]` sans décision explicite est interdit.
  assert.throws(() => advancedGestures.applyLayoutToAuthoring([], 'clamp'), TypeError);
  assert.throws(() => advancedGestures.applyViewLayout([]), TypeError);
});

test('la création raccordée reste une demande atomique unique', () => {
  const linked = {
    direction: 'action-to-stage',
    actionId: 'a1',
    index: 2,
    stage: {
      name: 'Suite',
      controls: { wheel: false, ok: false, home: false, pause: false, autoplay: false },
    },
    position: { x: 120, y: 80 },
  };
  assert.deepEqual(advancedGestures.createLinkedNode(linked), {
    gesture: 'create-linked-node', linked,
  });
});

test('les décisions d’export citent la cible sans jamais recomposer son chemin', () => {
  const member = { path: '/stageNodes/@uuid=s~11#0', key: 'duration', sourceOccurrence: 0 };
  const built = advancedGestures.setOpaqueExportDisposition(member, 'remove-explicitly');
  // Le chemin est un jeton opaque : il traverse la façade à l'octet, `~1`
  // d'échappement compris.
  assert.equal(built.member.path, member.path);
  assert.deepEqual(built, {
    gesture: 'set-opaque-export-disposition',
    member,
    disposition: 'remove-explicitly',
  });
  assert.deepEqual(
    advancedGestures.setPositionExportDisposition(graphNode.stage('s1'), 'omit-explicitly'),
    {
      gesture: 'set-position-export-disposition',
      node: { kind: 'stage', id: 's1' },
      disposition: 'omit-explicitly',
    },
  );
  assert.deepEqual(advancedGestures.flattenKnownGroup('g-1'), {
    gesture: 'flatten-known-group',
    groupId: 'g-1',
  });
  assert.throws(() => advancedGestures.setPositionExportDisposition(graphNode.stage('s1'), 'round'), TypeError);
  assert.throws(() => advancedGestures.setOpaqueExportDisposition(member, 'keep'), TypeError);
});

test('la création d’une Action autonome ne raccorde rien d’elle-même', () => {
  const created = advancedGestures.createAction({
    name: 'Choix',
    options: [optionTarget.stage('s2'), optionTarget.null()],
  });
  assert.deepEqual(created, {
    gesture: 'create-action',
    action: {
      name: 'Choix',
      options: [{ target: 'stage', uuid: 's2' }, { target: 'null' }],
    },
  });
  // Aucun champ de raccord : la transition est un geste distinct.
  assert.deepEqual(Object.keys(created.action).sort(), ['name', 'options']);
  assert.deepEqual(advancedGestures.createAction(), { gesture: 'create-action', action: {} });
});

test('une création déposée sur le canvas porte son point, les autres n’en portent pas', () => {
  // La position est un champ **frère**, jamais un membre de la requête : la
  // création reste un geste de document, le placement un geste de vue, et les
  // deux partent ensemble pour ne faire qu'un pas d'annulation.
  const controls = { wheel: false, ok: true, home: false, pause: false, autoplay: false };
  const posed = advancedGestures.createStage({ name: null, controls }, { x: -120.5, y: 340 });
  assert.deepEqual(posed, {
    gesture: 'create-stage',
    stage: { name: null, controls },
    position: { x: -120.5, y: 340 },
  });
  assert.deepEqual(
    advancedGestures.createAction({ id: null, name: null, options: [] }, { x: 8, y: 9 }).position,
    { x: 8, y: 9 },
  );

  // Sans point — la barre d'outils — la clé est **absente**, pas nulle : le
  // geste natif la lirait comme une demande de placement à l'origine.
  assert.equal('position' in advancedGestures.createStage({ name: null, controls }), false);
  assert.equal('position' in advancedGestures.createAction(), false);
});

test('un geste construit ici traverse la façade sans être réécrit', async () => {
  const payload = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
    + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';
  const project = {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'renard-avance',
    rootEntries: [],
    authoring: { payload, editorState: { version: 1 }, mediaBindings: [] },
  };
  const gesture = advancedGestures.setSquareOne('s1');
  const calls = [];
  const report = {
    gesture: 'set-square-one',
    created: null,
    anchors: { removed: [], retargeted: [], preexistingOrphans: [] },
    media: { added: [], repointed: [], released: [], unreferenced: [], unbound: [], missing: [], usages: [] },
    references: { selections: [], options: [], squareOne: ['/stageNodes/@uuid=s1#0'] },
    positions: { authored: [], editor: [], scaled: [], omitted: [], staleDecisions: [] },
  };
  const { report: rendered } = await applyAdvancedGesture(project, gesture, {
    invokeCommand: async (command, args) => {
      calls.push({ command, args });
      return { payload, mediaBindings: [], report };
    },
  });

  assert.deepEqual(calls[0].args.gesture, { gesture: 'set-square-one', stageUuid: 's1' });
  // Le rapport ressort tel quel : l'appelant lit les effets sur les références
  // et les positions sans que la façade les recompose.
  assert.deepEqual(rendered.references.squareOne, ['/stageNodes/@uuid=s1#0']);
  assert.deepEqual(rendered.positions.staleDecisions, []);
});
