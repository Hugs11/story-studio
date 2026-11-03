import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import fixture from './fixtures/catalogue/assembly-preparation.json' with { type: 'json' };
const { useCatalogueAssembly } = await import('../src/hooks/useCatalogueAssembly.js');

for (const dispose of ['close', 'unmount']) {
  test(`ready assembly ${dispose} releases media even when the old operation has expired`, async () => {
    const released = [];
    let cancellations = 0;
    const api = {
      prepare: async () => ({ operationId: 'old-operation' }),
      operation: async () => ({ status: 'success', result: fixture }),
      cancel: async () => { cancellations++; throw { code: 'CATALOG_OPERATION_EXPIRED', params: {} }; },
      release: async id => { released.push(id); return { released: true }; },
    };
    const app = runner(() => useCatalogueAssembly(api));
    let assembly = app.render();
    app.flush();
    await assembly.start([{ ficheId: 'entry', expectedFicheRevision: 1 }]);
    assembly = app.render();
    assert.equal(assembly.state.phase, 'ready');
    if (dispose === 'close') {
      await assembly.close();
      assembly = app.render();
      assert.equal(assembly.state.phase, 'idle');
      await assembly.close();
      app.unmount();
    } else app.unmount();
    assert.equal(cancellations, 0);
    assert.deepEqual(released, [fixture.preparationId]);
  });
}
