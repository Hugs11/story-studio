// Autosave, reprise après interruption et promotion.
//
// Les snapshots sont écrits dans un répertoire temporaire réel par les
// fonctions de production, puis relus par `node:fs` — jamais par la fonction
// qui vient de les écrire. Seuls la WebView, les dialogues et le transport IPC
// sont doublés ; `validate_advanced_payload` n'est **pas** déclaré au harnais,
// donc tout trajet exercé ici prouve, en passant, qu'il n'appelle pas Rust.
// C'est ce qui rend l'énumération des reprises vérifiable : un aperçu qui
// validerait le payload échouerait sur ce banc. Le cycle complet de reprise,
// lui, traverse le vrai handler Tauri dans `sessionRecoveryTransport.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const io = await import('../src/store/projectIO.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { isProjectWorthAutosaving } = await import('../src/store/autosaveDecision.js');
const {
  applySessionMediaTriage,
  collectSessionBoundReferences,
  collectSessionOnlyMedia,
} = await import('../src/store/sessionMediaTriage.js');
const { createWorkSnapshot, shouldAbortEphemeralPromotion } = await import('../src/store/projectHelpers.js');
const {
  acceptEphemeralSnapshotSeed,
  beginEphemeralSnapshotSeed,
  createEphemeralSnapshotSeedState,
  finishEphemeralSnapshotSeed,
  resetEphemeralSnapshotSeedState,
} = await import('../src/store/ephemeralSnapshotSeed.js');
const { KEYS } = await import('../src/store/persistentSettings.js');

// Entier au-delà de 2^53 : le payload d'auteur ne traverse jamais `JSON.parse`
// en JavaScript, et un snapshot de session doit le prouver à l'octet comme un
// enregistrement explicite.
const PAYLOAD = '{"payloadVersion":1,"document":{"title":"","stageNodes":[{"uuid":"0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34",'
  + '"squareOne":true,"audio":"a1b2c3.mp3","image":null,"duration":9007199254740993,'
  + '"controlSettings":{"wheel":false,"ok":true},"position":{"x":120.5,"y":-32769}}],'
  + '"actionNodes":[{"id":"action-1","options":["0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34"]}]},'
  + '"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio",'
  + '"packIdentity":{"origin":"generated","value":"6f1c0000-0000-4000-8000-000000000001"},'
  + '"editorPositions":[],"opaqueMembers":[],"diagnostics":[]}}';

// Projet avancé sans titre, sans média racine, sans arbre : exactement ce que
// l'inventaire Libre jugeait vide, et qui est pourtant du travail.
function advancedProject({ projectName = '', bindings = [], editorState = null } = {}) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName,
    rootEntries: [],
    authoring: {
      payload: PAYLOAD,
      editorState: editorState ?? { version: 1 },
      mediaBindings: bindings,
    },
  };
}

// L'histoire pré-créée du mode simple : le filtre du placeholder vierge doit
// continuer de refuser tout snapshot, sinon l'accueil propose une reprise vide.
const pristineFreeProject = () => normalizeProjectData({
  projectType: 'simple',
  projectName: '',
  rootEntries: [{ id: 'story-1', type: 'story', name: '' }],
});

