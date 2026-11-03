import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { NodeEditorContent } from '../components/editors/NodeEditorContent';
import { EndNodeEditor } from '../components/editors/EndNodeEditor';
import { END_NODE_ID } from '../components/TreePanel/TreePanel';
import { collectAllStories } from '../store/projectModel';
import { useProjectActions } from '../store/ProjectActionsContext';
import '../components/editors/EditorPanel.css';

export function SettingsPanel({
  node,
  selectedId,
  selectedIds,
  project,
  projectType,
  allMenus,
  projectIndex,
  afterPlayFocus = null,
  onAfterPlayFocusConsumed,
  autoNextFocus = null,
  onAutoNextFocusConsumed,
  header = null,
}) {
  const { t } = useTranslation('settings');
  const {
    onUpdateRoot,
    onUpdateMedia,
    onUpdateStoryAudio,
    onUpdateGlobalOption,
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
    onUpdateEndMessageAutoplay,
    onRemoveEndNode,
    onSelect,
    onAttachStoryEndToGlobal,
  } = useProjectActions();

  const isMultiSelect = selectedIds && selectedIds.size > 1;
  const allStories = useMemo(
    () => collectAllStories(project, projectIndex),
    [project, projectIndex],
  );

  let content = null;

  if (!isMultiSelect && selectedId === END_NODE_ID) {
    content = (
      <EndNodeEditor
        endNodeName={project.endNodeName || t('settings:panel.end.fallback')}
        nightModeAudio={project.nightModeAudio}
        nightModeActive={!!project.globalOptions?.nightMode}
        nightModeReturn={project.nightModeReturn ?? null}
        nightModeHomeReturn={project.nightModeHomeReturn ?? null}
        projectName={project.projectName}
        allMenus={allMenus}
        allStories={allStories}
        onUpdateNightModeAudio={onUpdateNightModeAudio}
        onUpdateNightMode={onUpdateNightMode}
        onUpdateNightModeReturn={onUpdateNightModeReturn}
        onUpdateNightModeHomeReturn={onUpdateNightModeHomeReturn}
        onUpdateEndMessageAutoplay={onUpdateEndMessageAutoplay}
        onUpdateEndNodeName={(value) => onUpdateRoot?.({ endNodeName: value })}
        onRemove={onRemoveEndNode}
        project={project}
        onExamineStory={onSelect}
        onAttachStory={onAttachStoryEndToGlobal}
      />
    );
  } else if (isMultiSelect) {
    const count = selectedIds.size;
    content = (
      <>
        <div className="multiselect-hint">{t('settings:panel.multi.description', { count })}</div>
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
          onUpdateOption={onUpdateGlobalOption}
          onUpdateMenu={onUpdateMenu}
          onDeleteMenu={onDeleteMenu}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
          onBulkUpdateItems={onBulkUpdateItems}
          onBulkDeleteItems={onBulkDeleteItems}
          afterPlayFocus={afterPlayFocus}
          onAfterPlayFocusConsumed={onAfterPlayFocusConsumed}
          autoNextFocus={autoNextFocus}
          onAutoNextFocusConsumed={onAutoNextFocusConsumed}
        />
      </>
    );
  } else if (node) {
    content = (
      <NodeEditorContent
        node={node}
        project={project}
        projectIndex={projectIndex}
        projectType={projectType}
        allMenus={allMenus}
        onUpdateRoot={onUpdateRoot}
        onUpdateMedia={onUpdateMedia}
        onUpdateStoryAudio={onUpdateStoryAudio}
        onUpdateOption={onUpdateGlobalOption}
        onUpdateMenu={onUpdateMenu}
        onDeleteMenu={onDeleteMenu}
        onUpdateItem={onUpdateItem}
        onDeleteItem={onDeleteItem}
        afterPlayFocus={afterPlayFocus}
        onAfterPlayFocusConsumed={onAfterPlayFocusConsumed}
        autoNextFocus={autoNextFocus}
        onAutoNextFocusConsumed={onAutoNextFocusConsumed}
      />
    );
  }

  return (
    <div className="settings-panel">
      {header}
      <div className="settings-panel-body">
        {content}
      </div>
    </div>
  );
}
