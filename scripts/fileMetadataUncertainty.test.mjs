// Régression E2E-import-001, sans corpus : vrais fichiers synthétiques, seuls
// le transport Tauri et l'ordonnanceur React sont doublés.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate as immediate, setTimeout as realWait } from 'node:timers/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import i18next from 'i18next';

// Observation des tables privées pour le test de rétention, sans API de test
// dans le produit. Le chargeur n'altère aucune règle métier.
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/src/store/fileMetadataCache.js')) return result;
  const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
  return { ...result, source: `${source}\nexport const __cacheSizesForTest = () => ({ reads: (typeof inflightPathSnapshots === 'undefined' ? pathSnapshotReads : inflightPathSnapshots).size, snapshots: pathSnapshotCache.size });\n` };
} });

// Permet de rejouer exactement le test 4,2 s avec le cache extrait par
// `git show`, sans modifier l'arbre de travail ni fabriquer une fixture depuis
// l'implémentation corrigée. Les autres modules restent ceux du dépôt.
if (process.env.IMPORT001_ORIGINAL_CACHE) {
  registerHooks({ load(url, context, next) {
    if (!url.endsWith('/fileMetadataCache.js?original-regression')) return next(url, context);
    return { format: 'module', source: fs.readFileSync(process.env.IMPORT001_ORIGINAL_CACHE, 'utf8'), shortCircuit: true };
  } });
}
const cache = await import(process.env.IMPORT001_ORIGINAL_CACHE
  ? '../src/store/fileMetadataCache.js?original-regression'
  : '../src/store/fileMetadataCache.js');
const { readPathSnapshot, hasFreshPathSnapshot, notifyFileChanged } = cache;
const { resolveMediaBindingStatuses } = await import('../src/store/projectModel/mediaBindings.js');
const { normalizeProjectData } = await import('../src/store/projectModel/schema.js');
const { mediaBlockage, runAdvancedProduction } = await import('../src/store/production/advancedProduction.js');
const { verifyMenuProduction } = await import('../src/store/production/mediaVerification.js');
const { EXPORT_REFUSAL } = await import('../src/store/advancedExport/exportOutcome.js');
const { useProjectFileAudit } = await import('../src/hooks/useProjectFileAudit.js');
const { useAdvancedBindingAudit } = await import('../src/hooks/useAdvancedBindingAudit.js');
const { useLocalFile } = await import('../src/hooks/useLocalFile.js');
const { usePackGeneration } = await import('../src/hooks/usePackGeneration.js');
const { loadProjectFromPath, consolidateProject } = await import('../src/store/projectIO.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { presentProduction } = await import('../src/i18n/productionPresentation.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';
const graph = (path, status = 'resolved') => ({
  schemaVersion: 4, authoringMode: 'advanced', projectType: 'advanced', rootEntries: [],
  authoring: { payload: PAYLOAD, editorState: { version: 1 }, mediaBindings: [{ assetRef: 'clip.wav', path, status }] },
});
const present = (path) => fs.existsSync(path);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle() { for (let index = 0; index < 12; index++) await immediate(); }
async function until(predicate) {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt++) await realWait(2);
  assert.ok(predicate(), 'le transport attendu a commencé');
}

async function diskFor(t, commands = {}) {
  let exists = present;
  const disk = await createDiskHarness({ commands: {
    'plugin:fs|exists': ({ path }) => exists(path),
    'plugin:fs|stat': ({ path }) => ({ ...fs.statSync(path), mtime: null, atime: null, birthtime: null }),
    validate_advanced_payload: () => ({}),
    ...commands,
  } });
  const target = new EventTarget();
  window.addEventListener = target.addEventListener.bind(target);
  window.removeEventListener = target.removeEventListener.bind(target);
  window.dispatchEvent = target.dispatchEvent.bind(target);
  window.setTimeout = setTimeout;
  t.after(() => disk.dispose());
  const clip = await disk.writeFile('project/fichiers-importes/clip.wav', 'synthetic audio');
  return { disk, clip, transport(fn) { exists = fn; } };
}

