import { useTranslation } from 'react-i18next';
import { translateGraph as t, graphTranslationEngine } from '../../i18n/graphPresentation.js';
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
    label: "graph:surface.structure.label",
    className: 'is-structure',
    ariaLabel: "graph:surface.showStructuralLinks.label",
  },
  {
    group: EDGE_VISIBILITY_GROUPS.RETURNS,
    label: "graph:surface.retour.label",
    className: 'is-return',
    ariaLabel: "graph:surface.showReturns.label",
  },
  {
    group: EDGE_VISIBILITY_GROUPS.DEVICE_RETURNS,
    label: "graph:surface.retourLunii.label",
    className: 'is-device-return',
    ariaLabel: "graph:surface.showDefaultLuniiReturns.label",
    title: "graph:surface.homeButtonWithNoDestinationLuniiReturnsToThe.label",
  },
  {
    group: EDGE_VISIBILITY_GROUPS.RANDOM,
    label: "graph:surface.aleatoire.label",
    className: 'is-random',
    ariaLabel: "graph:surface.showLinksWithRandomSelection.label",
    title: "graph:surface.choiceDrawnAtRandomEachTimeTheListOpens.label",
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
  useTranslation('graph', { i18n: graphTranslationEngine() });
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
        <span>{t("graph:surface.vueDEnsemble.label")}</span>
        {onClose && (
          <Tooltip text={t("graph:surface.closeOverview.label")} asChild>
            <button
              type="button"
              className="advanced-graph-overview__close"
              onClick={onClose}
              aria-label={t("graph:surface.closeOverview.label")}
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
        aria-label={t("graph:surface.graphOverviewClickOrDragToMoveTheCamera.label")}
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
  useTranslation('graph', { i18n: graphTranslationEngine() });
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
      label: t("graph:surface.foldIntoStackedBands.label", { parts: parts }),
    })),
    ...FOLD_PARTS.map((parts) => ({
      key: `lanes-${parts}`,
      fold: { lanes: parts },
      Icon: Columns2,
      label: t('graph:surface.fold.lanes', { parts }),
    })),
  ];

  // Un bouton dans la barre des commandes, et ses replis qui se déplient à sa
  // droite au survol : ce sont des variantes du même geste, pas un réglage
  // séparé.
  return (
    <div className="advanced-layout-control" role="group" aria-label={t("graph:surface.rangerLeGraphe.label")}>
      <Tooltip text={withShortcut(t('graph:surface.arrange.help'), shortcut)} asChild wrap>
        <button
          type="button"
          className="advanced-layout-control__trigger"
          onClick={() => press(NO_FOLD)}
          disabled={disabled || busy}
          aria-busy={busy ? 'true' : undefined}
          aria-label={busy ? t("graph:surface.rangement.label") : t('graph:surface.rangerLeGraphe.label')}
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
        <p className="advanced-layout-control__warning" role="alert">{t(failure)}</p>
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
  useTranslation('graph', { i18n: graphTranslationEngine() });
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
          ariaLabel={t("graph:surface.graphActions.label")}
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
              label={t("graph:surface.searchGraphNodes.label")}
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
        <div className="advanced-graph-zoom" role="group" aria-label={t("graph:surface.zoomDuGraphe.label")}>
          <Tooltip text={withShortcut(t('graph:surface.agrandir.label'), labels.graphZoomIn)} asChild>
            <button type="button" onClick={() => zoomBy(GRAPH_ZOOM_STEP)} aria-label={t("graph:surface.agrandir.label")}>+</button>
          </Tooltip>
          <output aria-label={t("graph:surface.niveauDeZoom.label")}>{Math.round(zoom * 100)}%</output>
          <Tooltip text={withShortcut(t("graph:surface.zoomOut.label"), labels.graphZoomOut)} asChild>
            <button type="button" onClick={() => zoomBy(1 / GRAPH_ZOOM_STEP)} aria-label={t("graph:surface.zoomOut.label")}>−</button>
          </Tooltip>
          <Tooltip text={withShortcut(t('graph:surface.fitEntireGraph.label'), labels.graphFit)} asChild>
            <button type="button" className="advanced-graph-zoom__fit" onClick={() => void engineRef.current?.fitContent()} aria-label={t("graph:surface.fitEntireGraph.label")}>⌗</button>
          </Tooltip>
        </div>
        {/* Précédent et Suivant portent sur les **révélations volontaires** —
            une recherche validée, un clic sur une connexion. Ils ne défont
            aucun geste : une commande impossible reste donc affichée et
            expliquée par son titre, au lieu de disparaître sans raison. */}
        {history && (
          <div className="advanced-graph-steps" role="group" aria-label={t("graph:surface.visitedNodeNavigation.label")}>
            <Tooltip
              text={history.canBack
                ? withShortcut(t("graph:surface.returnToThePreviousVisitedNodeNoEditsAre.label"), labels.graphVisitBack)
                : t("graph:surface.noNodesVisitedBeforeThisOne.label")}
              wrap
            >
              <button
                type="button"
                onClick={history.onBack}
                aria-disabled={history.canBack ? undefined : 'true'}
                aria-label={t("graph:surface.previousVisitedNode.label")}
              >
                ‹
              </button>
            </Tooltip>
            <Tooltip
              text={history.canForward
                ? withShortcut(t("graph:surface.goToTheNextVisitedNodeAvailableAfterGoing.label"), labels.graphVisitForward)
                : t("graph:surface.noNodesVisitedAfterThisOne.label")}
              wrap
            >
              <button
                type="button"
                onClick={history.onForward}
                aria-disabled={history.canForward ? undefined : 'true'}
                aria-label={t("graph:surface.nextVisitedNode.label")}
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
          <div className="advanced-graph-tools" role="group" aria-label={t("graph:surface.arrangementAndOverview.label")}>
            {arrangement && (
              <LayoutControls arrangement={arrangement} shortcut={labels.graphArrange} />
            )}
            {onToggleOverview && (
              <Tooltip
                text={withShortcut(
                  overviewOpen ? t('graph:surface.overview.hide') : t('graph:surface.overview.show'),
                  labels.graphToggleOverview,
                )}
                asChild
              >
                <button
                  type="button"
                  className={`advanced-graph-tools__overview${overviewOpen ? ' is-on' : ''}`}
                  onClick={onToggleOverview}
                  aria-pressed={overviewOpen}
                  aria-label={t("graph:surface.vueDEnsemble.label")}
                >
                  <MapIcon />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="advanced-graph-legend" role="group" aria-label={t("graph:surface.graphPathFilters.label")}>
        {EDGE_FILTERS.map((filter) => {
          const isVisible = edgeVisibility[filter.group] !== false;
          return (
            <Tooltip key={filter.group} text={filter.title ? t(filter.title) : undefined} asChild disabled={!filter.title}>
              <label
                className={`advanced-graph-legend__filter ${isVisible ? '' : 'is-disabled'}`}
              >
                <input
                  className="advanced-graph-legend__input"
                  type="checkbox"
                  aria-label={filter.ariaLabel ? t(filter.ariaLabel) : undefined}
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
                <span>{filter.label ? t(filter.label) : undefined}</span>
              </label>
            </Tooltip>
          );
        })}
      </div>
      {presentation?.mode && (
        <div className="advanced-graph-presentation" role="status">
          <strong>
            {presentation.mode === 'connections'
              ? t("graph:surface.connectionsLevel.label", { levels: presentation.levels })
              : t('graph:surface.playback.nodeCount', { count: presentation.nodePaths?.length ?? 0 })}
          </strong>
          {presentation.mode === 'connections' && presentationControls?.onExtend && (
            <button type="button" onClick={presentationControls.onExtend}>{t("graph:surface.extendByOneLevel.label")}</button>
          )}
          {presentation.mode === 'playback' && presentationControls?.onToggleFollow && (
            <label>
              <input
                type="checkbox"
                checked={presentationControls.followCamera === true}
                onChange={presentationControls.onToggleFollow}
              />{t("graph:surface.followPlayback.label")}</label>
          )}
          {presentationControls?.onExit && (
            <button type="button" onClick={presentationControls.onExit}>{t("graph:surface.vueComplete.label")}</button>
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
