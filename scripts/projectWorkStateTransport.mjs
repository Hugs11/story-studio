// Cycle d'état de travail d'un projet avancé, lancé par le test Rust.
//
// Les seuls doubles sont la WebView, les dialogues de fichiers et le transport
// IPC : les `.mbah` sont écrits dans un répertoire temporaire réel, relus par
// les fonctions de production, et les trois commandes du projet avancé —
// acquisition, validation d'ouverture et readiness — sont acheminées au vrai
// handler Tauri du processus parent. Le payload final lui est rendu pour qu'il
// compare document, contexte, identité et quadrillage avec son propre codec.

import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
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
const {
  acquireCreatedAdvancedProject,
  assessAdvancedProjectReadiness,
  createAdvancedProject,
  readAuthoringPayload,
  withAuthoringPayload,
  withEditorState,
} = await import('../src/store/projectModel.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);

const { payloadBlocked, payloadFixed } = await receive();
let checks = 0;
const check = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
};
const qualification = (readiness, id) => readiness.dimensions
  .find((dimension) => dimension.id === id)?.qualification;

// 1. Acquisition : un document créé, une identité, un seul appel pour toute la
// suite du cycle. Le test Rust compte les invocations pour le vérifier.
const created = await acquireCreatedAdvancedProject({
  title: 'Document créé',
  projectName: 'document-cree',
});
const work = workState(created);
check(work.project.authoringMode, 'advanced');
check(work.project.rootEntries, []);
check(work.history, []);
const createdPayload = readAuthoringPayload(work.project);
const createdReadiness = await assessAdvancedProjectReadiness(work.project);

// 2. Installation d'un pack bloqué : le projet remplace le précédent, historique vidé.
const projectDir = await harness.mkdirp('projet');
work.install(createAdvancedProject({ payload: payloadBlocked, projectName: 'temoin-b42' }));
check(work.undo(), false, 'rien d’antérieur au projet installé n’est atteignable');

const blocked = await assessAdvancedProjectReadiness(work.project);
check(blocked.blocked, true, 'l’Action orpheline bloque');
check(
  blocked.diagnostics.some((diagnostic) => diagnostic.code === 'ORPHAN_ACTION_AUTHORED_CONTENT'),
  true,
);
check(qualification(blocked, 'graph-topology'), 'SUPPORTED');
check(qualification(blocked, 'reachability-and-control-profiles'), 'SUPPORTED');

// 3. Mutation d'auteur : la readiness est redemandée et change.
work.mutate((project) => withAuthoringPayload(project, payloadFixed));
const fixed = await assessAdvancedProjectReadiness(work.project);
check(fixed.blocked, false, 'la readiness est recalculée sur le payload courant');

// 4. Annulation : la readiness du payload restauré redevient bloquante, sans
// qu'aucune qualification précédente ne soit réutilisée.
check(work.undo(), true);
check(readAuthoringPayload(work.project), payloadBlocked);
check((await assessAdvancedProjectReadiness(work.project)).blocked, true);
check(work.redo(), true);
check(readAuthoringPayload(work.project), payloadFixed);

// 5. Écriture d'auto-layout : elle reste dans l'état d'éditeur, et ne change ni
// le payload ni, par construction, une position d'auteur.
const payloadBeforeLayout = readAuthoringPayload(work.project);
work.mutate((project) => withEditorState(project, {
  version: 1,
  viewport: { x: -240, y: 118.5, zoom: 0.75 },
  collapsed: ['/stageNodes/@uuid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#0'],
}));
check(readAuthoringPayload(work.project), payloadBeforeLayout);

// 6. Enregistrement puis réouverture réelle : la validation d'ouverture passe
// par le vrai handler, et la chaîne relue est celle qui a été écrite.
const savePath = `${projectDir}/temoin.mbah`;
const savedSnapshot = createWorkSnapshot(work.project, [], {});
const saved = await io.saveProject(work.project, savePath);
check(saved.path, savePath);
const reopened = await io.loadProjectFromPath(savePath);
check(reopened.data.authoring.payload, payloadFixed);
check(reopened.data.rootEntries, []);
check(reopened.summary.payloadVersion, 1);
check(reopened.data.authoring.editorState.viewport.x, -240);
work.install(reopened.data);
check(createWorkSnapshot(work.project, [], {}), savedSnapshot,
  'le projet relu porte exactement la signature enregistrée');
check((await assessAdvancedProjectReadiness(work.project)).blocked, false);

send({
  kind: 'done',
  createdPayload,
  createdBlocked: createdReadiness.blocked,
  payload: readAuthoringPayload(work.project),
  checks,
});
await harness.dispose();
process.stdin.destroy();
