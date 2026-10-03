// Les contrôles ancrés à la surface : actions du L, zoom, cadrage, légende et vue d'ensemble.
//
// Ils ne bougent pas avec la caméra — ce sont les seules surimpressions du
// handoff qui restent collées aux coins de la scène. La géométrie de la
// miniature, elle, vit dans `graphOverview` : c'est une projection, et une
// projection se vérifie hors du rendu.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildOverview, MAP_HEIGHT, MAP_WIDTH, overviewCamera } from '../../store/advancedGraphView/graphOverview.js';
import { BroomSparkles, Check, Columns2, MapIcon, Rows2, X } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { FOLD_PARTS, NO_FOLD } from '../../store/advancedGraphView/graphParcoursLayout.js';
import { withShortcut } from '../../store/keyboardShortcuts.js';
import { useShortcutLabels } from '../../store/ShortcutLabelsContext.js';
import { DEFAULT_EDGE_VISIBILITY, EDGE_VISIBILITY_GROUPS } from './engines/engineContract.js';
import { GRAPH_ZOOM_STEP, zoomedViewport } from '../../store/advancedGraphView/graphGeometry.js';
import { WORKSPACE_MODE_ADVANCED } from '../../store/projectWorkState.js';
import { StructureActionsBar, StructureSearchButton } from '../structure/StructureActionsBar.jsx';

const EDGE_FILTERS = Object.freeze([
  {
    group: EDGE_VISIBILITY_GROUPS.STRUCTURE,
    label: 'Structure',
    className: 'is-structure',
    ariaLabel: 'Afficher les liens de structure',
  },
  {
    group: EDGE_VISIBILITY_GROUPS.RETURNS,
    label: 'Retour',
    className: 'is-return',
    ariaLabel: 'Afficher les retours',
  },
  {
    group: EDGE_VISIBILITY_GROUPS.DEVICE_RETURNS,
    label: 'Retour Lunii',
    className: 'is-device-return',
    ariaLabel: 'Afficher les retours par défaut de la Lunii',
    title: 'Bouton Accueil sans destination : la Lunii revient d’elle-même à l’Écran d’entrée. Ce retour n’est pas écrit dans le pack.',
  },
  {
    group: EDGE_VISIBILITY_GROUPS.RANDOM,
    label: 'Aléatoire',
    className: 'is-random',
    ariaLabel: 'Afficher les liens à sélection aléatoire',
    title: 'Choix tiré au sort à chaque ouverture de la liste',
  },
]);

// La taille de la scène est **lue** au premier rendu et suivie ensuite : un
// état initialisé à zéro laisserait la caméra de la miniature et le zoom
// centré sans repère pendant une image.
function useHostSize(hostRef) {
  const [size, setSize] = useState(() => ({
    width: hostRef.current?.clientWidth ?? 0,
    height: hostRef.current?.clientHeight ?? 0,
  }));
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => setSize((previous) => (
      previous.width === element.clientWidth && previous.height === element.clientHeight
        ? previous
        : { width: element.clientWidth, height: element.clientHeight }
    ));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hostRef]);
  return size;
}

// Le point du graphe amené au centre de la scène. C'est la seule opération de
// caméra de la miniature : elle ne change jamais l'échelle.
function centerCamera(engine, size, point) {
  const current = engine.getViewport();
  void engine.setViewport({
    x: size.width / 2 - point.x * current.zoom,
    y: size.height / 2 - point.y * current.zoom,
    zoom: current.zoom,
  });
}

