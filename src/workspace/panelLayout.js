export const WORKSPACE_PANEL_IDS = Object.freeze({
  STRUCTURE: 'structure',
  SETTINGS: 'settings',
  DIAGRAM: 'diagram',
});

export const DEFAULT_WORKSPACE_PANEL_ORDER = Object.freeze([
  WORKSPACE_PANEL_IDS.STRUCTURE,
  WORKSPACE_PANEL_IDS.SETTINGS,
  WORKSPACE_PANEL_IDS.DIAGRAM,
]);

const KNOWN_PANEL_IDS = new Set(DEFAULT_WORKSPACE_PANEL_ORDER);
const RESIZABLE_PANEL_IDS = new Set([
  WORKSPACE_PANEL_IDS.STRUCTURE,
  WORKSPACE_PANEL_IDS.SETTINGS,
]);

export function normalizeWorkspacePanelOrder(value) {
  if (!Array.isArray(value) || value.length !== DEFAULT_WORKSPACE_PANEL_ORDER.length) {
    return [...DEFAULT_WORKSPACE_PANEL_ORDER];
  }
  const uniqueIds = new Set(value);
  if (uniqueIds.size !== DEFAULT_WORKSPACE_PANEL_ORDER.length) {
    return [...DEFAULT_WORKSPACE_PANEL_ORDER];
  }
  if (value.some((id) => !KNOWN_PANEL_IDS.has(id))) {
    return [...DEFAULT_WORKSPACE_PANEL_ORDER];
  }
  return [...value];
}

export const WORKSPACE_PANEL_ORDER_CODEC = Object.freeze({
  decode: (rawValue) => {
    try {
      return normalizeWorkspacePanelOrder(JSON.parse(rawValue));
    } catch {
      return [...DEFAULT_WORKSPACE_PANEL_ORDER];
    }
  },
  encode: (value) => JSON.stringify(normalizeWorkspacePanelOrder(value)),
});

export function reorderWorkspacePanels(order, activeId, overId) {
  const normalized = normalizeWorkspacePanelOrder(order);
  const activeIndex = normalized.indexOf(activeId);
  const overIndex = normalized.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return normalized;

  const next = [...normalized];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
}

export function getVisibleWorkspacePanelOrder(order, visibility) {
  return normalizeWorkspacePanelOrder(order).filter((id) => visibility[id] !== false);
}

export function getFlexibleWorkspacePanelId(visibleOrder) {
  if (!Array.isArray(visibleOrder) || visibleOrder.length === 0) return null;
  if (visibleOrder.includes(WORKSPACE_PANEL_IDS.DIAGRAM)) return WORKSPACE_PANEL_IDS.DIAGRAM;
  return visibleOrder.at(-1) ?? null;
}

function getAdjacentBoundaryIndexes(panelIndex, panelCount) {
  const indexes = [];
  if (panelIndex < panelCount - 1) indexes.push(panelIndex);
  if (panelIndex > 0) indexes.push(panelIndex - 1);
  return indexes;
}

// Assigne au plus une largeur persistée à chaque frontière. Avec les trois
// panneaux visibles, les deux panneaux redimensionnables reçoivent chacun une
// poignée, quelle que soit la position du Diagramme. Avec Arbre + Réglages seuls,
// la frontière pilote le panneau de gauche et le dernier remplit l'espace restant.
export function getWorkspaceResizeBoundaries(visibleOrder) {
  const panels = Array.isArray(visibleOrder)
    ? visibleOrder.filter((id, index) => KNOWN_PANEL_IDS.has(id) && visibleOrder.indexOf(id) === index)
    : [];
  if (panels.length < 2) return [];

  const boundaryCount = panels.length - 1;
  const assignments = new Map();
  const resizablePanels = panels
    .map((panelId, panelIndex) => ({
      panelId,
      panelIndex,
      candidates: getAdjacentBoundaryIndexes(panelIndex, panels.length),
    }))
    .filter(({ panelId }) => RESIZABLE_PANEL_IDS.has(panelId))
    .sort((a, b) => a.candidates.length - b.candidates.length || a.panelIndex - b.panelIndex);

  for (const panel of resizablePanels) {
    const boundaryIndex = panel.candidates.find((candidate) => !assignments.has(candidate));
    if (boundaryIndex !== undefined) assignments.set(boundaryIndex, panel);
  }

  return Array.from({ length: boundaryCount }, (_, boundaryIndex) => {
    const panel = assignments.get(boundaryIndex);
    if (!panel) return null;
    return {
      id: `${panels[boundaryIndex]}-${panels[boundaryIndex + 1]}`,
      beforePanelId: panels[boundaryIndex],
      afterPanelId: panels[boundaryIndex + 1],
      resizedPanelId: panel.panelId,
      direction: panel.panelIndex === boundaryIndex ? 1 : -1,
    };
  }).filter(Boolean);
}
