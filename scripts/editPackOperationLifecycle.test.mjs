import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditPackOperationLifecycle,
  editorChooserFor,
  runEditPackBundleChildOperation,
  runEditPackImportOperation,
} from '../src/components/EditPack/editPackOperationLifecycle.js';

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, reject, resolve };
}

test('un démontage pendant conversion interdit classification et atterrissage', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  lifecycle.invalidate();
  assert.equal(lifecycle.isCurrent(token), false);
  assert.equal(lifecycle.claimCompletion(token), false);
});

test('une invalidation pendant classification interdit onLand', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  assert.equal(lifecycle.isCurrent(token), true);
  lifecycle.invalidate();
  assert.equal(lifecycle.claimCompletion(token), false);
});

test('double lancement refusé et succès courant réclamé une seule fois', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  assert.equal(lifecycle.begin(), null);
  assert.equal(lifecycle.claimCompletion(token), true);
  assert.equal(lifecycle.claimCompletion(token), false);
  assert.equal(lifecycle.finish(token), true);
  assert.equal(lifecycle.isRunning(), false);
});

test('une nouvelle ouverture ne reconnaît aucun jeton antérieur', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const oldToken = lifecycle.begin();
  lifecycle.invalidate();
  const nextToken = lifecycle.begin();
  assert.notEqual(nextToken, oldToken);
  assert.equal(lifecycle.isCurrent(oldToken), false);
  assert.equal(lifecycle.isCurrent(nextToken), true);
});

test('un résultat de sélecteur arrivé après fermeture ne peut pas démarrer une opération', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const pickerSession = lifecycle.captureSession();
  lifecycle.deactivate();
  assert.equal(lifecycle.isSessionCurrent(pickerSession), false);
  assert.equal(lifecycle.begin(), null);

  lifecycle.activate();
  assert.equal(lifecycle.isSessionCurrent(pickerSession), false);
  assert.notEqual(lifecycle.captureSession(), pickerSession);
});

test('une opération demandée sur un funnel désactivé ne produit aucun effet', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  lifecycle.deactivate();
  let calls = 0;
  const result = await runEditPackImportOperation({
    lifecycle,
    path: 'late-folder',
    isFolder: true,
    convertFolder: async () => { calls += 1; return 'pack.zip'; },
    classify: async () => { calls += 1; return { authoringEditable: true }; },
    land: async () => { calls += 1; },
  });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(calls, 0);
});

test('démontage pendant conversion: classification et onLand ne sont jamais appelés', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const conversion = controlledPromise();
  let classifications = 0;
  let landings = 0;
  const running = runEditPackImportOperation({
    lifecycle,
    path: 'pack-folder',
    isFolder: true,
    convertFolder: () => conversion.promise,
    classify: async () => { classifications += 1; return { authoringEditable: true }; },
    land: async () => { landings += 1; },
  });
  lifecycle.invalidate();
  conversion.resolve('pack.zip');
  assert.deepEqual(await running, { status: 'cancelled' });
  assert.equal(classifications, 0);
  assert.equal(landings, 0);
});

test('démontage pendant classification: onLand reste interdit', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const classification = controlledPromise();
  let landings = 0;
  const running = runEditPackImportOperation({
    lifecycle,
    path: 'pack.zip',
    isFolder: false,
    convertFolder: async () => assert.fail('conversion should not run'),
    classify: () => classification.promise,
    land: async () => { landings += 1; },
  });
  await Promise.resolve();
  lifecycle.invalidate();
  classification.resolve({ authoringEditable: true });
  assert.deepEqual(await running, { status: 'cancelled' });
  assert.equal(landings, 0);
});

test('succès normal appelle onLand exactement une fois', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  let landings = 0;
  const result = await runEditPackImportOperation({
    lifecycle,
    path: 'pack.zip',
    isFolder: false,
    convertFolder: async () => assert.fail('conversion should not run'),
    classify: async () => ({ authoringEditable: true }),
    land: async () => { landings += 1; },
  });
  assert.equal(result.status, 'landed');
  assert.equal(landings, 1);
  assert.equal(lifecycle.isRunning(), false);
});

// --- Archives enveloppes -----------------------------------------------------

const DIRECT = { kind: 'direct', containerFingerprint: 'f'.repeat(64), children: [] };

function bundleOf(children) {
  return { kind: 'bundle', containerFingerprint: 'e'.repeat(64), children };
}

