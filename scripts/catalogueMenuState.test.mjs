import test from 'node:test';
import assert from 'node:assert/strict';
import { menuReducer, CLOSED_MENU, menuKeyAction } from '../src/store/catalogue/menuState.js';
test('single menu, wrap navigation, choices/back and Escape restore trigger', () => {
  let state = menuReducer(CLOSED_MENU, { type: 'open', kind: 'exemplar', targetId: 'a', returnFocusId: 'copy-a', itemCount: 3 });
  state = menuReducer(state, menuKeyAction(state, 'ArrowUp'));
  assert.equal(state.activeIndex, 2);
  state = menuReducer(state, menuKeyAction(state, 'ArrowDown'));
  assert.equal(state.activeIndex, 0);
  state = menuReducer(state, menuKeyAction(state, 'End'));
  state = menuReducer(state, { type: 'choose', action: 'reveal', itemCount: 5 });
  assert.equal(state.activeIndex, 0);
  state = menuReducer(state, { type: 'back', itemCount: 3 });
  assert.equal(state.activeIndex, 2);
  state = menuReducer(state, menuKeyAction(state, 'Escape'));
  assert.equal(state.open, false);
  assert.equal(state.restoreFocusId, 'copy-a');
  assert.equal(menuReducer(state, { type: 'focusRestored' }).restoreFocusId, null);
});
test('opening replaces previous target, Tab closes and returns to its trigger', () => {
  let state = menuReducer(CLOSED_MENU, { type: 'open', targetId: 'a', returnFocusId: 'a', itemCount: 0 });
  state = menuReducer(state, { type: 'open', kind: 'card', targetId: 'b', returnFocusId: 'b', itemCount: 1 });
  assert.equal(state.targetId, 'b');
  assert.equal(menuKeyAction(state, 'Enter').type, 'activate');
  assert.equal(menuReducer(state, menuKeyAction(state, 'Tab')).restoreFocusId, 'b');
  assert.equal(menuKeyAction(CLOSED_MENU, 'Escape'), null);
});
