// Cycle complet d'autosave, d'interruption et de reprise du projet avancé,
// lancé par le test Rust.
//
// Les seuls doubles sont la WebView, les dialogues de fichiers et le transport
// IPC : le snapshot de session, sa relecture et le `.mbah` promu sont de vrais
// fichiers dans un répertoire temporaire, écrits et relus par les fonctions de
// production. Les trois commandes du projet avancé — acquisition, validation
// d'ouverture et readiness — sont acheminées au vrai handler Tauri du processus
// parent, qui compte les invocations : c'est ainsi qu'une reprise prouve
// qu'elle ne réacquiert pas d'identité et qu'une énumération prouve qu'elle
// n'ouvre pas le payload.
//
// L'interruption est simulée en abandonnant tout état mémoire (aucune variable
// du travail précédent n'est réutilisée après la ligne « reprise ») ; le travail
// réel de l'utilisateur n'est jamais touché : tout vit sous `os.tmpdir()`.

import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { workState } from './workStateDriver.mjs';

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
    validate_advanced_payload: forwarded('validate_advanced_payload'),
    create_advanced_document: forwarded('create_advanced_document'),
    assess_advanced_payload_readiness: forwarded('assess_advanced_payload_readiness'),
  },
});

const io = await import('../src/store/projectIO.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { FICHIERS_IMPORTES } = await import('../src/store/workspaceDirs.js');
const {
  acquireCreatedAdvancedProject,
  assessAdvancedProjectReadiness,
  readAuthoringPayload,
  readEditorState,
  readMediaBindings,
  withAuthoringPayload,
  withEditorState,
  withMediaBindings,
} = await import('../src/store/projectModel.js');
const { createWorkSnapshot, shouldAbortEphemeralPromotion } = await import('../src/store/projectHelpers.js');
harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);

const { payloadBlocked } = await receive();
let checks = 0;
const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
};

// Dossier de session éphémère et son snapshot anti-crash, nommés comme
// `useWorkSession` les compose.
const sessionDir = await harness.mkdirp('session');
const snapshotPath = `${sessionDir}/.session-recovery.mbah`;
const audioPath = await harness.writeFile('session/fichiers-importes/a1b2c3.mp3', 'audio de session');

// 1. Acquisition : un document créé, une identité générée, un seul appel pour
// tout le cycle — reprise et promotion comprises. Rust compte les invocations.
const created = await acquireCreatedAdvancedProject({ title: '', projectName: '' });
const work = workState(created);
const createdPayload = readAuthoringPayload(work.project);

// 2. Travail d'auteur sans titre ni média racine : une disposition de vue et une
// liaison média. C'est exactement le projet que l'inventaire Libre jugeait vide.
work.mutate((project) => withEditorState(project, {
  version: 1,
  viewport: { x: -240, y: 118.5, zoom: 0.75 },
  collapsed: ['/stageNodes/@uuid=0f9c2a41#0'],
}));
work.mutate((project) => withMediaBindings(project, [
  { assetRef: 'a1b2c3.mp3', path: audioPath, status: 'resolved' },
]));
check(work.project.projectName, '', 'ni titre, ni nom de projet');
const snapshotBeforeCrash = createWorkSnapshot(work.project, [audioPath], { [audioPath]: ['voix'] });

// 3. Filet anti-crash : le snapshot passe par le même codec que la sauvegarde
// explicite, avec le critère d'autosave des projets avancés.
const written = await io.autoSaveEphemeralProject(work.project, sessionDir, snapshotPath, {
  mediaTags: { [audioPath]: ['voix'] },
  mediaLibraryPaths: [audioPath],
  totalMediaCount: 1,
});
check(written.path, snapshotPath);

// ── Interruption : plus rien de ce qui précède n'est réutilisé ────────────────

// 4. Énumération des reprises : l'aperçu s'arrête à l'enveloppe. Rust vérifie
// qu'aucune validation de payload n'a lieu ici.
const preview = await io.previewProjectFromPath(snapshotPath);
check(preview.authoringMode, 'advanced');
check(preview.projectName, null, 'un projet sans nom n’en invente pas un');
const bytesAfterPreview = await fs.readFile(snapshotPath);

