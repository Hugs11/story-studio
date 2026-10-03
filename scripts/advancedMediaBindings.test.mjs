import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectFormatError,
  assertFreeProjectEnvelope,
  decodeProjectFile,
  encodeProjectFile,
  mediaBindingsByAssetRef,
  readProjectEnvelope,
  readMediaBindings,
  resolveMediaBindingStatuses,
  walkProjectMediaReferences,
} from '../src/store/projectModel.js';
import {
  mapProjectMediaPaths,
  relativizeProjectMediaPaths,
  resolveProjectMediaPaths,
} from '../src/store/projectMediaPaths.js';
import { collectMediaLibrary, executeMediaDeletion, reconcileMediaLibraryPaths } from '../src/store/mediaLibrary.js';
import { collectMissingMedia, relinkProjectMedia } from '../src/store/missingMediaRelink.js';
import { collectSessionOnlyMedia } from '../src/store/sessionMediaTriage.js';

const OLD_DIR = '/projets/renard';
const NEW_DIR = '/media/disque-externe/Projets sauvegardés/renard';

// Deux Stages partagent `a1b2c3.mp3`, un troisième porte `z9y8x7.mp3`. L'extension
// inconnue `legacyAsset` contient une clé `audio`, une clé `path` et un entier
// au-delà de 2^53 : rien de tout cela n'est une référence média.
const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":['
  + '{"uuid":"stage-1","squareOne":true,"audio":"a1b2c3.mp3","image":"d4e5f6.png"},'
  + '{"uuid":"stage-2","audio":"a1b2c3.mp3"},'
  + '{"uuid":"stage-3","audio":"z9y8x7.mp3"}'
  + '],"actionNodes":[],"extensions":{"legacyAsset":{"audio":"ne-pas-toucher.mp3",'
  + '"path":"/ancien/dossier/piste.wav","duration":9007199254740993}}},'
  + '"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"authored"}}';

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

// `medias/intro.mp3` et `voix/intro.mp3` portent le même nom de fichier pour
// deux références distinctes : elles ne doivent jamais fusionner.
function defaultBindings() {
  return [
    { assetRef: 'a1b2c3.mp3', path: `${OLD_DIR}/medias/intro.mp3`, status: 'resolved' },
    { assetRef: 'z9y8x7.mp3', path: `${OLD_DIR}/voix/intro.mp3`, status: 'resolved' },
    { assetRef: 'd4e5f6.png', path: null, status: 'missing' },
  ];
}

function freeProject() {
  return {
    schemaVersion: 3,
    authoringMode: 'free',
    projectType: 'pack',
    projectName: 'contes',
    rootAudio: `${OLD_DIR}/medias/intro.mp3`,
    rootEntries: [
      { id: 'story-1', type: 'story', name: 'Le renard', audio: `${OLD_DIR}/voix/intro.mp3` },
    ],
  };
}

function withoutBindingPaths(project) {
  const copy = structuredClone(project);
  for (const binding of readMediaBindings(copy)) binding.path = '<chemin>';
  return copy;
}

test('la porte d’enveloppe fixe la forme d’une liaison et refuse les références indécidables', () => {
  assert.equal(readProjectEnvelope(advancedProject()).authoringMode, 'advanced');

  const cases = [
    [[null], 'INVALID_MEDIA_BINDING'],
    [[['a1b2c3.mp3', './a.mp3']], 'INVALID_MEDIA_BINDING'],
    [[{ path: './a.mp3', status: 'resolved' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: '  ', path: './a.mp3', status: 'resolved' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: 'a.mp3', status: 'resolved' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: 'a.mp3', path: 42, status: 'resolved' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: 'a.mp3', path: './a.mp3', status: 'inconnu' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: 'a.mp3', path: null, status: 'resolved' }], 'INVALID_MEDIA_BINDING'],
    [[{ assetRef: 'a.mp3', path: './a.mp3', status: 'resolved', sourceStage: 'stage-1' }], 'INVALID_MEDIA_BINDING'],
    [[
      { assetRef: 'a.mp3', path: './a.mp3', status: 'resolved' },
      { assetRef: 'a.mp3', path: './b.mp3', status: 'resolved' },
    ], 'DUPLICATE_MEDIA_BINDING'],
  ];
  for (const [bindings, code] of cases) {
    assert.throws(
      () => readProjectEnvelope(advancedProject(bindings)),
      (error) => error instanceof ProjectFormatError && error.code === code,
      `liaisons acceptées à tort : ${JSON.stringify(bindings)}`,
    );
  }
  // Une liaison manquante mais sans chemin connu reste une forme valide.
  assert.equal(
    readProjectEnvelope(advancedProject([{ assetRef: 'a.mp3', path: null, status: 'missing' }])).authoringMode,
    'advanced',
  );
});

