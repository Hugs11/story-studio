import { decodeNavigationMenuId, decodeNavigationStoryId, isCurrentMenuNavigationTarget, isNextStoryNavigationTarget, isRootNavigationTarget, isStoryHomeStepNavigationTarget, isStoryNavigationTarget, normalizeNavigationTarget } from '../../store/navigationTargets';
import { findEntryById, findEntryPath, findParentMenuId } from '../../store/projectModel';

export const ICONS = { root: '📦', menu: '📂', story: '🎵', zip: '🗜', 'end-node': '🌙' };
export const TYPE_LABELS = { root: 'Racine', menu: 'Collection', story: 'Histoire', zip: 'ZIP', 'end-node': 'Nœud de fin' };
export const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', webp: 'image/webp' };
export const ZOOM_MIN = 0.08;
export const ZOOM_MAX = 1.9;
export const BUTTON_ZOOM_FACTOR = 1.12;
export const WHEEL_ZOOM_SENSITIVITY = 0.0012;
export const DRAG_START_DISTANCE = 6;
export const COMPLETE_METRICS = {
  full: { nodeWidth: 100, rootWidth: 120, nodeHeight: 96, colGap: 12, rowGap: 92, rowStackGap: 56, padX: 32, padY: 20, storyRowLimit: 8, structureRowLimit: 4, rootRowLimit: 3 },
  compact: { nodeWidth: 86, rootWidth: 98, nodeHeight: 74, colGap: 8, rowGap: 78, rowStackGap: 46, padX: 28, padY: 16, storyRowLimit: 6, structureRowLimit: 3, rootRowLimit: 2 },
  minimal: { nodeWidth: 68, rootWidth: 84, nodeHeight: 58, colGap: 6, rowGap: 62, rowStackGap: 36, padX: 22, padY: 12, storyRowLimit: 5, structureRowLimit: 2, rootRowLimit: 2 },
};

export function countStories(entries) {
  return (entries ?? []).filter((entry) => entry.type === 'story').length;
}

export function countStructuralNodes(entries) {
  return (entries ?? []).filter((entry) => entry.type === 'menu' || entry.type === 'zip').length;
}

export function describeContainer(entries) {
  const stories = countStories(entries);
  const structural = countStructuralNodes(entries);
  const parts = [];
  if (structural > 0) parts.push(`${structural} sous-noeud${structural > 1 ? 's' : ''}`);
  if (stories > 0) parts.push(`${stories} histoire${stories > 1 ? 's' : ''}`);
  return parts.join(' • ');
}

export function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function getNodeChildren(entry) {
  return entry?.type === 'menu' ? (entry.children ?? []) : [];
}

