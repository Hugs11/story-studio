import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectFormatError,
  applyAdvancedGesture,
  prepareImportedAdvancedProject,
  readMediaBindings,
  walkProjectMediaReferences,
} from '../src/store/projectModel.js';
import { hierarchicalProjectType } from '../src/store/projectWorkState.js';
import { bumpPackVersion } from '../src/utils/packConvention.js';

// Le payload porte un entier au-delà de 2^53 dans une extension opaque : s'il
// était ouvert par `JSON.parse` puis réémis en JavaScript, sa valeur changerait.
// Aucun test de ce fichier ne le lit ; ils le comparent à l'octet.
const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":['
  + '{"uuid":"stage-1","squareOne":true,"audio":"a1b2c3.mp3","legacy":9007199254740993}'
  + '],"actionNodes":[]},'
  + '"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio"}}';
const MUTATED = PAYLOAD.replace('"squareOne":true', '"squareOne":true,"okTransition":null');

function advancedProject(bindings = defaultBindings()) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'renard-avance',
    packMetadata: { title: 'Le renard', uuid: 'e3b0-inerte', version: 1 },
    rootEntries: [],
    authoring: {
      payload: PAYLOAD,
      editorState: { version: 1, viewport: { x: 120.5, y: -32769, zoom: 0.75 } },
      mediaBindings: bindings,
    },
  };
}

function defaultBindings() {
  return [{ assetRef: 'a1b2c3.mp3', path: '/projets/renard/medias/intro.mp3', status: 'resolved' }];
}

const GESTURE = {
  gesture: 'set-stage-transition',
  stageUuid: 'stage-1',
  slot: 'ok',
  update: { form: 'null' },
};

function invoker(outcome, calls = []) {
  return async (command, args) => {
    calls.push({ command, args });
    return outcome;
  };
}

const REPORT = {
  gesture: 'set-stage-transition',
  created: null,
  anchors: { removed: [], retargeted: [], preexistingOrphans: [] },
  media: { added: [], repointed: [], unreferenced: [], unbound: [], missing: [] },
};

test('le geste part du payload et des liaisons courants, et rend les deux ensemble', async () => {
  const calls = [];
  const project = advancedProject();
  const { project: next, report } = await applyAdvancedGesture(project, GESTURE, {
    invokeCommand: invoker(
      { payload: MUTATED, mediaBindings: defaultBindings(), report: REPORT },
      calls,
    ),
  });

  assert.deepEqual(calls, [{
    command: 'apply_advanced_gesture',
    args: { payload: PAYLOAD, mediaBindings: defaultBindings(), gesture: GESTURE },
  }]);
  // La chaîne est remplacée entière, jamais recomposée en JavaScript.
  assert.equal(next.authoring.payload, MUTATED);
  assert.deepEqual(next.authoring.mediaBindings, defaultBindings());
  assert.equal(report.gesture, 'set-stage-transition');
  // Le projet de départ n'est pas muté sur place.
  assert.equal(project.authoring.payload, PAYLOAD);
});

test('le geste ne touche ni l’état de vue, ni les métadonnées, ni le mode', async () => {
  const project = advancedProject();
  const { project: next } = await applyAdvancedGesture(project, GESTURE, {
    invokeCommand: invoker({ payload: MUTATED, mediaBindings: defaultBindings(), report: REPORT }),
  });

  assert.deepEqual(next.authoring.editorState, project.authoring.editorState);
  assert.deepEqual(next.packMetadata, project.packMetadata);
  assert.equal(next.schemaVersion, 4);
  assert.equal(next.authoringMode, 'advanced');
  assert.equal(next.projectType, 'advanced');
});

test('les liaisons rendues par un geste passent la porte d’enveloppe', async () => {
  const project = advancedProject();
  const added = [
    ...defaultBindings(),
    { assetRef: 'e7f8a9.mp3', path: '/projets/renard/medias/clairiere.mp3', status: 'resolved' },
    { assetRef: 'b0c1d2.png', path: null, status: 'missing' },
  ];
  const { project: next } = await applyAdvancedGesture(project, GESTURE, {
    invokeCommand: invoker({ payload: MUTATED, mediaBindings: added, report: REPORT }),
  });
  assert.equal(readMediaBindings(next).length, 3);

  // `resolved` sans chemin est refusé à la sortie d'un geste comme à l'entrée
  // d'un fichier : le producteur n'est pas dispensé de la forme fermée.
  await assert.rejects(
    () => applyAdvancedGesture(project, GESTURE, {
      invokeCommand: invoker({
        payload: MUTATED,
        mediaBindings: [{ assetRef: 'a1b2c3.mp3', path: null, status: 'resolved' }],
        report: REPORT,
      }),
    }),
    ProjectFormatError,
  );
});

