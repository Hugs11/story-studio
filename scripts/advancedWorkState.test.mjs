// État de travail du projet avancé.
//
// Les fonctions éprouvées ici sont celles que `useProjectStore` et
// `useSaveProgress` appellent : la discrimination de mode, les transitions
// d'historique, la signature de travail et la publication d'un résultat de
// sauvegarde. Le seul double est le store React lui-même, remplacé par un objet
// qui enregistre ce qu'on lui demande — la décision et son application, elles,
// sont la production. Le disque, lui, est réel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { workState } from './workStateDriver.mjs';
import {
  acquireCreatedAdvancedProject,
  assessAdvancedProjectReadiness,
  createAdvancedProject,
  normalizeProjectData,
  readAuthoringPayload,
  readEditorState,
  resolveMediaBindingStatuses,
  withAuthoringPayload,
  withEditorState,
  withMediaBindings,
} from '../src/store/projectModel.js';
import {
  hierarchicalProjectType,
  MAX_HISTORY_SIZE,
  normalizeWorkProject,
  pushWorkHistory,
  requalifiedMediaBindings,
  workProjectDepthDiagnostic,
} from '../src/store/projectWorkState.js';
import {
  applySavePublication,
  classifySavePublication,
  createWorkSnapshot,
  hasUnsavedWork,
  isSaveInputStillCurrent,
  publishedWorkSnapshot,
  SAVE_PUBLICATION,
} from '../src/store/projectHelpers.js';

// Payload de référence, écrit comme une chaîne et jamais construit par
// `JSON.stringify` : `9007199254740993` ne survivrait pas à un aller-retour
// JavaScript, donc sa présence à l'octet prouve qu'aucune couche ne l'a ouvert.
const PAYLOAD = '{"payloadVersion":1,"document":{"title":"Le renard","version":1,"format":"v1",'
  + '"stageNodes":[{"uuid":"0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34","squareOne":true,'
  + '"audio":"a1b2c3.mp3","image":"d4e5f6.png","duration":9007199254740993,'
  + '"controlSettings":{"wheel":false,"ok":true,"home":null,"pause":false},'
  + '"okTransition":{"actionNode":"action-1","optionIndex":-1},"position":{"x":120.5,"y":-32769}}],'
  + '"actionNodes":[{"id":"action-1","options":["0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34"]}]},'
  + '"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio",'
  + '"packIdentity":{"origin":"generated","value":"6f1c0000-0000-4000-8000-000000000001"},'
  + '"opaqueMembers":[{"scope":"stage","path":"/stageNodes/@uuid=0f9c2a41#0","key":"cadence",'
  + '"value":42,"exportDisposition":null}],"editorPositions":[],"diagnostics":[]}}';

// Cinq mutations d'auteur, chacune produite comme Rust la produirait : une
// chaîne différente. La transition, le champ présence-sensible, la disposition
// opaque et la provenance sont bien des valeurs distinctes, pas des variantes
// de graphie du même document.
const MUTATIONS = {
  transition: [
    '"okTransition":{"actionNode":"action-1","optionIndex":-1}',
    '"okTransition":{"actionNode":"action-1","optionIndex":0}',
  ],
  presence: [
    '"home":null', '"home":true',
  ],
  disposition: [
    '"exportDisposition":null', '"exportDisposition":"preserve-untested"',
  ],
  provenance: [
    '"defaultValueOrigin":"source-studio"', '"defaultValueOrigin":"source-native-derived"',
  ],
  identity: [
    '"value":"6f1c0000-0000-4000-8000-000000000001"',
    '"value":"6f1c0000-0000-4000-8000-000000000002"',
  ],
};

function mutatedPayload(kind) {
  const [from, to] = MUTATIONS[kind];
  assert.ok(PAYLOAD.includes(from), `témoin ${kind} absent du payload de référence`);
  return PAYLOAD.replace(from, to);
}

