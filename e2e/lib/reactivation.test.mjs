import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clickButton, enterGeneration, newProject } from './actions.mjs';
import { editorCard, findManagedCopy } from './c2-helpers.mjs';
import { attachCollectors } from './collect.mjs';
import { selectNodePickerOption } from './c4-helpers.mjs';
import { createCampaignProcessManager, isRepositoryDevExecutable } from './campaign-processes.mjs';

test('IPC : relances, flush répété et newline terminale restent un JSON par ligne', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-e2e-collector-'));
  try {
    for (const cmd of ['premier', 'relance']) {
      const page = new EventEmitter();
      const events = attachCollectors(page, dir);
      page.emit('request', { url: () => `http://ipc.localhost/${cmd}`, postDataJSON: () => ({}) });
      events.flush();
      events.flush();
    }
    const raw = readFileSync(join(dir, 'ipc.jsonl'), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(raw.trim().split('\n').map(line => JSON.parse(line).cmd), ['premier', 'relance']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('faults rapporte les avertissements et refus IPC sans masquer les erreurs JS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-e2e-signals-'));
  const original = console.warn;
  const reported = [];
  console.warn = (...args) => reported.push(args.join(' '));
  try {
    const page = new EventEmitter();
    const events = attachCollectors(page, dir);
    page.emit('console', { type: () => 'warning', text: () => 'alerte' });
    page.emit('pageerror', new Error('échec JS'));
    const response = { url: () => 'http://ipc.localhost/refus', ok: () => false, text: async () => 'refus attendu', status: () => 400 };
    await page.listeners('response')[0](response);
    assert.equal(events.faults().length, 1);
    assert.match(reported.join('\n'), /console.warning/);
    assert.match(reported.join('\n'), /ipc.error/);
  } finally { console.warn = original; rmSync(dir, { recursive: true, force: true }); }
});

test('copie gérée : sous-dossier projet, absence et ambiguïté', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-e2e-copy-'));
  try {
    const project = join(dir, 'fichiers-importes', 'projet');
    mkdirSync(project, { recursive: true });
    assert.equal(findManagedCopy(dir, 'audio.wav'), null);
    const copy = join(project, 'audio.wav');
    writeFileSync(copy, 'audio');
    assert.equal(findManagedCopy(dir, 'audio.wav'), copy);
    const other = join(dir, 'fichiers-importes', 'autre');
    mkdirSync(other);
    writeFileSync(join(other, 'audio.wav'), 'autre');
    assert.throws(() => findManagedCopy(dir, 'audio.wav'), /ambiguës/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clic requis absent : exception au lieu d’un faux succès silencieux', async () => {
  const absent = { first() { return this; }, count: async () => 0, filter() { return this; } };
  await assert.rejects(clickButton({ getByRole: () => absent, locator: () => absent }, 'Réparer'), /Bouton introuvable/);
});

test('nouveau graphe : la barre seule ne libère pas les gestes avant la liste initiale', async () => {
  const order = [];
  let releaseIndex;
  const indexReady = new Promise(resolve => { releaseIndex = resolve; });
  const tile = { first() { return this; }, waitFor: async () => {}, count: async () => 1,
    click: async () => { order.push('tile'); } };
  const bar = { first() { return this; }, waitFor: async () => { order.push('bar'); } };
  const missingError = { filter() { return this; }, first() { return this; }, waitFor: () => new Promise(() => {}) };
  const initialStage = { first() { return this; }, waitFor: async () => {
    order.push('index-wait'); await indexReady; order.push('index-ready');
  } };
  const page = { getByRole: () => bar, locator(selector) {
    if (selector === '.mode-tile-name') return tile;
    if (selector === '[data-toolbar-id="project-menu"]') return bar;
    if (selector === 'li[role="option"][data-kind="stage"]:visible') return initialStage;
    return missingError;
  } };
  const opening = newProject(page, 'advanced').then(() => { order.push('authoring'); });
  // Vider les microtâches : toutes les attentes simulées sauf l'index sont immédiates.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['tile', 'bar', 'bar', 'index-wait']);
  releaseIndex();
  await opening;
  assert.deepEqual(order.slice(-2), ['index-ready', 'authoring']);
  page.locator = selector => selector === 'li[role="option"][data-kind="stage"]:visible'
    ? { first() { return this; }, waitFor: async () => { throw new Error('index absent'); } }
    : selector === '.mode-tile-name' ? tile : selector === '[data-toolbar-id="project-menu"]' ? bar : missingError;
  await assert.rejects(newProject(page, 'advanced'), /index absent/);
});

test('carte histoire : apostrophes acceptées, titre toujours exact', () => {
  let pattern;
  const locator = { filter() { return this; }, first() { return this; } };
  editorCard({ locator: (_selector, options) => { if (options) pattern = options.hasText; return locator; } }, "L'histoire");
  assert.ok(pattern.test('L’histoire'));
  assert.ok(pattern.test("L'histoire"));
  assert.ok(!pattern.test('L’histoire suivante'));
  editorCard({ locator: (_selector, options) => { if (options) pattern = options.hasText; return locator; } }, 'Titre (audio)');
  assert.ok(pattern.test('Titre (audio)'));
  assert.ok(!pattern.test('Titre audio'));
});

test('Select : ouverture de la liste, choix exact et vérification de la sélection', async () => {
  let expanded = false;
  let value = '';
  const labels = ['Écran 10', 'Écran 1'];
  const options = {
    first: () => ({ waitFor: async () => assert.ok(expanded) }),
    count: async () => labels.length,
    nth: index => ({ innerText: async () => labels[index], click: async () => { value = labels[index]; expanded = false; } }),
  };
  const picker = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { expanded = true; },
    getAttribute: async attr => attr === 'aria-controls' ? 'liste-portée' : String(expanded),
    page: () => ({ locator: () => ({ locator: () => options }) }),
    innerText: async () => value,
  };
  await selectNodePickerOption(picker, 'Écran 1');
  assert.equal(value, 'Écran 1');
  await assert.rejects(selectNodePickerOption(picker, 'Écran absent'), /Aucune option/);
});

function processFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ss-e2e-process-'));
  const root = { pid: 1234, created: '2026-11-01T10:00:00.0000000Z' };
  const calls = [];
  let current = root;
  let killStatus = 0;
  let remainsAlive = false;
  let treeOnlyFailure = false;
  let elapsed = 0;
  const manager = createCampaignProcessManager({ platform: 'win32', cleanupTimeoutMs: 500,
    now: () => elapsed, sleep: async ms => { elapsed += ms; }, run(command, args) {
    calls.push({ command, args });
    if (command === 'powershell.exe') {
      assert.match(args.at(-1), /-Filter 'ProcessId=1234'/);
      assert.doesNotMatch(args.at(-1), /ParentProcessId|Get-NetTCPConnection/);
      return { status: 0, stdout: current ? JSON.stringify(current) : '', stderr: '' };
    }
    assert.equal(command, 'taskkill');
    const failedTree = treeOnlyFailure && args.includes('/T');
    if (!remainsAlive && !failedTree) current = null;
    return { status: failedTree ? 1 : killStatus, stdout: '', stderr: failedTree || killStatus ? 'accès refusé' : '' };
  } });
  return {
    manager, root, calls, file: join(dir, 'processes.json'),
    setCurrent(value) { current = value; },
    failKill({ alive = true } = {}) { killStatus = 1; remainsAlive = alive; },
    keepAlive() { remainsAlive = true; },
    failTreeOnly() { treeOnlyFailure = true; },
    dispose() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test('processus : registre limité à la racine et arrêt de son arbre après revérification', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { version: 1, roots: [f.root] });
    await f.manager.cleanupCampaignProcesses(f.file);
    assert.deepEqual(f.calls.map(call => call.command), ['powershell.exe', 'powershell.exe', 'taskkill', 'powershell.exe']);
    assert.deepEqual(f.calls.find(call => call.command === 'taskkill').args, ['/PID', '1234', '/T', '/F']);
  } finally { f.dispose(); }
});

