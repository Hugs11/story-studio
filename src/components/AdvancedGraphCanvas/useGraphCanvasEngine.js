// Cycle de vie du renderer : le document déclenche un montage, la caméra et
// la sélection des commandes. Les promesses d'un ancien montage restent locales.
import { useEffect, useRef, useState } from 'react';
import { engineDescriptor } from './engines/index.js';
import { toEngineElements } from './engines/engineContract.js';
import { useThemeEpoch } from './useThemeEpoch.js';
import { clampAuthoredPosition } from '../../store/advancedGraphView/graphGeometry.js';
import { focusAfterGraphSelection } from '../../store/advancedGraphView/graphSelection.js';

export const GRAPH_RENDER_TIERS = Object.freeze({
  FULL: 'full', NO_LABELS: 'noLabels', NO_THUMBS: 'noThumbs', SIMPLIFIED: 'simplified',
});

const GRAPH_RENDER_THRESHOLDS = Object.freeze({
  NO_LABELS: 0.30,
  NO_THUMBS: 0.05,
  SIMPLIFIED: 0.03,
});

export function graphRenderTier(zoom) {
  if (zoom < GRAPH_RENDER_THRESHOLDS.SIMPLIFIED) return GRAPH_RENDER_TIERS.SIMPLIFIED;
  if (zoom < GRAPH_RENDER_THRESHOLDS.NO_THUMBS) return GRAPH_RENDER_TIERS.NO_THUMBS;
  if (zoom < GRAPH_RENDER_THRESHOLDS.NO_LABELS) return GRAPH_RENDER_TIERS.NO_LABELS;
  return GRAPH_RENDER_TIERS.FULL;
}
const createGraphEngine = (id, options) => engineDescriptor(id).create(options);

