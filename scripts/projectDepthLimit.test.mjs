import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MENU_DEPTH,
  MENU_DEPTH_LIMIT_CODE,
  ProjectMenuDepthError,
  deepCloneEntry,
  getMenuDepth,
  getMenuSubtreeHeight,
  getProjectMenuDepthDiagnostic,
  normalizeProjectData,
  projectToRustExport,
  validateMenuDepthPlacement,
} from '../src/store/projectModel.js';
import { buildProjectIndex } from '../src/store/projectModel/index.js';
import {
  appendEntry,
  cutPasteEntries,
  insertEntryAfter,
  moveEntryToContainer,
  replaceEntryWithEntries,
  updateProjectRootEntries,
} from '../src/store/projectModel/operations.js';
import { getStructureLevelLayout } from '../src/components/diagram/diagram/structureLevelLayout.js';
import {
  findEntryLocation,
  getMenuBrowseState,
  resolveStoryHomeTarget,
  resolveStoryReturnTarget,
  resolveStoryTitleHomeTarget,
} from '../src/tabs/EmulatorTab/navigationResolvers.js';
import { getTreeGuideStyleVars, getTreeIndent } from '../src/components/TreePanel/treeGuides.js';
import { makeDepthProject, makeNestedMenuChain } from './fixtures/projectDepthFixtures.js';

const LAYOUT_METRICS = {
  nodeWidth: 68,
  rootWidth: 84,
  nodeHeight: 58,
  padX: 22,
  padY: 12,
  colGap: 6,
  rowGap: 62,
};

test('the shared authoring contract is 61 nested Dossiers', () => {
  assert.equal(MAX_MENU_DEPTH, 61);
});

for (const depth of [0, 1, 60, 61, 62]) {
  test(`project depth helper measures ${depth} Dossiers`, () => {
    const diagnostic = getProjectMenuDepthDiagnostic(makeDepthProject(depth));
    assert.equal(diagnostic.observedDepth, depth);
    assert.equal(diagnostic.allowed, depth <= MAX_MENU_DEPTH);
    assert.equal(diagnostic.code, depth > MAX_MENU_DEPTH ? MENU_DEPTH_LIMIT_CODE : null);
    if (depth > 0) {
      assert.equal(diagnostic.path.at(-1)?.id, `folder-${depth}`);
    }
  });
}

test('the diagnostic reports the actual deepest level beyond the limit', () => {
  const diagnostic = getProjectMenuDepthDiagnostic(makeDepthProject(75));
  assert.equal(diagnostic.allowed, false);
  assert.equal(diagnostic.observedDepth, 75);
  assert.equal(diagnostic.path.at(-1)?.id, 'folder-75');
});

test('subtree height counts Dossiers only', () => {
  assert.equal(getMenuSubtreeHeight({ type: 'story', id: 'story' }), 0);
  assert.equal(getMenuSubtreeHeight(makeNestedMenuChain(3)[0]), 3);
});

test('a Dossier can be created at level 61 but not at level 62', () => {
  const project = makeDepthProject(60);
  const index = buildProjectIndex(project);
  const newFolder = { id: 'new-folder', type: 'menu', children: [] };
  assert.equal(
    validateMenuDepthPlacement(project, 'folder-60', [newFolder], index).allowed,
    true,
  );

  const limitProject = makeDepthProject(61);
  const limitIndex = buildProjectIndex(limitProject);
  const rejected = validateMenuDepthPlacement(limitProject, 'folder-61', [newFolder], limitIndex);
  assert.deepEqual(
    { allowed: rejected.allowed, code: rejected.code, attemptedDepth: rejected.attemptedDepth },
    { allowed: false, code: MENU_DEPTH_LIMIT_CODE, attemptedDepth: 62 },
  );
});

test('tree operations accept level 61 and refuse level 62 atomically', () => {
  const folder = { id: 'new-folder', type: 'menu', name: 'Nouveau', children: [] };
  const project60 = normalizeProjectData(makeDepthProject(60));
  const accepted = appendEntry(project60, 'folder-60', folder);
  assert.equal(getProjectMenuDepthDiagnostic(accepted).observedDepth, 61);
  assert.ok(buildProjectIndex(accepted).entryById.has('new-folder'));

  const project61 = normalizeProjectData(makeDepthProject(61));
  const rejected = appendEntry(project61, 'folder-61', folder);
  assert.equal(rejected, project61);
  assert.equal(buildProjectIndex(rejected).entryById.has('new-folder'), false);
});

test('move, cut/paste and ZIP replacement keep project identity when depth would overflow', () => {
  const project = normalizeProjectData(makeDepthProject(60, { withSiblingBranch: true }));
  const tallBranch = {
    id: 'tall-a',
    type: 'menu',
    name: 'Tall A',
    children: [{
      id: 'tall-b',
      type: 'menu',
      name: 'Tall B',
      children: [{ id: 'tall-story', type: 'story', name: 'Tall story' }],
    }],
  };
  const withTallBranch = appendEntry(project, null, tallBranch);

  const moved = moveEntryToContainer(withTallBranch, 'tall-a', 'folder-60');
  assert.equal(moved, withTallBranch);
  const cutPasted = cutPasteEntries(withTallBranch, ['tall-a'], 'folder-60');
  assert.equal(cutPasted, withTallBranch);

  const projectWithZip = appendEntry(project, 'folder-60', {
    id: 'zip-at-limit',
    type: 'zip',
    name: 'ZIP',
    zipPath: '/fixtures/source.zip',
  });
  const replaced = replaceEntryWithEntries(
    projectWithZip,
    'folder-60',
    'zip-at-limit',
    makeNestedMenuChain(2),
  );
  assert.equal(replaced, projectWithZip);
  assert.equal(buildProjectIndex(replaced).entryById.has('zip-at-limit'), true);
});