async function produce(project, fileAudit = {}) {
  const trace = [];
  const result = await runAdvancedProduction({
    readProject: () => project,
    assessReadiness: async () => ({ blocked: false }),
    readReferencedMedia: async () => ['clip.wav'],
    fileAudit,
    chooseFolder: async () => { trace.push('folder'); return '/output'; },
    start: async () => { trace.push('start'); return 'job'; },
    refuse: () => trace.push('refuse'),
  });
  return { ...result, trace };
}

test('4,2 s : une réponse positive tardive ne devient jamais missing/not-found et la production démarre', async (t) => {
  const h = await diskFor(t);
  h.transport(async (path) => {
    const result = present(path);
    await wait(4200);
    return result;
  });
  const snapshot = await readPathSnapshot(h.clip);
  // Cette assertion échoue sur 0794bf3d après 4 s (exists vaut false).
  assert.notEqual(snapshot.exists, false, 'un délai IPC ne prouve pas une absence');
  assert.equal(snapshot.exists, null);
  assert.equal(hasFreshPathSnapshot(h.clip, 60_000), false, 'aucun constat indéterminé en cache');
  const audit = { [h.clip]: snapshot.exists };
  const requalified = resolveMediaBindingStatuses(graph(h.clip), audit);
  assert.equal(requalified.authoring.mediaBindings[0].status, 'resolved');
  assert.equal(mediaBlockage(requalified, ['clip.wav']), null);
  const result = await produce(requalified, audit);
  assert.equal(result.outcome, 'started');
  assert.deepEqual(result.trace, ['folder', 'start']);
});

test('la production revérifie sans cache les seules références suspectes et lève un ancien faux négatif', async (t) => {
  const h = await diskFor(t);
  h.transport(() => false);
  assert.equal((await readPathSnapshot(h.clip)).exists, false);
  h.transport(present);
  const project = graph(h.clip, 'missing');
  project.authoring.mediaBindings.push({ assetRef: 'unused.wav', path: '/unused.wav', status: 'missing' });
  const before = h.disk.countCalls('plugin:fs|exists');
  const result = await produce(project);
  assert.equal(result.outcome, 'started');
  assert.equal(h.disk.countCalls('plugin:fs|exists') - before, 1);
  assert.equal(project.authoring.mediaBindings[0].status, 'missing', 'la porte ne mute pas le projet');
});

test('un vrai false natif refuse toujours avec la bonne référence, même face à un cache positif', async (t) => {
  const h = await diskFor(t);
  assert.equal((await readPathSnapshot(h.clip)).exists, true);
  fs.unlinkSync(h.clip);
  const result = await produce(graph(h.clip, 'missing'));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal.kind, EXPORT_REFUSAL.MEDIA_UNAVAILABLE);
  assert.deepEqual(result.refusal.entries, [{
    assetRef: 'clip.wav', cause: 'not-found', lastKnownPath: h.clip, stageIds: [],
  }]);
  assert.deepEqual(result.trace, ['refuse']);
});

test('une erreur de transport persistante ne se cache pas et refuse comme vérification impossible dans les deux éditeurs', async (t) => {
  const h = await diskFor(t);
  h.transport(() => { throw new Error('IPC unavailable'); });
  assert.equal((await readPathSnapshot(h.clip)).exists, null);
  assert.equal(hasFreshPathSnapshot(h.clip, 60_000), false);
  const before = h.disk.countCalls('plugin:fs|exists');
  assert.equal((await readPathSnapshot(h.clip, { maxAgeMs: 60_000 })).exists, null);
  assert.equal(h.disk.countCalls('plugin:fs|exists') - before, 1);
  const result = await produce(graph(h.clip), { [h.clip]: null });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal.kind, EXPORT_REFUSAL.REQUEST);
  assert.equal(result.refusal.title, 'Vérification impossible');
  assert.match(result.refusal.message, /Réessayez/);
  assert.deepEqual(result.refusal.entries, []);
  assert.deepEqual(result.trace, ['refuse']);

  const dialogs = []; const jobs = [];
  const menu = menuProject(h.clip);
  const hook = runner(() => usePackGeneration({
    store: { project: menu, savePath: null },
    pathAudit: { [menu.rootAudio]: null }, pathAuditPending: false,
    importedPackPendingMetaRef: { current: false }, workspaceDirRef: { current: '' },
    renderQueue: { addJob: (job) => jobs.push(job) },
    showErrorDialog: (dialog) => dialogs.push(dialog),
  }));
  t.after(() => hook.unmount());
  await hook.render().handleGenerate(null, { skipMetadata: true });
  assert.equal(dialogs.length, 1);
  assert.equal(presentProduction(dialogs[0].title), 'Vérification impossible');
  assert.match(presentProduction(dialogs[0].message), /Réessayez/);
  assert.deepEqual(jobs, []);
});

