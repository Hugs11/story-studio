import { decodeNavigationStoryId, isStoryHomeStepNavigationTarget, isStoryNavigationTarget, normalizeNavigationTarget, refTargetEntryId } from '../../store/navigationTargets';
import {
  CONTEXTUAL_NEXT_STORY_TARGET,
  getGeneratedEndNodeReturnNavigation,
  getGeneratedStoryNavigation,
  resolveGeneratedTargetForStory,
} from '../../store/generatedNavigation';
import { canMoveEntryToContainer } from '../tree/treeOperations';

export const TYPE_LABELS = { root: 'Racine', menu: 'Dossier', story: 'Histoire', zip: 'ZIP', ref: 'Lien', 'end-node': 'Message de fin' };
// Re-exporte depuis la source unique (useZipCover importe MIME d'ici).
export { MIME } from '../../utils/mimeTypes';
export const ZOOM_MIN = 0.08;
export const ZOOM_MAX = 1.9;
export const BUTTON_ZOOM_FACTOR = 1.12;
export const WHEEL_ZOOM_SENSITIVITY = 0.0012;
export const DRAG_START_DISTANCE = 6;
const COMPLETE_METRICS = {
  full: { nodeWidth: 100, rootWidth: 120, nodeHeight: 96, nodeVisualHeight: 82, colGap: 12, rowGap: 92, rowStackGap: 56, padX: 32, padY: 20, navPadBottom: 48, storyRowLimit: 8, structureRowLimit: 4, rootRowLimit: 3 },
  compact: { nodeWidth: 86, rootWidth: 98, nodeHeight: 74, nodeVisualHeight: 62, colGap: 8, rowGap: 78, rowStackGap: 46, padX: 28, padY: 16, navPadBottom: 44, storyRowLimit: 6, structureRowLimit: 3, rootRowLimit: 2 },
  minimal: { nodeWidth: 68, rootWidth: 84, nodeHeight: 58, nodeVisualHeight: 48, colGap: 6, rowGap: 62, rowStackGap: 36, padX: 22, padY: 12, navPadBottom: 38, storyRowLimit: 5, structureRowLimit: 2, rootRowLimit: 2 },
};

export function countStories(entries) {
  return (entries ?? []).filter((entry) => entry.type === 'story').length;
}

