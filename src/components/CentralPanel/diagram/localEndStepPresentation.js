const END_STEP_WIDTH = 112;
const END_STEP_HEIGHT = 44;
const END_STEP_MARGIN = 8;

function visualBottom(node, metrics) {
  const visualHeight = metrics?.nodeVisualHeight ?? node.height;
  return node.y + Math.min(node.height, visualHeight);
}

function intersects(a, b) {
  return !(
    a.x + a.width + END_STEP_MARGIN <= b.x
    || b.x + b.width + END_STEP_MARGIN <= a.x
    || a.y + a.height + END_STEP_MARGIN <= b.y
    || b.y + b.height + END_STEP_MARGIN <= a.y
  );
}

function placeEndStep(source, target, layout, occupied) {
  const preferredX = ((source.x + (source.width / 2)) + (target.x + (target.width / 2))) / 2 - (END_STEP_WIDTH / 2);
  const preferredY = ((visualBottom(source, layout.metrics) + target.y) / 2) - (END_STEP_HEIGHT / 2);
  const maxX = Math.max(END_STEP_MARGIN, layout.width - END_STEP_WIDTH - END_STEP_MARGIN);
  const maxY = Math.max(END_STEP_MARGIN, layout.height - END_STEP_HEIGHT - END_STEP_MARGIN);
  const shifts = [0, -1, 1, -2, 2, -3, 3].map((lane) => lane * (END_STEP_WIDTH + END_STEP_MARGIN));

  for (const shift of shifts) {
    const candidate = {
      x: Math.max(END_STEP_MARGIN, Math.min(maxX, preferredX + shift)),
      y: Math.max(END_STEP_MARGIN, Math.min(maxY, preferredY)),
      width: END_STEP_WIDTH,
      height: END_STEP_HEIGHT,
    };
    if (!occupied.some((rect) => intersects(candidate, rect))) return candidate;
  }

  return {
    x: Math.max(END_STEP_MARGIN, Math.min(maxX, preferredX)),
    y: Math.max(END_STEP_MARGIN, Math.min(maxY, preferredY)),
    width: END_STEP_WIDTH,
    height: END_STEP_HEIGHT,
  };
}

function curveBetween(from, to, layout) {
  const fromBelow = from.y <= to.y;
  const x1 = from.x + (from.width / 2);
  const y1 = fromBelow ? visualBottom(from, layout.metrics) : from.y;
  const x2 = to.x + (to.width / 2);
  const y2 = fromBelow ? to.y : visualBottom(to, layout.metrics);
  const direction = y2 >= y1 ? 1 : -1;
  const controlOffset = Math.max(28, Math.abs(x2 - x1) * 0.16, Math.abs(y2 - y1) * 0.36);

  return {
    route: 'curve',
    x1,
    y1,
    x2,
    y2,
    c1y: y1 + (controlOffset * direction),
    c2y: y2 - (controlOffset * direction),
    labelX: x1 + ((x2 - x1) / 2),
    labelY: y1 + ((y2 - y1) / 2),
  };
}

// Transforme une relation « histoire → destination » en deux segments quand
// une fin locale existe réellement. Les cartes sont visuelles seulement : le
// modèle et la navigation générée restent inchangés.
export function presentLocalEndSteps(layout, navigationEdges) {
  const realNodes = new Map(layout.nodes.map((node) => [node.entry.id, node]));
  const occupied = layout.nodes.map((node) => ({
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }));
  const localNodes = [];
  const expandedEdges = [];

  for (const edge of navigationEdges) {
    if (!edge.localEnd) {
      expandedEdges.push(edge);
      continue;
    }

    const source = realNodes.get(edge.from);
    const target = realNodes.get(edge.displayTo ?? edge.to);
    if (!source || !target) {
      expandedEdges.push(edge);
      continue;
    }

    const id = `local-end:${edge.from}`;
    const placement = placeEndStep(source, target, layout, occupied);
    const localNode = {
      id,
      storyId: edge.from,
      ...edge.localEnd,
      ...placement,
    };
    localNodes.push(localNode);
    occupied.push(placement);

    const virtualNode = { ...placement };
    expandedEdges.push({
      ...edge,
      to: id,
      source: `${edge.source}-start`,
      localEndLeg: 'start',
      localEndStoryId: edge.from,
      ...curveBetween(source, virtualNode, layout),
    });
    expandedEdges.push({
      ...edge,
      from: id,
      source: `${edge.source}-exit`,
      localEndLeg: 'exit',
      localEndStoryId: edge.from,
      ...curveBetween(virtualNode, target, layout),
    });
  }

  return { localNodes, navigationEdges: expandedEdges };
}