test('un transport qui ne répond jamais borne la porte de production à 12 secondes', async (t) => {
  const h = await diskFor(t);
  h.transport(() => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = produce(graph(h.clip), { [h.clip]: null });
  await settle();
  let finished = false;
  pending.then(() => { finished = true; });
  t.mock.timers.tick(11999);
  await settle();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.refusal.kind, EXPORT_REFUSAL.REQUEST);
  assert.equal(result.refusal.title, 'Vérification impossible');
});

test('une réponse ancienne ne remplace pas une lecture forcée plus récente', async (t) => {
  const h = await diskFor(t);
  let finishOld;
  h.transport(() => new Promise((resolve) => { finishOld = resolve; }));
  const old = readPathSnapshot(h.clip);
  h.transport(() => false);
  assert.equal((await readPathSnapshot(h.clip, { force: true })).exists, false);
  finishOld(true);
  await old;
  assert.equal((await readPathSnapshot(h.clip, { maxAgeMs: 60_000 })).exists, false);
});

test('une réponse positive après expiration ne remplace pas le nouveau constat négatif', async (t) => {
  const h = await diskFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishOld;
  h.transport(() => new Promise((resolve) => { finishOld = resolve; }));
  const old = readPathSnapshot(h.clip);
  t.mock.timers.tick(4000);
  assert.equal((await old).exists, null);
  h.transport(() => false);
  assert.equal((await readPathSnapshot(h.clip)).exists, false);
  finishOld(true);
  await settle();
  assert.equal((await readPathSnapshot(h.clip, { maxAgeMs: 60_000 })).exists, false);
});

test('une invalidation empêche aussi une ancienne requête de repeupler le cache', async (t) => {
  const h = await diskFor(t);
  let finishOld;
  h.transport(() => new Promise((resolve) => { finishOld = resolve; }));
  const old = readPathSnapshot(h.clip);
  notifyFileChanged(h.clip);
  h.transport(() => false);
  await readPathSnapshot(h.clip);
  finishOld(true);
  await old;
  assert.equal((await readPathSnapshot(h.clip, { maxAgeMs: 60_000 })).exists, false);
});

test('l’audit publie l’indéterminé, conserve la liaison et relance sans événement focus', async (t) => {
  const h = await diskFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.transport(() => { throw new Error('IPC temporary failure'); });
  let project = graph(h.clip);
  const audit = runner(() => useProjectFileAudit(project));
  t.after(() => audit.unmount());
  audit.render(); audit.flush(); await settle();
  const unknown = audit.render();
  assert.equal(unknown.pending, false);
  assert.equal(unknown.statusByPath[h.clip], null);
  const bindingAudit = runner(() => useAdvancedBindingAudit({
    project, ...unknown, syncProjectWithoutHistory: (next) => { project = next; },
  }));
  t.after(() => bindingAudit.unmount());
  bindingAudit.render(); bindingAudit.flush();
  assert.equal(project.authoring.mediaBindings[0].status, 'resolved');
  h.transport(present);
  t.mock.timers.tick(1500);
  await settle();
  assert.equal(audit.render().statusByPath[h.clip], true);
});


function menuProject(path) {
  return normalizeProjectData({
    projectType: 'pack', rootAudio: path, rootImage: path,
    rootEntries: [{ id: 'story', type: 'story', name: 'Synthetic story', audio: path, itemAudio: path, itemImage: path }],
  });
}