export function useGraphCanvasEngine({
  hostRef, view, engineId, onAuthoredPositionsChange, onClamp,
  presentation = null,
  // Un refus laisse le document inchangé : le DTO ne bouge pas, et le nœud que
  // l'auteur venait de glisser resterait donc peint là où le moteur l'a laissé.
  // Changer ce jeton détruit et remonte le rendu sur les positions du DTO —
  // c'est la restauration visuelle attendue, par le seul chemin que la
  // frontière du moteur expose déjà.
  restoreToken = 0,
  createEngine = createGraphEngine,
}) {
  const engineRef = useRef(null);
  const lifecycleRef = useRef(null);
  const callbacks = useRef(null);
  callbacks.current = { onAuthoredPositionsChange, onClamp };
  const [engineError, setEngineError] = useState(null);
  const [engineVersion, setEngineVersion] = useState(0);
  const [nodeOverlays, setNodeOverlays] = useState({ zoom: 1, detailLevel: 'full', nodes: [], groups: [] });
  const [hoveredElement, setHoveredElement] = useState({ nodePath: null, edgeId: null });
  // Les positions déplacées **depuis** le montage, tant que le document ne les
  // a pas reprises. La vue d'ensemble s'en sert pour montrer le graphe tel
  // qu'il est peint, et non tel que le DTO l'était avant le glisser.
  const [livePositions, setLivePositions] = useState(() => new Map());
  const themeEpoch = useThemeEpoch();
  const { index, session, noteSelection, noteViewport, initialViewport } = view;

  useEffect(() => {
    setEngineError(null);
    setHoveredElement({ nodePath: null, edgeId: null });
    if (!index || !hostRef.current) return undefined;
    let disposed = false;
    let engine = null;
    let mounting = false;
    let ready = false;
    let synchronizingSelection = false;
    let selectionChain = Promise.resolve();
    let detailChain = Promise.resolve();
    let detail = null;
    const current = () => !disposed && session.state.index === index;
    // Les fins de glisser d'un même geste. Une sélection entraînée d'un bloc
    // rend une fin **par nœud**, toutes dans le même tour de boucle ; les
    // livrer une à une ferait partir N gestes, dont la file d'édition ne
    // garderait que le premier et le dernier. Elles sont donc rassemblées et
    // livrées ensemble, au tour suivant : un glisser, un geste.
    let droppedPositions = null;
    const deliverDroppedPositions = () => {
      const entries = droppedPositions;
      droppedPositions = null;
      if (!entries || !current() || !ready) return;
      const clamped = entries.find((entry) => entry.clamped);
      callbacks.current.onClamp(clamped ? { path: clamped.path, axes: clamped.axes } : null);
      setLivePositions((previous) => {
        const next = new Map(previous);
        for (const { path, x, y } of entries) next.set(path, { x, y });
        return next;
      });
      callbacks.current.onAuthoredPositionsChange?.(
        entries.map(({ path, x, y }) => ({ path, x, y })),
      );
    };
    const fail = error => { if (current()) setEngineError(error); };
    const destroy = () => {
      if (!engine) return;
      if (engineRef.current === engine) engineRef.current = null;
      engine.destroy();
      engine = null;
    };
    function syncDetail(zoom) {
      const next = graphRenderTier(zoom);
      if (next === detail) return;
      detail = next;
      detailChain = detailChain.then(async () => {
        if (current() && ready) await engine.setDetailLevel(next);
      }).catch(fail);
    }
    function syncSelection() {
      selectionChain = selectionChain.then(async () => {
        if (!current() || !ready) return;
        synchronizingSelection = true;
        try {
          const selected = session.state.selection;
          await engine.setSelection([...selected.stages, ...selected.actions]);
        } finally { synchronizingSelection = false; }
      }).catch(fail);
    }
    const lifecycle = { syncSelection };
    lifecycleRef.current = lifecycle;

    async function mount() {
      // Un remontage repart des positions du DTO : l'acceptation comme le refus
      // du geste passent par lui, et le relevé local n'a plus rien à corriger.
      setLivePositions(new Map());
      try {
        engine = await createEngine(engineId, {
          container: hostRef.current,
          onSelect: paths => {
            // Une restauration visuelle n'est pas une sélection d'auteur : elle
            // ne doit pas purger les ancrages temporairement absents.
            if (current() && ready && !synchronizingSelection) {
              noteSelection(paths, index, {
                focus: focusAfterGraphSelection(paths, session.state.focus),
              });
            }
          },
          onViewportChange: viewport => {
            if (!current() || !ready) return;
            noteViewport(viewport);
            syncDetail(viewport.zoom);
          },
          onNodeDragEnd: (path, position) => {
            if (!current() || !ready) return;
            const clamped = clampAuthoredPosition(position);
            if (!droppedPositions) {
              droppedPositions = [];
              queueMicrotask(deliverDroppedPositions);
            }
            droppedPositions = droppedPositions.filter((entry) => entry.path !== path);
            droppedPositions.push({
              path, x: clamped.x, y: clamped.y, clamped: clamped.clamped, axes: clamped.axes,
            });
          },
          onOverlayChange: setNodeOverlays,
          onHoverChange: setHoveredElement,
        });
        if (!current()) { destroy(); return; }
        mounting = true;
        const elements = toEngineElements(index);
        await engine.mount(elements);
        if (!current()) return;
        const start = initialViewport({
          width: hostRef.current?.clientWidth ?? 0,
          height: hostRef.current?.clientHeight ?? 0,
        });
        // Le moteur monte toujours sur les positions du DTO. Il n'y a donc
        // plus de cadrage automatique à imposer après coup : la caméra
        // mémorisée survit à une édition, au lieu d'être rejouée à chaque
        // reconstruction de l'index.
        if (start) await engine.setViewport(start);
        if (!current()) return;
        ready = true;
        engineRef.current = engine;
        setEngineVersion((version) => version + 1);
        syncDetail(start?.zoom ?? 1);
        syncSelection();
      } catch (error) {
        fail(error);
        destroy();
      } finally {
        mounting = false;
        if (!current()) destroy();
      }
    }
    void mount();
    const observer = new ResizeObserver(() => {
      if (current() && ready) engine.resize();
    });
    observer.observe(hostRef.current);
    return () => {
      disposed = true;
      ready = false;
      observer.disconnect();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      if (engineRef.current === engine) engineRef.current = null;
      // Un montage asynchrone encore en cours sera détruit à sa résolution.
      if (!mounting) destroy();
    };
  }, [index, session, engineId, createEngine, hostRef, noteSelection, noteViewport, initialViewport,
    restoreToken]);

  useEffect(() => { lifecycleRef.current?.syncSelection(); }, [view.selection]);

  useEffect(() => {
    void engineRef.current?.setPresentation(presentation);
  }, [presentation, engineVersion]);

  // La feuille de style du moteur est construite au montage : la bascule
  // clair/sombre doit la lui faire relire, sinon le canvas garde la palette de
  // l'autre thème jusqu'au prochain changement de document.
  useEffect(() => {
    if (themeEpoch === 0) return;
    engineRef.current?.refreshTheme();
  }, [themeEpoch, engineVersion]);

  return { engineRef, engineError, engineVersion, nodeOverlays, livePositions, hoveredElement };
}
