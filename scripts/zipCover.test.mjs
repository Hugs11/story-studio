import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

test('ZIP cover reads catalogue files locally and internal assets from the archive', async () => {
  const assetRequests = [];
  const harness = await createDiskHarness({ commands: {
    get_pack_asset: args => { assetRequests.push(args); return [90, 73, 80]; },
  } });
  Object.assign(window, {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
  });
  const { useZipCover } = await import('../src/components/editors/useZipCover.js');
  let image = await harness.writeFile('catalogue/cover.png', 'LOCAL');
  const zip = '/packs/source.zip';
  const hook = runner(() => useZipCover(zip, image));
  async function loadedCover() {
    hook.render();
    hook.flush();
    for (let i = 0; i < 100; i++) {
      await wait(5);
      const url = hook.render();
      if (url) return await (await fetch(url)).text();
    }
    assert.fail('cover did not load');
  }
  try {
    assert.equal(await loadedCover(), 'LOCAL');
    assert.deepEqual(assetRequests, []);
    image = 'c0ffee.bmp';
    assert.equal(await loadedCover(), 'ZIP');
    assert.deepEqual(assetRequests, [{ zipPath: zip, assetName: 'assets/c0ffee.bmp' }]);
  } finally {
    hook.unmount();
    await harness.dispose();
  }
});
