// Adaptateur AntV G6 v5 — finaliste « référence fonctionnelle d'éditeur ».
//
// **Canvas 2D forcé** : le renderer par défaut de G6 v5 est `@antv/g-canvas`,
// et aucun renderer WebGL n'est demandé ici. Le canvas 2D reste le socle de
// conformité partout ; le WebGL n'est relevé que pour le vainqueur,
// et seulement s'il est prouvé réellement accéléré.
//
// Tout le vocabulaire G6 est enfermé ici, exactement comme le vocabulaire
// Cytoscape l'est dans son propre fichier. Les deux adaptateurs portent la même
// charge visuelle — mêmes formes, mêmes libellés, même différenciation OK/HOME
// — sans quoi la comparaison n'en serait plus une.

import {
  assertEngineContract,
  DEFAULT_EDGE_VISIBILITY,
  danglingSourcePaths,
  edgeVisibilityGroup,
  EDGE_KINDS,
  EDGE_VISIBILITY_GROUPS,
  NODE_KINDS,
  plottableEdges,
} from '../../../src/components/AdvancedGraphCanvas/engines/engineContract.js';

const STAGE_COLOR = '#2f6f9f';
const ACTION_COLOR = '#8a5a2b';
const ENTRY_COLOR = '#1f7a4c';

