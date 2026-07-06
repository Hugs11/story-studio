import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildSelectedNode } from '../../store/projectModel';
import { useProjectActions } from '../../store/ProjectActionsContext';
import { NodeEditorContent } from './NodeEditorContent';
import { EndNodeEditor } from './EndNodeEditor';
import { MultiEditor } from './MultiEditor';
import { FloatingSimulator } from '../FloatingSimulator/FloatingSimulator';
import { CompleteDiagramTree } from './FullDiagramTree';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { Button } from '../common/Button';
import { END_NODE_ID, TYPE_LABELS } from './flowDiagramLayout';
import './FlowDiagram.css';

const INSPECTOR_WIDTH_DEFAULT = 680;
const INSPECTOR_WIDTH_MIN = 420;
const INSPECTOR_WIDTH_MAX = 980;

function getInspectorMaxWidth() {
  if (typeof window === 'undefined') return INSPECTOR_WIDTH_MAX;
  return Math.max(INSPECTOR_WIDTH_MIN, Math.min(INSPECTOR_WIDTH_MAX, window.innerWidth - 96));
}

function clampInspectorWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return INSPECTOR_WIDTH_DEFAULT;
  return Math.max(INSPECTOR_WIDTH_MIN, Math.min(getInspectorMaxWidth(), Math.round(numeric)));
}

function inspectorTitle(node) {
  if (!node) return 'Réglages';
  if (node.type === 'root') return node.name || 'Pack';
  return node.name || TYPE_LABELS[node.type] || 'Réglages';
}

function inspectorSubtitle(node) {
  if (!node) return null;
  const typeLabel = inspectorTypeLabel(node);
  if (!typeLabel || typeLabel === node.name) return null;
  if (node.type === 'root' && inspectorTitle(node) === typeLabel) return null;
  return typeLabel;
}

function inspectorTypeLabel(node) {
  if (!node) return 'Réglages';
  if (node.id === END_NODE_ID) return 'Message de fin';
  if (node.type === 'root') return 'Pack';
  const label = TYPE_LABELS[node.type] || null;
  return label || 'Réglages';
}

