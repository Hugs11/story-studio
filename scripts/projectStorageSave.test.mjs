import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProjectStorageSave, remapStoragePath, relocateStorageProject } from '../src/store/projectStorageSave.js';
import { createProjectStorage } from '../src/store/projectStorage.js';
import { beginProjectMediaOutput } from '../src/store/projectMediaOutput.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectStorageDiskCommands } from './projectStorageDiskCommands.mjs';

test('disk commands keep divergent category ranks and rename only the requested base', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-storage-divergent-'));
  const storage = createProjectStorage({ folder: 'Base' });
  const resolve = (category, folder = 'Base', workId = storage.workId) => projectStorageDiskCommands.resolve_project_folder({
    root, folder, workId, category, create: true,
  });
  try {
    assert.equal(await resolve('images-generees'), 'Base');
    const foreignId = createProjectStorage().workId;
    assert.equal(await resolve('voix-generees', 'Base', foreignId), 'Base (2)');
    // A late arrival occupies the first rank in this category.
    await fs.rename(path.join(root, 'voix-generees', 'Base (2)'), path.join(root, 'voix-generees', 'Base'));
    assert.equal(await resolve('voix-generees'), 'Base (2)');
    assert.equal(await resolve('images-generees'), 'Base');
    assert.equal(await resolve('voix-generees'), 'Base (2)');
    assert.equal(await resolve('images-generees', 'Autre'), 'Autre');
    const source = path.join(root, 'source.wav');
    await fs.writeFile(source, 'audio');
    const copied = await projectStorageDiskCommands.copy_project_media({ sourcePath: source, root,
      category: 'voix-generees', projectDestination: storage });
    assert.equal(copied.path, path.join(root, 'voix-generees', 'Base (2)', 'source.wav'));
    const moves = await projectStorageDiskCommands.rename_project_folder({ root, old: 'Base', new: 'Nouveau', workId: storage.workId });
    assert.equal(moves.length, 2);
    assert.equal(await fs.readFile(path.join(root, 'voix-generees', 'Nouveau', 'source.wav'), 'utf8'), 'audio');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'images-generees', 'Autre', '.story-studio-dossier.json'), 'utf8')).workId, storage.workId);
    const originalFolders = Object.fromEntries(moves.map(({ from }) => [path.basename(path.dirname(from)), path.basename(from)]));
    await projectStorageDiskCommands.rename_project_folder({ root, old: 'Nouveau', new: 'Base', workId: storage.workId, originalFolders });
    assert.equal(await fs.readFile(copied.path, 'utf8'), 'audio');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

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

test('rollback restores the original name of each category after an interleaved collision', async () => {
  const storage = createProjectStorage();
  const moves = [
    { from: '/workspace/images-generees/Projet sans titre', to: '/workspace/images-generees/Azuro' },
    { from: '/workspace/voix-generees/Projet sans titre (2)', to: '/workspace/voix-generees/Azuro' },
  ];
  const calls = [];
  const transaction = await prepareProjectStorageSave({ project: { storage, projectName: 'Azuro' }, root: '/workspace',
    invokeCommand: async (command, args) => {
      calls.push({ command, args });
      return command === 'resolve_project_folder' ? args.folder : moves;
    },
  });
  try {
    await transaction.rollback();
    assert.deepEqual(calls.at(-1), { command: 'rename_project_folder', args: {
      root: '/workspace', old: 'Azuro', new: 'Projet sans titre', workId: storage.workId,
      originalFolders: { 'images-generees': 'Projet sans titre', 'voix-generees': 'Projet sans titre (2)' },
    } });
  } finally { transaction.release(); }
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
    const provisional = await invokeCommand('resolve_project_folder', { root, folder: storage.folder, workId: storage.workId, create: true, category: 'voix-generees' });
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

test('manual save and rollback accept one category or no media without creating absent categories', async () => {
  for (const withMedia of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-storage-lazy-'));
    const storage = createProjectStorage();
    const old = path.join(root, 'images-generees', storage.folder);
    try {
      if (withMedia) {
        await fs.mkdir(old, { recursive: true });
        await fs.writeFile(path.join(old, '.story-studio-dossier.json'), JSON.stringify({ version: 1, workId: storage.workId }));
        await fs.writeFile(path.join(old, 'image.png'), 'image');
      }
      const invokeCommand = (command, args) => projectStorageDiskCommands[command](args);
      const project = { storage, projectName: 'Azuro', rootEntries: [], rootImage: withMedia ? path.join(old, 'image.png') : '' };
      const transaction = await prepareProjectStorageSave({ project, root, invokeCommand });
      try {
        assert.equal(transaction.finalized, true);
        assert.equal(transaction.moves.length, withMedia ? 1 : 0);
        assert.deepEqual(await fs.readdir(root), withMedia ? ['images-generees'] : []);
        if (withMedia) assert.equal(await fs.readFile(transaction.project.rootImage, 'utf8'), 'image');
        await transaction.rollback();
        if (withMedia) assert.equal(await fs.readFile(path.join(old, 'image.png'), 'utf8'), 'image');
      } finally { transaction.release(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});
