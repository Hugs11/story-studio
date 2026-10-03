import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { mediaDrag } from '../../store/dragState';
import { Tooltip } from '../common/Tooltip';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { Copy, Eye, FilePen, FolderOpen, Link2, Scissors, Trash2 } from '../icons/LucideLocal';
import { cleanPath, formatDate, getMetaDisplay, kindLabel, tagStyle } from './helpers';
import { useAudioDuration } from './useAudioDuration';
import { MediaThumb } from './MediaThumb';
import { TagSection } from './TagSection';
import { UsageBadge } from './UsageBadge';
import { resolveUsageTarget } from './usageTarget';

export function MediaTile({
  item, view, getMeta, markForProbe,
  index, isPopoverOpen, onActivate, onNavigate,
  itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag,
  mediaTags, onDeleteRequest, onAssemble, onSplit, onEditImage,
  isSelected, selectedItems, selectedAudioItems, onSelect, onContextMenuSelect,
  visibleCols, dropOnNode, onSelectNode, onRevealGraphNode,
}) {
  const usage = item.usages[0];
  const className = view === 'list' ? 'me-list-row' : 'media-tile';
  const [ctxMenu, setCtxMenu] = useState(null);
  const [duration, durationRef] = useAudioDuration(
    item.kind === 'audio' ? item.path : null,
    item.exists,
  );
  const m = getMeta ? getMeta(item.path) : null;

  useEffect(() => {
    if (view !== 'list' || !markForProbe || !item.exists || !item.path) return;
    const el = durationRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { markForProbe(item.path); obs.disconnect(); } },
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // Raison : markForProbe est passé par le parent et peut être recréé à chaque rendu ;
  // on observe seulement quand l'item ou la vue change, pas quand la prop fonction bouge.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, item.path, item.exists]);

  function handleContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    onContextMenuSelect?.(item, index);
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  // Une étiquette est posée **sur un chemin**. Une référence du document sans
  // fichier lié n'en a pas : offrir le geste le rendrait silencieusement sans
  // effet, ce qui est pire que de ne pas l'offrir.
  const hasTagActions = Boolean(onAddMediaTag && onRemoveMediaTag && item.path);
  const mediaClipboard = item.kind === 'audio' ? audioClipboard : item.kind === 'image' ? imageClipboard : null;
  const contextItems = isSelected && selectedItems.length > 1 ? selectedItems : [item];
  const contextAudioItems = isSelected && selectedAudioItems.length > 1 && item.kind === 'audio' ? selectedAudioItems : (item.kind === 'audio' ? [item] : []);
  const clipboardPaths = contextAudioItems.length > 1 ? contextAudioItems.map((audio) => audio.path) : [item.path];
  const tagPaths = contextItems.map((selectedItem) => selectedItem.path);

  const usageTarget = resolveUsageTarget(item, { onSelectNode, onRevealGraphNode });

  const ctxActions = [
    ...(mediaClipboard ? [
      { icon: <Copy />, label: clipboardPaths.length > 1 ? `Copier ${clipboardPaths.length} sons` : 'Copier le média', fn: () => mediaClipboard.set(clipboardPaths) },
      'sep',
    ] : []),
    { icon: <FolderOpen />, label: "Révéler dans l'explorateur", fn: () => revealItemInDir(item.path) },
    { icon: <Copy />, label: 'Copier le chemin', fn: () => navigator.clipboard.writeText(item.path).catch(() => {}) },
    ...(usageTarget ? [
      { icon: <Eye />, label: 'Voir l’utilisation dans le projet', fn: () => usageTarget.go() },
    ] : []),
    ...(onAssemble && contextAudioItems.length >= 2 ? [
      'sep',
      { icon: <Link2 />, label: `Assembler ${contextAudioItems.length} sons`, fn: () => onAssemble() },
    ] : []),
    ...(onSplit && item.kind === 'audio' && item.exists ? [
      'sep',
      { icon: <Scissors />, label: 'Découper un audio', fn: () => onSplit(item) },
    ] : []),
    ...(onEditImage && item.kind === 'image' && item.exists ? [
      'sep',
      { icon: <FilePen />, label: 'Modifier l’image…', fn: () => onEditImage(item) },
    ] : []),
    ...(onDeleteRequest ? [
      'sep',
      {
        icon: <Trash2 />,
        label: contextItems.length > 1
          ? `Retirer ${contextItems.length} fichiers de la médiathèque`
          : 'Retirer de la médiathèque',
        fn: () => onDeleteRequest(contextItems),
        danger: true,
      },
    ] : []),
    ...(hasTagActions ? [
      'sep',
      {
        type: 'node',
        render: () => (
          <TagSection
            paths={tagPaths}
            mediaTags={mediaTags}
            itemTags={itemTags}
            allProjectTags={allProjectTags}
            onAddMediaTag={onAddMediaTag}
            onRemoveMediaTag={onRemoveMediaTag}
          />
        ),
      },
    ] : []),
  ];

  function handlePointerDown(e) {
    if (!item.exists || e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const dragPaths = item.kind === 'audio' && isSelected && selectedAudioItems.length > 1
      ? selectedAudioItems.map((audio) => audio.path)
      : [item.path];
    let dragging = false;
    let ghost = null;
    let currentTarget = null;
    let currentTargetKind = null; // 'field' | 'node' | 'graph' — stored from last onMove
    const ghostLabel = dragPaths.length > 1 ? `${dragPaths.length} sons` : item.name;

    function findTarget(x, y) {
      const els = document.elementsFromPoint(x, y);
      // Field drop targets (AudioField / ImageField)
      const fieldTarget = els.find((el) => el.dataset.dropKind === item.kind);
      if (fieldTarget) return { el: fieldTarget, kind: 'field' };
      // Tree / full-diagram node targets (story / menu / root)
      if (item.kind === 'audio' || item.kind === 'image') {
        const treeTarget = els.find((el) => el.dataset.mediaNodeId);
        if (treeTarget) return { el: treeTarget, kind: 'node' };
        // Canvas de l'éditeur graphe. Il ne peint aucun nœud dans le DOM : la
        // cible n'est donc pas l'élément survolé, mais celle que l'étage de
        // canvas rend quand on la lui demande.
        const graphTarget = els.find((el) => el.dataset.mediaGraphDrop);
        if (graphTarget) return { el: graphTarget, kind: 'graph' };
      }
      return null;
    }

    // Survol du canvas du graphe : question synchrone, réponse dans le même
    // tour de boucle. Le nom de l'Écran visé rejoint le fantôme, parce que rien
    // sur le canvas ne peut s'éclairer à sa place.
    function askGraphTarget(el) {
      const detail = { kind: item.kind, target: null };
      el.dispatchEvent(new CustomEvent('media-drag-over', { bubbles: false, detail }));
      return detail.target?.label ?? null;
    }

    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return;
        dragging = true;
        window.getSelection()?.removeAllRanges();
        document.documentElement.classList.add('is-media-dragging');
        mediaDrag.start(item.kind, item.path);
        ghost = document.createElement('div');
        ghost.className = 'media-drag-ghost';
        ghost.textContent = ghostLabel;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY - 14}px`;

      const hit = findTarget(ev.clientX, ev.clientY);
      const graphLabel = hit?.kind === 'graph' ? askGraphTarget(hit.el) : null;
      // Sur le canvas, survoler le vide n'est pas survoler un Écran : sans nœud
      // sous le pointeur, il n'y a pas de cible, et le fantôme le dit.
      const newTarget = hit && (hit.kind !== 'graph' || graphLabel) ? hit.el : null;
      ghost.textContent = graphLabel ? `${ghostLabel} → ${graphLabel}` : ghostLabel;
      if (newTarget !== currentTarget) {
        currentTarget?.classList.remove('is-drop-over');
        newTarget?.classList.add('is-drop-over');
        currentTarget = newTarget;
        currentTargetKind = hit?.kind ?? null;
        ghost.classList.toggle('is-over-target', !!newTarget);
      }
    }

    function cleanup() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      document.documentElement.classList.remove('is-media-dragging');
      if (ghost) { document.body.removeChild(ghost); ghost = null; }
      currentTarget?.classList.remove('is-drop-over');
    }

    function onUp() {
      cleanup();
      if (dragging && currentTarget && currentTargetKind) {
        if (currentTargetKind === 'field') {
          currentTarget.dispatchEvent(new CustomEvent('media-drop', {
            bubbles: false,
            detail: { path: item.path, kind: item.kind },
          }));
        } else if (currentTargetKind === 'node') {
          void dropOnNode?.({
            nodeId: currentTarget.dataset.mediaNodeId,
            nodeType: currentTarget.dataset.mediaNodeType,
            path: item.path,
            paths: dragPaths,
            kind: item.kind,
          });
        } else if (currentTargetKind === 'graph') {
          // L'étage de canvas relit le nœud survolé au moment du relâchement :
          // la cible n'est pas celle du dernier mouvement, mais celle que le
          // moteur a sous le pointeur maintenant.
          currentTarget.dispatchEvent(new CustomEvent('media-drop', {
            bubbles: false,
            detail: { path: item.path, paths: dragPaths, kind: item.kind },
          }));
        }
      }
      mediaDrag.end();
    }

    function onCancel() {
      cleanup();
      mediaDrag.end();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }

  async function handleOpen() {
    try {
      await openPath(item.path);
    } catch {
      // Best effort only.
    }
  }

  const { size: sizeDisp, dim: dimDisp, dur: durDisp, fmt: fmtDisp } = getMetaDisplay(item, m, duration);
  const usageSuffix = item.usageKnown === false
    ? ' · usages non calculés'
    : (item.usedCount > 1 ? ` ×${item.usedCount}` : '');
  const usageText = `${kindLabel(item.kind)} · ${usage?.label || item.source}${usageSuffix}`;

  return (
    <>
      <div
        ref={durationRef}
        data-tile-idx={index}
        data-media-id={item.id}
        className={`${className}${item.exists ? '' : ' is-missing'}${isPopoverOpen ? ' is-popover-active' : ''}${isSelected ? ' is-selected' : ''}`}
        role="button"
        aria-selected={isSelected}
        tabIndex={0}
        onClick={(e) => onSelect?.(item, index, e)}
        onPointerDown={handlePointerDown}
        onDragStart={(e) => e.preventDefault()}
        onDoubleClick={() => onActivate?.(index)}
        onContextMenu={handleContextMenu}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            if (isPopoverOpen) { onNavigate?.(null); } else { onActivate?.(index); }
          }
          if (e.key === 'Enter') handleOpen();
          if (isPopoverOpen && e.key === 'ArrowDown') { e.preventDefault(); onNavigate?.(1); }
          if (isPopoverOpen && e.key === 'ArrowUp') { e.preventDefault(); onNavigate?.(-1); }
        }}
      >
        <div className="media-thumb-wrap">
          <MediaThumb item={item} compact={view === 'list'} />
          <UsageBadge count={item.projectUsedCount} known={item.usageKnown !== false} />
          {!item.exists && (
            <span
              className="media-missing-badge"
              title={`Fichier introuvable :\n${cleanPath(item.path)}`}
            >!</span>
          )}
          {duration && view !== 'list' && (
            <span className="media-duration-badge">{duration}</span>
          )}
          {view !== 'list' && itemTags.length > 0 && (
            <div className="media-tile-tags">
              {itemTags.map((tag) => (
                <span key={tag} className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
              ))}
            </div>
          )}
        </div>

        {view === 'list' ? (
          <>
            {visibleCols?.has('name') !== false && (
              <Tooltip text={cleanPath(item.path)} placement="above" wrap className="media-name-col">
                <span className="media-item-name">{item.name}</span>
              </Tooltip>
            )}
            {visibleCols?.has('usage') !== false && <span className="media-col media-col--usage">{usageText}</span>}
            {visibleCols?.has('size') !== false && <span className="media-col media-col--size">{sizeDisp}</span>}
            {visibleCols?.has('dim') !== false && <span className="media-col media-col--dim">{dimDisp}</span>}
            {visibleCols?.has('dur') !== false && <span className="media-col media-col--dur">{durDisp}</span>}
            {visibleCols?.has('fmt') !== false && <span className="media-col media-col--fmt">{fmtDisp}</span>}
            {visibleCols?.has('date') !== false && <span className="media-col media-col--date">{formatDate(m?.modified_at)}</span>}
            {visibleCols?.has('path') !== false && <span className="media-col media-col--path" title={cleanPath(item.path)}>{cleanPath(item.path)}</span>}
            {visibleCols?.has('tags') !== false && (
              <span className="media-col media-col--tags">
                {itemTags.map((tag) => (
                  <span key={tag} className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
                ))}
              </span>
            )}
          </>
        ) : (
          <span className="media-item-main">
            <span className="media-item-name">{item.name}</span>
            <span className="media-item-meta">
              {usageText}
              {duration ? ` · ${duration}` : ''}
            </span>
          </span>
        )}

      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          actions={ctxActions}
        />
      )}
    </>
  );
}
