import { findEntryById, findParentMenuId } from '../../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../../store/fieldClipboard';
import { TREE_COLOR_PALETTE } from '../../tree/treeOperations';
import { Copy, Scissors, ClipboardPaste, Trash2, FolderPlus, Music, Image as ImageIcon, Moon, House, FilePen, Play } from '../../icons/LucideLocal';
import { END_NODE_ID } from '../flowDiagramLayout';
import { resolveAudioStoriesInProjectOrder } from '../../../store/mediaToolContext';

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
}) {
  if (nodeId === END_NODE_ID) {
    return [{ icon: <Trash2 />, label: 'Supprimer le message de fin', fn: () => onRemoveEndNode?.(), danger: true }];
  }

  const entry = findEntryById(project, nodeId, projectIndex);
  const menuId = nodeType === 'menu'
    ? nodeId
    : (findParentMenuId(project, nodeId, projectIndex) ?? null);
  const actions = [];

  actions.push({ icon: <FolderPlus />, label: 'Ajouter un dossier', fn: () => onAddMenu?.(menuId) });
  actions.push({ icon: <Music />, label: 'Importer audio ou archive', fn: () => onAddStory?.(menuId) });

  const hasEndNode = !!(project.nightModeAudio || project.globalOptions?.nightMode || project.globalOptions?.endNode);
  if (nodeType === 'root' && !hasEndNode) {
    actions.push('sep');
    actions.push({ icon: <Moon />, label: 'Ajouter un message de fin', fn: () => onAddEndNode?.() });
  }

  if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
    actions.push('sep');
    actions.push({ icon: <House />, label: 'Définir comme racine', fn: () => onSetMenuAsRoot(nodeId) });
  }

  if (nodeType === 'zip' && entry?.zipPath) {
    actions.push('sep');
    actions.push({ icon: <Play />, label: 'Simuler ce pack…', fn: () => onSimulateZip?.(entry.zipPath) });
    actions.push({ icon: <FilePen />, label: "Extraire l'histoire", fn: () => onUnpackZip?.(nodeId) });
  }

  if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && menuId != null) {
    actions.push('sep');
    actions.push({ icon: '↖', label: 'Sortir du dossier', fn: () => onMoveToMenu?.(nodeId, menuId, null) });
  }

  if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
    actions.push('sep');
    actions.push({ icon: '⧉', label: 'Dupliquer', fn: () => onDuplicate?.(nodeId) });
    actions.push({ icon: <Copy />, label: 'Copier', fn: () => handleCopy(nodeId) });
    actions.push({ icon: <Scissors />, label: 'Couper', fn: () => handleCut(nodeId) });
  }

  if (clipboardRef.current?.entries?.length) {
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    actions.push({ icon: <ClipboardPaste />, label: 'Coller ici', fn: () => handlePaste(nodeId) });
  }

  if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
    const audioClip = audioClipboard.getEntry();
    const audioCount = audioClip?.paths?.length ?? 1;
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    actions.push({
      icon: <Music />,
      label: audioClip?.mode === 'cut'
        ? (audioCount > 1 ? `Déplacer ${audioCount} sons ici` : "Déplacer l'audio ici")
        : (audioCount > 1 ? `Coller ${audioCount} sons ici` : "Coller l'audio ici"),
      fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
    });
  }

  if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
    if (!actions.some((action) => action === 'sep')) actions.push('sep');
    actions.push({
      icon: <ImageIcon />,
      label: imageClipboard.getEntry()?.mode === 'cut' ? "Déplacer l'image ici" : "Coller l'image ici",
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
        label: 'Extraire ou découper l’audio dans Médias…',
        fn: () => {
          closeContextMenu();
          onOpenMediaAudioTool({
            origin: 'diagram',
            tool: 'split',
            mode: 'extract',
            entryIds: audioContext.entryIds,
          });
        },
      });
    } else {
      actions.push({
        icon: <Music />,
        label: 'Assembler leurs audios dans Médias…',
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

  if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip' || nodeType === 'ref') {
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
      label: selectedForDelete.length > 1 ? `Supprimer ${selectedForDelete.length} éléments` : 'Supprimer',
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

  return actions;
}