test('le walker ne rend que les liaisons déclarées, jamais une clé du payload d’auteur', () => {
  const refs = [...walkProjectMediaReferences(advancedProject())];
  assert.deepEqual(refs.map((ref) => ref.scope), ['advanced-asset', 'advanced-asset']);
  assert.deepEqual(refs.map((ref) => ref.key), ['path', 'path']);
  assert.deepEqual(refs.map((ref) => ref.path), [`${OLD_DIR}/medias/intro.mp3`, `${OLD_DIR}/voix/intro.mp3`]);
  assert.deepEqual(refs.map((ref) => ref.label), ['Média avancé: a1b2c3.mp3', 'Média avancé: z9y8x7.mp3']);

  // Les valeurs de l'extension opaque sont dans le payload, jamais dans le walker.
  const walked = refs.map((ref) => ref.path).join('|');
  for (const opaque of ['ne-pas-toucher.mp3', '/ancien/dossier/piste.wav', 'a1b2c3.mp3', 'd4e5f6.png']) {
    assert.equal(walked.includes(opaque), false, `${opaque} ne doit pas être une référence disque`);
  }
  // Un projet Libre ne produit aucune branche avancée.
  assert.equal([...walkProjectMediaReferences(freeProject())].some((ref) => ref.scope === 'advanced-asset'), false);
});

test('déplacer le dossier projet change la résolution disque et rien d’autre', () => {
  const project = advancedProject();
  const relative = relativizeProjectMediaPaths(project, OLD_DIR);
  assert.deepEqual(
    relative.authoring.mediaBindings.map((binding) => binding.path),
    ['./medias/intro.mp3', './voix/intro.mp3', null],
  );

  const moved = resolveProjectMediaPaths(relative, NEW_DIR);
  assert.deepEqual(
    moved.authoring.mediaBindings.map((binding) => binding.path),
    [`${NEW_DIR}/medias/intro.mp3`, `${NEW_DIR}/voix/intro.mp3`, null],
  );
  // Payload, identité, état de vue, nom et métadonnées : octet pour octet.
  assert.equal(moved.authoring.payload, PAYLOAD);
  assert.deepEqual(withoutBindingPaths(moved), withoutBindingPaths(project));
  // Les `assetRef` traversent les deux transformations sans être réécrites.
  assert.deepEqual([...mediaBindingsByAssetRef(moved).keys()], ['a1b2c3.mp3', 'z9y8x7.mp3', 'd4e5f6.png']);
});

test('deux Stages partageant un audio gardent leur association après relocalisation et relecture', async () => {
  const validateAdvancedPayload = async () => ({ payloadVersion: 1, stageCount: 3 });
  const relocated = resolveProjectMediaPaths(relativizeProjectMediaPaths(advancedProject(), OLD_DIR), NEW_DIR);
  const { project: reread } = await decodeProjectFile(encodeProjectFile(relocated), { validateAdvancedPayload });

  const stages = JSON.parse(reread.authoring.payload).document.stageNodes;
  const byAssetRef = mediaBindingsByAssetRef(reread);
  const diskPathForStage = (stage) => byAssetRef.get(stage.audio)?.path ?? null;

  assert.equal(stages[0].audio, stages[1].audio);
  assert.equal(diskPathForStage(stages[0]), `${NEW_DIR}/medias/intro.mp3`);
  assert.equal(diskPathForStage(stages[1]), `${NEW_DIR}/medias/intro.mp3`);
  assert.equal(diskPathForStage(stages[2]), `${NEW_DIR}/voix/intro.mp3`);
  // Un `assetRef` partagé reste une liaison unique ; deux `intro.mp3` restent deux.
  assert.equal(reread.authoring.mediaBindings.length, 3);
  assert.equal(reread.authoring.payload, PAYLOAD);
});

test('un média manquant reste lié et le projet reste encodable', async () => {
  const project = advancedProject([
    { assetRef: 'a1b2c3.mp3', path: `${OLD_DIR}/medias/disparu.mp3`, status: 'resolved' },
    { assetRef: 'd4e5f6.png', path: null, status: 'missing' },
  ]);
  const audited = resolveMediaBindingStatuses(project, { [`${OLD_DIR}/medias/disparu.mp3`]: false });
  assert.deepEqual(audited.authoring.mediaBindings, [
    { assetRef: 'a1b2c3.mp3', path: `${OLD_DIR}/medias/disparu.mp3`, status: 'missing' },
    { assetRef: 'd4e5f6.png', path: null, status: 'missing' },
  ]);

  const validateAdvancedPayload = async () => ({ payloadVersion: 1 });
  const { project: reread } = await decodeProjectFile(encodeProjectFile(audited), { validateAdvancedPayload });
  assert.deepEqual(reread.authoring.mediaBindings, audited.authoring.mediaBindings);

  const missing = collectMissingMedia(audited, { [`${OLD_DIR}/medias/disparu.mp3`]: false });
  assert.deepEqual(missing.map((item) => [item.fileName, item.labels]), [['disparu.mp3', ['Média avancé: a1b2c3.mp3']]]);
});

