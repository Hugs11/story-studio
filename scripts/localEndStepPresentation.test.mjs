import test from 'node:test';
import assert from 'node:assert/strict';

import { presentLocalEndSteps } from '../src/components/diagram/diagram/localEndStepPresentation.js';

const layout = {
  width: 420,
  height: 320,
  metrics: { nodeVisualHeight: 62 },
  nodes: [
    { entry: { id: 'menu', type: 'menu', name: 'Choix' }, x: 150, y: 30, width: 86, height: 74 },
    { entry: { id: 'story', type: 'story', name: 'Tapir' }, x: 150, y: 200, width: 86, height: 74 },
  ],
};

test('une fin locale devient une carte entre son histoire et sa destination', () => {
  const result = presentLocalEndSteps(layout, [{
    from: 'story',
    to: 'menu',
    kind: 'after-end',
    source: 'prompt',
    localEnd: { kind: 'prompt', stepCount: 1, label: 'Message de fin personnalisé' },
  }]);

  assert.equal(result.localNodes.length, 1);
  assert.deepEqual(result.localNodes[0].storyId, 'story');
  assert.deepEqual(result.navigationEdges.map((edge) => [edge.from, edge.to, edge.localEndLeg]), [
    ['story', 'local-end:story', 'start'],
    ['local-end:story', 'menu', 'exit'],
  ]);
  assert.equal(result.navigationEdges[1].y2, layout.nodes[0].y + layout.metrics.nodeVisualHeight);
});

test('un retour ordinaire reste une arête unique', () => {
  const edge = { from: 'story', to: 'menu', kind: 'return', source: 'configured' };
  const result = presentLocalEndSteps(layout, [edge]);

  assert.deepEqual(result.localNodes, []);
  assert.deepEqual(result.navigationEdges, [edge]);
});