test('processus : PID réattribué ou racine disparue, aucune mise à mort', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    f.setCurrent({ ...f.root, created: '2026-11-01T11:00:00.0000000Z' });
    await f.manager.cleanupCampaignProcesses(f.file);
    f.setCurrent(null);
    await f.manager.cleanupCampaignProcesses(f.file);
    assert.ok(f.calls.every(call => call.command !== 'taskkill'));
  } finally { f.dispose(); }
});

test('processus : échec de taskkill avec racine vivante propagé au nettoyage', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    f.failKill();
    await assert.rejects(f.manager.cleanupCampaignProcesses(f.file), /Nettoyage.*impossible.*toujours vivant/);
  } finally { f.dispose(); }
});

test('processus : taskkill non nul mais racine disparue, nettoyage idempotent', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    f.failKill({ alive: false });
    await f.manager.cleanupCampaignProcesses(f.file);
    await f.manager.cleanupCampaignProcesses(f.file);
    assert.equal(f.calls.filter(call => call.command === 'taskkill').length, 1);
  } finally { f.dispose(); }
});

test('processus : taskkill zéro ne suffit pas si la racine reste vivante', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    f.keepAlive();
    await assert.rejects(f.manager.cleanupCampaignProcesses(f.file), /toujours vivant/);
  } finally { f.dispose(); }
});

