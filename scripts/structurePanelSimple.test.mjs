// Le panneau Structure d'un projet simple : une barre réduite (simulateur et
// recherche), sans aucun des ajouts réservés aux packs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { mountSurface } from './chromeBench.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { createElement } = await import('react');
const { StructureSearchButton } = await import('../src/components/structure/StructureActionsBar.jsx');
const { StructurePanel } = await import('../src/components/structure/StructurePanel.jsx');
const { ProjectActionsContext } = await import('../src/store/ProjectActionsContext.js');

function witness() {
  const called = [];
  const handler = (...args) => called.push(args);
  handler.called = called;
  return handler;
}

test('un projet simple garde une barre réduite : simulateur et recherche, sans ajout', () => {
  const onSimulateRoot = witness();
  const onFocusTreeSearch = witness();
  const actions = new Proxy({}, { get: () => witness() });
  const { elements } = mountSurface(createElement(ProjectActionsContext.Provider, { value: actions },
    createElement(StructurePanel, {
      project: { rootEntries: [], projectName: 'Simple', globalOptions: {} },
      projectType: 'simple',
      selectedId: null,
      selectedIds: new Set(),
      projectIndex: { flatEntries: [], entryById: new Map(), parentMenuById: new Map() },
      validationIssues: [],
      onSimulateRoot,
      onFocusTreeSearch,
    })));

  const bar = elements.find((element) => element.props?.variant === 'panel');
  assert.ok(bar, 'la barre du panneau n’est pas montée pour un projet simple');
  assert.equal(bar.props.onAddStory, null);
  assert.equal(bar.props.onAddFolder, null);
  assert.equal(bar.props.onRecord, null);
  assert.equal(bar.props.onLaunchSimulator, onSimulateRoot);
  const search = elements.find((element) => element.props?.onClick && element.type === StructureSearchButton);
  assert.ok(search, 'la recherche n’est pas montée');
  search.props.onClick();
  assert.equal(onFocusTreeSearch.called.length, 1);
});
