// Contrat DOM de la liste du graphe : elle est la voie accessible vers les
// nœuds que le canvas ne peut pas exposer. Les tests portent donc sur les
// informations et les gestes, jamais sur des pixels.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elementByAttribute,
  elementsByAttribute,
  mountSurface,
} from './chromeBench.mjs';

const { createElement } = await import('react');
const {
  default: GraphSearchPanel,
  GraphNodeListActions,
} = await import('../src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx');
const { SEARCH_SCOPES } = await import('../src/store/advancedGraphView/graphSearch.js');
const { nodeRoles } = await import('../src/store/advancedGraphView/graphRoles.js');

const duplicateA = {
  kind: 'stage',
  path: '/stageNodes/@uuid=commun#0',
  label: { label: 'Accueil', isFallback: false },
  node: { uuid: 'commun', uniqueId: false, squareOne: { value: true } },
};
const duplicateB = {
  kind: 'stage',
  path: '/stageNodes/@uuid=commun#1',
  label: { label: 'Retour accueil', isFallback: false },
  node: { uuid: 'commun', uniqueId: false, squareOne: { value: false } },
};
const action = {
  kind: 'action',
  path: '/actionNodes/@id=choix#0',
  label: { label: 'Choisir', isFallback: false },
  node: { id: 'choix', uniqueId: true },
};

function result(entries) {
  return { results: entries, total: entries.length, truncated: false };
}

function search(options = {}) {
  if (options.scope === SEARCH_SCOPES.DETACHED) return result([duplicateB]);
  if (options.scope === SEARCH_SCOPES.DIAGNOSED) return result([duplicateA]);
  if (options.scope === SEARCH_SCOPES.STAGES) return result([duplicateA, duplicateB]);
  if (options.scope === SEARCH_SCOPES.ACTIONS) return result([action]);
  return result([duplicateA, duplicateB, action]);
}

// Les rôles viennent du **même** module que ceux du canvas : la liste n'en
// calcule plus aucun, et l'essai le prouve en lui passant ce que l'index
// produit réellement.
const index = {
  entries: [duplicateA, duplicateB, action],
  diagnosticsByNode: new Map([[duplicateA.path, [{ code: 'D1-GVI-005' }]]]),
  view: {
    edges: [
      { edgeId: 'e0', kind: 'stage-ok', from: duplicateA.path, to: action.path },
      { edgeId: 'e1', kind: 'action-option', from: action.path, to: duplicateA.path },
    ],
  },
};
const roles = nodeRoles(index);

function witness() {
  const called = [];
  const handler = (...args) => called.push(args);
  handler.called = called;
  return handler;
}

test('la liste distingue les natures et occurrences sans répéter les diagnostics', () => {
  const { html } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: duplicateA.path,
    onFocusPath: witness(),
    counts: { stages: 2, actions: 1, edges: 4 },
    roles,
    entry: { status: 'unique', stagePath: duplicateA.path },
  }));

  assert.match(html, />Écran · commun · occurrence 1</);
  assert.match(html, />Écran · commun · occurrence 2</);
  assert.match(html, />Liste de choix · choix</);
  assert.doesNotMatch(html, />Doublon</);
  assert.doesNotMatch(html, />À corriger</);
  assert.doesNotMatch(html, />Isolé</);
  assert.match(html, /2 Écrans · 1 liste de choix · 4 liens/);
});

test('l\'Écran racine ouvre la liste et porte le badge « racine »', () => {
  // La racine est volontairement la dernière des résultats : la liste la
  // remonte en tête, sans lien « Montrer la racine » à part.
  const { html, elements } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: null,
    onFocusPath: witness(),
    entry: { status: 'unique', stagePath: duplicateB.path },
  }));

  const options = elementsByAttribute(elements, 'role').filter((element) => element.props.role === 'option');
  assert.deepEqual(options.map((option) => option.props.id), [
    `advanced-option-${encodeURIComponent(duplicateB.path)}`,
    `advanced-option-${encodeURIComponent(duplicateA.path)}`,
    `advanced-option-${encodeURIComponent(action.path)}`,
  ]);
  assert.equal((html.match(/class="advanced-search__root-badge"/g) ?? []).length, 1);
  assert.match(html, /advanced-search__root-badge">racine</);
  assert.ok(elements.some((element) => element.props?.text === 'Écran d’entrée : le pack commence ici'));
  assert.doesNotMatch(html, /Montrer la racine/);
});

test('sans racine unique, aucun Écran n\'est présenté comme racine', () => {
  for (const entry of [null, { status: 'missing' }, { status: 'multiple', stagePath: duplicateB.path }]) {
    const { html } = mountSurface(createElement(GraphSearchPanel, {
      search,
      focus: null,
      onFocusPath: witness(),
      entry,
    }));
    assert.doesNotMatch(html, /advanced-search__root-badge/);
  }
});

