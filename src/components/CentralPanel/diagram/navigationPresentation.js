// Condense les playlists créées par un message de fin : dans un grand dossier,
// tracer chaque transition vers l'histoire suivante masque la seule sortie qui
// compte réellement. Le modèle de navigation ne change pas ; seule sa lecture
// dans le diagramme est simplifiée.
function compactGlobalEndRoutes(project, edges, layout) {
  if (!layout) return edges;
  const nodesById = new Map(layout.nodes.map((node) => [node.entry.id, node]));
  const endNode = nodesById.get('end-node');
  if (!endNode) return edges;

  const hiddenIndexes = new Set();
  const groupedEdges = [];
  const findGlobalEndEdge = (storyId) => edges.findIndex((edge, index) => (
    !hiddenIndexes.has(index)
    && edge.from === storyId
    && edge.to === 'end-node'
    && edge.source === 'global-end'
  ));
  const visualBottom = (node) => node.y + Math.min(node.height, layout.metrics?.nodeVisualHeight ?? node.height);

  const visit = (entries) => {
    for (const entry of entries ?? []) {
      if (entry.type !== 'menu') continue;
      const stories = (entry.children ?? []).filter((child) => child.type === 'story');
      const indexes = stories.length >= 3 ? stories.map((story) => findGlobalEndEdge(story.id)) : [];
      const source = nodesById.get(entry.id);
      if (source && indexes.length > 0 && indexes.every((index) => index >= 0)) {
        indexes.forEach((index) => hiddenIndexes.add(index));
        const template = edges[indexes[0]];
        const x1 = source.x + (source.width / 2);
        const y1 = visualBottom(source);
        const x2 = endNode.x + (endNode.width / 2);
        const y2 = endNode.y;
        const controlOffset = Math.max(54, Math.abs(x2 - x1) * 0.18, Math.abs(y2 - y1) * 0.34);
        groupedEdges.push({
          ...template,
          from: entry.id,
          source: 'global-group',
          chainStoryIds: stories.map((story) => story.id),
          endNodeTargetId: entry.id,
          x1,
          y1,
          x2,
          y2,
          c1y: y1 + controlOffset,
          c2y: y2 - controlOffset,
          labelX: x1 + ((x2 - x1) / 2),
          labelY: y1 + ((y2 - y1) / 2),
          route: 'curve',
        });
      }
      visit(entry.children);
    }
  };

  visit(project?.rootEntries);
  return [...edges.filter((_, index) => !hiddenIndexes.has(index)), ...groupedEdges];
}