function Overview({ engineRef, index, viewport, hostSize, livePositions, onClose = null }) {
  const overview = useMemo(() => buildOverview(index, livePositions), [index, livePositions]);
  const dragging = useRef(false);

  // La boîte est demandée à l'élément **qui reçoit** le geste : c'est le seul
  // qui soit sûrement là, et il n'y a pas de second chemin à tenir à jour.
  const cameraFrom = useCallback((event) => {
    const engine = engineRef.current;
    if (!engine || !overview || hostSize.width === 0) return;
    const rect = event.currentTarget?.getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const px = (event.clientX - rect.left) * (MAP_WIDTH / rect.width);
    const py = (event.clientY - rect.top) * (MAP_HEIGHT / rect.height);
    centerCamera(engine, hostSize, overview.unproject(px, py));
  }, [engineRef, hostSize, overview]);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cameraFrom(event);
  };
  const onPointerMove = (event) => {
    if (!dragging.current) return;
    cameraFrom(event);
  };
  const onPointerUp = (event) => {
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // Le clavier déplace la caméra d'un quart d'écran : la miniature est un
  // geste de vue, pas une liste de nœuds — les nœuds, eux, restent atteints
  // par la liste de recherche.
  const onKeyDown = (event) => {
    const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    const engine = engineRef.current;
    if (!step || !engine || hostSize.width === 0) return;
    event.preventDefault();
    const current = engine.getViewport();
    void engine.setViewport({
      x: current.x - step[0] * hostSize.width / 4,
      y: current.y - step[1] * hostSize.height / 4,
      zoom: current.zoom,
    });
  };

  const camera = overviewCamera(overview, viewport, hostSize);

  return (
    <div className="advanced-graph-overview">
      <div className="advanced-graph-overview__title">
        <span>Vue d’ensemble</span>
        {onClose && (
          <Tooltip text="Fermer la vue d’ensemble" asChild>
            <button
              type="button"
              className="advanced-graph-overview__close"
              onClick={onClose}
              aria-label="Fermer la vue d’ensemble"
            >
              <X />
            </button>
          </Tooltip>
        )}
      </div>
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="application"
        tabIndex={0}
        aria-label="Vue d’ensemble du graphe : cliquer ou glisser déplace la caméra, les flèches la déplacent au clavier"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {(overview?.marks ?? []).map((mark) => (
          <rect
            key={mark.path}
            className={mark.tone ? `is-${mark.tone}` : undefined}
            x={mark.px - (mark.kind === 'action' ? 1 : 1.5)}
            y={mark.py - 1}
            width={mark.kind === 'action' ? 2 : 3}
            height={2}
            rx={1}
          />
        ))}
        {camera && (
          <rect
            className="advanced-graph-overview__camera"
            x={camera.x}
            y={camera.y}
            width={camera.width}
            height={camera.height}
            rx={2}
          />
        )}
      </svg>
    </div>
  );
}

// Le rangement du graphe : un bouton, et ses replis.
//
// Il n'y a pas de menu d'algorithmes. Les cinq dispositions génériques
// rangeaient le graphe du document, où les retours Home et les Actions de
// raccord décident de tout ; la Vue parcours range le graphe de mise en page,
// et c'est la seule qui réponde à « à quoi ressemble mon histoire ».
//
// Il n'y a pas non plus d'aperçu ni d'avertissement à confirmer. Un rangement
// se comporte comme un déplacement à la main : il écrit la position d'auteur
// tout de suite — un nœud n'a qu'une position, celle du graphe à plat —, et
// `Ctrl+Z` le défait. Un aperçu serait une seconde mécanique d'annulation
// réservée à une seule opération — et le meilleur aperçu d'un rangement reste
// le rangement lui-même, qui est visible à l'instant où il est fait.
//
// Un rangement calculé ne devient authored que si l'auteur l'applique
// **explicitement**. Ce clic, ou sa touche, est cet
// acte ; le calcul et son état vivent dans `useGraphArrangement`, que le
// clavier partage. Une seule exception : un pack sans
// disposition lisible — aucune position, ou toutes au même point — est rangé
// seul à l'ouverture (`needsInitialLayout`, dans `AdvancedWorkspace`).
//
// Aucune politique de bornes n'est demandée : `parcoursLayout` rend des
// entiers déjà contenus dans `[-32768, 32767]`, donc la règle 5 — qui refuse à
// Story Studio de créer une position hors borne sans décision — ne peut pas se
// déclencher.
function LayoutControls({ arrangement, shortcut = '' }) {
  const { busy, failure, disabled, arrange } = arrangement;
  const press = (fold) => { void arrange(fold); };

  // Les replis offerts. Ils ne corrigent pas le rangement — sa forme est celle
  // de l'histoire, et c'est une lecture exacte — ils proposent l'autre
  // compromis : moins de continuité, plus de compacité.
  const folds = [
    ...FOLD_PARTS.map((parts) => ({
      key: `bands-${parts}`,
      fold: { bands: parts },
      Icon: Rows2,
      label: `Replier en ${parts} bandes empilées`,
    })),
    ...FOLD_PARTS.map((parts) => ({
      key: `lanes-${parts}`,
      fold: { lanes: parts },
      Icon: Columns2,
      label: `Replier chaque rang en ${parts} colonnes`,
    })),
  ];

  // Un bouton dans la barre des commandes, et ses replis qui se déplient à sa
  // droite au survol : ce sont des variantes du même geste, pas un réglage
  // séparé.
  return (
    <div className="advanced-layout-control" role="group" aria-label="Ranger le graphe">
      <Tooltip text={withShortcut('Ranger le graphe en suivant le parcours de l’histoire', shortcut)} asChild wrap>
        <button
          type="button"
          className="advanced-layout-control__trigger"
          onClick={() => press(NO_FOLD)}
          disabled={disabled || busy}
          aria-busy={busy ? 'true' : undefined}
          aria-label={busy ? 'Rangement…' : 'Ranger le graphe'}
        >
          <BroomSparkles />
        </button>
      </Tooltip>
      <div className="advanced-layout-control__folds">
        {folds.map(({ key, fold, Icon, label }) => (
          <Tooltip key={key} text={label} asChild wrap>
            <button
              type="button"
              className="advanced-layout-control__fold"
              onClick={() => press(fold)}
              disabled={disabled || busy}
              aria-label={label}
            >
              <Icon />
              <span aria-hidden="true">{fold.bands ?? fold.lanes}</span>
            </button>
          </Tooltip>
        ))}
      </div>
      {failure && (
        <p className="advanced-layout-control__warning" role="alert">{failure}</p>
      )}
    </div>
  );
}