test('menus : ancien false et indéterminé sont revérifiés ; un vrai absent garde son libellé', async (t) => {
  const h = await diskFor(t);
  const project = menuProject(h.clip);
  const auditedPath = project.rootEntries[0].audio;
  for (const status of [false, null]) {
    const result = await verifyMenuProduction(project, { [auditedPath]: status });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.unverifiedPaths, []);
  }
  h.transport(() => false);
  const result = await verifyMenuProduction(project, { [auditedPath]: false });
  assert.ok(result.errors.length > 0);
  assert.match(result.errors.join('\n'), /Synthetic story/);
  assert.deepEqual(result.unverifiedPaths, []);
  const before = h.disk.countCalls('plugin:fs|exists');
  assert.deepEqual((await verifyMenuProduction(project, { '/unused': null })).errors, []);
  assert.equal(h.disk.countCalls('plugin:fs|exists'), before, 'les médias inutilisés ne sont pas sondés');
});

test('menus : une revérification positive atteint réellement la file de production', async (t) => {
  const h = await diskFor(t);
  const dialogs = []; const jobs = [];
  const menu = menuProject(h.clip);
  h.disk.answerOpen('/output');
  const hook = runner(() => usePackGeneration({
    store: { project: menu, savePath: null },
    pathAudit: { [menu.rootAudio]: false }, pathAuditPending: false,
    importedPackPendingMetaRef: { current: false }, workspaceDirRef: { current: '' },
    renderQueue: { addJob: (job) => jobs.push(job) },
    showErrorDialog: (dialog) => dialogs.push(dialog),
  }));
  t.after(() => hook.unmount());
  await hook.render().handleGenerate(null, { skipMetadata: true });
  assert.deepEqual(dialogs, []);
  assert.equal(jobs.length, 1);
});

test('réouverture projectIO : délai et rejet ne déplacent pas la liaison vers un homonyme du workspace', async (t) => {
  const h = await diskFor(t);
  const duplicate = await h.disk.writeFile('workspace/fichiers-importes/clip.wav', 'workspace homonym');
  h.disk.settings.setItem(KEYS.WORKSPACE_DIR, h.disk.workspace);
  const saved = await h.disk.writeFile('project/graph.mbah', JSON.stringify(graph('./fichiers-importes/clip.wav')));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['timeout', 'reject', 'absent']) {
    let finish;
    h.transport((path) => {
      if (path.replaceAll('\\', '/') !== h.clip) return present(path);
      if (mode === 'reject') throw new Error('IPC unavailable');
      if (mode === 'absent') return false;
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = loadProjectFromPath(saved);
    if (mode === 'timeout') {
      await until(() => !!finish);
      t.mock.timers.tick(4000);
    }
    const reopened = await pending;
    const binding = reopened.data.authoring.mediaBindings[0];
    assert.equal(binding.path, mode === 'absent' ? duplicate : h.clip);
    assert.equal(binding.status, 'resolved');
    if (finish) finish(true);
  }
});

test('consolidation projectIO : un audit en délai ne requalifie pas la copie comme manquante', async (t) => {
  const h = await diskFor(t);
  const destination = h.disk.dir('consolidated');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  h.transport((path) => {
    if (fs.existsSync(path) && path.replaceAll('\\', '/').startsWith(destination)) {
      return new Promise((resolve) => { finish = resolve; });
    }
    return present(path);
  });
  const pending = consolidateProject(graph(h.clip), null, destination);
  await until(() => !!finish);
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.project.authoring.mediaBindings[0].status, 'resolved');
  assert.deepEqual(result.errors, []);
  finish(true);
});