function advancedProject(overrides = {}) {
  return createAdvancedProject({
    payload: PAYLOAD,
    projectName: 'renard-avance',
    mediaBindings: [
      { assetRef: 'a1b2c3.mp3', path: '/projets/renard/medias/a1b2c3.mp3', status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: '/projets/renard/medias/d4e5f6.png', status: 'missing' },
    ],
    ...overrides,
  });
}

const freeProject = () => ({
  projectName: 'conte-simple',
  projectType: 'pack',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Le renard', audio: '/medias/story.mp3' }],
});

// ── Installation, remplacement et mode ───────────────────────────────────────

test('un projet avancé est installé sans normaliseur hiérarchique ni champ inventé', () => {
  const project = advancedProject();
  const installed = normalizeWorkProject(project);
  assert.equal(installed, project, 'la valeur installée est celle fournie, pas une reconstruction');
  assert.deepEqual(installed.rootEntries, []);
  assert.equal(readAuthoringPayload(installed), PAYLOAD);
  for (const key of ['packMetadata', 'globalOptions', 'nativeGraph', 'rootName', 'importWarnings']) {
    assert.equal(Object.hasOwn(installed, key), false, `${key} ne doit pas apparaître`);
  }
  // La protection du normaliseur Libre reste en place : c'est la branche de
  // mode qui distingue les cas, pas sa porte.
  assert.throws(() => normalizeProjectData(project), (error) => error.code === 'ADVANCED_CODEC_REQUIRED');
});

test('un projet Libre traverse exactement le normaliseur qu’il traversait', () => {
  const raw = freeProject();
  assert.deepEqual(normalizeWorkProject(raw), normalizeProjectData(raw));
});

test('une mutation qui casse l’enveloppe avancée est refusée à l’installation', () => {
  const project = advancedProject();
  const refusals = [
    [{ ...project, authoring: { ...project.authoring, payload: 42 } }, 'INVALID_AUTHORING_PAYLOAD'],
    [{ ...project, rootEntries: [{ id: 'x', type: 'story' }] }, 'CONTRADICTORY_PROJECT_ENVELOPE'],
    [{ ...project, nativeGraph: { document: {} } }, 'CONTRADICTORY_PROJECT_ENVELOPE'],
    [withMediaBindings(project, [{ assetRef: 'a.mp3', path: null, status: 'resolved' }]), 'INVALID_MEDIA_BINDING'],
    [withMediaBindings(project, [
      { assetRef: 'a.mp3', path: '/a.mp3', status: 'resolved' },
      { assetRef: 'a.mp3', path: '/b.mp3', status: 'resolved' },
    ]), 'DUPLICATE_MEDIA_BINDING'],
  ];
  for (const [broken, code] of refusals) {
    assert.throws(() => normalizeWorkProject(broken), (error) => error.code === code, code);
  }
});

test('la profondeur de Dossiers ne qualifie pas un graphe d’auteur', () => {
  const advanced = workProjectDepthDiagnostic(advancedProject());
  assert.equal(advanced.allowed, true);
  assert.equal(advanced.authoringMode, 'advanced');
  assert.equal(advanced.observedDepth, 0);
  // Le témoin Libre trop profond reste refusé par la même fonction.
  let deep = { id: 'menu-0', type: 'menu', name: 'M0', children: [] };
  const root = deep;
  for (let level = 1; level <= 62; level += 1) {
    const child = { id: `menu-${level}`, type: 'menu', name: `M${level}`, children: [] };
    deep.children.push(child);
    deep = child;
  }
  assert.equal(workProjectDepthDiagnostic({ projectType: 'pack', rootEntries: [root] }).allowed, false);
});

test('aucun composant hiérarchique ne monte sur un projet avancé', () => {
  assert.equal(hierarchicalProjectType(advancedProject()), null);
  assert.equal(hierarchicalProjectType(normalizeProjectData(freeProject())), 'pack');
  assert.equal(hierarchicalProjectType({ projectType: null }), null);
});

