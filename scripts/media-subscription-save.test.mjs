// Quelles écritures de projet annoncent ses suivis au registre local.
//
// Les fichiers sont réellement écrits dans un répertoire temporaire ; seul
// l'événement d'annonce est observé. Une écriture vers le fichier du projet,
// même silencieuse, active les suivis demandés ; les écritures de secours
// (dossier de sauvegardes d'un projet jamais enregistré, instantané de
// session) n'annoncent jamais, car leur chemin n'est pas celui du projet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const io = await import('../src/store/projectIO.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { SUBSCRIPTIONS_SAVED_EVENT } = await import('../src/store/mediaSubscriptionSource.js');

const followedProject = () => normalizeProjectData({
  projectName: 'projet-suivi',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Le renard' }],
  mediaSubscriptions: [{
    id: 'follow-1', source: 'podcast', url: 'https://example.com/feed.xml', title: 'Flux',
    baselineIds: ['ep-1'], enabled: true,
  }],
});

async function withAnnouncements(run) {
  const harness = await createDiskHarness();
  const events = [];
  const previousDispatch = window.dispatchEvent;
  const previousCustomEvent = globalThis.CustomEvent;
  window.dispatchEvent = (event) => { events.push(event); return true; };
  globalThis.CustomEvent = class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init.detail; }
  };
  try {
    await run(harness, events);
  } finally {
    window.dispatchEvent = previousDispatch;
    globalThis.CustomEvent = previousCustomEvent;
    await harness.dispose();
  }
}

test('a silent save to the project file announces its subscriptions', async () => {
  await withAnnouncements(async (harness, events) => {
    const savePath = harness.dir('documents', 'suivi.mbah');
    await io.saveProject(followedProject(), savePath, null, { autosave: true, announceSubscriptions: true });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, SUBSCRIPTIONS_SAVED_EVENT);
    assert.equal(events[0].detail.projectPath, savePath);
    assert.deepEqual(events[0].detail.configs.map((item) => item.id), ['follow-1']);
  });
});

test('an explicit save still announces, an autosave without the project path does not', async () => {
  await withAnnouncements(async (harness, events) => {
    await io.saveProject(followedProject(), harness.dir('documents', 'explicite.mbah'));
    assert.equal(events.length, 1);

    await io.saveProject(followedProject(), harness.dir('documents', 'secours.mbah'), null, { autosave: true });
    assert.equal(events.length, 1);
  });
});

test('backup-folder autosaves and session snapshots never announce subscriptions', async () => {
  await withAnnouncements(async (harness, events) => {
    const saved = await io.autoSaveNewProject(followedProject(), harness.workspace);
    assert.ok(saved?.path);
    const sessionDir = await harness.mkdirp('session');
    const snapshot = await io.autoSaveEphemeralProject(followedProject(), sessionDir, `${sessionDir}/snapshot.mbah`);
    assert.ok(snapshot?.path);
    assert.deepEqual(events, []);
  });
});
