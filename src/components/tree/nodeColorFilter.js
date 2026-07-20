import { TREE_COLOR_PALETTE } from './treeOperations.js';

const COLOR_LABELS = new Map([
  ['#e24b4a', 'Rouge'],
  ['#ef9f27', 'Orange'],
  ['#f0c84b', 'Jaune'],
  ['#5fbf6b', 'Vert'],
  ['#3d9be9', 'Bleu'],
  ['#7c6af7', 'Violet'],
  ['#d95bb4', 'Rose'],
]);

export function normalizeNodeColor(color) {
  return typeof color === 'string' ? color.trim().toLowerCase() : '';
}

export function getNodeColorLabel(color) {
  const normalized = normalizeNodeColor(color);
  return COLOR_LABELS.get(normalized) ?? `Couleur ${normalized || 'inconnue'}`;
}

export function buildUsedNodeColors(colors) {
  const counts = new Map();
  for (const color of colors ?? []) {
    const normalized = normalizeNodeColor(color);
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  const paletteOrder = new Map(TREE_COLOR_PALETTE.map((color, index) => [normalizeNodeColor(color), index]));
  return [...counts]
    .sort(([left], [right]) => {
      const leftOrder = paletteOrder.get(left) ?? Number.POSITIVE_INFINITY;
      const rightOrder = paletteOrder.get(right) ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || left.localeCompare(right);
    })
    .map(([color, count]) => ({ color, count, label: getNodeColorLabel(color) }));
}

export function collectProjectUsedNodeColors(project, projectIndex) {
  return buildUsedNodeColors([
    project?.treeColor,
    ...(projectIndex?.flatEntries ?? []).map(({ entry }) => entry?.treeColor),
  ]);
}

export function matchesNodeColor(color, selectedColors) {
  if (!selectedColors || selectedColors.size === 0) return true;
  return selectedColors.has(normalizeNodeColor(color));
}

export function toggleNodeColorFilter(selectedColors, color) {
  const normalized = normalizeNodeColor(color);
  const next = new Set(selectedColors ?? []);
  if (!normalized) return next;
  if (next.has(normalized)) next.delete(normalized);
  else next.add(normalized);
  return next;
}
