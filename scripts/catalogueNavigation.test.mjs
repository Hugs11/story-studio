import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateKey, pointerSelection, keepActive, columnsFromTops } from '../src/store/catalogue/listNavigation.js';
import { selectionReducer, EMPTY_SELECTION, prunedAnnouncement } from '../src/store/catalogue/selection.js';
const order = ['a', 'b', 'c', 'd', 'e', 'f'];
for (const [key, expected] of [['ArrowDown','d'], ['ArrowUp','a'], ['ArrowRight','c'], ['ArrowLeft','a'], ['Home','a'], ['End','f'], ['PageDown','f'], ['PageUp','a']]) {
  test(`grid ${key}`, () => assert.equal(navigateKey({ activeId: 'b', order, columns: 2, pageRows: 2 }, { key }).activeId, expected));
}
test('mouse and keyboard selection share range, toggle, all and prune rules', () => {
  let state = selectionReducer(EMPTY_SELECTION, pointerSelection({ id: 'b', order }));
  state = selectionReducer(state, pointerSelection({ id: 'd', order, shiftKey: true }));
  assert.deepEqual(state.ids, ['b', 'c', 'd']);
  state = selectionReducer(state, pointerSelection({ id: 'c', ctrlKey: true }));
  assert.deepEqual(state.ids, ['b', 'd']);
  assert.equal(navigateKey({ activeId: 'd', order }, { key: 'ArrowDown', ctrlKey: true }).selection, null);
  assert.equal(navigateKey({ activeId: 'd', order }, { key: 'ArrowUp', shiftKey: true }).selection.type, 'range');
  assert.equal(navigateKey({ activeId: 'd', order }, { key: ' ' }).selection.type, 'toggle');
  state = selectionReducer(state, { type: 'selectAll', order: ['a', 'b'] });
  assert.deepEqual(state.ids, ['a', 'b']);
  state = selectionReducer(state, { type: 'prune', order: ['b'] });
  assert.deepEqual(state.ids, ['b']);
  assert.equal(prunedAnnouncement(['a', 'c']).params.count, 2);
  assert.equal(prunedAnnouncement([]), null);
  assert.deepEqual(selectionReducer(state, { type: 'clear' }), EMPTY_SELECTION);
});
test('commands and active item recovery, list geometry and empty result', () => {
  for (const [key, command] of [['Enter','open'], ['ContextMenu','menu'], ['F10','menu']]) assert.equal(navigateKey({ activeId: 'b', order }, { key, shiftKey: true }).command, command);
  assert.equal(navigateKey({ activeId: null, order: [] }, { key: 'ArrowDown' }), null);
  assert.equal(keepActive('c', order, ['a', 'b']), 'b');
  assert.equal(keepActive('c', order, []), null);
  assert.equal(columnsFromTops([10,10,20]), 2);
  assert.equal(navigateKey({ activeId: 'b', order }, { key: 'ArrowDown' }).activeId, 'c');
});