async function withHarness(run) {
  const harness = await createDiskHarness();
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

// Dossier de session éphémère et chemin de son snapshot, tels que `useWorkSession`
// les compose (`.session-recovery.mbah` à la racine de la session).
async function sessionDir(harness, name = 'session') {
  const dir = await harness.mkdirp(name);
  return { dir, snapshotPath: `${dir}/.session-recovery.mbah` };
}

const readJson = async (path) => JSON.parse(await fs.readFile(path, 'utf8'));

// ── Critère « contenu qui mérite sauvegarde » ────────────────────────────────

test('un projet avancé sans titre, média ni arbre mérite un snapshot ; le placeholder Libre vierge non', () => {
  assert.equal(isProjectWorthAutosaving(advancedProject()), true);
  assert.equal(isProjectWorthAutosaving(advancedProject(), [], 0), true);
  // Le mode décide avant l'inventaire : ni catalogue ni compteur ne sont requis.
  assert.equal(isProjectWorthAutosaving(pristineFreeProject()), false);
  assert.equal(isProjectWorthAutosaving(pristineFreeProject(), [], 0), false);
  assert.equal(isProjectWorthAutosaving(null), false);
});

test('une disposition visuelle est du travail : elle change la signature et déclenche le snapshot', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    const before = advancedProject();
    const after = advancedProject({
      editorState: { version: 1, viewport: { x: -240, y: 118.5, zoom: 0.75 }, collapsed: ['/stageNodes/@uuid=0f9c2a41#0'] },
    });
    assert.notEqual(createWorkSnapshot(before, [], {}), createWorkSnapshot(after, [], {}));

    await io.autoSaveEphemeralProject(before, dir, snapshotPath);
    const seeded = await readJson(snapshotPath);
    assert.equal(Object.hasOwn(seeded.authoring.editorState, 'viewport'), false);

    await io.autoSaveEphemeralProject(after, dir, snapshotPath);
    const rewritten = await readJson(snapshotPath);
    assert.equal(rewritten.authoring.editorState.viewport.x, -240);
    assert.deepEqual(rewritten.authoring.editorState.collapsed, ['/stageNodes/@uuid=0f9c2a41#0']);
  });
});

test('le snapshot d’un avancé passe par le codec : la chaîne est écrite à l’octet, sans appel Rust', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    const audio = await harness.writeFile('session/fichiers-importes/a1b2c3.mp3', 'audio');
    const project = advancedProject({
      bindings: [{ assetRef: 'a1b2c3.mp3', path: audio, status: 'resolved' }],
    });

    const written = await io.autoSaveEphemeralProject(project, dir, snapshotPath, {
      mediaTags: { [audio]: ['voix'] },
      mediaLibraryPaths: [audio],
      totalMediaCount: 1,
    });
    assert.equal(written.path, snapshotPath);

    const raw = await fs.readFile(snapshotPath, 'utf8');
    assert.ok(raw.includes('9007199254740993'), 'le grand entier survit à l’octet');
    const snapshot = await readJson(snapshotPath);
    assert.equal(snapshot.schemaVersion, 4);
    assert.equal(snapshot.authoringMode, 'advanced');
    assert.equal(snapshot.authoring.payload, PAYLOAD);
    // Relativisé contre le dossier de session, comme un enregistrement explicite.
    assert.equal(snapshot.authoring.mediaBindings[0].path, './fichiers-importes/a1b2c3.mp3');
    assert.equal(snapshot.authoring.mediaBindings[0].assetRef, 'a1b2c3.mp3');
    assert.deepEqual(snapshot.mediaLibraryPaths, ['./fichiers-importes/a1b2c3.mp3']);
    assert.deepEqual(snapshot.mediaTags['./fichiers-importes/a1b2c3.mp3'], ['voix']);
  });
});

test('un projet Libre vierge n’écrit aucun snapshot de session', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    await assert.rejects(
      () => io.autoSaveEphemeralProject(pristineFreeProject(), dir, snapshotPath, { totalMediaCount: 0 }),
      /projet courant semble vide/,
    );
    assert.equal(await harness.exists(snapshotPath), false, 'aucun fichier de reprise parasite');
  });
});

// ── Énumération des reprises ─────────────────────────────────────────────────

