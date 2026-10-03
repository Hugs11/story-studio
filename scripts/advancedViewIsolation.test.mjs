// Les six preuves d'isolation de la vue.
//
// La question « la vue rend-elle le projet modifié ? » n'a plus d'objet. Ce qui
// reste à démontrer est son inverse : **aucun chemin de l'éditeur avancé
// n'écrit dans `editorState` ni ne le fait entrer dans l'historique**. Ce
// fichier le démontre, et rien d'autre.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDiskHarness } from './tauriDiskHarness.mjs';
import {
  createAdvancedProject,
  readAuthoringPayload,
} from '../src/store/projectModel.js';
import { createWorkSnapshot, hasUnsavedWork } from '../src/store/projectHelpers.js';
import { pushWorkHistory } from '../src/store/projectWorkState.js';
import {
  createAdvancedViewSession,
  DOCUMENT_EVENTS,
  VIEW_EVENTS,
} from '../src/store/advancedGraphView/advancedViewSession.js';

const SOURCE_ROOT = nodePath.resolve(fileURLToPath(new URL('../src', import.meta.url)));

// Un chemin relatif au dépôt s'écrit avec `/` dans les listes de reference de
// ces tests. `nodePath.relative` rend le séparateur du systeme : sans cette
// normalisation, les memes fichiers ne se reconnaissent pas sous Windows.
const repoPath = (from, to) => nodePath.relative(from, to).split(nodePath.sep).join('/');

const PAYLOAD = '{"payloadVersion":1,"document":{"format":"v1",'
  + '"stageNodes":[{"uuid":"s1","squareOne":true,"name":"Entree"}],'
  + '"actionNodes":[{"id":"a1","options":["s1"]}]},'
  + '"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio"}}';

function graphView({ stages = ['s1'], fingerprint = 'sha256:essai' } = {}) {
  return {
    viewVersion: 1,
    documentFingerprint: fingerprint,
    documentOrigin: 'imported-studio',
    defaultValueOrigin: 'source-studio',
    packIdentity: { origin: 'square-one-stage', value: 'pack-1' },
    entry: { status: 'unique', stagePath: `/stageNodes/@uuid=${stages[0]}#0`, candidates: [] },
    counts: { stages: stages.length, actions: 0, options: 0, edges: 0 },
    stages: stages.map((uuid) => ({
      path: `/stageNodes/@uuid=${uuid}#0`,
      uuid,
      occurrence: 0,
      uniqueId: true,
      name: { presence: 'value', value: uuid },
      fallbackLabel: '',
      stageType: { presence: 'absent', value: null },
      squareOne: { presence: 'absent', value: null },
      groupId: { presence: 'absent', value: null },
      controls: { presence: 'absent', wheel: {}, ok: {}, home: {}, pause: {}, autoplay: {}, complete: false },
      audio: { presence: 'absent', assetRef: null },
      image: { presence: 'absent', assetRef: null },
      okTransition: { presence: 'absent' },
      homeTransition: { presence: 'absent' },
      sourcePosition: null,
      layout: { x: 0, y: 0, source: 'fallback', origin: null },
      provenance: { uuid: 'source-studio', name: 'source-studio', position: 'source-studio' },
    })),
    actions: [],
    edges: [],
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  };
}

// Le double de la clé Rust : identité **et** ancrage, jamais l'identité seule.
function cacheKeyDouble(project) {
  return `${project.packIdentity ?? '-'}${project.savePath ?? project.sessionDir ?? ''}`;
}