// ── Historique ───────────────────────────────────────────────────────────────

test('undo puis redo d’une mutation d’auteur restaurent la chaîne exacte', () => {
  const work = workState(advancedProject());
  const mutated = mutatedPayload('transition');
  work.mutate((project) => withAuthoringPayload(project, mutated));
  assert.equal(readAuthoringPayload(work.project), mutated);
  assert.equal(work.undo(), true);
  assert.equal(readAuthoringPayload(work.project), PAYLOAD, 'undo restaure le document et son contexte');
  assert.equal(work.redo(), true);
  assert.equal(readAuthoringPayload(work.project), mutated);
});

test('l’identité générée à l’initialisation ne disparaît pas au premier undo', () => {
  const work = workState(advancedProject());
  assert.equal(work.undo(), false, 'aucune étape antérieure au projet installé');
  assert.equal(readAuthoringPayload(work.project), PAYLOAD);
  // Une installation ultérieure vide aussi l'historique : rien d'antérieur au
  // projet acquis ne reste atteignable, et aucune identité n'est retirée.
  work.mutate((project) => withEditorState(project, { version: 1, viewport: { x: 4, y: 2, zoom: 1 } }));
  work.install(advancedProject());
  assert.equal(work.undo(), false);
  assert.equal(readAuthoringPayload(work.project), PAYLOAD);
});

test('l’historique reste borné et ne perd pas l’étape la plus récente', () => {
  let history = [];
  for (let step = 0; step < MAX_HISTORY_SIZE + 10; step += 1) history = pushWorkHistory(history, step);
  assert.equal(history.length, MAX_HISTORY_SIZE);
  assert.equal(history[history.length - 1], MAX_HISTORY_SIZE + 9);
});

// ── Signature de travail ─────────────────────────────────────────────────────

test('chaque valeur persistante change la signature, et elle seule', () => {
  const base = advancedProject();
  const signature = (project) => createWorkSnapshot(project, [], {});
  const reference = signature(base);

  for (const kind of Object.keys(MUTATIONS)) {
    assert.notEqual(
      signature(withAuthoringPayload(base, mutatedPayload(kind))),
      reference,
      `une mutation ${kind} doit changer la signature`,
    );
  }
  assert.notEqual(
    signature(withEditorState(base, { version: 1, viewport: { x: 12.5, y: -3.25, zoom: 0.75 } })),
    reference,
    'un état visuel persistant change la signature',
  );
  assert.notEqual(
    signature(withMediaBindings(base, [
      { assetRef: 'a1b2c3.mp3', path: '/ailleurs/a1b2c3.mp3', status: 'resolved' },
      ...base.authoring.mediaBindings.slice(1),
    ])),
    reference,
    'une liaison média repointée change la signature',
  );

  // Une valeur qui ne change pas n'en crée pas une nouvelle.
  assert.equal(signature(withAuthoringPayload(base, PAYLOAD)), reference);
  assert.equal(signature(withEditorState(base, { ...readEditorState(base) })), reference);
});

test('un relevé de disque ne rend pas le projet sale', () => {
  const base = advancedProject();
  const reference = createWorkSnapshot(base, [], {});
  const audited = resolveMediaBindingStatuses(base, {
    '/projets/renard/medias/a1b2c3.mp3': false,
    '/projets/renard/medias/d4e5f6.png': true,
  });
  assert.notDeepEqual(
    audited.authoring.mediaBindings.map((binding) => binding.status),
    base.authoring.mediaBindings.map((binding) => binding.status),
    'le relevé doit bien avoir changé les statuts',
  );
  assert.equal(createWorkSnapshot(audited, [], {}), reference);
  assert.equal(hasUnsavedWork({ project: audited, savedSnapshot: reference }), false);
});