test('processus : /T laisse la racine vivante, repli /F après revérification puis disparition', async () => {
  const f = processFixture();
  try {
    f.manager.registerCampaignProcess(f.file, f.root.pid);
    f.failTreeOnly();
    await f.manager.cleanupCampaignProcesses(f.file);
    assert.deepEqual(f.calls.map(call => call.command), [
      'powershell.exe', 'powershell.exe', 'taskkill', 'powershell.exe', 'taskkill', 'powershell.exe',
    ]);
    assert.deepEqual(f.calls.filter(call => call.command === 'taskkill').map(call => call.args), [
      ['/PID', '1234', '/T', '/F'], ['/PID', '1234', '/F'],
    ]);
  } finally { f.dispose(); }
});

test('génération : fiche requise traversée ou dossier direct effectivement répondu', async () => {
  let clicked = false;
  const cta = { first() { return this; }, count: async () => 1, click: async () => { clicked = true; } };
  const sheet = { count: async () => 1, getByRole: () => cta };
  await enterGeneration({ locator: () => sheet }, { dialogCount: 0, outDir: 'sortie' });
  assert.ok(clicked);
  const direct = { locator: () => ({ count: async () => 0 }), evaluate: async () => [
    { kind: 'open', args: [{ directory: true }], answered: 'sortie' },
  ] };
  await enterGeneration(direct, { dialogCount: 0, outDir: 'sortie' });
  for (const entry of [
    { kind: 'open', args: [{ directory: false }], answered: 'sortie' },
    { kind: 'open', args: [{ directory: true }], unanswered: true },
    { kind: 'open', args: [{ directory: true }], answered: 'autre' },
  ]) {
    await assert.rejects(enterGeneration({ ...direct, evaluate: async () => [entry],
      waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 2)),
    }, { dialogCount: 0, outDir: 'sortie', timeout: 1 }), /ni fiche du pack ni choix du dossier/);
  }
});

test('Select : rendu différé attendu, mauvaise sélection toujours refusée', async () => {
  let expanded = false;
  let value = '';
  let openingReads = 0;
  let closingReads = 0;
  let wrong = false;
  const page = { waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 2)),
    locator: () => ({ locator: () => ({
      first: () => ({ waitFor: async () => {} }), count: async () => 1,
      nth: () => ({ innerText: async () => 'Écran 2', click: async () => { expanded = false; } }),
    }) }),
  };
  const picker = {
    page: () => page, scrollIntoViewIfNeeded: async () => {},
    click: async () => { expanded = true; openingReads = 0; closingReads = 0; value = ''; },
    getAttribute: async attr => attr === 'aria-controls' ? (++openingReads > 1 ? 'liste' : null) : String(expanded),
    innerText: async () => { if (!expanded && ++closingReads > 1) value = wrong ? 'Écran 1' : 'Écran 2'; return value; },
  };
  await selectNodePickerOption(picker, 'Écran 2', { timeout: 1_000 });
  assert.equal(value, 'Écran 2');
  wrong = true;
  await assert.rejects(selectNodePickerOption(picker, 'Écran 2', { timeout: 200 }), /ne persiste pas/);
});

test('processus : ancien registre de descendants refusé sans interroger ni tuer', async () => {
  const f = processFixture();
  try {
    writeFileSync(f.file, JSON.stringify([f.root]));
    await assert.rejects(f.manager.cleanupCampaignProcesses(f.file), /Registre E2E incompatible/);
    assert.equal(f.calls.length, 0);
  } finally { f.dispose(); }
});

test('processus : racine absente au lancement, aucun registre créé', () => {
  const f = processFixture();
  try {
    f.setCurrent(null);
    assert.throws(() => f.manager.registerCampaignProcess(f.file, f.root.pid), /PID lancé non enregistré/);
    assert.equal(f.calls.length, 1);
    assert.throws(() => readFileSync(f.file), { code: 'ENOENT' });
  } finally { f.dispose(); }
});

