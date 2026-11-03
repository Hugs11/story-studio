import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/file-plan.json' with { type: 'json' };
import { filePlan } from '../src/store/catalogue/filePlan.js';
import { createCatalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';
test('manual DTO and exact IPC arguments, typed errors', async () => {
  const calls = [];
  const api = createCatalogueFilesApi({ invoke: async (command, args) => { calls.push({ command, args }); return command.includes('plan_') ? fixture : { operationId: 'op', state: 'queued' }; } });
  const targets = [{ ficheId: 'fiche-a', exemplarId: 'exemplar-a', expectedRevision: 12 }];
  const options = { destination: '/exports' };
  assert.deepEqual(await api.plan(targets, options, 'trash'), fixture);
  assert.deepEqual(calls[0], { command: 'catalogue_plan_file_operation', args: { action: 'trash', targets, options } });
  const decisions = { summaryValidated: true, skipExemplarIds: [] };
  await api.start(fixture.planId, decisions, 'request');
  assert.deepEqual(calls[1].args, { planId: fixture.planId, decisions, requestId: 'request' });
  const failing = createCatalogueFilesApi({ invoke: async () => { throw { code: 'CATALOG_FILE_SOURCE_CHANGED', params: {} }; } });
  await assert.rejects(failing.start('p', decisions, 'r'), e => e.code === 'CATALOG_FILE_SOURCE_CHANGED');
  assert.throws(() => filePlan({ ...fixture, targets: [{}] }));
});
test('name conflict, conversion and file publication errors retain typed translations', async () => {
  const { createTestI18n } = await import('./i18nTestSetup.mjs');
  const { presentCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
  const { default: i18next } = await import('i18next');
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const code of ['CATALOG_FILE_NAME_CONFLICT', 'CATALOG_FILE_CONVERSION_FAILED', 'CATALOG_FILE_PUBLICATION_UNAVAILABLE', 'CATALOG_DELETE_FAILED']) {
      const api = createCatalogueFilesApi({ invoke: async () => { throw { code, params: {} }; } });
      await assert.rejects(api.plan([], {}), error => {
        assert.equal(error.code, code);
        const { message } = presentCatalogueError(error);
        assert.ok(message);
        assert.doesNotMatch(message, /\[object Object\]|^CATALOG_|rust:/);
        return true;
      });
    }
  }
});
