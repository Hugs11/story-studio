import { translateTree as t } from '../../i18n/treePresentation.js';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { NodeColorPicker } from '../tree/NodeColorPicker.jsx';
import { hasVisibleEndNode } from '../../store/generatedNavigation';
import {
  MENU_DEPTH_LIMIT_REACHED_MESSAGE,
  validateMenuDepthPlacement,
} from '../../store/projectModel/menuDepth.js';
import { getAssemblyReplacementEligibility, resolveAudioStoriesInProjectOrder } from '../../store/mediaToolContext';
import { END_NODE_ID } from './treePanelConstants';
import {
  ArrowUpRight,
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  FolderPlus,
  House,
  Moon,
  Music,
  PenLine,
  Play,
  Scissors,
  SquareStack,
  Trash2,
} from '../icons/LucideLocal';

// Construit les actions du menu contextuel de l'arbre (pendant tree du
// buildDiagramContextActions du diagramme).
export function buildTreeContextActions({
  nodeId,
  nodeType,
  project,
  projectIndex,
  projectType,
  selectedIds,
  getEntry,
  getParentId,
  clipboardRef,
  getTopLevelSelected,
  handleCopy,
  handleCut,
  handlePaste,
  handlePasteMedia,
  handleReplaceAudio,
  callOnSelect,
  onSelectionChange,
  onAddMenu,
  onAddStory,
  onImportFolder,
  onAddEndNode,
  onRemoveEndNode,
  onDemoteRootToMenu,
  onSetMenuAsRoot,
  onSimulateZip,
  onUnpackZip,
  onSimulateNode,
  onMoveToMenu,
  onDuplicate,
  onDeleteMenu,
  onDeleteItem,
  onBulkDeleteItems,
  onBulkUpdateItems,
  onSetNodeColor,
  onOpenMediaAudioTool,
  closeContextMenu,
  // Relire les raccourcis à l’affichage : une action peut survivre au changement de langue.
  shortcutLabels = {},
}) {
  const isRootCtx = nodeType === 'root' || nodeType === 'root-bg';
  const parentMenuId = isRootCtx ? null : getParentId(nodeId);
  const targetMenuId = nodeType === 'menu' ? nodeId : parentMenuId;
  const actions = [];

  if (nodeType === END_NODE_ID) {
    actions.push({ icon: <Trash2 />, label: t("tree:endNode.delete.action"), fn: () => onRemoveEndNode?.(), danger: true });
    return actions;
  }

  if (projectType === 'pack') {
    const addFolderDepth = validateMenuDepthPlacement(
      project,
      targetMenuId,
      [{ type: 'menu', children: [] }],
      projectIndex,
    );
    actions.push({
      icon: <FolderPlus />,
      label: t("common:structure.folder.create"),
      fn: () => onAddMenu(targetMenuId),
      disabledReason: addFolderDepth.allowed ? null : MENU_DEPTH_LIMIT_REACHED_MESSAGE,
    });
    actions.push({ icon: <Music />, label: t("tree:context.media.import"), fn: () => onAddStory(targetMenuId) });
    if (onImportFolder) {
      actions.push({ icon: <Download />, label: t("common:structure.folder.import"), fn: () => onImportFolder(targetMenuId) });
    }

    const hasEndNode = hasVisibleEndNode(project);
    if (isRootCtx && !hasEndNode) {
      actions.push('sep');
      actions.push({ icon: <Moon />, label: t("tree:context.end.add"), fn: () => onAddEndNode?.() });
    }

    if (nodeType === 'root' && onDemoteRootToMenu && (project.rootEntries ?? []).length > 0) {
      const demoteDepth = validateMenuDepthPlacement(
        project,
        null,
        [{ type: 'menu', children: project.rootEntries ?? [] }],
        projectIndex,
      );
      actions.push('sep');
      actions.push({
        icon: <ArrowUpRight />,
        label: t("tree:context.root.demote"),
        fn: onDemoteRootToMenu,
        disabledReason: demoteDepth.allowed ? null : MENU_DEPTH_LIMIT_REACHED_MESSAGE,
      });
    }

    if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
      actions.push('sep');
      actions.push({ icon: <House />, label: t("tree:context.root.promote"), fn: () => onSetMenuAsRoot(nodeId) });
    }

    if (nodeType === 'zip') {
      const item = getEntry(nodeId);
      if (item?.zipPath) {
        actions.push('sep');
        actions.push({ icon: <Play />, label: t("tree:context.pack.preview"), fn: () => onSimulateZip(item.zipPath) });
        actions.push({ icon: <PenLine />, label: t("tree:context.story.extract"), fn: () => onUnpackZip(nodeId) });
      }
    }

    if (onSimulateNode && (nodeType === 'root' || nodeType === 'menu' || nodeType === 'story')) {
      actions.push('sep');
      actions.push({ icon: <Play />, label: t("tree:context.node.preview"), fn: () => onSimulateNode(nodeId) });
    }

    if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && parentMenuId != null) {
      actions.push('sep');
      actions.push({ icon: <ArrowUpRight />, label: t("tree:context.folder.moveOut"), fn: () => onMoveToMenu(nodeId, parentMenuId, null) });
    }

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      actions.push('sep');
      // Trois gestes, trois dessins : deux gestes distincts ne doivent pas se
      // ressembler.
      actions.push({ icon: <SquareStack />, label: t("tree:context.node.duplicate"), fn: () => onDuplicate(nodeId), get shortcut() { return shortcutLabels.selectionDuplicate ?? null; } });
      actions.push({ icon: <Copy />, label: t("tree:media.clipboard.copy"), fn: () => handleCopy(nodeId), get shortcut() { return shortcutLabels.selectionCopy ?? null; } });
      actions.push({ icon: <Scissors />, label: t("tree:media.clipboard.cut"), fn: () => handleCut(nodeId), get shortcut() { return shortcutLabels.selectionCut ?? null; } });
    }

    if (clipboardRef.current?.entries?.length) {
      const pasteDepth = validateMenuDepthPlacement(
        project,
        targetMenuId,
        clipboardRef.current.entries,
        projectIndex,
      );
      const targetPath = targetMenuId == null ? [] : (projectIndex?.pathById?.get(targetMenuId) ?? []);
      const pasteCreatesCycle = clipboardRef.current.isCut
        && targetPath.some((entry) => clipboardRef.current.sourceIds?.includes(entry.id));
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

    if (nodeType === 'story') {
      const hasAudio = !!getEntry(nodeId)?.audio;
      actions.push({
        icon: <Download />,
        label: hasAudio ? t("tree:context.audio.replace") : t("tree:audio.file.chooseDialog"),
        fn: () => handleReplaceAudio(nodeId, nodeType),
      });
    }

    if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
      const audioClip = audioClipboard.getEntry();
      const audioCount = audioClip?.paths?.length ?? 1;
      actions.push({
        icon: <Music />,
        label: audioClip?.mode === 'cut'
          ? (audioCount > 1 ? t("tree:context.audio.moveCount", { count: audioCount }) : t("tree:context.audio.move"))
          : (audioCount > 1 ? t("tree:context.audio.pasteCount", { count: audioCount }) : t("tree:context.audio.paste")),
        fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
      });
    }

    if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
      actions.push({
        icon: <Download />,
        label: imageClipboard.getEntry()?.mode === 'cut' ? t("tree:context.image.move") : t("tree:context.image.paste"),
        fn: () => handlePasteMedia(nodeId, nodeType, 'image'),
      });
    }

    const selectedForAudio = !isRootCtx && selectedIds.has(nodeId) && selectedIds.size > 1
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
              origin: 'tree',
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
              origin: 'tree',
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
      const selectedForDelete = selectedIds.has(nodeId) && selectedIds.size > 1
        ? getTopLevelSelected()
        : [nodeId];
      const deleteFn = selectedForDelete.length > 1
        ? () => {
          onBulkDeleteItems?.(selectedForDelete);
          onSelectionChange?.(new Set(['root']));
          callOnSelect('root');
        }
        : nodeType === 'menu'
          ? () => onDeleteMenu(nodeId)
          : () => onDeleteItem(nodeId);
      actions.push({
        icon: <Trash2 />,
        label: selectedForDelete.length > 1 ? t("tree:context.node.deleteCount", { count: selectedForDelete.length }) : t("common:dialog.delete.label"),
        get shortcut() { return shortcutLabels.selectionDelete ?? null; },
        fn: deleteFn,
        danger: true,
      });
    }

    if (isRootCtx || nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      const isMultiTarget = !isRootCtx && selectedIds.has(nodeId) && selectedIds.size > 1;
      const colorTargetIds = isMultiTarget
        ? getTopLevelSelected().filter((id) => id !== 'root')
        : (isRootCtx ? [] : [nodeId]);
      const includesRoot = isMultiTarget && selectedIds.has('root');

      let currentColor;
      if (isMultiTarget) {
        const colors = colorTargetIds.map((id) => getEntry(id)?.treeColor ?? null);
        if (includesRoot) colors.push(project.treeColor ?? null);
        const unique = [...new Set(colors)];
        currentColor = unique.length === 1 ? unique[0] : '__mixed__';
      } else if (isRootCtx) {
        currentColor = project.treeColor ?? null;
      } else {
        currentColor = getEntry(nodeId)?.treeColor ?? null;
      }

      const applyColor = (color) => {
        if (isMultiTarget) {
          if (colorTargetIds.length > 0) {
            onBulkUpdateItems?.(colorTargetIds, () => ({ treeColor: color }));
          }
          if (includesRoot) {
            onSetNodeColor?.('root', 'root', color);
          }
        } else {
          onSetNodeColor?.(nodeId, nodeType, color);
        }
      };

      const headerLabel = isMultiTarget
        ? t("tree:context.color.selectionCount", { count: colorTargetIds.length + (includesRoot ? 1 : 0) })
        : t("tree:multi.color.label");

      actions.push('sep');
      actions.push({
        type: 'node',
        render: () => (
          <NodeColorPicker
            label={headerLabel}
            currentColor={currentColor}
            onChange={(color) => {
              applyColor(color);
              closeContextMenu();
            }}
          />
        ),
      });
    }
  }

  // Afficher dans l'explorateur — uniquement pour les histoires.
  const entryForReveal = !isRootCtx ? getEntry(nodeId) : null;
  const revealFiles = [];
  if (nodeType === 'story' && entryForReveal) {
    if (entryForReveal.audio) revealFiles.push({ label: t('tree:context.file.audio'), path: entryForReveal.audio });
    if (entryForReveal.image) revealFiles.push({ label: t('tree:context.file.image'), path: entryForReveal.image });
  }
  if (revealFiles.length > 0) {
    actions.push('sep');
    if (revealFiles.length === 1) {
      actions.push({ icon: <FolderOpen />, label: t("tree:media.file.reveal"), fn: () => revealItemInDir(revealFiles[0].path) });
    } else {
      revealFiles.forEach(rf => {
        actions.push({ icon: <FolderOpen />, label: t("tree:context.file.revealNamed", { label: rf.label }), fn: () => revealItemInDir(rf.path) });
      });
    }
  }

  return actions;
}
