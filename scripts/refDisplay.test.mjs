import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRefDisplay, refTargetEntryId } from '../src/components/tree/refDisplay.js';

const entryById = new Map([
  ['story-1', { id: 'story-1', name: 'Le grand bal' }],
  ['menu-1', { id: 'menu-1', name: 'Baroque' }],
]);

test('refTargetEntryId decodes story, story_play and menu targets', () => {
  assert.equal(refTargetEntryId('story:story-1'), 'story-1');
  assert.equal(refTargetEntryId('story_play:story-1'), 'story-1');
  assert.equal(refTargetEntryId('menu:menu-1'), 'menu-1');
  assert.equal(refTargetEntryId(null), null);
});

test('buildRefDisplay resolves the target name with a forward arrow', () => {
  const display = buildRefDisplay({ type: 'ref', target: 'story:story-1' }, entryById);
  assert.equal(display.targetId, 'story-1');
  assert.equal(display.label, '↪ Le grand bal');
  assert.equal(display.isReturn, false);
});

test('buildRefDisplay uses a return arrow for return refs', () => {
  const display = buildRefDisplay({ type: 'ref', target: 'menu:menu-1', refKind: 'return' }, entryById);
  assert.equal(display.label, '↩ Baroque');
  assert.equal(display.isReturn, true);
});

test('an explicit label overrides the resolved target name', () => {
  const display = buildRefDisplay({ type: 'ref', target: 'story:story-1', label: 'Suite' }, entryById);
  assert.equal(display.label, '↪ Suite');
});

test('an unresolved target falls back to a readable placeholder', () => {
  const display = buildRefDisplay({ type: 'ref', target: 'story:ghost' }, entryById);
  assert.equal(display.label, '↪ cible inconnue');
});
