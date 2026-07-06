import { useState } from 'react';
import {
  Maximize2,
  Minimize2,
  PanelLeft,
  SlidersHorizontal,
  X,
} from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { DIAGRAM_LEFT_SLOTS } from '../../workspace/useDiagramViewState';
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
  leftSlot,
  onLeftSlotChange,
  onMaximize,
  onMinimize,
  onClose,
  controlsHostRef,
}) {
  const isFull = variant === 'plein';

  return (
    <div className="fd-panel-header">
      {isFull ? (
        <>
          <div className="fd-panel-left-toggles" aria-label="Panneau gauche du diagramme">
            <IconButton
              label="Afficher l'arbre"
              active={leftSlot === DIAGRAM_LEFT_SLOTS.TREE}
              onClick={() => onLeftSlotChange?.(DIAGRAM_LEFT_SLOTS.TREE)}
            >
              <PanelLeft aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Afficher les réglages"
              active={leftSlot === DIAGRAM_LEFT_SLOTS.SETTINGS}
              onClick={() => onLeftSlotChange?.(DIAGRAM_LEFT_SLOTS.SETTINGS)}
            >
              <SlidersHorizontal aria-hidden="true" />
            </IconButton>
          </div>
          <span className="fd-panel-separator" aria-hidden="true" />
        </>
      ) : null}
      <div className="fd-panel-title">
        {isFull ? 'Diagramme complet du pack' : 'Diagramme'}
      </div>
      <div className="fd-panel-view-controls" ref={controlsHostRef} />
      <div className="fd-panel-window-controls">
        {isFull ? (
          <IconButton label="Réduire le diagramme" onClick={onMinimize}>
            <Minimize2 aria-hidden="true" />
          </IconButton>
        ) : (
          <IconButton label="Agrandir le diagramme" onClick={onMaximize}>
            <Maximize2 aria-hidden="true" />
          </IconButton>
        )}
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
  variant = 'plein',
  leftSlot = DIAGRAM_LEFT_SLOTS.TREE,
  onLeftSlotChange,
  onMaximize,
  onMinimize,
  onClose,
  onPreview,
  onSimulateZip,
  onSimulateRoot,
}) {
  const [controlsHost, setControlsHost] = useState(null);

  if (project?.projectType !== 'pack' && project?.projectType !== 'simple') return null;

  const showActionsBar = variant === 'plein' && leftSlot !== DIAGRAM_LEFT_SLOTS.TREE;
  const showHint = variant === 'plein' && leftSlot !== DIAGRAM_LEFT_SLOTS.SETTINGS;

  return (
    <div className="fd-panel" data-project-type={projectType}>
      <DiagramPanelHeader
        variant={variant}
        leftSlot={leftSlot}
        onLeftSlotChange={onLeftSlotChange}
        onMaximize={onMaximize}
        onMinimize={onMinimize}
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
          onPreview={onPreview}
          onSimulateZip={onSimulateZip}
          onSimulateRoot={onSimulateRoot}
          controlsHost={controlsHost}
          showActionsBar={showActionsBar}
          showHint={showHint}
        />
      </div>
    </div>
  );
}