// Un banc où le seul double est le transport IPC : le cache est un objet, mais
// la cadence, la fraicheur et les ancrages sont ceux de production.
function bench({ cacheEntries = new Map(), view = graphView() } = {}) {
  const writes = [];
  const reads = [];
  const timers = new Map();
  let handle = 1;
  let clock = 0;
  const session = createAdvancedViewSession({
    readGraphView: async () => view,
    readViewCache: async ({ project, fingerprint }) => {
      reads.push({ project, fingerprint });
      // Le double reproduit la regle Rust : une entree ne s'applique que si
      // elle decrit **ce** projet.
      return cacheEntries.get(cacheKeyDouble(project)) ?? null;
    },
    writeViewCache: async ({ project, fingerprint, view: value }) => {
      writes.push({ project, fingerprint, view: value });
      cacheEntries.set(cacheKeyDouble(project), {
        fingerprintMatches: true,
        viewportRejected: false,
        view: value,
      });
    },
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = handle++;
      timers.set(id, { at: clock + delay, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    session,
    writes,
    reads,
    cacheEntries,
    async advance(ms) {
      const target = clock + ms;
      for (let guard = 0; guard < 500; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = due[1].at;
        due[1].callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      clock = target;
      await Promise.resolve();
    },
  };
}

// -- Une session de vue ne touche pas au projet -------------------------------

test('une session complete de vue ne touche ni editorState ni la signature', async () => {
  const project = createAdvancedProject({ payload: PAYLOAD, projectName: 'essai' });
  const editorStateAtOpen = project.authoring.editorState;
  const snapshotAtOpen = createWorkSnapshot(project, [], {});

  const harness = bench();
  await harness.session.open({
    projectEpoch: 1,
    project: { packIdentity: 'pack-1', savePath: '/tmp/essai.mbah', sessionDir: null },
  });

  // Une session d'auteur : panoramique, zoom, selection, focus.
  harness.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: -10, y: 4, zoom: 1 } });
  harness.session.noteViewEvent(VIEW_EVENTS.ZOOM, { viewport: { x: -10, y: 4, zoom: 1.4 } });
  harness.session.noteViewEvent(VIEW_EVENTS.SELECTION, {
    selection: { stages: ['/stageNodes/@uuid=s1#0'], actions: [] },
  });
  harness.session.noteViewEvent(VIEW_EVENTS.FOCUS, { focus: '/stageNodes/@uuid=s1#0' });
  await harness.advance(1_000);

  // La vue a bien ete memorisee...
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.writes[0].view.viewport, { x: -10, y: 4, zoom: 1.4 });

  // ... et le projet n'a pas bouge d'un octet.
  assert.equal(project.authoring.editorState, editorStateAtOpen, 'le meme objet, pas une copie egale');
  assert.deepEqual(project.authoring.editorState, { version: 1 });
  assert.equal(createWorkSnapshot(project, [], {}), snapshotAtOpen);
  assert.equal(hasUnsavedWork({ project, savedSnapshot: snapshotAtOpen }), false);
});

test('la revision de vue avance, le ticket de document ne bouge pas', async () => {
  const harness = bench();
  await harness.session.open({
    projectEpoch: 1,
    project: { packIdentity: 'pack-1', savePath: '/tmp/essai.mbah' },
  });
  const before = harness.session.state.ticket;
  harness.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: 1, y: 1, zoom: 1 } });
  const after = harness.session.state.ticket;
  assert.equal(after.viewRevision, before.viewRevision + 1);
  assert.equal(after.documentRevision, before.documentRevision);
  assert.equal(after.projectEpoch, before.projectEpoch);
});

// -- Aucune surface avancée n'écrit dans l'état de l'éditeur ------------------

// Le code seul, sans sa documentation. Un commentaire qui **enonce** la regle
// (« ce module ne passe jamais par setProject ») ne doit pas etre compte comme
// une violation de cette regle : sinon la garde punirait le fait de l'ecrire.
// Les lignes de commentaire entieres et les blocs sont retires ; un `//` a
// l'interieur d'une chaine ne l'est pas, et n'a pas a l'etre ici.
function codeWithoutComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('aucune surface avancee n appelle withEditorState', async () => {
  const files = await sourceFiles(SOURCE_ROOT);
  const callers = [];
  for (const file of files) {
    const contents = codeWithoutComments(await fs.readFile(file, 'utf8'));
    if (!contents.includes('withEditorState')) continue;
    callers.push(repoPath(SOURCE_ROOT, file));
  }
  // Le bloc est **produit** par `authoring.js`, qui le declare ; la facade le
  // reexporte par `export *` et ne le nomme donc pas. Tout autre fichier qui
  // le nommerait dans son code serait un ecrivain, donc un defaut.
  assert.deepEqual(
    callers.sort(),
    ['store/projectModel/authoring.js'],
    `withEditorState ne doit avoir aucun appelant applicatif ; trouve dans ${callers.join(', ')}`,
  );
});

