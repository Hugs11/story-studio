import { useCallback, useMemo, useState } from 'react';
import { TreePanel } from '../TreePanel/TreePanel';
import { TreeDisplayPopover } from '../TreePanel/TreeDisplayPopover';
import { KEYS } from '../../store/persistentSettings';
import { useProjectActions } from '../../store/ProjectActionsContext';
import { usePersistentState } from '../../hooks/usePersistentState';
import { StructureActionsBar, StructureSearchButton } from './StructureActionsBar';

const BOOL_CODEC = {
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
};

const NAVIGATION_BADGES_CODEC = {
  decode: (value) => value !== 'false',
  encode: (value) => (value ? 'true' : 'false'),
};

function useStructureNodeColor() {
  const { onUpdateMedia, onUpdateMenu, onUpdateItem } = useProjectActions();

  return useCallback((nodeId, nodeType, color) => {
    const fields = { treeColor: color };
    if (nodeType === 'root') {
      onUpdateMedia('treeColor', color);
    } else if (nodeType === 'menu') {
      onUpdateMenu(fields, nodeId);
    } else {
      onUpdateItem(fields, nodeId);
    }
  }, [onUpdateMedia, onUpdateMenu, onUpdateItem]);
}

export function StructurePanel({
  canvasActionsAvailable = false,
  project,
  projectType,
  selectedId,
  selectedIds,
  projectIndex,
  validationIssues,
  treeSearchFocusTrigger,
  selectionRevealRequest,
  hoveredNodeId,
  onNodeHoverChange,
  onSelectNode,
  onSelectionChange,
  onFocusTreeSearch,
  onSimulateNode,
  onSimulateZip,
  onSimulateRoot,
  headerDragHandleProps = {},
}) {
  const {
    onSelect, onReorder, onMoveToMenu,
    onAddMenu, onAddStoryToMenu, onImportFolder, onUnpackZip,
    onImportPodcast, onImportYoutube, onRecord, onGenerateStoryTts, canRecord, canGenerateStoryTts,
    onDeleteMenu, onDeleteItem, onBulkUpdateItems, onBulkDeleteItems,
    onUpdateMenu, onUpdateItem,
    onSetMenuAsRoot, onDemoteRootToMenu, onDuplicate, onPasteEntries, onCutPasteEntries,
    onAddEndNode, onRemoveEndNode, onOpenMediaAudioTool,
  } = useProjectActions();
  const handleRenameNode = useCallback((nodeId, nodeType, fields) => {
    if (nodeType === 'menu') onUpdateMenu(fields, nodeId);
    else if (nodeType === 'story') onUpdateItem(fields, nodeId);
  }, [onUpdateItem, onUpdateMenu]);
  const handleSetNodeColor = useStructureNodeColor();
  const [treeDisplayOpen, setTreeDisplayOpen] = useState(false);
  const [showNavigationBadges, setShowNavigationBadges] = usePersistentState(
    KEYS.TREE_SHOW_DEFAULT_NAVIGATION_BADGES,
    true,
    NAVIGATION_BADGES_CODEC,
  );
  const [showTreeGuides, setShowTreeGuides] = usePersistentState(KEYS.TREE_SHOW_GUIDES, true, BOOL_CODEC);

  const structureActionTargetMenuId = useMemo(() => {
    if (projectType !== 'pack' || !selectedId || selectedId === 'root') return null;
    const entry = projectIndex.entryById.get(selectedId);
    if (entry?.type === 'menu') return selectedId;
    return projectIndex.parentMenuById.get(selectedId) ?? null;
  }, [projectIndex, projectType, selectedId]);

  return (
    <div className="structure-panel">
      {projectType === 'pack' ? (
        <div className="structure-panel-header structure-panel-header--actions" {...headerDragHandleProps}>
          <StructureActionsBar
            variant="panel"
            targetMenuId={structureActionTargetMenuId}
            onAddStory={canvasActionsAvailable ? null : onAddStoryToMenu}
            onAddFolder={canvasActionsAvailable ? null : onAddMenu}
            onImportFolder={canvasActionsAvailable ? null : onImportFolder}
            onImportPodcast={canvasActionsAvailable ? null : onImportPodcast}
            onImportYoutube={canvasActionsAvailable ? null : onImportYoutube}
            onRecord={canvasActionsAvailable ? null : onRecord}
            onGenerateStoryTts={canvasActionsAvailable ? null : onGenerateStoryTts}
            canRecord={canRecord}
            canGenerateStoryTts={canGenerateStoryTts}
            onLaunchSimulator={canvasActionsAvailable ? null : onSimulateRoot}
            trailing={(
              <>
                <StructureSearchButton
                  onClick={() => {
                    setTreeDisplayOpen(false);
                    onFocusTreeSearch?.();
                  }}
                />
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
        <div className="structure-panel-header structure-panel-header--empty" {...headerDragHandleProps} />
      )}
      <TreePanel
        project={project}
        projectType={projectType}
        showNavigationBadges={showNavigationBadges}
        showTreeGuides={showTreeGuides}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={onSelectNode ?? onSelect}
        onSelectionChange={onSelectionChange}
        selectionRevealRequest={selectionRevealRequest}
        hoveredNodeId={hoveredNodeId}
        onNodeHoverChange={onNodeHoverChange}
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
        onRenameNode={handleRenameNode}
        onAddEndNode={onAddEndNode}
        onRemoveEndNode={onRemoveEndNode}
        onSimulateNode={onSimulateNode}
        onOpenMediaAudioTool={onOpenMediaAudioTool}
        validationIssues={validationIssues}
        projectIndex={projectIndex}
        treeSearchFocusTrigger={treeSearchFocusTrigger}
      />
    </div>
  );
}