test('un pack direct traverse l\'inspection sans changer de parcours', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const classified = [];
  const landed = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion de dossier attendue'),
    inspect: async () => DIRECT,
    classify: async (zipPath) => { classified.push(zipPath); return { authoringEditable: true }; },
    land: async (zipPath) => { landed.push(zipPath); },
  });
  assert.equal(result.status, 'landed');
  assert.deepEqual(classified, ['/packs/histoire.zip']);
  assert.deepEqual(landed, ['/packs/histoire.zip']);
});

test('sans inspection branchée, le parcours est exactement celui d\'avant', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const landed = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion de dossier attendue'),
    classify: async () => ({ authoringEditable: true }),
    land: async (zipPath) => { landed.push(zipPath); },
  });
  assert.equal(result.status, 'landed');
  assert.deepEqual(landed, ['/packs/histoire.zip']);
});

test('une enveloppe interrompt l\'import et rend son inventaire, sans rien classer', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const inspection = bundleOf([{ childId: 'a', displayName: 'Un', selectable: true }]);
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/enveloppe.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion de dossier attendue'),
    inspect: async () => inspection,
    classify: () => assert.fail('aucune classification avant le choix de l\'auteur'),
    land: () => assert.fail('aucun atterrissage avant le choix de l\'auteur'),
  });
  assert.equal(result.status, 'bundle');
  assert.equal(result.containerPath, '/packs/enveloppe.zip');
  assert.equal(result.inspection, inspection);
  assert.equal(lifecycle.isRunning(), false, 'l\'écran de choix n\'occupe pas l\'opération');
});

test('un dossier n\'est jamais inspecté comme une enveloppe', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/dossier',
    isFolder: true,
    convertFolder: async () => '/cache/converti.zip',
    inspect: () => assert.fail('un dossier porte un pack ou rien'),
    classify: async () => ({ authoringEditable: true }),
    land: async () => {},
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.zipPath, '/cache/converti.zip');
});

test('une inspection revenue après fermeture n\'ouvre aucun écran de choix', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const gate = controlledPromise();
  const pending = runEditPackImportOperation({
    lifecycle,
    path: '/packs/enveloppe.zip',
    isFolder: false,
    convertFolder: async () => assert.fail('aucune conversion'),
    inspect: () => gate.promise,
    classify: () => assert.fail('aucune classification'),
    land: () => assert.fail('aucun atterrissage'),
  });
  lifecycle.deactivate();
  gate.resolve(bundleOf([{ childId: 'a', selectable: true }]));
  assert.equal((await pending).status, 'cancelled');
});

test('l\'enfant choisi est extrait puis reprend le parcours d\'un pack normal', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const asked = [];
  const landed = [];
  const result = await runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: async (request) => { asked.push(request); return '/cache/enfant.zip'; },
    classify: async () => ({ authoringEditable: true }),
    land: async (zipPath) => { landed.push(zipPath); },
  });
  assert.equal(result.status, 'landed');
  assert.deepEqual(asked, [{
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
  }]);
  assert.deepEqual(landed, ['/cache/enfant.zip']);
});

test('un enfant non éditable rend son verdict sans atterrir, comme un pack fourni seul', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const report = { authoringEditable: false, readOnlyInspectable: true, reason: 'non fidèle' };
  const result = await runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: async () => '/cache/enfant.zip',
    classify: async () => report,
    land: () => assert.fail('aucun atterrissage pour un pack non éditable'),
  });
  assert.equal(result.status, 'classified');
  assert.equal(result.report, report);
  assert.equal(result.zipPath, '/cache/enfant.zip');
});

test('un pack compatible avec les deux éditeurs demande le choix après classement', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const events = [];
  const advanced = [];
  const result = await runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: async () => '/cache/enfant.zip',
    classify: async () => { events.push('classified'); return { authoringEditable: true }; },
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: async (zipPath) => { advanced.push(zipPath); },
    chooseEditor: async () => { events.push('chosen'); return 'advanced'; },
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.advanced, true);
  assert.deepEqual(events, ['classified', 'chosen']);
  assert.deepEqual(advanced, ['/cache/enfant.zip']);
});

test('un pack non fidèle au Libre ouvre le Graphe sans demander de choix', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const report = { authoringEditable: false, readOnlyInspectable: true, reason: 'non fidèle' };
  const advanced = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => report,
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: async (zipPath) => { advanced.push(zipPath); },
    chooseEditor: () => assert.fail('aucun choix quand seul le Graphe convient'),
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.advanced, true);
  assert.equal(result.report, report);
  assert.deepEqual(advanced, ['/packs/histoire.zip']);
});

