import { useCallback, useEffect, useRef, useState } from 'react';
import { CentralPanel } from '../components/CentralPanel/CentralPanel';
import { DiagramPanel } from '../components/CentralPanel/DiagramPanel';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { StructurePanel } from '../components/structure/StructurePanel';
import {
  LEFT_PANEL_MIN_WIDTH,
  startResize,
} from '../components/structure/panelResize';
import { useProjectActions } from '../store/ProjectActionsContext';
import {
  DIAGRAM_COLUMN_WIDTH_MAX,
  DIAGRAM_COLUMN_WIDTH_MIN,
  getTreePanelMaxWidth,
} from './useDiagramViewState';
import { SettingsPanelHeader } from './SettingsPanelHeader';

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
    isColonne,
    isPlein,
    maximizeDiagram,
    restoreSettings,
    closeDiagram,
    diagramColumnWidth,
    setDiagramColumnWidth,
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
    '--workspace-diagram-column-width': `${diagramColumnWidth}px`,
  };

  const settingsHeader = (
    <SettingsPanelHeader
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
    />
  );

  const renderStructurePanel = () => (
    <StructurePanel
      project={project}
      projectType={projectType}
      selectedId={selectedId}
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
    <div
      className="resize-handle"
      onMouseDown={(event) => startResize(
        event,
        '.panel-left',
        '--col-left',
        1,
        LEFT_PANEL_MIN_WIDTH,
        {
          maxWidth: getTreePanelMaxWidth,
          onResize: setTreePanelWidth,
        },
      )}
    />
  );

  const renderCentralPanel = ({ withHeader = false } = {}) => (
    <CentralPanel
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      projectType={projectType}
      allMenus={allMenus}
      projectIndex={projectIndex}
      header={withHeader ? settingsHeader : null}
    />
  );

  // `key={variant}` : remonte le diagramme au passage plein↔colonne (Agrandir/Réduire)
  // pour le re-centrer sur la nouvelle largeur (comportement vague 1). `variant` suit
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

  const renderDiagramResizeHandle = () => (
    <div
      className="resize-handle"
      onMouseDown={(event) => startResize(
        event,
        '.workspace-diagram-column',
        '--workspace-diagram-column-width',
        -1,
        DIAGRAM_COLUMN_WIDTH_MIN,
        {
          maxWidth: DIAGRAM_COLUMN_WIDTH_MAX,
          onResize: setDiagramColumnWidth,
        },
      )}
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

  // Composition « 3 bascules » : arbre (fixe) · réglages (flex) · diagramme (colonne
  // fixe si réglages visibles, plein sinon). La poignée arbre ne s'affiche que si un
  // panneau la suit (réglages ou diagramme) ; la poignée du milieu, qu'en « colonne ».
  const workspaceClass = [
    'workspace',
    isPlein ? 'workspace--diagram-full' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="screen visible">
      <div className={workspaceClass} style={style}>
        {showTree ? renderStructurePanel() : null}

        {showTree && (showSettings || showDiagram) ? renderTreeResizeHandle() : null}

        {showSettings ? renderCentralPanel({ withHeader: isColonne }) : null}

        {showSettings && showDiagram ? renderDiagramResizeHandle() : null}

        {showDiagram ? (
          <div className={isPlein ? 'workspace-diagram-full' : 'workspace-diagram-column'}>
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
