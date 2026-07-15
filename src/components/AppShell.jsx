import { lazy } from 'react';
import { MediaTransferProvider } from '../store/MediaTransferContext';
import { ProjectContext } from '../store/ProjectContext';
import { ProjectActionsContext } from '../store/ProjectActionsContext';
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
  projectType,
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
      notifyCutPaste={mediaTransfer.notifyCutPaste}
      activeDropZone={mediaTransfer.activeDropZone}
      setActiveDropZone={mediaTransfer.setActiveDropZone}
    >
    <ProjectContext.Provider value={projectContextValue}>
    <ProjectActionsContext.Provider value={projectActions}>
    <div className="app">
      <TitleBar
        projectName={titleBar.projectName}
        packMetadata={titleBar.packMetadata}
        packCoverImage={titleBar.packCoverImage}
        isDirty={titleBar.isDirty}
        hasSavePath={titleBar.hasSavePath}
        saveState={titleBar.saveState}
        showProjectMeta={titleBar.showProjectMeta}
        onOpenPackMetadata={titleBar.onOpenPackMetadata}
        onOpenCredits={titleBar.onOpenCredits}
      />

      {projectType !== null && (
        <Toolbar
          showProjectActions={toolbar.showProjectActions}
          shortcutLabels={toolbar.shortcutLabels}
          saveState={toolbar.saveState}
          generateDisabled={toolbar.generateDisabled}
          onNewProject={toolbar.onNewProject}
          onOpenProject={toolbar.onOpenProject}
          onSaveProject={toolbar.onSaveProject}
          onSaveProjectAs={toolbar.onSaveProjectAs}
          panels={toolbar.panels}
          onToggleTree={toolbar.onToggleTree}
          onToggleSettings={toolbar.onToggleSettings}
          onToggleDiagram={toolbar.onToggleDiagram}
          packOptionsOpen={toolbar.packOptionsOpen}
          onPackOptionsOpenChange={toolbar.onPackOptionsOpenChange}
          projectType={toolbar.projectType}
          globalOptions={toolbar.globalOptions}
          onUpdateGlobalOption={toolbar.onUpdateGlobalOption}
          onOpenPreferences={toolbar.onOpenPreferences}
          onGenerate={toolbar.onGenerate}
          validationIssues={toolbar.validationIssues}
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
              node={workspace.node}
              selectedId={workspace.selectedId}
              onSetProjectType={workspace.onSetProjectType}
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
              pathAudit={workspace.pathAudit}
              validationIssues={workspace.validationIssues}
              allMenus={workspace.allMenus}
              projectIndex={workspace.projectIndex}
              treeSearchFocusTrigger={workspace.treeSearchFocusTrigger}
              onFocusTreeSearch={workspace.onFocusTreeSearch}
              diagramSearchFocusTrigger={workspace.diagramSearchFocusTrigger}
              diagramView={workspace.diagramView}
            />,
          )}
          {projectType !== null && bottomPanel.open && renderDeferred(
            <BottomWorkspacePanel
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
              onOpenAiQueue={bottomPanel.onOpenAiQueue}
              onRegenerateImage={bottomPanel.onRegenerateImage}
              onClearAiDone={bottomPanel.onClearAiDone}
              onRemoveImageJob={bottomPanel.onRemoveImageJob}
              onRemoveAudioJob={bottomPanel.onRemoveAudioJob}
              getAudioUsage={bottomPanel.getAudioUsage}
              getImageUsage={bottomPanel.getImageUsage}
              onSelectNode={bottomPanel.onSelectNode}
              renderQueue={bottomPanel.renderQueue}
              mediaTags={bottomPanel.mediaTags}
              onAddMediaTag={bottomPanel.onAddMediaTag}
              onRemoveMediaTag={bottomPanel.onRemoveMediaTag}
              onDeleteMedia={bottomPanel.onDeleteMedia}
              savePath={bottomPanel.savePath}
              projectName={bottomPanel.projectName}
              onMediaCreated={bottomPanel.onMediaCreated}
            />
          )}
        </div>
      </div>

      <AppModals {...appModalsProps} />

      {/* Bottom bar */}
      <div className="bottombar">
        <span className="status-text">{bottomBar.statusText}</span>
        {bottomBar.projectType !== null && !bottomBar.open && (
          <button
            className="rq-bottombar-btn"
            onClick={bottomBar.onOpenMedia}
          >
            Médias
            <span>({bottomBar.mediaLibraryCount})</span>
          </button>
        )}
        {bottomBar.projectType !== null && !bottomBar.open && (
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
        {bottomBar.projectType !== null && !bottomBar.open && (
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
    </ProjectActionsContext.Provider>
    </ProjectContext.Provider>
    </MediaTransferProvider>
  );
}
