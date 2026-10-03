// L'étage de canvas : le moteur, sa caméra, ses avis et rien d'autre.
//
// Il reçoit la session de vue au lieu de la créer. C'est ce qui permet au banc
// d'essai et à l'espace de travail de partager exactement le
// même rendu, la même caméra et le même cycle de vie du moteur — sans qu'aucun
// des deux n'ouvre une seconde session sur le même document.
//
// Il n'expose toujours rien au DOM : l'accessibilité et le clavier passent par
// la liste de recherche et par l'inspecteur. C'est le coût assumé du rendu
// canvas, quel que soit le moteur retenu.

import { useCallback, useEffect, useRef, useState } from 'react';

import { ENGINE_IDS } from './engines/index.js';
import { useGraphCanvasEngine } from './useGraphCanvasEngine.js';
import {
  centerOnNode, isNodeOnScreen, surfacePointToGraph, viewportCenter, zoomedViewport, zoomViewportAt,
} from '../../store/advancedGraphView/graphGeometry.js';
import { describeEdgeEnds } from '../../store/advancedGraphView/graphPresentation.js';
import { resolveGraphDropTarget } from '../../store/advancedAuthoring/mediaDrop.js';
import { autoPanVelocity, linkDropCandidate } from '../../store/advancedAuthoring/graphLinkDrag.js';
import { acquireLocalFileUrl } from '../../store/localFileUrlCache.js';
import { MEDIA_BINDING_RESOLVED, mediaBindingsByAssetRef } from '../../store/projectModel/mediaBindings.js';
import { MIME } from '../../utils/mimeTypes.js';
import { DEFAULT_EDGE_VISIBILITY, PORT_OVERHANG } from './engines/engineContract.js';
import { linkHandlePx } from './nodeOverlayMetrics.js';
import { GraphSurfaceControls } from './GraphSurfaceControls.jsx';
import { GraphGroupOverlays, GraphNodeOverlays } from './GraphNodeOverlays.jsx';
import {
  GRAPH_LINK_DROP,
  moveGraphLinkDraft,
  resolveGraphLinkDrop,
  startGraphLinkDraft,
} from '../../store/advancedAuthoring/graphLinkDraft.js';

const NOTICE_TEXT = {
  'viewport-rejected': () => 'Caméra mémorisée inutilisable : vue recadrée.',
  'anchors-ignored': (notice) => `${notice.count} ancrage(s) mémorisé(s) ne désignent plus rien : ignorés, non supprimés.`,
  'cache-unreadable': () => 'Vue précédente illisible : vue reconstruite.',
  'cache-failure': (notice) => `Mémorisation de la vue indisponible${notice.disarmed ? ' (désarmée pour la session)' : ''}.`,
};

// L'étiquette d'un lien survolé : « départ → arrivée · sortie ». Un trait droit
// croise parfois un nœud sur son chemin, et un bout peut être hors de l'écran ;
// l'étiquette lève le doute sans rien changer au dessin.
function EdgeHoverLabel({ index, hovered }) {
  const point = hovered.edgePoint;
  const ends = point ? describeEdgeEnds(index, hovered.edgeId) : null;
  if (!ends) return null;
  return (
    <div className="advanced-canvas__edge-label" style={{ left: point.x, top: point.y }} aria-hidden="true">
      <span className="advanced-canvas__edge-label-end">{ends.from}</span>
      <span className="advanced-canvas__edge-label-arrow">→</span>
      <span className="advanced-canvas__edge-label-end">{ends.to}</span>
      <span className="advanced-canvas__edge-label-via">
        {ends.via}
        {ends.term && <em className="advanced-canvas__edge-label-term">{ends.term}</em>}
      </span>
    </div>
  );
}

function engineDropCandidate(engine, index, sourcePath) {
  const path = engine.nodeAtPointer?.() ?? null;
  const entry = path && path !== sourcePath ? index?.byPath.get(path) : null;
  return entry ? { path, kind: entry.kind, x: 0, y: 0, width: 0, height: 0 } : null;
}