test('repli dev : frontière du target de ce clone, chemin Windows insensible à la casse', () => {
  const repo = 'C:\\travail\\story-studio';
  assert.ok(isRepositoryDevExecutable('c:\\TRAVAIL\\story-studio\\src-tauri\\target\\debug\\story-studio.exe', repo));
  for (const path of [null, 'story-studio.exe', 'C:\\travail\\autre-clone\\src-tauri\\target\\debug\\story-studio.exe',
    'C:\\travail\\story-studio\\src-tauri\\target-autre\\story-studio.exe',
    'C:\\Program Files\\Story Studio\\story-studio.exe',
    'C:\\travail\\story-studio\\src-tauri\\target\\..\\ailleurs\\story-studio.exe']) {
    assert.equal(isRepositoryDevExecutable(path, repo), false, String(path));
  }
});

function cleanupFixture({ blocked = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-e2e-cleanup-'));
  const repoDir = 'C:\\travail\\story-studio';
  const root = { pid: 1234, created: '2026-11-01T10:00:00Z' };
  const orphan = { pid: 2345, created: '2026-11-01T10:01:00Z', executablePath: repoDir + '\\src-tauri\\target\\debug\\story-studio.exe' };
  const foreign = { pid: 9876, created: '2026-11-01T10:02:00Z', executablePath: 'C:\\autre\\src-tauri\\target\\debug\\story-studio.exe' };
  const processes = new Map([root, orphan, foreign].map(process => [process.pid, process]));
  const killed = [];
  const checkedPorts = [];
  let elapsed = 0;
  const manager = createCampaignProcessManager({ platform: 'win32', repoDir, cleanupTimeoutMs: 1000,
    now: () => elapsed, sleep: async ms => { elapsed += ms; },
    isPortOccupied: async port => { checkedPorts.push(port); return blocked || elapsed === 0; },
    run(command, args) {
      if (command === 'taskkill') {
        const pid = Number(args[1]);
        assert.ok(pid === root.pid || pid === orphan.pid, 'aucun processus étranger arrêté');
        killed.push({ pid, args });
        processes.delete(pid);
        return { status: 0, stdout: '', stderr: '' };
      }
      assert.equal(command, 'powershell.exe');
      const script = args.at(-1);
      assert.doesNotMatch(script, /OwningProcess|ParentProcessId|Get-NetTCPConnection/);
      const pid = script.match(/-Filter 'ProcessId=(\d+)'/);
      const value = pid ? processes.get(Number(pid[1])) : [...processes.values()];
      return { status: 0, stdout: value ? JSON.stringify(value) : '', stderr: '' };
    },
  });
  const file = join(dir, 'processes.json');
  manager.registerCampaignProcess(file, root.pid);
  return { manager, file, killed, checkedPorts, processes, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('nettoyage complet : arbre racine, orphelin dev du clone, attente des deux ports, étranger intact', async () => {
  const f = cleanupFixture();
  try {
    await f.manager.cleanupAppProcesses(f.file);
    assert.deepEqual(f.killed, [
      { pid: 1234, args: ['/PID', '1234', '/T', '/F'] },
      { pid: 2345, args: ['/PID', '2345', '/F'] },
    ]);
    assert.ok(f.processes.has(9876));
    assert.deepEqual(f.checkedPorts, [1420, 9222, 1420, 9222]);
  } finally { f.dispose(); }
});

test('nettoyage complet : ports toujours occupés, échec explicite et aucun arrêt de leur propriétaire', async () => {
  const f = cleanupFixture({ blocked: true });
  try {
    await assert.rejects(f.manager.cleanupAppProcesses(f.file), /Nettoyage E2E échoué : ports 1420, 9222 toujours occupés après 1000 ms/);
    assert.ok(f.processes.has(9876));
    assert.deepEqual(f.killed.map(process => process.pid), [1234, 2345]);
    assert.deepEqual(f.checkedPorts, [1420, 9222, 1420, 9222, 1420, 9222]);
  } finally { f.dispose(); }
});

test('nettoyage complet : racine déjà disparue, le repli dev et la vérification des ports restent obligatoires', async () => {
  const f = cleanupFixture();
  try {
    f.processes.delete(1234);
    await f.manager.cleanupAppProcesses(f.file);
    assert.deepEqual(f.killed, [{ pid: 2345, args: ['/PID', '2345', '/F'] }]);
    assert.ok(f.processes.has(9876));
    assert.deepEqual(f.checkedPorts, [1420, 9222, 1420, 9222]);
  } finally { f.dispose(); }
});
