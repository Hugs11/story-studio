import { memo, useMemo } from 'react';
import { RootEditor } from './RootEditor';
import { MenuEditor } from './MenuEditor';
import { StoryEditor } from './StoryEditor';
import { ZipEditor } from './ZipEditor';
import { RefEditor } from './RefEditor';
import { MultiEditor } from './MultiEditor';
import { collectAllStories, findEntryById, findParentMenuId } from '../../store/projectModel';

export const NodeEditorContent = memo(function NodeEditorContent({
  node,
  selectedIds,
  project,
  projectIndex,
  projectType,
  allMenus,
  onUpdateRoot,
  onUpdateMedia,
  onUpdateStoryAudio,
  onUpdateMenu,
  onDeleteMenu,
  onUpdateItem,
  onDeleteItem,
  onBulkUpdateItems,
  onBulkDeleteItems,
}) {
  const isMultiSelect = selectedIds && selectedIds.size > 1;
  const parentMenuId = !isMultiSelect && (node?.type === 'story' || node?.type === 'menu') ? findParentMenuId(project, node.id, projectIndex) : null;
  const parentMenu = useMemo(
    () => (parentMenuId ? findEntryById(project, parentMenuId, projectIndex) : null),
    [parentMenuId, project, projectIndex],
  );
  const allStories = useMemo(() => collectAllStories(project, projectIndex), [project, projectIndex]);

  if (isMultiSelect) {
    return (
      <MultiEditor
        selectedIds={selectedIds}
        project={project}
        projectIndex={projectIndex}
        allMenus={allMenus}
        allStories={allStories}
        onBulkUpdateItems={onBulkUpdateItems}
        onBulkDeleteItems={onBulkDeleteItems}
      />
    );
  }

  if (!node) return null;

  if (node.type === 'root') {
    return (
      <RootEditor
        node={node}
        projectType={projectType}
        onUpdateRoot={onUpdateRoot}
        onUpdateMedia={onUpdateMedia}
        onUpdateStoryAudio={onUpdateStoryAudio}
      />
    );
  }

  if (node.type === 'menu') {
    return (
      <MenuEditor
        node={node}
        project={project}
        parentMenu={parentMenu}
        allMenus={allMenus}
        allStories={allStories}
        onUpdate={onUpdateMenu}
        onDelete={onDeleteMenu}
      />
    );
  }

  if (node.type === 'story') {
    return (
      <StoryEditor
        node={node}
        project={project}
        allMenus={allMenus}
        allStories={allStories}
        parentMenu={parentMenu}
        onUpdate={onUpdateItem}
        onDelete={onDeleteItem}
      />
    );
  }

  if (node.type === 'zip') {
    return (
      <ZipEditor
        node={node}
        onUpdate={onUpdateItem}
        onDelete={onDeleteItem}
      />
    );
  }

  if (node.type === 'ref') {
    return (
      <RefEditor
        node={node}
        allMenus={allMenus}
        allStories={allStories}
        onUpdate={onUpdateItem}
        onDelete={onDeleteItem}
      />
    );
  }

  return null;
});