test('l’audit disque requalifie les liaisons, une seule fois et hors historique', () => {
  const base = advancedProject();
  // Un projet Libre n'a aucune liaison : rien à requalifier.
  assert.equal(requalifiedMediaBindings(normalizeProjectData(freeProject()), {}), null);
  // Un relevé qui confirme les statuts connus ne réinstalle rien.
  assert.equal(requalifiedMediaBindings(base, {
    '/projets/renard/medias/a1b2c3.mp3': true,
    '/projets/renard/medias/d4e5f6.png': false,
  }), null);
  // Un chemin absent du relevé garde son dernier état connu.
  assert.equal(requalifiedMediaBindings(base, {}), null);
  const requalified = requalifiedMediaBindings(base, { '/projets/renard/medias/d4e5f6.png': true });
  assert.deepEqual(requalified.authoring.mediaBindings.map((binding) => binding.status), ['resolved', 'resolved']);
  assert.deepEqual(
    requalified.authoring.mediaBindings.map((binding) => binding.assetRef),
    base.authoring.mediaBindings.map((binding) => binding.assetRef),
  );
  assert.equal(createWorkSnapshot(requalified, [], {}), createWorkSnapshot(base, [], {}));
  assert.equal(requalifiedMediaBindings(requalified, { '/projets/renard/medias/d4e5f6.png': true }), null);
});

test('l’ordre des clés du fichier n’est pas une valeur d’auteur', () => {
  const base = advancedProject();
  const reordered = {
    authoring: {
      mediaBindings: base.authoring.mediaBindings,
      editorState: base.authoring.editorState,
      payload: base.authoring.payload,
    },
    rootEntries: [],
    projectName: base.projectName,
    projectType: 'advanced',
    authoringMode: 'advanced',
    schemaVersion: 4,
  };
  assert.equal(createWorkSnapshot(normalizeWorkProject(reordered), [], {}), createWorkSnapshot(base, [], {}));
});

test('un projet avancé jamais enregistré est un travail non enregistré', () => {
  const base = advancedProject();
  assert.equal(hasUnsavedWork({ project: base, savedSnapshot: null }), true);
  const saved = createWorkSnapshot(base, [], {});
  assert.equal(hasUnsavedWork({ project: base, savedSnapshot: saved }), false);
  assert.equal(
    hasUnsavedWork({ project: withAuthoringPayload(base, mutatedPayload('presence')), savedSnapshot: saved }),
    true,
  );
});

// ── Publication d’un résultat de sauvegarde ──────────────────────────────────

// Double du store React : il n'a que le contrat que `applySavePublication`
// utilise, et enregistre ce qui lui a été demandé.
function storeDouble(project) {
  return {
    project,
    savePath: null,
    installed: [],
    syncProjectWithoutHistory(next) { this.project = next; this.installed.push(next); },
    setSavePath(path) { this.savePath = path; },
  };
}

function publish({
  startedFrom, work, result, savedSnapshot, replaced, marks,
  mediaLibraryPaths = [], mediaTags = {},
}) {
  const projectStillCurrent = isSaveInputStillCurrent(startedFrom, work.project);
  const decision = classifySavePublication({
    replaced,
    savedSnapshot,
    currentSnapshot: replaced ? null : publishedWorkSnapshot({
      projectStillCurrent,
      resultProject: result.project,
      currentProject: work.project,
      mediaLibraryPaths,
      mediaTags,
    }),
  });
  applySavePublication({
    decision, work, result, savedSnapshot, projectStillCurrent, ...marks,
  });
  return decision;
}

test('un résultat de sauvegarde ne publie que le travail encore courant', () => {
  const saved = advancedProject();
  const work = storeDouble(saved);
  const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: 'auto' } };
  const savedSnapshot = createWorkSnapshot(saved, [], {});
  const decision = publish({
    startedFrom: saved,
    work,
    result: { project: saved, path: '/projets/renard/renard.mbah' },
    savedSnapshot,
    replaced: false,
    marks,
  });
  assert.equal(decision, SAVE_PUBLICATION.CURRENT);
  assert.equal(work.savePath, '/projets/renard/renard.mbah');
  assert.equal(marks.savedSnapshotRef.current, savedSnapshot);
  assert.equal(marks.autoSaveSnapshotRef.current, null);
  assert.equal(work.installed.length, 1);
});

