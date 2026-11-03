import { useTreeTranslation } from '../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../i18n/treePresentation.js';
import { useState } from 'react';
import { ChevronRight, Search, X } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { CompleteDiagramTree } from './FullDiagramTree';
import './FlowDiagram.css';

function IconButton({ label, onClick, active = false, children }) {
  useTreeTranslation();
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
  autoNextActive,
  onOpenAutoNextSettings,
  controlsHostRef,
  dragHandleProps,
}) {
  useTreeTranslation();
  const isFull = variant === 'plein';

  return (
    <div className="fd-panel-header" {...dragHandleProps}>
      <div className="fd-panel-title" title={isFull ? t("tree:diagram.full.title") : t("common:workspace.diagram.label")}>
        {isFull ? t("tree:diagram.full.title") : t("common:workspace.diagram.label")}
      </div>
      <div className="fd-panel-view-controls" ref={controlsHostRef} />
      {autoNextActive ? (
        <button
          type="button"
          className="fd-auto-next-badge"
          title={t("tree:diagram.autoNext.edit")}
          aria-label={t("tree:diagram.autoNext.aria")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onOpenAutoNextSettings}
        >
          <span className="fd-auto-next-icon" aria-hidden="true"><ChevronRight /><ChevronRight /></span>{t("tree:diagram.autoNext.label")}</button>
      ) : null}
      <div className="fd-panel-window-controls">
        <IconButton label={t("tree:diagram.search.shortcut")} onClick={onSearch}>
          <Search aria-hidden="true" />
        </IconButton>
        <IconButton label={t("tree:diagram.close.aria")} onClick={onClose}>
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
  onOpenAutoNextSettings,
  headerDragHandleProps = {},
}) {
  useTreeTranslation();
  const [controlsHost, setControlsHost] = useState(null);
  const [localSearchFocusTrigger, setLocalSearchFocusTrigger] = useState(0);

  if (project?.projectType !== 'pack' && project?.projectType !== 'simple') return null;

  return (
    <div className="fd-panel" data-project-type={projectType}>
      <DiagramPanelHeader
        variant={variant}
        onClose={onClose}
        autoNextActive={projectType === 'pack' && !!project?.globalOptions?.autoNext}
        onOpenAutoNextSettings={onOpenAutoNextSettings}
        onSearch={() => {
          setLocalSearchFocusTrigger((value) => value + 1);
        }}
        controlsHostRef={setControlsHost}
        dragHandleProps={headerDragHandleProps}
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
          onSearch={() => setLocalSearchFocusTrigger((value) => value + 1)}
          showHint={showHint}
        />
      </div>
    </div>
  );
}
