import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStructureSearchTarget } from '../src/hooks/useAppShortcutActions.js';

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
