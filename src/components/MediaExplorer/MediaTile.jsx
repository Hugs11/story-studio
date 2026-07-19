import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { mediaDrag } from '../../store/dragState';
import { Tooltip } from '../common/Tooltip';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { Copy, FolderOpen, Link2, Scissors, Trash2 } from '../icons/LucideLocal';
import { cleanPath, formatDate, getMetaDisplay, kindLabel, tagStyle } from './helpers';
import { useAudioDuration } from './useAudioDuration';
import { MediaThumb } from './MediaThumb';
import { TagSection } from './TagSection';
import { UsageBadge } from './UsageBadge';

export function MediaTile({
  item, view, getMeta, markForProbe,
  index, isPopoverOpen, onActivate, onNavigate,
  itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag,
  mediaTags, onDeleteRequest, onAssemble, onSplit,
  isSelected, selectedItems, selectedAudioItems, onSelect, onContextMenuSelect,
  visibleCols, dropOnNode,
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

  const hasTagActions = onAddMediaTag && onRemoveMediaTag;
  const mediaClipboard = item.kind === 'audio' ? audioClipboard : item.kind === 'image' ? imageClipboard : null;
  const contextItems = isSelected && selectedItems.length > 1 ? selectedItems : [item];
  const contextAudioItems = isSelected && selectedAudioItems.length > 1 && item.kind === 'audio' ? selectedAudioItems : (item.kind === 'audio' ? [item] : []);
  const clipboardPaths = contextAudioItems.length > 1 ? contextAudioItems.map((audio) => audio.path) : [item.path];
  const tagPaths = contextItems.map((selectedItem) => selectedItem.path);

  const ctxActions = [
    ...(mediaClipboard ? [
      { icon: <Copy />, label: clipboardPaths.length > 1 ? `Copier ${clipboardPaths.length} sons` : 'Copier le média', fn: () => mediaClipboard.set(clipboardPaths) },
      'sep',
    ] : []),
    { icon: <FolderOpen />, label: "Révéler dans l'explorateur", fn: () => revealItemInDir(item.path) },
    { icon: <Copy />, label: 'Copier le chemin', fn: () => navigator.clipboard.writeText(item.path).catch(() => {}) },
    ...(onAssemble && contextAudioItems.length >= 2 ? [
      'sep',
      { icon: <Link2 />, label: `Assembler ${contextAudioItems.length} sons`, fn: () => onAssemble() },
    ] : []),
    ...(onSplit && item.kind === 'audio' && item.exists ? [
      'sep',
      { icon: <Scissors />, label: 'Découper un audio', fn: () => onSplit(item) },
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
    let currentTargetKind = null; // 'field' | 'node' — stored from last onMove

    function findTarget(x, y) {
      const els = document.elementsFromPoint(x, y);
      // Field drop targets (AudioField / ImageField)
      const fieldTarget = els.find((el) => el.dataset.dropKind === item.kind);
      if (fieldTarget) return { el: fieldTarget, kind: 'field' };
      // Tree / full-diagram node targets (story / menu / root)
      if (item.kind === 'audio' || item.kind === 'image') {
        const treeTarget = els.find((el) => el.dataset.mediaNodeId);
        if (treeTarget) return { el: treeTarget, kind: 'node' };
      }
      return null;
    }

    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return;
        dragging = true;
        mediaDrag.start(item.kind, item.path);
        ghost = document.createElement('div');
        ghost.className = 'media-drag-ghost';
        ghost.textContent = dragPaths.length > 1 ? `${dragPaths.length} sons` : item.name;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY - 14}px`;

      const hit = findTarget(ev.clientX, ev.clientY);
      const newTarget = hit?.el ?? null;
      if (newTarget !== currentTarget) {
        currentTarget?.classList.remove('is-drop-over');
        newTarget?.classList.add('is-drop-over');
        currentTarget = newTarget;
        currentTargetKind = hit?.kind ?? null;
        ghost.classList.toggle('is-over-target', !!newTarget);
      }
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (ghost) { document.body.removeChild(ghost); ghost = null; }
      currentTarget?.classList.remove('is-drop-over');

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
        }
      }
      mediaDrag.end();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  async function handleOpen() {
    try {
      await openPath(item.path);
    } catch {
      // Best effort only.
    }
  }

  const { size: sizeDisp, dim: dimDisp, dur: durDisp, fmt: fmtDisp } = getMetaDisplay(item, m, duration);
  const usageText = `${kindLabel(item.kind)} · ${usage?.label || item.source}${item.usedCount > 1 ? ` ×${item.usedCount}` : ''}`;

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
          <UsageBadge count={item.projectUsedCount} />
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
