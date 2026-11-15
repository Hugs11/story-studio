import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createCacheFixture } from './projectMediaCacheFixture.mjs';

test('snapshot_keeps_a_durable_extracted_cover', async () => {
  const disk = await createDiskHarness();
  try {
    const fixture = await createCacheFixture(disk.root, 'recovery');
    assert.equal(await disk.exists(fixture.durableMedia), true);
    assert.notEqual((JSON.parse(await fs.readFile(fixture.path, 'utf8'))).rootEntries[0].itemImage.replaceAll('\\', '/'), fixture.media);
  } finally { await disk.dispose(); }
});

test('saved_download_must_not_reference_the_purgeable_cache_after_copy_failure', async () => {
  const disk = await createDiskHarness();
  try {
    const fixture = await createCacheFixture(disk.root, 'saved-download');
    const written = JSON.parse(await fs.readFile(fixture.path, 'utf8'));
    assert.notEqual(written.rootEntries[0].audio.replaceAll('\\', '/'), fixture.media,
      'un import annoncé réussi et enregistré ne doit pas dépendre du cache podcast purgeable');
  } finally { await disk.dispose(); }
});
