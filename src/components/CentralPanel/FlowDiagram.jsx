import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildSelectedNode, findEntryPath as getProjectEntryPath } from '../../store/projectModel';
import { NodeEditorContent } from './NodeEditorContent';
import { EndNodeEditor } from './EndNodeEditor';
import { MultiEditor } from './MultiEditor';
import { FloatingSimulator } from '../FloatingSimulator/FloatingSimulator';
import { CompleteDiagramTree } from './FullDiagramTree';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { Download } from '../icons/LucideLocal';
import { Button } from '../common/Button';
import { IconArchive, IconFolderOpen, IconHouse, IconMoon, IconStory } from '../TreePanel/TreeIcons';
import { END_NODE_ID, TYPE_LABELS, describeContainer, countStories } from './flowDiagramLayout';
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

function EmptyDiagramState({ onImportStories = null }) {
  return (
    <div className="fd-empty">
      <span>Ajoute des dossiers, ZIP ou histoires pour voir la structure.</span>
      {onImportStories ? (
        <button type="button" className="fd-empty-btn" onClick={onImportStories}>
          <Download className="fd-empty-btn-icon" strokeWidth={2} absoluteStrokeWidth />
          <span>Importer des histoires</span>
        </button>
      ) : null}
    </div>
  );
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

function DiagramNodeIcon({ type }) {
  if (type === 'root') return <IconHouse />;
  if (type === 'menu') return <IconFolderOpen />;
  if (type === 'story') return <IconStory />;
  if (type === 'zip') return <IconArchive />;
  if (type === 'end-node') return <IconMoon />;
  return null;
}

function NodeCard({ type, name, selected, detail, badge, onClick }) {
  return (
    <button
      type="button"
      className={`fd-node-card fd-node-card--${type} ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
      title={name || '(sans nom)'}
    >
      <div className="fd-node-icon"><DiagramNodeIcon type={type} /></div>
      <div className="fd-node-copy">
        <div className="fd-node-top">
          <div className="fd-node-name">{name || '(sans nom)'}</div>
          {badge ? <span className="fd-node-badge">{badge}</span> : null}
        </div>
        {detail ? <div className="fd-node-detail">{detail}</div> : null}
      </div>
    </button>
  );
}

function StoryCluster({ containerKey, stories, expanded, onToggle, selectedId, onSelect }) {
  if (!stories.length) return null;

  return (
    <div className="fd-story-cluster">
      <button type="button" className="fd-story-toggle" onClick={() => onToggle(containerKey)}>
        <span className="fd-story-toggle-label">{expanded ? '▾' : '▸'} Histoires</span>
        <span className="fd-story-toggle-count">{stories.length}</span>
      </button>
      {expanded && (
        <div className="fd-story-list">
          {stories.map((story) => (
            <button
              key={story.id}
              type="button"
              className={`fd-story-chip ${story.id === selectedId ? 'is-selected' : ''}`}
              onClick={() => onSelect?.(story.id)}
              title={story.name || '(sans nom)'}
            >
              <span className="fd-story-chip-icon"><DiagramNodeIcon type="story" /></span>
              <span className="fd-story-chip-label">{story.name || '(sans nom)'}</span>
              {(story.afterPlaybackSequence?.length ?? 0) > 0 ? (
                <span className="fd-story-chip-badge">Fin x{story.afterPlaybackSequence.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Branch({
  entry,
  rootEntries,
  selectedId,
  expandedStories,
  onToggleStories,
  onSelect,
}) {
  const isRoot = entry.type === 'root';
  const entries = isRoot ? rootEntries : (entry.children ?? []);
  const structuralChildren = entries.filter((child) => child.type === 'menu' || child.type === 'zip');
  const storyChildren = entries.filter((child) => child.type === 'story');
  const containerKey = isRoot ? 'root' : entry.id;
  const detail = describeContainer(entries);
  const badge = !isRoot ? countStories(entries) || null : (rootEntries?.length ?? 0);

  return (
    <div className="fd-branch">
      <NodeCard
        type={entry.type}
        name={entry.name}
        selected={selectedId === entry.id}
        detail={detail}
        badge={badge}
        onClick={() => onSelect?.(entry.id)}
      />

      {(structuralChildren.length > 0 || storyChildren.length > 0) && (
        <div className="fd-branch-children">
          <StoryCluster
            containerKey={containerKey}
            stories={storyChildren}
            expanded={!!expandedStories[containerKey]}
            onToggle={onToggleStories}
            selectedId={selectedId}
            onSelect={onSelect}
          />

          {structuralChildren.map((child) => (
            <div key={child.id} className="fd-child-row">
              <div className="fd-child-elbow" />
              <Branch
                entry={child}
                rootEntries={rootEntries}
                selectedId={selectedId}
                expandedStories={expandedStories}
                onToggleStories={onToggleStories}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiagramTree({ project, projectIndex, selectedId, expandedStories, setExpandedStories, onSelect, onImportStories }) {
  const selectedPath = useMemo(() => (
    selectedId && selectedId !== 'root'
      ? getProjectEntryPath(project, selectedId, projectIndex) ?? []
      : []
  ), [project, projectIndex, selectedId]);

  const breadcrumb = [
    { id: 'root', name: project.rootName || 'Racine' },
    ...selectedPath.map((entry) => ({ id: entry.id, name: entry.name || TYPE_LABELS[entry.type] })),
  ];

  function toggleStories(containerKey) {
    setExpandedStories((prev) => ({ ...prev, [containerKey]: !prev[containerKey] }));
  }

  return (
    <div className="fd-tree-shell">
      <div className="fd-breadcrumbs">
        <div className="fd-breadcrumbs-title">Branche active</div>
        <div className="fd-breadcrumbs-list">
          {breadcrumb.map((item) => (
            <span key={item.id} className={item.id === selectedId ? 'is-active' : ''}>
              {item.name}
            </span>
          ))}
        </div>
      </div>

      {(project.rootEntries?.length ?? 0) === 0 ? (
        <EmptyDiagramState onImportStories={onImportStories} />
      ) : (
        <Branch
          entry={{ id: 'root', type: 'root', name: project.projectType === 'simple' ? (project.projectName || 'Mon histoire') : (project.packMetadata?.title || project.projectName || 'Nom du pack') }}
          rootEntries={project.rootEntries ?? []}
          selectedId={selectedId}
          expandedStories={expandedStories}
          onToggleStories={toggleStories}
          onSelect={onSelect}
        />
      )}
    </div>
  );
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
  onSelect,
  onSelectionChange,
  onMoveToMenu,
  onUpdateRoot,
  onUpdateMedia,
  onUpdateStoryAudio,
  onUpdateMenu,
  onDeleteMenu,
  onUpdateItem,
  onDeleteItem,
  onImportStories,
  onImportFolder,
  onImportPodcast,
  onRecord,
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSetMenuAsRoot,
  onBulkUpdateItems,
  onBulkDeleteItems,
  onSetNodeColor,
  onPasteEntries,
  onCutPasteEntries,
  onDuplicate,
  onAddEndNode,
  onRemoveEndNode,
  onUpdateNightModeAudio,
  onUpdateNightMode,
  onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  displayMode = 'card',
}) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [expandedInlineStories, setExpandedInlineStories] = useState({});
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

  const selectedPath = useMemo(() => (
    selectedId && selectedId !== 'root'
      ? getProjectEntryPath(project, selectedId, projectIndex) ?? []
      : []
  ), [project, projectIndex, selectedId]);

  useEffect(() => {
    const selectedEntry = selectedPath[selectedPath.length - 1];
    if (selectedEntry?.type !== 'story') return;
    const containerKey = selectedPath.length > 1 ? selectedPath[selectedPath.length - 2].id : 'root';
    setExpandedInlineStories((prev) => (prev[containerKey] ? prev : { ...prev, [containerKey]: true }));
  }, [selectedPath]);

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

  const fullViewActive = displayMode === 'screen' || fullscreenOpen;

  useEffect(() => {
    if (!fullscreenOpen) return undefined;
    document.body.classList.add('fd-fullscreen-open');
    return () => {
      document.body.classList.remove('fd-fullscreen-open');
    };
  }, [fullscreenOpen]);

  // Ouverture auto des panneaux à la sélection (désactivable via checkbox)
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
      } else if (!autoOpenSettings) {
        // ne pas forcer la fermeture — l'utilisateur peut avoir ouvert manuellement
      }
    }
  }, [selectedId, selectedIds, autoOpenSettings]);

  useEscapeKey(fullViewActive, () => {
    if (previewNodeId || previewZipPath) {
      setPreviewNodeId(null);
      setPreviewZipPath(null);
      return;
    }
    if (inspectorNodeId) {
      setInspectorNodeId(null);
      return;
    }
    if (displayMode !== 'screen') setFullscreenOpen(false);
  });

  const previewNode = useMemo(
    () => (previewNodeId ? buildSelectedNode(project, previewNodeId, projectIndex) : null),
    [project, previewNodeId, projectIndex],
  );

  // Simulation depuis le diagramme via le FloatingSimulator : un noeud ou, pour
  // un pack importe, un zip standalone (« Simuler ce pack… »). Les deux sont
  // exclusifs.
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

  // ⚙ ouvre le multi-panel si multi-sélection, sinon l'inspecteur simple
  function handleInspect(nodeId) {
    setMultiPanelOpen(false);
    setInspectorNodeId(nodeId);
  }

  const fullViewContent = (
    <>
      <CompleteDiagramTree
        project={project}
        projectIndex={projectIndex}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
        onPreview={handlePreviewNode}
        onInspect={handleInspect}
        onMoveToMenu={onMoveToMenu}
        onImportStories={onImportStories}
        onImportFolder={onImportFolder}
        onImportPodcast={onImportPodcast}
        onRecord={onRecord}
        onAddMenu={onAddMenu}
        onAddStory={onAddStory}
        onUnpackZip={onUnpackZip}
        onSimulateZip={handleSimulateZip}
        onSimulateRoot={handlePreviewRoot}
        onSetMenuAsRoot={onSetMenuAsRoot}
        onDeleteMenu={onDeleteMenu}
        onDeleteItem={onDeleteItem}
        onBulkDeleteItems={onBulkDeleteItems}
        onBulkUpdateItems={onBulkUpdateItems}
        onSetNodeColor={onSetNodeColor}
        onPasteEntries={onPasteEntries}
        onCutPasteEntries={onCutPasteEntries}
        onDuplicate={onDuplicate}
        onAddEndNode={onAddEndNode}
        onRemoveEndNode={onRemoveEndNode}
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

  const fullscreenTree = fullscreenOpen ? createPortal(
    <div className="fd-fullscreen-overlay">
      <div className="fd-fullscreen">
        <div className="modal-header fd-fullscreen-header">
          <span>Diagramme complet du pack</span>
          <div className="fd-fullscreen-actions">
            {autoOpenCheckbox}
            <Button variant="icon" className="modal-close" onClick={() => setFullscreenOpen(false)}>✕</Button>
          </div>
        </div>
        <div className="fd-fullscreen-body">
          {fullViewContent}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

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

  if (displayMode === 'screen') {
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

  return (
    <>
      <div className="card">
        <div className="fd-card-head">
          <div className="card-title">Structure du pack</div>
        </div>

        <DiagramTree
          project={project}
          projectIndex={projectIndex}
          selectedId={selectedId}
          expandedStories={expandedInlineStories}
          setExpandedStories={setExpandedInlineStories}
          onSelect={onSelect}
          onImportStories={onImportStories}
        />
      </div>
      {fullscreenTree}
    </>
  );
}