test('le statut est redérivé du disque et « non audité » n’est pas « manquant »', () => {
  const project = advancedProject([
    { assetRef: 'a.mp3', path: '/projets/a.mp3', status: 'missing' },
    { assetRef: 'b.mp3', path: '/projets/b.mp3', status: 'resolved' },
    { assetRef: 'c.mp3', path: '/projets/c.mp3', status: 'resolved' },
    { assetRef: 'd.png', path: null, status: 'resolved' },
  ]);
  const audited = resolveMediaBindingStatuses(project, { '/projets/a.mp3': true, '/projets/b.mp3': false });
  assert.deepEqual(audited.authoring.mediaBindings.map((binding) => binding.status), [
    'resolved', 'missing', 'resolved', 'missing',
  ]);
  // Aucune liaison n'est retirée ni réordonnée, et le projet source est intact.
  assert.deepEqual(audited.authoring.mediaBindings.map((binding) => binding.assetRef), ['a.mp3', 'b.mp3', 'c.mp3', 'd.png']);
  assert.equal(project.authoring.mediaBindings[0].status, 'missing');
  // Un projet Libre n'a aucune liaison : il ressort tel quel, sans clone.
  const free = freeProject();
  assert.equal(resolveMediaBindingStatuses(free, { '/projets/renard/medias/intro.mp3': false }), free);
});

test('les chemins POSIX différant par la casse restent deux liaisons distinctes', () => {
  const upper = '/tmp/Médias de test/A propos.wav';
  const lower = '/tmp/Médias de test/a propos.wav';
  const project = advancedProject([
    { assetRef: 'majuscule.mp3', path: upper, status: 'resolved' },
    { assetRef: 'minuscule.mp3', path: lower, status: 'resolved' },
  ]);
  const relative = relativizeProjectMediaPaths(project, '/tmp/Médias de test');
  assert.deepEqual(relative.authoring.mediaBindings.map((binding) => binding.path), ['./A propos.wav', './a propos.wav']);

  const catalog = collectMediaLibrary({ project, statusByPath: { [upper]: true, [lower]: true } });
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map((item) => item.path).sort(), [upper, lower].sort());
});

// Tests purs de graphies Windows et macOS : ils n'ont pas été exécutés sur ces
// systèmes de fichiers et ne valent pas validation manuelle Windows/macOS.
test('lecteurs Windows, UNC et volumes macOS suivent les mêmes deux transformations', () => {
  const cases = [
    ['C:\\Projets\\Renard', 'C:\\Projets\\Renard\\medias\\intro.mp3', './medias/intro.mp3', 'D:/Sauvegardes/Renard'],
    ['\\\\serveur\\partage\\renard', '\\\\serveur\\partage\\renard\\voix\\récit.mp3', './voix/récit.mp3', '\\\\autre\\partage\\renard'],
    ['/Volumes/Disque externe/Renard', '/Volumes/Disque externe/Renard/medias/intro.mp3', './medias/intro.mp3', '/Volumes/Autre disque/Renard'],
  ];
  for (const [projectDir, absolute, expectedRelative, newDir] of cases) {
    const project = advancedProject([{ assetRef: 'a1b2c3.mp3', path: absolute, status: 'resolved' }]);
    const relative = relativizeProjectMediaPaths(project, projectDir);
    assert.equal(relative.authoring.mediaBindings[0].path, expectedRelative);
    const moved = resolveProjectMediaPaths(relative, newDir);
    assert.equal(
      moved.authoring.mediaBindings[0].path,
      `${newDir.replace(/\\/g, '/').replace(/\/$/, '')}${expectedRelative.slice(1)}`,
    );
  }
  // Un média hors du dossier projet reste absolu et intact.
  const external = advancedProject([{ assetRef: 'a1b2c3.mp3', path: '/Volumes/Disque externe/Médias/à écouter.mp3', status: 'resolved' }]);
  const untouched = relativizeProjectMediaPaths(external, '/Volumes/Disque externe/Renard');
  assert.equal(untouched.authoring.mediaBindings[0].path, '/Volumes/Disque externe/Médias/à écouter.mp3');
  assert.deepEqual(resolveProjectMediaPaths(untouched, NEW_DIR), untouched);
});

