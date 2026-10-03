// Cycle disque complet d'un projet avancé, lancé par le test Rust.
//
// Les seuls doubles sont la WebView, les dialogues de fichiers et le transport
// IPC : les `.mbah` sont écrits dans un répertoire temporaire réel, relus par
// les fonctions de production, et `validate_advanced_payload` est acheminée au
// vrai handler Tauri du processus parent. Le payload final lui est rendu pour
// qu'il compare document, contexte et identité avec son propre codec.

import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const harness = await createDiskHarness({
  commands: {
    'validate_advanced_payload': async (args) => {
      send({ kind: 'invoke', cmd: 'validate_advanced_payload', args });
      const response = await receive();
      if ('error' in response) throw response.error;
      return response.result;
    },
  },
});

const io = await import('../src/store/projectIO.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);

const { payload } = await receive();
let checks = 0;
const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
};

const projectDir = await harness.mkdirp('projet');
await harness.writeFile('projet/medias/a1b2c3.mp3', 'audio du renard');
const savePath = `${projectDir}/renard.mbah`;
const project = {
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'renard-avance',
  rootEntries: [],
  authoring: {
    payload,
    editorState: { version: 1, viewport: { x: 12.5, y: -3.25, zoom: 0.75 } },
    mediaBindings: [
      { assetRef: 'a1b2c3.mp3', path: `${projectDir}/medias/a1b2c3.mp3`, status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: `${projectDir}/medias/disparu.png`, status: 'missing' },
    ],
  },
};

// 1. Deux cycles complets : chaque relecture repart d'un état mémoire neuf, et
// la validation d'ouverture est celle du vrai handler Rust.
let current = project;
let summary = null;
for (let cycle = 0; cycle < 2; cycle += 1) {
  await io.saveProject(current, savePath);
  const reopened = await io.loadProjectFromPath(savePath);
  check(reopened.data.authoring.payload, payload, `cycle ${cycle} : payload identique à l'octet`);
  check(reopened.data.authoring.editorState, project.authoring.editorState, `cycle ${cycle} : vue conservée`);
  check(reopened.data.authoringMode, 'advanced', `cycle ${cycle} : mode explicite relu`);
  check(reopened.data.schemaVersion, 4, `cycle ${cycle} : schéma 4 conservé`);
  check(reopened.data.rootEntries, [], `cycle ${cycle} : aucune projection hiérarchique`);
  check(reopened.summary.identityStatus, 'resolved', `cycle ${cycle} : identité résolue`);
  check(reopened.data.authoring.mediaBindings.map((b) => [b.assetRef, b.path, b.status]), [
    ['a1b2c3.mp3', `${projectDir}/medias/a1b2c3.mp3`, 'resolved'],
    ['d4e5f6.png', `${projectDir}/medias/disparu.png`, 'missing'],
  ], `cycle ${cycle} : liaisons résolues, référence manquante conservée`);
  summary = reopened.summary;
  current = reopened.data;
}
check(harness.countCalls('validate_advanced_payload'), 2, 'un seul appel Rust par ouverture');

// 2. Save As : nouveau chemin, métadonnées locales adaptées, identité intacte.
const previousBytes = await harness.readFile(savePath);
const copyDir = await harness.mkdirp('copie');
harness.answerSave(`${copyDir}/renard-copie.mbah`);
const copied = await io.saveProjectAs(current, savePath);
check(copied.path, `${copyDir}/renard-copie.mbah`, 'Save As écrit le chemin choisi');
check(await harness.readFile(savePath), previousBytes, 'Save As laisse la source intacte');
const reopenedCopy = await io.loadProjectFromPath(copied.path);
check(reopenedCopy.data.authoring.payload, payload, 'Save As conserve le payload et son packIdentity');
check(reopenedCopy.data.projectName, 'renard-copie', 'le nom local suit le fichier');
check(reopenedCopy.data.authoring.mediaBindings[0].path, `${projectDir}/medias/a1b2c3.mp3`,
  'un média hors du nouveau dossier reste résoluble');
check(await harness.exists(reopenedCopy.data.authoring.mediaBindings[0].path), true,
  'la liaison de la copie désigne un fichier réellement présent');

// 3. Déplacement du dossier complet : les cibles relatives suivent le dossier.
await fs.rename(projectDir, harness.dir('deplace'));
const movedPath = harness.dir('deplace/renard.mbah');
const moved = await io.loadProjectFromPath(movedPath);
check(moved.data.authoring.mediaBindings.map((b) => b.path), [
  harness.dir('deplace/medias/a1b2c3.mp3'),
  harness.dir('deplace/medias/disparu.png'),
], 'les liaisons visent le nouveau dossier');
check(await harness.exists(projectDir), false, 'le dossier d’origine n’existe plus');
check(moved.data.authoring.payload, payload, 'le déplacement ne réécrit pas le payload');

// 4. Backup : relu par le même codec, il porte l'état précédent.
const backupProject = structuredClone(moved.data);
backupProject.authoring.editorState = { version: 1, viewport: { x: 999, y: 999, zoom: 2 } };
await io.saveProject(backupProject, movedPath, null, { backupLimit: 2 });
const backupDir = `${harness.workspace}/sauvegardes/versions-securite`;
const [backupName] = await fs.readdir(backupDir);
const backup = await io.loadProjectFromPath(`${backupDir}/${backupName}`);
check(backup.data.authoring.editorState, project.authoring.editorState, 'le backup porte l’état précédent');
check(backup.data.authoring.payload, payload, 'le backup traverse le même codec');

// 5. Panne d'écriture : l'ancien fichier reste lisible par le codec réel.
const beforeFailure = await harness.readFile(movedPath);
harness.injectFailure({ cmd: 'plugin:fs|rename', match: 'renard.mbah', message: 'remplacement impossible' });
const doomed = structuredClone(moved.data);
doomed.projectName = 'jamais-ecrit';
await assert.rejects(io.saveProject(doomed, movedPath));
checks += 1;
check(await harness.readFile(movedPath), beforeFailure, 'octets du .mbah inchangés après la panne');
check((await io.loadProjectFromPath(movedPath)).data.authoring.payload, payload,
  'le fichier précédent reste relisible par le codec');

// 6. Refus au niveau du payload : invisibles depuis l'enveloppe, ils viennent de Rust.
for (const [name, brokenPayload, code] of [
  ['tronque.mbah', '{"payloadVersion":1,"document"', 'INVALID_PAYLOAD_JSON'],
  ['futur.mbah', '{"payloadVersion":2,"document":{"stageNodes":[],"actionNodes":[]},"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}', 'UNSUPPORTED_PAYLOAD_VERSION'],
  ['sans-origine.mbah', '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},"context":{}}', 'INVALID_AUTHORING_PAYLOAD'],
]) {
  const broken = structuredClone(project);
  broken.authoring.payload = brokenPayload;
  broken.authoring.mediaBindings = [];
  const contents = JSON.stringify(broken, null, 2);
  const path = await harness.writeFile(`refus/${name}`, contents);
  await assert.rejects(io.loadProjectFromPath(path), (error) => {
    assert.equal(error.code, code, name);
    assert.equal(error.fileName, name);
    return true;
  });
  checks += 1;
  check(await harness.readFile(path), contents, `${name} : octets source intacts`);
}

check(summary.documentOrigin, 'imported-studio', 'le résumé vient du payload, pas de l’enveloppe');
send({ kind: 'done', payload: backup.data.authoring.payload, checks });
await harness.dispose();
process.stdin.destroy();
