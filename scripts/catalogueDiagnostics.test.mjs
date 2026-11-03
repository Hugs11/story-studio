import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import page from './fixtures/catalogue/duplicates-page.json' with { type: 'json' };
import entry from './fixtures/catalogue/checker-entry.json' with { type: 'json' };
import { createTestI18n } from './i18nTestSetup.mjs';
import { createCatalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';
import { presentCatalogueError } from '../src/store/catalogue/catalogueApi.js';
import { appendDuplicatePage, checkerOutputDirectory, checkerAvailability, checkerEntry, duplicatePage, emptyDuplicateResults } from '../src/store/catalogue/duplicateModel.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { createCheckerPreparationLifetime } from '../src/store/catalogue/checkerPreparation.js';
import { exemplarActions, cardMenuActions } from '../src/store/catalogue/cardActions.js';

test('handwritten diagnostic DTOs and all new IPC arguments', async () => {
  assert.deepEqual(duplicatePage(page), page); assert.deepEqual(checkerEntry(entry), entry);
  assert.throws(() => duplicatePage({ ...page, cursor: -1 }));
  assert.throws(() => duplicatePage({ ...page, exactGroups: [{}] }));
  assert.throws(() => checkerEntry({ ...entry, source: {} }));
  const calls = [];
  const api = createCatalogueFilesApi({ invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'catalogue_get_duplicate_results') return page;
    if (command === 'catalogue_prepare_checker_entry') return entry;
    return { released: true };
  } });
  await api.findDuplicates({ ficheId: 'card' }, 'request');
  assert.deepEqual(await api.duplicateResults('operation', 2, 20), page);
  assert.deepEqual(await api.prepareChecker('pack-a', 12), entry);
  assert.deepEqual(await api.releaseChecker('preparation-a'), { released: true });
  assert.deepEqual(calls, [
    { command: 'catalogue_find_duplicates', args: { scope: { ficheId: 'card' }, requestId: 'request' } },
    { command: 'catalogue_get_duplicate_results', args: { operationId: 'operation', offset: 2, limit: 20 } },
    { command: 'catalogue_prepare_checker_entry', args: { exemplarId: 'pack-a', expectedRevision: 12 } },
    { command: 'catalogue_release_checker_entry', args: { preparationId: 'preparation-a' } },
  ]);
});
test('pagination preserves exact equality and lower versions as separate diagnostics', () => {
  const first = appendDuplicatePage(emptyDuplicateResults(), { ...page, cursor: 3 });
  const next = appendDuplicatePage(first, page);
  assert.equal(next.exactGroups.length, 2); assert.equal(next.olderVersions.length, 2);
  assert.equal(next.issues.length, 2); assert.equal(next.cursor, null);
  assert.equal(first.exactGroups.length, 1);
});
test('preparation survives correction and reanalysis after the owner closes', async () => {
  let releases = 0; const life = createCheckerPreparationLifetime(() => { releases += 1; });
  const close = life.retain(); const finishCorrection = life.beginTask(); const finishAnalysis = life.beginTask();
  close(); await Promise.resolve(); assert.equal(releases, 0);
  finishAnalysis(); await Promise.resolve(); assert.equal(releases, 0);
  finishCorrection(); finishCorrection(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1); assert.throws(() => life.beginTask());
});
test('effect setup and cleanup replay does not release a live preparation', async () => {
  let releases = 0; const life = createCheckerPreparationLifetime(() => { releases += 1; });
  life.retain()(); const close = life.retain();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(releases, 0);
  close(); close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(releases, 1);
});
test('native task failures still release the preparation when the owner closes', async () => {
  const failures = []; const life = createCheckerPreparationLifetime(async () => { throw new Error('release'); }, error => failures.push(error.message));
  const close = life.retain(); const finish = life.beginTask();
  try { throw new Error('analysis'); } catch { finish(); }
  close(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(failures, ['release']);
});
test('checker targets one available pack, with children and technical folder formats', () => {
  for (const format of ['zip', '7z', 'studioDirectory', 'fsDirectory']) {
    assert.equal(checkerAvailability({ format, state: 'available' }).enabled, true);
    assert.equal(checkerAvailability({ format: 'folder', technicalFormat: format, member: 'pack', state: 'available' }).enabled, true);
    assert.equal(checkerAvailability({ format, state: 'missing' }).enabled, false);
    assert.equal(checkerAvailability({ format, state: 'available', availability: 'unavailable' }).enabled, false);
  }
  assert.equal(checkerAvailability({ format: 'project', state: 'available' }).enabled, false);
  const exemplar = { id: 'e', format: 'zip', state: 'available', available: true, path: '/packs/a.zip' };
  assert.equal(exemplarActions({}, exemplar).find(a => a.id === 'checkPack').enabled, true);
  assert.equal(cardMenuActions({}, [exemplar]).find(a => a.id === 'duplicates'), undefined, 'FICHEB: duplicates move to fiche overflow menu');
  // Aucun exemplaire de format vérifiable (aucun, ou projet seul) : l'entrée est masquée, pas grisée.
  assert.equal(cardMenuActions({}, []).find(a => a.id === 'checkPack'), undefined);
  assert.equal(cardMenuActions({}, [{ id: 'p', format: 'project', state: 'available' }]).find(a => a.id === 'checkPack'), undefined);
  // Un pack présent mais indisponible garde l'entrée, désactivée avec sa raison.
  assert.equal(cardMenuActions({}, [{ id: 'm', format: 'zip', state: 'missing' }]).find(a => a.id === 'checkPack').enabled, false);
  assert.equal(cardMenuActions({}, [{ id: 'p', format: 'project', state: 'available' }, exemplar]).find(a => a.id === 'checkPack').enabled, true);
});
test('typed diagnostic failures are presentable in FR, EN and IT', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const code of ['CATALOG_DUPLICATE_HASH_FAILED', 'CATALOG_CHECKER_PREPARATION_FAILED']) {
      const api = createCatalogueFilesApi({ invoke: async () => { throw { code, params: {} }; } });
      await assert.rejects(api.prepareChecker('e', 1), error => {
        assert.equal(error.code, code); assert.doesNotMatch(presentCatalogueError(error).message, /\[object Object\]|^CATALOG_|rust:/); return true;
      });
    }
  }
});

