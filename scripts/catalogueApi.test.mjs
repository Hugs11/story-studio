// Adaptateur IPC du catalogue : fixture de contrat lue page par page,
// erreurs `UserMessage` présentables (jamais « [object Object] »), reprise
// du chargement quand l'index change, annulation, abonnement aux changements,
// état de chargement et regroupement des rechargements.

import test from 'node:test';
import assert from 'node:assert/strict';
import page from './fixtures/catalogue/entries-page.json' with { type: 'json' };
import { CatalogueError, createCatalogueApi, presentCatalogueError, toCatalogueError } from '../src/store/catalogue/catalogueApi.js';
import { createReloadScheduler, entriesReducer, entriesStatusLine, INITIAL_ENTRIES_STATE } from '../src/store/catalogue/entriesState.js';

const secondPage = (revision = 7) => ({ catalogueRevision: revision, items: [{ ...page.items[1], id: 'card-trois' }], totalMatching: 3, cursor: null });

function bridge(responses) {
  const calls = [];
  return {
    calls,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'catalogue_lunii_open') return null;
      const next = responses.shift();
      if (next instanceof Function) return next(args);
      if (next?.throws !== undefined) throw next.throws;
      return next;
    },
    listen: async () => () => {},
  };
}

test('la fixture de contrat est lue page par page et normalisée', async () => {
  const fake = bridge([page, secondPage()]);
  const result = await createCatalogueApi(fake).listAllEntries();
  assert.equal(result.revision, 7);
  assert.equal(result.restarts, 0);
  assert.deepEqual(result.cards.map((card) => card.id), ['card-lune', 'card-ours', 'card-trois']);
  assert.equal(result.cards[0].formats.join(','), 'project,zip');
  assert.deepEqual(fake.calls, [
    { command: 'catalogue_list_entries', args: { limit: 200, cursor: null, includeUnavailable: true } },
    { command: 'catalogue_list_entries', args: { limit: 200, cursor: '7:false:2:2', includeUnavailable: true } },
  ]);
});

test('curseur périmé : le chargement recommence sans erreur', async () => {
  const expired = { throws: { code: 'CATALOG_ENTRIES_CURSOR_EXPIRED', params: {} } };
  const fake = bridge([page, expired, { ...page, catalogueRevision: 8, cursor: '8:true:200:2' }, secondPage(8)]);
  const result = await createCatalogueApi(fake).listAllEntries();
  assert.equal(result.revision, 8);
  assert.equal(result.restarts, 1);
  assert.equal(result.cards.length, 3);
  assert.equal(fake.calls[2].args.cursor, null, 'reprise depuis le début');
});

test('révision différente entre deux pages : reprise', async () => {
  const fake = bridge([page, secondPage(9), { ...page, catalogueRevision: 9, cursor: '9:true:200:2' }, secondPage(9)]);
  const result = await createCatalogueApi(fake).listAllEntries();
  assert.equal(result.revision, 9);
  assert.equal(result.restarts, 1);
});

test('reprises bornées : une erreur codée finit par remonter', async () => {
  const expired = () => { throw JSON.stringify({ code: 'CATALOG_ENTRIES_CURSOR_EXPIRED', params: {} }); };
  const responses = [];
  for (let index = 0; index < 6; index += 1) responses.push(page, expired);
  await assert.rejects(createCatalogueApi(bridge(responses)).listAllEntries(), (error) => error instanceof CatalogueError && error.code === 'CATALOG_ENTRIES_CURSOR_EXPIRED');
});

test('erreur UserMessage : présentée par son code, jamais « [object Object] »', async () => {
  const fake = bridge([{ throws: { code: 'CATALOG_STORE_ERROR', params: {}, detail: 'disk I/O error' } }]);
  const error = await createCatalogueApi(fake).listAllEntries().catch((caught) => caught);
  assert.ok(error instanceof CatalogueError);
  assert.equal(error.code, 'CATALOG_STORE_ERROR');
  const presented = presentCatalogueError(error);
  assert.equal(presented.code, 'CATALOG_STORE_ERROR');
  assert.equal(presented.fallback, false);
  assert.equal(presented.technicalDetail, 'disk I/O error');
  assert.doesNotMatch(presented.message, /object Object/);
  assert.ok(presented.message.length > 0);
});

test('erreur transportée en chaîne JSON ou sans code : message générique et détail lisible', () => {
  const fromString = toCatalogueError(JSON.stringify({ code: 'CATALOG_OPERATION_EXPIRED', params: {} }));
  assert.equal(fromString.code, 'CATALOG_OPERATION_EXPIRED');
  assert.doesNotMatch(presentCatalogueError(fromString).message, /object Object/);
  for (const raw of [{ unexpected: true }, new Error('boom'), 'texte libre', null]) {
    const presented = presentCatalogueError(toCatalogueError(raw));
    assert.doesNotMatch(presented.message, /object Object/);
    assert.doesNotMatch(presented.technicalDetail, /object Object/);
    assert.equal(presented.fallback, true);
  }
});