test('un projet Libre n’a pas de geste avancé et le refus est explicite', async () => {
  const free = { schemaVersion: 3, authoringMode: 'free', projectType: 'menu', rootEntries: [] };
  await assert.rejects(
    () => applyAdvancedGesture(free, GESTURE, { invokeCommand: invoker(null) }),
    (error) => error instanceof ProjectFormatError && error.code === 'ADVANCED_CODEC_REQUIRED',
  );
});

test('un geste avancé ne fabrique aucun chemin hiérarchique', async () => {
  const project = advancedProject();
  const { project: next } = await applyAdvancedGesture(project, GESTURE, {
    invokeCommand: invoker({ payload: MUTATED, mediaBindings: defaultBindings(), report: REPORT }),
  });
  // Le montage hiérarchique reste interdit après mutation : `rootEntries` reste
  // vide et le shell ne trouve aucun type d'arbre à monter.
  assert.deepEqual(next.rootEntries, []);
  assert.equal(hierarchicalProjectType(next), null);
  // Le walker ne rend que les liaisons déclarées, jamais une clé du payload.
  assert.deepEqual(
    [...walkProjectMediaReferences(next)].map((reference) => reference.scope),
    ['advanced-asset'],
  );
});

// Un pack repris dans le graphe porte la version d'origine + 1, par la
// règle même de la chaîne Libre. Les deux chaînes proposent donc la même
// version pour le même pack.
function revisionInvoker(version, calls, opaqueMembers = []) {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_advanced_graph_view') return { metadata: { version }, opaqueMembers };
    return { payload: MUTATED, mediaBindings: defaultBindings(), report: REPORT };
  };
}

for (const [label, version, original] of [
  ['version 1', { presence: 'value', value: 1 }, 1],
  ['version 7', { presence: 'value', value: 7 }, 7],
  ['version 0', { presence: 'value', value: 0 }, 0],
  ['sans version', { presence: 'absent' }, undefined],
]) {
  test(`pack repris dans le graphe, ${label} : même version proposée que la chaîne Libre`, async () => {
    const calls = [];
    const project = advancedProject();
    const revised = await prepareImportedAdvancedProject(project, {
      invokeCommand: revisionInvoker(version, calls),
    });

    assert.deepEqual(calls.map((call) => call.command), [
      'read_advanced_graph_view',
      'apply_advanced_gesture',
    ]);
    assert.deepEqual(calls[1].args.gesture, {
      gesture: 'set-document-metadata',
      update: { version: { form: 'set', value: bumpPackVersion(original) } },
    });
    assert.ok(calls[1].args.gesture.update.version.value >= 2);
    assert.equal(revised.authoring.payload, MUTATED);
    assert.equal(project.authoring.payload, PAYLOAD);
  });
}

// Le bloc que « Vérifier un pack » écrivait dans les packs corrigés est
// préservé dès l'atterrissage : l'auteur n'a pas à trancher une donnée que
// Story Studio a lui-même écrite. Une extension d'un tiers reste à trancher.
test('pack repris dans le graphe : le bloc Story Studio est préservé, pas celui d’un tiers', async () => {
  const calls = [];
  // Forme réelle du DTO : `path` désigne le porteur (la racine), la clé est à part.
  const own = { scope: 'root', path: '/', key: 'storyStudioMetadata', sourceOccurrence: 0 };
  const foreign = { scope: 'root', path: '/', key: 'autreOutil', sourceOccurrence: 0 };
  await prepareImportedAdvancedProject(advancedProject(), {
    invokeCommand: revisionInvoker({ presence: 'value', value: 1 }, calls, [own, foreign]),
  });

  const gestures = calls.filter((call) => call.command === 'apply_advanced_gesture')
    .map((call) => call.args.gesture);
  assert.deepEqual(gestures.map((gesture) => gesture.gesture), [
    'set-document-metadata',
    'set-opaque-export-disposition',
  ]);
  assert.deepEqual(gestures[1], {
    gesture: 'set-opaque-export-disposition',
    member: { path: own.path, key: own.key, sourceOccurrence: 0 },
    disposition: 'preserve-untested',
  });
});