export function GraphSurfaceControls({
  engineRef, index, viewport, hostRef, livePositions = null,
  surfaceTools = null,
  presentation = null,
  presentationControls = null,
  edgeVisibility = DEFAULT_EDGE_VISIBILITY,
  onEdgeVisibilityChange = () => {},
  history = null,
  // Le rangement, tenu par l'hôte (`useGraphArrangement`) pour que le bouton
  // et le clavier partagent son état : `{ busy, failure, disabled, arrange }`.
  arrangement = null,
  overviewOpen = true,
  onToggleOverview = null,
}) {
  const hostSize = useHostSize(hostRef);
  const zoom = viewport?.zoom ?? 1;
  // Les touches annoncées sont celles qui marchent : reconfigurées dans les
  // préférences, elles changent ici aussi.
  const labels = useShortcutLabels();

  // Le zoom garde le **centre visible** stable ; le calcul est celui du
  // clavier (`zoomedViewport`).
  const zoomBy = (factor) => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = zoomedViewport(engine.getViewport(), hostSize, factor);
    if (next) void engine.setViewport(next);
  };
  return (
    <>
      {surfaceTools && (
        <StructureActionsBar
          variant="canvas"
          workspaceMode={WORKSPACE_MODE_ADVANCED}
          ariaLabel="Actions du graphe"
          onImportMedia={surfaceTools.onImportMedia}
          onImportPodcast={surfaceTools.onImportPodcast}
          onImportYoutube={surfaceTools.onImportYoutube}
          onRecord={surfaceTools.onRecord}
          onGenerateStoryTts={surfaceTools.onGenerateStoryTts}
          canRecord={surfaceTools.canRecord}
          canGenerateStoryTts={surfaceTools.canGenerateStoryTts}
          onLaunchSimulator={surfaceTools.onSimulate}
          availableInlineSize={hostSize.width ? hostSize.width - 24 : null}
          trailing={surfaceTools.onSearch && (
            <StructureSearchButton
              label="Rechercher dans les nœuds du graphe"
              onClick={surfaceTools.onSearch}
            />
          )}
        />
      )}
      {/* Tout ce qui déplace la caméra sans rien modifier au document, et rien
          d'autre : agrandir, réduire, tout cadrer, et revenir où l'on était.
          Le pas-à-pas est posé sous le zoom plutôt qu'ailleurs parce qu'il
          restaure aussi le cadrage — et le pourcentage qui change alors est
          juste au-dessus. */}
      <div className={`advanced-graph-camera${surfaceTools ? ' advanced-graph-camera--joined' : ''}`}>
        <div className="advanced-graph-zoom" role="group" aria-label="Zoom du graphe">
          <Tooltip text={withShortcut('Agrandir', labels.graphZoomIn)} asChild>
            <button type="button" onClick={() => zoomBy(GRAPH_ZOOM_STEP)} aria-label="Agrandir">+</button>
          </Tooltip>
          <output aria-label="Niveau de zoom">{Math.round(zoom * 100)}%</output>
          <Tooltip text={withShortcut('Réduire', labels.graphZoomOut)} asChild>
            <button type="button" onClick={() => zoomBy(1 / GRAPH_ZOOM_STEP)} aria-label="Réduire">−</button>
          </Tooltip>
          <Tooltip text={withShortcut('Cadrer tout le graphe', labels.graphFit)} asChild>
            <button type="button" className="advanced-graph-zoom__fit" onClick={() => void engineRef.current?.fitContent()} aria-label="Cadrer tout le graphe">⌗</button>
          </Tooltip>
        </div>
        {/* Précédent et Suivant portent sur les **révélations volontaires** —
            une recherche validée, un clic sur une connexion. Ils ne défont
            aucun geste : une commande impossible reste donc affichée et
            expliquée par son titre, au lieu de disparaître sans raison. */}
        {history && (
          <div className="advanced-graph-steps" role="group" aria-label="Navigation dans les nœuds visités">
            <Tooltip
              text={history.canBack
                ? withShortcut('Revenir au nœud visité juste avant. Ne défait aucune modification.', labels.graphVisitBack)
                : 'Aucun nœud visité avant celui-ci.'}
              wrap
            >
              <button
                type="button"
                onClick={history.onBack}
                aria-disabled={history.canBack ? undefined : 'true'}
                aria-label="Nœud visité précédent"
              >
                ‹
              </button>
            </Tooltip>
            <Tooltip
              text={history.canForward
                ? withShortcut('Repartir vers le nœud visité ensuite. Disponible après un retour en arrière.', labels.graphVisitForward)
                : 'Aucun nœud visité après celui-ci.'}
              wrap
            >
              <button
                type="button"
                onClick={history.onForward}
                aria-disabled={history.canForward ? undefined : 'true'}
                aria-label="Nœud visité suivant"
              >
                ›
              </button>
            </Tooltip>
          </div>
        )}
        {/* Ce qui règle la surface elle-même : ranger le graphe, et ouvrir ou
            replier sa vue d'ensemble. Ranger modifie le document, contrairement
            au reste de la colonne ; il y est quand même, dans son propre groupe,
            parce que c'est un geste sur l'ensemble de la surface et qu'il
            libère le coin haut où il flottait seul. */}
        {(arrangement || onToggleOverview) && (
          <div className="advanced-graph-tools" role="group" aria-label="Rangement et vue d’ensemble">
            {arrangement && (
              <LayoutControls arrangement={arrangement} shortcut={labels.graphArrange} />
            )}
            {onToggleOverview && (
              <Tooltip
                text={withShortcut(
                  overviewOpen ? 'Replier la vue d’ensemble' : 'Afficher la vue d’ensemble',
                  labels.graphToggleOverview,
                )}
                asChild
              >
                <button
                  type="button"
                  className={`advanced-graph-tools__overview${overviewOpen ? ' is-on' : ''}`}
                  onClick={onToggleOverview}
                  aria-pressed={overviewOpen}
                  aria-label="Vue d’ensemble"
                >
                  <MapIcon />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="advanced-graph-legend" role="group" aria-label="Filtres des chemins du graphe">
        {EDGE_FILTERS.map((filter) => {
          const isVisible = edgeVisibility[filter.group] !== false;
          return (
            <Tooltip key={filter.group} text={filter.title} asChild disabled={!filter.title}>
              <label
                className={`advanced-graph-legend__filter ${isVisible ? '' : 'is-disabled'}`}
              >
                <input
                  className="advanced-graph-legend__input"
                  type="checkbox"
                  aria-label={filter.ariaLabel}
                  checked={isVisible}
                  onChange={(event) => onEdgeVisibilityChange({
                    ...edgeVisibility,
                    [filter.group]: event.currentTarget.checked,
                  })}
                />
                <span className="advanced-graph-legend__checkbox" aria-hidden="true">
                  {isVisible && <Check />}
                </span>
                <i className={filter.className} aria-hidden="true" />
                <span>{filter.label}</span>
              </label>
            </Tooltip>
          );
        })}
      </div>
      {presentation?.mode && (
        <div className="advanced-graph-presentation" role="status">
          <strong>
            {presentation.mode === 'connections'
              ? `Connexions · niveau ${presentation.levels}`
              : `Parcours suivi · ${presentation.nodePaths?.length ?? 0} nœuds`}
          </strong>
          {presentation.mode === 'connections' && presentationControls?.onExtend && (
            <button type="button" onClick={presentationControls.onExtend}>Étendre d’un niveau</button>
          )}
          {presentation.mode === 'playback' && presentationControls?.onToggleFollow && (
            <label>
              <input
                type="checkbox"
                checked={presentationControls.followCamera === true}
                onChange={presentationControls.onToggleFollow}
              />
              Suivre la lecture
            </label>
          )}
          {presentationControls?.onExit && (
            <button type="button" onClick={presentationControls.onExit}>Vue complète</button>
          )}
        </div>
      )}
      {/* Repliée, la vue d'ensemble n'est pas montée : elle ne calcule plus
          rien à chaque déplacement de la caméra. */}
      {overviewOpen && (
        <Overview
          engineRef={engineRef}
          index={index}
          viewport={viewport}
          hostSize={hostSize}
          livePositions={livePositions}
          onClose={onToggleOverview}
        />
      )}
    </>
  );
}