test('annulation : le chargement s’interrompt entre deux pages', async () => {
  const controller = new AbortController();
  const fake = bridge([() => { controller.abort(); return page; }, secondPage()]);
  await assert.rejects(createCatalogueApi(fake).listAllEntries({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fake.calls.length, 1);
});

test('abonnement à catalogue-changed, désabonnement même avant l’installation', async () => {
  const received = [];
  let handler = null;
  let stopped = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const fake = {
    invoke: async () => null,
    listen: async (event, callback) => { assert.equal(event, 'catalogue-changed'); handler = callback; await ready; return () => { stopped += 1; }; },
  };
  const api = createCatalogueApi(fake);
  const early = api.subscribeChanges(() => {});
  early();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1, 'écoute arrêtée dès son installation');

  const unsubscribe = api.subscribeChanges((change) => received.push(change));
  await new Promise((resolve) => setImmediate(resolve));
  handler({ payload: { catalogueRevision: 12, scope: 'entries' } });
  assert.deepEqual(received, [{ revision: 12, scope: 'entries' }]);
  unsubscribe();
  handler({ payload: { catalogueRevision: 13, scope: 'entries' } });
  assert.equal(received.length, 1);
  assert.equal(stopped, 2);
});

test('état de chargement : un rechargement ne vide jamais les fiches', () => {
  const cards = [{ id: 'a' }];
  let state = entriesReducer(INITIAL_ENTRIES_STATE, { type: 'loadStarted' });
  assert.equal(state.status, 'loading');
  assert.deepEqual(entriesStatusLine(state), { key: 'catalogue:loading.state.loading', params: {} });
  state = entriesReducer(state, { type: 'loadSucceeded', cards, revision: 3 });
  assert.equal(entriesStatusLine(state), null);
  state = entriesReducer(state, { type: 'loadStarted' });
  assert.equal(state.status, 'ready');
  assert.equal(state.reloading, true);
  assert.equal(state.cards, cards);
  state = entriesReducer(state, { type: 'loadFailed', error: new Error('x') });
  assert.equal(state.status, 'ready');
  assert.equal(state.cards, cards);
  assert.deepEqual(entriesStatusLine(state), { key: 'catalogue:loading.state.stale', params: {} });
  const failed = entriesReducer(INITIAL_ENTRIES_STATE, { type: 'loadFailed', error: new Error('x') });
  assert.equal(failed.status, 'error');
  assert.deepEqual(entriesStatusLine(failed), { key: 'catalogue:loading.state.error', params: {} });
});

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (callback) => { const id = next++; timers.set(id, callback); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async flush() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) await callback();
    },
    get size() { return timers.size; },
  };
}

test('rechargements regroupés : une rafale = un chargement ; une demande pendant un chargement = un seul de plus', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let finish;
  const scheduler = createReloadScheduler({
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    run: () => { runs += 1; return new Promise((resolve) => { finish = resolve; }); },
  });
  scheduler.request(4); scheduler.request(5); scheduler.request(6);
  assert.equal(timers.size, 1);
  const flushing = timers.flush();
  assert.equal(runs, 1);
  scheduler.request(7); scheduler.request(8);
  finish(6);
  await flushing;
  assert.equal(timers.size, 1, 'un seul rechargement en attente');
  const second = timers.flush();
  assert.equal(runs, 2);
  finish(8);
  await second;
  assert.equal(scheduler.request(8), false, 'révision déjà chargée ignorée');
  assert.equal(scheduler.request(9), true);
  scheduler.dispose();
  assert.equal(timers.size, 0);
});

test('catalogue opening is separate from reloads and starts only once per opening', async () => {
  const fake = bridge([{ ...page, cursor: null }, { ...page, cursor: null }]);
  const api = createCatalogueApi(fake);
  await api.openCatalogue();
  await api.listAllEntries();
  await api.listAllEntries();
  assert.equal(fake.calls.filter(c => c.command === 'catalogue_lunii_open').length, 1);
});

test('catalogue unavailable uses the existing error presentation for sources, entries and file commands', async () => {
  const { createCatalogueFilesApi } = await import('../src/store/catalogue/catalogueFilesApi.js');
  const fr = (await import('../src/locales/fr/rust.json', { with: { type: 'json' } })).default;
  const unavailable = { code: 'CATALOG_STORE_UNAVAILABLE', params: {} };
  const fake = { invoke: async () => { throw unavailable; }, listen: async () => () => {} };
  const api = createCatalogueApi(fake);
  for (const call of [() => api.listSources(), () => api.listAllEntries(), () => createCatalogueFilesApi(fake).projectAccess('open', '/project.mbah')]) {
    await assert.rejects(call(), error => {
      assert.equal(error.code, unavailable.code);
      assert.equal(presentCatalogueError(error, { t: key => fr[key.replace('rust:', '')] }).message, fr.CATALOG_STORE_UNAVAILABLE);
      return true;
    });
  }
});
