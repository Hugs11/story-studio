import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUsageTarget } from '../src/components/MediaExplorer/usageTarget.js';

test('resolveUsageTarget goes to the first locatable usage', () => {
  const calls = [];
  const handlers = {
    onSelectNode: (id) => calls.push(['tree', id]),
    onRevealGraphNode: (path) => calls.push(['graph', path]),
  };
  const tree = { kind: 'audio', usages: [{ label: 'x' }, { label: 'A', entryId: 'e1' }, { label: 'B', nodePath: 'n' }] };
  const target = resolveUsageTarget(tree, handlers);
  assert.equal(target.label, 'A');
  target.go();
  const graph = { kind: 'audio', usages: [{ label: 'G', nodePath: 'n/2' }] };
  resolveUsageTarget(graph, handlers).go();
  assert.deepEqual(calls, [['tree', 'e1'], ['graph', 'n/2']]);
});

test('resolveUsageTarget is absent when unused or without handler', () => {
  const h = { onSelectNode: () => {}, onRevealGraphNode: () => {} };
  assert.equal(resolveUsageTarget({ kind: 'audio', usages: [] }, h), null);
  assert.equal(resolveUsageTarget({ kind: 'audio', usages: [{ label: 'x' }] }, h), null);
  assert.equal(resolveUsageTarget({ kind: 'audio', usages: [{ label: 'A', entryId: 'e' }] }, {}), null);
  assert.equal(resolveUsageTarget({ kind: 'image', usages: [{ label: 'A', entryId: 'e' }] }, h), null);
});