export function compactNavigationPresentation(project, edges, layout = null) {
  const edgeIndexByRoute = new Map();
  edges.forEach((edge, index) => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.source ?? ''}`;
    const indexes = edgeIndexByRoute.get(key) ?? [];
    indexes.push(index);
    edgeIndexByRoute.set(key, indexes);
  });

  const findPromptReturn = (from, to) => {
    const indexes = edgeIndexByRoute.get(`${from}\u0000${to}\u0000return\u0000prompt`);
    return indexes?.[0] ?? null;
  };
  const hiddenIndexes = new Set();
  const replacements = new Map();

  const visit = (entries) => {
    for (const entry of entries ?? []) {
      if (entry.type !== 'menu') continue;

      const stories = (entry.children ?? []).filter((child) => child.type === 'story');
      // Deux vignettes restent immédiatement lisibles. À partir de trois, les
      // traits intermédiaires n'apportent plus d'information et encombrent vite
      // les gros packs.
      if (stories.length >= 3) {
        const internalIndexes = stories.slice(0, -1).map((story, index) => (
          findPromptReturn(story.id, stories[index + 1].id)
        ));
        const terminalIndex = findPromptReturn(stories.at(-1).id, entry.id);

        if (internalIndexes.every((index) => index != null) && terminalIndex != null) {
          internalIndexes.forEach((index) => hiddenIndexes.add(index));
          replacements.set(terminalIndex, {
            ...edges[terminalIndex],
            kind: 'after-end',
            source: 'prompt-chain',
            chainStoryIds: stories.map((story) => story.id),
          });
        }
      }

      visit(entry.children);
    }
  };

  visit(project?.rootEntries);

  const compacted = edges
    .map((edge, index) => {
      if (hiddenIndexes.has(index)) return null;
      const replacement = replacements.get(index);
      if (replacement) return replacement;
      if (edge.kind === 'sequence') return { ...edge, kind: 'after-end', source: 'sequence' };
      if (edge.kind === 'return' && edge.source === 'prompt') {
        return { ...edge, kind: 'after-end', source: 'prompt' };
      }
      return edge;
    })
    .filter(Boolean);

  return compactGlobalEndRoutes(project, compacted, layout);
}

export function navigationEdgeTouchesNode(edge, nodeId) {
  return edge.from === nodeId
    || edge.to === nodeId
    || edge.displayTo === nodeId
    || edge.localEndStoryId === nodeId
    || edge.chainStoryIds?.includes(nodeId);
}

function chainIdsOverlap(left, right) {
  if (!left?.length || !right?.length) return false;
  const rightIds = new Set(right);
  return left.some((nodeId) => rightIds.has(nodeId));
}

// Plusieurs traits peuvent représenter un seul trajet lisible : les deux
// jambes d'une fin locale, ou l'aller vers le message global puis sa reprise.
// Survoler n'importe laquelle doit donc activer le trajet entier.
export function collectActiveNavigationPathEdges(activeEdge, navigationEdges = [], endNodeId = 'end-node') {
  if (!activeEdge) return [];

  const pathEdges = new Set([activeEdge]);
  const orderedPathEdges = () => {
    const ordered = navigationEdges.filter((edge) => pathEdges.has(edge));
    if (!ordered.includes(activeEdge)) ordered.push(activeEdge);
    return ordered;
  };
  if (activeEdge.localEndStoryId) {
    for (const edge of navigationEdges) {
      if (edge.localEndStoryId === activeEdge.localEndStoryId && edge.kind === activeEdge.kind) {
        pathEdges.add(edge);
      }
    }
    return orderedPathEdges();
  }

  const endTargetId = activeEdge.to === endNodeId
    ? activeEdge.endNodeTargetId
    : activeEdge.from === endNodeId
      ? activeEdge.to
      : null;
  if (!endTargetId) return orderedPathEdges();

  for (const edge of navigationEdges) {
    const isMatchingIncoming = edge.to === endNodeId && edge.endNodeTargetId === endTargetId;
    const isMatchingContinuation = edge.from === endNodeId && edge.to === endTargetId;
    const isSameGroupedRoute = (edge.to === endNodeId || edge.from === endNodeId)
      && chainIdsOverlap(edge.chainStoryIds, activeEdge.chainStoryIds);
    if (isMatchingIncoming || isMatchingContinuation || isSameGroupedRoute) pathEdges.add(edge);
  }

  return orderedPathEdges();
}

// Les histoires d'un trajet agrégé participent à sa lecture, mais ne sont pas
// ses extrémités. Les séparer évite de leur donner à toutes le même contour que
// le nœud réellement sélectionné.
export function buildNavigationNodeRoles(activeEdge, navigationEdges = [], endNodeId = 'end-node') {
  if (!activeEdge) return { activeNodeIds: new Set(), memberNodeIds: new Set() };

  const activeNodeIds = new Set();
  const memberNodeIds = new Set();
  for (const edge of collectActiveNavigationPathEdges(activeEdge, navigationEdges, endNodeId)) {
    activeNodeIds.add(edge.from);
    activeNodeIds.add(edge.to);
    if (edge.displayTo) activeNodeIds.add(edge.displayTo);
    if (edge.localEndStoryId) activeNodeIds.add(edge.localEndStoryId);
    if (edge.to === endNodeId && edge.endNodeTargetId) activeNodeIds.add(edge.endNodeTargetId);
    edge.chainStoryIds?.forEach((nodeId) => memberNodeIds.add(nodeId));
  }

  activeNodeIds.forEach((nodeId) => memberNodeIds.delete(nodeId));
  return { activeNodeIds, memberNodeIds };
}
