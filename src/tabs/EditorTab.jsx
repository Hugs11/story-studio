import { useState, useEffect, useRef, useCallback } from 'react';
import { TreePanel } from '../components/TreePanel/TreePanel';
import { CentralPanel } from '../components/CentralPanel/CentralPanel';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';

function startResize(e, panelClass, cssVar, direction) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = document.querySelector(panelClass)?.clientWidth ?? 260;
  const onMove = ev => {
    const delta = direction === 1 ? ev.clientX - startX : startX - ev.clientX;
    const newW = Math.max(150, Math.min(window.innerWidth * 0.42, startW + delta));
    document.documentElement.style.setProperty(cssVar, `${newW}px`);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

export function EditorTab({
  node,
  project, selectedId, onSelect,
  onReorder, onMoveToMenu, onAddMenu, onAddStory,
  onUpdateRoot, onUpdateMedia, onUpdateStoryAudio, onSetProjectType, onOpenProject,
  onOpenPreferences, recentProjects, onOpenRecentProject,
  onUpdateMenu, onDeleteMenu,
  onUpdateItem, onDeleteItem, onBulkUpdateItems, onBulkDeleteItems,
  onAddStoryToMenu, onImportFolder, onUnpackZip, onSimulateZip,
  onPasteEntries, onCutPasteEntries, onSetMenuAsRoot, onDemoteRootToMenu, onDuplicate,
  onAddEndNode, onRemoveEndNode, onUpdateNightModeAudio, onUpdateNightMode, onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  pathAudit, validationIssues, allMenus, projectIndex,
  treeSearchFocusTrigger,
  showCentralDiagram,
}) {
  const { projectType } = project;
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const skipIdSyncRef = useRef(false);

  const handleSimulateNode = useCallback((nodeId) => {
    setSimulatorAnchorId(nodeId);
  }, []);

  const handleCloseSimulator = useCallback(() => {
    setSimulatorAnchorId(null);
  }, []);

  const handleSelectionChange = useCallback((ids) => {
    skipIdSyncRef.current = true;
    setSelectedIds(ids);
  }, []);

  const handleSetNodeColor = useCallback((nodeId, nodeType, color) => {
    const fields = { treeColor: color };
    if (nodeType === 'root') {
      onUpdateMedia('treeColor', color);
    } else if (nodeType === 'menu') {
      onUpdateMenu(fields, nodeId);
    } else {
      onUpdateItem(fields, nodeId);
    }
  }, [onUpdateMedia, onUpdateMenu, onUpdateItem]);

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
            onOpen={onOpenProject}
            onOpenPreferences={onOpenPreferences}
            recentProjects={recentProjects}
            onOpenRecent={onOpenRecentProject}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="screen visible">
      <div className="workspace">
        <div className="panel-left">
          <div className="panel-left-header">
            <span>Structure</span>
          </div>
          <TreePanel
            project={project}
            projectType={projectType}
            selectedId={selectedId}
            onSelect={onSelect}
            onSelectionChange={handleSelectionChange}
            onReorder={onReorder}
            onMoveToMenu={onMoveToMenu}
            onAddMenu={onAddMenu}
            onAddStory={onAddStoryToMenu}
            onImportFolder={onImportFolder}
            onDeleteMenu={onDeleteMenu}
            onDeleteItem={onDeleteItem}
            onBulkDeleteItems={onBulkDeleteItems}
            onBulkUpdateItems={onBulkUpdateItems}
            onUnpackZip={onUnpackZip}
            onSimulateZip={onSimulateZip}
            onPasteEntries={onPasteEntries}
            onCutPasteEntries={onCutPasteEntries}
            onSetMenuAsRoot={onSetMenuAsRoot}
            onDemoteRootToMenu={onDemoteRootToMenu}
            onDuplicate={onDuplicate}
            onSetNodeColor={handleSetNodeColor}
            onAddEndNode={onAddEndNode}
            onRemoveEndNode={onRemoveEndNode}
            onSimulateNode={handleSimulateNode}
            pathAudit={pathAudit}
            validationIssues={validationIssues}
            projectIndex={projectIndex}
            treeSearchFocusTrigger={treeSearchFocusTrigger}
          />
        </div>

        <div className="resize-handle" onMouseDown={e => startResize(e, '.panel-left', '--col-left', 1)} />

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
          onImportStories={onAddStory}
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
          hostSelector=".workspace"
          onActiveNodeChange={onSelect}
          onClose={handleCloseSimulator}
        />
      </div>
    </div>
  );
}