// 5. Reprise réelle : la lecture passe par le codec et le vrai handler.
const recovered = await io.loadProjectFromPath(snapshotPath, { preserveEmptyProjectName: true });
check(await fs.readFile(snapshotPath), bytesAfterPreview, 'la reprise ne réécrit pas le snapshot');
const resumed = workState(recovered.data);
check(readAuthoringPayload(resumed.project), createdPayload, 'la chaîne relue est celle qui a été écrite');
check(readEditorState(resumed.project).viewport, { x: -240, y: 118.5, zoom: 0.75 });
check(readEditorState(resumed.project).collapsed, ['/stageNodes/@uuid=0f9c2a41#0']);
check(readMediaBindings(resumed.project)[0], { assetRef: 'a1b2c3.mp3', path: audioPath, status: 'resolved' });
check(recovered.mediaLibraryPaths, [audioPath], 'le catalogue est résolu depuis le dossier de session');
check(recovered.mediaTags, { [audioPath]: ['voix'] }, 'les tags survivent à la reprise');
check(
  createWorkSnapshot(resumed.project, recovered.mediaLibraryPaths, recovered.mediaTags),
  snapshotBeforeCrash,
  'le travail repris porte exactement la signature interrompue',
);
check(resumed.undo(), false, 'rien d’antérieur au projet repris n’est atteignable');
const recoveredPayload = readAuthoringPayload(resumed.project);

// 6. Un export bloqué reste récupérable : le pack bloqué est installé, snapshoté,
// repris, et sa readiness est **recalculée** — jamais relue d'un cache.
resumed.mutate((project) => withAuthoringPayload(project, payloadBlocked));
const blockedBefore = await assessAdvancedProjectReadiness(resumed.project);
check(blockedBefore.blocked, true, 'l’Action orpheline bloque avant l’interruption');
await io.autoSaveEphemeralProject(resumed.project, sessionDir, snapshotPath, {
  mediaTags: { [audioPath]: ['voix'] },
  mediaLibraryPaths: [audioPath],
  totalMediaCount: 1,
});
const blockedRecovery = await io.loadProjectFromPath(snapshotPath, { preserveEmptyProjectName: true });
const blockedWork = workState(blockedRecovery.data);
const blockedAfter = await assessAdvancedProjectReadiness(blockedWork.project);
check(blockedAfter.blocked, true, 'le blocage d’export survit à la reprise');
check(
  blockedAfter.dimensions.map((dimension) => [dimension.id, dimension.qualification]),
  blockedBefore.dimensions.map((dimension) => [dimension.id, dimension.qualification]),
  'les mêmes qualifications, recalculées',
);

// 7. Promotion, transfert en échec : la session et le travail sont conservés.
const projectDir = await harness.mkdirp('projet');
const savePath = `${projectDir}/promu.mbah`;
const failed = await io.transferProjectFilesToProject(blockedWork.project, savePath, async () => {
  throw new Error('copie refusée');
});
check(failed.errors.length, 1, 'l’échec de copie est remonté');
check(shouldAbortEphemeralPromotion({ isEphemeralSession: true, transferErrors: failed.errors }), true);
check(readMediaBindings(failed.project)[0].path, audioPath, 'la liaison garde son chemin de session');
check(
  (await io.collectLiveSessionDependencies(failed.project, sessionDir)).map((entry) => entry.path),
  [audioPath],
  'la session reste une dépendance : elle ne peut pas être nettoyée',
);

// 8. Réessai réussi : la même identité, la même chaîne, et plus aucune
// dépendance au dossier éphémère.
const transferred = await io.transferProjectFilesToProject(
  blockedWork.project,
  savePath,
  (source) => io.copyMediaToWorkspace(source, harness.workspace, FICHIERS_IMPORTES, 'promu'),
);
check(transferred.errors, []);
check(readMediaBindings(transferred.project)[0].assetRef, 'a1b2c3.mp3', 'la référence du dialecte n’est pas réécrite');
check(readMediaBindings(transferred.project)[0].status, 'resolved');
check(await io.collectLiveSessionDependencies(transferred.project, sessionDir), []);

const promoted = await io.saveProject(transferred.project, savePath, null, {
  mediaTags: {},
  mediaLibraryPaths: [],
  workspaceDir: harness.workspace,
});
check(promoted.path, savePath);

// Le nettoyage de session que la promotion autorise désormais : le projet
// enregistré doit rouvrir sans lui.
await fs.rm(sessionDir, { recursive: true, force: true });
const reopened = await io.loadProjectFromPath(savePath);
check(readAuthoringPayload(reopened.data), payloadBlocked, 'le projet promu porte la chaîne du travail repris');
const promotedBinding = readMediaBindings(reopened.data)[0];
check(promotedBinding.assetRef, 'a1b2c3.mp3');
check(await fs.readFile(promotedBinding.path, 'utf8'), 'audio de session', 'le média vit hors de la session');
check((await assessAdvancedProjectReadiness(reopened.data)).blocked, true);

send({
  kind: 'done',
  createdPayload,
  recoveredPayload,
  promotedPayload: readAuthoringPayload(reopened.data),
  blockedAfterRecovery: blockedAfter.blocked,
  checks,
});
await harness.dispose();
process.stdin.destroy();
