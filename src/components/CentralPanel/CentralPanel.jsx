import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { NodeEditorContent } from './NodeEditorContent';
import { EndNodeEditor } from './EndNodeEditor';
import { PackNameBar } from './PackNameBar';
import { END_NODE_ID } from '../TreePanel/TreePanel';
import { collectAllStories } from '../../store/projectModel';
import {
  CONTEXTUAL_NEXT_STORY_TARGET,
  getDefaultPackEntryDestination,
  getGeneratedNavigationTargetName,
  resolveNavigationTargetId,
} from '../../store/generatedNavigation';
import { isNextStoryNavigationTarget, isRootNavigationTarget, normalizeNavigationTarget } from '../../store/navigationTargets';
import { NAV_ROOT_LABEL } from './story/storyUtils';
import './CentralPanel.css';

const FlowDiagram = lazy(() => import('./FlowDiagram').then((module) => ({ default: module.FlowDiagram })));

export function CentralPanel({
  node,
  selectedId,
  selectedIds,
  project,
  projectType,
  allMenus,
  projectIndex,
  onSelect,
  onMoveToMenu,
  onUpdateRoot,
  onUpdateMedia,
  onUpdateStoryAudio,
  onUpdateMenu,
  onDeleteMenu,
  onUpdateItem,
  onDeleteItem,
  onBulkUpdateItems,
  onBulkDeleteItems,
  onImportStories,
  onUpdateNightModeAudio,
  onUpdateNightMode,
  onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  onRemoveEndNode,
  showCentralDiagram = false,
}) {
  const [showFlowDiagram, setShowFlowDiagram] = useState(false);

  useEffect(() => {
    if (projectType !== 'pack' || !showCentralDiagram) {
      setShowFlowDiagram(false);
      return undefined;
    }
    if (showFlowDiagram) return undefined;

    let cancelled = false;
    const idleHandle = window.requestIdleCallback
      ? window.requestIdleCallback(() => {
        if (!cancelled) setShowFlowDiagram(true);
      }, { timeout: 250 })
      : null;
    const timeoutHandle = idleHandle == null
      ? window.setTimeout(() => {
        if (!cancelled) setShowFlowDiagram(true);
      }, 120)
      : null;

    return () => {
      cancelled = true;
      if (idleHandle != null && window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
    };
  }, [projectType, showFlowDiagram, showCentralDiagram]);

  const isMultiSelect = selectedIds && selectedIds.size > 1;
  const allStories = useMemo(
    () => collectAllStories(project, projectIndex),
    [project, projectIndex],
  );

  const defaultPackEntry = useMemo(
    () => getDefaultPackEntryDestination(project),
    [project],
  );
  const defaultPackEntryLabel = defaultPackEntry
    ? `${defaultPackEntry.name} (premier élément du pack)`
    : NAV_ROOT_LABEL;
  // Étiquette pour le défaut GLOBAL du nœud de fin : la destination effective
  // est contextuelle (chaque story retombe sur sa propre destination de fin).
  // On ne peut donc pas afficher une cible unique sans mentir.
  const endNodeContextualDefaultLabel = 'Suit la destination de fin de chaque histoire';

  const resolveExplicitTargetLabel = (normalized) => {
    if (isNextStoryNavigationTarget(normalized)) {
      return getGeneratedNavigationTargetName(CONTEXTUAL_NEXT_STORY_TARGET, projectIndex);
    }
    if (isRootNavigationTarget(normalized)) return defaultPackEntryLabel;
    return null;
  };

  const endNodeReturnResolvedLabel = useMemo(() => {
    const normalized = normalizeNavigationTarget(project.nightModeReturn);
    if (!normalized) return endNodeContextualDefaultLabel;
    return resolveExplicitTargetLabel(normalized);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.nightModeReturn, defaultPackEntryLabel, projectIndex]);

  const endNodeHomeResolvedLabel = useMemo(() => {
    const normalized = normalizeNavigationTarget(project.nightModeHomeReturn);
    if (!normalized) {
      const fallback = normalizeNavigationTarget(project.nightModeReturn);
      if (!fallback) return endNodeContextualDefaultLabel;
      const fallbackLabel = resolveExplicitTargetLabel(fallback)
        ?? getGeneratedNavigationTargetName(resolveNavigationTargetId(fallback, null), projectIndex);
      return `${fallbackLabel} (suit le réglage de fin)`;
    }
    return resolveExplicitTargetLabel(normalized);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.nightModeHomeReturn, project.nightModeReturn, defaultPackEntryLabel, projectIndex]);

  if (!isMultiSelect && selectedId === END_NODE_ID) {
    return (
      <div className="panel-center">

        <div className="center-body">
          <EndNodeEditor
            nightModeAudio={project.nightModeAudio}
            nightModeActive={!!project.globalOptions?.nightMode}
            nightModeReturn={project.nightModeReturn ?? null}
            nightModeHomeReturn={project.nightModeHomeReturn ?? null}
            nightModeReturnResolvedLabel={endNodeReturnResolvedLabel}
            nightModeHomeReturnResolvedLabel={endNodeHomeResolvedLabel}
            projectName={project.name}
            savePath={project.savePath}
            allMenus={allMenus}
            allStories={allStories}
            onUpdateNightModeAudio={onUpdateNightModeAudio}
            onUpdateNightMode={onUpdateNightMode}
            onUpdateNightModeReturn={onUpdateNightModeReturn}
            onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
            onRemove={onRemoveEndNode}
          />
        </div>
      </div>
    );
  }

  if (!isMultiSelect && !node) {
    return (
      <div className="panel-center">

        <div className="center-body" />
      </div>
    );
  }

  if (isMultiSelect) {
    const count = selectedIds.size;
    return (
      <div className="panel-center">

        <div className="center-body">
          <div className="multiselect-hint">{count} éléments sélectionnés — modification groupée</div>
          <NodeEditorContent
            node={node}
            selectedIds={selectedIds}
            project={project}
            projectIndex={projectIndex}
            projectType={projectType}
            allMenus={allMenus}
            onUpdateRoot={onUpdateRoot}
            onUpdateMedia={onUpdateMedia}
            onUpdateStoryAudio={onUpdateStoryAudio}
            onUpdateMenu={onUpdateMenu}
            onDeleteMenu={onDeleteMenu}
            onUpdateItem={onUpdateItem}
            onDeleteItem={onDeleteItem}
            onBulkUpdateItems={onBulkUpdateItems}
            onBulkDeleteItems={onBulkDeleteItems}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="panel-center">
      {projectType === 'pack' && <PackNameBar packName={project.name} packDescription={project.packDescription ?? ''} packVersion={project.packVersion ?? 1} packMinAge={project.packMinAge ?? ''} packConventionSource={project.packConventionSource ?? ''} onUpdateRoot={onUpdateRoot} />}
      <div className="center-body">
        <NodeEditorContent
          node={node}
          project={project}
          projectIndex={projectIndex}
          projectType={projectType}
          allMenus={allMenus}
          onUpdateRoot={onUpdateRoot}
          onUpdateMedia={onUpdateMedia}
          onUpdateStoryAudio={onUpdateStoryAudio}
          onUpdateMenu={onUpdateMenu}
          onDeleteMenu={onDeleteMenu}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
        />
        {projectType === 'pack' && showFlowDiagram ? (
          <Suspense fallback={<div className="card" style={{ minHeight: 160 }}>Chargement du diagramme...</div>}>
            <FlowDiagram
              project={project}
              projectType={projectType}
              allMenus={allMenus}
              allStories={allStories}
              projectIndex={projectIndex}
              selectedId={selectedId}
              onSelect={onSelect}
              onMoveToMenu={onMoveToMenu}
              onUpdateRoot={onUpdateRoot}
              onUpdateMedia={onUpdateMedia}
              onUpdateStoryAudio={onUpdateStoryAudio}
              onUpdateMenu={onUpdateMenu}
              onDeleteMenu={onDeleteMenu}
              onUpdateItem={onUpdateItem}
              onDeleteItem={onDeleteItem}
              onBulkDeleteItems={onBulkDeleteItems}
              onImportStories={onImportStories}
              onUpdateNightModeAudio={onUpdateNightModeAudio}
              onUpdateNightMode={onUpdateNightMode}
              onUpdateNightModeReturn={onUpdateNightModeReturn}
              onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
              onRemoveEndNode={onRemoveEndNode}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
