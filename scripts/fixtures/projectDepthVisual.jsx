import { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ContextMenu } from '../../src/components/TreePanel/ContextMenu.jsx';
import { TreePanel } from '../../src/components/TreePanel/TreePanel.jsx';
import { buildTreeContextActions } from '../../src/components/TreePanel/treeContextMenuActions.jsx';
import { CompleteDiagramTree } from '../../src/components/diagram/FullDiagramTree.jsx';
import { MediaTransferProvider } from '../../src/store/MediaTransferContext.js';
import { ProjectActionsContext } from '../../src/store/ProjectActionsContext.js';
import { buildProjectIndex } from '../../src/store/projectModel/index.js';
import { MAX_MENU_DEPTH } from '../../src/store/projectModel/menuDepth.js';
import { makeDepthProject } from './projectDepthFixtures.js';
import '../../src/styles/variables.css';
import '../../src/styles/layout.css';
import '../../src/components/diagram/FlowDiagram.css';
import './projectDepthVisual.css';

const noop = () => {};
const noopResult = () => ({ allowed: true });

function VisualFixture() {
  const view = new URLSearchParams(window.location.search).get('view') ?? 'overview';
  const project = useMemo(
    () => makeDepthProject(MAX_MENU_DEPTH, { withSiblingBranch: true }),
    [],
  );
  const projectIndex = useMemo(() => buildProjectIndex(project), [project]);
  const initialSelection = view === 'overview' ? 'root' : `folder-${MAX_MENU_DEPTH}`;
  const [selectedId, setSelectedId] = useState(initialSelection);
  const [selectedIds, setSelectedIds] = useState(new Set([initialSelection]));
  const [expandedStoryGroupIds, setExpandedStoryGroupIds] = useState(new Set());
  const actions = useMemo(() => ({
    onSelect: setSelectedId,
    onMoveToMenu: noopResult,
    onImportFolder: noop,
    onImportPodcast: noop,
    onImportYoutube: noop,
    onRecord: noop,
    onGenerateStoryTts: noop,
    canGenerateStoryTts: false,
    onAddMenu: noopResult,
    onAddStoryToMenu: noopResult,
    onUnpackZip: noop,
    onSetMenuAsRoot: noop,
    onDeleteMenu: noop,
    onDeleteItem: noop,
    onBulkDeleteItems: noop,
    onBulkUpdateItems: noop,
    onUpdateMedia: noop,
    onUpdateMenu: noop,
    onUpdateItem: noop,
    onPasteEntries: noopResult,
    onCutPasteEntries: noopResult,
    onDuplicate: noopResult,
    onAddEndNode: noop,
    onRemoveEndNode: noop,
    onOpenMediaAudioTool: noop,
  }), []);

  const handleSelection = (ids) => {
    const next = ids instanceof Set ? ids : new Set(ids ?? []);
    setSelectedIds(next);
    setSelectedId([...next][0] ?? null);
  };
  const revealRequest = initialSelection === 'root'
    ? null
    : { id: initialSelection, requestId: `visual-${view}` };
  const limitMenuActions = view === 'limit'
    ? buildTreeContextActions({
      nodeId: `folder-${MAX_MENU_DEPTH}`,
      nodeType: 'menu',
      project,
      projectIndex,
      projectType: 'pack',
      selectedIds,
      getEntry: (id) => projectIndex.entryById.get(id) ?? null,
      getParentId: (id) => projectIndex.parentMenuById.get(id) ?? null,
      clipboardRef: { current: null },
      getTopLevelSelected: () => [`folder-${MAX_MENU_DEPTH}`],
      handleCopy: noop,
      handleCut: noop,
      handlePaste: noop,
      handlePasteMedia: noop,
      handleReplaceAudio: noop,
      callOnSelect: noop,
      onSelectionChange: noop,
      onAddMenu: noopResult,
      onAddStory: noopResult,
      onImportFolder: noop,
      onDeleteMenu: noop,
      onDeleteItem: noop,
      onBulkDeleteItems: noop,
      onBulkUpdateItems: noop,
      onSetMenuAsRoot: noop,
      onSimulateZip: noop,
      onUnpackZip: noop,
      onSimulateNode: noop,
      onMoveToMenu: noopResult,
      onDuplicate: noopResult,
      onSetNodeColor: noop,
      onOpenMediaAudioTool: noop,
      closeContextMenu: noop,
    }).slice(0, 3)
    : [];

  return (
    <MediaTransferProvider>
      <ProjectActionsContext.Provider value={actions}>
        <main className="depth-visual-root">
          <header className="depth-visual-header">
            <div>
              <strong>Fixture réelle Story Studio</strong>
              <span>61 Dossiers imbriqués · racine non comptée</span>
            </div>
            <output data-testid="depth-status">
              Sélection : {selectedId === 'root' ? 'Menu racine' : `Dossier ${MAX_MENU_DEPTH} (N${MAX_MENU_DEPTH})`}
            </output>
          </header>
          <section className="depth-visual-grid">
            <aside className="depth-tree-panel" aria-label="Arbre de profondeur 61">
              <div className="depth-panel-title">Arbre · hiérarchie complète</div>
              <TreePanel
                project={project}
                projectType="pack"
                selectedId={selectedId}
                selectedIds={selectedIds}
                onSelect={(id) => {
                  setSelectedId(id);
                  setSelectedIds(new Set([id]));
                }}
                onSelectionChange={handleSelection}
                onReorder={noopResult}
                onMoveToMenu={noopResult}
                onAddMenu={noopResult}
                onAddStory={noopResult}
                onImportFolder={noop}
                onDeleteMenu={noop}
                onDeleteItem={noop}
                onBulkDeleteItems={noop}
                onBulkUpdateItems={noop}
                onUnpackZip={noop}
                onSimulateZip={noop}
                onPasteEntries={noopResult}
                onCutPasteEntries={noopResult}
                onSetMenuAsRoot={noop}
                onDemoteRootToMenu={noopResult}
                onDuplicate={noopResult}
                onSetNodeColor={noop}
                onRenameNode={noop}
                onAddEndNode={noop}
                onRemoveEndNode={noop}
                onSimulateNode={noop}
                onOpenMediaAudioTool={noop}
                validationIssues={[]}
                projectIndex={projectIndex}
                selectionRevealRequest={revealRequest}
                showNavigationBadges={false}
                showTreeGuides
              />
            </aside>
            <section className="depth-diagram-panel" aria-label="Diagramme de profondeur 61">
              <div className="depth-panel-title">Diagramme · 61 niveaux calculés</div>
              <CompleteDiagramTree
                project={project}
                projectIndex={projectIndex}
                selectedId={selectedId}
                selectedIds={selectedIds}
                onSelectNode={(id) => {
                  setSelectedId(id);
                  setSelectedIds(new Set([id]));
                }}
                onSelectionChange={handleSelection}
                selectionRevealRequest={revealRequest}
                expandedStoryGroupIds={expandedStoryGroupIds}
                onExpandedStoryGroupIdsChange={setExpandedStoryGroupIds}
                onPreview={noop}
                onSimulateZip={noop}
                onSimulateRoot={noop}
                onOpenLocalEndSettings={noop}
              />
            </section>
          </section>
          {view === 'limit' ? (
            <ContextMenu
              x={245}
              y={650}
              onClose={noop}
              actions={limitMenuActions}
            />
          ) : null}
        </main>
      </ProjectActionsContext.Provider>
    </MediaTransferProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<VisualFixture />);

// Le chargement du module reste ouvert le temps que les effets de centrage et
// le menu contextuel de la vue `limit` soient stabilisés avant une capture.
await new Promise((resolve) => window.setTimeout(resolve, 1800));
