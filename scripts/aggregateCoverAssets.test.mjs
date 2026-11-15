// Les couvertures internes des packs ajoutés depuis l'Accueil restent des noms
// d'assets ZIP dans les deux destinations ; seuls les fichiers sont copiés.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const harness = await createDiskHarness({ commands: {} });
const { prepareAggregateLanding, copyAggregatePack } = await import('../src/components/AggregatePacks/aggregateLanding.js');
const io = await import('../src/store/projectIO.js');
const { defaultMetadataForPacks } = await import('../src/components/AggregatePacks/aggregateProject.js');

test.after(() => harness.dispose());

// Le pack tel que `addPackPaths` le fabrique pour une archive choisie sur le disque.
function packFromDisk(zip) {
  return { id: 'a', path: zip, fileName: 'pack-a.zip', name: 'Pack A', coverImage: 'c0ffee.bmp', coverAudio: 'c0ffee.mp3', packUuid: '', storyCount: 2, sizeBytes: 10 };
}

test('manual_aggregate_lands_in_editor_with_pack_cover_asset_names', async () => {
  const zip = await harness.writeFile('entrees/pack-a.zip', 'synthetic ZIP bytes');
  const rootAudio = await harness.writeFile('entrees/menu.mp3', 'root audio');
  const rootImage = await harness.writeFile('entrees/menu.png', 'root image');
  const packs = [packFromDisk(zip)];
  const workspaceDir = await harness.mkdirp('session-editor');
  const project = await prepareAggregateLanding({
    draft: { packs, rootAudio, rootImage, metadata: defaultMetadataForPacks(packs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') },
    workspaceDir,
    copy: (path, dir) => io.copyMediaToWorkspace(path, dir, undefined, 'Agrégat'),
  });
  assert.equal(project.rootEntries.length, 1);
});

test('manual_aggregate_direct_generation_preserves_pack_cover_asset_names', async () => {
  // Même préparation que la génération directe du funnel.
  const sessionDir = await harness.mkdirp('session-generate');
  const pack = packFromDisk(await harness.writeFile('entrees/pack-b.zip', 'synthetic ZIP bytes'));
  await copyAggregatePack(pack, path => io.copyMediaToWorkspace(path, sessionDir, undefined, 'Agrégat'));
});
