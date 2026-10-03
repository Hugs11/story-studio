// La position du panneau Réglages, retenue pour les derniers nœuds visités.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCROLL_MEMORY_SIZE,
  rememberScroll,
} from '../src/components/AdvancedWorkspace/useInspectorScrollMemory.js';

test('un nœud revisité retrouve sa dernière position', () => {
  const memory = new Map();
  rememberScroll(memory, 'ecran', 120);
  rememberScroll(memory, 'liste', 40);
  rememberScroll(memory, 'ecran', 480);
  assert.equal(memory.get('ecran'), 480);
  assert.equal(memory.get('liste'), 40);
});

test('seuls les dix derniers nœuds sont retenus, le plus ancien part d’abord', () => {
  const memory = new Map();
  for (let rank = 0; rank <= SCROLL_MEMORY_SIZE; rank += 1) rememberScroll(memory, `n${rank}`, rank);
  assert.equal(SCROLL_MEMORY_SIZE, 10);
  assert.equal(memory.size, 10);
  assert.equal(memory.has('n0'), false, 'le premier visité est oublié');
  assert.equal(memory.get('n10'), 10);
});

test('revisiter un nœud le rafraîchit : il n’est pas oublié le premier', () => {
  const memory = new Map();
  for (let rank = 0; rank < SCROLL_MEMORY_SIZE; rank += 1) rememberScroll(memory, `n${rank}`, rank);
  rememberScroll(memory, 'n0', 99);
  rememberScroll(memory, 'nouveau', 1);
  assert.equal(memory.get('n0'), 99);
  assert.equal(memory.has('n1'), false);
});
