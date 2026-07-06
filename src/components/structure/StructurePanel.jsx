import { useCallback, useMemo, useState } from 'react';
import { TreePanel } from '../TreePanel/TreePanel';
import { TreeDisplayPopover } from '../TreePanel/TreeDisplayPopover';
import { Tooltip } from '../common/Tooltip';
import { Search } from '../icons/LucideLocal';
import { LuniiIcon } from '../icons/LuniiIcon';
import { KEYS } from '../../store/persistentSettings';
import { useProjectActions } from '../../store/ProjectActionsContext';
import { usePersistentState } from '../../hooks/usePersistentState';
import { StructureActionsBar } from './StructureActionsBar';

const BOOL_CODEC = {
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
};

const NAVIGATION_BADGES_CODEC = {
  decode: (value) => value !== 'false',
  encode: (value) => (value ? 'true' : 'false'),
};

export function useStructureNodeColor() {
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
  project,
  projectType,
  selectedId,
  projectIndex,
  pathAudit,
  validationIssues,
  treeSearchFocusTrigger,
  onSelectionChange,
  onFocusTreeSearch,
  onSimulateNode,
  onSimulateZip,
  onSimulateRoot,
}) {
  const {
    onSelect, onReorder, onMoveToMenu,
    onAddMenu, onAddStoryToMenu, onImportFolder, onUnpackZip,
    onImportPodcast, onImportYoutube, onRecord, onGenerateStoryTts, canRecord, canGenerateStoryTts,
    onDeleteMenu, onDeleteItem, onBulkUpdateItems, onBulkDeleteItems,
    onSetMenuAsRoot, onDemoteRootToMenu, onDuplicate, onPasteEntries, onCutPasteEntries,
    onAddEndNode, onRemoveEndNode,
  } = useProjectActions();
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
            onImportYoutube={onImportYoutube}
            onRecord={onRecord}
            onGenerateStoryTts={onGenerateStoryTts}
            canRecord={canRecord}
            canGenerateStoryTts={canGenerateStoryTts}
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
                    onClick={onSimulateRoot}
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
        onSelectionChange={onSelectionChange}
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
        onSimulateNode={onSimulateNode}
        pathAudit={pathAudit}
        validationIssues={validationIssues}
        projectIndex={projectIndex}
        treeSearchFocusTrigger={treeSearchFocusTrigger}
      />
    </div>
  );
}