test('un aperçu de reprise laisse les octets intacts et n’ouvre pas le payload', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    await io.autoSaveEphemeralProject(advancedProject({ projectName: 'document-cree' }), dir, snapshotPath);
    const bytesBefore = await fs.readFile(snapshotPath);

    // Aucun `validate_advanced_payload` n'est déclaré au harnais : si l'aperçu
    // ouvrait le payload, cet appel échouerait au lieu de rendre un nom.
    const preview = await io.previewProjectFromPath(snapshotPath);
    assert.equal(preview.authoringMode, 'advanced');
    assert.equal(preview.projectName, 'document-cree');
    assert.equal(preview.projectType, 'advanced');
    assert.equal(preview.thumbnailImage, null);
    assert.deepEqual(await fs.readFile(snapshotPath), bytesBefore, 'les octets du snapshot sont inchangés');

    // Et l'ouverture réelle, elle, exige bien Rust : la différence est mesurée.
    await assert.rejects(() => io.loadProjectFromPath(snapshotPath), /validate_advanced_payload/);
    assert.deepEqual(await fs.readFile(snapshotPath), bytesBefore);
  });
});

test('un aperçu Libre n’invente pas l’identité que l’ouverture, elle, génère', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    const image = await harness.writeFile('session/images-generees/couverture.png', 'png');
    await io.autoSaveEphemeralProject(
      normalizeProjectData({ projectName: 'conte', projectType: 'pack', thumbnailImage: image, rootEntries: [] }),
      dir,
      snapshotPath,
    );
    const stored = await readJson(snapshotPath);
    delete stored.packMetadata;
    await fs.writeFile(snapshotPath, JSON.stringify(stored, null, 2));
    const bytesBefore = await fs.readFile(snapshotPath);

    const preview = await io.previewProjectFromPath(snapshotPath);
    assert.equal(preview.authoringMode, 'free');
    assert.equal(preview.projectName, 'conte');
    assert.equal(preview.thumbnailImage, image, 'la vignette relative est résolue pour être affichable');
    assert.deepEqual(await fs.readFile(snapshotPath), bytesBefore);

    // L'ouverture, elle, migre et fabrique l'UUID manquant : c'est exactement ce
    // qu'une simple énumération ne doit pas faire.
    const opened = await io.loadProjectFromPath(snapshotPath, { preserveEmptyProjectName: true });
    assert.ok(opened.data.packMetadata.uuid, 'l’ouverture, elle, génère l’identité manquante');
    assert.deepEqual(await fs.readFile(snapshotPath), bytesBefore, 'même l’ouverture ne réécrit pas le fichier');
  });
});

test('snapshots et backups reçoivent les refus de format d’une ouverture explicite', async () => {
  await withHarness(async (harness) => {
    const { snapshotPath } = await sessionDir(harness);
    const backupPath = `${await harness.mkdirp('workspace/sauvegardes/versions-securite')}/conte.2026-09-08.mbah`;
    const refusals = [
      ['{"schemaVersion":4,"authoringMode":"advanced","projectType":"advanced","rootEntries":[]}', 'CONTRADICTORY_PROJECT_ENVELOPE'],
      ['{"schemaVersion":5,"authoringMode":"free","rootEntries":[]}', 'UNSUPPORTED_SCHEMA_VERSION'],
      ['{"schemaVersion":4,"rootEntries":[]}', 'MISSING_AUTHORING_MODE'],
      ['{"projectName":"conte","authoring":{"payload":"{}"}}', 'CONTRADICTORY_PROJECT_ENVELOPE'],
      ['{"projectName":', 'INVALID_PROJECT_JSON'],
    ];
    for (const [contents, code] of refusals) {
      for (const path of [snapshotPath, backupPath]) {
        await fs.writeFile(path, contents);
        const bytesBefore = await fs.readFile(path);
        for (const call of [() => io.previewProjectFromPath(path), () => io.loadProjectFromPath(path)]) {
          await assert.rejects(call, (error) => {
            assert.equal(error.code, code, contents);
            assert.ok(error.message.includes(path.split('/').pop()), 'le refus nomme le fichier');
            return true;
          });
        }
        assert.deepEqual(await fs.readFile(path), bytesBefore, 'un refus ne réécrit rien');
      }
    }
  });
});

