import test from 'node:test';
import assert from 'node:assert/strict';
import { card } from './catalogueFixtures.mjs';
import {
  CHOICE_POLICIES, CLOSED_CHOICE, choiceDecision, choiceItems, choiceKeyAction, choiceReducer, choiceTarget,
} from '../src/store/catalogue/exemplarChoice.js';
import { simulationAvailability } from '../src/store/catalogue/simulationAvailability.js';
import { cardMenuActions, simulateCommand } from '../src/store/catalogue/cardActions.js';

const simulate = { policy: CHOICE_POLICIES.simulate, availability: simulationAvailability };
const edit = { policy: CHOICE_POLICIES.edit, availability: simulationAvailability };

test('availability by target: unavailable file, scan state, unknown format, still to verify', () => {
  const c = card({ exemplars: [
    { id: 'ok' },
    { id: 'gone', available: false },
    { id: 'corrupt', state: 'corruptArchive' },
    { id: 'protected', state: 'protectedArchive' },
    { id: 'invalid', state: 'invalidStructure' },
    { id: 'unsupported', state: 'unsupportedFormat' },
    { id: 'odd', state: 'unreadableUnknown' },
    { id: 'project', format: 'project', projectType: 'pack' },
  ] });
  const reasons = Object.fromEntries(c.exemplars.map((exemplar) => [exemplar.id, simulationAvailability(exemplar)]));
  assert.deepEqual(reasons.ok, { enabled: true, reasonKey: null });
  assert.equal(reasons.project.enabled, true, 'a project is qualified at opening');
  assert.equal(reasons.gone.reasonKey, 'catalogue:reason.action.fileUnavailable');
  assert.equal(reasons.corrupt.reasonKey, 'catalogue:reason.action.archiveCorrupt');
  assert.equal(reasons.protected.reasonKey, 'catalogue:reason.action.archiveProtected');
  assert.equal(reasons.invalid.reasonKey, 'catalogue:reason.action.invalidPack');
  assert.equal(reasons.unsupported.reasonKey, 'catalogue:reason.action.unsupportedFormat');
  assert.equal(reasons.odd.reasonKey, 'catalogue:reason.action.unreadable');
  assert.equal(simulationAvailability({ ...c.exemplars[0], format: null }).reasonKey, 'catalogue:reason.action.unsupportedFormat');
  assert.equal(simulationAvailability(null).enabled, false);
});

test('« Simuler » asks whenever several copies exist, including unavailable ones', () => {
  const single = card({ exemplars: [{ id: 'a' }, { id: 'b', available: false }] });
  // FICHEA: even a single suitable copy requires a choice when other copies exist.
  assert.equal(choiceDecision(single.exemplars, simulate).kind, 'choose');
  assert.equal(simulateCommand(single, single.exemplars).choice, true);
  assert.deepEqual(choiceDecision([single.exemplars.find(e => e.id === 'a')], simulate), { kind: 'direct', exemplarId: 'a' });
  const several = card({ exemplars: [{ id: 'a', format: 'zip', modifiedAt: 2 }, { id: 'b', format: 'project' }, { id: 'c', available: false }] });
  const decision = choiceDecision(several.exemplars, simulate);
  assert.equal(decision.kind, 'choose');
  // Order of the card (fixed formats, then most recent first), every copy present.
  assert.deepEqual(decision.items.map((item) => item.id), several.exemplars.map((exemplar) => exemplar.id));
  const disabled = decision.items.find((item) => item.id === 'c');
  assert.deepEqual([disabled.enabled, disabled.reasonKey], [false, 'catalogue:reason.action.fileUnavailable']);
  const command = simulateCommand(several, several.exemplars);
  assert.deepEqual([command.enabled, command.choice, command.labelKey], [true, true, 'catalogue:actions.simulate.choose']);
  assert.equal(cardMenuActions(several, several.exemplars).find((action) => action.id === 'simulate').choice, true);
  const none = card({ exemplars: [{ id: 'x', available: false }, { id: 'y', state: 'corruptArchive' }] });
  assert.deepEqual(choiceDecision(none.exemplars, simulate), { kind: 'unavailable', reasonKey: 'catalogue:reason.action.noSuitableExemplar' });
  const lone = card({ exemplars: [{ id: 'x', available: false }] });
  assert.equal(simulateCommand(lone, lone.exemplars).reasonKey, 'catalogue:reason.action.fileUnavailable');
  assert.equal(choiceDecision([], simulate).reasonKey, 'catalogue:actions.reason.noExemplar');
});

