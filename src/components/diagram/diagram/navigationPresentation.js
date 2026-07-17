export function compactNavigationPresentation(_project, edges) {
  return edges.map((edge) => {
      if (edge.kind === 'sequence') return { ...edge, kind: 'after-end', source: 'sequence' };
      if (edge.kind === 'return' && edge.source === 'prompt') {
        return { ...edge, kind: 'after-end', source: 'prompt' };
      }
      return edge;
    });
}

export function navigationEdgeTouchesNode(edge, nodeId) {
  return edge.from === nodeId
    || edge.to === nodeId
    || edge.displayTo === nodeId
    || edge.localEndStoryId === nodeId
    || edge.contextualStoryId === nodeId
    || edge.chainStoryIds?.includes(nodeId);
}

export function findPrimaryStoryNavigationEdge(storyId, edges = []) {
  if (!storyId) return null;
  const priority = { 'after-end': 0, sequence: 0, return: 1, reference: 1, home: 2 };
  return edges
    .filter((edge) => edge.from === storyId)
    .sort((left, right) => (priority[left.kind] ?? 9) - (priority[right.kind] ?? 9))[0]
    ?? null;
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

  if (activeEdge.contextualStoryId) {
    let hasExactContinuation = false;
    for (const edge of navigationEdges) {
      const touchesEndNode = edge.to === endNodeId || edge.from === endNodeId;
      if (touchesEndNode && edge.contextualStoryId === activeEdge.contextualStoryId) {
        pathEdges.add(edge);
        if (edge !== activeEdge && edge.from === endNodeId) hasExactContinuation = true;
      }
    }
    if (activeEdge.to === endNodeId && !hasExactContinuation && activeEdge.endNodeTargetId) {
      const sharedContinuation = navigationEdges.find((edge) => (
        edge.from === endNodeId && edge.to === activeEdge.endNodeTargetId
      ));
      if (sharedContinuation) pathEdges.add(sharedContinuation);
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