test('une mutation survenue pendant l’attente reste non enregistrée', () => {
  const stateA = advancedProject();
  const work = storeDouble(stateA);
  const savedSnapshot = createWorkSnapshot(stateA, [], {});
  // B arrive pendant l'écriture de A.
  const stateB = withAuthoringPayload(stateA, mutatedPayload('transition'));
  work.project = stateB;
  const marks = { savedSnapshotRef: { current: 'signature-precedente' }, autoSaveSnapshotRef: { current: 'auto' } };
  const decision = publish({
    startedFrom: stateA,
    work,
    result: { project: stateA, path: '/projets/renard/renard.mbah' },
    savedSnapshot,
    replaced: false,
    marks,
  });
  assert.equal(decision, SAVE_PUBLICATION.STALE);
  assert.equal(work.project, stateB, 'le résultat A n’écrase pas B');
  assert.deepEqual(work.installed, []);
  assert.equal(work.savePath, '/projets/renard/renard.mbah', 'le fichier écrit devient bien le chemin courant');
  assert.equal(marks.savedSnapshotRef.current, 'signature-precedente');
  assert.equal(
    hasUnsavedWork({ project: work.project, savedSnapshot: marks.savedSnapshotRef.current }),
    true,
    'B reste marqué non sauvegardé',
  );
});

test('un projet remplacé ou réinitialisé pendant l’attente ne reçoit rien', () => {
  const stateA = advancedProject();
  const replacement = normalizeProjectData(freeProject());
  const work = storeDouble(replacement);
  const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: null } };
  const decision = publish({
    startedFrom: stateA,
    work,
    result: { project: stateA, path: '/projets/renard/renard.mbah' },
    savedSnapshot: createWorkSnapshot(stateA, [], {}),
    replaced: true,
    marks,
  });
  assert.equal(decision, SAVE_PUBLICATION.REPLACED);
  assert.equal(work.project, replacement);
  assert.deepEqual(work.installed, []);
  assert.equal(work.savePath, null, 'le chemin du fichier écrit n’est pas attribué au projet installé');
  assert.equal(marks.savedSnapshotRef.current, null);
});

test('un enregistrement lancé sur un projet corrigé hors du store reste publiable', () => {
  // Cas du relink : l'objet enregistré n'est plus celui du store, mais la
  // signature est la même — le fichier porte bien le travail courant.
  const corrected = advancedProject();
  const work = storeDouble(advancedProject());
  assert.notEqual(work.project, corrected);
  const savedSnapshot = createWorkSnapshot(corrected, [], {});
  const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: 'auto' } };
  const decision = publish({
    startedFrom: corrected,
    work,
    result: { project: corrected, path: '/projets/renard/renard.mbah' },
    savedSnapshot,
    replaced: false,
    marks,
  });
  assert.equal(decision, SAVE_PUBLICATION.CURRENT);
  assert.equal(marks.savedSnapshotRef.current, savedSnapshot);
  assert.deepEqual(work.installed, [], 'un objet qui n’est plus celui du store n’est pas réinstallé');
});