test('annuler le choix des éditeurs rend la main au funnel sans atterrissage', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => ({ authoringEditable: true }),
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: () => assert.fail('atterrissage Graphe inattendu'),
    chooseEditor: async () => null,
  });
  assert.equal(result.status, 'choice-cancelled');
  assert.equal(lifecycle.isRunning(), false);
});

test('annuler la garde de sauvegarde conserve le projet courant sans atterrissage', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const events = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => ({ authoringEditable: true }),
    chooseEditor: async () => { events.push('editor'); return 'free'; },
    beforeReplace: async () => { events.push('guard'); return false; },
    land: () => assert.fail('aucun atterrissage après annulation'),
    landAdvanced: () => assert.fail('aucun atterrissage Graphe'),
  });
  assert.equal(result.status, 'choice-cancelled');
  assert.deepEqual(events, ['editor', 'guard']);
  assert.equal(lifecycle.isRunning(), false);
});

test('un échec du Graphe conserve le verdict nécessaire à la simulation', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const report = { authoringEditable: false, readOnlyInspectable: true, reason: 'non fidèle' };
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => report,
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: async () => { throw new Error('dialecte inconnu'); },
  });
  assert.equal(result.status, 'classified');
  assert.equal(result.report, report);
  assert.match(result.advancedError.message, /dialecte inconnu/);
  assert.equal(lifecycle.isRunning(), false);
});

test('une extraction d\'enfant échouée reste une erreur exploitable, sans atterrissage', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const result = await runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: async () => { throw new Error('Cette archive a changé depuis'); },
    classify: () => assert.fail('aucune classification après un échec d\'extraction'),
    land: () => assert.fail('aucun atterrissage après un échec d\'extraction'),
  });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /a changé depuis/);
  assert.equal(lifecycle.isRunning(), false);
});

test('un enfant extrait après fermeture n\'atterrit nulle part', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const gate = controlledPromise();
  const pending = runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: () => gate.promise,
    classify: () => assert.fail('aucune classification après fermeture'),
    land: () => assert.fail('aucun atterrissage après fermeture'),
  });
  lifecycle.deactivate();
  gate.resolve('/cache/enfant.zip');
  assert.equal((await pending).status, 'cancelled');
});

test('depuis le graphe, un pack compatible avec les deux éditeurs s’ouvre dans le graphe sans question', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const advanced = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => ({ authoringEditable: true }),
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: async (zipPath) => { advanced.push(zipPath); },
    chooseEditor: editorChooserFor({
      openedFromGraph: true,
      askEditor: () => assert.fail('aucune question depuis le graphe'),
    }),
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.advanced, true);
  assert.deepEqual(advanced, ['/packs/histoire.zip']);
});

test('depuis le graphe, un enfant d’enveloppe compatible s’ouvre aussi dans le graphe sans question', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const advanced = [];
  const result = await runEditPackBundleChildOperation({
    lifecycle,
    containerPath: '/packs/enveloppe.zip',
    containerFingerprint: 'e'.repeat(64),
    childId: 'c'.repeat(64),
    extractChild: async () => '/cache/enfant.zip',
    classify: async () => ({ authoringEditable: true }),
    land: () => assert.fail('atterrissage Libre inattendu'),
    landAdvanced: async (zipPath) => { advanced.push(zipPath); },
    chooseEditor: editorChooserFor({
      openedFromGraph: true,
      askEditor: () => assert.fail('aucune question depuis le graphe'),
    }),
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.advanced, true);
  assert.deepEqual(advanced, ['/cache/enfant.zip']);
});

test('depuis l’éditeur par menus ou l’accueil, le choix de l’éditeur reste proposé', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const events = [];
  const landed = [];
  const result = await runEditPackImportOperation({
    lifecycle,
    path: '/packs/histoire.zip',
    isFolder: false,
    convertFolder: () => assert.fail('aucune conversion'),
    classify: async () => ({ authoringEditable: true }),
    land: async (zipPath) => { landed.push(zipPath); },
    landAdvanced: () => assert.fail('atterrissage Graphe inattendu'),
    chooseEditor: editorChooserFor({
      openedFromGraph: false,
      askEditor: async () => { events.push('asked'); return 'free'; },
    }),
  });
  assert.equal(result.status, 'landed');
  assert.equal(result.advanced, false);
  assert.deepEqual(events, ['asked']);
  assert.deepEqual(landed, ['/packs/histoire.zip']);
});