test('« Modifier » always asks when several copies or formats exist', () => {
  const two = card({ exemplars: [{ id: 'a' }, { id: 'b', available: false }] });
  assert.equal(choiceDecision(two.exemplars, edit).kind, 'choose');
  const one = card({ exemplars: [{ id: 'a' }] });
  assert.deepEqual(choiceDecision(one.exemplars, edit), { kind: 'direct', exemplarId: 'a' });
  const gone = card({ exemplars: [{ id: 'a', available: false }] });
  assert.equal(choiceDecision(gone.exemplars, edit).kind, 'unavailable');
});

test('choice navigation reaches disabled copies, chooses only suitable ones', () => {
  const c = card({ exemplars: [{ id: 'gone', available: false }, { id: 'a' }, { id: 'b' }] });
  const items = choiceItems(c.exemplars, simulationAvailability);
  let state = choiceReducer(CLOSED_CHOICE, { type: 'open', cardId: c.id, command: 'simulate', revision: 3, items, returnFocusId: 'trigger' });
  assert.equal(items[state.activeIndex].id, items.find((item) => item.enabled).id, 'first suitable copy is active');
  state = choiceReducer(state, choiceKeyAction('End'));
  state = choiceReducer(state, choiceKeyAction('ArrowDown'));
  assert.equal(state.activeIndex, 0, 'wraps to the disabled copy, still reachable');
  assert.equal(choiceTarget(state, items[0]), null);
  assert.deepEqual(choiceTarget(state, items[2]), { exemplarId: items[2].id, expectedRevision: 3 });
  assert.equal(choiceKeyAction('Enter').type, 'activate');
  assert.equal(choiceKeyAction('x'), null);
  const closed = choiceReducer(state, { type: 'close' });
  assert.equal(closed.open, false);
  assert.equal(closed.restoreFocusId, 'trigger');
  assert.equal(choiceReducer(closed, { type: 'focusRestored' }).restoreFocusId, null);
  assert.equal(choiceReducer(state, { type: 'close', restoreFocus: false }).restoreFocusId, null);
});

test('a rescan during the choice revalidates the target and refreshes the list, never another file', () => {
  const before = card({ id: 'c', exemplars: [{ id: 'a', modifiedAt: 3 }, { id: 'b', modifiedAt: 2 }, { id: 'old', modifiedAt: 1 }] });
  const items = choiceItems(before.exemplars, simulationAvailability);
  let state = choiceReducer(CLOSED_CHOICE, { type: 'open', cardId: 'c', command: 'simulate', revision: 5, items });
  state = choiceReducer(state, { type: 'focus', index: 1 });
  assert.equal(items[state.activeIndex].id, 'b');
  // Rescan: a new copy arrives first, « b » became unavailable, « old » is gone.
  const after = card({ id: 'c', exemplars: [{ id: 'new', modifiedAt: 9 }, { id: 'a', modifiedAt: 3 }, { id: 'b', modifiedAt: 2, available: false }] });
  const refreshed = choiceItems(after.exemplars, simulationAvailability);
  state = choiceReducer(state, { type: 'refresh', items: refreshed, revision: 6, activeId: 'b' });
  assert.equal(state.revision, 6);
  assert.equal(refreshed[state.activeIndex].id, 'b', 'the active row follows its own copy');
  assert.equal(choiceTarget(state, refreshed[state.activeIndex]), null, 'now unavailable: no fallback to another copy');
  assert.deepEqual(choiceTarget(state, refreshed[1]), { exemplarId: 'a', expectedRevision: 6 });
  // The chosen copy disappeared: the row resets to the first suitable copy, never to « old ».
  state = choiceReducer(state, { type: 'refresh', items: choiceItems([after.exemplars[0]], simulationAvailability), revision: 7, activeId: 'old' });
  assert.equal(state.activeIndex, 0);
  // The card itself disappeared: the box closes and returns the focus.
  const gone = choiceReducer({ ...state, returnFocusId: 'trigger' }, { type: 'refresh', items: [], revision: 8, activeId: 'new' });
  assert.deepEqual([gone.open, gone.restoreFocusId], [false, 'trigger']);
});
