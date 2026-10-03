import { lazy } from 'react';
import { MediaTransferProvider } from '../store/MediaTransferContext';
import { ProjectContext } from '../store/ProjectContext';
import { ProjectActionsContext } from '../store/ProjectActionsContext';
import { ShortcutLabelsContext } from '../store/ShortcutLabelsContext';
import { TitleBar } from './layout/TitleBar';
import { Toolbar } from './layout/Toolbar';
import { AppModals } from './AppModals';
import { renderDeferred } from './renderDeferred';

const WorkspaceView = lazy(() => import('../workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceView })));
const BottomWorkspacePanel = lazy(() => import('./BottomWorkspacePanel/BottomWorkspacePanel')
  .then((module) => ({ default: module.BottomWorkspacePanel })));

// Shell présentational d'`AppContent`. Composant pur :
// aucune logique métier, uniquement le rendu du chrome (providers, `.app`,
// TitleBar, Toolbar, WorkspaceView, BottomWorkspacePanel, AppModals, bottombar),
// alimenté par des groupes de props déjà bâtis par l'hôte.
//
// Les providers (`MediaTransferProvider`, `ProjectContext`, `ProjectActionsContext`)
// vivent ici : `AppContent` fournit les valeurs (`projectContextValue`,
// `projectActions`, groupe `mediaTransfer`) et le shell les monte autour de l'arbre.
// `WorkspaceView` reste `lazy` + `renderDeferred` : le code-split est préservé.
export function AppShell({
  mediaTransfer,
  projectContextValue,
  projectActions,
  // Le panneau du bas et la bottombar suivent « un projet est-il ouvert ? »,
  // comme la barre : médiathèque, files et étiquettes ne demandent pas d'arbre.
  // Le shell ne lit pas la capacité d'arbre.
  projectOpen,
  titleBar,
  toolbar,
  workspace,
  bottomPanel,
  appModalsProps,
  bottomBar,
}) {
  return (
    <MediaTransferProvider
      dropOnNode={mediaTransfer.dropOnNode}
      prepareMediaForProject={mediaTransfer.prepareMediaForProject}
      notifyCutPaste={mediaTransfer.notifyCutPaste}
      activeDropZone={mediaTransfer.activeDropZone}
      setActiveDropZone={mediaTransfer.setActiveDropZone}
    >
    <ProjectContext.Provider value={projectContextValue}>
    <ProjectActionsContext.Provider value={projectActions}>
    <ShortcutLabelsContext.Provider value={toolbar.shortcutLabels}>
    <div className="app">
      <TitleBar
        projectName={titleBar.projectName}
        packRecap={titleBar.packRecap}
        packCoverImage={titleBar.packCoverImage}
        isDirty={titleBar.isDirty}
        hasSavePath={titleBar.hasSavePath}
        saveState={titleBar.saveState}
        showProjectMeta={titleBar.showProjectMeta}
        onOpenPackMetadata={titleBar.onOpenPackMetadata}
        onOpenCredits={titleBar.onOpenCredits}
      />

      {projectOpen && (
        <Toolbar
          inventory={toolbar.inventory}
          shortcutLabels={toolbar.shortcutLabels}
          suspensionNotice={toolbar.suspensionNotice}
          onNewProject={toolbar.onNewProject}
          onOpenProject={toolbar.onOpenProject}
          onOpenPack={toolbar.onOpenPack}
          onSaveProject={toolbar.onSaveProject}
          onSaveProjectAs={toolbar.onSaveProjectAs}
          onContinueInGraph={toolbar.onContinueInGraph}
          onUndo={toolbar.onUndo}
          onRedo={toolbar.onRedo}
          onOpenPreferences={toolbar.onOpenPreferences}
          panels={toolbar.panels}
          panelOrder={toolbar.panelOrder}
          onMovePanel={toolbar.onMovePanel}
          onToggleTree={toolbar.onToggleTree}
          onToggleSettings={toolbar.onToggleSettings}
          onToggleDiagram={toolbar.onToggleDiagram}
          onToggleNodeList={toolbar.onToggleNodeList}
          onToggleInspector={toolbar.onToggleInspector}
          packOptionsOpen={toolbar.packOptionsOpen}
          onPackOptionsOpenChange={toolbar.onPackOptionsOpenChange}
          projectType={toolbar.projectType}
          globalOptions={toolbar.globalOptions}
          onUpdateGlobalOption={toolbar.onUpdateGlobalOption}
          onGenerate={toolbar.onGenerate}
          issueKind={toolbar.issueKind}
          validationIssues={toolbar.validationIssues}
          advancedIssues={toolbar.advancedIssues}
          pathAuditPending={toolbar.pathAuditPending}
          validationOpen={toolbar.validationOpen}
          onValidationOpenChange={toolbar.onValidationOpenChange}
          onSelectIssue={toolbar.onSelectIssue}
        />
      )}

      <div className="chrome-shell">
        <div className="chrome-content">
          {renderDeferred(
            <WorkspaceView
              project={workspace.project}
              projectEpoch={workspace.projectEpoch}
              node={workspace.node}
              selectedId={workspace.selectedId}
              onSetProjectType={workspace.onSetProjectType}
              onStartAdvancedProject={workspace.onStartAdvancedProject}
              onEditPack={workspace.onEditPack}
              onPodcastFunnel={workspace.onPodcastFunnel}
              onYoutubeFunnel={workspace.onYoutubeFunnel}
              onAggregatePacks={workspace.onAggregatePacks}
              onCheckPack={workspace.onCheckPack}
              pendingSimulateZipPath={workspace.pendingSimulateZipPath}
              onSimulateConsumed={workspace.onSimulateConsumed}
              onOpenProject={workspace.onOpenProject}
              onOpenPreferences={workspace.onOpenPreferences}
              recentProjects={workspace.recentProjects}
              onOpenRecentProject={workspace.onOpenRecentProject}
              sessionRecoveries={workspace.sessionRecoveries}
              onRecoverSession={workspace.onRecoverSession}
              onIgnoreSessionRecovery={workspace.onIgnoreSessionRecovery}
              validationIssues={workspace.validationIssues}
              allMenus={workspace.allMenus}
              projectIndex={workspace.projectIndex}
              treeSearchFocusTrigger={workspace.treeSearchFocusTrigger}
              onFocusTreeSearch={workspace.onFocusTreeSearch}
              diagramSearchFocusTrigger={workspace.diagramSearchFocusTrigger}
              workspaceViewState={workspace.workspaceViewState}
              advanced={workspace.advanced}
            />,
          )}
          {projectOpen && bottomPanel.open && renderDeferred(
            <BottomWorkspacePanel
              key={bottomPanel.editorScope}
              heightKey={bottomPanel.heightKey}
              activeTab={bottomPanel.activeTab}
              onActiveTabChange={bottomPanel.onActiveTabChange}
              onClose={bottomPanel.onClose}
              project={bottomPanel.project}
              pathAudit={bottomPanel.pathAudit}
              sdJobs={bottomPanel.sdJobs}
              xttsJobs={bottomPanel.xttsJobs}
              mediaLibraryPaths={bottomPanel.mediaLibraryPaths}
              onImportStories={bottomPanel.onImportStories}
              onImportMedia={bottomPanel.onImportMedia}
              onImportMediaFolder={bottomPanel.onImportMediaFolder}
              onRegenerateImage={bottomPanel.onRegenerateImage}
              onClearAiDone={bottomPanel.onClearAiDone}
              onRemoveImageJob={bottomPanel.onRemoveImageJob}
              onRemoveAudioJob={bottomPanel.onRemoveAudioJob}
              getAudioUsage={bottomPanel.getAudioUsage}
              getImageUsage={bottomPanel.getImageUsage}
              onSelectNode={bottomPanel.onSelectNode}
              onRevealGraphNode={bottomPanel.onRevealGraphNode}
              renderQueue={bottomPanel.renderQueue}
              renderQueueAdvanced={bottomPanel.renderQueueAdvanced}
              mediaTags={bottomPanel.mediaTags}
              onAddMediaTag={bottomPanel.onAddMediaTag}
              onRemoveMediaTag={bottomPanel.onRemoveMediaTag}
              onDeleteMedia={bottomPanel.onDeleteMedia}
              onMediaCatalogChanged={bottomPanel.onMediaCatalogChanged}
              workspaceDir={bottomPanel.workspaceDir}
              savePath={bottomPanel.savePath}
              projectName={bottomPanel.projectName}
              onMediaCreated={bottomPanel.onMediaCreated}
              advancedMediaUsages={bottomPanel.advancedMediaUsages}
              mediaToolRequest={bottomPanel.mediaToolRequest}
              onAcknowledgeMediaToolRequest={bottomPanel.onAcknowledgeMediaToolRequest}
              onInvalidateMediaToolRequest={bottomPanel.onInvalidateMediaToolRequest}
              onValidateMediaToolRequest={bottomPanel.onValidateMediaToolRequest}
              onApplyMediaToolProjectAction={bottomPanel.onApplyMediaToolProjectAction}
              pendingMediaReveal={bottomPanel.pendingMediaReveal}
              onMediaRevealConsumed={bottomPanel.onMediaRevealConsumed}
            />
          )}
        </div>
      </div>

      <AppModals {...appModalsProps} />

      {/* Bottom bar */}
      <div className="bottombar">
        <span className="status-text">{bottomBar.statusText}</span>
        {bottomBar.projectOpen && !bottomBar.open && (
          <button
            className="rq-bottombar-btn"
            onClick={bottomBar.onOpenMedia}
          >
            Médias
            <span>({bottomBar.mediaLibraryCount})</span>
          </button>
        )}
        {bottomBar.projectOpen && !bottomBar.open && (
          <button
            className={`rq-bottombar-btn${bottomBar.renderQueueActiveCount > 0 ? ' has-active' : ''}`}
            onClick={bottomBar.onOpenRenderQueue}
          >
            {bottomBar.renderQueueActiveCount > 0 && <span className="rq-spinner" />}
            File de rendu
            {bottomBar.renderQueueActiveCount > 0 && <span className="bottom-status-pill">{bottomBar.renderQueueActiveCount}</span>}
            {bottomBar.renderQueueActiveCount === 0 && bottomBar.renderQueueHasResults && <span className="bottom-status-pill is-done">✓</span>}
          </button>
        )}
        {bottomBar.projectOpen && !bottomBar.open && (
          <button
            className={`rq-bottombar-btn${bottomBar.aiQueueActiveCount > 0 ? ' has-active' : ''}`}
            onClick={bottomBar.onOpenAiQueue}
          >
            {bottomBar.aiQueueActiveCount > 0 && <span className="rq-spinner" />}
            File IA
            {bottomBar.aiQueueActiveCount > 0 && <span className="bottom-status-pill">{bottomBar.aiQueueActiveCount}</span>}
            {bottomBar.aiQueueActiveCount === 0 && bottomBar.aiQueueHasResults && <span className="bottom-status-pill is-done">✓</span>}
          </button>
        )}
        {bottomBar.appVersion && <span className="bottombar-version">v{bottomBar.appVersion}</span>}
      </div>
    </div>
    </ShortcutLabelsContext.Provider>
    </ProjectActionsContext.Provider>
    </ProjectContext.Provider>
    </MediaTransferProvider>
  );
}