test('duplicating a Dossier preserves every descendant without increasing its depth', () => {
  const project = normalizeProjectData(makeDepthProject(61));
  const source = project.rootEntries[0];
  const clone = deepCloneEntry(source);
  const duplicated = insertEntryAfter(project, source.id, clone);

  assert.equal(getMenuSubtreeHeight(clone), 61);
  assert.notEqual(clone.id, source.id);
  assert.notEqual(clone.children[0].id, source.children[0].id);
  assert.equal(duplicated.rootEntries.length, 2);
  assert.equal(getProjectMenuDepthDiagnostic(duplicated).observedDepth, 61);
});

test('regrouping and root conversion accept level 61 and refuse level 62 atomically', () => {
  const groupedSubtree = {
    id: 'group-parent',
    type: 'menu',
    name: 'Groupe',
    children: [{ id: 'group-child', type: 'menu', name: 'Enfant', children: [] }],
  };
  assert.equal(
    validateMenuDepthPlacement(makeDepthProject(59), 'folder-59', [groupedSubtree]).allowed,
    true,
  );
  assert.equal(
    validateMenuDepthPlacement(makeDepthProject(60), 'folder-60', [groupedSubtree]).allowed,
    false,
  );

  const depth60 = normalizeProjectData(makeDepthProject(60));
  const acceptedWrapper = {
    id: 'root-wrapper',
    type: 'menu',
    name: 'Ancienne racine',
    children: depth60.rootEntries,
  };
  const accepted = updateProjectRootEntries(depth60, [acceptedWrapper]);
  assert.equal(getProjectMenuDepthDiagnostic(accepted).observedDepth, 61);

  const depth61 = normalizeProjectData(makeDepthProject(61));
  const rejectedWrapper = { ...acceptedWrapper, children: depth61.rootEntries };
  const rejected = updateProjectRootEntries(depth61, [rejectedWrapper]);
  assert.equal(rejected, depth61);
});

test('a shallow sibling does not alter the deepest branch contract', () => {
  const project = makeDepthProject(61, { withSiblingBranch: true });
  assert.equal(getProjectMenuDepthDiagnostic(project).observedDepth, 61);
  assert.equal(getMenuDepth(project, 'shallow-folder'), 1);
});

test('normalization accepts 61 and rejects 62 before recursive model work', () => {
  assert.doesNotThrow(() => normalizeProjectData(makeDepthProject(61)));
  assert.throws(
    () => normalizeProjectData(makeDepthProject(62)),
    (error) => error instanceof ProjectMenuDepthError
      && error.code === MENU_DEPTH_LIMIT_CODE
      && error.attemptedDepth === 62,
  );
});

test('JSON save/load shape and Rust export retain every level at 61', () => {
  const project = normalizeProjectData(makeDepthProject(61));
  const saved = JSON.stringify(project);
  for (let level = 1; level <= 61; level += 1) {
    assert.match(saved, new RegExp(`\\"folder-${level}\\"`));
  }
  const loaded = normalizeProjectData(JSON.parse(saved));
  const exported = projectToRustExport(loaded, { leading: 0, trailing: 0 });
  assert.equal(getProjectMenuDepthDiagnostic(exported).observedDepth, 61);
  assert.equal(JSON.stringify(exported).includes('folder-61'), true);
});

test('index and simulator traverse all 61 Dossiers and resolve Home/return to root', () => {
  const project = makeDepthProject(61);
  const index = buildProjectIndex(project);
  assert.equal(index.pathById.get('folder-61').length, 61);
  assert.equal(index.parentMenuById.get('folder-61'), 'folder-60');

  for (let level = 1; level <= 61; level += 1) {
    const browseState = getMenuBrowseState(project.rootEntries, `folder-${level}`);
    assert.ok(browseState);
    assert.equal(browseState.menuPath.length, level - 1);
  }

  const location = findEntryLocation(project.rootEntries, 'depth-story');
  assert.equal(location.menuPath.length, 61);
  assert.equal(location.menuPath.at(-1), 'folder-61');
  const parentMenu = index.entryById.get('folder-61');
  assert.equal(resolveStoryReturnTarget(location.entry, parentMenu, project), 'root');
  assert.equal(resolveStoryHomeTarget(location.entry, parentMenu, project), 'root');
  assert.equal(resolveStoryTitleHomeTarget(location.entry, parentMenu, project.rootEntries), 'root');
});

test('diagram layout stays finite and keeps N61 selectable', () => {
  const project = makeDepthProject(61);
  const layout = getStructureLevelLayout(project, LAYOUT_METRICS, {
    expandedStoryGroupIds: new Set(['story-group:folder-61']),
  });
  const deepest = layout.nodes.find((node) => node.entry.id === 'folder-61');
  assert.ok(deepest);
  assert.equal(deepest.depth, 61);
  assert.equal(layout.bands.some((band) => band.label === 'N61'), true);
  assert.equal(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)), true);
  assert.equal(Number.isFinite(layout.width) && Number.isFinite(layout.height), true);
});

test('tree indentation and branch guides preserve all 61 visual levels', () => {
  assert.equal(getTreeIndent(61), 738);
  const style = getTreeGuideStyleVars({ level: 61, hoverGuideLevel: 61 });
  assert.equal(style['--tree-depth-level'], 61);
  assert.equal(style['--tree-branch-guide-left'], '733px');
});
