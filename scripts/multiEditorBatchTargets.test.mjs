import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canShowTextImageBatchAction,
  getTextImageBatchTargets,
} from '../src/components/CentralPanel/multiEditorBatchTargets.js';

test('text image batch action is available for stories and menus with images', () => {
  const nodes = [
    { id: 'story-a', type: 'story' },
    { id: 'menu-a', type: 'menu', autoBlackImage: false },
  ];

  assert.equal(canShowTextImageBatchAction(nodes), true);
  assert.deepEqual(getTextImageBatchTargets(nodes).map((node) => node.id), ['story-a', 'menu-a']);
});

test('text image batch action ignores imported zips without blocking eligible nodes', () => {
  const nodes = [
    { id: 'story-a', type: 'story' },
    { id: 'zip-a', type: 'zip' },
  ];

  assert.equal(canShowTextImageBatchAction(nodes), true);
  assert.deepEqual(getTextImageBatchTargets(nodes).map((node) => node.id), ['story-a']);
});

test('text image batch action is hidden when the end node is selected', () => {
  const nodes = [
    { id: 'story-a', type: 'story' },
    { id: 'end-node', type: 'end-node' },
  ];

  assert.equal(canShowTextImageBatchAction(nodes), false);
  assert.deepEqual(getTextImageBatchTargets(nodes).map((node) => node.id), ['story-a']);
});

test('text image batch action is hidden for menus without image', () => {
  const nodes = [
    { id: 'story-a', type: 'story' },
    { id: 'menu-a', type: 'menu', autoBlackImage: true },
  ];

  assert.equal(canShowTextImageBatchAction(nodes), false);
  assert.deepEqual(getTextImageBatchTargets(nodes).map((node) => node.id), ['story-a']);
});

test('text image batch action is hidden when the root node is selected', () => {
  const nodes = [
    { id: 'root', type: 'root' },
    { id: 'story-a', type: 'story' },
  ];

  assert.equal(canShowTextImageBatchAction(nodes), false);
});