test('le refus de vérification se traduit à chaud en FR/EN/IT sans message introuvable', async (t) => {
  const h = await diskFor(t);
  h.transport(() => { throw new Error('IPC unavailable'); });
  const resources = createTestI18n().options.resources;
  await i18next.init({ lng: 'fr', resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
  t.after(() => i18next.changeLanguage('fr'));
  const result = await produce(graph(h.clip), { [h.clip]: null });
  const titles = []; const messages = [];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    titles.push(result.refusal.title); messages.push(result.refusal.message);
    assert.doesNotMatch(result.refusal.message, /introuvable|not.found|non.trovat|\[object Object\]|production:/i);
  }
  assert.equal(new Set(titles).size, 3);
  assert.equal(new Set(messages).size, 3);
});

test('P2 reprises : 439 chemins en erreur ont trois reprises espacées puis attendent focus ou projet', async (t) => {
  const h = await diskFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.transport(() => { throw new Error('persistent IPC failure'); });
  let project = graph(h.clip);
  project.authoring.mediaBindings = Array.from({ length: 439 }, (_, index) => ({
    assetRef: `${index}.wav`, path: `${h.clip}.${index}`, status: 'resolved',
  }));
  const audit = runner(() => useProjectFileAudit(project));
  t.after(() => audit.unmount());
  audit.render(); audit.flush(); await settle();
  const probes = () => h.disk.countCalls('plugin:fs|exists');
  assert.equal(probes(), 439);
  for (const [index, delay] of [1500, 3000, 6000].entries()) {
    const before = probes();
    t.mock.timers.tick(delay - 1); await settle();
    assert.equal(probes(), before, `reprise ${index + 1} trop tôt`);
    t.mock.timers.tick(1); await settle();
    assert.equal(probes(), before + 439);
  }
  const stopped = probes();
  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(60_000); await settle();
    assert.equal(probes(), stopped, 'aucune sonde supplémentaire sans intervention');
  }
  assert.equal(stopped, 1756, 'audit initial et trois reprises seulement');
  assert.equal(audit.render().pending, false);
  assert.equal(Object.keys(audit.render().statusByPath).length, 439);
  assert.ok(Object.values(audit.render().statusByPath).every((status) => status === null));
  window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(probes(), stopped + 439);
  t.mock.timers.tick(1500); await settle();
  assert.equal(probes(), stopped + 878, 'le focus réarme les reprises');
  project = graph(`${h.clip}.new-project`);
  audit.render(); audit.flush(); await settle();
  const afterChange = probes();
  t.mock.timers.tick(1500); await settle();
  assert.equal(probes(), afterChange + 1, 'le nouveau projet réarme sa propre reprise');
  audit.unmount();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(probes(), afterChange + 1, 'aucune reprise après démontage');
});


test('P2 audit : une observation remplacée pendant le reste du lot ne requalifie aucun média', async (t) => {
  const h = await diskFor(t);
  const other = await h.disk.writeFile('project/other.wav', 'synthetic second audio');
  const project = graph(h.clip);
  project.authoring.mediaBindings.push({ assetRef: 'other.wav', path: other, status: 'resolved' });
  const audit = runner(() => useProjectFileAudit(project));
  t.after(() => audit.unmount());
  audit.render(); audit.flush(); await until(() => !audit.render().pending);
  assert.equal(audit.render().statusByPath[h.clip], true);
  let finishOther;
  notifyFileChanged(h.clip); notifyFileChanged(other);
  h.transport((path) => path === other
    ? new Promise((resolve) => { finishOther = resolve; })
    : false);
  window.dispatchEvent(new Event('focus')); await settle();
  assert.ok(finishOther);
  const replaced = await readPathSnapshot(h.clip, { maxAgeMs: 60_000 });
  assert.equal(replaced.exists, false);
  h.transport(present);
  await readPathSnapshot(h.clip, { force: true });
  finishOther(true); await until(() => !audit.render().pending);
  assert.equal(audit.render().statusByPath[h.clip], true, 'le lot ignore son observation remplacée');
  assert.equal(resolveMediaBindingStatuses(project, audit.render().statusByPath).authoring.mediaBindings[0].status, 'resolved');
});





test('revue2 P2 : un réaudit pendant le chargement initial ne laisse pas l’aperçu vide', async (t) => {
  let finishRead;
  const h = await diskFor(t, { 'plugin:fs|read_file': ({ path }) => {
    if (finishRead) return Array.from(fs.readFileSync(path));
    return new Promise((resolve) => { finishRead = resolve; });
  } });
  const preview = runner(() => useLocalFile(h.clip));
  const project = graph(h.clip);
  const audit = runner(() => useProjectFileAudit(project));
  t.after(() => { preview.unmount(); audit.unmount(); });
  preview.render(); preview.flush(); await until(() => !!finishRead);
  audit.render(); audit.flush(); await until(() => !audit.render().pending);
  assert.equal(audit.render().statusByPath[h.clip], true);
  finishRead(Array.from(fs.readFileSync(h.clip))); await settle();
  assert.match(preview.render() ?? '', /^blob:/, 'l’aperçu rejoint le relevé courant et finit son chargement');
});