export default function GraphCanvasStage({
  view,
  project = null,
  surfaceTools = null,
  engineId = ENGINE_IDS.CYTOSCAPE,
  createEngine = undefined,
  onAuthoredPositionsChange = null,
  // Dépôt d'un média venu de la médiathèque. Le canvas ne connaît que le
  // nœud visé ; le geste d'auteur est assemblé plus haut.
  onMediaDrop = null,
  // Clic droit sur une carte. Le canvas n'expose rien au DOM : la cible ne peut
  // pas être trouvée par `elementsFromPoint` comme sur l'arbre et le diagramme
  // Libre. Elle est donc demandée au moteur, qui tient déjà le nœud qu'il a
  // criblé sous le pointeur — la même porte que le dépôt de média.
  onNodeContextMenu = null,
  onSurfaceContextMenu = null,
  // Double-clic sur une carte : l'hôte ouvre le champ Nom commun aux deux
  // natures. La cible suit la même résolution moteur que le clic droit.
  onNodeDoubleClick = null,
  onGraphLinkIntent = null,
  onInactiveLinkPort = null,
  // L'écoute depuis l'Écran sélectionné. C'est la commande de
  // `AdvancedWorkspace`, transmise telle quelle : le graphe n'ouvre pas un
  // second simulateur.
  // Révélation volontaire : elle entre dans l'historique Précédent/Suivant.
  // Sans elle, la scène se rabat sur son propre cadrage, qui n'enregistre rien.
  // `{ canBack, canForward, onBack, onForward }`, ou `null` quand l'hôte ne
  // tient pas d'historique — le banc, par exemple.
  presentation = null,
  presentationControls = null,
  edgeVisibility = DEFAULT_EDGE_VISIBILITY,
  onEdgeVisibilityChange = () => {},
  history = null,
  // Le rangement tenu par l'hôte ; voir `GraphSurfaceControls`.
  arrangement = null,
  // La Vue d'ensemble, ouverte ou repliée. Sans bascule — le banc, par
  // exemple —, elle reste ouverte et aucun bouton ne la propose.
  overviewOpen = true,
  onToggleOverview = null,
  cameraTarget = null,
  focusRef = null,
  graphCenterRef = null,
  // Les commandes de caméra et le point sous le pointeur, pour le clavier :
  // `{ zoomBy(factor), fit(), pointerPoint() }`. Le parent n'a pas à posséder
  // le moteur pour agrandir, cadrer ou créer sous le pointeur.
  cameraRef = null,
  // Poignée de recette, **facultative** et jamais posée par l'application.
  //
  // `captureGraphSurface` compose le PNG du moteur et le relevé de
  // surimpressions que la surface publie, mais les deux vivent ici : sans
  // cette porte, la recette ne pouvait capturer que les calques du canvas, et
  // reperdait les noms, les pastilles et les repères — exactement le défaut que
  // l'audit reproche à `exportImage()` seul. Elle ne donne aucun pouvoir
  // nouveau : le moteur et le relevé sont rendus **en lecture**.
  surfaceRef = null,
  restoreToken = 0,
  children = null,
}) {
  const hostRef = useRef(null);
  const dropRef = useRef(null);
  const [clampNotice, setClampNotice] = useState(null);
  // Le tirage d'un raccord ne passe **pas** par l'état de React.
  //
  // Il y passait, à chaque mouvement de pointeur : un `setState` par
  // déplacement de souris, donc un rendu complet de la scène — jusqu'à six
  // cents surimpressions, qu'aucune mémoïsation ne protège — pour déplacer les
  // deux bouts d'un segment. Le brouillon vit désormais dans une référence, le
  // tracé est écrit directement dans le DOM sur une seule frame, et React ne
  // rend plus que deux fois : à la prise et au relâchement.
  const [linkDragging, setLinkDragging] = useState(false);
  const [linkNotice, setLinkNotice] = useState(null);
  const linkDraftRef = useRef(null);
  const linkPointerRef = useRef({ x: 0, y: 0 });
  const linkCandidateRef = useRef(null);
  const linkFrameRef = useRef(null);
  const draftLineRef = useRef(null);
  const draftTargetRef = useRef(null);
  const { index, noteFocus, noteSelection } = view;
  // Sous 3 %, un repère cliqué sélectionne son nœud sans déplacer la caméra :
  // l'auteur le regarde déjà.
  const selectLandmark = useCallback((path) => {
    noteSelection?.([path], index);
  }, [noteSelection, index]);
  const { engineRef, engineError, engineVersion, nodeOverlays, livePositions, hoveredElement } = useGraphCanvasEngine({
    hostRef, view, engineId, onAuthoredPositionsChange, onClamp: setClampNotice, restoreToken,
    presentation, createEngine,
  });
  useEffect(() => {
    let previousScale = 1;
    function onNativePinch(event) {
      const { phase, scale, clientX, clientY } = event.detail ?? {};
      if (phase === 'begin' || phase === 'end') {
        previousScale = 1;
        return;
      }
      if (phase !== 'change' || !Number.isFinite(scale) || scale <= 0) return;
      const factor = Math.max(0.5, Math.min(2, scale / previousScale));
      previousScale = scale;
      const host = hostRef.current;
      const engine = engineRef.current;
      if (!host || !engine) return;
      const rect = host.getBoundingClientRect();
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)
        || clientX < rect.left || clientX > rect.right
        || clientY < rect.top || clientY > rect.bottom) return;
      const topmost = document.elementFromPoint?.(clientX, clientY);
      if (topmost && !dropRef.current?.contains(topmost)) return;
      const next = zoomViewportAt(engine.getViewport(), factor, {
        x: clientX - rect.left,
        y: clientY - rect.top,
      });
      if (next) void engine.setViewport(next);
    }
    window.addEventListener('story-studio:native-pinch', onNativePinch);
    return () => window.removeEventListener('story-studio:native-pinch', onNativePinch);
  }, [engineRef]);
  // Ce filtre ne touche qu'au rendu. Il est réappliqué après le remontage du
  // moteur, tandis que l'état reste porté par l'espace de travail.
  useEffect(() => {
    void engineRef.current?.setEdgeVisibility?.(edgeVisibility);
  }, [edgeVisibility, engineRef, engineVersion]);
  const linkRuntimeRef = useRef(null);
  linkRuntimeRef.current = { index, nodeOverlays, onGraphLinkIntent };

  const localPoint = useCallback((event) => {
    const rect = dropRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
  }, []);

  const endLinkDrag = useCallback(() => {
    linkDraftRef.current = null;
    linkCandidateRef.current = null;
    setLinkDragging(false);
  }, []);

  const startLink = useCallback((event, node, port, anchor) => {
    if (!onGraphLinkIntent || !dropRef.current) return;
    const viewport = engineRef.current?.getViewport();
    const point = localPoint(event);
    if (!viewport || !point) return;
    // L'ancre est la prise elle-même, convertie **une fois** en coordonnées de
    // graphe. Tout le reste du geste s'y réfère : la caméra peut tourner, le
    // trait reste accroché à la prise dont il part.
    const started = startGraphLinkDraft(index, node.path, port.id, {
      x: ((node.x + (anchor?.dx ?? 0)) - viewport.x) / viewport.zoom,
      y: ((node.y + (anchor?.dy ?? 0)) - viewport.y) / viewport.zoom,
    });
    if (!started || started.kind !== 'draft') return;
    setLinkNotice(null);
    linkPointerRef.current = point;
    linkCandidateRef.current = null;
    linkDraftRef.current = { ...started, pointerId: event.pointerId };
    setLinkDragging(true);
  }, [engineRef, index, localPoint, onGraphLinkIntent]);

  // La boucle du geste : une passe par image, quoi qu'il arrive.
  //
  // Elle reprojette l'ancre, suit le pointeur, crible la cible et entraîne la
  // caméra aux bords. Le tracé et le cadre de la cible sont écrits directement
  // dans le DOM : ils vivent dans une couche qui n'appartient qu'au geste, donc
  // un rendu de React ne peut ni les effacer ni les retarder.
  useEffect(() => {
    if (!linkDragging) return undefined;
    const host = dropRef.current;
    const view = host?.ownerDocument?.defaultView;
    if (!host || !view?.requestAnimationFrame) return undefined;
    const tick = () => {
      linkFrameRef.current = view.requestAnimationFrame(tick);
      const draft = linkDraftRef.current;
      const engine = engineRef.current;
      if (!draft || !engine) return;
      const viewport = engine.getViewport();
      const pointer = linkPointerRef.current;
      draft.pointer = {
        x: (pointer.x - viewport.x) / viewport.zoom,
        y: (pointer.y - viewport.y) / viewport.zoom,
      };
      const line = draftLineRef.current;
      if (line) {
        line.setAttribute('x1', `${(draft.anchor.x * viewport.zoom) + viewport.x}`);
        line.setAttribute('y1', `${(draft.anchor.y * viewport.zoom) + viewport.y}`);
        line.setAttribute('x2', `${pointer.x}`);
        line.setAttribute('y2', `${pointer.y}`);
      }
      // Le débord des prises est en unités de graphe ; la boîte publiée par le
      // moteur est en pixels écran. Il passe donc par le zoom courant, comme
      // les pastilles elles-mêmes.
      // Le relevé de surimpressions est borné à 600 nœuds, et regroupé au
      // régime éloigné : dézoomé sur un gros graphe, la carte visée peut n'y
      // pas figurer, et le dépôt concluait au vide. Le nœud que le moteur a
      // criblé sous le pointeur prend alors le relais — sans cadre, faute de
      // boîte publiée.
      const candidate = linkDropCandidate(
        linkRuntimeRef.current.nodeOverlays.nodes ?? [], pointer, draft.sourcePath,
        PORT_OVERHANG * viewport.zoom, linkHandlePx(viewport.zoom) / 2,
      ) ?? engineDropCandidate(engine, linkRuntimeRef.current.index, draft.sourcePath);
      linkCandidateRef.current = candidate;
      const target = draftTargetRef.current;
      if (target) {
        target.setAttribute('width', `${candidate ? candidate.width : 0}`);
        target.setAttribute('height', `${candidate ? candidate.height : 0}`);
        if (candidate) {
          target.setAttribute('x', `${candidate.x - (candidate.width / 2)}`);
          target.setAttribute('y', `${candidate.y - (candidate.height / 2)}`);
          // Un Écran se raccorde à une Action, et réciproquement. Le refus se
          // voit donc **avant** le relâchement, pas après.
          target.dataset.reach = candidate.kind === draft.sourceKind ? 'invalid' : 'valid';
        }
      }
      const velocity = autoPanVelocity(pointer, { width: host.clientWidth, height: host.clientHeight });
      if (velocity.x !== 0 || velocity.y !== 0) {
        void engine.setViewport({
          x: viewport.x + velocity.x,
          y: viewport.y + velocity.y,
          zoom: viewport.zoom,
        });
      }
    };
    linkFrameRef.current = view.requestAnimationFrame(tick);
    return () => {
      if (linkFrameRef.current !== null) view.cancelAnimationFrame(linkFrameRef.current);
      linkFrameRef.current = null;
    };
  }, [engineRef, linkDragging]);

  useEffect(() => {
    if (!linkDragging) return undefined;
    // Le déplacement ne fait que **relever** la position : tout le travail est
    // fait par la boucle d'image, donc une souris qui émet deux cents
    // événements par seconde ne coûte pas plus qu'une qui en émet soixante.
    const onPointerMove = (event) => {
      const current = linkDraftRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const point = localPoint(event);
      if (point) linkPointerRef.current = point;
    };
    const stop = (event, cancelled = false) => {
      const current = linkDraftRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const candidate = linkCandidateRef.current;
      const point = localPoint(event);
      const viewport = engineRef.current?.getViewport();
      endLinkDrag();
      if (cancelled || !point || !viewport) return;
      // Le point de dépôt est relu sur l'événement de relâchement plutôt que
      // sur la dernière image : entre les deux, le pointeur a pu parcourir
      // seize millisecondes de chemin.
      const dropped = moveGraphLinkDraft(current, {
        x: (point.x - viewport.x) / viewport.zoom,
        y: (point.y - viewport.y) / viewport.zoom,
      });
      const runtime = linkRuntimeRef.current;
      const intent = resolveGraphLinkDrop(
        runtime.index, dropped, candidate?.path ?? null, dropped.pointer,
      );
      if (intent?.kind === GRAPH_LINK_DROP.INVALID) {
        setLinkNotice(intent.reason);
        return;
      }
      if (intent) runtime.onGraphLinkIntent?.(intent);
    };
    const onPointerUp = event => stop(event, false);
    const onPointerCancel = event => stop(event, true);
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      endLinkDrag();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [endLinkDrag, engineRef, linkDragging, localPoint]);

  useEffect(() => {
    endLinkDrag();
  }, [endLinkDrag, engineVersion, index]);

  // Le suivi de lecture déplace seulement la caméra. Il ne passe pas par
  // `noteFocus` et reste donc distinct de la sélection d'édition.
  useEffect(() => {
    if (!cameraTarget) return;
    void engineRef.current?.focusNode(cameraTarget);
  }, [cameraTarget, engineRef, engineVersion]);

  // Les vignettes du graphe suivent la même voie locale, bornée et mutualisée
  // que les autres aperçus de l'application. `assetRef` reste l'identité du
  // document ; seul `mediaBindings` donne le chemin disque à lire.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !index || !project) return undefined;
    const bindings = mediaBindingsByAssetRef(project);
    const pathsByAssetRef = new Map();
    for (const entry of index.entries) {
      const assetRef = entry.kind === 'stage' && entry.node.image?.presence === 'value'
        ? entry.node.image.assetRef
        : null;
      if (!assetRef) continue;
      const paths = pathsByAssetRef.get(assetRef) ?? [];
      paths.push(entry.path);
      pathsByAssetRef.set(assetRef, paths);
    }
    let cancelled = false;
    const releases = [];
    for (const [assetRef, nodePaths] of pathsByAssetRef) {
      const binding = bindings.get(assetRef);
      if (!binding?.path || binding.status !== MEDIA_BINDING_RESOLVED) continue;
      const extension = binding.path.split('.').pop()?.toLowerCase() ?? '';
      const acquisition = acquireLocalFileUrl({
        path: binding.path,
        mime: MIME[extension] || 'application/octet-stream',
        version: binding.status,
      });
      releases.push(acquisition.release);
      void acquisition.promise.then((url) => {
        if (cancelled || engineRef.current !== engine) return;
        for (const path of nodePaths) engine.setNodeImage(path, url);
      }).catch(() => {
        // L'état manquant reste déjà visible dans l'inspecteur et les
        // diagnostics ; une vignette illisible ne doit pas faire tomber le graphe.
      });
    }
    return () => {
      cancelled = true;
      for (const release of releases) release();
    };
  }, [engineRef, engineVersion, index, project]);

  const focusPath = useCallback(async (path, { center = true, updateFocus = true } = {}) => {
    if (updateFocus) noteFocus(path);
    if (!center) return;
    // `center: 'if-needed'` ne déplace la caméra que si le nœud n'est pas déjà
    // sous les yeux de l'auteur. C'est ce que demande un déplacement de
    // lecture — un pas en arrière dans les nœuds visités : recadrer sur une
    // carte déjà visible lui ferait perdre ses repères pour rien, alors qu'un
    // nœud sorti de l'écran, lui, doit être ramené.
    if (center === 'if-needed') {
      const visible = index?.byPath.get(path);
      const host = hostRef.current;
      if (visible && host && isNodeOnScreen(view.viewport, visible.node, {
        width: host.clientWidth,
        height: host.clientHeight,
      })) return;
    }
    // La sélection reste exploitable si le nœud n'est pas dessiné : le cadrage
    // passe par le moteur quand il connaît le nœud, et par la géométrie
    // mesurée sinon. `focusNode` rend une **promesse** de booléen : l'attendre
    // est ce qui distingue « le moteur a cadré » de « le moteur a promis de
    // cadrer ».
    const engine = engineRef.current;
    if (await engine?.focusNode(path)) return;
    if (engine !== engineRef.current) return;
    const entry = index?.byPath.get(path);
    if (!entry || !hostRef.current) return;
    await engine?.setViewport(centerOnNode(view.viewport, entry.node, {
      width: hostRef.current.clientWidth,
      height: hostRef.current.clientHeight,
    }));
  }, [index, noteFocus, view.viewport]);

  // Le parent pilote le cadrage sans posséder le moteur : un diagnostic ou un
  // rapport de geste révèle son nœud par cette porte, et par elle seule.
  useEffect(() => {
    if (!focusRef) return undefined;
    focusRef.current = focusPath;
    return () => { if (focusRef.current === focusPath) focusRef.current = null; };
  }, [focusPath, focusRef]);

  // Le centre de la surface visible, en coordonnées de graphe.
  //
  // Créer un nœud depuis l'en-tête ne désigne aucun point, là où un clic droit
  // en désigne un. Sans position, le nœud naît où la disposition le met — sur
  // un pack de neuf mille nœuds, souvent hors de l'écran, et le retrouver
  // demande de fouiller. Le centre de ce que l'auteur regarde est le seul
  // endroit qu'il puisse prévoir sans qu'on le lui dise.
  //
  // Même porte que le cadrage, et pour la même raison : le parent n'a pas à
  // posséder le moteur pour savoir où l'auteur regarde.
  const graphCenter = useCallback(() => {
    const viewport = engineRef.current?.getViewport();
    const host = dropRef.current;
    if (!viewport || !host) return null;
    return viewportCenter(viewport, { width: host.clientWidth, height: host.clientHeight });
  }, [engineRef]);

  useEffect(() => {
    if (!graphCenterRef) return undefined;
    graphCenterRef.current = graphCenter;
    return () => { if (graphCenterRef.current === graphCenter) graphCenterRef.current = null; };
  }, [graphCenter, graphCenterRef]);

  // Le dernier point du pointeur **sur** la surface, en pixels relatifs à son
  // coin ; `null` dès qu'il en sort. Une création au clavier se pose là,
  // comme au clic droit, et au centre de la vue quand le pointeur est ailleurs.
  const pointerRef = useRef(null);
  useEffect(() => {
    const element = dropRef.current;
    if (!element) return undefined;
    const onMove = (event) => { pointerRef.current = localPoint(event); };
    const onLeave = () => { pointerRef.current = null; };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
    };
  }, [localPoint]);

  useEffect(() => {
    if (!cameraRef) return undefined;
    const size = () => ({
      width: dropRef.current?.clientWidth ?? 0,
      height: dropRef.current?.clientHeight ?? 0,
    });
    const commands = {
      zoomBy(factor) {
        const engine = engineRef.current;
        const next = engine ? zoomedViewport(engine.getViewport(), size(), factor) : null;
        if (next) void engine.setViewport(next);
      },
      fit() {
        void engineRef.current?.fitContent();
      },
      pointerPoint() {
        const viewport = engineRef.current?.getViewport();
        return surfacePointToGraph(viewport, pointerRef.current);
      },
    };
    cameraRef.current = commands;
    return () => { if (cameraRef.current === commands) cameraRef.current = null; };
  }, [cameraRef, engineRef]);

  // Le dernier relevé publié, tenu dans une ref pour que la poignée de recette
  // le lise **à l'instant de la capture** et non à l'instant où elle a été
  // posée. Même raison que `projectRef` dans `useAdvancedAuthoring` : un rappel
  // d'image peut tomber avant le rendu suivant.
  const overlayRef = useRef(nodeOverlays);
  overlayRef.current = nodeOverlays;
  useEffect(() => {
    if (!surfaceRef) return undefined;
    surfaceRef.current = {
      engine: () => engineRef.current,
      overlay: () => overlayRef.current,
      size: () => ({
        width: hostRef.current?.clientWidth ?? 0,
        height: hostRef.current?.clientHeight ?? 0,
      }),
    };
    return () => { surfaceRef.current = null; };
  }, [engineRef, surfaceRef]);

  // Dépôt d'un média. Le canvas n'expose rien au DOM : la médiathèque ne
  // peut donc pas viser un nœud par `elementsFromPoint`, comme elle le fait sur
  // l'arbre et le diagramme Libre. Elle vise cet étage, qui demande au moteur le
  // nœud qu'il a lui-même criblé sous le pointeur.
  //
  // Deux événements, tous deux **synchrones** : le survol répond dans le même
  // tour de boucle, pour que le fantôme de glisser dise le nom de l'Écran visé
  // avant le relâchement, et non après.
  const resolveDropTarget = useCallback((mediaKind) => resolveGraphDropTarget({
    index,
    path: engineRef.current?.nodeAtPointer() ?? null,
    kind: mediaKind,
  }), [engineRef, index]);

  useEffect(() => {
    const element = dropRef.current;
    if (!element || (!onNodeContextMenu && !onSurfaceContextMenu)) return undefined;
    const onContextMenu = (event) => {
      const path = engineRef.current?.nodeAtPointer() ?? null;
      // Un clic droit dans le vide n'ouvre pas de menu **de nœud** : il n'a pas
      // de cible, et en inventer une — la sélection courante, par exemple —
      // appliquerait l'action à autre chose que ce qui est sous le pointeur.
      //
      // Il ouvre en revanche un menu **de surface**, dont les entrées n'agissent
      // sur aucun nœud existant : créer ici, coller ici. Le raisonnement
      // ci-dessus ne s'y applique pas, puisqu'il n'y a rien à confondre.
      if (path) {
        if (!onNodeContextMenu) return;
        event.preventDefault();
        onNodeContextMenu({ path, x: event.clientX, y: event.clientY });
        return;
      }
      if (!onSurfaceContextMenu) return;
      const viewport = engineRef.current?.getViewport();
      const point = localPoint(event);
      if (!viewport || !point) return;
      event.preventDefault();
      // Le point part en **coordonnées de graphe**. En pixels écran il serait
      // périmé dès le premier mouvement de caméra — la leçon de l'ancre du
      // tirage de lien.
      onSurfaceContextMenu({
        graphPoint: surfacePointToGraph(viewport, point),
        x: event.clientX,
        y: event.clientY,
      });
    };
    element.addEventListener('contextmenu', onContextMenu);
    return () => element.removeEventListener('contextmenu', onContextMenu);
  }, [engineRef, localPoint, onNodeContextMenu, onSurfaceContextMenu]);

  // La molette zoome partout sur le graphe. La couche HTML posée sur le canvas
  // (repères et noms de la vue éloignée, prises de lien) capte le pointeur et
  // reçoit donc la molette à la place du moteur : un seul écouteur, ici, la lui
  // renvoie. Les autres éléments de l'étage (commandes, notices) ne sont pas
  // dans cette couche et gardent leur défilement.
  useEffect(() => {
    const element = dropRef.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      if (!event.target?.closest?.('.advanced-node-overlays')) return;
      engineRef.current?.forwardWheel(event);
    };
    // Non passif : le moteur doit pouvoir retenir le défilement de la page.
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [engineRef]);

  useEffect(() => {
    const element = dropRef.current;
    if (!element || !onNodeDoubleClick) return undefined;
    const onDoubleClick = (event) => {
      const path = engineRef.current?.nodeAtPointer() ?? null;
      if (!path) return;
      event.preventDefault();
      onNodeDoubleClick(path);
    };
    element.addEventListener('dblclick', onDoubleClick);
    return () => element.removeEventListener('dblclick', onDoubleClick);
  }, [engineRef, onNodeDoubleClick]);

  useEffect(() => {
    const element = dropRef.current;
    if (!element || !onMediaDrop) return undefined;
    const onDragOver = (event) => {
      event.detail.target = resolveDropTarget(event.detail?.kind);
    };
    const onDrop = (event) => {
      const target = resolveDropTarget(event.detail?.kind);
      if (!target) return;
      void onMediaDrop({
        stageUuid: target.uuid,
        nodePath: target.path,
        kind: event.detail.kind,
        path: event.detail.path,
        paths: event.detail.paths,
      });
    };
    element.addEventListener('media-drag-over', onDragOver);
    element.addEventListener('media-drop', onDrop);
    return () => {
      element.removeEventListener('media-drag-over', onDragOver);
      element.removeEventListener('media-drop', onDrop);
    };
  }, [onMediaDrop, resolveDropTarget]);

  return (
    <div
      ref={dropRef}
      className="advanced-canvas__stage"
      data-media-graph-drop={onMediaDrop ? '1' : undefined}
      data-hovered-edge={hoveredElement.edgeId ?? undefined}
    >
      <GraphGroupOverlays overlay={nodeOverlays} />
      <div
        ref={hostRef}
        className="advanced-canvas__host"
        data-grid-engine={engineId === ENGINE_IDS.CYTOSCAPE ? 'cytoscape' : undefined}
      />
      {linkDragging && (
        <svg className="advanced-link-draft" aria-hidden="true">
          <rect ref={draftTargetRef} width="0" height="0" rx="10" />
          <line ref={draftLineRef} x1="0" y1="0" x2="0" y2="0" />
        </svg>
      )}
      <EdgeHoverLabel index={index} hovered={hoveredElement} />
      <GraphNodeOverlays
        overlay={nodeOverlays}
        onLinkPortPointerDown={onGraphLinkIntent ? startLink : null}
        onInactiveLinkPort={onInactiveLinkPort}
        onSelectLandmark={selectLandmark}
      />
      <GraphSurfaceControls
        surfaceTools={surfaceTools}
        engineRef={engineRef}
        index={index}
        viewport={view.viewport}
        hostRef={hostRef}
        livePositions={livePositions}
        presentation={presentation}
        presentationControls={presentationControls}
        edgeVisibility={edgeVisibility}
        onEdgeVisibilityChange={onEdgeVisibilityChange}
        history={history}
        arrangement={arrangement}
        overviewOpen={overviewOpen}
        onToggleOverview={onToggleOverview}
      />
      {view.status === 'loading' && <p className="advanced-canvas__status">Lecture du graphe…</p>}
      {engineError && (
        <p className="advanced-canvas__status" role="alert">
          Moteur d'affichage indisponible : {String(engineError.message ?? engineError)}
        </p>
      )}
      {clampNotice && (
        // La butée est **visible** : l'auteur doit voir que le nœud a cessé
        // de suivre le pointeur, et pourquoi.
        <p className="advanced-canvas__status advanced-canvas__status--warning" role="status">
          Position bornée au domaine sûr [-32768, 32767]
          {clampNotice.axes.x && ' en X'}
          {clampNotice.axes.y && ' en Y'}.
        </p>
      )}
      {linkNotice && (
        <p className="advanced-canvas__status advanced-canvas__status--warning" role="status">
          {linkNotice}
        </p>
      )}
      {view.notices.map((notice, position) => (
        <p key={`${notice.kind}-${position}`} className="advanced-canvas__status" role="status">
          {NOTICE_TEXT[notice.kind]?.(notice) ?? notice.kind}
        </p>
      ))}
      {children}
    </div>
  );
}
