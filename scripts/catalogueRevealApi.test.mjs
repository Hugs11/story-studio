import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/reveal.json' with { type: 'json' };
import { createCatalogueApi, presentCatalogueError } from '../src/store/catalogue/catalogueApi.js';
test('reveal fixture, exact target/revision and report-path adapter', async () => {
  const calls = [];
  const api = createCatalogueApi({ listen: async () => () => {}, invoke: async (command, args) => { calls.push({ command, args }); return fixture; } });
  assert.deepEqual(await api.revealExemplar({ exemplarId: 'child', expectedRevision: 7 }), fixture);
  assert.deepEqual(await api.revealPath('/Packs/broken.zip'), fixture);
  assert.deepEqual(calls, [{ command: 'catalogue_reveal_exemplar', args: { exemplarId: 'child', expectedRevision: 7 } }, { command: 'catalogue_reveal_path', args: { path: '/Packs/broken.zip' } }]);
});
for (const code of ['CATALOG_FILE_DISAPPEARED', 'CATALOG_TARGET_REVISION_CHANGED']) test(`${code} is presentable`, async () => {
  const api = createCatalogueApi({ listen: async () => () => {}, invoke: async () => { throw { code, params: { path: '/gone' } }; } });
  await assert.rejects(api.revealExemplar({ exemplarId: 'x', expectedRevision: 0 }), error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(presentCatalogueError(error).message, /\[object Object\]|rust:/);
    return true;
  });
});
