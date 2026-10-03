import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_STRUCTURE_ACTION_SLOT_WIDTH,
  STRUCTURE_ACTIONS_TRAILING_SLOTS,
  STRUCTURE_ACTION_SLOT_WIDTH,
  partitionStructureActions,
  structureActionsRequiredWidth,
} from '../src/components/structure/structureActionLayout.js';

const actions = [
  { id: 'import', priority: 'primary' },
  { id: 'folder', priority: 'primary' },
  { id: 'podcast', priority: 'secondary' },
  { id: 'simulator', priority: 'secondary' },
];

// La largeur dont cette barre-ci a besoin. Elle dépend du nombre d'actions :
// une barre de cinq boutons ne se replie pas à la largeur où une
// barre de huit se replie.
const REQUIRED = structureActionsRequiredWidth(actions.length);

test('panel compact keeps primary actions direct and moves secondary actions to overflow', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: REQUIRED - 1,
  });

  assert.deepEqual(layout.directActions.map(({ id }) => id), ['import', 'folder']);
  assert.deepEqual(layout.overflowActions.map(({ id }) => id), ['podcast', 'simulator']);
});

test('wide panel and floating bar keep every action direct', () => {
  const widePanel = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: REQUIRED,
  });
  const floating = partitionStructureActions(actions, {
    variant: 'floating',
    inlineSize: REQUIRED,
  });

  assert.deepEqual(widePanel.directActions, actions);
  assert.deepEqual(widePanel.overflowActions, []);
  assert.deepEqual(floating.directActions, actions);
  assert.deepEqual(floating.overflowActions, []);
});

test('narrow floating bar keeps primary actions direct and moves secondary actions to overflow', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'floating',
    inlineSize: REQUIRED - 1,
  });

  assert.deepEqual(layout.directActions.map(({ id }) => id), ['import', 'folder']);
  assert.deepEqual(layout.overflowActions.map(({ id }) => id), ['podcast', 'simulator']);
});

test('unmeasured panel starts compact to avoid an overflow flash', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: null,
  });

  assert.deepEqual(layout.directActions.map(({ id }) => id), ['import', 'folder']);
  assert.deepEqual(layout.overflowActions.map(({ id }) => id), ['podcast', 'simulator']);
});

test('unmeasured floating bar starts expanded so its parent can expose the available width', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'floating',
    inlineSize: null,
  });

  assert.deepEqual(layout.directActions, actions);
  assert.deepEqual(layout.overflowActions, []);
});

// La largeur nécessaire suit le contenu de la barre.
test('la largeur nécessaire suit le nombre d’actions et les widgets de fin', () => {
  assert.equal(structureActionsRequiredWidth(5), 5 * STRUCTURE_ACTION_SLOT_WIDTH);
  assert.equal(
    structureActionsRequiredWidth(8, { hasTrailing: true }),
    (8 + STRUCTURE_ACTIONS_TRAILING_SLOTS) * STRUCTURE_ACTION_SLOT_WIDTH,
  );
});

test('le L du graphe tient sur le canvas à sa largeur minimale', () => {
  const mediaTools = [
    { id: 'import-media', priority: 'primary' },
    { id: 'import-podcast', priority: 'secondary' },
    { id: 'import-youtube', priority: 'secondary' },
    { id: 'record', priority: 'secondary' },
    { id: 'generate-tts', priority: 'secondary' },
    { id: 'simulator', priority: 'secondary' },
  ];
  // Le canvas mesure au moins 360 px : 24 px vont à ses marges.
  const layout = partitionStructureActions(mediaTools, {
    variant: 'canvas', inlineSize: 336, hasTrailing: true,
    slotWidth: CANVAS_STRUCTURE_ACTION_SLOT_WIDTH, trailingSlots: 1,
  });

  assert.deepEqual(layout.directActions, mediaTools);
  assert.deepEqual(layout.overflowActions, []);
});

test('la barre de l’arbre garde son repli à la largeur d’une barre de huit actions', () => {
  const treeActions = Array.from({ length: 8 }, (_, index) => ({
    id: `action-${index}`,
    priority: index < 2 ? 'primary' : 'secondary',
  }));
  const options = { variant: 'panel', hasTrailing: true };

  assert.equal(
    partitionStructureActions(treeActions, { ...options, inlineSize: 296 }).overflowActions.length,
    6,
  );
  assert.equal(
    partitionStructureActions(treeActions, { ...options, inlineSize: 297 }).overflowActions.length,
    0,
  );
});

test('le L replie les actions secondaires quand le diagramme est étroit', () => {
  const canvasActions = Array.from({ length: 8 }, (_, index) => ({
    id: `action-${index}`,
    priority: index < 2 ? 'primary' : 'secondary',
  }));
  const options = {
    variant: 'canvas', hasTrailing: true,
    slotWidth: CANVAS_STRUCTURE_ACTION_SLOT_WIDTH, trailingSlots: 1,
  };
  const compact = partitionStructureActions(canvasActions, { ...options, inlineSize: 316 });
  assert.deepEqual(compact.directActions.map(({ id }) => id), ['action-0', 'action-1']);
  assert.equal(compact.overflowActions.length, 6);

  const wide = partitionStructureActions(canvasActions, { ...options, inlineSize: 351 });
  assert.equal(wide.directActions.length, 8);
  assert.equal(wide.overflowActions.length, 0);
});
