import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dataActions } from '../src/store/catalogue/dataActions.js';
import { selectionActions } from '../src/store/catalogue/selectionActions.js';
import { tagCollision, tagSuggestions } from '../src/store/catalogue/tagSuggest.js';
import { filterControls } from '../src/store/catalogue/filterState.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { evaluateCard, normalizeFilters } from '../src/store/catalogue/filters.js';
import { pruneSelection, prunedAnnouncement, selectionReducer } from '../src/store/catalogue/selection.js';
import { createCatalogueDataApi } from '../src/store/catalogue/catalogueDataApi.js';
const entries = [
 { id: 'a', favorite: true, tagIds: ['t', 'u'], tags: [{ id: 't', label: 'Été' }, { id: 'u', label: 'Lune' }], exemplars: [{ format: 'zip', availability: 'available', sourceIds: ['s'] }] },
 { id: 'b', favorite: false, tagIds: ['t'], tags: [{ id: 't', label: 'Été' }], exemplars: [{ format: 'zip', availability: 'available', sourceIds: ['s'] }] },
 { id: 'c', favorite: true, tagIds: [], exemplars: [{ format: 'project', availability: 'available' }] },
];
const cards = entries.map(normalizeEntry);
test('data availability and ordered selection actions only contain visible targets', () => {
 assert.deepEqual(dataActions().map(action => [action.id, action.enabled, action.reasonKey]), ['favorite', 'tags'].map(id => [id, false, 'catalogue:data.noTarget']));
 const result = selectionActions(['a', 'b'], cards, ['b', 'c']);
 assert.deepEqual(result.targets.map(card => card.id), ['b']);
 assert.deepEqual(result.actions.map(action => action.id), ['favorite', 'tags']);
 assert.ok(result.actions.every(action => action.enabled));
 assert.equal(dataActions([cards[0]])[0].labelKey, 'catalogue:data.unfavorite');
 assert.ok(dataActions(cards, { busy: true }).every(action => !action.enabled && action.reasonKey === 'catalogue:data.busy'));
 assert.ok(selectionActions(['a'], cards, ['c']).actions.every(action => !action.enabled));
});
test('accent/case/ligature suggestions detect collisions, stable identity and no implicit merge', () => {
 const tags = [{ id: 't', label: 'Été  en forêt' }, { id: 'u', label: 'Cœur' }, { id: 'v', label: 'Lune' }];
 assert.equal(tagCollision(tags, ' ETE en FORET ').id, 't');
 assert.equal(tagCollision(tags, 'coeur').id, 'u');
 assert.equal(tagCollision(tags, 'coeur', 'u'), null);
 assert.deepEqual(tagSuggestions(tags, 'foret').map(tag => tag.id), ['t']);
 assert.equal(tags.length, 3); assert.equal(tags[0].label, 'Été  en forêt');
});
test('D74 (révisé) : les étiquettes sont toujours « au moins une », même si un mode all est restauré ; autres familles en OU', () => {
 const visible = filters => cards.filter(card => evaluateCard(card, normalizeFilters(filters))).map(card => card.id);
 assert.deepEqual(visible({ tags: { ids: ['t', 'u'] } }), ['a', 'b']);
 assert.deepEqual(visible({ tags: { ids: ['t', 'u'], mode: 'all' } }), ['a', 'b']);
 assert.deepEqual(visible({ tags: { ids: ['t', 'u'], mode: 'any' } }), ['a', 'b']);
 assert.deepEqual(visible({ favoritesOnly: true }), ['a', 'c']);
 assert.deepEqual(visible({ formats: ['zip', 'project'] }), ['a', 'b', 'c']);
 const controls = filterControls(cards); assert.ok(!controls.find(control => control.family === 'tags').unavailable);
 assert.deepEqual(cards[0].tagIds, ['t', 'u']);
});
test('pruning emits one grouped announcement and the next reconciliation is silent', () => {
 const original = { ids: ['a', 'b', 'c'], anchor: 'a' };
 const first = pruneSelection(original, ['c']); assert.deepEqual(first.removed, ['a', 'b']);
 assert.equal(prunedAnnouncement(first.removed).params.count, 2);
 const second = pruneSelection(first.selection, ['c']); assert.equal(prunedAnnouncement(second.removed), null);
 assert.deepEqual(selectionReducer(original, { type: 'prune', order: ['c'] }), { ids: ['c'], anchor: null });
});
test('additive organization IPC lists and all mutations preserve their wire shape and coded errors', async () => {
 const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/catalogue/organization.json', import.meta.url)));
 const calls = []; const api = createCatalogueDataApi({ invoke: async (command, args) => { calls.push({ command, args }); return command === 'catalogue_mutate' ? fixture.outcome : fixture.list; } });
 assert.deepEqual(await api.listTags(), fixture.list);
 for (const mutation of fixture.mutations) {
  assert.deepEqual(await api.mutate(mutation, 4), fixture.outcome);
  assert.deepEqual(calls.at(-1), { command: 'catalogue_mutate', args: { mutation, expectedCatalogueRevision: 4 } });
 }
 const error = createCatalogueDataApi({ invoke: async () => { throw { code: 'CATALOG_NAME_DUPLICATE', params: { label: 'ETE', existingId: 't' } }; } });
 await assert.rejects(error.listTags(), err => err.code === 'CATALOG_NAME_DUPLICATE' && err.userMessage.params.existingId === 't');
});

test('combobox keyboard transitions: boundaries, empty list, Escape and explicit suggestion', async () => {
 const { tagInputKey } = await import('../src/store/catalogue/tagInputState.js');
 let state = { open: false, active: -1 };
 state = tagInputKey(state, 'ArrowDown', 2); assert.deepEqual(state, { open: true, active: 0, command: null });
 state = tagInputKey(state, 'ArrowDown', 2); assert.equal(state.active, 1);
 state = tagInputKey(state, 'ArrowDown', 2); assert.equal(state.active, 1);
 assert.equal(tagInputKey(state, 'Enter', 2).command, 'suggestion');
 state = tagInputKey(state, 'Escape', 2); assert.equal(state.open, false);
 assert.equal(tagInputKey(state, 'Enter', 2).command, 'submit');
 assert.equal(tagInputKey(state, 'ArrowDown', 0).active, -1);
 assert.equal(tagInputKey(state, 'Tab', 2), null);
});

test('current catalogue excludes unreferenced cards but retains disconnected covered exemplars', async () => {
 const { currentCatalogueCards } = await import('../src/store/catalogue/entryModel.js');
 const disconnected = normalizeEntry({ id: 'offline', favorite: true, exemplars: [{ id: 'copy', sourceIds: ['active-source'], availability: 'unavailable' }] });
 const unreferenced = normalizeEntry({ id: 'orphan', favorite: true, exemplars: [{ id: 'copy', sourceIds: [] }] });
 assert.deepEqual(currentCatalogueCards([disconnected, unreferenced, normalizeEntry({ id: 'empty' })]).map(card => card.id), ['offline']);
});
