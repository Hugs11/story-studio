import { useMemo } from 'react';
import { NodeEditorContent } from './NodeEditorContent';
import { EndNodeEditor } from './EndNodeEditor';
import { END_NODE_ID } from '../TreePanel/TreePanel';
import { collectAllStories } from '../../store/projectModel';
import { useProjectActions } from '../../store/ProjectActionsContext';
import {
  CONTEXTUAL_NEXT_STORY_TARGET,
  getDefaultPackEntryDestination,
  getGeneratedNavigationTargetName,
  resolveNavigationTargetId,
} from '../../store/generatedNavigation';
import { isNextStoryNavigationTarget, isRootNavigationTarget, normalizeNavigationTarget } from '../../store/navigationTargets';
import { NAV_ROOT_LABEL } from './story/storyUtils';
import './CentralPanel.css';

export function CentralPanel({
  node,
  selectedId,
  selectedIds,
  project,
  projectType,
  allMenus,
  projectIndex,
}) {
  const {
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
  // Étiquette pour le défaut GLOBAL du message de fin : la destination effective
  // est contextuelle (chaque story retombe sur sa propre destination de fin).
  // On ne peut donc pas afficher une cible unique sans mentir.
  const endNodeContextualDefaultLabel = 'Suit la destination de fin de l’histoire source';

  const resolveExplicitTargetLabel = (normalized) => {
    if (isNextStoryNavigationTarget(normalized)) {
      return getGeneratedNavigationTargetName(CONTEXTUAL_NEXT_STORY_TARGET, projectIndex);
    }
    if (isRootNavigationTarget(normalized)) return defaultPackEntryLabel;
    return null;
  };

  // resolveExplicitTargetLabel capture defaultPackEntryLabel + projectIndex (deja listes),
  // endNodeContextualDefaultLabel est une string litterale stable.
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
      return `${fallbackLabel} (même destination que la fin du message)`;
    }
    return resolveExplicitTargetLabel(normalized);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.nightModeHomeReturn, project.nightModeReturn, defaultPackEntryLabel, projectIndex]);

  if (!isMultiSelect && selectedId === END_NODE_ID) {
    return (
      <div className="panel-center">

        <div className="center-body">
          <EndNodeEditor
            endNodeName={project.endNodeName || 'Message de fin'}
            nightModeAudio={project.nightModeAudio}
            nightModeActive={!!project.globalOptions?.nightMode}
            nightModeReturn={project.nightModeReturn ?? null}
            nightModeHomeReturn={project.nightModeHomeReturn ?? null}
            nightModeReturnResolvedLabel={endNodeReturnResolvedLabel}
            nightModeHomeReturnResolvedLabel={endNodeHomeResolvedLabel}
            projectName={project.projectName}
            allMenus={allMenus}
            allStories={allStories}
            onUpdateNightModeAudio={onUpdateNightModeAudio}
            onUpdateNightMode={onUpdateNightMode}
            onUpdateNightModeReturn={onUpdateNightModeReturn}
            onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
            onUpdateEndNodeName={(value) => onUpdateRoot?.({ endNodeName: value })}
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
      </div>
    </div>
  );
}
