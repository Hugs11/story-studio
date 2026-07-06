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
  DIAGRAM_LEFT_SLOTS,
  DIAGRAM_VIEW_STATES,
  SETTINGS_SLOT_WIDTH_MAX,
  SETTINGS_SLOT_WIDTH_MIN,
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
    state,
    leftSlot,
    maximize,
    minimize,
    closeDiagram,
    setLeftSlot,
    forceLeftSlot,
    diagramColumnWidth,
    setDiagramColumnWidth,
    settingsSlotWidth,
    setSettingsSlotWidth,
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
    if (state === DIAGRAM_VIEW_STATES.FULL && ids?.size > 0) {
      forceLeftSlot(DIAGRAM_LEFT_SLOTS.SETTINGS);
    }
  }, [forceLeftSlot, state]);

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
    '--workspace-settings-slot-width': `${settingsSlotWidth}px`,
  };

  const settingsHeader = (closable = false) => (
    <SettingsPanelHeader
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      onClose={closable ? () => forceLeftSlot(DIAGRAM_LEFT_SLOTS.TREE) : null}
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

  const renderCentralPanel = ({ withHeader = false, headerClosable = false } = {}) => (
    <CentralPanel
      node={node}
      selectedId={selectedId}
      selectedIds={selectedIds}
      project={project}
      projectType={projectType}
      allMenus={allMenus}
      projectIndex={projectIndex}
      header={withHeader ? settingsHeader(headerClosable) : null}
    />
  );

  const renderDiagramPanel = (variant) => (
    <DiagramPanel
      project={project}
      projectType={projectType}
      projectIndex={projectIndex}
      selectedId={selectedId}
      selectedIds={selectedIds}
      onSelectionChange={handleDiagramSelectionChange}
      variant={variant}
      leftSlot={leftSlot}
      onLeftSlotChange={setLeftSlot}
      onMaximize={maximize}
      onMinimize={minimize}
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

  const renderSettingsResizeHandle = () => (
    <div
      className="resize-handle"
      onMouseDown={(event) => startResize(
        event,
        '.workspace-settings-slot',
        '--workspace-settings-slot-width',
        1,
        SETTINGS_SLOT_WIDTH_MIN,
        {
          maxWidth: SETTINGS_SLOT_WIDTH_MAX,
          onResize: setSettingsSlotWidth,
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

  const isColumn = state === DIAGRAM_VIEW_STATES.COLUMN;
  const isFull = state === DIAGRAM_VIEW_STATES.FULL;
  const workspaceClass = [
    'workspace',
    isColumn ? 'workspace--diagram-column' : '',
    isFull ? 'workspace--diagram-full' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="screen visible">
      <div className={workspaceClass} style={style}>
        {!isFull ? (
          <>
            {renderStructurePanel()}
            {renderTreeResizeHandle()}
            {renderCentralPanel({ withHeader: isColumn })}
            {isColumn ? (
              <>
                {renderDiagramResizeHandle()}
                <div className="workspace-diagram-column">
                  {renderDiagramPanel("colonne")}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            {leftSlot === DIAGRAM_LEFT_SLOTS.TREE ? (
              <>
                {renderStructurePanel()}
                {renderTreeResizeHandle()}
              </>
            ) : null}
            {leftSlot === DIAGRAM_LEFT_SLOTS.SETTINGS ? (
              <>
                <div className="workspace-settings-slot">
                  {renderCentralPanel({ withHeader: true, headerClosable: true })}
                </div>
                {renderSettingsResizeHandle()}
              </>
            ) : null}
            <div className="workspace-diagram-full">
              {renderDiagramPanel("plein")}
            </div>
          </>
        )}

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
