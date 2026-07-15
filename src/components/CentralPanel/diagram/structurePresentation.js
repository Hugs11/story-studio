export const STORY_GROUP_PREFIX = 'story-group:';

export function getStoryGroupId(parentId) {
  return `${STORY_GROUP_PREFIX}${parentId}`;
}

export function isStoryGroupId(entryId) {
  return String(entryId ?? '').startsWith(STORY_GROUP_PREFIX);
}

export function toggleExclusiveStoryGroup(currentGroupId, requestedGroupId) {
  return currentGroupId === requestedGroupId ? null : requestedGroupId;
}

export function getFolderCollapseIntent({ entryId, expandedStoryGroupId, isCollapsed }) {
  const regroupStories = expandedStoryGroupId === getStoryGroupId(entryId);
  return {
    regroupStories,
    toggleFolder: !regroupStories || isCollapsed,
  };
}

function getChildren(entry) {
  if (entry.type === 'root' || entry.type === 'menu') return entry.children ?? [];
  return [];
}

function projectEntry(entry, depth, options) {
  const projected = {
    id: entry.id,
    entry,
    depth,
    parentId: options.parentId ?? null,
    children: [],
  };
  if (options.collapsedIds?.has(entry.id)) return projected;

  const children = getChildren(entry);
  const containers = children.filter((child) => child.type === 'menu' || child.type === 'zip');
  const otherLeaves = children.filter((child) => child.type !== 'menu' && child.type !== 'zip' && child.type !== 'story');
  const stories = children.filter((child) => child.type === 'story');

  projected.children.push(...containers.map((child) => projectEntry(child, depth + 1, {
    ...options,
    parentId: entry.id,
  })));
  projected.children.push(...otherLeaves.map((child) => projectEntry(child, depth + 1, {
    ...options,
    parentId: entry.id,
  })));

  const groupId = getStoryGroupId(entry.id);
  const storiesAreExpanded = options.expandedStoryGroupIds?.has(groupId);
  const storiesAreGrouped = stories.length > 0
    && !storiesAreExpanded
    && (entry.type === 'menu' || stories.length > 1);
  if (storiesAreGrouped) {
    projected.children.push({
      id: groupId,
      entry: {
        id: groupId,
        type: 'story-group',
        name: `${stories.length} histoires`,
        storyCount: stories.length,
        storyIds: stories.map((story) => story.id),
        parentId: entry.id,
      },
      depth: depth + 1,
      parentId: entry.id,
      children: [],
    });
  } else {
    projected.children.push(...stories.map((story) => projectEntry(story, depth + 1, {
      ...options,
      parentId: entry.id,
    })));
  }

  return projected;
}

export function buildStructureProjection(project, options = {}) {
  return projectEntry({
    id: 'root',
    type: 'root',
    name: project.projectType === 'simple'
      ? (project.projectName || 'Mon histoire')
      : (project.rootName || 'Menu racine'),
    children: project.rootEntries ?? [],
  }, 0, {
    collapsedIds: options.collapsedIds ?? new Set(),
    expandedStoryGroupIds: options.expandedStoryGroupIds ?? new Set(),
    parentId: null,
  });
}

export function getStructureEdgeId(edge) {
  return edge.id ?? `structure:${edge.from}:${edge.to}`;
}

export function buildStructureFocus(edges, activeEdgeId, labelById = new Map()) {
  if (!activeEdgeId) return null;
  const edgeById = new Map(edges.map((edge) => [getStructureEdgeId(edge), edge]));
  const activeEdge = edgeById.get(activeEdgeId);
  if (!activeEdge) return null;

  const parentEdgeByChild = new Map();
  const childEdgesByParent = new Map();
  for (const edge of edges) {
    parentEdgeByChild.set(edge.to, edge);
    const siblings = childEdgesByParent.get(edge.from) ?? [];
    siblings.push(edge);
    childEdgesByParent.set(edge.from, siblings);
  }

  const pathEdges = [activeEdge];
  const visited = new Set([activeEdge.to]);
  let currentId = activeEdge.from;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parentEdge = parentEdgeByChild.get(currentId);
    if (!parentEdge) break;
    pathEdges.unshift(parentEdge);
    currentId = parentEdge.from;
  }

  const pathEdgeIds = new Set(pathEdges.map(getStructureEdgeId));
  const pathNodeIds = new Set();
  for (const edge of pathEdges) {
    pathNodeIds.add(edge.from);
    pathNodeIds.add(edge.to);
  }
  const siblingNodeIds = new Set(
    (childEdgesByParent.get(activeEdge.from) ?? [])
      .filter((edge) => edge.to !== activeEdge.to)
      .map((edge) => edge.to),
  );
  const siblingEdgeIds = new Set(
    (childEdgesByParent.get(activeEdge.from) ?? [])
      .filter((edge) => edge.to !== activeEdge.to)
      .map(getStructureEdgeId),
  );
  const breadcrumbIds = [pathEdges[0]?.from, ...pathEdges.map((edge) => edge.to)].filter(Boolean);
  const breadcrumb = breadcrumbIds.map((id) => labelById.get(id) ?? id);

  return {
    activeEdge,
    activeEdgeId,
    pathEdges,
    pathEdgeIds,
    pathNodeIds,
    siblingNodeIds,
    siblingEdgeIds,
    breadcrumbIds,
    breadcrumb,
    targetDepth: Math.max(0, breadcrumbIds.length - 1),
    parentLabel: labelById.get(activeEdge.from) ?? activeEdge.from,
    targetLabel: labelById.get(activeEdge.to) ?? activeEdge.to,
  };
}
