import { useState, useEffect, useRef, useCallback } from 'react';
import { CentralPanel } from '../components/CentralPanel/CentralPanel';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';
import { StructurePanel, useStructureNodeColor } from '../components/structure/StructurePanel';
import { LEFT_PANEL_MIN_WIDTH, startResize } from '../components/structure/panelResize';
import { useProjectActions } from '../store/ProjectActionsContext';

export function EditorTab({
  node,
  project, selectedId,
  onSetProjectType, onEditPack, onPodcastFunnel, onYoutubeFunnel, onAggregatePacks, onCheckPack, onOpenProject,
  onOpenPreferences, recentProjects, onOpenRecentProject,
  pendingSimulateZipPath = null, onSimulateConsumed,
  sessionRecoveries = [], onRecoverSession, onIgnoreSessionRecovery,
  pathAudit, validationIssues, allMenus, projectIndex,
  treeSearchFocusTrigger,
  onFocusTreeSearch,
  showCentralDiagram,
}) {
  // Actions projet partagées avec DiagramTab : fournies par App via
  // ProjectActionsContext plutôt que re-câblées en props sur chaque surface.
  const {
    onSelect, onMoveToMenu,
    onImportStories,
    onUpdateRoot, onUpdateMedia, onUpdateStoryAudio,
    onUpdateMenu, onDeleteMenu, onUpdateItem, onDeleteItem, onBulkUpdateItems, onBulkDeleteItems,
    onRemoveEndNode,
    onUpdateNightModeAudio, onUpdateNightMode, onUpdateNightModeReturn, onUpdateNightModeHomeReturn,
  } = useProjectActions();
  const { projectType } = project;
  const handleSetNodeColor = useStructureNodeColor();
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const [simulatorZipPath, setSimulatorZipPath] = useState(null);
  const skipIdSyncRef = useRef(false);

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

  // « Modifier un pack » non éditable (plan 04) : ouvre le simulateur ZIP dès que
  // l'éditeur est monté avec le pack demandé.
  useEffect(() => {
    if (!pendingSimulateZipPath || projectType == null) return;
    handleSimulateZip(pendingSimulateZipPath);
    onSimulateConsumed?.();
  }, [pendingSimulateZipPath, projectType, handleSimulateZip, onSimulateConsumed]);

  const handleSelectionChange = useCallback((ids) => {
    skipIdSyncRef.current = true;
    setSelectedIds(ids);
  }, []);

  useEffect(() => {
    if (skipIdSyncRef.current) {
      skipIdSyncRef.current = false;
      return;
    }
    setSelectedIds(new Set([selectedId]));
  }, [selectedId]);

  // Mode non choisi → écran de sélection plein écran
  if (projectType === null) {
    return (
      <div className="screen visible">
        <div className="workspace" style={{ justifyContent: 'center' }}>
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

  return (
    <div className="screen visible">
      <div className="workspace">
        <StructurePanel
          project={project}
          projectType={projectType}
          selectedId={selectedId}
          projectIndex={projectIndex}
          pathAudit={pathAudit}
          validationIssues={validationIssues}
          treeSearchFocusTrigger={treeSearchFocusTrigger}
          onSelectionChange={handleSelectionChange}
          onFocusTreeSearch={onFocusTreeSearch}
          onSimulateNode={handleSimulateNode}
          onSimulateZip={handleSimulateZip}
          onSimulateRoot={handleSimulateRoot}
        />

        <div className="resize-handle" onMouseDown={e => startResize(e, '.panel-left', '--col-left', 1, LEFT_PANEL_MIN_WIDTH)} />

        <CentralPanel
          node={node}
          selectedId={selectedId}
          selectedIds={selectedIds}
          project={project}
          projectType={projectType}
          allMenus={allMenus}
          projectIndex={projectIndex}
          onSelect={onSelect}
          onMoveToMenu={onMoveToMenu}
          onUpdateRoot={onUpdateRoot}
          onUpdateMedia={onUpdateMedia}
          onUpdateStoryAudio={onUpdateStoryAudio}
          onUpdateMenu={onUpdateMenu}
          onDeleteMenu={onDeleteMenu}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
          onBulkUpdateItems={onBulkUpdateItems}
          onBulkDeleteItems={onBulkDeleteItems}
          onSetNodeColor={handleSetNodeColor}
          onImportStories={onImportStories}
          onUpdateNightModeAudio={onUpdateNightModeAudio}
          onUpdateNightMode={onUpdateNightMode}
          onUpdateNightModeReturn={onUpdateNightModeReturn}
          onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
          onRemoveEndNode={onRemoveEndNode}
          showCentralDiagram={showCentralDiagram}
        />

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
