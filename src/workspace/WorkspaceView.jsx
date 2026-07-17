import { useCallback, useEffect, useRef, useState } from 'react';
import { CentralPanel } from '../components/CentralPanel/CentralPanel';
import { DiagramPanel } from '../components/CentralPanel/DiagramPanel';
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
} from './useDiagramViewState';
import { SettingsPanelHeader } from './SettingsPanelHeader';
import {
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
  diagramView,
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
    isPlein,
    toggleTree,
    toggleSettings,
    toggleDiagram,
    restoreSettings,
    closeDiagram,
    settingsPanelWidth,
    setSettingsPanelWidth,
    treePanelWidth,
    setTreePanelWidth,
  } = diagramView;

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

  // Réglages = colonne centrale dockée : son en-tête est systématique dès que
  // Réglages est visible, avec un fermeur utilisable dans tous les états.
  const settingsHeader = (
    <SettingsPanelHeader
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      onClose={toggleSettings}
    />
  );

  const renderStructurePanel = () => (
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
    />
  );

  const renderTreeResizeHandle = () => (
    <PanelResizeHandle
      ariaLabel="Redimensionner l’arbre"
      panelClass=".panel-left"
      cssVar="--col-left"
      minWidth={LEFT_PANEL_MIN_WIDTH}
      maxWidth={getTreePanelMaxWidth}
      value={treePanelWidth}
      defaultValue={TREE_PANEL_WIDTH_DEFAULT}
      onResize={setTreePanelWidth}
    />
  );

  const renderCentralPanel = () => (
    <CentralPanel
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      projectType={projectType}
      allMenus={allMenus}
      projectIndex={projectIndex}
      afterPlayFocus={afterPlayFocus}
      onAfterPlayFocusConsumed={handleAfterPlayFocusConsumed}
      header={settingsHeader}
    />
  );

  // `key={variant}` : remonte le diagramme au passage plein↔colonne via la
  // bascule Réglages, pour le re-centrer sur la nouvelle largeur. `variant` suit
  // `showSettings`, pas `showTree` — donc pas de re-fit au simple masquage de l'arbre.
  const renderDiagramPanel = (variant) => (
    <DiagramPanel
      key={variant}
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
    />
  );

  const renderSettingsResizeHandle = () => (
    <PanelResizeHandle
      ariaLabel="Redimensionner les réglages"
      panelClass=".panel-center"
      cssVar="--workspace-settings-panel-width"
      minWidth={SETTINGS_PANEL_WIDTH_MIN}
      maxWidth={SETTINGS_PANEL_WIDTH_MAX}
      value={settingsPanelWidth}
      defaultValue={SETTINGS_PANEL_WIDTH_DEFAULT}
      onResize={setSettingsPanelWidth}
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

  // Composition « 3 bascules » : arbre (fixe) · réglages (colonne plafonnée) ·
  // diagramme (flex). Chaque poignée déplace la frontière qu'elle matérialise.
  const workspaceClass = [
    'workspace',
    isPlein ? 'workspace--diagram-full' : '',
    showDiagram ? 'workspace--with-diagram' : '',
    !showDiagram ? 'workspace--without-diagram' : '',
    !showDiagram && !showSettings && showTree ? 'workspace--tree-only' : '',
  ].filter(Boolean).join(' ');
  const hasVisiblePanel = showTree || showSettings || showDiagram;

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

        {showTree ? renderStructurePanel() : null}

        {showTree && (showSettings || showDiagram) ? renderTreeResizeHandle() : null}

        {showSettings ? renderCentralPanel() : null}

        {showSettings && showDiagram ? renderSettingsResizeHandle() : null}

        {showDiagram ? (
          <div className="workspace-diagram">
            {renderDiagramPanel(isPlein ? 'plein' : 'colonne')}
          </div>
        ) : null}

        <FloatingSimulator
          project={project}
          anchorId={simulatorAnchorId}
          zipPath={simulatorZipPath}
          hostSelector=".workspace"
          onActiveNodeChange={onSelect}
          onClose={handleCloseSimulator}
        />
      </div>
    </div>
  );
}
