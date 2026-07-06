import { useState, useEffect, useRef, useCallback } from 'react';
import { FlowDiagram } from '../components/CentralPanel/FlowDiagram';

export function DiagramTab({
  project,
  projectType,
  projectIndex,
  selectedId,
  allMenus,
  allStories,
  inspectRequest,
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
        onSelectionChange={handleSelectionChange}
      />
    </div>
  );
}