function countStructuralNodes(entries) {
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

function buildLayoutBlock(entry, metrics, options = {}) {
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
    name: project.projectType === 'simple'
      ? (project.projectName || 'Mon histoire')
      : (project.rootName || 'Menu racine'),
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

  const hasEndNode = !!(
    project.nightModeAudio
    || project.globalOptions?.nightMode
    || project.globalOptions?.endNode
  );
  const canvasWidth = rootBlock.width + metrics.padX * 2;
  const canvasHeight = rootBlock.height + metrics.padY * 2 + metrics.navPadBottom;

  if (hasEndNode) {
    const endNodeWidth = metrics.nodeWidth;
    const endNodeX = Math.round((canvasWidth - endNodeWidth) / 2);
    const endNodeY = canvasHeight + metrics.rowGap;
    positionedNodes.push({
      entry: {
        id: END_NODE_ID,
        type: 'end-node',
        name: project.endNodeName || 'Message de fin',
        icon: project.globalOptions?.nightMode ? 'moon' : 'stop',
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

function getRuntimeRootDiagramTarget(project) {
  return project?.rootEntries?.[0]?.id ?? 'root';
}

function diagramNodeIdFromGeneratedTarget(targetId, project = null) {
  if (!targetId || targetId === CONTEXTUAL_NEXT_STORY_TARGET) return null;
  if (targetId === 'root') return getRuntimeRootDiagramTarget(project);
  if (isStoryNavigationTarget(targetId)) return decodeNavigationStoryId(targetId);
  return targetId;
}

function resolveStoryDiagramTarget(target, entry, parentMenu, rootEntries, fallbackTarget = null, project = null) {
  return diagramNodeIdFromGeneratedTarget(
    resolveGeneratedTargetForStory(target, entry, parentMenu, rootEntries, fallbackTarget),
    project,
  );
}

function storyTargetMode(target) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized || !isStoryNavigationTarget(normalized)) return null;
  if (isStoryHomeStepNavigationTarget(normalized)) return 'story_home_step';
  return normalized.startsWith('story_play:') ? 'story_play' : 'story';
}

function collectNavigationTransitions(entries, parentMenu = null, transitions = [], hasEndNode = false, project = null, rootEntries = entries) {
  const projectType = project?.projectType ?? null;
  for (const entry of entries ?? []) {
    if (entry.type === 'story') {
      const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
      const sequence = entry.afterPlaybackSequence ?? [];
      const autoNextActive = !!project?.globalOptions?.autoNext;
      const hasSequence = sequence.length > 0 && !autoNextActive;
      const hasPrompt = !!entry.afterPlaybackPromptAudio && !autoNextActive;
      let effectiveReturnTarget = null;
      const inheritedTarget = parentMenu?.returnAfterPlay
        ? resolveStoryDiagramTarget(parentMenu.returnAfterPlay, entry, parentMenu, rootEntries, parentMenu.id, project)
        : null;
      const generatedReturnTarget = diagramNodeIdFromGeneratedTarget(navigation.directReturn.targetId, project);
      const explicitReturnTarget = !autoNextActive && entry.returnAfterPlay && generatedReturnTarget
        ? generatedReturnTarget
        : null;
      const fallbackReturnTarget = explicitReturnTarget
        ?? generatedReturnTarget
        ?? inheritedTarget
        ?? (projectType !== 'simple' ? (parentMenu?.id ?? getRuntimeRootDiagramTarget(project)) : null);

      if (hasSequence) {
        const lastStep = sequence[sequence.length - 1];
        const configuredReturnTarget = lastStep?.okTarget
          ? resolveStoryDiagramTarget(lastStep.okTarget, entry, parentMenu, rootEntries, fallbackReturnTarget, project)
          : null;
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
          const homeTarget = step?.homeTarget
            ? resolveStoryDiagramTarget(step.homeTarget, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
            : null;
          if (homeTarget && homeTarget !== effectiveReturnTarget) {
            transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'sequence' });
          }
        }
      } else if (hasPrompt) {
        effectiveReturnTarget = (entry.afterPlaybackPromptOkTarget
          ? resolveStoryDiagramTarget(entry.afterPlaybackPromptOkTarget, entry, parentMenu, rootEntries, fallbackReturnTarget, project)
          : null) ?? fallbackReturnTarget;
        if (effectiveReturnTarget) {
          transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: entry.afterPlaybackPromptOkTarget ? 'prompt' : 'implicit' });
        }
        const promptHomeTarget = entry.afterPlaybackPromptHomeNone
          ? null
          : entry.afterPlaybackPromptHomeTarget
            ? resolveStoryDiagramTarget(entry.afterPlaybackPromptHomeTarget, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
            : null;
        if (promptHomeTarget && promptHomeTarget !== effectiveReturnTarget) {
          transitions.push({ from: entry.id, to: promptHomeTarget, kind: 'home', source: 'prompt' });
        }
      } else if (hasEndNode) {
        effectiveReturnTarget = END_NODE_ID;
        transitions.push({
          from: entry.id,
          to: effectiveReturnTarget,
          kind: 'return',
          source: 'configured',
          endNodeTargetId: diagramNodeIdFromGeneratedTarget(navigation.endNodeReturn.effectiveTargetId, project),
        });
      } else {
        if (explicitReturnTarget) {
          effectiveReturnTarget = explicitReturnTarget;
          transitions.push({ from: entry.id, to: explicitReturnTarget, kind: 'return', source: 'configured' });
        } else {
          if (generatedReturnTarget && projectType !== 'simple') {
            effectiveReturnTarget = generatedReturnTarget;
            transitions.push({
              from: entry.id,
              to: generatedReturnTarget,
              kind: 'return',
              source: inheritedTarget ? 'inherited' : 'implicit',
            });
          } else if (projectType !== 'simple') {
            effectiveReturnTarget = parentMenu?.id ?? getRuntimeRootDiagramTarget(project);
            transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: 'implicit' });
          }
        }
      }

      const homeTarget = entry.returnOnHome
        ? resolveStoryDiagramTarget(entry.returnOnHome, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
        : null;
      if (homeTarget && homeTarget !== effectiveReturnTarget) {
        transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'configured' });
      }
      continue;
    }

    if (entry.type === 'ref') {
      // Un nœud `ref` est une arête vers un nœud existant : on relie la feuille ref à sa cible.
      const to = refTargetEntryId(entry.target);
      if (to) {
        transitions.push({ from: entry.id, to, kind: 'reference', source: 'reference' });
      }
      continue;
    }

    if (entry.type === 'menu') {
      collectNavigationTransitions(entry.children ?? [], entry, transitions, hasEndNode, project, rootEntries);
    }
  }

  return transitions;
}