// ── Concurrence et échecs ────────────────────────────────────────────────────
//
// Le filet anti-crash de `useWorkSession` enchaîne exactement ces appels :
// `beginEphemeralSnapshotSeed`, l'écriture, puis `acceptEphemeralSnapshotSeed`
// avec le mode et le chemin **du moment**. Seule la boucle React est remplacée
// par des variables ; les décisions et l'écriture sont la production.

test('une écriture de la session A terminée après l’activation de B ne marque ni ne touche B', async () => {
  await withHarness(async (harness) => {
    const a = await sessionDir(harness, 'session-a');
    const b = await sessionDir(harness, 'session-b');
    const state = createEphemeralSnapshotSeedState();

    const projectA = advancedProject({ projectName: 'session-a' });
    const snapshotA = createWorkSnapshot(projectA, [], {});
    const write = beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral',
      path: a.snapshotPath,
      snapshot: snapshotA,
    });
    assert.ok(write);

    // B devient la session courante pendant que l'écriture de A est en vol.
    resetEphemeralSnapshotSeedState(state);
    const projectB = advancedProject({ projectName: 'session-b' });
    await io.autoSaveEphemeralProject(projectB, b.dir, b.snapshotPath);
    const bytesB = await fs.readFile(b.snapshotPath);

    // L'écriture de A se termine : son fichier lui appartient, mais elle ne
    // publie rien sur l'état courant.
    await io.autoSaveEphemeralProject(projectA, a.dir, a.snapshotPath);
    const accepted = acceptEphemeralSnapshotSeed(state, write, {
      sessionMode: 'ephemeral',
      path: b.snapshotPath,
    });
    finishEphemeralSnapshotSeed(state, write);

    assert.equal(accepted, false, 'l’écriture périmée n’est pas acceptée');
    assert.equal(state.seeded, false);
    assert.equal(state.savedSnapshot, null, 'B n’est pas marquée enregistrée');
    assert.deepEqual(await fs.readFile(b.snapshotPath), bytesB, 'les fichiers de B sont intacts');
    assert.equal(await harness.exists(b.dir), true, 'le dossier de B n’est pas nettoyé');
    assert.equal((await readJson(a.snapshotPath)).projectName, 'session-a');

    // Et le travail de B reste sale : rien ne l’a déclaré enregistré.
    const mutatedB = advancedProject({ projectName: 'session-b', editorState: { version: 1, viewport: { x: 12 } } });
    assert.notEqual(createWorkSnapshot(mutatedB, [], {}), state.savedSnapshot);
    assert.ok(beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral',
      path: b.snapshotPath,
      snapshot: createWorkSnapshot(mutatedB, [], {}),
    }), 'une mutation plus récente reste à écrire');
  });
});

test('une mutation survenue pendant l’écriture attend son tour, puis devient la référence', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    const state = createEphemeralSnapshotSeedState();
    const first = advancedProject({ projectName: 'v1' });
    const second = advancedProject({ projectName: 'v1', editorState: { version: 1, viewport: { x: 42 } } });
    const firstSnapshot = createWorkSnapshot(first, [], {});
    const secondSnapshot = createWorkSnapshot(second, [], {});

    const inFlight = beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral', path: snapshotPath, snapshot: firstSnapshot,
    });
    assert.equal(
      beginEphemeralSnapshotSeed(state, { sessionMode: 'ephemeral', path: snapshotPath, snapshot: secondSnapshot }),
      null,
      'une seule écriture en vol à la fois',
    );
    await io.autoSaveEphemeralProject(first, dir, snapshotPath);
    acceptEphemeralSnapshotSeed(state, inFlight, { sessionMode: 'ephemeral', path: snapshotPath });
    finishEphemeralSnapshotSeed(state, inFlight);
    assert.equal(state.savedSnapshot, firstSnapshot);

    const retry = beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral', path: snapshotPath, snapshot: secondSnapshot,
    });
    assert.ok(retry, 'la mutation plus récente est reprise après la fin de l’écriture');
    await io.autoSaveEphemeralProject(second, dir, snapshotPath);
    acceptEphemeralSnapshotSeed(state, retry, { sessionMode: 'ephemeral', path: snapshotPath });
    finishEphemeralSnapshotSeed(state, retry);

    assert.equal(state.savedSnapshot, secondSnapshot);
    assert.equal((await readJson(snapshotPath)).authoring.editorState.viewport.x, 42);
  });
});

