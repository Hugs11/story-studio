import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { TREE_COLOR_PALETTE } from '../tree/treeOperations';
import { hasVisibleEndNode } from '../../store/generatedNavigation';
import { getAssemblyReplacementEligibility, resolveAudioStoriesInProjectOrder } from '../../store/mediaToolContext';
import { END_NODE_ID } from './treePanelConstants';
import {
  IconArrowUpLeft,
  IconClipboardPaste,
  IconCopy,
  IconFolderOpen,
  IconFolderPlus,
  IconHouse,
  IconImport,
  IconMoon,
  IconPen,
  IconPlay,
  IconScissors,
  IconStory,
  IconTrash,
} from './TreeIcons';

// Construit les actions du menu contextuel de l'arbre (pendant tree du
// buildDiagramContextActions du diagramme).
export function buildTreeContextActions({
  nodeId,
  nodeType,
  project,
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
}) {
  const isRootCtx = nodeType === 'root' || nodeType === 'root-bg';
  const parentMenuId = isRootCtx ? null : getParentId(nodeId);
  const targetMenuId = nodeType === 'menu' ? nodeId : parentMenuId;
  const actions = [];

  if (nodeType === END_NODE_ID) {
    actions.push({ icon: <IconTrash />, label: 'Supprimer le message de fin', fn: () => onRemoveEndNode?.(), danger: true });
    return actions;
  }

  if (projectType === 'pack') {
    actions.push({ icon: <IconFolderPlus />, label: 'Créer un dossier', fn: () => onAddMenu(targetMenuId) });
    actions.push({ icon: <IconStory />, label: 'Importer audio ou archive', fn: () => onAddStory(targetMenuId) });
    if (onImportFolder) {
      actions.push({ icon: <IconImport />, label: 'Importer un dossier', fn: () => onImportFolder(targetMenuId) });
    }

    const hasEndNode = hasVisibleEndNode(project);
    if (isRootCtx && !hasEndNode) {
      actions.push('sep');
      actions.push({ icon: <IconMoon />, label: 'Ajouter un message de fin', fn: () => onAddEndNode?.() });
    }

    if (nodeType === 'root' && onDemoteRootToMenu && (project.rootEntries ?? []).length > 0) {
      actions.push('sep');
      actions.push({ icon: <IconArrowUpLeft />, label: 'Sortir de la racine', fn: onDemoteRootToMenu });
    }

    if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
      actions.push('sep');
      actions.push({ icon: <IconHouse />, label: 'Définir comme racine', fn: () => onSetMenuAsRoot(nodeId) });
    }

    if (nodeType === 'zip') {
      const item = getEntry(nodeId);
      if (item?.zipPath) {
        actions.push('sep');
        actions.push({ icon: <IconPlay />, label: 'Simuler ce pack…', fn: () => onSimulateZip(item.zipPath) });
        actions.push({ icon: <IconPen />, label: "Extraire l'histoire", fn: () => onUnpackZip(nodeId) });
      }
    }

    if (onSimulateNode && (nodeType === 'root' || nodeType === 'menu' || nodeType === 'story')) {
      actions.push('sep');
      actions.push({ icon: <IconPlay />, label: 'Simuler depuis ici', fn: () => onSimulateNode(nodeId) });
    }

    if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && parentMenuId != null) {
      actions.push('sep');
      actions.push({ icon: <IconArrowUpLeft />, label: 'Sortir du dossier', fn: () => onMoveToMenu(nodeId, parentMenuId, null) });
    }

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      actions.push('sep');
      actions.push({ icon: <IconCopy />, label: 'Dupliquer', fn: () => onDuplicate(nodeId) });
      actions.push({ icon: <IconClipboardPaste />, label: 'Copier', fn: () => handleCopy(nodeId) });
      actions.push({ icon: <IconScissors />, label: 'Couper', fn: () => handleCut(nodeId) });
    }

    if (clipboardRef.current?.entries?.length) {
      actions.push({ icon: <IconClipboardPaste />, label: 'Coller ici', fn: () => handlePaste(nodeId) });
    }

    if (nodeType === 'story') {
      const hasAudio = !!getEntry(nodeId)?.audio;
      actions.push({
        icon: <IconImport />,
        label: hasAudio ? 'Remplacer le fichier audio…' : 'Choisir un fichier audio…',
        fn: () => handleReplaceAudio(nodeId, nodeType),
      });
    }

    if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
      const audioClip = audioClipboard.getEntry();
      const audioCount = audioClip?.paths?.length ?? 1;
      actions.push({
        icon: <IconStory />,
        label: audioClip?.mode === 'cut'
          ? (audioCount > 1 ? `Déplacer ${audioCount} sons ici` : "Déplacer l'audio ici")
          : (audioCount > 1 ? `Coller ${audioCount} sons ici` : "Coller l'audio ici"),
        fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
      });
    }

    if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
      actions.push({
        icon: <IconImport />,
        label: imageClipboard.getEntry()?.mode === 'cut' ? "Déplacer l'image ici" : "Coller l'image ici",
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
          icon: <IconScissors />,
          label: 'Extraire ou découper l’audio dans Médias…',
          fn: () => {
            closeContextMenu();
            onOpenMediaAudioTool({
              origin: 'tree',
              tool: 'split',
              mode: 'extract',
              entryIds: audioContext.entryIds,
            });
          },
        });
      } else {
        const replacementEligibility = getAssemblyReplacementEligibility(project, audioContext.entryIds);
        actions.push({
          icon: <IconStory />,
          label: replacementEligibility.valid
            ? 'Assembler et remplacer les histoires…'
            : 'Assembler leurs audios dans Médias…',
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

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip' || nodeType === 'ref') {
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
        icon: <IconTrash />,
        label: selectedForDelete.length > 1 ? `Supprimer ${selectedForDelete.length} éléments` : 'Supprimer',
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
        ? `Couleur (${colorTargetIds.length + (includesRoot ? 1 : 0)} éléments)`
        : 'Couleur';

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
                title={currentColor === '__mixed__' ? 'Couleurs différentes — cliquer pour effacer' : 'Aucune couleur'}
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
  }

  // Afficher dans l'explorateur — uniquement pour les histoires.
  const entryForReveal = !isRootCtx ? getEntry(nodeId) : null;
  const revealFiles = [];
  if (nodeType === 'story' && entryForReveal) {
    if (entryForReveal.audio) revealFiles.push({ label: "l'audio", path: entryForReveal.audio });
    if (entryForReveal.image) revealFiles.push({ label: "l'image", path: entryForReveal.image });
  }
  if (revealFiles.length > 0) {
    actions.push('sep');
    if (revealFiles.length === 1) {
      actions.push({ icon: <IconFolderOpen />, label: "Afficher dans l'explorateur", fn: () => revealItemInDir(revealFiles[0].path) });
    } else {
      revealFiles.forEach(rf => {
        actions.push({ icon: <IconFolderOpen />, label: `Afficher ${rf.label} dans l'explorateur`, fn: () => revealItemInDir(rf.path) });
      });
    }
  }

  return actions;
}
