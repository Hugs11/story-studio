import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { saveProject, loadProjectFromPath } = await import('../src/store/projectIO.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { selectStaleAutosaveBackups } = await import('../src/store/autosaveDecision.js');

for (const [label, firstName, secondName] of [
  ['same_basename', 'A/Contes.mbah', 'B/Contes.mbah'],
  ['dotted_basename', 'A/Contes.v2.mbah', 'B/Contes.mbah'],
]) {
  test(`${label}_projects_keep_independent_backup_rotations`, async () => {
    const disk = await createDiskHarness();
    try {
      disk.settings.setItem(KEYS.WORKSPACE_DIR, disk.workspace);
      const backupDir = `${disk.workspace}/sauvegardes/versions-securite`;
      const createProject = (name) => normalizeProjectData({ projectType: 'pack', projectName: name,
        rootEntries: [{ id: 'story', type: 'story', name }] });
      const firstPath = disk.dir(firstName);
      const secondPath = disk.dir(secondName);
      await disk.mkdirp('A'); await disk.mkdirp('B');
      // La limite de cinq est la valeur par défaut. A possède une seule version.
      await saveProject(createProject('A0'), firstPath);
      await saveProject(createProject('A1'), firstPath, null, { backupLimit: 5 });
      const [firstBackup] = await fs.readdir(backupDir);
      const originalBytes = await fs.readFile(`${backupDir}/${firstBackup}`, 'utf8');
      await saveProject(createProject('B0'), secondPath);
      const expected = [originalBytes];
      for (let version = 1; version <= 5; version += 1) {
        expected.push(await fs.readFile(secondPath, 'utf8'));
        // Des instants distincts évitent la collision de noms à la milliseconde.
        await new Promise(resolve => setTimeout(resolve, 12));
        await saveProject(createProject(`B${version}`), secondPath, null, { backupLimit: 5 });
      }
      assert.equal(await disk.exists(firstPath), true, 'le projet A reste intact');
      const backups = await fs.readdir(backupDir);
      const contents = await Promise.all(backups.map(name => fs.readFile(`${backupDir}/${name}`, 'utf8')));
      for (const bytes of expected) {
        assert.ok(contents.includes(bytes),
          `version perdue : ${JSON.parse(bytes).rootEntries[0].name} (${backups.join(', ')})`);
      }
    } finally { await disk.dispose(); }
  });
}

test('rotation matches the exact timestamp suffix, including dotted and regex-like project names', () => {
  const stamp = '2026-01-01T10-00-00-000Z';
  const names = [
    `Contes.${stamp}.mbah`,
    `Contes.v2.${stamp}.mbah`,
    'Contes.notes.mbah',
    'Contes.2026-01-01.mbah',
    `Contes[2].${stamp}.mbah`,
  ];
  const entries = names.map(name => ({ isFile: true, name }));
  assert.deepEqual(selectStaleAutosaveBackups(entries, 'Contes', 0), [names[0]]);
  assert.deepEqual(selectStaleAutosaveBackups(entries, 'Contes.v2', 0), [names[1]]);
  assert.deepEqual(selectStaleAutosaveBackups(entries, 'Contes[2]', 0), [names[4]]);
});

test('shared rotation keeps ambiguous legacy backups readable and prunes only its own oldest version', async () => {
  const disk = await createDiskHarness();
  try {
    disk.settings.setItem(KEYS.WORKSPACE_DIR, disk.workspace);
    const backupDir = `${disk.workspace}/sauvegardes/versions-securite`;
    const project = name => normalizeProjectData({ projectType: 'pack', projectName: name,
      rootEntries: [{ id: 'story', type: 'story', name }] });
    const path = `${await disk.mkdirp('A')}/Contes.mbah`;
    await saveProject(project('legacy'), path);
    await fs.mkdir(backupDir, { recursive: true });
    const legacyPath = `${backupDir}/Contes.2026-01-01T10-00-00-000Z.mbah`;
    await fs.copyFile(path, legacyPath);
    const legacyBytes = await fs.readFile(legacyPath, 'utf8');
    // An identical legacy backup must neither suppress the first identified
    // backup nor be counted in its rotation.
    await saveProject(project('v1'), path, null, { backupLimit: 2 });
    const identified = (await fs.readdir(backupDir)).find(name => name.includes('--'));
    assert.ok(identified);
    assert.equal((await loadProjectFromPath(`${backupDir}/${identified}`)).data.rootEntries[0].name, 'legacy');
    for (const name of ['v2', 'v3']) {
      await new Promise(resolve => setTimeout(resolve, 12));
      await saveProject(project(name), path, null, { backupLimit: 2 });
    }
    const backups = await fs.readdir(backupDir);
    assert.equal(backups.length, 3, 'two identified backups plus the untouched legacy version');
    assert.ok(!backups.includes(identified), 'oldest identified version removed');
    assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyBytes);
    assert.equal((await loadProjectFromPath(legacyPath)).data.rootEntries[0].name, 'legacy');
    const contents = await Promise.all(backups.filter(name => name.includes('--'))
      .map(async name => (await loadProjectFromPath(`${backupDir}/${name}`)).data.rootEntries[0].name));
    assert.deepEqual(contents.sort(), ['v1', 'v2']);
  } finally { await disk.dispose(); }
});