export function getCompleteNavigationEdges(project, layout) {
  const nodeMap = new Map(layout.nodes.map((node) => [node.entry.id, node]));
  const nodeVisualHeight = layout.metrics?.nodeVisualHeight ?? layout.metrics?.nodeHeight ?? 0;
  const visualBottom = (node) => node.y + Math.min(node.height, nodeVisualHeight || node.height);

  const regularEdges = collectNavigationTransitions(project.rootEntries ?? [], null, [], layout.hasEndNode, project, project.rootEntries ?? [])
    .map((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return null;

      const selfLoop = edge.from === edge.to;
      const sameRowReturn = edge.kind === 'return' && Math.abs(from.y - to.y) < 1;
      const useRailReturn = sameRowReturn && !selfLoop;
      const x1 = selfLoop ? from.x + (from.width * 0.28) : from.x + (from.width / 2);
      const y1 = (selfLoop || useRailReturn) ? visualBottom(from) : from.y;
      const x2 = selfLoop ? from.x + (from.width * 0.72) : to.x + (to.width / 2);
      const y2 = visualBottom(to);
      const verticalDirection = y2 >= y1 ? 1 : -1;
      const controlOffset = selfLoop
        ? Math.max(30, from.height * 0.34)
        : Math.max(54, Math.abs(x2 - x1) * 0.18, Math.abs(y2 - y1) * 0.34);
      const railY = useRailReturn
        ? Math.max(y1, y2) + Math.max(22, Math.min(34, Math.abs(x2 - x1) * 0.12))
        : null;

      return {
        ...edge,
        selfLoop,
        route: useRailReturn ? 'same-row-return' : 'curve',
        x1,
        y1,
        x2,
        y2,
        labelX: x1 + ((x2 - x1) / 2),
        labelY: railY ?? (selfLoop ? y1 + controlOffset + 14 : y1 + ((y2 - y1) / 2)),
        railY,
        c1y: selfLoop ? y1 + controlOffset : y1 + (controlOffset * verticalDirection),
        c2y: selfLoop ? y2 + controlOffset : y2 - (controlOffset * verticalDirection),
      };
    })
    .filter(Boolean);

  if (layout.hasEndNode) {
    const endNode = nodeMap.get(END_NODE_ID);
    if (endNode) {
      const endNodeReturn = getGeneratedEndNodeReturnNavigation(project);
      let contextualReturnCount = 0;
      if (endNodeReturn?.isContextual) {
        const collectContextualEndNodeEdges = (entries, parentMenu = null) => {
          for (const entry of entries ?? []) {
            if (entry.type === 'story') {
              const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, project.rootEntries ?? []);
              if (!navigation.usesEndNode || !navigation.endNodeReturn.effectiveTargetId) continue;
              const to = diagramNodeIdFromGeneratedTarget(navigation.endNodeReturn.effectiveTargetId, project);
              if (to) contextualReturnCount += 1;
            } else if (entry.type === 'menu') {
              collectContextualEndNodeEdges(entry.children ?? [], entry);
            }
          }
        };
        collectContextualEndNodeEdges(project.rootEntries ?? []);
      }

      const endNodeEdges = contextualReturnCount > 0
        ? [{
          to: END_NODE_ID,
          source: 'contextual',
          label: endNodeReturn?.isDefaultContextual
            ? `Fin -> destination de chaque histoire (${contextualReturnCount} cible${contextualReturnCount > 1 ? 's' : ''})`
            : `Fin -> histoire suivante (${contextualReturnCount} cible${contextualReturnCount > 1 ? 's' : ''})`,
          selfLoop: true,
        }]
        : endNodeReturn ? [{
          to: diagramNodeIdFromGeneratedTarget(endNodeReturn?.targetId, project) ?? getRuntimeRootDiagramTarget(project),
          source: endNodeReturn?.isExplicit ? 'configured' : 'implicit',
        }] : [];

      const seenEndNodeTargets = new Set();
      for (const edge of endNodeEdges) {
        if (seenEndNodeTargets.has(edge.to)) continue;
        seenEndNodeTargets.add(edge.to);
        const returnTarget = edge.selfLoop ? endNode : (nodeMap.get(edge.to) ?? nodeMap.get('root'));
        if (!returnTarget) continue;
        const ex = edge.selfLoop ? endNode.x + endNode.width : endNode.x + endNode.width / 2;
        const ey = edge.selfLoop ? endNode.y + endNode.height / 2 : endNode.y;
        const rx = edge.selfLoop ? endNode.x : returnTarget.x + returnTarget.width / 2;
        const ry = edge.selfLoop ? endNode.y + endNode.height / 2 : returnTarget.y + returnTarget.height;
        const controlOffset = Math.max(80, Math.abs(ey - ry) * 0.4);
        regularEdges.push({
          from: END_NODE_ID,
          to: edge.to,
          kind: 'return',
          source: edge.source,
          label: edge.label,
          x1: ex,
          y1: ey + endNode.height,
          x2: rx,
          y2: ry,
          c1y: edge.selfLoop ? ey + controlOffset : ey + endNode.height + controlOffset,
          c2y: edge.selfLoop ? ry + controlOffset : ry - controlOffset,
          labelX: edge.selfLoop ? endNode.x + endNode.width / 2 : undefined,
          labelY: edge.selfLoop ? endNode.y + endNode.height + 18 : undefined,
        });
      }
    }
  }

  return regularEdges;
}

export { canMoveEntryToContainer };