test('la session de vue n importe ni le store de projet ni React ni un moteur', async () => {
  const directory = nodePath.join(SOURCE_ROOT, 'store', 'advancedGraphView');
  for (const file of await sourceFiles(directory)) {
    const contents = codeWithoutComments(await fs.readFile(file, 'utf8'));
    const name = repoPath(SOURCE_ROOT, file);
    assert.ok(!/from ['"]react['"]/.test(contents), `${name} ne doit pas dependre de React`);
    assert.ok(!contents.includes('setProject'), `${name} ne doit pas passer par setProject`);
    assert.ok(!contents.includes('editorState'), `${name} ne doit pas nommer editorState`);
    // La frontiere du paragraphe 8 de la note de comparaison : le modele de
    // lecture ne connait aucun des deux moteurs.
    assert.ok(!/cytoscape/i.test(contents), `${name} ne doit connaitre aucun moteur`);
    assert.ok(!/@antv/i.test(contents), `${name} ne doit connaitre aucun moteur`);
  }
});

// -- Un glisser confirmé ------------------------------------------------------

test('un glisser confirme change la signature et cree une entree d undo', async () => {
  const before = createAdvancedProject({ payload: PAYLOAD, projectName: 'essai' });
  const signatureBefore = createWorkSnapshot(before, [], {});

  // Le glisser confirme est un **geste d'auteur** : Rust rend un payload
  // different, que le store installe comme n'importe quelle mutation.
  const movedPayload = PAYLOAD.replace('"name":"Entree"', '"name":"Entree","position":{"x":12,"y":34}');
  const after = { ...before, authoring: { ...before.authoring, payload: movedPayload } };

  const signatureAfter = createWorkSnapshot(after, [], {});
  assert.notEqual(signatureAfter, signatureBefore);
  assert.ok(hasUnsavedWork({ project: after, savedSnapshot: signatureBefore }));
  // Et le projet d'avant, lui, est toujours considere comme enregistre.
  assert.equal(hasUnsavedWork({ project: before, savedSnapshot: signatureBefore }), false);
  // Et il entre dans l'historique, contrairement a tout geste de vue.
  const history = pushWorkHistory([], before);
  assert.equal(history.length, 1);
  assert.equal(readAuthoringPayload(history[0]), PAYLOAD);
  // `editorState` n'a toujours pas bouge : la position vit dans le payload.
  assert.deepEqual(after.authoring.editorState, { version: 1 });
});

// -- Une caméra par projet ----------------------------------------------------

test('deux projets de meme packIdentity ne partagent aucune camera', async () => {
  const cacheEntries = new Map();
  const premier = { packIdentity: 'pack-1', savePath: '/tmp/premier.mbah', sessionDir: null };
  const second = { packIdentity: 'pack-1', savePath: '/tmp/second.mbah', sessionDir: null };

  const a = bench({ cacheEntries });
  await a.session.open({ projectEpoch: 1, project: premier });
  a.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: -999, y: -999, zoom: 3 } });
  await a.advance(1_000);
  assert.equal(a.writes.length, 1);

  // Le second projet porte la **meme** identite de pack et un autre chemin.
  const b = bench({ cacheEntries });
  await b.session.open({ projectEpoch: 2, project: second });
  assert.equal(b.session.state.viewport, null, 'aucune camera heritee du premier projet');

  // Et le premier retrouve la sienne.
  const c = bench({ cacheEntries });
  await c.session.open({ projectEpoch: 3, project: premier });
  assert.deepEqual(c.session.state.viewport, { x: -999, y: -999, zoom: 3 });
});

test('un changement de projet demonte la vue sans heriter d une valeur', async () => {
  const harness = bench();
  await harness.session.open({
    projectEpoch: 1,
    project: { packIdentity: 'pack-1', savePath: '/tmp/premier.mbah' },
  });
  harness.session.noteViewEvent(VIEW_EVENTS.SELECTION, {
    selection: { stages: ['/stageNodes/@uuid=s1#0'], actions: [] },
  });
  harness.session.noteViewEvent(VIEW_EVENTS.FOCUS, { focus: '/stageNodes/@uuid=s1#0' });
  await harness.advance(1_000);

  await harness.session.open({
    projectEpoch: 2,
    project: { packIdentity: 'pack-2', savePath: '/tmp/second.mbah' },
  });
  const state = harness.session.state;
  assert.deepEqual(state.selection, { stages: [], actions: [] });
  assert.equal(state.viewport, null);
  assert.equal(state.ticket.projectEpoch, 2);
  assert.equal(state.ticket.viewRevision, 0);
  assert.equal(state.ticket.documentRevision, 0);
});

test('un Save As ecrit sur la nouvelle cle sans rediriger l ecriture en vol', async () => {
  const cacheEntries = new Map();
  const harness = bench({ cacheEntries });
  const source = { packIdentity: 'pack-1', savePath: '/tmp/source.mbah' };
  const copie = { packIdentity: 'pack-1', savePath: '/tmp/copie.mbah' };
  await harness.session.open({ projectEpoch: 1, project: source });
  harness.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: 5, y: 5, zoom: 1 } });
  await harness.advance(1_000);
  assert.equal(harness.writes[0].project.savePath, '/tmp/source.mbah');

  harness.session.rebindProject(copie);
  await harness.advance(1_000);
  assert.equal(harness.writes.at(-1).project.savePath, '/tmp/copie.mbah');
  // Le projet source garde sa vue : pas de renommage sur un Save As.
  assert.ok(cacheEntries.has(cacheKeyDouble(source)));
  assert.ok(cacheEntries.has(cacheKeyDouble(copie)));
});

