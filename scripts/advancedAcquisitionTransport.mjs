// Acquisition d'un pack avancé et vie complète de ses médias,
// lancée par le test Rust.
//
// Les liaisons médias ne sont **pas fournies par ce script** : elles sont
// produites par l'acquisition de production, acheminée au vrai handler Tauri du
// processus parent. C'est le raccord qui manquait : sans lui, aucun parcours
// média avancé n'était prouvable, puisque le tableau de liaisons était fabriqué
// par le banc lui-même.
//
// Les seuls doubles sont la WebView, les dialogues de fichiers et le transport
// IPC. Les assets extraits, le snapshot de session, le `.mbah` promu, sa copie
// et le dossier consolidé sont de vrais fichiers dans un répertoire temporaire,
// écrits et relus par les fonctions de production. Les octets de chaque média
// sont confrontés à leur source à chaque étape : deux audios distincts, une
// image partagée par deux Stages, un asset référencé qu'aucun fichier ne porte.

import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const forwarded = (cmd) => async (args) => {
  send({ kind: 'invoke', cmd, args });
  const response = await receive();
  if ('error' in response) throw response.error;
  return response.result;
};

const harness = await createDiskHarness({
  commands: {
    acquire_advanced_pack_document: forwarded('acquire_advanced_pack_document'),
    validate_advanced_payload: forwarded('validate_advanced_payload'),
  },
});

const io = await import('../src/store/projectIO.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { FICHIERS_IMPORTES } = await import('../src/store/workspaceDirs.js');
const {
  acquireImportedAdvancedProject,
  readAuthoringPayload,
  readMediaBindings,
} = await import('../src/store/projectModel.js');
harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);

const { packPath } = await receive();
let checks = 0;
const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
};

const bindingOf = (project, assetRef) => readMediaBindings(project)
  .find((binding) => binding.assetRef === assetRef);
const bytesOf = async (project, assetRef) => fs.readFile(bindingOf(project, assetRef).path, 'utf8');

// 1. Acquisition dans la session éphémère : un seul appel, et les liaisons
// arrivent avec le payload. Rien n'est complété ici.
const sessionDir = await harness.mkdirp('session');
const acquired = await acquireImportedAdvancedProject({
  packPath,
  assetsDir: `${io.getExtractedZipsDir(sessionDir)}/pack-medias`,
  workspaceDir: sessionDir,
  projectName: 'Pack médias',
});
const acquiredPayload = readAuthoringPayload(acquired);

check(
  readMediaBindings(acquired).map((binding) => [binding.assetRef, binding.status]),
  [
    ['voix-a.mp3', 'resolved'],
    ['commune.png', 'resolved'],
    ['voix-b.mp3', 'resolved'],
    ['absent.mp3', 'missing'],
  ],
  'toutes les références du document sont liées, dans son ordre, et elles seules',
);
check(await bytesOf(acquired, 'voix-a.mp3'), 'octets de A');
check(await bytesOf(acquired, 'voix-b.mp3'), 'octets de B, differents');
check(await bytesOf(acquired, 'commune.png'), 'image partagee');
check(
  nodePath.basename(bindingOf(acquired, 'voix-a.mp3').path),
  nodePath.basename(bindingOf(acquired, 'voix-b.mp3').path).replace('-b', '-a'),
  'deux fichiers distincts, deux chemins distincts',
);
check(
  typeof bindingOf(acquired, 'absent.mp3').path,
  'string',
  'le média absent garde un chemin : il reste retrouvable',
);
check(await harness.exists(bindingOf(acquired, 'absent.mp3').path), false);

// 2. Filet anti-crash, puis interruption : plus rien de ce qui précède n'est
// réutilisé au-delà de la ligne de reprise.
const snapshotPath = `${sessionDir}/.session-recovery.mbah`;
await io.autoSaveEphemeralProject(acquired, sessionDir, snapshotPath, {
  mediaTags: {},
  mediaLibraryPaths: [],
  totalMediaCount: 0,
});
const preview = await io.previewProjectFromPath(snapshotPath);
check(preview.authoringMode, 'advanced');

// ── Reprise ─────────────────────────────────────────────────────────────────

const recovered = await io.loadProjectFromPath(snapshotPath);
check(readAuthoringPayload(recovered.data), acquiredPayload, 'la chaîne acquise est celle relue');
check(
  readMediaBindings(recovered.data).map((binding) => [binding.assetRef, binding.status]),
  readMediaBindings(acquired).map((binding) => [binding.assetRef, binding.status]),
  'la reprise conserve chaque liaison et son statut',
);
check(await bytesOf(recovered.data, 'commune.png'), 'image partagee');

