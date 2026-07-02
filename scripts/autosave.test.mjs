import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOSAVE_ACTIONS,
  decideAutosaveAction,
  isProjectWorthAutosaving,
  selectStaleAutosaveBackups,
} from '../src/store/autosaveDecision.js';

function snapshot(value) {
  return JSON.stringify(value);
}

test('decideAutosaveAction skips when the snapshot matches the last saved one', () => {
  const project = { rootEntries: [{ id: 'a', type: 'story', name: 'A' }] };
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: snapshot(project),
    savedSnapshot: snapshot(project),
    isDirty: true,
    savePath: 'D:/projet/file.mbah',
    workspaceDir: 'D:/ws',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_UNCHANGED);
});

test('decideAutosaveAction skips an empty/non-dirty project (no write)', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{}',
    savedSnapshot: null,
    isDirty: false,
    savePath: null,
    workspaceDir: 'D:/ws',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_EMPTY);
});

test('decideAutosaveAction routes a dirty project with a savePath to the explicit save handler', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":1}',
    savedSnapshot: '{"a":0}',
    isDirty: true,
    savePath: 'D:/projet/file.mbah',
    workspaceDir: 'D:/ws',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SAVE_EXPLICIT);
  assert.equal(action.path, 'D:/projet/file.mbah');
});

test('decideAutosaveAction creates a new autosave when no savePath but workspaceDir is set', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":1}',
    savedSnapshot: null,
    isDirty: true,
    savePath: null,
    workspaceDir: 'D:/ws',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.AUTOSAVE_NEW);
  assert.equal(action.workspaceDir, 'D:/ws');
});

test('decideAutosaveAction routes an ephemeral project to the session recovery snapshot', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":1}',
    savedSnapshot: null,
    isDirty: true,
    savePath: null,
    workspaceDir: 'D:/temp/story_studio_session_1_2',
    sessionMode: 'ephemeral',
    ephemeralSnapshotPath: 'D:/temp/story_studio_session_1_2/.session-recovery.mbah',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.AUTOSAVE_EPHEMERAL);
  assert.equal(action.workspaceDir, 'D:/temp/story_studio_session_1_2');
  assert.equal(action.path, 'D:/temp/story_studio_session_1_2/.session-recovery.mbah');
});

test('decideAutosaveAction skips an unchanged ephemeral snapshot without marking the project saved', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":1}',
    savedSnapshot: null,
    isDirty: true,
    savePath: null,
    workspaceDir: 'D:/temp/story_studio_session_1_2',
    sessionMode: 'ephemeral',
    ephemeralSnapshotPath: 'D:/temp/story_studio_session_1_2/.session-recovery.mbah',
    lastEphemeralSnapshot: '{"a":1}',
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_UNCHANGED);
});

test('decideAutosaveAction reuses the existing autosave file when one is already known', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":2}',
    savedSnapshot: '{"a":1}',
    isDirty: true,
    savePath: null,
    workspaceDir: 'D:/ws',
    autoSavePath: 'D:/ws/sauvegardes/mon-projet_2026-01-01_10h00m00.mbah',
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.AUTOSAVE_EXISTING);
  assert.equal(action.path, 'D:/ws/sauvegardes/mon-projet_2026-01-01_10h00m00.mbah');
});

test('decideAutosaveAction skips silently when neither savePath nor workspaceDir is set', () => {
  const action = decideAutosaveAction({
    isSaving: false,
    currentSnapshot: '{"a":1}',
    savedSnapshot: null,
    isDirty: true,
    savePath: null,
    workspaceDir: null,
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_NO_TARGET);
});

test('decideAutosaveAction skips while another save is in flight', () => {
  const action = decideAutosaveAction({
    isSaving: true,
    currentSnapshot: '{"a":1}',
    savedSnapshot: '{"a":0}',
    isDirty: true,
    savePath: 'D:/projet/file.mbah',
    workspaceDir: 'D:/ws',
    autoSavePath: null,
  });
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_BUSY);
});

test('decideAutosaveAction tolerates a missing parameter object without crashing', () => {
  // L'autosave est appelé périodiquement par un setInterval ; les arguments
  // peuvent occasionnellement être incomplets. Le helper ne doit pas lever.
  assert.doesNotThrow(() => decideAutosaveAction());
  const action = decideAutosaveAction({});
  assert.equal(action.kind, AUTOSAVE_ACTIONS.SKIP_UNCHANGED);
});

test('selectStaleAutosaveBackups keeps the N freshest and returns the rest for deletion', () => {
  // Les noms suivent le format `<base>.<ISO-timestamp>.mbah`. Le tri
  // lexicographique est donc chronologique.
  const baseName = 'projet';
  const entries = [
    { isFile: true, name: 'projet.2026-01-01T10-00-00-000Z.mbah' },
    { isFile: true, name: 'projet.2026-01-02T10-00-00-000Z.mbah' },
    { isFile: true, name: 'projet.2026-01-03T10-00-00-000Z.mbah' },
    { isFile: true, name: 'projet.2026-01-04T10-00-00-000Z.mbah' },
  ];

  const stale = selectStaleAutosaveBackups(entries, baseName, 3);

  assert.deepEqual(stale, ['projet.2026-01-01T10-00-00-000Z.mbah']);
});