export function FlowDiagram({
  project,
  projectType,
  allMenus,
  allStories,
  projectIndex,
  selectedId = 'root',
  selectedIds,
  inspectRequest = null,
  onSelectionChange,
}) {
  const {
    onSelect,
    onUpdateRoot,
    onUpdateMedia,
    onUpdateStoryAudio,
    onUpdateMenu,
    onDeleteMenu,
    onUpdateItem,
    onDeleteItem,
    onBulkUpdateItems,
    onBulkDeleteItems,
    onUpdateNightModeAudio,
    onUpdateNightMode,
    onUpdateNightModeReturn,
    onUpdateNightModeHomeReturn,
    onRemoveEndNode,
  } = useProjectActions();
  const [previewNodeId, setPreviewNodeId] = useState(null);
  const [previewZipPath, setPreviewZipPath] = useState(null);
  const [inspectorNodeId, setInspectorNodeId] = useState(null);
  const [multiPanelOpen, setMultiPanelOpen] = useState(false);
  const [autoOpenSettings, setAutoOpenSettings] = useState(
    () => read(KEYS.FLOW_DIAGRAM_AUTO_OPEN_SETTINGS) !== 'false',
  );
  const [inspectorPanelWidth, setInspectorPanelWidth] = useState(
    () => clampInspectorWidth(read(KEYS.FLOW_DIAGRAM_INSPECTOR_WIDTH, { defaultValue: INSPECTOR_WIDTH_DEFAULT })),
  );

  function handleAutoOpenChange(e) {
    const v = e.target.checked;
    setAutoOpenSettings(v);
    write(KEYS.FLOW_DIAGRAM_AUTO_OPEN_SETTINGS, v ? 'true' : 'false');
  }

  function persistInspectorWidth(width) {
    write(KEYS.FLOW_DIAGRAM_INSPECTOR_WIDTH, String(clampInspectorWidth(width)));
  }

  function updateInspectorWidth(width) {
    const nextWidth = clampInspectorWidth(width);
    setInspectorPanelWidth(nextWidth);
    return nextWidth;
  }

  function handleInspectorResizePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = inspectorPanelWidth;
    let nextWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    function handlePointerMove(moveEvent) {
      nextWidth = updateInspectorWidth(startWidth + startX - moveEvent.clientX);
    }

    function stopResize() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      persistInspectorWidth(nextWidth);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  function handleInspectorResizeKeyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    const nextWidth = event.key === 'Home'
      ? INSPECTOR_WIDTH_DEFAULT
      : inspectorPanelWidth + (event.key === 'ArrowLeft' ? 32 : -32);
    persistInspectorWidth(updateInspectorWidth(nextWidth));
  }

  useEffect(() => {
    const targetId = inspectRequest?.id;
    if (!targetId) return;
    setPreviewNodeId(null);
    setPreviewZipPath(null);
    setMultiPanelOpen(false);
    onSelectionChange?.(new Set([targetId]));
    onSelect?.(targetId);
    setInspectorNodeId(targetId);
  }, [inspectRequest, onSelect, onSelectionChange]);

  // Ouverture auto des panneaux à la sélection (désactivable via checkbox).
  useEffect(() => {
    if (selectedIds && selectedIds.size === 0) {
      setInspectorNodeId(null);
      setMultiPanelOpen(false);
      return;
    }
    if (selectedIds && selectedIds.size > 1) {
      setInspectorNodeId(null);
      setPreviewNodeId(null);
      setPreviewZipPath(null);
      if (autoOpenSettings) setMultiPanelOpen(true);
    } else {
      setMultiPanelOpen(false);
      if (autoOpenSettings && selectedId && selectedId !== 'root') {
        setInspectorNodeId(selectedId);
      }
    }
  }, [selectedId, selectedIds, autoOpenSettings]);

  useEscapeKey(true, () => {
    if (previewNodeId || previewZipPath) {
      setPreviewNodeId(null);
      setPreviewZipPath(null);
      return;
    }
    if (inspectorNodeId) {
      setInspectorNodeId(null);
    }
  });

  const previewNode = useMemo(
    () => (previewNodeId ? buildSelectedNode(project, previewNodeId, projectIndex) : null),
    [project, previewNodeId, projectIndex],
  );

  const handlePreviewNode = useCallback((nodeId) => {
    setPreviewZipPath(null);
    setPreviewNodeId(nodeId);
  }, []);

  const handlePreviewRoot = useCallback(() => {
    handlePreviewNode('root');
  }, [handlePreviewNode]);

  const handleSimulateZip = useCallback((zipPath) => {
    setPreviewNodeId(null);
    setPreviewZipPath(zipPath);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewNodeId(null);
    setPreviewZipPath(null);
  }, []);

  const inspectorNode = useMemo(
    () => {
      if (!inspectorNodeId) return null;
      if (inspectorNodeId === END_NODE_ID) {
        return {
          id: END_NODE_ID,
          type: 'end-node',
          name: project?.endNodeName || 'Message de fin',
        };
      }
      return buildSelectedNode(project, inspectorNodeId, projectIndex);
    },
    [project, inspectorNodeId, projectIndex],
  );
  const inspectorSubtitleText = inspectorSubtitle(inspectorNode);

  if (project?.projectType !== 'pack' && project?.projectType !== 'simple') return null;

  function handleInspect(nodeId) {
    setMultiPanelOpen(false);
    setInspectorNodeId(nodeId);
  }

  const autoOpenCheckbox = (
    <label className="fd-header-setting">
      <input
        type="checkbox"
        checked={autoOpenSettings}
        onChange={handleAutoOpenChange}
      />
      Ouverture auto des réglages
    </label>
  );

  const fullViewContent = (
    <>
      <CompleteDiagramTree
        project={project}
        projectIndex={projectIndex}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelectionChange={onSelectionChange}
        onPreview={handlePreviewNode}
        onInspect={handleInspect}
        onSimulateZip={handleSimulateZip}
        onSimulateRoot={handlePreviewRoot}
        allMenus={allMenus}
      />

      {multiPanelOpen && selectedIds?.size > 1 && (
        <div className="fd-multi-panel">
          <div className="fd-floating-panel-head">
            <div className="fd-floating-panel-title">Sélection multiple</div>
            <Button
              variant="icon"
              className="modal-close"
              onClick={() => setMultiPanelOpen(false)}
            >
              ✕
            </Button>
          </div>
          <div className="fd-multi-panel-body">
            <MultiEditor
              selectedIds={selectedIds}
              project={project}
              projectIndex={projectIndex}
              allMenus={allMenus}
              allStories={allStories}
              onBulkUpdateItems={onBulkUpdateItems}
              onBulkDeleteItems={onBulkDeleteItems}
            />
          </div>
        </div>
      )}

      {(previewNode || previewZipPath) && (
        <FloatingSimulator
          project={project}
          anchorId={previewNodeId}
          zipPath={previewZipPath}
          hostSelector=".fd-fullscreen-body"
          escapeEnabled={false}
          onActiveNodeChange={(nodeId) => {
            onSelectionChange?.(new Set([nodeId]));
            onSelect?.(nodeId);
          }}
          onClose={closePreview}
        />
      )}

      {inspectorNode && (
        <div
          className="fd-floating-panel fd-floating-panel--editor"
          style={{ width: inspectorPanelWidth }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="fd-floating-panel-resize-handle"
            role="separator"
            aria-label="Redimensionner le panneau de réglages"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={handleInspectorResizePointerDown}
            onKeyDown={handleInspectorResizeKeyDown}
          />
          <div className="fd-floating-panel-head">
            <div>
              <div className="fd-floating-panel-title">{inspectorTitle(inspectorNode)}</div>
              {inspectorSubtitleText ? (
                <div className="fd-floating-panel-sub">{inspectorSubtitleText}</div>
              ) : null}
            </div>
            <Button variant="icon" className="modal-close" onClick={() => setInspectorNodeId(null)}>✕</Button>
          </div>
          <div className="fd-floating-panel-body">
            {inspectorNode.id === END_NODE_ID ? (
              <EndNodeEditor
                endNodeName={project.endNodeName || 'Message de fin'}
                nightModeAudio={project.nightModeAudio}
                nightModeActive={!!project.globalOptions?.nightMode}
                nightModeReturn={project.nightModeReturn ?? null}
                nightModeHomeReturn={project.nightModeHomeReturn ?? null}
                projectName={project.projectName}
                savePath={project.savePath}
                allMenus={allMenus}
                allStories={allStories ?? []}
                onUpdateNightModeAudio={onUpdateNightModeAudio}
                onUpdateNightMode={onUpdateNightMode}
                onUpdateNightModeReturn={onUpdateNightModeReturn}
                onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
                onUpdateEndNodeName={(value) => onUpdateRoot?.({ endNodeName: value })}
                onRemove={() => {
                  onRemoveEndNode?.();
                  setInspectorNodeId(null);
                }}
              />
            ) : (
              <NodeEditorContent
                node={inspectorNode}
                project={project}
                projectIndex={projectIndex}
                projectType={projectType}
                allMenus={allMenus}
                onUpdateRoot={onUpdateRoot}
                onUpdateMedia={onUpdateMedia}
                onUpdateStoryAudio={onUpdateStoryAudio}
                onUpdateMenu={(fields) => onUpdateMenu?.(fields, inspectorNode.id)}
                onDeleteMenu={() => {
                  onDeleteMenu?.(inspectorNode.id);
                  setInspectorNodeId(null);
                }}
                onUpdateItem={(fields) => onUpdateItem?.(fields, inspectorNode.id)}
                onDeleteItem={() => {
                  onDeleteItem?.(inspectorNode.id);
                  setInspectorNodeId(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="fd-fullscreen fd-fullscreen--embedded">
      <div className="modal-header fd-fullscreen-header">
        <span>Diagramme complet du pack</span>
        {autoOpenCheckbox}
      </div>
      <div className="fd-fullscreen-body">
        {fullViewContent}
      </div>
    </div>
  );
}
