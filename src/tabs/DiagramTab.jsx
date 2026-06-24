import { useState, useEffect, useRef, useCallback } from 'react';
import { FlowDiagram } from '../components/CentralPanel/FlowDiagram';

export function DiagramTab({
  project,
  projectType,
  projectIndex,
  selectedId,
  onSelect,
  onMoveToMenu,
  onUpdateRoot,
  onUpdateMedia,
  onUpdateStoryAudio,
  onUpdateMenu,
  onDeleteMenu,
  onUpdateItem,
  onDeleteItem,
  allMenus,
  allStories,
  inspectRequest,
  onImportStories,
  onImportFolder,
  onImportPodcast,
  onImportYoutube,
  onRecord,
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSetMenuAsRoot,
  onBulkUpdateItems,
  onBulkDeleteItems,
  onPasteEntries,
  onCutPasteEntries,
  onDuplicate,
  onAddEndNode,
  onRemoveEndNode,
  onUpdateNightModeAudio,
  onUpdateNightMode,
  onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const skipIdSyncRef = useRef(false);

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

  return (
    <div className="screen visible">
      <FlowDiagram
        project={project}
        projectType={projectType}
        allMenus={allMenus}
        allStories={allStories}
        projectIndex={projectIndex}
        selectedId={selectedId}
        selectedIds={selectedIds}
        inspectRequest={inspectRequest}
        onSelect={onSelect}
        onSelectionChange={handleSelectionChange}
        onMoveToMenu={onMoveToMenu}
        onUpdateRoot={onUpdateRoot}
        onUpdateMedia={onUpdateMedia}
        onUpdateStoryAudio={onUpdateStoryAudio}
        onUpdateMenu={onUpdateMenu}
        onDeleteMenu={onDeleteMenu}
        onUpdateItem={onUpdateItem}
        onDeleteItem={onDeleteItem}
        onImportStories={onImportStories}
        onImportFolder={onImportFolder}
        onImportPodcast={onImportPodcast}
        onImportYoutube={onImportYoutube}
        onRecord={onRecord}
        onAddMenu={onAddMenu}
        onAddStory={onAddStory}
        onUnpackZip={onUnpackZip}
        onSetMenuAsRoot={onSetMenuAsRoot}
        onBulkUpdateItems={onBulkUpdateItems}
        onBulkDeleteItems={onBulkDeleteItems}
        onPasteEntries={onPasteEntries}
        onCutPasteEntries={onCutPasteEntries}
        onDuplicate={onDuplicate}
        onAddEndNode={onAddEndNode}
        onRemoveEndNode={onRemoveEndNode}
        onUpdateNightModeAudio={onUpdateNightModeAudio}
        onUpdateNightMode={onUpdateNightMode}
        onUpdateNightModeReturn={onUpdateNightModeReturn}
        onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
        displayMode="screen"
      />
    </div>
  );
}
