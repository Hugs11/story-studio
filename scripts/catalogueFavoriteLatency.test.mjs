// Favori immédiat et conflit de révision : présentation sans JSON brut,
// rejeu unique d'un favori sur révisions fraîches, mise à jour optimiste,
// liste patchée sans rechargement complet, cartes non re-rendues quand elles
// n'ont pas changé.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueSelectionActions } = await import('../src/hooks/useCatalogueSelectionActions.js');
const { presentCatalogueError, toCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
const { presentUserMessage } = await import('../src/i18n/userMessage.js');
const { createReloadScheduler, entriesReducer, shareUnchangedCards } = await import('../src/store/catalogue/entriesState.js');
const { applyFavoriteOverrides, reconcileFavoriteOverrides, settleFavoriteOverrides, withFavoriteOverrides, withoutFavoriteOverrides, NO_FAVORITE_OVERRIDES } = await import('../src/store/catalogue/favoriteOverrides.js');
const { sameCardProps, stableCardView } = await import('../src/store/catalogue/cardRenderMemo.js');
const { memoizePipeline } = await import('../src/store/catalogue/pipeline.js');

const CONFLICT = { code: 'CATALOG_REVISION_CONFLICT', params: {} };

test('présentateur : un code traduit n’a jamais son enveloppe JSON pour détail', () => {
  for (const raw of [CONFLICT, JSON.stringify(CONFLICT), toCatalogueError(CONFLICT), toCatalogueError(JSON.stringify(CONFLICT))]) {
    const presented = raw instanceof Error ? presentCatalogueError(raw) : presentUserMessage(raw);
    assert.equal(presented.fallback, false);
    assert.equal(presented.technicalDetail, '');
    assert.doesNotMatch(presented.message, /\{"code"/);
  }
  // Code inconnu : message générique, détail = le code et les noms de ses paramètres, sans valeurs ni JSON.
  const unknown = presentCatalogueError(toCatalogueError({ code: 'CATALOG_NOT_A_REAL_CODE', params: { a: '/home/secret', b: 2 } }));
  assert.equal(unknown.fallback, true);
  assert.equal(unknown.technicalDetail, 'CATALOG_NOT_A_REAL_CODE (a, b)');
  assert.equal(presentUserMessage({ code: 'CATALOG_NOT_A_REAL_CODE', params: {} }).technicalDetail, 'CATALOG_NOT_A_REAL_CODE');
  // Détail fourni par le producteur : conservé ; détail lui-même codé : présenté.
  assert.equal(presentUserMessage({ ...CONFLICT, detail: 'disk' }).technicalDetail, 'disk');
  const nested = presentUserMessage({ code: 'CATALOG_STORE_ERROR', params: {}, detail: JSON.stringify(CONFLICT) });
  assert.equal(nested.technicalDetail, presentUserMessage(CONFLICT).message);
});

test('favori : conflit de révision rejoué une fois sur les révisions fraîches, sans erreur visible', async () => {
  const calls = []; const errors = []; const overrides = []; let reloads = 0;
  const cards = [{ id: 'a', ficheRevision: 2, favorite: false }, { id: 'b', ficheRevision: 5, favorite: false }];
  const fresh = { a: { favorite: false, ficheRevision: 3, catalogueRevision: 40 }, b: { favorite: true, ficheRevision: 6, catalogueRevision: 40 } };
  const api = {
    mutate: async (mutation, expected) => { calls.push({ mutation, expected }); if (calls.length === 1) throw CONFLICT; return { catalogueRevision: 41, affectedCardIds: mutation.ficheIds }; },
    getCard: async id => fresh[id],
  };
  const hook = runner(() => useCatalogueSelectionActions({ ids: ['a', 'b'], cards, visibleIds: ['a', 'b'], revision: 30, api,
    optimistic: { set: (ids, value) => overrides.push(['set', ids, value]), settle: (ids, value, revision) => overrides.push(['settle', ids, value, revision]), clear: (ids, value) => overrides.push(['clear', ids, value]) },
    onReload: () => { reloads++; }, onError: error => errors.push(error) }));
  const outcome = await hook.render().favorite();
  assert.equal(outcome.catalogueRevision, 41);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  // `b` est déjà favori : seul `a` est rejoué, sur sa révision fraîche, avec une nouvelle clé.
  assert.deepEqual(calls[1].mutation.ficheIds, ['a']);
  assert.deepEqual(calls[1].mutation.expectedFicheRevisions, { a: 3 });
  assert.notEqual(calls[1].mutation.requestKey, calls[0].mutation.requestKey);
  // Validé : la valeur optimiste reste jusqu'à ce que la liste atteigne la révision 41.
  assert.deepEqual(overrides, [['set', ['a', 'b'], true], ['settle', ['a', 'b'], true, 41]]);
  assert.equal(reloads, 1);
  hook.unmount();
});

test('favori : un second conflit remonte, l’étoile optimiste est retirée', async () => {
  const errors = []; const overrides = []; let reloads = 0;
  const hook = runner(() => useCatalogueSelectionActions({ ids: ['a'], cards: [{ id: 'a', ficheRevision: 1, favorite: true }], visibleIds: ['a'], revision: 1,
    api: { mutate: async () => { throw CONFLICT; }, getCard: async () => ({ favorite: true, ficheRevision: 2, catalogueRevision: 3 }) },
    optimistic: { set: (...args) => overrides.push(['set', ...args]), settle: (...args) => overrides.push(['settle', ...args]), clear: (...args) => overrides.push(['clear', ...args]) },
    onReload: () => { reloads++; }, onError: error => errors.push(error) }));
  assert.equal(await hook.render().favorite(), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'CATALOG_REVISION_CONFLICT');
  assert.deepEqual(overrides.map(entry => entry[0]), ['set', 'clear']);
  assert.equal(reloads, 1);
  hook.unmount();
});

test('favori : un résultat appliqué localement évite le rechargement complet', async () => {
  let reloads = 0; const applied = [];
  const hook = runner(() => useCatalogueSelectionActions({ ids: ['a'], cards: [{ id: 'a', ficheRevision: 1, favorite: false }], visibleIds: ['a'], revision: 7,
    api: { mutate: async mutation => ({ catalogueRevision: 8, affectedCardIds: mutation.ficheIds }) },
    applyLocal: (mutation, outcome) => { applied.push([mutation.kind, mutation.value, outcome.catalogueRevision]); return true; },
    onReload: () => { reloads++; } }));
  assert.ok(await hook.render().favorite());
  assert.deepEqual(applied, [['setFavorite', true, 8]]);
  assert.equal(reloads, 0);
  hook.unmount();
});

test('liste : favori patché seulement sur la révision suivante, cartes inchangées conservées', () => {
  const a = { id: 'a', favorite: false, ficheRevision: 1 }; const b = { id: 'b', favorite: false, ficheRevision: 4 };
  const ready = { status: 'ready', cards: [a, b], revision: 10, error: null, reloading: false };
  const patched = entriesReducer(ready, { type: 'favoritePatched', ids: ['a'], value: true, revision: 11 });
  assert.equal(patched.revision, 11);
  assert.deepEqual(patched.cards[0], { id: 'a', favorite: true, ficheRevision: 2 });
  assert.equal(patched.cards[1], b, 'la carte voisine garde son objet');
  assert.equal(entriesReducer(ready, { type: 'favoritePatched', ids: ['a'], value: true, revision: 12 }), ready, 'révision sautée : rechargement');
  assert.equal(entriesReducer({ ...ready, reloading: true }, { type: 'favoritePatched', ids: ['a'], value: true, revision: 11 }).revision, 10);
  // Rechargement identique : même tableau ; une carte modifiée seule change d'objet.
  const same = entriesReducer(ready, { type: 'loadSucceeded', cards: [{ ...a }, { ...b }], revision: 10 });
  assert.equal(same.cards, ready.cards);
  const one = shareUnchangedCards(ready.cards, [{ ...a, favorite: true }, { ...b }]);
  assert.notEqual(one[0], a); assert.equal(one[1], b);
});

test('rechargement : l’événement de sa propre écriture est absorbé par le patch local', async () => {
  const timers = []; let runs = 0;
  const scheduler = createReloadScheduler({ run: async () => { runs++; return 10; }, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: id => { timers[id - 1] = null; } });
  await scheduler.now();
  assert.equal(runs, 1);
  scheduler.request(11);
  scheduler.markLoaded(11);
  assert.ok(timers.every(fn => fn === null), 'rechargement en attente annulé');
  assert.equal(scheduler.request(11), false);
  // Une demande plus récente que le patch survit.
  scheduler.request(12); scheduler.markLoaded(11);
  assert.ok(timers.some(Boolean));
  scheduler.dispose();
});

test('rechargement en cours : pas de patch local, et la révision chargée ne recule jamais', async () => {
  const timers = []; let release; let runs = 0;
  const scheduler = createReloadScheduler({
    run: () => { runs++; return runs === 1 ? 10 : new Promise(resolve => { release = resolve; }); },
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: id => { timers[id - 1] = null; },
  });
  await scheduler.now();
  assert.equal(scheduler.isRunning(), false);
  const late = scheduler.now();
  assert.equal(scheduler.isRunning(), true, 'visible dès le lancement, avant tout dispatch');
  // Un patch accepté ailleurs porte la liste à 11 ; le chargement lancé avant rend 10.
  scheduler.markLoaded(11);
  release(10); await late;
  assert.equal(scheduler.request(11), false, 'la révision 11 reste chargée');
  assert.equal(scheduler.request(12), true);
  scheduler.dispose();
});

test('liste : patchFavorite refusé pendant un chargement, accepté ensuite', async () => {
  const { useCatalogueEntries } = await import('../src/hooks/useCatalogueEntries.js');
  let release;
  const page = cards => ({ cards, revision: 10 });
  const api = { listAllEntries: () => new Promise(resolve => { release = resolve; }), subscribeChanges: () => () => {} };
  const hook = runner(() => useCatalogueEntries({ api }));
  let entries = hook.render(); hook.flush();
  // Premier chargement en cours : aucun patch.
  assert.equal(entries.patchFavorite({ ids: ['a'], value: true, revision: 11 }), false);
  await new Promise(resolve => setTimeout(resolve, 0));
  release(page([{ id: 'a', favorite: false, ficheRevision: 1 }])); await new Promise(resolve => setTimeout(resolve, 0));
  entries = hook.render();
  assert.equal(entries.revision, 10);
  assert.equal(entries.patchFavorite({ ids: ['a'], value: true, revision: 11 }), true);
  entries = hook.render();
  assert.equal(entries.revision, 11); assert.equal(entries.cards[0].favorite, true);
  // Un rechargement démarre : un nouveau patch est refusé, l'appelant relit.
  void entries.refresh();
  assert.equal(entries.patchFavorite({ ids: ['a'], value: false, revision: 12 }), false);
  await new Promise(resolve => setTimeout(resolve, 0));
  release(page([{ id: 'a', favorite: true, ficheRevision: 2 }])); await new Promise(resolve => setTimeout(resolve, 0));
  hook.unmount();
});

test('favoris optimistes : retirés au refus, gardés après validation jusqu’à ce que la liste les porte', () => {
  const card = { id: 'a', favorite: false }; const other = { id: 'b', favorite: true };
  const set = withFavoriteOverrides(NO_FAVORITE_OVERRIDES, ['a'], true);
  const shown = applyFavoriteOverrides([card, other], set);
  assert.equal(shown[0].favorite, true); assert.equal(shown[1], other);
  assert.equal(withoutFavoriteOverrides(set, ['a'], false), set);
  assert.equal(withoutFavoriteOverrides(set, ['a'], true).size, 0);
  // En vol : une liste relue avec l'ancienne valeur ne l'efface pas.
  assert.equal(reconcileFavoriteOverrides(set, [card], 50), set);
  // Validé en révision 11 alors qu'un rechargement plus ancien est en cours :
  // la liste de révision 10 (ancienne valeur) garde l'étoile, un second clic lit donc `true`.
  const settled = settleFavoriteOverrides(set, ['a'], true, 11);
  assert.equal(withoutFavoriteOverrides(settled, ['a'], true), settled, 'un geste validé ne se retire plus');
  const stale = reconcileFavoriteOverrides(settled, [card], 10);
  assert.equal(applyFavoriteOverrides([card], stale)[0].favorite, true);
  // La liste atteint la révision validée, ou porte la valeur : la valeur optimiste disparaît.
  assert.equal(reconcileFavoriteOverrides(settled, [card], 11).size, 0);
  assert.equal(reconcileFavoriteOverrides(settleFavoriteOverrides(set, ['a'], true, null), [{ ...card, favorite: true }], 10).size, 0);
  assert.equal(reconcileFavoriteOverrides(settled, [], 10).size, 0, 'fiche sortie de la liste');
});

test('cartes mémoïsées : seule la carte qui change est re-rendue, les gestes vont au dernier rendu', () => {
  const card = { id: 'a' }; const item = { card };
  const latest = { current: null }; const cache = new Map(); const clicks = [];
  const raw = (activeId, selected, tag) => ({ activeId, selected: new Set(selected), expanded: new Set(), luniiFicheIds: new Set(), dataBusy: false, window: { tag },
    onItemClick: () => clicks.push(tag) });
  const render = (view) => { latest.current = view; return stableCardView(view, latest, cache); };
  const first = render(raw('z', [], 1)); const second = render(raw('y', ['other'], 2));
  assert.ok(sameCardProps({ item, index: 0, view: first }, { item, index: 0, view: second }), 'activité, sélection et fenêtre d’autres cartes ignorées');
  first.onItemClick();
  assert.deepEqual(clicks, [2], 'le gestionnaire stable appelle celui du dernier rendu');
  const third = render(raw('a', [], 3));
  assert.equal(sameCardProps({ item, index: 0, view: second }, { item, index: 0, view: third }), false);
  assert.equal(sameCardProps({ item, index: 0, view: third }, { item: { card }, index: 0, view: third }), false);
  const busy = render({ ...raw('a', [], 3), dataBusy: true });
  assert.equal(sameCardProps({ item, index: 0, view: third }, { item, index: 0, view: busy }), false);
});

test('pipeline : les éléments des fiches inchangées gardent leur objet', () => {
  const pipeline = memoizePipeline();
  const exemplar = { id: 'e', sourceIds: ['s'] };
  const a = { id: 'a', title: 'A', exemplars: [exemplar] }; const b = { id: 'b', title: 'B', exemplars: [] };
  const first = pipeline([a, b]).items;
  const second = pipeline([{ ...a, favorite: true }, b]).items;
  const byId = list => new Map(list.map(item => [item.card.id, item]));
  assert.notEqual(byId(second).get('a'), byId(first).get('a'));
  assert.equal(byId(second).get('b'), byId(first).get('b'));
});
