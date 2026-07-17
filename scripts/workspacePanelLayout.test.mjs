import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_PANEL_ORDER,
  getFlexibleWorkspacePanelId,
  getVisibleWorkspacePanelOrder,
  getWorkspaceResizeBoundaries,
  normalizeWorkspacePanelOrder,
  reorderWorkspacePanels,
  WORKSPACE_PANEL_ORDER_CODEC,
} from '../src/workspace/panelLayout.js';
import { getKeyboardResizeDelta, getPointerResizeDelta } from '../src/components/structure/panelResize.js';

const A = 'structure';
const R = 'settings';
const D = 'diagram';

test('normalizeWorkspacePanelOrder conserve uniquement une permutation complète connue', () => {
  assert.deepEqual(normalizeWorkspacePanelOrder([D, A, R]), [D, A, R]);
  assert.deepEqual(normalizeWorkspacePanelOrder([A, A, D]), DEFAULT_WORKSPACE_PANEL_ORDER);
  assert.deepEqual(normalizeWorkspacePanelOrder([A, R]), DEFAULT_WORKSPACE_PANEL_ORDER);
  assert.deepEqual(normalizeWorkspacePanelOrder([A, R, 'unknown']), DEFAULT_WORKSPACE_PANEL_ORDER);
  assert.deepEqual(normalizeWorkspacePanelOrder(null), DEFAULT_WORKSPACE_PANEL_ORDER);
});

test('WORKSPACE_PANEL_ORDER_CODEC sérialise et récupère un ordre valide avec repli sûr', () => {
  assert.equal(WORKSPACE_PANEL_ORDER_CODEC.encode([R, D, A]), '["settings","diagram","structure"]');
  assert.deepEqual(WORKSPACE_PANEL_ORDER_CODEC.decode('["diagram","settings","structure"]'), [D, R, A]);
  assert.deepEqual(WORKSPACE_PANEL_ORDER_CODEC.decode('not-json'), DEFAULT_WORKSPACE_PANEL_ORDER);
  assert.deepEqual(WORKSPACE_PANEL_ORDER_CODEC.decode('["diagram","diagram","structure"]'), DEFAULT_WORKSPACE_PANEL_ORDER);
});

test('reorderWorkspacePanels déplace un panneau et ignore les drops invalides', () => {
  assert.deepEqual(reorderWorkspacePanels([A, R, D], A, D), [R, D, A]);
  assert.deepEqual(reorderWorkspacePanels([D, A, R], R, D), [R, D, A]);
  assert.deepEqual(reorderWorkspacePanels([A, R, D], A, A), [A, R, D]);
  assert.deepEqual(reorderWorkspacePanels([A, R, D], 'unknown', R), [A, R, D]);
});

test('getVisibleWorkspacePanelOrder garde la position configurée des panneaux masqués', () => {
  assert.deepEqual(getVisibleWorkspacePanelOrder([D, R, A], {
    [A]: true,
    [R]: false,
    [D]: true,
  }), [D, A]);
});

test('le panneau flexible reste Diagramme, sinon le dernier panneau visible', () => {
  assert.equal(getFlexibleWorkspacePanelId([A, D, R]), D);
  assert.equal(getFlexibleWorkspacePanelId([R, A]), A);
  assert.equal(getFlexibleWorkspacePanelId([R]), R);
  assert.equal(getFlexibleWorkspacePanelId([]), null);
});

test('chaque permutation à trois panneaux donne une poignée propre à Arbre et Réglages', () => {
  const expectations = [
    [[A, R, D], [[A, 1], [R, 1]]],
    [[A, D, R], [[A, 1], [R, -1]]],
    [[R, A, D], [[R, 1], [A, 1]]],
    [[R, D, A], [[R, 1], [A, -1]]],
    [[D, A, R], [[A, -1], [R, -1]]],
    [[D, R, A], [[R, -1], [A, -1]]],
  ];

  for (const [order, expected] of expectations) {
    const boundaries = getWorkspaceResizeBoundaries(order);
    assert.deepEqual(
      boundaries.map(({ resizedPanelId, direction }) => [resizedPanelId, direction]),
      expected,
      order.join(' → '),
    );
  }
});

test('toutes les paires et vues unitaires produisent les frontières attendues', () => {
  const pairExpectations = [
    [[A, R], [A, 1]],
    [[R, A], [R, 1]],
    [[A, D], [A, 1]],
    [[D, A], [A, -1]],
    [[R, D], [R, 1]],
    [[D, R], [R, -1]],
  ];

  for (const [order, expected] of pairExpectations) {
    assert.deepEqual(
      getWorkspaceResizeBoundaries(order).map(({ resizedPanelId, direction }) => [resizedPanelId, direction]),
      [expected],
      order.join(' → '),
    );
  }

  for (const panelId of [A, R, D]) {
    assert.deepEqual(getWorkspaceResizeBoundaries([panelId]), []);
  }
  assert.deepEqual(getWorkspaceResizeBoundaries([]), []);
});

test('le clavier suit le côté du panneau piloté par la poignée', () => {
  assert.equal(getKeyboardResizeDelta('ArrowRight', 1), 16);
  assert.equal(getKeyboardResizeDelta('ArrowLeft', 1), -16);
  assert.equal(getKeyboardResizeDelta('ArrowRight', -1), -16);
  assert.equal(getKeyboardResizeDelta('ArrowLeft', -1), 16);
  assert.equal(getKeyboardResizeDelta('Enter', 1), 0);
  assert.equal(getPointerResizeDelta(140, 100, 1), 40);
  assert.equal(getPointerResizeDelta(140, 100, -1), -40);
  assert.equal(getPointerResizeDelta(60, 100, -1), 40);
});
