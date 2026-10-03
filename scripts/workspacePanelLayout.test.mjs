import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ADVANCED_WORKSPACE_PANEL_IDS,
  ADVANCED_WORKSPACE_PANEL_ORDER_CODEC,
  DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
  DEFAULT_WORKSPACE_PANEL_ORDER,
  getAdvancedWorkspaceResizeBoundaries,
  getFlexibleWorkspacePanelId,
  getVisibleAdvancedWorkspacePanelOrder,
  getVisibleWorkspacePanelOrder,
  getWorkspaceResizeBoundaries,
  normalizeAdvancedWorkspacePanelOrder,
  normalizeWorkspacePanelOrder,
  reorderAdvancedWorkspacePanels,
  reorderWorkspacePanels,
  WORKSPACE_PANEL_ORDER_CODEC,
} from '../src/workspace/panelLayout.js';
import {
  getKeyboardResizeDelta,
  getPointerResizeDelta,
  TREE_PANEL_MAX_WIDTH,
} from '../src/components/structure/panelResize.js';
import { KEYS } from '../src/store/persistentSettings.js';

const A = 'structure';
const R = 'settings';
const D = 'diagram';
const N = ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST;
const G = ADVANCED_WORKSPACE_PANEL_IDS.GRAPH;
const I = ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR;

// Valeur réellement lue dans le localStorage Tauri Fedora
// (`http_127.0.0.1_1420.localstorage`, 16 septembre 2026), avant le codec
// actuel. Elle n'est pas reconstruite avec lui : ce témoin garde le format
// enregistré par la version précédente.
const PRE_L08_SAVED_ORDER = '["diagram","structure","settings"]';

test('le plafond de l’Arbre permet une vue large sans changer son défaut compact', () => {
  assert.equal(TREE_PANEL_MAX_WIDTH, 900);
});

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

test('une disposition réellement enregistrée par la version précédente reste lisible sans migration', () => {
  assert.deepEqual(WORKSPACE_PANEL_ORDER_CODEC.decode(PRE_L08_SAVED_ORDER), [D, A, R]);
  assert.equal(WORKSPACE_PANEL_ORDER_CODEC.encode([D, A, R]), PRE_L08_SAVED_ORDER);
});

test('les panneaux du graphe ont un ordre et une visibilité propres', () => {
  assert.deepEqual(normalizeAdvancedWorkspacePanelOrder([I, G, N]), [I, G, N]);
  assert.deepEqual(
    normalizeAdvancedWorkspacePanelOrder([A, R, D]),
    DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
  );
  assert.equal(
    ADVANCED_WORKSPACE_PANEL_ORDER_CODEC.encode([I, N, G]),
    '["advanced-inspector","advanced-node-list","advanced-graph"]',
  );
  assert.deepEqual(
    getVisibleAdvancedWorkspacePanelOrder([I, G, N], { [G]: true, [I]: false, [N]: true }),
    [G, N],
  );
  assert.deepEqual(reorderAdvancedWorkspacePanels([N, G, I], I, N), [I, N, G]);
});

test('les préférences de panneaux sont locales, partagées par éditeur et séparées entre éditeurs', () => {
  assert.notEqual(KEYS.WORKSPACE_PANEL_ORDER, KEYS.ADVANCED_WORKSPACE_PANEL_ORDER);
  assert.notEqual(KEYS.DIAGRAM_SHOW_SETTINGS, KEYS.ADVANCED_SHOW_INSPECTOR);
  assert.notEqual(KEYS.DIAGRAM_SHOW_TREE, KEYS.ADVANCED_SHOW_NODE_LIST);
  assert.notEqual(KEYS.TREE_PANEL_WIDTH, KEYS.ADVANCED_NODE_LIST_PANEL_WIDTH);
  assert.notEqual(KEYS.SETTINGS_PANEL_WIDTH, KEYS.ADVANCED_INSPECTOR_PANEL_WIDTH);

  const source = readFileSync(
    new URL('../src/workspace/useAdvancedWorkspaceViewState.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /export function useAdvancedWorkspaceViewState\(\)/);
  assert.match(source, /usePersistentState/);
  assert.doesNotMatch(source, /useProjectStore|setProject|runGesture|authoring/);
  // Un objet neuf à chaque rendu de l'hôte relance les rappels de l'Éditeur
  // graphe qui en dépendent, et boucle avec le contexte « À corriger ».
  assert.match(source, /return useMemo\(\(\) => \(\{/);
});

test('chaque permutation du graphe redimensionne la liste et l’inspecteur', () => {
  const expectations = [
    [[N, G, I], [[N, 1], [I, -1]]],
    [[N, I, G], [[N, 1], [I, 1]]],
    [[G, N, I], [[N, -1], [I, -1]]],
    [[G, I, N], [[I, -1], [N, -1]]],
    [[I, N, G], [[I, 1], [N, 1]]],
    [[I, G, N], [[I, 1], [N, -1]]],
  ];

  for (const [order, expected] of expectations) {
    assert.deepEqual(
      getAdvancedWorkspaceResizeBoundaries(order)
        .map(({ resizedPanelId, direction }) => [resizedPanelId, direction]),
      expected,
      order.join(' → '),
    );
  }
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