// -- Contre-exemples du paragraphe 9 -----------------------------------------

test('un undo pendant une lecture jette la reponse perimee sans erreur', async () => {
  let resolveRead;
  let calls = 0;
  const session = createAdvancedViewSession({
    readGraphView: () => {
      calls += 1;
      // La premiere lecture reste en vol ; les suivantes repondent tout de suite.
      return calls === 1
        ? new Promise((resolve) => { resolveRead = resolve; })
        : Promise.resolve(graphView({ stages: ['s1', 's2'] }));
    },
    readViewCache: async () => null,
    writeViewCache: async () => {},
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
  });

  const opening = session.open({ projectEpoch: 1, project: { packIdentity: 'p', savePath: '/tmp/a.mbah' } });
  // L'undo survient avant la reponse : le ticket de document avance.
  await session.noteDocumentEvent(DOCUMENT_EVENTS.UNDO);
  resolveRead(graphView({ stages: ['s1'] }));
  const outcome = await opening;
  // La reponse en vol portait un ticket perime : elle n'est pas installee, et
  // ce n'est pas une erreur.
  assert.deepEqual(outcome, { installed: false });
  // C'est la lecture declenchee par l'undo qui a fourni la vue courante.
  assert.equal(session.state.view.counts.stages, 2);
});

test('la camera ne bouge jamais du fait d un undo ou d un geste d auteur', async () => {
  const harness = bench();
  await harness.session.open({
    projectEpoch: 1,
    project: { packIdentity: 'pack-1', savePath: '/tmp/essai.mbah' },
  });
  harness.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: 42, y: 21, zoom: 2 } });
  await harness.session.noteDocumentEvent(DOCUMENT_EVENTS.AUTHOR_GESTURE);
  assert.deepEqual(harness.session.state.viewport, { x: 42, y: 21, zoom: 2 });
  await harness.session.noteDocumentEvent(DOCUMENT_EVENTS.UNDO);
  assert.deepEqual(harness.session.state.viewport, { x: 42, y: 21, zoom: 2 });
});

test('une panne de cache laisse la vue utilisable et ne leve aucun dialogue', async () => {
  const session = createAdvancedViewSession({
    readGraphView: async () => graphView(),
    readViewCache: async () => { throw new Error('cache inaccessible'); },
    writeViewCache: async () => { throw new Error('disque plein'); },
    now: () => 0,
    setTimer: (callback) => { callback(); return 0; },
    clearTimer: () => {},
  });
  const opened = await session.open({
    projectEpoch: 1,
    project: { packIdentity: 'pack-1', savePath: '/tmp/essai.mbah' },
  });
  assert.equal(opened.installed, true, 'la vue s ouvre malgre le cache');
  assert.ok(session.state.notices.some((notice) => notice.kind === 'cache-unreadable'));
  session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: 1, y: 1, zoom: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // La vue reste celle que l'auteur manipule : rien n'a ete annule.
  assert.deepEqual(session.state.viewport, { x: 1, y: 1, zoom: 1 });
});

// -- Le .mbah écrit -----------------------------------------------------------

test('le .mbah ecrit apres une session de vue ne porte que la version 1', async () => {
  const harness = await createDiskHarness();
  try {
    const io = await import('../src/store/projectIO.js');
    const projectDir = await harness.mkdirp('projet');
    const savePath = `${projectDir}/avance.mbah`;
    const project = createAdvancedProject({ payload: PAYLOAD, projectName: 'avance' });

    // Une session de vue complete, sur la vraie session de vue.
    const view = bench();
    await view.session.open({
      projectEpoch: 1,
      project: { packIdentity: 'pack-1', savePath, sessionDir: null },
    });
    view.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: { x: -240, y: 118.5, zoom: 0.75 } });
    view.session.noteViewEvent(VIEW_EVENTS.SELECTION, {
      selection: { stages: ['/stageNodes/@uuid=s1#0'], actions: [] },
    });
    await view.advance(1_000);
    assert.equal(view.writes.length, 1, 'la vue a bien ete memorisee quelque part');

    const saved = await io.saveProject(project, savePath);
    assert.equal(saved.path, savePath);
    const written = JSON.parse(await fs.readFile(savePath, 'utf8'));
    // Le cycle complet : ce que la vue a memorise n'est **pas** dans le fichier.
    assert.deepEqual(written.authoring.editorState, { version: 1 });
    assert.equal(written.authoring.payload, PAYLOAD, 'le payload est reecrit a l octet');
    const serialized = JSON.stringify(written);
    assert.ok(!serialized.includes('118.5'), 'aucune camera dans le document');
    assert.ok(!serialized.includes('viewport'), 'aucun bloc de vue dans le document');
  } finally {
    await harness.dispose();
  }
});
