import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_OPERATIONS, operationIssueItems, operationReducer, recentOperations } from '../src/store/catalogue/operationView.js';

const snapshot = (i, extra = {}) => ({ operationId: `op-${i}`, timestamp: i, sequence: 1, status: 'success', outcomes: { updated: 1 }, ...extra });
const deliver = (state, value, ids) => operationReducer(state, { type: 'snapshot', snapshot: value, retainedOperationIds: ids });

test('empty issue journals do not repeat the summary error except for repatriation', () => {
  const error = { code: 'CATALOG_STORE_UNAVAILABLE' };
  const options = { summaryErrorVisible: true };
  for (const operationKind of [undefined, 'trash', 'luniiSend', 'assembly', 'catalogueImport']) {
    assert.deepEqual(operationIssueItems({ items: [], error }, { operationKind, error }, options), []);
  }
  const transferError = { code: 'STORYTELLER_STORY_UNREADABLE' };
  assert.deepEqual(operationIssueItems({ items: [] }, { operationKind: 'luniiRepatriate', error: transferError }, options),
    // A title that was never remembered (restart, evicted entry) is unknown, not untitled.
    [{ path: '', outcome: 'refused', detail: transferError }]);
  const items = [{ path: '/pack.zip', outcome: 'refused', detail: error }];
  assert.equal(operationIssueItems({ items }, { error }, options), items);
  assert.deepEqual(operationIssueItems({ items: [], error }, {}, { summaryErrorVisible: false }),
    [{ path: '', outcome: 'refused', detail: error }], 'an error absent from the summary must remain visible');
});

test('summary deduplication preserves a distinct report error', () => {
  const error = { code: 'CATALOG_STORE_UNAVAILABLE', detail: 'snapshot detail' };
  const options = { summaryErrorVisible: true };
  assert.deepEqual(operationIssueItems({ items: [], error: { ...error } }, { error }, options), []);
  for (const reportError of [{ ...error, detail: 'report detail' }, { code: 'CATALOG_OPERATION_EXPIRED' }, 'different report error']) {
    assert.deepEqual(operationIssueItems({ items: [], error: reportError }, { error }, options),
      [{ path: '', outcome: 'refused', detail: reportError }]);
  }
});

test('500 completed dismissals keep bounded snapshots and markers, and reject late events', () => {
  let state = INITIAL_OPERATIONS;
  let ids;
  for (let i = 0; i < 500; i++) {
    ids = Array.from({ length: Math.min(i + 1, 32) }, (_, k) => `op-${i - k}`);
    state = deliver(state, snapshot(i), ids);
    state = operationReducer(state, { type: 'dismiss', id: `op-${i}` });
  }
  assert.equal(Object.keys(state.items).length, 20);
  assert.equal(Object.keys(state.dismissed).length, 20);
  assert.ok(Object.keys(state.retired).length <= 32);
  assert.equal(recentOperations(state).length, 20);
  for (const i of [0, 468, 479]) {
    const before = state;
    state = deliver(state, snapshot(i, { sequence: 999, timestamp: 9999 }), ids);
    assert.deepEqual(state, before, 'neither expired nor still registered retired IDs reappear');
    state = deliver(state, snapshot(i, { status: 'running', sequence: 998 }), ids);
    assert.deepEqual(state, before, 'a late progress event cannot revive a retired operation');
  }
});

test('active operations and retained send completions survive history eviction', () => {
  let state = deliver(INITIAL_OPERATIONS, snapshot('active', { status: 'running', timestamp: -1 }), ['op-active']);
  state = operationReducer(state, { type: 'retain', id: 'op-send' });
  state = deliver(state, snapshot('send', { operationKind: 'luniiSend', timestamp: 0 }), ['op-active', 'op-send']);
  for (let i = 1; i <= 100; i++) state = deliver(state, snapshot(i), ['op-active', 'op-send', ...Array.from({ length: Math.min(i, 30) }, (_, k) => `op-${i - k}`)]);
  assert.equal(state.items['op-active'].status, 'running');
  assert.equal(state.items['op-send'].status, 'success', 'the send can still release its reservation');
  state = operationReducer(state, { type: 'release', id: 'op-send' });
  assert.equal(state.items['op-send'], undefined);
  assert.deepEqual(state.retained, {});
  assert.equal(state.items['op-active'].status, 'running');
});

test('pruning keeps the same latest twenty completed presentations without closing the selected report', () => {
  let state = INITIAL_OPERATIONS;
  for (let i = 0; i < 20; i++) state = deliver(state, snapshot(i), Array.from({ length: 32 }, (_, k) => `op-${k}`));
  state = operationReducer(state, { type: 'open', id: 'op-0' });
  state = deliver(state, snapshot(20), Array.from({ length: 32 }, (_, k) => `op-${k}`));
  assert.equal(state.selected, 'op-0');
  assert.ok(state.items['op-0']);
  assert.deepEqual(recentOperations(state).map(s => s.operationId), Array.from({ length: 20 }, (_, k) => `op-${20 - k}`));
});

test('a retained send receives its final event even after engine expiry', () => {
  let state = operationReducer(INITIAL_OPERATIONS, { type: 'retain', id: 'op-send' });
  state = deliver(state, snapshot('send', { status: 'running' }), ['op-send']);
  state = deliver(state, snapshot('send', { sequence: 2 }), []);
  assert.equal(state.items['op-send'].status, 'success');
});

test('late UI actions cannot accumulate markers for forgotten operations', () => {
  let state = INITIAL_OPERATIONS;
  for (let i = 0; i < 500; i++) {
    for (const type of ['closeTracker', 'dismiss', 'open']) state = operationReducer(state, { type, id: `expired-${i}` });
  }
  assert.deepEqual(state.hidden, {});
  assert.deepEqual(state.dismissed, {});
  assert.equal(state.selected, null);
});
