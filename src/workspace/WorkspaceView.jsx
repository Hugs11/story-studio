import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { DiagramPanel } from '../components/diagram/DiagramPanel';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';
import { EDITOR_LAYOUT_SCOPE } from '../store/persistentSettings';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { StructurePanel } from '../components/structure/StructurePanel';
import {
  LEFT_PANEL_MIN_WIDTH,
} from '../components/structure/panelResize';
import { PanelResizeHandle } from '../components/structure/PanelResizeHandle';
import { startStageForEntry, useProjectedSimulation } from '../hooks/useProjectedSimulation';
import { useProjectActions } from '../store/ProjectActionsContext';
import { shouldOpenSettingsForSelection } from '../store/selectionOpensSettings';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HOME,
  authoringWorkspaceMode,
  hasProjectTree,
  hierarchicalProjectType,
} from '../store/projectWorkState';
import {
  getTreePanelMaxWidth,
  SETTINGS_PANEL_WIDTH_DEFAULT,
  SETTINGS_PANEL_WIDTH_MAX,
  SETTINGS_PANEL_WIDTH_MIN,
  TREE_PANEL_WIDTH_DEFAULT,
} from './useWorkspaceViewState';
import {
  getFlexibleWorkspacePanelId,
  getVisibleWorkspacePanelOrder,
  getWorkspaceResizeBoundaries,
  WORKSPACE_PANEL_IDS,
} from './panelLayout';
import { PanelSortContext, SortablePanelItem } from './PanelSortContext';
import { SettingsPanel } from './SettingsPanel';
import { SettingsPanelHeader } from './SettingsPanelHeader';
import {
  buildSimulatorSelectionSync,
  getPendingInternalSelectedId,
  resolveWorkspaceSelectionSync,
} from './selectionSync';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

// L'espace avancé est chargé à la demande : le moteur d'affichage et ses
// dépendances n'entrent dans le bundle que lorsqu'un projet avancé est ouvert.
const AdvancedWorkspace = lazy(() => import('../components/AdvancedWorkspace/AdvancedWorkspace')
  .then((module) => ({ default: module.AdvancedWorkspace })));