export function createG6Engine({
  container,
  g6,
  onSelect = () => {},
  onViewportChange = () => {},
  onNodeDragEnd = () => {},
  onHoverChange = () => {},
}) {
  let graph = null;
  // La sélection courante, tenue par l'adaptateur pour ne toucher que le delta.
  let selected = new Set();
  let detail = 'full';
  let viewportTimer = null;
  let selectionTimer = null;
  // Le nœud survolé, tenu par le criblage **du moteur** — même rôle et même
  // règle que chez Cytoscape : l'adaptateur note, il ne cherche pas.
  let hovered = null;
  let hoveredEdge = null;
  let edgeIdsByVisibility = new Map();
  let edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
  const publishHover = () => onHoverChange({ nodePath: hovered, edgeId: hoveredEdge });

  // G6 n'émet pas d'événement de viewport aussi simplement que Cytoscape : la
  // caméra est relevée après les gestes de canvas. Le relevé est différé d'une
  // image pour ne pas mesurer un état intermédiaire.
  function noteViewport() {
    if (viewportTimer !== null) return;
    viewportTimer = requestAnimationFrame(() => {
      viewportTimer = null;
      onViewportChange(engine.getViewport());
    });
  }

  const engine = {
    name: 'g6',
    version: g6?.version ?? 'inconnue',

    async mount(elements) {
      const dangling = danglingSourcePaths(elements);
      const edges = plottableEdges(elements);
      edgeIdsByVisibility = new Map(Object.values(EDGE_VISIBILITY_GROUPS).map((group) => [group, []]));
      for (const edge of edges) {
        const group = edge.visibilityGroup ?? edgeVisibilityGroup(edge);
        edgeIdsByVisibility.get(group)?.push(edge.id);
      }
      edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
      graph = new g6.Graph({
        container,
        // Même densité de pixels que Cytoscape ; le banc relève aussi les
        // dimensions effectives de chaque canvas, pas seulement le DPR écran.
        devicePixelRatio: 1,
        autoResize: false,
        // Aucune disposition calculée : les positions viennent du DTO. Un
        // layout automatique écraserait une disposition d'auteur.
        layout: undefined,
        data: {
          nodes: elements.nodes.map((node) => ({
            id: node.id,
            // `data` porte ce qui sert aux styles ; `style.x/y` la position.
            data: { ...node, hasDangling: dangling.has(node.id) },
            style: { x: node.x, y: node.y },
          })),
          edges: edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            data: edge,
          })),
        },
        node: {
          // Écran : rectangle. Action : losange. La **forme** distingue les
          // deux natures, pas la seule couleur.
          type: (datum) => (datum.data.kind === NODE_KINDS.ACTION ? 'diamond' : 'rect'),
          style: {
            size: (datum) => (datum.data.kind === NODE_KINDS.ACTION ? [72, 48] : [96, 32]),
            fill: (datum) => (datum.data.kind === NODE_KINDS.ACTION ? ACTION_COLOR : STAGE_COLOR),
            labelText: (datum) => (detail === 'full' ? datum.data.label : ''),
            labelFill: '#ffffff',
            labelFontSize: 10,
            labelPlacement: 'center',
            // L'entrée est le seul rôle porté par la carte. Les blocages de
            // génération vivent dans la pastille commune de la barre.
            stroke: (datum) => (datum.data.isEntry ? ENTRY_COLOR : '#1b1b1b'),
            lineWidth: (datum) => (datum.data.isEntry ? 4 : 1),
            // `undefined`, jamais `false` : le moteur de rendu de G6 analyse
            // `lineDash` comme un tableau de dimensions, et un booléen y lève
            // dans `parseDimensionArrayFormat`. C'est un défaut d'adaptateur,
            // relevé par le criblage et corrigé ici — pas un défaut de G6.
            lineDash: undefined,
          },
          state: {
            selected: { stroke: '#ffb300', lineWidth: 5 },
          },
        },
        edge: {
          style: {
            stroke: (datum) => {
              if (datum.data.kind === EDGE_KINDS.STAGE_OK) return '#2f6f9f';
              if (datum.data.kind === EDGE_KINDS.STAGE_HOME) return '#6a3fa0';
              return '#9aa0a6';
            },
            lineWidth: (datum) => (datum.data.kind === EDGE_KINDS.ACTION_OPTION ? 1 : 2),
            // HOME est **tireté** et une option aléatoire **pointillée** :
            // OK et HOME ne se distinguent pas par la seule couleur.
            lineDash: (datum) => {
              if (datum.data.kind === EDGE_KINDS.STAGE_HOME) return [6, 4];
              if (datum.data.random) return [2, 3];
              // Voir la note sur `lineDash` ci-dessus : `undefined`, pas `false`.
              return undefined;
            },
            endArrow: true,
            endArrowSize: 6,
          },
        },
        behaviors: ['zoom-canvas', 'drag-canvas', 'click-select', 'drag-element'],
      });

      const noteSelection = () => {
        if (selectionTimer !== null) return;
        // Le comportement click-select applique ses états après l'événement.
        selectionTimer = requestAnimationFrame(() => {
          selectionTimer = null;
          if (!graph) return;
          const paths = graph.getNodeData()
            .filter(node => graph.getElementState(node.id).includes('selected'))
            .map(node => node.id);
          selected = new Set(paths);
          onSelect(paths);
        });
      };
      graph.on('node:click', noteSelection);
      graph.on('canvas:click', noteSelection);
      for (const event of ['canvas:drag', 'canvas:wheel', 'aftertransform']) {
        graph.on(event, noteViewport);
      }
      graph.on('node:pointerenter', (event) => {
        hovered = event?.target?.id ?? null;
        publishHover();
      });
      graph.on('node:pointerleave', (event) => {
        if (hovered === (event?.target?.id ?? null)) {
          hovered = null;
          publishHover();
        }
      });
      graph.on('edge:pointerenter', (event) => {
        hoveredEdge = event?.target?.id ?? null;
        publishHover();
      });
      graph.on('edge:pointerleave', (event) => {
        if (hoveredEdge === (event?.target?.id ?? null)) {
          hoveredEdge = null;
          publishHover();
        }
      });
      graph.on('node:dragend', (event) => {
        const id = event?.target?.id;
        if (!id) return;
        // À la fin du geste, **un seul** geste d'auteur part avec la position
        // finale : la prévisualisation intermédiaire n'a rien envoyé.
        const [x, y] = graph.getElementPosition(id);
        onNodeDragEnd(id, { x, y });
      });

      // `render` est asynchrone : ne pas l'attendre ferait rendre `mount`
      // avant qu'un seul nœud soit peint, et le banc mesurerait un montage qui
      // n'a pas eu lieu.
      await graph.render();
      return { nodes: graph.getNodeData().length, edges: graph.getEdgeData().length };
    },

    async setViewport({ x, y, zoom }) {
      if (!graph) return;
      const current = graph;
      await current.zoomTo(zoom, false);
      if (graph !== current) return;
      // Contrat commun : (x,y) est la position en pixels de l'origine du
      // graphe. translateTo/getPosition de G6 utilisent une autre convention.
      const [originX, originY] = current.getViewportByCanvas([0, 0]);
      await current.translateBy([x - originX, y - originY], false);
    },

    getViewport() {
      if (!graph) return { x: 0, y: 0, zoom: 1 };
      const [x, y] = graph.getViewportByCanvas([0, 0]);
      return { x, y, zoom: graph.getZoom() };
    },

    async focusNode(path) {
      if (!graph || !graph.hasNode(path)) return false;
      await graph.focusElement(path, false);
      return true;
    },

    // Le banc ne pose aucune couche HTML sur le canvas : rien à rejouer.
    forwardWheel() {
      return false;
    },

    nodeAtPointer() {
      return graph ? hovered : null;
    },

    edgeAtPointer() {
      return graph ? hoveredEdge : null;
    },

    setNodeImage() {
      // Le banc G6 reste une surface de comparaison ; les miniatures réelles
      // appartiennent au moteur Cytoscape retenu pour la production.
    },

    async setSelection(paths) {
      if (!graph) return;
      const wanted = new Set(paths);
      // Seul le **delta** est touché, comme dans l'adaptateur Cytoscape :
      // construire l'état des 9 121 nœuds à chaque sélection mesurerait
      // l'adaptateur, pas le moteur.
      const states = {};
      for (const path of selected) {
        if (!wanted.has(path)) states[path] = [];
      }
      for (const path of wanted) {
        if (!selected.has(path)) states[path] = 'selected';
      }
      if (Object.keys(states).length > 0) await graph.setElementState(states, false);
      selected = wanted;
    },

    // Le banc G6 ne porte pas la présentation de production. La méthode reste
    // explicite pour conserver une frontière identique entre adaptateurs.
    async setPresentation() {},

    async setEdgeVisibility(visibility = DEFAULT_EDGE_VISIBILITY) {
      if (!graph) return;
      const hidden = [];
      const shown = [];
      for (const group of Object.values(EDGE_VISIBILITY_GROUPS)) {
        const wasVisible = edgeVisibility[group] !== false;
        const isVisible = visibility?.[group] !== false;
        if (wasVisible === isVisible) continue;
        (isVisible ? shown : hidden).push(...(edgeIdsByVisibility.get(group) ?? []));
        edgeVisibility[group] = isVisible;
      }
      if (hidden.length > 0) await graph.hideElement(hidden, false);
      if (shown.length > 0) await graph.showElement(shown, false);
    },

    async setDetailLevel(level) {
      if (!graph || level === detail) return;
      detail = level;
      // Simplification visuelle à faible zoom : les libellés tombent. Le graphe
      // reste **complet** dans le DTO — seul son rendu est allégé.
      await graph.draw();
    },

    // Témoin du banc : sa palette est fixe et ne dépend pas du thème de
    // l'application — les trois constantes du haut de ce fichier sont là pour
    // que les deux finalistes portent la **même** charge visuelle, pas pour
    // suivre clair/sombre. La relecture n'a donc rien à changer ici, et c'est
    // volontaire.
    refreshTheme() {},

    resize() {
      if (!graph) return;
      graph.resize();
    },

    async fitContent(padding = 48) {
      if (!graph) return;
      await graph.fitView({ when: 'always', direction: 'both', padding }, false);
    },

    async exportImage() {
      if (!graph) return null;
      return graph.toDataURL({ mode: 'viewport' });
    },

    destroy() {
      if (selectionTimer !== null) cancelAnimationFrame(selectionTimer);
      selectionTimer = null;
      if (viewportTimer !== null) cancelAnimationFrame(viewportTimer);
      viewportTimer = null;
      graph?.destroy();
      graph = null;
      edgeIdsByVisibility = new Map();
      edgeVisibility = { ...DEFAULT_EDGE_VISIBILITY };
      selected = new Set();
      hovered = null;
      hoveredEdge = null;
      onHoverChange({ nodePath: null, edgeId: null });
    },
  };

  return assertEngineContract(engine);
}
