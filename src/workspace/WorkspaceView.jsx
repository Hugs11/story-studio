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
  pathAudit,
  validationIssues,
  allMenus,
  projectIndex,
  treeSearchFocusTrigger,
  onFocusTreeSearch,
  diagramView,
}) {
  const { onSelect } = useProjectActions();
  const { projectType } = project;
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const [simulatorZipPath, setSimulatorZipPath] = useState(null);
  const skipIdSyncRef = useRef(false);

  const {
    showTree,
    showSettings,
    showDiagram,
    isPlein,
    toggleTree,
    toggleSettings,
    toggleDiagram,
    maximizeDiagram,
    restoreSettings,
    closeDiagram,
    settingsPanelWidth,
    setSettingsPanelWidth,
    treePanelWidth,
    setTreePanelWidth,
  } = diagramView;

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

  const handleTreeSelectionChange = useCallback((ids) => {
    skipIdSyncRef.current = true;
    setSelectedIds(ids);
  }, []);

  const handleDiagramSelectionChange = useCallback((ids) => {
    skipIdSyncRef.current = true;
    setSelectedIds(ids);
    // En « plein » (diagramme seul), une sélection venue du diagramme réaffiche les
    // réglages pour éditer l'élément cliqué.
    if (isPlein && ids?.size > 0) {
      restoreSettings();
    }
  }, [isPlein, restoreSettings]);

  useEffect(() => {
    if (skipIdSyncRef.current) {
      skipIdSyncRef.current = false;
      return;
    }
    setSelectedIds(new Set([selectedId]));
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
      pathAudit={pathAudit}
      validationIssues={validationIssues}
      treeSearchFocusTrigger={treeSearchFocusTrigger}
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
      header={settingsHeader}
    />
  );

  // `key={variant}` : remonte le diagramme au passage plein↔colonne (Agrandir/Réduire)
  // pour le re-centrer sur la nouvelle largeur. `variant` suit
  // `showSettings`, pas `showTree` — donc pas de re-fit au simple masquage de l'arbre.
  const renderDiagramPanel = (variant) => (
    <DiagramPanel
      key={variant}
      project={project}
      projectType={projectType}
      projectIndex={projectIndex}
      selectedId={selectedId}
      selectedIds={selectedIds}
      onSelectionChange={handleDiagramSelectionChange}
      variant={variant}
      showActionsBar={showDiagram && !showTree}
      showHint={showDiagram && !showSettings}
      onMaximize={maximizeDiagram}
      onMinimize={restoreSettings}
      onClose={closeDiagram}
      onPreview={handleSimulateNode}
      onSimulateZip={handleSimulateZip}
      onSimulateRoot={handleSimulateRoot}
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
