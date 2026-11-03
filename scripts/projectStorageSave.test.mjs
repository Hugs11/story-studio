import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProjectStorageSave, remapStoragePath, relocateStorageProject } from '../src/store/projectStorageSave.js';
import { createProjectStorage } from '../src/store/projectStorage.js';
import { beginProjectMediaOutput } from '../src/store/projectMediaOutput.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectStorageDiskCommands } from './projectStorageDiskCommands.mjs';

test('silent saves never resolve or rename a provisional folder', async () => {
  const project = { storage: createProjectStorage(), projectName: 'Azuro' };
  const result = await prepareProjectStorageSave({ project, silent: true, root: '/workspace', invokeCommand: () => { throw new Error('unexpected disk call'); } });
  assert.equal(result.project, project);
  assert.equal(result.finalized, false);
});
test('active producer defers first naming until a later manual save', async () => {
  const project = { storage: createProjectStorage(), projectName: 'Azuro' };
  const job = beginProjectMediaOutput({ root:'/session', storage:project.storage, ephemeral:true });
  const result = await prepareProjectStorageSave({ project, root:'/workspace', invokeCommand: () => { throw new Error('unexpected rename'); } });
  assert.equal(result.deferred, true);
  assert.equal(result.project.storage.provisional, true);
  job.release();
});
test('manual transaction stages storage and path prefixes; failure inverses only its move', async () => {
  const project = { storage: createProjectStorage(), projectName:'Azuro', rootEntries:[], rootAudio:'/workspace/voix-generees/Projet sans titre/a.mp3' };
  const calls = [];
  const transaction = await prepareProjectStorageSave({ project, root:'/workspace', invokeCommand: async (cmd, args) => {
    calls.push({cmd,args});
    if (cmd === 'resolve_project_folder') return args.folder;
    return [{from:'/workspace/voix-generees/Projet sans titre',to:'/workspace/voix-generees/Azuro'}];
  }});
  assert.equal(project.storage.provisional,true);
  assert.equal(transaction.project.storage.provisional,false);
  assert.equal(transaction.project.rootAudio,'/workspace/voix-generees/Azuro/a.mp3');
  await transaction.rollback(); transaction.release();
  assert.equal(calls.at(-1).args.old,'Azuro');
  assert.equal(calls.at(-1).args.new,'Projet sans titre');
});
test('path relocation respects native boundaries and leaves payload and asset refs untouched', () => {
  const moves=[{from:'C:/ws/voix-generees/Projet sans titre',to:'C:/ws/voix-generees/Azuro'}];
  assert.equal(remapStoragePath('c:\\ws\\voix-generees\\Projet sans titre\\a.mp3',moves),'C:/ws/voix-generees/Azuro/a.mp3');
  assert.equal(remapStoragePath('C:/ws/voix-generees/Projet sans titre bis/a.mp3',moves),'C:/ws/voix-generees/Projet sans titre bis/a.mp3');
  const advanced={authoringMode:'advanced',authoring:{payload:'opaque',mediaBindings:[{path:'C:/ws/voix-generees/Projet sans titre/a.mp3',assetRef:'a.mp3'}]}};
  const storage=createProjectStorage({folder:'Azuro',provisional:false});
  const relocated=relocateStorageProject(advanced,moves,storage);
  assert.equal(relocated.authoring.payload,'opaque');assert.equal(relocated.authoring.mediaBindings[0].assetRef,'a.mp3');
  assert.deepEqual(relocated.storage,storage);
});

test('a long colliding name keeps its base in storage, never truncates the resolved suffix', async () => {
  const base = 'é'.repeat(60);
  const project = { projectName: base, storage: createProjectStorage() };
  const transaction = await prepareProjectStorageSave({ project, root: '/workspace', ephemeral: true,
    invokeCommand: async () => `${base} (2)`,
  });
  assert.equal(transaction.project.storage.folder, base);
  assert.equal(transaction.project.storage.provisional, false);
  transaction.release();
});

test('first manual save renames the provisional (2) folder really owned once the first rank is freed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-storage-owned-rank-'));
  try {
    const foreign = path.join(root, 'enregistrements', 'Projet sans titre');
    await fs.mkdir(foreign, { recursive: true });
    const invokeCommand = (command, args) => projectStorageDiskCommands[command](args);
    const storage = createProjectStorage();
    const provisional = await invokeCommand('resolve_project_folder', { root, folder: storage.folder, workId: storage.workId, create: true });
    assert.equal(provisional, 'Projet sans titre (2)');
    await fs.rm(foreign, { recursive: true });
    const rootAudio = path.join(root, 'voix-generees', provisional, 'a.mp3');
    await fs.writeFile(rootAudio, 'audio');
    const transaction = await prepareProjectStorageSave({ project: { storage, projectName: 'Azuro', rootEntries: [], rootAudio }, root, invokeCommand });
    transaction.release();
    assert.equal(path.normalize(transaction.project.rootAudio), path.join(root, 'voix-generees', 'Azuro', 'a.mp3'));
    assert.equal(await fs.readFile(transaction.project.rootAudio, 'utf8'), 'audio');
    await assert.rejects(fs.access(path.join(root, 'voix-generees', provisional)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
