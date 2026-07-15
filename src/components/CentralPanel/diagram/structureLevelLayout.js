import { buildStructureProjection, getStructureEdgeId } from './structurePresentation.js';

const END_NODE_ID = 'end-node';

function measureTree(node, metrics, horizontalGap) {
  const nodeWidth = node.entry.type === 'root' ? metrics.rootWidth : metrics.nodeWidth;
  const children = node.children.map((child) => measureTree(child, metrics, horizontalGap));
  const childrenWidth = children.length
    ? children.reduce((sum, child) => sum + child.subtreeWidth, 0) + (horizontalGap * (children.length - 1))
    : 0;
  return {
    ...node,
    nodeWidth,
    children,
    subtreeWidth: Math.max(nodeWidth, childrenWidth),
    childrenWidth,
  };
}

function maxDepth(node) {
  return node.children.reduce((depth, child) => Math.max(depth, maxDepth(child)), node.depth);
}

export function getStructureLevelLayout(project, metrics, options = {}) {
  const projection = buildStructureProjection(project, options);
  const horizontalGap = Math.max(18, metrics.colGap * 1.5);
  const rowPitch = metrics.nodeHeight + Math.max(74, metrics.rowGap);
  const labelGutter = 46;
  const padX = metrics.padX + labelGutter;
  const padY = metrics.padY + 24;
  const measuredRoot = measureTree(projection, metrics, horizontalGap);
  const nodes = [];
  const edges = [];

  function place(node, left) {
    const x = left + ((node.subtreeWidth - node.nodeWidth) / 2);
    const y = padY + (node.depth * rowPitch);
    nodes.push({
      entry: node.entry,
      x,
      y,
      width: node.nodeWidth,
      height: metrics.nodeHeight,
      depth: node.depth,
      parentId: node.parentId,
    });

    if (!node.children.length) return;
    let childLeft = left + ((node.subtreeWidth - node.childrenWidth) / 2);
    for (const child of node.children) {
      const childX = childLeft + ((child.subtreeWidth - child.nodeWidth) / 2);
      const childY = padY + (child.depth * rowPitch);
      const edge = {
        id: `structure:${node.id}:${child.id}`,
        from: node.id,
        to: child.id,
        kind: child.entry.type === 'story' ? 'story' : child.entry.type === 'story-group' ? 'story-group' : 'structural',
        x1: x + (node.nodeWidth / 2),
        y1: y + metrics.nodeHeight,
        x2: childX + (child.nodeWidth / 2),
        y2: childY,
        depth: child.depth,
      };
      edge.midY = edge.y1 + ((edge.y2 - edge.y1) / 2);
      edge.id = getStructureEdgeId(edge);
      edges.push(edge);
      place(child, childLeft);
      childLeft += child.subtreeWidth + horizontalGap;
    }
  }

  place(measuredRoot, padX);
  const depthCount = maxDepth(measuredRoot) + 1;
  const width = measuredRoot.subtreeWidth + (padX * 2);
  let height = padY + ((depthCount - 1) * rowPitch) + metrics.nodeHeight + metrics.padY + 28;
  const bands = Array.from({ length: depthCount }, (_, depth) => ({
    depth,
    label: `N${depth}`,
    y: padY + (depth * rowPitch) - 20,
    height: metrics.nodeHeight + 40,
  }));

  const hiddenStoryGroupByStoryId = new Map();
  for (const node of nodes) {
    if (node.entry.type !== 'story-group') continue;
    node.entry.storyIds?.forEach((storyId) => hiddenStoryGroupByStoryId.set(storyId, node.entry.id));
  }

  const hasEndNode = !!(
    project.nightModeAudio
    || project.globalOptions?.nightMode
    || project.globalOptions?.endNode
  );
  let endNodeX = null;
  let endNodeY = null;
  if (hasEndNode) {
    const endNodeWidth = Math.max(64, Math.round(metrics.nodeWidth * 0.78));
    const endNodeHeight = 50;
    const endBandGap = Math.max(28, metrics.rowGap * 0.38);
    endNodeY = height + endBandGap;
    endNodeX = Math.round((width - endNodeWidth) / 2);
    bands.push({
      depth: 'end',
      kind: 'after-reading',
      label: 'FIN',
      secondaryLabel: 'Après la lecture',
      y: endNodeY - 18,
      height: endNodeHeight + 34,
    });
    nodes.push({
      entry: {
        id: END_NODE_ID,
        type: 'end-node',
        name: project.endNodeName || 'Message de fin',
        icon: project.globalOptions?.nightMode ? 'moon' : 'stop',
      },
      x: endNodeX,
      y: endNodeY,
      width: endNodeWidth,
      height: endNodeHeight,
      depth: null,
      parentId: null,
    });
    height = endNodeY + endNodeHeight + metrics.padY + 18;
  }

  return {
    width,
    height,
    metrics,
    nodes,
    edges,
    groups: [],
    bands,
    hasEndNode,
    endNodeX: endNodeX == null ? undefined : endNodeX + (nodes.at(-1).width / 2),
    endNodeY: endNodeY ?? undefined,
    endNodeHeight: hasEndNode ? nodes.at(-1).height : undefined,
    hiddenStoryGroupByStoryId,
    isLevelLayout: true,
  };
}