test('le relink re-pointe une liaison sans toucher sa référence de dialecte', () => {
  const project = advancedProject([
    { assetRef: 'a1b2c3.mp3', path: `${OLD_DIR}/medias/intro.mp3`, status: 'missing' },
    { assetRef: 'z9y8x7.mp3', path: `${OLD_DIR}/voix/intro.mp3`, status: 'resolved' },
  ]);
  const relinked = relinkProjectMedia(project, { [`${OLD_DIR}/medias/intro.mp3`]: '/retrouve/intro.mp3' });
  assert.deepEqual(relinked.authoring.mediaBindings, [
    { assetRef: 'a1b2c3.mp3', path: '/retrouve/intro.mp3', status: 'missing' },
    { assetRef: 'z9y8x7.mp3', path: `${OLD_DIR}/voix/intro.mp3`, status: 'resolved' },
  ]);
  assert.equal(relinked.authoring.payload, PAYLOAD);
  const audited = resolveMediaBindingStatuses(relinked, { '/retrouve/intro.mp3': true });
  assert.equal(audited.authoring.mediaBindings[0].status, 'resolved');
});

// Ce catalogue n'affirme d'un média avancé que « lié, usages non calculés »
// tant que la vue du graphe n'a pas été lue : un « utilisé ×1 » par liaison
// compterait les liaisons, pas les écrans, et serait un nombre fabriqué. La
// protection contre la suppression tient à `inProject`, que la liaison suffit
// à poser.
test('le catalogue voit les liaisons avancées et la suppression disque reste bloquée', async () => {
  const project = advancedProject();
  const catalog = collectMediaLibrary({ project, statusByPath: { [`${OLD_DIR}/medias/intro.mp3`]: true, [`${OLD_DIR}/voix/intro.mp3`]: false } });
  assert.equal(catalog.length, 2);
  for (const item of catalog) {
    assert.equal(item.inProject, true);
    assert.equal(item.usageKnown, false);
    assert.deepEqual(item.usages, []);
    assert.equal(item.projectUsedCount, 0);
  }
  assert.equal(catalog.find((item) => item.path === `${OLD_DIR}/voix/intro.mp3`).exists, false);
  // Le catalogue durable garde les deux fichiers, sans les fusionner par nom.
  assert.deepEqual(reconcileMediaLibraryPaths(project, []), [`${OLD_DIR}/medias/intro.mp3`, `${OLD_DIR}/voix/intro.mp3`]);

  let deleted = false;
  const result = await executeMediaDeletion({
    item: catalog[0],
    deleteFromDisk: true,
    deleteDisk: async () => { deleted = true; },
  });
  assert.deepEqual([result.removed, result.blocked, deleted], [false, true, false]);
});

test('le tri des médias de session considère une liaison avancée comme référencée', () => {
  const sessionDir = '/sessions/en-cours';
  const project = advancedProject([{ assetRef: 'a1b2c3.mp3', path: `${sessionDir}/medias/intro.mp3`, status: 'resolved' }]);
  const orphans = collectSessionOnlyMedia({
    project,
    mediaLibraryPaths: [`${sessionDir}/medias/intro.mp3`, `${sessionDir}/medias/variante.png`],
    sessionDir,
  });
  assert.deepEqual(orphans.map((item) => item.filename), ['variante.png']);
});

test('les consommateurs d’édition destructrice restent fermés au mode Avancé', () => {
  assert.throws(
    () => assertFreeProjectEnvelope(advancedProject()),
    (error) => error instanceof ProjectFormatError && error.code === 'ADVANCED_CODEC_REQUIRED',
  );
  assert.equal(assertFreeProjectEnvelope(freeProject()), undefined);
});

test('les témoins Libre du walker, du catalogue et du mapping restent inchangés', () => {
  const project = freeProject();
  assert.deepEqual(
    [...walkProjectMediaReferences(project)].map((ref) => [ref.scope, ref.key, ref.path]),
    [
      ['root', 'rootAudio', `${OLD_DIR}/medias/intro.mp3`],
      ['story', 'audio', `${OLD_DIR}/voix/intro.mp3`],
    ],
  );
  const relative = relativizeProjectMediaPaths(project, OLD_DIR);
  assert.equal(relative.rootAudio, './medias/intro.mp3');
  assert.equal(relative.rootEntries[0].audio, './voix/intro.mp3');
  assert.deepEqual(resolveProjectMediaPaths(relative, OLD_DIR), project);
  assert.equal(readMediaBindings(project).length, 0);
  assert.equal(mapProjectMediaPaths(project, (path) => path).rootAudio, project.rootAudio);
  assert.equal(collectMediaLibrary({ project, statusByPath: {} }).length, 2);
});
