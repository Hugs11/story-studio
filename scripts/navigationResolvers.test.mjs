import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEndNodeHomeTarget } from '../src/tabs/EmulatorTab/navigationResolvers.js';

// resolveEndNodeHomeTarget : volet Home du message de fin global, consommé par le
// ProjectSimulator pour rester à parité avec le ZipSimulator / story.json.

test('endnode home: empty global home is none (return to squareOne, never follows OK)', () => {
  assert.deepEqual(resolveEndNodeHomeTarget({}, null), { kind: 'none', targetId: null });
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: '' }, null),
    { kind: 'none', targetId: null },
  );
  // Un retour OK défini ne fait pas basculer le Home vide en cible : Home reste `none`.
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeReturn: 'root' }, null),
    { kind: 'none', targetId: null },
  );
});

test('endnode home: explicit target is resolved', () => {
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'root' }, null),
    { kind: 'target', targetId: 'root' },
  );
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'menu:m1' }, null),
    { kind: 'target', targetId: 'm1' },
  );
});

test('endnode home: current_menu resolves against the source parent menu', () => {
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'current_menu' }, { id: 'menu-1' }),
    { kind: 'target', targetId: 'menu-1' },
  );
});

test('endnode home: next_story stays a literal for contextual per-story resolution', () => {
  // L'appelant (simulateur) résout `next_story` sur la sœur suivante de l'histoire source.
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'next_story' }, null),
    { kind: 'target', targetId: 'next_story' },
  );
});
