import test from 'node:test';
import assert from 'node:assert/strict';

import {
  centerDiagramNode,
  fitDiagramViewport,
  getDiagramViewportLayoutKey,
  getWheelZoomFactor,
  preserveViewportCenter,
} from '../src/components/CentralPanel/diagram/viewportGeometry.js';

test('le trackpad et le pincement zooment dans les deux directions', () => {
  assert.ok(getWheelZoomFactor({ deltaY: -10, deltaMode: 0 }) > 1);
  assert.ok(getWheelZoomFactor({ deltaY: 10, deltaMode: 0 }) < 1);
  assert.ok(getWheelZoomFactor({ deltaY: -4, deltaMode: 0, ctrlKey: true }) > 1.04);
  assert.ok(getWheelZoomFactor({ deltaY: 4, deltaMode: 0, ctrlKey: true }) < 0.96);
  assert.ok(getWheelZoomFactor({ deltaY: 0, deltaX: -4, deltaMode: 0, ctrlKey: true }) > 1.04);
  assert.ok(getWheelZoomFactor({ deltaY: 0, wheelDeltaY: 120, deltaMode: 0 }) > 1);
});

test('une molette conserve un pas modéré et normalise deltaMode', () => {
  const pixelWheel = getWheelZoomFactor({ deltaY: -100, deltaMode: 0 });
  const lineWheel = getWheelZoomFactor({ deltaY: -6.25, deltaMode: 1 });
  assert.ok(pixelWheel > 1 && pixelWheel < 1.2);
  assert.equal(lineWheel, pixelWheel);
});

test('le cadrage ajuste les grands diagrammes sans agrandir les petits au-delà de 100 %', () => {
  const small = fitDiagramViewport({
    containerWidth: 1200,
    containerHeight: 800,
    layoutWidth: 600,
    layoutHeight: 400,
  });
  const large = fitDiagramViewport({
    containerWidth: 1200,
    containerHeight: 800,
    layoutWidth: 2400,
    layoutHeight: 1400,
  });

  assert.equal(small.zoom, 1);
  assert.ok(large.zoom < 1);
  assert.equal(large.camera.x, Math.round((1200 - (2400 * large.zoom)) / 2));
  assert.ok(large.camera.y >= 32);
});

test('un redimensionnement de panneau conserve le même centre visuel', () => {
  assert.deepEqual(preserveViewportCenter(
    { x: 100, y: 80 },
    { width: 1000, height: 700 },
    { width: 800, height: 760 },
  ), { x: 0, y: 110 });
});

test('le centrage place le milieu du nœud au milieu du viewport au zoom courant', () => {
  assert.deepEqual(centerDiagramNode({
    containerWidth: 1000,
    containerHeight: 700,
    zoom: 0.5,
    node: { x: 1200, y: 600, width: 200, height: 100 },
  }), { x: -150, y: 25 });
  assert.equal(centerDiagramNode({
    containerWidth: 0,
    containerHeight: 700,
    zoom: 1,
    node: { x: 0, y: 0, width: 100, height: 100 },
  }), null);
});

test('la clé de cadrage change avec la géométrie, le focus et les histoires dépliées', () => {
  const layout = {
    width: 500,
    height: 300,
    nodes: [{ entry: { id: 'root' }, x: 200, y: 20, width: 120, height: 96 }],
  };
  const base = getDiagramViewportLayoutKey(layout, { compactMode: 'full' });
  const focused = getDiagramViewportLayoutKey(layout, { compactMode: 'full', focusMode: true, selectedId: 'root' });
  const expandedStories = getDiagramViewportLayoutKey(layout, {
    compactMode: 'full',
    expandedStoryGroupIds: new Set(['story-group:menu-b', 'story-group:menu-a']),
  });

  assert.notEqual(focused, base);
  assert.notEqual(expandedStories, base);
});
