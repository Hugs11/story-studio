import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUndo, undoState } from '../src/store/catalogue/undoState.js';
import { createCatalogueDataApi } from '../src/store/catalogue/catalogueDataApi.js';
test('undo token replacement, unrelated outcome, conflict and expiry', () => {
 let state = undoState(emptyUndo(), { type: 'outcome', outcome: { undoToken: 'one' } });
 state = undoState(state, { type: 'outcome', outcome: {} }); assert.equal(state.token, 'one');
 state = undoState(state, { type: 'outcome', outcome: { undoToken: 'two' } }); assert.equal(state.token, 'two');
 state = undoState(state, { type: 'error', error: { code: 'CATALOG_UNDO_CONFLICT', userMessage: { params: { conflicts: ['language'] } } } });
 assert.equal(state.status, 'conflict'); assert.deepEqual(state.conflicts, ['language']);
 state = undoState(state, { type: 'error', error: { code: 'CATALOG_UNDO_EXPIRED' } }); assert.equal(state.token, null);
});
test('legacy read IPC contracts remain available without a catalogue surface', async () => {
 const calls = []; const api = createCatalogueDataApi({ invoke: async (...args) => { calls.push(args); return {}; } });
 await api.listUnreferenced({ limit: 20, cursor: null }); await api.previewForget(['a']); await api.lastUndo();
 assert.deepEqual(calls, [['catalogue_list_unreferenced', { limit: 20, cursor: null }], ['catalogue_preview_forget', { ficheIds: ['a'] }], ['catalogue_last_undo', undefined]]);
});
test('handwritten 4c mutation IPC contract passes every tagged payload intact', async () => {
 const { readFile } = await import('node:fs/promises');
 const variants = JSON.parse(await readFile(new URL('./fixtures/catalogue/mutations-4c.json', import.meta.url)));
 const calls = []; const api = createCatalogueDataApi({ invoke: async (...args) => { calls.push(args); return { catalogueRevision: 8, affectedCardIds: ['a'], undoToken: 'opaque-token' }; } });
 for (const mutation of variants) await api.mutate(mutation, 7);
 assert.deepEqual(calls, variants.map(mutation => ['catalogue_mutate', { mutation, expectedCatalogueRevision: 7 }]));
});
