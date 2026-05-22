import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildSelectedNode, findEntryPath as getProjectEntryPath } from '../../store/projectModel';
import { NodeEditorContent } from './NodeEditorContent';
import { EndNodeEditor } from './EndNodeEditor';
import { MultiEditor } from './MultiEditor';
import { FloatingSimulator } from '../FloatingSimulator/FloatingSimulator';
import { CompleteDiagramTree } from './FullDiagramTree';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Download } from '../icons/LucideLocal';
import { END_NODE_ID, ICONS, TYPE_LABELS, describeContainer, countStories } from './flowDiagramLayout';
import './FlowDiagram.css';

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

function NodeCard({ type, name, selected, detail, badge, onClick }) {
  return (
    <button
      type="button"
      className={`fd-node-card fd-node-card--${type} ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
      title={name || '(sans nom)'}
    >
      <div className="fd-node-icon">{ICONS[type]}</div>
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
              <span className="fd-story-chip-icon">{ICONS.story}</span>
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
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSimulateZip,
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
  const [inspectorNodeId, setInspectorNodeId] = useState(null);
  const [multiPanelOpen, setMultiPanelOpen] = useState(false);
  const [autoOpenSettings, setAutoOpenSettings] = useState(
    () => localStorage.getItem('fd_auto_open_settings') !== 'false',
  );

  function handleAutoOpenChange(e) {
    const v = e.target.checked;
    setAutoOpenSettings(v);
    localStorage.setItem('fd_auto_open_settings', v ? 'true' : 'false');
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
    if (selectedIds && selectedIds.size > 1) {
      setInspectorNodeId(null);
      setPreviewNodeId(null);
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
    if (previewNodeId) {
      setPreviewNodeId(null);
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
  const inspectorNode = useMemo(
    () => {
      if (!inspectorNodeId) return null;
      if (inspectorNodeId === END_NODE_ID) {
        return {
          id: END_NODE_ID,
          type: 'end-node',
          name: 'Nœud de fin',
        };
      }
      return buildSelectedNode(project, inspectorNodeId, projectIndex);
    },
    [project, inspectorNodeId, projectIndex],
  );

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
        onPreview={setPreviewNodeId}
        onInspect={handleInspect}
        onMoveToMenu={onMoveToMenu}
        onImportStories={onImportStories}
        onAddMenu={onAddMenu}
        onAddStory={onAddStory}
        onUnpackZip={onUnpackZip}
        onSimulateZip={onSimulateZip}
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
            <button
              type="button"
              className="modal-close"
              onClick={() => setMultiPanelOpen(false)}
            >
              ✕
            </button>
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

      {previewNode && (
        <FloatingSimulator
          project={project}
          anchorId={previewNodeId}
          hostSelector=".fd-fullscreen-body"
          escapeEnabled={false}
          onActiveNodeChange={(nodeId) => {
            onSelectionChange?.(new Set([nodeId]));
            onSelect?.(nodeId);
          }}
          onClose={() => setPreviewNodeId(null)}
        />
      )}

      {inspectorNode && (
        <div className="fd-floating-panel fd-floating-panel--editor" onClick={(event) => event.stopPropagation()}>
          <div className="fd-floating-panel-head">
            <div>
              <div className="fd-floating-panel-title">Réglages du nœud</div>
              <div className="fd-floating-panel-sub">{inspectorNode.name || TYPE_LABELS[inspectorNode.type]}</div>
            </div>
            <button type="button" className="modal-close" onClick={() => setInspectorNodeId(null)}>✕</button>
          </div>
          <div className="fd-floating-panel-body">
            {inspectorNode.id === END_NODE_ID ? (
              <EndNodeEditor
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
            <button type="button" className="modal-close" onClick={() => setFullscreenOpen(false)}>✕</button>
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