// 3. Promotion : les médias présents quittent la session, l'absent reste
// déclaré. Sa copie échoue et n'empêche pas les autres.
const projectDir = await harness.mkdirp('projet');
const savePath = `${projectDir}/promu.mbah`;
const transferred = await io.transferProjectFilesToProject(
  recovered.data,
  savePath,
  (source) => io.copyMediaToWorkspace(source, harness.workspace, FICHIERS_IMPORTES, 'promu'),
);
check(transferred.errors.map((error) => nodePath.basename(error.path)), ['absent.mp3'],
  'seul le média jamais présent échoue à la copie');
check(transferred.copiedCount, 3, 'les trois fichiers présents sont copiés une fois chacun');
check(
  readMediaBindings(transferred.project).map((binding) => [binding.assetRef, binding.status]),
  [
    ['voix-a.mp3', 'resolved'],
    ['commune.png', 'resolved'],
    ['voix-b.mp3', 'resolved'],
    ['absent.mp3', 'missing'],
  ],
);
check(await bytesOf(transferred.project, 'voix-a.mp3'), 'octets de A');
check(await bytesOf(transferred.project, 'voix-b.mp3'), 'octets de B, differents');
check(
  await io.collectLiveSessionDependencies(transferred.project, sessionDir),
  [],
  'plus aucun fichier vivant ne dépend de la session : elle peut être nettoyée',
);

const promoted = await io.saveProject(transferred.project, savePath, null, {
  mediaTags: {},
  mediaLibraryPaths: [],
  workspaceDir: harness.workspace,
});
check(promoted.path, savePath);
await fs.rm(sessionDir, { recursive: true, force: true });

const reopened = await io.loadProjectFromPath(savePath);
check(readAuthoringPayload(reopened.data), acquiredPayload, 'le projet promu porte la chaîne acquise');
check(await bytesOf(reopened.data, 'voix-a.mp3'), 'octets de A', 'le média vit hors de la session');
check(await bytesOf(reopened.data, 'voix-b.mp3'), 'octets de B, differents');
check(await bytesOf(reopened.data, 'commune.png'), 'image partagee');
check(bindingOf(reopened.data, 'absent.mp3').status, 'missing');
check(typeof bindingOf(reopened.data, 'absent.mp3').path, 'string',
  'le média manquant garde son chemin après la disparition de la session');

// 4. Copie sous : la copie porte les mêmes médias.
const copyDir = await harness.mkdirp('copie');
harness.answerSave(`${copyDir}/copie.mbah`);
const copied = await io.saveProjectAs(reopened.data, savePath, null, {}, {
  workspaceDir: harness.workspace,
}, []);
const reopenedCopy = await io.loadProjectFromPath(copied.path);
check(readAuthoringPayload(reopenedCopy.data), acquiredPayload);
check(await bytesOf(reopenedCopy.data, 'voix-b.mp3'), 'octets de B, differents');

// 5. Consolidation puis déplacement du dossier : les médias suivent le projet.
const consolidatedDir = harness.dir('consolide');
const consolidated = await io.consolidateProject(reopenedCopy.data, copied.path, consolidatedDir);
check(consolidated.errors.map((error) => nodePath.basename(error.path)), ['absent.mp3']);
check(await bytesOf(consolidated.project, 'commune.png'), 'image partagee');

const movedDir = harness.dir('consolide-deplace');
await fs.rename(consolidatedDir, movedDir);
const movedPath = nodePath.join(movedDir, nodePath.basename(consolidated.path));
const afterMove = await io.loadProjectFromPath(movedPath);
check(readAuthoringPayload(afterMove.data), acquiredPayload, 'le déplacement ne touche pas au payload');
check(await bytesOf(afterMove.data, 'voix-a.mp3'), 'octets de A', 'chaque média suit le dossier déplacé');
check(await bytesOf(afterMove.data, 'voix-b.mp3'), 'octets de B, differents');
check(await bytesOf(afterMove.data, 'commune.png'), 'image partagee');
check(
  readMediaBindings(afterMove.data).map((binding) => binding.assetRef),
  ['voix-a.mp3', 'commune.png', 'voix-b.mp3', 'absent.mp3'],
  'aucune référence du dialecte n’a été réécrite ni retirée',
);

send({ kind: 'done', acquiredPayload, movedPayload: readAuthoringPayload(afterMove.data), checks });
await harness.dispose();
process.stdin.destroy();