export function WorkspaceView({
  project,
  projectEpoch = null,
  node,
  selectedId,
  onSetProjectType,
  onStartAdvancedProject,
  onEditPack,
  onPodcastFunnel,
  onYoutubeFunnel,
  onAggregatePacks,
  onCheckPack,
  onOpenProject,
  onOpenPreferences,
  recentProjects,
  onOpenRecentProject,
  pendingSimulateZipPath = null,
  onSimulateConsumed,
  sessionRecoveries = [],
  onRecoverSession,
  onIgnoreSessionRecovery,
  validationIssues,
  allMenus,
  projectIndex,
  treeSearchFocusTrigger,
  onFocusTreeSearch,
  diagramSearchFocusTrigger,
  workspaceViewState,
  advanced = null,
}) {
  const { onSelect } = useProjectActions();
  // Seul point de montage de l'espace de travail hiérarchique : un projet avancé
  // n'en monte aucun composant. Le mode d'auteur,
  // lui, décide **quel** espace monter — et un projet avancé ouvert n'est plus
  // renvoyé à l'accueil du seul fait que son type hiérarchique est `null`.
  const projectType = hierarchicalProjectType(project);
  const workspaceMode = authoringWorkspaceMode(project);
  const hasTree = hasProjectTree(project);
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [afterPlayFocus, setAfterPlayFocus] = useState(null);
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const [simulatorZipPath, setSimulatorZipPath] = useState(null);
  // Le jeton de lancement d'une écoute. Il change à chaque demande, et c'est lui
  // — jamais le projet — qui déclenche une projection : le générateur rend des
  // identifiants neufs à chaque appel, donc reprojeter en cours d'écoute
  // téléporterait l'auditeur au lieu de le suivre.
  const [simulationLaunch, setSimulationLaunch] = useState(null);
  const simulationEpochRef = useRef(projectEpoch);
  const projectEpochRef = useRef(projectEpoch);
  projectEpochRef.current = projectEpoch;
  const [expandedDiagramStoryGroupIds, setExpandedDiagramStoryGroupIds] = useState(() => new Set());
  const [hoveredStructureNodeId, setHoveredStructureNodeId] = useState(null);
  const [treeRevealRequest, setTreeRevealRequest] = useState(null);
  const [diagramRevealRequest, setDiagramRevealRequest] = useState(null);
  const selectedIdRef = useRef(selectedId);
  const selectedIdsRef = useRef(selectedIds);
  const pendingInternalSelectedIdRef = useRef(null);
  const revealRequestIdRef = useRef(0);
  selectedIdRef.current = selectedId;

  // WorkspaceView reste monté derrière l'accueil. Sans remise à zéro ici, les
  // groupes ouverts dans le projet précédent peuvent se rouvrir dans un pack
  // fraîchement extrait lorsque celui-ci réutilise les mêmes ids importés.
  useEffect(() => {
    if (hasTree) return;
    setExpandedDiagramStoryGroupIds((current) => (current.size > 0 ? new Set() : current));
  }, [hasTree]);

  const {
    showTree,
    showSettings,
    showDiagram,
    panelOrder,
    isPlein,
    toggleTree,
    toggleSettings,
    toggleDiagram,
    restoreSettings,
    closeDiagram,
    movePanel,
    settingsPanelWidth,
    setSettingsPanelWidth,
    treePanelWidth,
    setTreePanelWidth,
  } = workspaceViewState;

  // Dépendances inchangées : `projectType` est ici une identité de surface, pas
  // une capacité — passer de 'pack' à 'simple' doit continuer à purger le survol.
  useEffect(() => {
    setHoveredStructureNodeId(null);
  }, [projectType, showDiagram, showTree]);

  const handleStructureNodeHoverChange = useCallback((nodeId, isHovered) => {
    setHoveredStructureNodeId((current) => {
      if (isHovered) return nodeId;
      return current === nodeId ? null : current;
    });
  }, []);

  const handleSimulateNode = useCallback((nodeId) => {
    simulationEpochRef.current = projectEpoch;
    setSimulatorZipPath(null);
    setSimulatorAnchorId(nodeId);
    setSimulationLaunch({ nodeId, at: Date.now() });
  }, [projectEpoch]);

  const handleSimulateRoot = useCallback(() => {
    handleSimulateNode('root');
  }, [handleSimulateNode]);

  const handleSimulateZip = useCallback((zipPath) => {
    simulationEpochRef.current = projectEpoch;
    setSimulatorAnchorId(null);
    setSimulatorZipPath(zipPath);
    setSimulationLaunch(null);
  }, [projectEpoch]);

  const handleCloseSimulator = useCallback(() => {
    setSimulatorAnchorId(null);
    setSimulatorZipPath(null);
    setSimulationLaunch(null);
  }, []);

  useEffect(() => {
    handleCloseSimulator();
  }, [projectEpoch, handleCloseSimulator]);

  // L'écoute du projet en cours, projetée par le générateur. Elle ne part que
  // sur une demande explicite, et le graphe qu'elle rend est figé jusqu'à la
  // suivante.
  const simulation = useProjectedSimulation({ project, projectEpoch, launch: simulationLaunch });
  const simulationForCurrentProject = simulationEpochRef.current === projectEpoch;

  useEffect(() => {
    if (!pendingSimulateZipPath || projectType == null) return;
    handleSimulateZip(pendingSimulateZipPath);
    onSimulateConsumed?.();
  }, [pendingSimulateZipPath, projectType, handleSimulateZip, onSimulateConsumed]);

  const commitSelectionChange = useCallback((ids) => {
    pendingInternalSelectedIdRef.current = null;
    const nextIds = ids?.size > 0 ? ids : new Set([selectedIdRef.current]);
    selectedIdsRef.current = nextIds;
    setSelectedIds(nextIds);
  }, []);

  // Une sélection choisie dans l'arbre ou le diagramme rouvre les Réglages
  // fermés, pour éditer ce qui vient d'être désigné — sauf si la préférence
  // commune aux deux éditeurs le refuse. L'arbre signale ce qui vient de
  // l'auteur : le recalage sur la racine après une suppression n'ouvre rien.
  const handleTreeSelectionChange = useCallback((ids, origin) => {
    commitSelectionChange(ids);
    if (origin?.byAuthor && shouldOpenSettingsForSelection(ids?.size ?? 0, { panelOpen: showSettings })) {
      restoreSettings();
    }
  }, [commitSelectionChange, restoreSettings, showSettings]);

  const handleDiagramSelectionChange = useCallback((ids) => {
    commitSelectionChange(ids);
    if (shouldOpenSettingsForSelection(ids?.size ?? 0, { panelOpen: showSettings })) {
      restoreSettings();
    }
  }, [commitSelectionChange, restoreSettings, showSettings]);

  const handleTreeNodeSelect = useCallback((id) => {
    pendingInternalSelectedIdRef.current = getPendingInternalSelectedId({
      currentSelectedId: selectedIdRef.current,
      nextSelectedId: id,
    });
    onSelect(id);
    setDiagramRevealRequest({ id, requestId: ++revealRequestIdRef.current });
  }, [onSelect]);

  const handleDiagramNodeSelect = useCallback((id) => {
    pendingInternalSelectedIdRef.current = getPendingInternalSelectedId({
      currentSelectedId: selectedIdRef.current,
      nextSelectedId: id,
    });
    onSelect(id);
    setTreeRevealRequest({ id, requestId: ++revealRequestIdRef.current });
  }, [onSelect]);

  const handleSimulatorActiveNodeChange = useCallback((id) => {
    const sync = buildSimulatorSelectionSync(id, ++revealRequestIdRef.current);
    if (!sync) return;
    commitSelectionChange(sync.selectedIds);
    pendingInternalSelectedIdRef.current = getPendingInternalSelectedId({
      currentSelectedId: selectedIdRef.current,
      nextSelectedId: id,
    });
    onSelect(id);
    setTreeRevealRequest(sync.revealRequest);
    setDiagramRevealRequest(sync.revealRequest);
  }, [commitSelectionChange, onSelect]);

  // L'Écran qui joue désigne le nœud d'auteur dont il vient. Un Écran qui n'en
  // désigne aucun — le générateur en produit qui n'appartiennent à aucune
  // entrée — laisse la sélection de l'auteur où elle est plutôt que de la
  // déplacer au hasard.
  const handleSimulatorActiveNode = useCallback((stageId) => {
    // Un dernier événement du lecteur quitté ne sélectionne rien dans le
    // nouveau projet, même si les identifiants importés y sont les mêmes.
    if (projectEpochRef.current !== projectEpoch) return;
    const entryId = simulation.graph?.entryIdByStage?.get(stageId) ?? null;
    if (entryId) handleSimulatorActiveNodeChange(entryId);
  }, [projectEpoch, simulation.graph, handleSimulatorActiveNodeChange]);

  const handleOpenLocalEndSettings = useCallback((storyId) => {
    commitSelectionChange(new Set([storyId]));
    handleDiagramNodeSelect(storyId);
    if (!showSettings) restoreSettings();
    setAfterPlayFocus({ storyId, requestId: Date.now() });
  }, [commitSelectionChange, handleDiagramNodeSelect, restoreSettings, showSettings]);
  const handleAfterPlayFocusConsumed = useCallback(() => {
    setAfterPlayFocus(null);
  }, []);

  useEffect(() => {
    const sync = resolveWorkspaceSelectionSync({
      selectedId,
      selectedIds: selectedIdsRef.current,
      pendingInternalSelectedId: pendingInternalSelectedIdRef.current,
    });
    pendingInternalSelectedIdRef.current = sync.pendingInternalSelectedId;
    if (!sync.preserveSelection) {
      selectedIdsRef.current = sync.selectedIds;
      setSelectedIds(sync.selectedIds);
    }
  }, [selectedId]);

  const style = {
    '--col-left': `${treePanelWidth}px`,
    '--workspace-settings-panel-width': `${settingsPanelWidth}px`,
  };

  const renderStructurePanel = (headerDragHandleProps) => (
    <StructurePanel
      canvasActionsAvailable={showDiagram}
      project={project}
      projectType={projectType}
      selectedId={selectedId}
      selectedIds={selectedIds}
      projectIndex={projectIndex}
      validationIssues={validationIssues}
      treeSearchFocusTrigger={treeSearchFocusTrigger}
      selectionRevealRequest={treeRevealRequest}
      hoveredNodeId={hoveredStructureNodeId}
      onNodeHoverChange={handleStructureNodeHoverChange}
      onSelectNode={handleTreeNodeSelect}
      onSelectionChange={handleTreeSelectionChange}
      onFocusTreeSearch={onFocusTreeSearch}
      onSimulateNode={handleSimulateNode}
      onSimulateZip={handleSimulateZip}
      onSimulateRoot={handleSimulateRoot}
      headerDragHandleProps={headerDragHandleProps}
    />
  );

  const renderSettingsPanel = (headerDragHandleProps) => (
    <SettingsPanel
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      projectType={projectType}
      allMenus={allMenus}
      projectIndex={projectIndex}
      afterPlayFocus={afterPlayFocus}
      onAfterPlayFocusConsumed={handleAfterPlayFocusConsumed}
      header={(
        <SettingsPanelHeader
          node={node}
          selectedId={selectedId}
          selectedIds={selectedIds}
          project={project}
          onClose={toggleSettings}
          dragHandleProps={headerDragHandleProps}
        />
      )}
    />
  );

  // La clé remonte le diagramme au passage plein↔colonne et après réorganisation,
  // afin de le re-centrer sur sa nouvelle largeur. Les groupes ouverts restent
  // contrôlés par WorkspaceView et survivent donc au remontage.
  const renderDiagramPanel = (variant, headerDragHandleProps, orderKey) => (
    <DiagramPanel
      key={`${variant}:${orderKey}`}
      project={project}
      projectType={projectType}
      projectIndex={projectIndex}
      selectedId={selectedId}
      selectedIds={selectedIds}
      onSelectNode={handleDiagramNodeSelect}
      onSelectionChange={handleDiagramSelectionChange}
      selectionRevealRequest={diagramRevealRequest}
      hoveredNodeId={hoveredStructureNodeId}
      onNodeHoverChange={handleStructureNodeHoverChange}
      searchFocusTrigger={diagramSearchFocusTrigger}
      expandedStoryGroupIds={expandedDiagramStoryGroupIds}
      onExpandedStoryGroupIdsChange={setExpandedDiagramStoryGroupIds}
      variant={variant}
      showActionsBar={showDiagram}
      showHint={showDiagram && !showSettings}
      onClose={closeDiagram}
      onPreview={handleSimulateNode}
      onSimulateZip={handleSimulateZip}
      onSimulateRoot={handleSimulateRoot}
      onOpenLocalEndSettings={handleOpenLocalEndSettings}
      headerDragHandleProps={headerDragHandleProps}
    />
  );

  if (workspaceMode === WORKSPACE_MODE_ADVANCED) {
    return (
      <div className="screen visible">
        <div className="workspace workspace--advanced">
          <Suspense fallback={<p className="workspace-advanced-loading">Ouverture de l'Éditeur graphe…</p>}>
            <AdvancedWorkspace {...advanced} project={project} />
          </Suspense>
        </div>
      </div>
    );
  }

  // Après le retour avancé ci-dessus, « pas d'arbre » et « aucun projet ouvert »
  // coïncident : c'est bien la seconde question que l'accueil pose.
  if (workspaceMode === WORKSPACE_MODE_HOME) {
    return (
      <div className="screen visible">
        <div className="workspace workspace--home">
          <ModeSelector
            onSelect={onSetProjectType}
            onSelectGraph={onStartAdvancedProject}
            onEditPack={onEditPack}
            onPodcastFunnel={onPodcastFunnel}
            onYoutubeFunnel={onYoutubeFunnel}
            onAggregatePacks={onAggregatePacks}
            onCheckPack={onCheckPack}
            onOpen={onOpenProject}
            onOpenPreferences={onOpenPreferences}
            recentProjects={recentProjects}
            onOpenRecent={onOpenRecentProject}
            sessionRecoveries={sessionRecoveries}
            onRecoverSession={onRecoverSession}
            onIgnoreSessionRecovery={onIgnoreSessionRecovery}
          />
        </div>
      </div>
    );
  }

  const visibility = {
    [WORKSPACE_PANEL_IDS.STRUCTURE]: showTree,
    [WORKSPACE_PANEL_IDS.SETTINGS]: showSettings,
    [WORKSPACE_PANEL_IDS.DIAGRAM]: showDiagram,
  };
  const visiblePanelOrder = getVisibleWorkspacePanelOrder(panelOrder, visibility);
  const resizeBoundaries = getWorkspaceResizeBoundaries(visiblePanelOrder);
  const resizeBoundaryByPair = new Map(resizeBoundaries.map((boundary) => [boundary.id, boundary]));
  const flexiblePanelId = getFlexibleWorkspacePanelId(visiblePanelOrder);
  const orderKey = panelOrder.join('-');

  const renderResizeHandle = (boundary) => {
    const settingsConfig = {
      ariaLabel: 'Redimensionner les réglages',
      panelClass: '.workspace-panel-slot--settings',
      cssVar: '--workspace-settings-panel-width',
      minWidth: SETTINGS_PANEL_WIDTH_MIN,
      maxWidth: SETTINGS_PANEL_WIDTH_MAX,
      value: settingsPanelWidth,
      defaultValue: SETTINGS_PANEL_WIDTH_DEFAULT,
      onResize: setSettingsPanelWidth,
    };
    const structureConfig = {
      ariaLabel: 'Redimensionner l’arbre',
      panelClass: '.workspace-panel-slot--structure',
      cssVar: '--col-left',
      minWidth: LEFT_PANEL_MIN_WIDTH,
      maxWidth: getTreePanelMaxWidth,
      value: treePanelWidth,
      defaultValue: TREE_PANEL_WIDTH_DEFAULT,
      onResize: setTreePanelWidth,
    };
    const config = boundary.resizedPanelId === WORKSPACE_PANEL_IDS.STRUCTURE
      ? structureConfig
      : settingsConfig;
    return <PanelResizeHandle {...config} direction={boundary.direction} />;
  };

  const renderPanelContent = (panelId, headerDragHandleProps) => {
    if (panelId === WORKSPACE_PANEL_IDS.STRUCTURE) {
      return renderStructurePanel(headerDragHandleProps);
    }
    if (panelId === WORKSPACE_PANEL_IDS.SETTINGS) {
      return renderSettingsPanel(headerDragHandleProps);
    }
    return renderDiagramPanel(isPlein ? 'plein' : 'colonne', headerDragHandleProps, orderKey);
  };

  // Composition pilotée par les identités : l'ordre visuel ne donne aucun rôle
  // métier aux panneaux. Les frontières sont recalculées pour chaque permutation.
  const workspaceClass = [
    'workspace',
    isPlein ? 'workspace--diagram-full' : '',
    showDiagram ? 'workspace--with-diagram' : '',
    !showDiagram ? 'workspace--without-diagram' : '',
  ].filter(Boolean).join(' ');
  const hasVisiblePanel = visiblePanelOrder.length > 0;

  return (
    <div className="screen visible">
      <div className={workspaceClass} style={style}>
        {!hasVisiblePanel ? (
          <WorkspaceEmptyState
            onShowTree={toggleTree}
            onShowSettings={toggleSettings}
            onShowDiagram={toggleDiagram}
          />
        ) : null}

        {hasVisiblePanel ? (
          <PanelSortContext items={visiblePanelOrder} onMove={movePanel}>
            {visiblePanelOrder.map((panelId, index) => {
              const nextPanelId = visiblePanelOrder[index + 1];
              const boundary = nextPanelId
                ? resizeBoundaryByPair.get(`${panelId}-${nextPanelId}`)
                : null;
              return (
                <Fragment key={panelId}>
                  <SortablePanelItem
                    id={panelId}
                    activation="header"
                    className={[
                      'workspace-panel-slot',
                      `workspace-panel-slot--${panelId}`,
                      panelId === flexiblePanelId ? 'is-flexible' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {({ dragHandleProps }) => renderPanelContent(panelId, dragHandleProps)}
                  </SortablePanelItem>
                  {boundary ? renderResizeHandle(boundary) : null}
                </Fragment>
              );
            })}
          </PanelSortContext>
        ) : null}

        <FloatingSimulator
          anchorId={simulationForCurrentProject ? simulatorAnchorId : null}
          zipPath={simulationForCurrentProject ? simulatorZipPath : null}
          documentGraph={simulation.graph}
          documentStartId={startStageForEntry(simulation.graph, simulatorAnchorId)}
          documentStatus={simulation.status}
          documentError={simulation.error}
          hostSelector=".workspace"
          layoutScope={EDITOR_LAYOUT_SCOPE.FREE}
          // Le simulateur désigne l'Écran qui joue ; l'arbre et le diagramme
          // attendent le nœud d'auteur. La projection porte la correspondance.
          onActiveNodeChange={handleSimulatorActiveNode}
          onClose={handleCloseSimulator}
        />
      </div>
    </div>
  );
}