test('revue2 P3 : focus pendant l’audit initial puis erreur ne laisse aucune minuterie au démontage', async (t) => {
  const h = await diskFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const activeTimers = new Set();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = schedule(() => { activeTimers.delete(timer); callback(...args); }, delay);
    activeTimers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    activeTimers.delete(timer);
    return cancel(timer);
  });
  let rejectExists;
  h.transport(() => new Promise((_, reject) => { rejectExists = reject; }));
  const project = graph(h.clip);
  const audit = runner(() => useProjectFileAudit(project));
  t.after(() => audit.unmount());
  audit.render(); audit.flush();
  window.dispatchEvent(new Event('focus'));
  rejectExists(new Error('IPC failure')); await settle();
  assert.ok(activeTimers.size > 0, 'la reprise a bien été programmée');
  audit.unmount();
  assert.equal(activeTimers.size, 0, 'toutes les minuteries programmées sont annulées');
});


test('revue2 partage : deux aperçus montés ensemble mutualisent la vérification initiale', async (t) => {
  const h = await diskFor(t);
  let finishExists;
  h.transport(() => new Promise((resolve) => { finishExists = resolve; }));
  const first = runner(() => useLocalFile(h.clip));
  const second = runner(() => useLocalFile(h.clip));
  t.after(() => { first.unmount(); second.unmount(); });
  first.render(); first.flush(); second.render(); second.flush();
  assert.equal(h.disk.countCalls('plugin:fs|exists'), 1);
  finishExists(true);
  await until(() => !!first.render() && !!second.render());
  assert.equal(first.render(), second.render());
  assert.equal(h.disk.countCalls('plugin:fs|exists'), 1);
});



test('repli Astra : 1000 chemins réglés ne laissent aucune entrée de lecture retenue', async (t) => {
  const h = await diskFor(t);
  h.transport(() => { throw new Error('persistent IPC failure'); });
  const snapshotsBefore = cache.__cacheSizesForTest().snapshots;
  const results = await Promise.all(Array.from({ length: 1000 }, (_, index) => readPathSnapshot(`${h.clip}.${index}`)));
  assert.ok(results.every((snapshot) => snapshot.exists === null));
  assert.equal(cache.__cacheSizesForTest().snapshots, snapshotsBefore, 'aucun snapshot indéterminé mis en cache');
  assert.equal(cache.__cacheSizesForTest().reads, 0, 'aucune lecture ni promesse réglée retenue');
});

test('repli Astra : un aperçu démonté pendant une lecture bloquée peut être remonté avec une nouvelle lecture', async (t) => {
  let reads = 0;
  const h = await diskFor(t, { 'plugin:fs|read_file': ({ path }) => {
    reads++;
    return reads === 1 ? new Promise(() => {}) : Array.from(fs.readFileSync(path));
  } });
  const first = runner(() => useLocalFile(h.clip));
  const second = runner(() => useLocalFile(h.clip));
  t.after(() => { first.unmount(); second.unmount(); });
  first.render(); first.flush(); await until(() => reads === 1);
  first.unmount();
  second.render(); second.flush(); await settle();
  assert.equal(reads, 2, 'le remontage doit relire au lieu de reprendre la promesse bloquée');
  await until(() => !!second.render());
  assert.match(second.render(), /^blob:/);
});

test('repli Astra : un résultat indéterminé conserve l’aperçu sans reprise automatique', async (t) => {
  const h = await diskFor(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const preview = runner(() => useLocalFile(h.clip));
  t.after(() => preview.unmount());
  preview.render(); preview.flush(); await until(() => !!preview.render());
  const url = preview.render();
  h.transport(() => { throw new Error('IPC failure'); });
  notifyFileChanged(h.clip); await settle();
  assert.equal(preview.render(), url);
  const probes = h.disk.countCalls('plugin:fs|exists');
  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(60_000); await settle();
    assert.equal(h.disk.countCalls('plugin:fs|exists'), probes);
    assert.equal(preview.render(), url);
  }
  fs.unlinkSync(h.clip);
  h.transport(present);
  notifyFileChanged(h.clip); await settle();
  assert.equal(preview.render(), null, 'un vrai false natif constate toujours la disparition');
});
