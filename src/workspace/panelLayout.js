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

export const ADVANCED_WORKSPACE_PANEL_IDS = Object.freeze({
  NODE_LIST: 'advanced-node-list',
  GRAPH: 'advanced-graph',
  INSPECTOR: 'advanced-inspector',
});

export const DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER = Object.freeze([
  ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST,
  ADVANCED_WORKSPACE_PANEL_IDS.GRAPH,
  ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR,
]);

export const ADVANCED_NODE_LIST_WIDTH_MIN = 220;
export const ADVANCED_NODE_LIST_WIDTH_MAX = 380;
export const ADVANCED_NODE_LIST_WIDTH_DEFAULT = 240;
// Le troisième panneau est désormais un vrai panneau Réglages : il reprend
// l'amplitude du Libre pour que ses cartes et outils média communs ne soient
// pas tassés dans l'ancienne largeur d'inspecteur.
export const ADVANCED_INSPECTOR_WIDTH_MIN = 200;
export const ADVANCED_INSPECTOR_WIDTH_MAX = 900;
export const ADVANCED_INSPECTOR_WIDTH_DEFAULT = 800;

const KNOWN_PANEL_IDS = new Set(DEFAULT_WORKSPACE_PANEL_ORDER);
const RESIZABLE_PANEL_IDS = new Set([
  WORKSPACE_PANEL_IDS.STRUCTURE,
  WORKSPACE_PANEL_IDS.SETTINGS,
]);
const KNOWN_ADVANCED_PANEL_IDS = new Set(DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER);
const RESIZABLE_ADVANCED_PANEL_IDS = new Set([
  ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST,
  ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR,
]);

export function normalizeWorkspacePanelOrder(value) {
  return normalizePanelOrder(value, DEFAULT_WORKSPACE_PANEL_ORDER);
}

export function normalizeAdvancedWorkspacePanelOrder(value) {
  return normalizePanelOrder(value, DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER);
}

function normalizePanelOrder(value, defaultOrder) {
  if (!Array.isArray(defaultOrder) || defaultOrder.length === 0) return [];
  if (!Array.isArray(value) || value.length !== defaultOrder.length) {
    return [...defaultOrder];
  }
  const uniqueIds = new Set(value);
  if (uniqueIds.size !== defaultOrder.length) {
    return [...defaultOrder];
  }
  const knownIds = new Set(defaultOrder);
  if (value.some((id) => !knownIds.has(id))) {
    return [...defaultOrder];
  }
  return [...value];
}

function createPanelOrderCodec(defaultOrder) {
  return Object.freeze({
    decode: (rawValue) => {
      try {
        return normalizePanelOrder(JSON.parse(rawValue), defaultOrder);
      } catch {
        return [...defaultOrder];
      }
    },
    encode: (value) => JSON.stringify(normalizePanelOrder(value, defaultOrder)),
  });
}

// Le codec Libre garde volontairement son format historique. L'ajout des
// panneaux du graphe utilise une autre clé et un autre codec : une disposition
// enregistrée avant l'arrivée des panneaux du graphe est relue octet pour octet.
export const WORKSPACE_PANEL_ORDER_CODEC = createPanelOrderCodec(DEFAULT_WORKSPACE_PANEL_ORDER);

export const ADVANCED_WORKSPACE_PANEL_ORDER_CODEC = createPanelOrderCodec(
  DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
);

function reorderPanels(order, activeId, overId, defaultOrder) {
  const normalized = normalizePanelOrder(order, defaultOrder);
  const activeIndex = normalized.indexOf(activeId);
  const overIndex = normalized.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return normalized;

  const next = [...normalized];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
}

export function reorderWorkspacePanels(order, activeId, overId) {
  return reorderPanels(order, activeId, overId, DEFAULT_WORKSPACE_PANEL_ORDER);
}

export function reorderAdvancedWorkspacePanels(order, activeId, overId) {
  return reorderPanels(order, activeId, overId, DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER);
}

function getVisiblePanelOrder(order, visibility, defaultOrder) {
  return normalizePanelOrder(order, defaultOrder).filter((id) => visibility[id] !== false);
}

export function getVisibleWorkspacePanelOrder(order, visibility) {
  return getVisiblePanelOrder(order, visibility, DEFAULT_WORKSPACE_PANEL_ORDER);
}

export function getVisibleAdvancedWorkspacePanelOrder(order, visibility) {
  return getVisiblePanelOrder(order, visibility, DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER);
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

// Assigne au plus une largeur persistée à chaque frontière. Avec trois panneaux
// visibles, les deux panneaux redimensionnables reçoivent chacun une poignée,
// quelle que soit la position de la surface flexible. Avec seulement deux
// panneaux redimensionnables, la frontière pilote celui de gauche.
function getPanelResizeBoundaries(visibleOrder, knownPanelIds, resizablePanelIds) {
  const panels = Array.isArray(visibleOrder)
    ? visibleOrder.filter((id, index) => (
        knownPanelIds.has(id) && visibleOrder.indexOf(id) === index
      ))
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
    .filter(({ panelId }) => resizablePanelIds.has(panelId))
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

export function getWorkspaceResizeBoundaries(visibleOrder) {
  return getPanelResizeBoundaries(visibleOrder, KNOWN_PANEL_IDS, RESIZABLE_PANEL_IDS);
}

// Même contrat que l'Éditeur libre : les deux panneaux latéraux portent une
// largeur persistée et le Graphe absorbe le reste, indépendamment de l'ordre.
export function getAdvancedWorkspaceResizeBoundaries(visibleOrder) {
  return getPanelResizeBoundaries(
    visibleOrder,
    KNOWN_ADVANCED_PANEL_IDS,
    RESIZABLE_ADVANCED_PANEL_IDS,
  );
}