test('selectStaleAutosaveBackups: N+1 backups → exactly one (oldest) is removed', () => {
  // Scénario explicite « créer N+1 backups consécutifs → le plus ancien
  // est supprimé, on en garde N ».
  const baseName = 'projet';
  const keep = 5;
  const timestamps = [
    '2026-01-01T10-00-00-000Z',
    '2026-01-02T10-00-00-000Z',
    '2026-01-03T10-00-00-000Z',
    '2026-01-04T10-00-00-000Z',
    '2026-01-05T10-00-00-000Z',
    '2026-01-06T10-00-00-000Z', // N+1
  ];
  const entries = timestamps.map((t) => ({ isFile: true, name: `${baseName}.${t}.mbah` }));

  const stale = selectStaleAutosaveBackups(entries, baseName, keep);

  assert.equal(stale.length, 1, `un seul backup doit être supprimé, reçu ${stale.length}`);
  assert.equal(stale[0], `${baseName}.${timestamps[0]}.mbah`);
});

test('selectStaleAutosaveBackups returns nothing when keep ≥ number of backups', () => {
  const entries = [
    { isFile: true, name: 'projet.2026-01-01.mbah' },
    { isFile: true, name: 'projet.2026-01-02.mbah' },
  ];
  assert.deepEqual(selectStaleAutosaveBackups(entries, 'projet', 5), []);
  assert.deepEqual(selectStaleAutosaveBackups(entries, 'projet', 2), []);
});

test('selectStaleAutosaveBackups ignores directories and unrelated files', () => {
  const entries = [
    { isFile: false, name: 'projet.2026-01-01.mbah' }, // dossier homonyme
    { isFile: true, name: 'autre.2026-01-01.mbah' },   // base différente
    { isFile: true, name: 'projet.2026-01-02.txt' },   // mauvaise extension
    { isFile: true, name: 'projet.2026-01-03.mbah' },
    { isFile: true, name: 'projet.2026-01-04.mbah' },
  ];
  assert.deepEqual(
    selectStaleAutosaveBackups(entries, 'projet', 1),
    ['projet.2026-01-03.mbah'],
  );
});

test('selectStaleAutosaveBackups treats keep ≤ 0 as “purge everything matching”', () => {
  const entries = [
    { isFile: true, name: 'projet.2026-01-01.mbah' },
    { isFile: true, name: 'projet.2026-01-02.mbah' },
  ];
  assert.equal(selectStaleAutosaveBackups(entries, 'projet', 0).length, 2);
  assert.equal(selectStaleAutosaveBackups(entries, 'projet', -1).length, 2);
});

// --- isProjectWorthAutosaving (plan 24) ---------------------------------

function simpleProjectWith(story = {}) {
  return {
    projectType: 'simple',
    rootAudio: null,
    rootEntries: [{ id: 's1', type: 'story', name: '', audio: null, itemAudio: null, itemImage: null, ...story }],
  };
}

test('isProjectWorthAutosaving: projet simple vierge (histoire pré-créée) → non', () => {
  assert.equal(isProjectWorthAutosaving(simpleProjectWith()), false);
});

test('isProjectWorthAutosaving: histoire nommée ou avec média → oui', () => {
  assert.equal(isProjectWorthAutosaving(simpleProjectWith({ name: 'Le loup' })), true);
  assert.equal(isProjectWorthAutosaving(simpleProjectWith({ audio: 'C:/a.mp3' })), true);
  assert.equal(isProjectWorthAutosaving(simpleProjectWith({ itemImage: 'C:/a.png' })), true);
});

test('isProjectWorthAutosaving: nom de projet ou titre de pack saisi → oui', () => {
  assert.equal(isProjectWorthAutosaving({ ...simpleProjectWith(), projectName: 'Filet' }), true);
  assert.equal(isProjectWorthAutosaving({ ...simpleProjectWith(), packMetadata: { title: 'Mon pack' } }), true);
});

test('isProjectWorthAutosaving: média racine ou bibliothèque → oui', () => {
  assert.equal(isProjectWorthAutosaving({ projectType: 'simple', rootAudio: 'C:/t.mp3', rootEntries: [] }), true);
  assert.equal(isProjectWorthAutosaving(simpleProjectWith(), ['C:/lib.mp3']), true);
  assert.equal(isProjectWorthAutosaving(simpleProjectWith(), [], 3), true);
});

test('isProjectWorthAutosaving: pack avec dossier créé → oui ; pack vide → non', () => {
  assert.equal(isProjectWorthAutosaving({ projectType: 'pack', rootEntries: [{ id: 'm1', type: 'menu', name: 'Nouveau dossier', children: [] }] }), true);
  assert.equal(isProjectWorthAutosaving({ projectType: 'pack', rootEntries: [] }), false);
  assert.equal(isProjectWorthAutosaving(null), false);
});
