import { useState } from 'react';
import { Search, X } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { CompleteDiagramTree } from './FullDiagramTree';
import './FlowDiagram.css';

function IconButton({ label, onClick, active = false, children }) {
  return (
    <Tooltip text={label}>
      <button
        type="button"
        className={`fd-panel-icon-btn ${active ? 'is-active' : ''}`}
        aria-label={label}
        aria-pressed={active || undefined}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function DiagramPanelHeader({
  variant,
  onClose,
  onSearch,
  controlsHostRef,
}) {
  const isFull = variant === 'plein';

  return (
    <div className="fd-panel-header">
      <div className="fd-panel-title" title={isFull ? 'Diagramme complet du pack' : 'Diagramme'}>
        {isFull ? 'Diagramme complet du pack' : 'Diagramme'}
      </div>
      <div className="fd-panel-view-controls" ref={controlsHostRef} />
      <div className="fd-panel-window-controls">
        <IconButton label="Rechercher dans le diagramme (Ctrl+F)" onClick={onSearch}>
          <Search aria-hidden="true" />
        </IconButton>
        <IconButton label="Fermer le diagramme" onClick={onClose}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

export function DiagramPanel({
  project,
  projectType,
  projectIndex,
  selectedId = 'root',
  selectedIds,
  onSelectNode,
  onSelectionChange,
  selectionRevealRequest,
  hoveredNodeId = null,
  onNodeHoverChange,
  searchFocusTrigger = 0,
  expandedStoryGroupIds = new Set(),
  onExpandedStoryGroupIdsChange,
  variant = 'plein',
  showActionsBar = false,
  showHint = false,
  onClose,
  onPreview,
  onSimulateZip,
  onSimulateRoot,
  onOpenLocalEndSettings,
}) {
  const [controlsHost, setControlsHost] = useState(null);
  const [localSearchFocusTrigger, setLocalSearchFocusTrigger] = useState(0);

  if (project?.projectType !== 'pack' && project?.projectType !== 'simple') return null;

  return (
    <div className="fd-panel" data-project-type={projectType}>
      <DiagramPanelHeader
        variant={variant}
        onClose={onClose}
        onSearch={() => {
          setLocalSearchFocusTrigger((value) => value + 1);
        }}
        controlsHostRef={setControlsHost}
      />
      <div className="fd-panel-body">
        <CompleteDiagramTree
          project={project}
          projectIndex={projectIndex}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelectNode={onSelectNode}
          onSelectionChange={onSelectionChange}
          selectionRevealRequest={selectionRevealRequest}
          hoveredNodeId={hoveredNodeId}
          onNodeHoverChange={onNodeHoverChange}
          searchFocusTrigger={`${searchFocusTrigger}:${localSearchFocusTrigger}`}
          expandedStoryGroupIds={expandedStoryGroupIds}
          onExpandedStoryGroupIdsChange={onExpandedStoryGroupIdsChange}
          onPreview={onPreview}
          onSimulateZip={onSimulateZip}
          onSimulateRoot={onSimulateRoot}
          onOpenLocalEndSettings={onOpenLocalEndSettings}
          controlsHost={controlsHost}
          showActionsBar={showActionsBar}
          showHint={showHint}
        />
      </div>
    </div>
  );
}