function chunkArray(items, chunkSize) {
  if (!items.length || chunkSize <= 0) return [items];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function getRowWidth(blocks, gap) {
  if (!blocks.length) return 0;
  return blocks.reduce((sum, block) => sum + block.width, 0) + (gap * (blocks.length - 1));
}

function getLayoutChildren(entry, options = {}) {
  const children = entry?.type === 'root' ? (entry.children ?? []) : getNodeChildren(entry);
  if (entry?.type === 'menu' && options.collapsedIds?.has(entry.id)) return [];
  return children;
}

function isStructuralChild(entry) {
  return entry?.type === 'menu' || entry?.type === 'zip';
}

function hashTone(value) {
  const text = String(value ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 6;
}

export function buildLayoutBlock(entry, metrics, options = {}) {
  const isRoot = entry.type === 'root';
  const nodeWidth = isRoot ? metrics.rootWidth : metrics.nodeWidth;
  const children = getLayoutChildren(entry, options);

  let rows = [];
  if (children.length > 0) {
    const groupedChildren = [];
    for (const child of children) {
      const kind = isStructuralChild(child) ? 'structural' : 'story';
      const previous = groupedChildren[groupedChildren.length - 1];
      if (previous?.kind === kind) {
        previous.items.push(child);
      } else {
        groupedChildren.push({ kind, items: [child] });
      }
    }

    rows = groupedChildren.flatMap((group, groupIndex) => {
      const blocks = group.items.map((child) => buildLayoutBlock(child, metrics, options));
      const rowLimit = isRoot
        ? metrics.rootRowLimit
        : (group.kind === 'structural' ? metrics.structureRowLimit : metrics.storyRowLimit);
      return chunkArray(blocks, rowLimit)
        .filter((row) => row.length > 0)
        .map((row) => ({ kind: group.kind, groupIndex, groupSize: group.items.length, blocks: row }));
    });
  }

  const rowDefs = rows.map((row) => ({
    ...row,
    width: getRowWidth(row.blocks, metrics.colGap),
    height: Math.max(...row.blocks.map((block) => block.height)),
  }));

  const contentWidth = Math.max(nodeWidth, ...rowDefs.map((row) => row.width), 0);
  const nodeX = (contentWidth - nodeWidth) / 2;
  const nodes = [{
    entry,
    x: nodeX,
    y: 0,
    width: nodeWidth,
    height: metrics.nodeHeight,
  }];
  const edges = [];
  const groups = [];
  const groupBounds = new Map();

  let nextRowY = metrics.nodeHeight + metrics.rowGap;
  for (const row of rowDefs) {
    let cursorX = (contentWidth - row.width) / 2;
    const rowStartX = cursorX;
    for (const block of row.blocks) {
      nodes.push(...block.nodes.map((node) => ({
        ...node,
        x: node.x + cursorX,
        y: node.y + nextRowY,
      })));
      groups.push(...(block.groups ?? []).map((group) => ({
        ...group,
        x: group.x + cursorX,
        y: group.y + nextRowY,
      })));
      edges.push(
        {
          from: entry.id,
          to: block.entry.id,
          kind: block.entry.type === 'story' ? 'story' : 'structural',
          x1: nodeX + (nodeWidth / 2),
          y1: metrics.nodeHeight,
          x2: cursorX + block.rootCenterX,
          y2: nextRowY,
        },
        ...block.edges.map((edge) => ({
          ...edge,
          x1: edge.x1 + cursorX,
          y1: edge.y1 + nextRowY,
          x2: edge.x2 + cursorX,
          y2: edge.y2 + nextRowY,
        })),
      );
      cursorX += block.width + metrics.colGap;
    }
    if (row.kind === 'story' && row.groupSize > 1) {
      const key = `${entry.id}:${row.groupIndex}`;
      const existing = groupBounds.get(key);
      const next = {
        parentId: entry.id,
        kind: 'stories',
        tone: hashTone(entry.id),
        x: rowStartX,
        y: nextRowY - 12,
        width: row.width,
        height: row.height + 24,
      };
      if (existing) {
        const minX = Math.min(existing.x, next.x);
        const minY = Math.min(existing.y, next.y);
        const maxX = Math.max(existing.x + existing.width, next.x + next.width);
        const maxY = Math.max(existing.y + existing.height, next.y + next.height);
        groupBounds.set(key, {
          ...existing,
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        });
      } else {
        groupBounds.set(key, next);
      }
    }
    nextRowY += row.height + metrics.rowStackGap;
  }
  groups.push(...groupBounds.values());

  return {
    entry,
    width: contentWidth,
    height: rowDefs.length > 0 ? nextRowY - metrics.rowStackGap : metrics.nodeHeight,
    rootCenterX: nodeX + (nodeWidth / 2),
    nodes,
    edges,
    groups,
  };
}

export const END_NODE_ID = 'end-node';

export function getCompleteLayout(project, compactMode, options = {}) {
  const metrics = COMPLETE_METRICS[compactMode] ?? COMPLETE_METRICS.full;
  const rootBlock = buildLayoutBlock({
    id: 'root',
    type: 'root',
    name: project.rootName || project.name || 'Nom du pack',
    children: project.rootEntries ?? [],
  }, metrics, options);

  const positionedNodes = rootBlock.nodes.map((node) => ({
    ...node,
    x: node.x + metrics.padX,
    y: node.y + metrics.padY,
  }));

  const positionedEdges = rootBlock.edges.map((edge) => {
    const x1 = edge.x1 + metrics.padX;
    const y1 = edge.y1 + metrics.padY;
    const x2 = edge.x2 + metrics.padX;
    const y2 = edge.y2 + metrics.padY;
    return {
      ...edge,
      x1,
      y1,
      x2,
      y2,
      midY: y1 + ((y2 - y1) / 2),
    };
  });
  const positionedGroups = (rootBlock.groups ?? []).map((group) => ({
    ...group,
    x: group.x + metrics.padX,
    y: group.y + metrics.padY,
  }));

  const hasEndNode = !!project.nightModeAudio;
  const canvasWidth = rootBlock.width + metrics.padX * 2;
  const canvasHeight = rootBlock.height + metrics.padY * 2;

  if (hasEndNode) {
    const endNodeWidth = metrics.nodeWidth;
    const endNodeX = Math.round((canvasWidth - endNodeWidth) / 2);
    const endNodeY = canvasHeight + metrics.rowGap;
    positionedNodes.push({
      entry: {
        id: END_NODE_ID,
        type: 'end-node',
        name: 'Nœud de fin d\'histoire',
      },
      x: endNodeX,
      y: endNodeY,
      width: endNodeWidth,
      height: metrics.nodeHeight,
    });

    return {
      width: canvasWidth,
      height: endNodeY + metrics.nodeHeight + metrics.padY,
      metrics,
      nodes: positionedNodes,
      edges: positionedEdges,
      groups: positionedGroups,
      hasEndNode: true,
      endNodeX: endNodeX + endNodeWidth / 2,
      endNodeY,
      endNodeHeight: metrics.nodeHeight,
      rootCenterX: metrics.padX + rootBlock.rootCenterX,
      rootNodeHeight: metrics.nodeHeight,
    };
  }

  return {
    width: canvasWidth,
    height: canvasHeight,
    metrics,
    nodes: positionedNodes,
    edges: positionedEdges,
    groups: positionedGroups,
    hasEndNode: false,
  };
}

function resolveEntryNavigationTarget(target, parentMenu = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
  if (isNextStoryNavigationTarget(normalized)) return null;
  if (isStoryNavigationTarget(normalized)) return decodeNavigationStoryId(normalized);
  return decodeNavigationMenuId(normalized);
}

function storyTargetMode(target) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized || !isStoryNavigationTarget(normalized)) return null;
  if (isStoryHomeStepNavigationTarget(normalized)) return 'story_home_step';
  return normalized.startsWith('story_play:') ? 'story_play' : 'story';
}