test('un échec d’écriture laisse le snapshot précédent lisible, sans artefact ni marquage', async () => {
  await withHarness(async (harness) => {
    const { dir, snapshotPath } = await sessionDir(harness);
    const state = createEphemeralSnapshotSeedState();
    const first = advancedProject({ projectName: 'v1' });
    const seeded = beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral', path: snapshotPath, snapshot: createWorkSnapshot(first, [], {}),
    });
    await io.autoSaveEphemeralProject(first, dir, snapshotPath);
    acceptEphemeralSnapshotSeed(state, seeded, { sessionMode: 'ephemeral', path: snapshotPath });
    finishEphemeralSnapshotSeed(state, seeded);
    const bytesBefore = await fs.readFile(snapshotPath);

    const second = advancedProject({ projectName: 'v2' });
    const write = beginEphemeralSnapshotSeed(state, {
      sessionMode: 'ephemeral', path: snapshotPath, snapshot: createWorkSnapshot(second, [], {}),
    });
    harness.injectFailure({ cmd: 'plugin:fs|write_text_file', match: '.session-recovery', message: 'disque plein' });
    await assert.rejects(() => io.autoSaveEphemeralProject(second, dir, snapshotPath), /disque plein/);
    finishEphemeralSnapshotSeed(state, write);

    assert.deepEqual(await fs.readFile(snapshotPath), bytesBefore, 'le snapshot précédent est intact');
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.includes('.tmp-')),
      [],
      'aucun temporaire laissé à côté du snapshot',
    );
    assert.equal(state.savedSnapshot, createWorkSnapshot(first, [], {}), 'l’état v2 n’est pas marqué écrit');
    assert.equal(state.inFlight, null, 'l’écriture échouée est relâchée, une reprise est possible');
    // La reprise réussit et devient la nouvelle référence.
    await io.autoSaveEphemeralProject(second, dir, snapshotPath);
    assert.equal((await readJson(snapshotPath)).projectName, 'v2');
  });
});

// ── Promotion : nettoyage seulement quand la session n’est plus une dépendance ─

test('une liaison avancée restée dans la session est une dépendance vivante ; copiée, elle ne l’est plus', async () => {
  await withHarness(async (harness) => {
    const { dir } = await sessionDir(harness);
    const projectDir = await harness.mkdirp('projet');
    const savePath = `${projectDir}/promu.mbah`;
    const audio = await harness.writeFile('session/fichiers-importes/a1b2c3.mp3', 'audio');
    const project = advancedProject({
      projectName: 'promu',
      bindings: [{ assetRef: 'a1b2c3.mp3', path: audio, status: 'resolved' }],
    });

    const before = await io.collectLiveSessionDependencies(project, dir);
    assert.deepEqual(before.map((entry) => entry.path), [audio]);
    assert.equal(before[0].label, 'Média avancé: a1b2c3.mp3');

    const transfer = await io.transferProjectFilesToProject(project, savePath, async (source) => {
      const target = `${projectDir}/${source.split('/').pop()}`;
      await fs.copyFile(source, target);
      return target;
    });
    assert.deepEqual(transfer.errors, []);
    assert.equal(transfer.copiedCount, 1);
    assert.equal(transfer.project.authoring.mediaBindings[0].status, 'resolved');
    assert.equal(transfer.project.authoring.mediaBindings[0].assetRef, 'a1b2c3.mp3', 'la référence du dialecte n’est pas réécrite');

    const after = await io.collectLiveSessionDependencies(transfer.project, dir);
    assert.deepEqual(after, [], 'plus rien du projet enregistré ne vit dans la session');
    // Le fichier copié est lisible sans le dossier éphémère.
    await fs.rm(dir, { recursive: true, force: true });
    assert.equal(await fs.readFile(transfer.project.authoring.mediaBindings[0].path, 'utf8'), 'audio');
  });
});

