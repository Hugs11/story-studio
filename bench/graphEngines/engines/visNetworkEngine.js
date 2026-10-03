// Adaptateur vis-network — **témoin**, pas finaliste.
//
// Il n'existe que pour une raison : une anomalie commune aux deux finalistes
// doit être rejouée sur un troisième moteur canvas 2D **avant** d'être imputée
// à une bibliothèque plutôt qu'à la WebView. Sans ce témoin, un défaut de
// WebKitGTK serait attribué à Cytoscape et à G6 à la fois, et le départage
// porterait sur un symptôme qui n'appartient à aucun des deux.
//
// Il est donc volontairement minimal : il ne sert pas à départager, seulement à
// discriminer la cause.

import {
  assertEngineContract,
  DEFAULT_EDGE_VISIBILITY,
  edgeVisibilityGroup,
  EDGE_KINDS,
  EDGE_VISIBILITY_GROUPS,
  NODE_KINDS,
  plottableEdges,
} from '../../../src/components/AdvancedGraphCanvas/engines/engineContract.js';

export function createVisNetworkEngine({
  container,
  visNetwork,
  onSelect = () => {},
  onViewportChange = () => {},
  onNodeDragEnd = () => {},
  onHoverChange = () => {},
}) {
  let network = null;
  let edgesData = null;
  let edgeIdsByVisibility = new Map();
  let edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
  // Le nœud survolé, comme chez les deux finalistes. Le survol est **activé**
  // ci-dessous : le témoin ne sert pas de référence de fluidité — sa
  // simplification de détail est déjà un no-op —, et le contrat commun exige
  // que les trois adaptateurs répondent à la même question.
  let hovered = null;
  let hoveredEdge = null;
  const publishHover = () => onHoverChange({ nodePath: hovered, edgeId: hoveredEdge });

  const engine = {
    name: 'vis-network',
    version: 'témoin',

    async mount(elements) {
      const edges = plottableEdges(elements);
      edgeIdsByVisibility = new Map(Object.values(EDGE_VISIBILITY_GROUPS).map((group) => [group, []]));
      const edgeItems = edges.map((edge) => {
        const visibilityGroup = edge.visibilityGroup ?? edgeVisibilityGroup(edge);
        edgeIdsByVisibility.get(visibilityGroup)?.push(edge.id);
        return {
          id: edge.id,
          from: edge.source,
          to: edge.target,
          arrows: 'to',
          dashes: edge.kind === EDGE_KINDS.STAGE_HOME || edge.random,
          visibilityGroup,
          hidden: false,
        };
      });
      edgesData = new visNetwork.DataSet(edgeItems);
      edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
      network = new visNetwork.Network(
        container,
        {
          nodes: elements.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            x: node.x,
            y: node.y,
            fixed: true,
            shape: node.kind === NODE_KINDS.ACTION ? 'diamond' : 'box',
            color: node.kind === NODE_KINDS.ACTION ? '#8a5a2b' : '#2f6f9f',
            borderWidth: node.isEntry ? 4 : 1,
          })),
          edges: edgesData,
        },
        {
          // Aucune physique : les positions viennent du DTO, comme pour les
          // deux finalistes. Une simulation de forces mesurerait autre chose.
          physics: false,
          layout: { improvedLayout: false },
          interaction: { dragNodes: true, hover: true },
        },
      );
      network.on('selectNode', (event) => onSelect(event.nodes));
      network.on('deselectNode', (event) => onSelect(event.nodes));
      network.on('dragEnd', (event) => {
        const [id] = event.nodes ?? [];
        if (id) onNodeDragEnd(id, network.getPositions([id])[id]);
      });
      network.on('hoverNode', (event) => {
        hovered = event?.node ?? null;
        publishHover();
      });
      network.on('blurNode', (event) => {
        if (hovered === (event?.node ?? null)) {
          hovered = null;
          publishHover();
        }
      });
      network.on('hoverEdge', (event) => {
        hoveredEdge = event?.edge ?? null;
        publishHover();
      });
      network.on('blurEdge', (event) => {
        if (hoveredEdge === (event?.edge ?? null)) {
          hoveredEdge = null;
          publishHover();
        }
      });
      network.on('zoom', () => onViewportChange(engine.getViewport()));
      network.on('dragEnd', () => onViewportChange(engine.getViewport()));
      return { nodes: elements.nodes.length, edges: plottableEdges(elements).length };
    },

    async setViewport({ x, y, zoom }) {
      network?.moveTo({ position: { x, y }, scale: zoom, animation: false });
    },

    getViewport() {
      if (!network) return { x: 0, y: 0, zoom: 1 };
      const position = network.getViewPosition();
      return { x: position.x, y: position.y, zoom: network.getScale() };
    },

    async focusNode(path) {
      if (!network) return false;
      network.focus(path, { animation: false, scale: network.getScale() });
      return true;
    },

    // Le banc ne pose aucune couche HTML sur le canvas : rien à rejouer.
    forwardWheel() {
      return false;
    },

    nodeAtPointer() {
      return network ? hovered : null;
    },

    edgeAtPointer() {
      return network ? hoveredEdge : null;
    },

    setNodeImage() {
      // Adaptateur témoin : aucune charge visuelle de production ajoutée.
    },

    async setSelection(paths) {
      network?.selectNodes(paths, false);
    },

    async setPresentation() {
      // Adaptateur témoin : la présentation de lecture appartient au moteur
      // Cytoscape retenu, pas au diagnostic inter-moteurs.
    },

    async setEdgeVisibility(visibility = DEFAULT_EDGE_VISIBILITY) {
      if (!edgesData) return;
      const updates = [];
      for (const group of Object.values(EDGE_VISIBILITY_GROUPS)) {
        const wasVisible = edgeVisibility[group] !== false;
        const isVisible = visibility?.[group] !== false;
        if (wasVisible === isVisible) continue;
        for (const id of edgeIdsByVisibility.get(group) ?? []) {
          updates.push({ id, hidden: !isVisible });
        }
        edgeVisibility[group] = isVisible;
      }
      if (updates.length > 0) edgesData.update(updates);
    },

    async setDetailLevel() {
      // Le témoin ne porte aucune optimisation de détail : il sert à rejouer
      // une anomalie, pas à être comparé sur la fluidité.
    },

    // Témoin : palette fixe, indépendante du thème. Voir l'adaptateur G6.
    refreshTheme() {},

    resize() {
      network?.redraw();
    },

    async fitContent() {
      network?.fit({ animation: false });
    },

    async exportImage() {
      return container.querySelector('canvas')?.toDataURL('image/png') ?? null;
    },

    destroy() {
      network?.destroy();
      network = null;
      edgesData = null;
      edgeIdsByVisibility = new Map();
      edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
      hovered = null;
      hoveredEdge = null;
      onHoverChange({ nodePath: null, edgeId: null });
    },
  };

  return assertEngineContract(engine);
}