test('un catalogue modifié pendant l’écriture reste du travail non enregistré', () => {
  // F-03 : le projet n'a pas bougé, mais un média a été ajouté au catalogue
  // pendant la copie sous. Le fichier écrit ne le porte pas : le déclarer
  // enregistré ferait passer ce média pour sauvegardé.
  const saved = advancedProject();
  const work = storeDouble(saved);
  const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: 'auto' } };
  const savedSnapshot = createWorkSnapshot(saved, ['/medias/ancien.wav'], {});
  const decision = publish({
    startedFrom: saved,
    work,
    result: { project: saved, path: '/projets/renard/copie.mbah' },
    savedSnapshot,
    replaced: false,
    marks,
    mediaLibraryPaths: ['/medias/ancien.wav', '/medias/nouveau.wav'],
  });
  assert.equal(decision, SAVE_PUBLICATION.STALE);
  assert.equal(work.savePath, '/projets/renard/copie.mbah', 'la copie écrite devient le chemin courant');
  assert.equal(marks.savedSnapshotRef.current, null, 'rien n’est déclaré enregistré');
  assert.equal(marks.autoSaveSnapshotRef.current, 'auto');
  assert.equal(
    hasUnsavedWork({
      project: work.project,
      mediaLibraryPaths: ['/medias/ancien.wav', '/medias/nouveau.wav'],
      savedSnapshot: savedSnapshot,
    }),
    true,
    'le média ajouté reste du travail à enregistrer',
  );
});

test('un tag posé pendant l’écriture n’est pas emporté par la publication', () => {
  const saved = advancedProject();
  const work = storeDouble(saved);
  const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: null } };
  const savedSnapshot = createWorkSnapshot(saved, ['/medias/a.wav'], {});
  const decision = publish({
    startedFrom: saved,
    work,
    result: { project: saved, path: '/projets/renard/renard.mbah' },
    savedSnapshot,
    replaced: false,
    marks,
    mediaLibraryPaths: ['/medias/a.wav'],
    mediaTags: { '/medias/a.wav': ['voix'] },
  });
  assert.equal(decision, SAVE_PUBLICATION.STALE);
  assert.equal(marks.savedSnapshotRef.current, null);
});

// ── Acquisition et readiness ─────────────────────────────────────────────────

test('l’acquisition d’un document créé n’a lieu qu’une fois par projet', async () => {
  const calls = [];
  const invokeCommand = async (command, args) => {
    calls.push({ command, args });
    return PAYLOAD;
  };
  const acquired = await acquireCreatedAdvancedProject({ title: 'Le renard', invokeCommand });
  const work = workState(acquired);
  work.mutate((project) => withAuthoringPayload(project, mutatedPayload('transition')));
  work.undo();
  work.redo();
  work.install(normalizeWorkProject(work.project));
  assert.deepEqual(calls, [{ command: 'create_advanced_document', args: { title: 'Le renard' } }]);
  assert.equal(acquired.projectName, 'Le renard');
  assert.equal(acquired.authoringMode, 'advanced');
  assert.deepEqual(acquired.authoring.mediaBindings, []);
});

test('la readiness est demandée sur le payload courant, jamais mémorisée', async () => {
  const asked = [];
  const invokeCommand = async (command, { payload }) => {
    asked.push(payload);
    return { blocked: payload !== PAYLOAD, interoperability: 'SUPPORTED', dimensions: [], unevaluated: [], diagnostics: [] };
  };
  const base = advancedProject();
  const first = await assessAdvancedProjectReadiness(base, { invokeCommand });
  const edited = withAuthoringPayload(base, mutatedPayload('disposition'));
  const second = await assessAdvancedProjectReadiness(edited, { invokeCommand });
  assert.deepEqual(asked, [PAYLOAD, mutatedPayload('disposition')]);
  assert.equal(first.blocked, false);
  assert.equal(second.blocked, true);
  // Rien n'est retenu dans le projet : ni readiness, ni qualification.
  for (const project of [base, edited]) {
    assert.equal(JSON.stringify(project).includes('interoperability'), false);
    assert.equal(JSON.stringify(project).includes('blocked'), false);
  }
});

// ── Cycle disque, sur fichiers réels ─────────────────────────────────────────