test('le décompte monte dans la barre de la liste quand l\'hôte la fournit', () => {
  const { html } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: null,
    onFocusPath: witness(),
    counts: { stages: 2, actions: 1, edges: 4 },
    renderHeader: (summary) => createElement(GraphNodeListActions, {
      onSearch: witness(),
      onClose: witness(),
      summary,
    }),
  }));

  // Une seule occurrence, logée dans l'emplacement de tête de la barre.
  assert.equal((html.match(/2 Écrans · 1 liste de choix · 4 liens/g) ?? []).length, 1);
  assert.match(
    html,
    /class="structure-actions-leading"><p class="advanced-search__count" aria-live="polite">2 Écrans · 1 liste de choix · 4 liens/,
  );
});

test('un cul-de-sac ne devient pas un avertissement dans la liste', () => {
  const { html } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: null,
    onFocusPath: witness(),
    roles,
  }));
  // L'Action ne porte aucune sortie : c'est une fin, pas une erreur. Elle
  // reçoit donc « Cul-de-sac » en ton neutre, et non « À corriger ».
  assert.doesNotMatch(html, />Cul-de-sac</);
});

test('les filtres restent centrés sur la nature des nœuds', () => {
  const { elements } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: null,
    onFocusPath: witness(),
    roles,
    searchActive: true,
  }));

  const filters = elementsByAttribute(elements, 'aria-pressed');
  assert.deepEqual(filters.map((filter) => filter.props.children), ['Tout', 'Écrans', 'Listes de choix']);
  assert.equal(filters[0].props['aria-pressed'], true);
  assert.ok(filters.slice(1).every((filter) => filter.props['aria-pressed'] === false));
});

test('la recherche du graphe réutilise la barre de recherche du Libre', () => {
  const { html } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: null,
    onFocusPath: witness(),
    searchActive: true,
  }));

  assert.match(html, /class="tree-search-controls"/);
  assert.match(html, /class="tree-search-bar"/);
  assert.match(html, /placeholder="Rechercher…"/);
});

test('la liste atteint tous les résultats : la fenêtre s\'ouvre au clavier', () => {
  const many = Array.from({ length: 450 }, (_, position) => ({
    kind: 'stage',
    path: `/stageNodes/@uuid=n${position}#0`,
    label: { label: `Écran ${position}`, isFallback: false },
    node: { uuid: `n${position}`, uniqueId: true },
  }));
  const searchAll = () => ({ results: many, total: many.length, truncated: false });

  const first = mountSurface(createElement(GraphSearchPanel, {
    search: searchAll, focus: null, onFocusPath: witness(),
  }));
  // Deux cents lignes rendues, mais le compte total est dit et le reste est
  // offert : la liste n'enferme plus le clavier dans sa première page. Le
  // bouton de fin de liste est seul à dire ce qui reste à afficher.
  assert.match(first.html, /450 résultats/);
  assert.doesNotMatch(first.html, /affichés/);
  assert.match(first.html, /Afficher 200 nœuds de plus/);
  assert.match(first.html, /250 restants/);

  // Un nœud désigné au-delà de la fenêtre est **rendu**, sinon
  // `aria-activedescendant` viserait un identifiant absent du document.
  const far = mountSurface(createElement(GraphSearchPanel, {
    search: searchAll, focus: many[430].path, onFocusPath: witness(),
  }));
  const list = elementByAttribute(far.elements, 'role', 'listbox');
  assert.match(far.html, />Écran 430</);
  assert.ok(list.props['aria-activedescendant']);
});

test('le clavier parcourt sans recentrer puis Entrée recentre la sélection', () => {
  const onFocusPath = witness();
  const { elements } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: duplicateA.path,
    onFocusPath,
    roles,
  }));
  const list = elementByAttribute(elements, 'role', 'listbox');
  const preventDefault = witness();

  list.props.onKeyDown({ key: 'ArrowDown', preventDefault });
  list.props.onKeyDown({ key: 'Enter', preventDefault });

  assert.deepEqual(onFocusPath.called, [
    [duplicateB.path, { center: false }],
    [duplicateA.path, { center: true }],
  ]);
  assert.equal(preventDefault.called.length, 2);
});

test('une recherche vide garde un état explicite dans la liste', () => {
  const { html } = mountSurface(createElement(GraphSearchPanel, {
    search: () => result([]),
    focus: null,
    onFocusPath: witness(),
  }));

  assert.match(html, /Aucun nœud ne correspond à cette recherche/);
});

test('le clic droit d’une ligne ouvre le menu sur ce nœud', () => {
  const onContextMenuRequest = witness();
  const { elements } = mountSurface(createElement(GraphSearchPanel, {
    search,
    focus: duplicateA.path,
    onFocusPath: witness(),
    onContextMenuRequest,
  }));
  const row = elements.find((element) => element.props?.id === optionIdForTest(duplicateB.path));
  const preventDefault = witness();
  const stopPropagation = witness();

  row.props.onContextMenu({ clientX: 120, clientY: 80, preventDefault, stopPropagation });

  assert.deepEqual(onContextMenuRequest.called, [[{
    path: duplicateB.path,
    x: 120,
    y: 80,
  }]]);
  assert.equal(preventDefault.called.length, 1);
  assert.equal(stopPropagation.called.length, 1);
});

function optionIdForTest(path) {
  return `advanced-option-${encodeURIComponent(path)}`;
}