function collectNavigationTransitions(entries, parentMenu = null, transitions = [], hasEndNode = false, projectType = null) {
  for (const entry of entries ?? []) {
    if (entry.type === 'story') {
      const sequence = entry.afterPlaybackSequence ?? [];
      const hasSequence = sequence.length > 0;
      const hasPrompt = !!entry.afterPlaybackPromptAudio;
      let effectiveReturnTarget = null;
      const explicitReturnTarget = resolveEntryNavigationTarget(entry.returnAfterPlay, parentMenu);
      const inheritedTarget = resolveEntryNavigationTarget(parentMenu?.returnAfterPlay, parentMenu);
      const fallbackReturnTarget = explicitReturnTarget
        ?? inheritedTarget
        ?? (projectType !== 'simple' ? (parentMenu?.id ?? 'root') : null);

      if (hasSequence) {
        const lastStep = sequence[sequence.length - 1];
        const configuredReturnTarget = resolveEntryNavigationTarget(lastStep?.okTarget, parentMenu);
        const targetForMode = lastStep?.okTarget
          ?? entry.returnAfterPlay
          ?? parentMenu?.returnAfterPlay
          ?? null;
        effectiveReturnTarget = configuredReturnTarget ?? fallbackReturnTarget;
        if (effectiveReturnTarget) {
          const mode = storyTargetMode(targetForMode);
          transitions.push({
            from: entry.id,
            to: effectiveReturnTarget,
            kind: 'sequence',
            source: configuredReturnTarget ? 'configured' : 'implicit',
            label: mode === 'story_home_step' ? 'Fin -> retour' : mode === 'story_play' ? 'Fin -> lecture' : mode === 'story' ? 'Fin -> titre' : 'Fin',
          });
        }
        for (const step of sequence) {
          if (step?.homeNone) continue;
          const homeTarget = resolveEntryNavigationTarget(step?.homeTarget, parentMenu);
          if (homeTarget && homeTarget !== effectiveReturnTarget) {
            transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'sequence' });
          }
        }
      } else if (hasPrompt) {
        effectiveReturnTarget = resolveEntryNavigationTarget(entry.afterPlaybackPromptOkTarget, parentMenu) ?? fallbackReturnTarget;
        if (effectiveReturnTarget) {
          transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: entry.afterPlaybackPromptOkTarget ? 'prompt' : 'implicit' });
        }
        const promptHomeTarget = entry.afterPlaybackPromptHomeNone
          ? null
          : resolveEntryNavigationTarget(entry.afterPlaybackPromptHomeTarget, parentMenu);
        if (promptHomeTarget && promptHomeTarget !== effectiveReturnTarget) {
          transitions.push({ from: entry.id, to: promptHomeTarget, kind: 'home', source: 'prompt' });
        }
      } else if (hasEndNode) {
        effectiveReturnTarget = END_NODE_ID;
        transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: 'configured' });
      } else {
        if (explicitReturnTarget) {
          effectiveReturnTarget = explicitReturnTarget;
          transitions.push({ from: entry.id, to: explicitReturnTarget, kind: 'return', source: 'configured' });
        } else {
          if (inheritedTarget) {
            effectiveReturnTarget = inheritedTarget;
            transitions.push({ from: entry.id, to: inheritedTarget, kind: 'return', source: 'inherited' });
          } else if (projectType !== 'simple') {
            effectiveReturnTarget = parentMenu?.id ?? 'root';
            transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: 'implicit' });
          }
        }
      }

      const homeTarget = resolveEntryNavigationTarget(entry.returnOnHome, parentMenu);
      if (homeTarget && homeTarget !== effectiveReturnTarget) {
        transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'configured' });
      }
      continue;
    }

    if (entry.type === 'menu') {
      collectNavigationTransitions(entry.children ?? [], entry, transitions, hasEndNode, projectType);
    }
  }

  return transitions;
}