test('le projet avancé issu de l’état de travail s’écrit sans être normalisé', async () => {
  const harness = await createDiskHarness();
  try {
    const io = await import('../src/store/projectIO.js');
    const projectDir = await harness.mkdirp('projet');
    await harness.writeFile('projet/medias/a1b2c3.mp3', 'audio du renard');
    const savePath = `${projectDir}/renard.mbah`;

    const work = workState(createAdvancedProject({
      payload: PAYLOAD,
      projectName: 'renard-avance',
      mediaBindings: [
        { assetRef: 'a1b2c3.mp3', path: `${projectDir}/medias/a1b2c3.mp3`, status: 'resolved' },
        { assetRef: 'd4e5f6.png', path: `${projectDir}/medias/disparu.png`, status: 'missing' },
      ],
    }));
    // Une écriture d'auto-layout : elle reste dans l'état d'éditeur.
    work.mutate((project) => withEditorState(project, {
      version: 1,
      viewport: { x: -240, y: 118.5, zoom: 0.75 },
      collapsed: ['/stageNodes/@uuid=0f9c2a41#0'],
    }));

    const saved = await io.saveProject(work.project, savePath);
    assert.equal(saved.path, savePath);

    const written = JSON.parse(await fs.readFile(savePath, 'utf8'));
    assert.equal(written.schemaVersion, 4);
    assert.equal(written.authoringMode, 'advanced');
    assert.deepEqual(written.rootEntries, []);
    assert.equal(written.authoring.payload, PAYLOAD, 'le payload est réécrit à l’octet');
    assert.equal(written.authoring.editorState.viewport.x, -240);
    assert.deepEqual(written.authoring.mediaBindings.map((binding) => binding.path),
      ['./medias/a1b2c3.mp3', './medias/disparu.png']);
    for (const key of ['globalOptions', 'nativeGraph', 'rootName', 'importWarnings']) {
      assert.equal(Object.hasOwn(written, key), false, `${key} ne doit pas être fabriqué à l’écriture`);
    }

    // Une mutation pendant l'écriture : le résultat ne la remplace pas.
    const marks = { savedSnapshotRef: { current: null }, autoSaveSnapshotRef: { current: null } };
    const store = storeDouble(work.project);
    const pending = io.saveProject(work.project, savePath);
    const stateA = work.project;
    work.mutate((project) => withAuthoringPayload(project, mutatedPayload('provenance')));
    store.project = work.project;
    const result = await pending;
    const decision = publish({
      startedFrom: stateA,
      work: store,
      result,
      savedSnapshot: createWorkSnapshot(result.project, [], {}),
      replaced: false,
      marks,
    });
    assert.equal(decision, SAVE_PUBLICATION.STALE);
    assert.equal(readAuthoringPayload(store.project), mutatedPayload('provenance'));
    assert.equal(marks.savedSnapshotRef.current, null);
    assert.equal(
      JSON.parse(await fs.readFile(savePath, 'utf8')).authoring.payload,
      PAYLOAD,
      'le fichier porte l’état A réellement écrit',
    );
  } finally {
    await harness.dispose();
  }
});

// ── Vignette catalogue d'un projet graphe ───────────────────────────────────
//
// Elle vit dans l'**enveloppe**, comme côté hiérarchique, et non dans le
// document : c'est ce qui permet de la reprendre d'un pack importé sans
// toucher au dialecte, et d'éviter deux mécaniques pour la même fonction.

test('la vignette catalogue acquise est retenue dans l’enveloppe du projet graphe', () => {
  const project = createAdvancedProject({
    payload: PAYLOAD,
    projectName: 'pack repris',
    thumbnailImage: '/medias/.story-studio-thumbnail/thumbnail.png',
  });
  assert.equal(project.thumbnailImage, '/medias/.story-studio-thumbnail/thumbnail.png');
  // Elle n'entre pas dans le document : le payload reste celui qu'on a reçu.
  assert.equal(readAuthoringPayload(project), PAYLOAD);
});

test('un pack sans vignette n’ajoute aucun champ, et garde le repli sur l’Écran d’entrée', () => {
  const project = createAdvancedProject({ payload: PAYLOAD, projectName: 'pack nu' });
  assert.equal(Object.hasOwn(project, 'thumbnailImage'), false);
});
