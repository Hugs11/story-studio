import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStructureSearchTarget } from '../src/hooks/useAppShortcutActions.js';
import { WORKSPACE_MODE_ADVANCED } from '../src/store/projectWorkState.js';

test('Ctrl+F suit la dernière surface active quand arbre et diagramme sont visibles', () => {
  const common = { projectType: 'pack', treeVisible: true, diagramVisible: true };
  assert.equal(resolveStructureSearchTarget({ ...common, activeSurface: 'tree' }), 'tree');
  assert.equal(resolveStructureSearchTarget({ ...common, activeSurface: 'diagram' }), 'diagram');
});

test('Ctrl+F choisit la seule surface de recherche disponible', () => {
  assert.equal(resolveStructureSearchTarget({
    projectType: 'pack',
    treeVisible: false,
    diagramVisible: true,
  }), 'diagram');
  assert.equal(resolveStructureSearchTarget({
    projectType: 'pack',
    treeVisible: true,
    diagramVisible: false,
  }), 'tree');
  assert.equal(resolveStructureSearchTarget({
    projectType: 'simple',
    treeVisible: true,
    diagramVisible: true,
    activeSurface: 'tree',
  }), 'diagram');
  assert.equal(resolveStructureSearchTarget({
    projectType: 'simple',
    treeVisible: true,
    diagramVisible: false,
  }), null);
});

test('Ctrl+F vise la liste des nœuds visible dans l’éditeur graphe', () => {
  assert.equal(resolveStructureSearchTarget({
    workspaceMode: WORKSPACE_MODE_ADVANCED,
    advancedNodeListVisible: true,
  }), 'advanced');
  assert.equal(resolveStructureSearchTarget({
    workspaceMode: WORKSPACE_MODE_ADVANCED,
    advancedNodeListVisible: false,
  }), null);
});
