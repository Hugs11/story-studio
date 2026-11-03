import { translateTree as t } from '../../../i18n/treePresentation.js';
import { findEntryById, findParentMenuId } from '../../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../../store/fieldClipboard';
import { TREE_COLOR_PALETTE } from '../../tree/treeOperations';
import { Copy, Scissors, ClipboardPaste, Trash2, FolderPlus, Music, Image as ImageIcon, Moon, House, FilePen, Play } from '../../icons/LucideLocal';
import { END_NODE_ID } from '../flowDiagramLayout';
import { getAssemblyReplacementEligibility, resolveAudioStoriesInProjectOrder } from '../../../store/mediaToolContext';
import {
  MENU_DEPTH_LIMIT_REACHED_MESSAGE,
  validateMenuDepthPlacement,
} from '../../../store/projectModel/menuDepth.js';

function setNodeColor({ nodeId, nodeType, color, onUpdateMedia, onUpdateMenu, onUpdateItem }) {
  const fields = { treeColor: color };
  if (nodeType === 'root') {
    onUpdateMedia?.('treeColor', color);
  } else if (nodeType === 'menu') {
    onUpdateMenu?.(fields, nodeId);
  } else {
    onUpdateItem?.(fields, nodeId);
  }
}

export function buildDiagramContextActions({
  project,
  projectIndex,
  selectedIds,
  nodeId,
  nodeType,
  clipboardRef,
  onMoveToMenu,
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSimulateZip,
  onSetMenuAsRoot,
  onDeleteMenu,
  onDeleteItem,
  onBulkUpdateItems,
  onUpdateMedia,
  onUpdateMenu,
  onUpdateItem,
  onDuplicate,
  onAddEndNode,
  onRemoveEndNode,
  onOpenMediaAudioTool,
  getTopLevelSelected,
  handleCopy,
  handleCut,
  handlePaste,
  handlePasteMedia,
  handleDeleteSelection,
  closeContextMenu,
  // Relire les raccourcis à l’affichage : une action peut survivre au changement de langue.
  shortcutLabels = {},
}) {
  if (nodeId === END_NODE_ID) {
    return [{ icon: <Trash2 />, label: t("tree:endNode.delete.action"), fn: () => onRemoveEndNode?.(), danger: true }];
  }

  const entry = findEntryById(project, nodeId, projectIndex);
  const menuId = nodeType === 'menu'
    ? nodeId
    : (findParentMenuId(project, nodeId, projectIndex) ?? null);
  const actions = [];

  const addFolderDepth = validateMenuDepthPlacement(
    project,
    menuId,
    [{ type: 'menu', children: [] }],
    projectIndex,
  );
  actions.push({
    icon: <FolderPlus />,
    label: t("tree:context.folder.add"),
    fn: () => onAddMenu?.(menuId),
    disabledReason: addFolderDepth.allowed ? null : MENU_DEPTH_LIMIT_REACHED_MESSAGE,
  });
  actions.push({ icon: <Music />, label: t("tree:context.media.import"), fn: () => onAddStory?.(menuId) });

  const hasEndNode = !!(project.nightModeAudio || project.globalOptions?.nightMode || project.globalOptions?.endNode);
  if (nodeType === 'root' && !hasEndNode) {
    actions.push('sep');
    actions.push({ icon: <Moon />, label: t("tree:context.end.add"), fn: () => onAddEndNode?.() });
  }

  if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
    actions.push('sep');
    actions.push({ icon: <House />, label: t("tree:context.root.promote"), fn: () => onSetMenuAsRoot(nodeId) });
  }

  if (nodeType === 'zip' && entry?.zipPath) {
    actions.push('sep');
    actions.push({ icon: <Play />, label: t("tree:context.pack.preview"), fn: () => onSimulateZip?.(entry.zipPath) });
    actions.push({ icon: <FilePen />, label: t("tree:context.story.extract"), fn: () => onUnpackZip?.(nodeId) });
  }

  if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && menuId != null) {
    actions.push('sep');
    actions.push({ icon: '↖', label: t("tree:context.folder.moveOut"), fn: () => onMoveToMenu?.(nodeId, menuId, null) });
  }

  if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
    actions.push('sep');
    actions.push({ icon: '⧉', label: t("tree:context.node.duplicate"), fn: () => onDuplicate?.(nodeId), get shortcut() { return shortcutLabels.selectionDuplicate ?? null; } });
    actions.push({ icon: <Copy />, label: t("tree:media.clipboard.copy"), fn: () => handleCopy(nodeId), get shortcut() { return shortcutLabels.selectionCopy ?? null; } });
    actions.push({ icon: <Scissors />, label: t("tree:media.clipboard.cut"), fn: () => handleCut(nodeId), get shortcut() { return shortcutLabels.selectionCut ?? null; } });
  }

  if (clipboardRef.current?.entries?.length) {
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    const pasteDepth = validateMenuDepthPlacement(
      project,
      menuId,
      clipboardRef.current.entries,
      projectIndex,
    );
    const targetPath = menuId == null ? [] : (projectIndex?.pathById?.get(menuId) ?? []);
    const pasteCreatesCycle = clipboardRef.current.isCut
      && targetPath.some((pathEntry) => clipboardRef.current.sourceIds?.includes(pathEntry.id));
    actions.push({
      icon: <ClipboardPaste />,
      label: t("tree:context.node.paste"),
      get shortcut() { return shortcutLabels.selectionPaste ?? null; },
      fn: () => handlePaste(nodeId),
      disabledReason: pasteCreatesCycle
        ? t("tree:context.folder.cycle")
        : pasteDepth.allowed ? null : MENU_DEPTH_LIMIT_REACHED_MESSAGE,
    });
  }

  if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
    const audioClip = audioClipboard.getEntry();
    const audioCount = audioClip?.paths?.length ?? 1;
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    actions.push({
      icon: <Music />,
      label: audioClip?.mode === 'cut'
        ? (audioCount > 1 ? t("tree:context.audio.moveCount", { count: audioCount }) : t("tree:context.audio.move"))
        : (audioCount > 1 ? t("tree:context.audio.pasteCount", { count: audioCount }) : t("tree:context.audio.paste")),
      fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
    });
  }

  if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    actions.push({
      icon: <ImageIcon />,
      label: imageClipboard.getEntry()?.mode === 'cut' ? t("tree:context.image.move") : t("tree:context.image.paste"),
      fn: () => handlePasteMedia(nodeId, nodeType, 'image'),
    });
  }

  const selectedForAudio = selectedIds?.has(nodeId) && selectedIds?.size > 1
    ? [...selectedIds]
    : [nodeId];
  const audioContext = resolveAudioStoriesInProjectOrder(project, selectedForAudio);
  if (onOpenMediaAudioTool && audioContext.valid) {
    actions.push('sep');
    if (audioContext.stories.length === 1) {
      actions.push({
        icon: <Scissors />,
        label: t("tree:context.audio.split"),
        fn: () => {
          closeContextMenu();
          onOpenMediaAudioTool({
            origin: 'diagram',
            tool: 'split',
            entryIds: audioContext.entryIds,
          });
        },
      });
    } else {
      const replacementEligibility = getAssemblyReplacementEligibility(project, audioContext.entryIds);
      actions.push({
        icon: <Music />,
        label: replacementEligibility.valid
          ? t("tree:context.audio.assembleReplace")
          : t("tree:context.audio.assembleCount", { count: audioContext.stories.length }),
        fn: () => {
          closeContextMenu();
          onOpenMediaAudioTool({
            origin: 'diagram',
            tool: 'assemble',
            mode: 'assemble',
            entryIds: audioContext.entryIds,
          });
        },
      });
    }
  }

  if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
    actions.push('sep');
    const selectedForDelete = selectedIds?.has(nodeId) && selectedIds?.size > 1
      ? getTopLevelSelected(nodeId)
      : [nodeId];
    const deleteFn = selectedForDelete.length > 1
      ? () => handleDeleteSelection(nodeId)
      : nodeType === 'menu'
        ? () => onDeleteMenu?.(nodeId)
        : () => onDeleteItem?.(nodeId);
    actions.push({
      icon: <Trash2 />,
      label: selectedForDelete.length > 1 ? t("tree:context.node.deleteCount", { count: selectedForDelete.length }) : t("common:dialog.delete.label"),
      get shortcut() { return shortcutLabels.selectionDelete ?? null; },
      fn: deleteFn,
      danger: true,
    });
  }

  if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
    const isMultiTarget = selectedIds?.has(nodeId) && selectedIds?.size > 1;
    const colorTargetIds = isMultiTarget
      ? getTopLevelSelected(nodeId).filter((id) => id !== 'root')
      : [nodeId];
    const includesRoot = isMultiTarget && selectedIds?.has('root');

    let currentColor;
    if (isMultiTarget) {
      const colors = colorTargetIds.map((id) => findEntryById(project, id, projectIndex)?.treeColor ?? null);
      if (includesRoot) colors.push(project.treeColor ?? null);
      const unique = [...new Set(colors)];
      currentColor = unique.length === 1 ? unique[0] : '__mixed__';
    } else {
      currentColor = entry?.treeColor ?? null;
    }

    const applyColor = (color) => {
      if (isMultiTarget) {
        if (colorTargetIds.length > 0) {
          onBulkUpdateItems?.(colorTargetIds, () => ({ treeColor: color }));
        }
        if (includesRoot) {
          setNodeColor({ nodeId: 'root', nodeType: 'root', color, onUpdateMedia, onUpdateMenu, onUpdateItem });
        }
      } else {
        setNodeColor({ nodeId, nodeType, color, onUpdateMedia, onUpdateMenu, onUpdateItem });
      }
    };

    const headerLabel = isMultiTarget
      ? t("tree:context.color.selectionCount", { count: colorTargetIds.length + (includesRoot ? 1 : 0) })
      : t("tree:multi.color.label");

    actions.push('sep');
    actions.push({
      type: 'node',
      render: () => (
        <div className="ctx-color-section">
          <div className="ctx-color-header">{headerLabel}</div>
          <div className="ctx-color-row">
            {TREE_COLOR_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
                style={{ backgroundColor: color }}
                title={color}
                onClick={() => {
                  applyColor(color);
                  closeContextMenu();
                }}
              />
            ))}
            <button
              type="button"
              className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
              title={currentColor === '__mixed__' ? t("tree:multi.color.clearMixed") : t("tree:multi.color.none")}
              onClick={() => {
                applyColor(null);
                closeContextMenu();
              }}
            >
              ×
            </button>
          </div>
        </div>
      ),
    });
  }

  return actions;
}