test('un transfert échoué conserve la liaison, sa dépendance de session et interdit la promotion', async () => {
  await withHarness(async (harness) => {
    const { dir } = await sessionDir(harness);
    const projectDir = await harness.mkdirp('projet');
    const savePath = `${projectDir}/promu.mbah`;
    const audio = await harness.writeFile('session/fichiers-importes/a1b2c3.mp3', 'audio');
    const project = advancedProject({
      bindings: [{ assetRef: 'a1b2c3.mp3', path: audio, status: 'resolved' }],
    });

    const transfer = await io.transferProjectFilesToProject(project, savePath, async () => {
      throw new Error('disque plein');
    });
    assert.equal(transfer.errors.length, 1);
    assert.equal(transfer.project.authoring.mediaBindings[0].path, audio, 'la liaison garde son dernier chemin connu');
    assert.equal(
      shouldAbortEphemeralPromotion({ isEphemeralSession: true, transferErrors: transfer.errors }),
      true,
    );
    const pending = await io.collectLiveSessionDependencies(transfer.project, dir);
    assert.deepEqual(pending.map((entry) => entry.path), [audio], 'la session reste indispensable');
  });
});

test('une dépendance déjà disparue du disque ne retient pas la session', async () => {
  await withHarness(async (harness) => {
    const { dir } = await sessionDir(harness);
    const missing = `${dir}/fichiers-importes/perdu.mp3`;
    const project = advancedProject({
      bindings: [{ assetRef: 'perdu.mp3', path: missing, status: 'missing' }],
    });
    assert.deepEqual(
      collectSessionBoundReferences({ project, sessionDir: dir }).map((entry) => entry.path),
      [missing],
      'la liaison pointe bien dans la session',
    );
    assert.deepEqual(
      await io.collectLiveSessionDependencies(project, dir),
      [],
      'un média manquant n’a jamais bloqué un enregistrement, il ne bloque pas le nettoyage',
    );
  });
});

test('le tri du catalogue voit les liaisons avancées et conserve tags et chemins repointés', () => {
  const dir = '/tmp/story_studio_session_1_2';
  const bound = `${dir}/fichiers-importes/a1b2c3.mp3`;
  const orphan = `${dir}/voix-generees/variante.wav`;
  const project = advancedProject({
    bindings: [{ assetRef: 'a1b2c3.mp3', path: bound, status: 'resolved' }],
  });

  const orphans = collectSessionOnlyMedia({
    project,
    mediaLibraryPaths: [bound, orphan],
    mediaTags: { [orphan]: ['essai'] },
    sessionDir: dir,
  });
  assert.deepEqual(orphans.map((item) => item.path), [orphan], 'un média lié n’est pas un orphelin');

  const kept = '/home/user/story-studio/fichiers-importes/variante.wav';
  const next = applySessionMediaTriage({
    mediaLibraryPaths: [bound, orphan],
    mediaTags: { [orphan]: ['essai'] },
    replacements: new Map([[orphan.toLowerCase(), kept], [bound.toLowerCase(), '/home/user/projet/a1b2c3.mp3']]),
    droppedPaths: [],
  });
  assert.deepEqual(next.mediaLibraryPaths, ['/home/user/projet/a1b2c3.mp3', kept]);
  assert.deepEqual(next.mediaTags[kept], ['essai']);
});
