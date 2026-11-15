// Les noms d'assets ZIP ne sont pas des fichiers à copier à l'enregistrement.
// Les jaquettes externes restent des références de fichiers du projet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const harness = await createDiskHarness({ commands: {} });
const io = await import('../src/store/projectIO.js');
const { createZipEntry, normalizeProjectData } = await import('../src/store/projectModel.js');
const { shouldAbortEphemeralPromotion } = await import('../src/store/projectHelpers.js');

test.after(() => harness.dispose());

test('ZIP catalogue covers survive relative serialization and resolution without changing asset names', async () => {
  const { relativizeProjectMediaPaths, resolveProjectMediaPaths } = await import('../src/store/projectMediaPaths.js');
  const { walkProjectMediaReferences } = await import('../src/store/projectModel/index.js');
  const project = normalizeProjectData({
    projectType: 'pack',
    rootEntries: [
      createZipEntry({ zipPath: '/project/pack.zip', coverImage: '/project/cover.png', coverAudio: '/project/cover.mp3' }),
      createZipEntry({ zipPath: '/project/other.zip', coverImage: 'c0ffee.bmp', coverAudio: 'c0ffee.mp3' }),
    ],
  });
  const serialized = relativizeProjectMediaPaths(project, '/project');
  assert.equal(serialized.rootEntries[0].coverImage, './cover.png');
  assert.equal(serialized.rootEntries[0].coverAudio, './cover.mp3');
  const reopened = resolveProjectMediaPaths(serialized, '/moved');
  assert.equal(reopened.rootEntries[0].coverImage, '/moved/cover.png');
  assert.equal(reopened.rootEntries[0].coverAudio, '/moved/cover.mp3');
  assert.equal(reopened.rootEntries[1].coverImage, 'c0ffee.bmp');
  assert.equal(reopened.rootEntries[1].coverAudio, 'c0ffee.mp3');
  assert.deepEqual([...walkProjectMediaReferences(reopened)].map(ref => ref.path), [
    '/moved/pack.zip', '/moved/cover.png', '/moved/cover.mp3', '/moved/other.zip',
  ]);
});

test('saving_a_project_with_a_zip_node_copies_only_real_files', async () => {
  const saveDir = await harness.mkdirp('projet');
  const savePath = `${saveDir}/Mon agrégat.mbah`;
  // Le ZIP est déjà dans le dossier du projet : il n'y a plus rien à copier.
  const zip = await harness.writeFile('projet/fichiers-importes/pack-a.zip', 'synthetic ZIP bytes');
  const project = normalizeProjectData({
    projectType: 'pack',
    projectName: 'Mon agrégat',
    rootEntries: [createZipEntry({ name: 'Pack A', zipPath: zip, coverImage: 'c0ffee.bmp', coverAudio: 'c0ffee.mp3' })],
  });
  const attempted = [];
  const transfer = await io.transferProjectFilesToProject(project, savePath, async (source) => {
    attempted.push(source);
    return io.copyMediaToWorkspace(source, saveDir, undefined, 'Mon agrégat');
  });
  // Les candidats que la question « copier dans le projet ? » listerait.
  const candidates = io.collectTransferableProjectFiles(project, savePath).map((candidate) => candidate.filename);
  // Premier enregistrement d'un nouveau projet (session éphémère) : une seule
  // erreur de copie annule tout l'enregistrement (useSaveProgress.js:558).
  const aborted = shouldAbortEphemeralPromotion({ isEphemeralSession: true, transferErrors: transfer.errors });
  assert.deepEqual(
    { candidates, attempted, errors: transfer.errors.map((error) => error.path), aborted },
    { candidates: [], attempted: [], errors: [], aborted: false },
  );
});