test('checker output chooser keeps POSIX, drive and UNC roots intact', () => {
  for (const [path, expected] of [['/pack.zip', '/'], ['C:\\pack.zip', 'C:\\'], ['\\\\server\\share\\pack.zip', '\\\\server\\share\\']]) {
    assert.equal(checkerOutputDirectory({ source: { path } }), expected);
  }
});

test('completed diagnostics have an explicit idempotent release IPC', async () => {
  const calls = [];
  const api = createCatalogueFilesApi({ invoke: async (command, args) => { calls.push({ command, args }); return { released: true }; } });
  assert.deepEqual(await api.releaseDuplicateResults('operation'), { released: true });
  assert.deepEqual(calls, [{ command: 'catalogue_release_duplicate_results', args: { operationId: 'operation' } }]);
});

test('normalized exemplars from unavailable sources cannot enter the checker', () => {
  const card = normalizeEntry({ id: 'offline-card', exemplars: [{ id: 'offline', format: 'zip', state: 'available', availability: 'unavailable', locator: { path: '/offline/pack.zip' } }] });
  const [exemplar] = card.exemplars;
  assert.equal(exemplar.state, 'available');
  assert.equal(exemplar.available, false);
  assert.equal(Object.hasOwn(exemplar, 'availability'), false);
  const availability = checkerAvailability(exemplar);
  assert.equal(availability.enabled, false);
  assert.equal(availability.reasonKey, 'catalogue:diagnostics.checkerUnavailable');
  assert.equal(exemplarActions({}, exemplar).find(action => action.id === 'checkPack').enabled, false);
  assert.equal(cardMenuActions({}, [exemplar]).find(action => action.id === 'checkPack').enabled, false);
});
