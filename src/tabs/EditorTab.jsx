import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { TreePanel } from '../components/TreePanel/TreePanel';
import { TreeDisplayPopover } from '../components/TreePanel/TreeDisplayPopover';
import { CentralPanel } from '../components/CentralPanel/CentralPanel';
import { ModeSelector } from '../components/ModeSelector/ModeSelector';
import { FloatingSimulator } from '../components/FloatingSimulator/FloatingSimulator';
import { StructureActionsBar } from '../components/structure/StructureActionsBar';
import { Tooltip } from '../components/common/Tooltip';
import { Search } from '../components/icons/LucideLocal';
import { LuniiIcon } from '../components/icons/LuniiIcon';
import { KEYS } from '../store/persistentSettings';
import { usePersistentState } from '../hooks/usePersistentState';

const BOOL_CODEC = {
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
};

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
  onAddStoryToMenu, onImportFolder, onUnpackZip,
  onImportPodcast, onRecord, canRecord = true,
  onPasteEntries, onCutPasteEntries, onSetMenuAsRoot, onDemoteRootToMenu, onDuplicate,
  onAddEndNode, onRemoveEndNode, onUpdateNightModeAudio, onUpdateNightMode, onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  pathAudit, validationIssues, allMenus, projectIndex,
  treeSearchFocusTrigger,
  onFocusTreeSearch,
  showCentralDiagram,
}) {
  const { projectType } = project;
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const [simulatorAnchorId, setSimulatorAnchorId] = useState(null);
  const [simulatorZipPath, setSimulatorZipPath] = useState(null);
  const [treeDisplayOpen, setTreeDisplayOpen] = useState(false);
  const [showNavigationBadges, setShowNavigationBadges] = usePersistentState(
    KEYS.TREE_SHOW_DEFAULT_NAVIGATION_BADGES,
    true,
    {
      decode: (value) => value !== 'false',
      encode: (value) => (value ? 'true' : 'false'),
    },
  );
  const [showTreeGuides, setShowTreeGuides] = usePersistentState(KEYS.TREE_SHOW_GUIDES, true, BOOL_CODEC);
  const skipIdSyncRef = useRef(false);

  const structureActionTargetMenuId = useMemo(() => {
    if (projectType !== 'pack' || !selectedId || selectedId === 'root') return null;
    const entry = projectIndex.entryById.get(selectedId);
    if (entry?.type === 'menu') return selectedId;
    return projectIndex.parentMenuById.get(selectedId) ?? null;
  }, [projectIndex, projectType, selectedId]);

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
          {projectType === 'pack' ? (
            <div className="panel-left-header panel-left-header--actions">
              <StructureActionsBar
                variant="panel"
                targetMenuId={structureActionTargetMenuId}
                onAddStory={onAddStoryToMenu}
                onAddFolder={onAddMenu}
                onImportFolder={onImportFolder}
                onImportPodcast={onImportPodcast}
                onRecord={onRecord}
                canRecord={canRecord}
                trailing={(
                  <>
                    <Tooltip text="Rechercher dans la structure (Ctrl+F)" placement="below">
                      <button
                        type="button"
                        className="tree-display-trigger tree-search-trigger"
                        aria-label="Rechercher dans la structure"
                        onClick={() => {
                          setTreeDisplayOpen(false);
                          onFocusTreeSearch?.();
                        }}
                      >
                        <Search className="tree-display-trigger-icon" strokeWidth={2.15} absoluteStrokeWidth />
                      </button>
                    </Tooltip>
                    <Tooltip text="Lancer le simulateur" placement="below">
                      <button
                        type="button"
                        className="tree-display-trigger"
                        aria-label="Lancer le simulateur"
                        onClick={handleSimulateRoot}
                      >
                        <LuniiIcon className="tree-display-trigger-icon tree-display-trigger-icon--lunii" />
                      </button>
                    </Tooltip>
                    <TreeDisplayPopover
                      open={treeDisplayOpen}
                      onOpenChange={setTreeDisplayOpen}
                      showNavigationBadges={showNavigationBadges}
                      onShowNavigationBadgesChange={setShowNavigationBadges}
                      showGuides={showTreeGuides}
                      onShowGuidesChange={setShowTreeGuides}
                    />
                  </>
                )}
              />
            </div>
          ) : null}
          {projectType === 'pack' ? null : (
            <div className="panel-left-header panel-left-header--empty" aria-hidden="true" />
          )}
          <TreePanel
            project={project}
            projectType={projectType}
            showNavigationBadges={showNavigationBadges}
            showTreeGuides={showTreeGuides}
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
            onSimulateZip={handleSimulateZip}
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
          zipPath={simulatorZipPath}
          hostSelector=".workspace"
          onActiveNodeChange={onSelect}
          onClose={handleCloseSimulator}
        />
      </div>
    </div>
  );
}
