const TREE_INDENT_BASE = 6;
const TREE_INDENT_MAX_LEVEL = 6;
const TREE_GUIDE_LEFT = 13;
const TREE_GUIDE_STEP = 12;

export function getTreeIndent(level) {
  const safeLevel = Math.max(level, 0);
  return TREE_INDENT_BASE + Math.min(safeLevel, TREE_INDENT_MAX_LEVEL) * TREE_GUIDE_STEP;
}

export function getTreeGuideStyleVars({ level, hoverGuideLevel }) {
  const safeLevel = Math.max(level, 0);
  const hoverLevel = hoverGuideLevel ?? safeLevel;
  return {
    '--tree-depth-level': safeLevel,
    '--tree-branch-guide-left': `${TREE_GUIDE_LEFT + Math.max(safeLevel - 1, 0) * TREE_GUIDE_STEP}px`,
    '--tree-branch-guide-width': `${safeLevel > 0 ? 2 : 0}px`,
    '--tree-hover-guide-left': `${TREE_GUIDE_LEFT + Math.max(hoverLevel - 1, 0) * TREE_GUIDE_STEP}px`,
  };
}

export function resolveHoverGuide({ clientX, itemLeft, level, guideScopeIds }) {
  const safeLevel = Math.max(level, 0);
  if (safeLevel <= 0) {
    return { scopeId: null, level: null };
  }

  const guideStart = itemLeft + TREE_GUIDE_LEFT;
  const guideEnd = guideStart + safeLevel * TREE_GUIDE_STEP;
  const guideLevel = clientX >= guideStart && clientX <= guideEnd
    ? Math.min(Math.max(Math.floor((clientX - guideStart) / TREE_GUIDE_STEP) + 1, 1), safeLevel)
    : safeLevel;

  return {
    scopeId: guideScopeIds?.[guideLevel - 1] ?? null,
    level: guideLevel,
  };
}

export function buildGuideScopeIdsById(projectIndex) {
  const byId = new Map();
  for (const flatEntry of projectIndex.flatEntries) {
    const path = projectIndex.pathById.get(flatEntry.entry.id) ?? [];
    byId.set(flatEntry.entry.id, Array.from({ length: flatEntry.level }, (_, index) => (index === 0
      ? 'root'
      : (path[index - 1]?.id ?? null))));
  }
  return byId;
}

export function isEntryInHoverGuide({ entryId, level, hoverGuide, guideScopeIdsById }) {
  return hoverGuide?.level <= level
    && hoverGuide?.parentId === guideScopeIdsById.get(entryId)?.[hoverGuide.level - 1];
}

export function getNextHoverGuide(parentScopeId, level) {
  const nextParentId = parentScopeId ?? null;
  return level > 0 && nextParentId != null
    ? { parentId: nextParentId, level }
    : null;
}

export function sameHoverGuide(left, right) {
  return left?.parentId === right?.parentId && left?.level === right?.level;
}
