import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { DiagramPanel } from '../components/diagram/DiagramPanel';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { StructurePanel } from '../components/structure/StructurePanel';
import {
  LEFT_PANEL_MIN_WIDTH,
} from '../components/structure/panelResize';
import { PanelResizeHandle } from '../components/structure/PanelResizeHandle';
import { useProjectActions } from '../store/ProjectActionsContext';
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

export function WorkspaceView({
  project,
  node,
  selectedId,
  onSetProjectType,
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
}) {
  const { onSelect } = useProjectActions();
  const { projectType } = project;
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [afterPlayFocus, setAfterPlayFocus] = useState(null);
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const [simulatorZipPath, setSimulatorZipPath] = useState(null);
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
    if (projectType !== null) return;
    setExpandedDiagramStoryGroupIds((current) => (current.size > 0 ? new Set() : current));
  }, [projectType]);

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
    setSimulatorZipPath(null);
    setSimulatorAnchorId(nodeId);
  }, []);

  const handleSimulateRoot = useCallback(() => {
    handleSimulateNode('root');
  }, [handleSimulateNode]);

  const handleSimulateZip = useCallback((zipPath) => {
    setSimulatorAnchorId(null);
    setSimulatorZipPath(zipPath);
  }, []);

  const handleCloseSimulator = useCallback(() => {
    setSimulatorAnchorId(null);
    setSimulatorZipPath(null);
  }, []);

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

  const handleTreeSelectionChange = commitSelectionChange;

  const handleDiagramSelectionChange = useCallback((ids) => {
    commitSelectionChange(ids);
    // En « plein » (diagramme seul), une sélection venue du diagramme réaffiche les
    // réglages pour éditer l'élément cliqué.
    if (isPlein && ids?.size > 0) {
      restoreSettings();
    }
  }, [commitSelectionChange, isPlein, restoreSettings]);

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
      showActionsBar={showDiagram && !showTree}
      showHint={showDiagram && !showSettings}
      onClose={closeDiagram}
      onPreview={handleSimulateNode}
      onSimulateZip={handleSimulateZip}
      onSimulateRoot={handleSimulateRoot}
      onOpenLocalEndSettings={handleOpenLocalEndSettings}
      headerDragHandleProps={headerDragHandleProps}
    />
  );

  if (projectType === null) {
    return (
      <div className="screen visible">
        <div className="workspace workspace--home">
          <ModeSelector
            onSelect={onSetProjectType}
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
          project={project}
          anchorId={simulatorAnchorId}
          zipPath={simulatorZipPath}
          hostSelector=".workspace"
          onActiveNodeChange={handleSimulatorActiveNodeChange}
          onClose={handleCloseSimulator}
        />
      </div>
    </div>
  );
}
