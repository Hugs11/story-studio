import { useState } from 'react';
import { X } from '../icons/LucideLocal';
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
  controlsHostRef,
}) {
  const isFull = variant === 'plein';

  return (
    <div className="fd-panel-header">
      <div className="fd-panel-title">
        {isFull ? 'Diagramme complet du pack' : 'Diagramme'}
      </div>
      <div className="fd-panel-view-controls" ref={controlsHostRef} />
      <div className="fd-panel-window-controls">
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
  onSelectionChange,
  expandedStoryGroupId = null,
  onExpandedStoryGroupIdChange,
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

  if (project?.projectType !== 'pack' && project?.projectType !== 'simple') return null;

  return (
    <div className="fd-panel" data-project-type={projectType}>
      <DiagramPanelHeader
        variant={variant}
        onClose={onClose}
        controlsHostRef={setControlsHost}
      />
      <div className="fd-panel-body">
        <CompleteDiagramTree
          project={project}
          projectIndex={projectIndex}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelectionChange={onSelectionChange}
          expandedStoryGroupId={expandedStoryGroupId}
          onExpandedStoryGroupIdChange={onExpandedStoryGroupIdChange}
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