export function getCompleteNavigationEdges(project, layout) {
  const nodeMap = new Map(layout.nodes.map((node) => [node.entry.id, node]));

  const regularEdges = collectNavigationTransitions(project.rootEntries ?? [], null, [], layout.hasEndNode, project.projectType)
    .map((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return null;

      const x1 = from.x + (from.width / 2);
      const y1 = from.y;
      const x2 = to.x + (to.width / 2);
      const y2 = to.y + to.height;
      const verticalDirection = y2 >= y1 ? 1 : -1;
      const controlOffset = Math.max(54, Math.abs(x2 - x1) * 0.18, Math.abs(y2 - y1) * 0.34);

      return {
        ...edge,
        x1,
        y1,
        x2,
        y2,
        labelX: x1 + ((x2 - x1) / 2),
        labelY: y1 + ((y2 - y1) / 2),
        c1y: y1 + (controlOffset * verticalDirection),
        c2y: y2 - (controlOffset * verticalDirection),
      };
    })
    .filter(Boolean);

  if (layout.hasEndNode) {
    const endNode = nodeMap.get(END_NODE_ID);
    if (endNode) {
      const returnTargetId = resolveEntryNavigationTarget(project.nightModeReturn) ?? 'root';
      const returnTarget = nodeMap.get(returnTargetId) ?? nodeMap.get('root');
      if (returnTarget) {
        const rx = returnTarget.x + returnTarget.width / 2;
        const ry = returnTarget.y + returnTarget.height;
        const ex = endNode.x + endNode.width / 2;
        const ey = endNode.y;
        const controlOffset = Math.max(80, Math.abs(ey - ry) * 0.4);
        regularEdges.push({
          from: END_NODE_ID,
          to: returnTargetId,
          kind: 'return',
          source: project.nightModeReturn ? 'configured' : 'implicit',
          x1: ex,
          y1: ey + endNode.height,
          x2: rx,
          y2: ry,
          c1y: ey + endNode.height + controlOffset,
          c2y: ry - controlOffset,
        });
      }
    }
  }

  return regularEdges;
}

export function canMoveEntryToContainer(project, projectIndex, entryId, targetContainerId) {
  if (!entryId || entryId === 'root') return false;
  const entry = findEntryById(project, entryId, projectIndex);
  if (!entry) return false;
  const sourceContainerId = findParentMenuId(project, entryId, projectIndex);
  if (sourceContainerId === targetContainerId) return false;
  if (targetContainerId != null && entry.type === 'menu') {
    const targetPath = findEntryPath(project, targetContainerId, projectIndex) ?? [];
    if (targetPath.some((ancestor) => ancestor.id === entry.id)) return false;
  }
  return targetContainerId == null || !!findEntryById(project, targetContainerId, projectIndex);
}
