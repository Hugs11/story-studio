import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { useLocalFile } from '../../store/useLocalFile';
import { collectMediaLibrary } from '../../store/mediaLibrary';
import { mediaDrag } from '../../store/dragState';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { useMediaMetadata, fmtSize, fmtHz } from '../../store/useMediaMetadata';
import { Tooltip } from '../common/Tooltip';
import { FilePlus, FolderPlus, Package, Play, SwatchBook, SlidersHorizontal, Copy, Scissors, FolderOpen, FolderInput, Trash2, Link2, Download } from '../icons/LucideLocal';
import { AudioAssemblyModal } from '../AudioAssemblyModal/AudioAssemblyModal';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { MediaPopover } from './MediaPopover';
import './MediaExplorer.css';

function cleanPath(path) {
  return path.replace(/^\\\\\?\\/, '');
}

function mediaPathKey(path) {
  return String(path || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
}

// Module-level audio singleton — un seul son à la fois
let _stopCurrentAudio = null;
function stopCurrentAudio() {
  if (_stopCurrentAudio) { _stopCurrentAudio(); _stopCurrentAudio = null; }
}

// Module-level duration cache — chargé une fois par chemin
const _durationCache = new Map();

function formatDuration(secs) {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LS_COL_WIDTHS = 'me-col-widths-v2';
const LS_VISIBLE_COLS = 'me-visible-cols-v2';

const COLUMNS = [
  { id: 'name',  label: 'Nom',        defaultWidth: 200 },
  { id: 'usage', label: 'Usage',      defaultWidth: 120 },
  { id: 'size',  label: 'Taille',     defaultWidth: 60  },
  { id: 'dim',   label: 'Dimensions', defaultWidth: 80  },
  { id: 'dur',   label: 'Durée',      defaultWidth: 72  },
  { id: 'fmt',   label: 'Format',     defaultWidth: 100 },
  { id: 'date',  label: 'Date',       defaultWidth: 110 },
  { id: 'path',  label: 'Chemin',     defaultWidth: 260 },
  { id: 'tags',  label: 'Tags',       defaultWidth: 120 },
];
const DEFAULT_COL_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.id, c.defaultWidth]));
const _OLD_COL_IDS = ['name', 'usage', 'size', 'dim', 'fmt', 'path', 'tags'];

function loadColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_COL_WIDTHS) ?? 'null');
    if (saved && !Array.isArray(saved)) {
      return { ...DEFAULT_COL_WIDTHS, ...Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, Math.max(40, Number(v))])) };
    }
    if (Array.isArray(saved)) {
      const result = { ...DEFAULT_COL_WIDTHS };
      saved.slice(0, _OLD_COL_IDS.length).forEach((w, i) => { result[_OLD_COL_IDS[i]] = Math.max(40, Number(w)); });
      return result;
    }
  } catch {}
  return { ...DEFAULT_COL_WIDTHS };
}

function loadVisibleCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_VISIBLE_COLS) ?? 'null');
    if (Array.isArray(saved)) {
      const valid = new Set(COLUMNS.map((c) => c.id));
      const filtered = saved.filter((id) => valid.has(id));
      if (filtered.length > 0) return new Set(filtered);
    }
  } catch {}
  return new Set(COLUMNS.map((c) => c.id));
}

function colsToGrid(widths, visibleCols) {
  return `56px ${COLUMNS.filter((c) => visibleCols.has(c.id)).map((c) => `${widths[c.id]}px`).join(' ')} 30px`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Deterministic tag color from name (HSL, same hue for same name)
function tagHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return (h * 137.5) % 360;
}
function tagStyle(name) {
  return { background: `hsl(${Math.round(tagHue(name))},55%,45%)`, color: '#fff' };
}

function useAudioDuration(path, exists) {
  const [duration, setDuration] = useState(() => _durationCache.get(path) ?? null);
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);
  const shouldLoad = visible && exists && !!path && !_durationCache.has(path);
  const url = useLocalFile(shouldLoad ? path : null);

  useEffect(() => {
    if (!path || !exists || _durationCache.has(path)) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: '120px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [path, exists]);

  useEffect(() => {
    if (!url) return;
    if (_durationCache.has(path)) { setDuration(_durationCache.get(path)); return; }
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    audio.onloadedmetadata = () => {
      const d = formatDuration(audio.duration);
      _durationCache.set(path, d);
      setDuration(d);
      audio.src = '';
    };
    audio.onerror = () => { audio.src = ''; };
    return () => { audio.src = ''; };
  }, [url, path]);

  return [duration, ref];
}

const LS_DELETE_DISK = 'me-delete-disk-v1';

const FILTERS = [
  { id: 'all', label: 'Tout' },
  { id: 'image', label: 'Images' },
  { id: 'audio', label: 'Audio' },
  { id: 'zip', label: 'ZIP' },
  { id: 'ai', label: 'IA' },
  { id: 'imported', label: 'Importés' },
  { id: 'recorded', label: 'Enreg.' },
  { id: 'unused', label: 'Non utilisés' },
];

const ORIGIN_BADGE = {
  ai:       { label: 'IA',  className: 'origin-ai' },
  recorded: { label: 'REC', className: 'origin-rec' },
  imported: { label: 'IMP', className: 'origin-imp' },
  library:  { label: 'LIB', className: 'origin-lib' },
};

// Deterministic waveform heights from filename chars (purely visual)
function waveHeights(name, bars = 18) {
  const heights = [];
  for (let i = 0; i < bars; i++) {
    const c = name.charCodeAt(i % name.length) || 65;
    heights.push(4 + ((c * 7 + i * 13) % 14));
  }
  return heights;
}

function kindLabel(kind) {
  if (kind === 'image') return 'Image';
  if (kind === 'audio') return 'Son';
  if (kind === 'archive') return 'Archive';
  return 'Fichier';
}

function KindIcon({ kind }) {
  const Icon = kind === 'image' ? SwatchBook : kind === 'audio' ? Play : Package;
  return <Icon className="media-kind-icon" strokeWidth={2} absoluteStrokeWidth />;
}

function OriginBadge({ origin }) {
  const def = ORIGIN_BADGE[origin];
  if (!def) return null;
  return <span className={`media-origin-badge ${def.className}`}>{def.label}</span>;
}

function UsageBadge({ count }) {
  return <span className={`media-usage-badge${count === 0 ? ' is-zero' : ''}`}>×{count}</span>;
}

function AudioWave({ name, bars = 18 }) {
  const heights = waveHeights(name, bars);
  return (
    <div className="media-audio-wave">
      {heights.map((h, i) => (
        <span key={i} className="media-audio-wave-bar" style={{ height: h }} />
      ))}
    </div>
  );
}

function MediaThumb({ item, compact }) {
  const imageUrl = useLocalFile(item.kind === 'image' && item.exists ? item.path : null);
  if (imageUrl) return <img className="media-thumb-img" src={imageUrl} alt="" draggable={false} />;
  if (item.kind === 'audio') {
    return (
      <div className="media-thumb-fallback is-audio">
        <AudioWave name={item.name} bars={compact ? 8 : 18} />
      </div>
    );
  }
  return (
    <div className={`media-thumb-fallback is-${item.kind}`}>
      <KindIcon kind={item.kind} />
    </div>
  );
}

function getMetaDisplay(item, m, duration) {
  if (!item.exists) return { size: '—', dim: '—', dur: '—', fmt: item.ext.toUpperCase() };
  const size = m ? fmtSize(m.size_bytes) : '…';
  let dim = '…';
  let dur = '…';
  let fmt = item.ext.toUpperCase();
  if (item.kind === 'image') {
    dim = m ? (m.width ? `${m.width}×${m.height}` : '—') : '…';
    dur = '—';
  } else if (item.kind === 'audio') {
    dim = '—';
    dur = duration || (m?.duration_secs != null ? formatDuration(m.duration_secs) : (m ? '—' : '…'));
    if (m) {
      const codec = (m.codec || item.ext).toUpperCase();
      const hz = m.sample_rate ? ` · ${fmtHz(m.sample_rate)}` : '';
      fmt = `${codec}${hz}`;
    }
  } else {
    dim = m ? '—' : '…';
    dur = '—';
  }
  return { size, dim, dur, fmt };
}

// Tag section rendered inside ContextMenu as a type:'node' item
function TagSection({ paths, mediaTags, itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag }) {
  const [newTag, setNewTag] = useState('');
  const targetPaths = (paths ?? []).filter(Boolean);
  const isBulk = targetPaths.length > 1;

  function tagsForPath(path) {
    return mediaTags?.[path] ?? (!isBulk ? itemTags : []);
  }

  function handleSubmit(e) {
    e.preventDefault();
    const t = newTag.trim();
    if (t) {
      for (const path of targetPaths) onAddMediaTag(path, t);
      setNewTag('');
    }
  }

  return (
    <div className="ctx-tag-section">
      <div className="ctx-tag-header">{isBulk ? `Tags (${targetPaths.length})` : 'Tags'}</div>
      {allProjectTags.map((tag) => {
        const taggedCount = targetPaths.filter((path) => tagsForPath(path).includes(tag)).length;
        const active = taggedCount === targetPaths.length;
        const partial = taggedCount > 0 && !active;
        return (
          <button
            key={tag}
            type="button"
            className={`ctx-tag-toggle${partial ? ' is-partial' : ''}`}
            onClick={() => {
              for (const path of targetPaths) {
                if (active) onRemoveMediaTag(path, tag);
                else onAddMediaTag(path, tag);
              }
            }}
          >
            <span className="ctx-tag-check">{active ? '✓' : partial ? '–' : ''}</span>
            <span className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
          </button>
        );
      })}
      <form className="ctx-tag-new-form" onSubmit={handleSubmit}>
        <input
          className="ctx-tag-new-input"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="+ Nouveau tag"
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  );
}

function MediaTile({
  item, view, getMeta, markForProbe, onSelectNode, onOpenAiQueue,
  index, isPopoverOpen, onActivate, onNavigate,
  itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag,
  mediaTags, onDeleteRequest, onAssemble,
  isSelected, selectedItems, selectedAudioItems, onSelect, onContextMenuSelect,
  visibleCols,
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
    ...(onDeleteRequest ? [
      'sep',
      { icon: <Trash2 />, label: contextItems.length > 1 ? `Supprimer ${contextItems.length} fichiers` : 'Supprimer', fn: () => onDeleteRequest(contextItems), danger: true },
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
          document.dispatchEvent(new CustomEvent('media-drop-node', {
            bubbles: false,
            detail: {
              nodeId: currentTarget.dataset.mediaNodeId,
              nodeType: currentTarget.dataset.mediaNodeType,
              path: item.path,
              paths: dragPaths,
              kind: item.kind,
            },
          }));
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

export function MediaExplorer({
  project,
  statusByPath,
  sdJobs,
  xttsJobs,
  extraPaths,
  onImportStories,
  onImportMedia,
  onImportMediaFolder,
  onOpenAiQueue,
  onSelectNode,
  mediaTags = {},
  onAddMediaTag,
  onRemoveMediaTag,
  onDeleteMedia,
  savePath,
  projectName = '',
  onMediaCreated,
}) {
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState('list');
  const [osDropHover, setOsDropHover] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState(() => new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  const [assemblyToast, setAssemblyToast] = useState('');
  const [pendingSelectPath, setPendingSelectPath] = useState('');
  const { getMeta, markForProbe } = useMediaMetadata();

  const [bgCtxMenu, setBgCtxMenu] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteDisk, setDeleteDisk] = useState(() => localStorage.getItem(LS_DELETE_DISK) === 'true');
  const [deleteRemember, setDeleteRemember] = useState(false);

  const [colWidths, setColWidthsState] = useState(loadColWidths);
  const colWidthsRef = useRef(colWidths);
  const [visibleCols, setVisibleColsState] = useState(loadVisibleCols);
  const [colPickerOpen, setColPickerOpen] = useState(false);
  const colPickerRef = useRef(null);
  const headerRef = useRef(null);
  const listScrollRef = useRef(null);
  const containerRef = useRef(null);
  const lastSelectedIndexRef = useRef(null);

  // Popover state — lifted here so arrow-key navigation can move between tiles.
  const [activePopover, setActivePopover] = useState(null); // { idx, rect } | null

  function setColWidths(newWidths) {
    colWidthsRef.current = newWidths;
    setColWidthsState(newWidths);
  }

  function openPopoverAt(idx) {
    const el = containerRef.current?.querySelector(`[data-tile-idx="${idx}"]`);
    const rect = el?.getBoundingClientRect() ?? null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    el?.focus();
    setActivePopover(rect ? { idx, rect } : null);
  }

  function handleNavigate(delta) {
    if (delta === null) { setActivePopover(null); return; }
    setActivePopover((prev) => {
      if (!prev) return null;
      const next = Math.max(0, Math.min(sortedVisible.length - 1, prev.idx + delta));
      const el = containerRef.current?.querySelector(`[data-tile-idx="${next}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      el?.focus();
      return { idx: next, rect: el?.getBoundingClientRect() ?? prev.rect };
    });
  }

  function startResize(e, colId) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidthsRef.current[colId];
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(40, startWidth + delta);
      setColWidths({ ...colWidthsRef.current, [colId]: newWidth });
    }

    function onUp() {
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      localStorage.setItem(LS_COL_WIDTHS, JSON.stringify(colWidthsRef.current));
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const gridCols = colsToGrid(colWidths, visibleCols);

  const items = useMemo(
    () => collectMediaLibrary({ project, statusByPath, sdJobs, xttsJobs, extraPaths }),
    [project, statusByPath, sdJobs, xttsJobs, extraPaths],
  );

  // All tags that appear on at least one item in the library
  const allTags = useMemo(() => {
    const set = new Set();
    for (const item of items) {
      for (const t of (mediaTags?.[item.path] ?? [])) set.add(t);
    }
    return [...set].sort();
  }, [items, mediaTags]);

  const counts = useMemo(() => ({
    all:      items.length,
    image:    items.filter((i) => i.kind === 'image').length,
    audio:    items.filter((i) => i.kind === 'audio').length,
    zip:      items.filter((i) => i.kind === 'archive').length,
    ai:       items.filter((i) => i.origin === 'ai').length,
    imported: items.filter((i) => i.origin === 'imported').length,
    recorded: items.filter((i) => i.origin === 'recorded').length,
    unused:   items.filter((i) => !i.inProject).length,
  }), [items]);

  const visible = items.filter((item) => {
    switch (filter) {
      case 'image':    if (item.kind !== 'image') return false; break;
      case 'audio':    if (item.kind !== 'audio') return false; break;
      case 'zip':      if (item.kind !== 'archive') return false; break;
      case 'ai':       if (item.origin !== 'ai') return false; break;
      case 'imported': if (item.origin !== 'imported') return false; break;
      case 'recorded': if (item.origin !== 'recorded') return false; break;
      case 'unused':   if (item.inProject) return false; break;
      default: break;
    }
    if (activeTags.size > 0) {
      const itemTagList = mediaTags?.[item.path] ?? [];
      for (const t of activeTags) {
        if (!itemTagList.includes(t)) return false;
      }
    }
    if (!query.trim()) return true;
    const haystack = `${item.name} ${item.path} ${item.usages.map((u) => u.label).join(' ')}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  function handleSortClick(i) {
    if (sortCol === i) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(i);
      setSortDir('asc');
    }
  }

  const sortedVisible = sortCol === null ? visible : [...visible].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortCol) {
      case 'name':  return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'usage': return dir * (a.usedCount - b.usedCount);
      case 'size':  { const sa = getMeta(a.path)?.size_bytes ?? -1; const sb = getMeta(b.path)?.size_bytes ?? -1; return dir * (sa - sb); }
      case 'dim': {
        const da = (getMeta(a.path)?.width ?? 0) * (getMeta(a.path)?.height ?? 0);
        const db = (getMeta(b.path)?.width ?? 0) * (getMeta(b.path)?.height ?? 0);
        return dir * (da - db);
      }
      case 'dur': { const da = getMeta(a.path)?.duration_secs ?? -1; const db = getMeta(b.path)?.duration_secs ?? -1; return dir * (da - db); }
      case 'fmt':   return dir * (a.ext ?? '').localeCompare(b.ext ?? '', undefined, { sensitivity: 'base' });
      case 'date':  { const da = getMeta(a.path)?.modified_at ?? 0; const db = getMeta(b.path)?.modified_at ?? 0; return dir * (da - db); }
      case 'path':  return dir * a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
      case 'tags':  { const ta = (mediaTags?.[a.path] ?? []).join(','); const tb = (mediaTags?.[b.path] ?? []).join(','); return dir * ta.localeCompare(tb, undefined, { sensitivity: 'base' }); }
      default:      return 0;
    }
  });

  const visibleSelectedItems = visible.filter((item) => selectedIds.has(item.id));
  const selectedAudioItems = visibleSelectedItems.filter((item) => item.kind === 'audio' && item.exists);
  const selectedNonAudioCount = visibleSelectedItems.filter((item) => item.kind !== 'audio').length;
  const selectedCount = visibleSelectedItems.length;

  const isEmpty = items.length === 0;

  // Sync header right-padding with scroll container's scrollbar gutter width
  useEffect(() => {
    if (view !== 'list') return;
    const scroll = listScrollRef.current;
    const header = headerRef.current;
    if (!scroll || !header) return;

    function sync() {
      const gutter = scroll.offsetWidth - scroll.clientWidth;
      header.style.paddingRight = `${9 + gutter}px`;
    }

    const ro = new ResizeObserver(sync);
    ro.observe(scroll);
    sync();
    return () => ro.disconnect();
  }, [view, visible.length]);

  // Close popover when filter, search, or active tags change
  useEffect(() => { setActivePopover(null); }, [filter, query, activeTags]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const itemIds = new Set(items.map((item) => item.id));
      const next = new Set([...prev].filter((id) => itemIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    if (!pendingSelectPath) return;
    const key = mediaPathKey(pendingSelectPath);
    const item = items.find((candidate) => mediaPathKey(candidate.path) === key);
    if (!item) return;
    setFilter('audio');
    setActiveTags(new Set());
    setSelectedIds(new Set([item.id]));
    setPendingSelectPath('');
  }, [items, pendingSelectPath]);

  useEffect(() => {
    if (!assemblyToast) return undefined;
    const timer = setTimeout(() => setAssemblyToast(''), 4200);
    return () => clearTimeout(timer);
  }, [assemblyToast]);

  // Remove stale active tags when allTags shrinks
  useEffect(() => {
    setActiveTags((prev) => {
      const next = new Set([...prev].filter((t) => allTags.includes(t)));
      return next.size === prev.size ? prev : next;
    });
  }, [allTags]);

  // Keyboard Delete — ref holds current selection to avoid re-registering on every render
  const visibleSelectedRef = useRef(visibleSelectedItems);
  useEffect(() => { visibleSelectedRef.current = visibleSelectedItems; }, [visibleSelectedItems]);
  useEffect(() => {
    if (!onDeleteMedia) return undefined;
    function onKey(e) {
      if (e.key !== 'Delete') return;
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      const items = visibleSelectedRef.current;
      if (!items.length) return;
      e.preventDefault();
      setDeleteConfirm({ items });
    }
    const el = containerRef.current;
    if (!el) return undefined;
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onDeleteMedia]);

  const handleDeleteRequest = useCallback((items) => {
    if (!items?.length) return;
    setDeleteConfirm({ items });
  }, []);

  async function confirmDelete() {
    if (!deleteConfirm) return;
    if (deleteRemember) localStorage.setItem(LS_DELETE_DISK, String(deleteDisk));
    const items = deleteConfirm.items;
    setDeleteConfirm(null);
    const diskErrors = [];
    for (const item of items) {
      const result = await onDeleteMedia(item, { deleteFromDisk: deleteDisk });
      if (deleteDisk && result?.diskError) {
        diskErrors.push(`• ${item.name || item.path}\n  ${result.diskError}`);
      }
    }
    if (diskErrors.length > 0) {
      const header = diskErrors.length === 1
        ? "Suppression disque refusée pour ce fichier :"
        : `Suppression disque refusée pour ${diskErrors.length} fichiers :`;
      window.alert(`${header}\n\n${diskErrors.join('\n\n')}\n\nLes références projet ont été retirées, mais les fichiers d'origine restent sur le disque (hors workspace géré par Story Studio).`);
    }
  }

  function toggleCol(id) {
    setVisibleColsState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size <= 1) return prev;
        next.delete(id);
        if (sortCol === id) setSortCol(null);
      } else {
        next.add(id);
      }
      localStorage.setItem(LS_VISIBLE_COLS, JSON.stringify([...next]));
      return next;
    });
  }

  useEffect(() => {
    if (!colPickerOpen) return undefined;
    function onDown(e) { if (!colPickerRef.current?.contains(e.target)) setColPickerOpen(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colPickerOpen]);

  useEffect(() => { setColPickerOpen(false); }, [view]);

  useEffect(() => {
    function onZone(e) { setOsDropHover(e.detail.zone === 'mediaexplorer'); }
    document.addEventListener('os-file-drag-zone', onZone);
    return () => document.removeEventListener('os-file-drag-zone', onZone);
  }, []);

  function toggleActiveTag(tag) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  function handleSelectItem(item, index, event) {
    if (event.defaultPrevented) return;
    setActivePopover(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && lastSelectedIndexRef.current != null) {
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        for (let i = start; i <= end; i++) {
          if (sortedVisible[i]) next.add(sortedVisible[i].id);
        }
      } else if (event.ctrlKey || event.metaKey) {
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        lastSelectedIndexRef.current = index;
      } else {
        next.clear();
        next.add(item.id);
        lastSelectedIndexRef.current = index;
      }
      return next;
    });
  }

  function handleContextMenuSelect(item, index) {
    if (selectedIds.has(item.id)) return;
    lastSelectedIndexRef.current = index;
    setSelectedIds(new Set([item.id]));
  }

  function clearSelection() {
    setSelectedIds(new Set());
    lastSelectedIndexRef.current = null;
  }

  function applyBulkTag(e) {
    e.preventDefault();
    const tag = bulkTag.trim();
    if (!tag || selectedCount === 0 || !onAddMediaTag) return;
    for (const item of visibleSelectedItems) {
      onAddMediaTag(item.path, tag);
    }
    setBulkTag('');
  }

  function copySelectedAudio(mode = 'copy') {
    const paths = selectedAudioItems.map((item) => item.path);
    if (paths.length === 0) return;
    audioClipboard.set(paths, { mode });
  }

  function handleBgClick(e) {
    if (e.target === e.currentTarget) clearSelection();
  }

  function handleBgContextMenu(e) {
    e.preventDefault();
    setBgCtxMenu({ x: e.clientX, y: e.clientY });
  }

  function handleAudioAssemblyCreated(path) {
    onMediaCreated?.(path);
    setPendingSelectPath(path);
    setAssemblyOpen(false);
    setAssemblyToast(`Audio assemblé créé : ${cleanPath(path).replace(/.*[\\/]/, '')}`);
  }

  const viewSwitch = (
    <div className="media-view-switch-row">
      <div className="media-view-switch">
        <Tooltip text="Vue grille"><button className={view === 'grid' ? 'is-active' : ''} type="button" onClick={() => setView('grid')}>⊞</button></Tooltip>
        <Tooltip text="Vue liste"><button className={view === 'list' ? 'is-active' : ''} type="button" onClick={() => setView('list')}>≡</button></Tooltip>
      </div>
      {view === 'list' && (
        <div className="me-col-picker-wrap" ref={colPickerRef}>
          <Tooltip text="Colonnes visibles">
          <button
            type="button"
            className={`me-col-picker-btn${colPickerOpen ? ' is-active' : ''}`}
            onClick={() => setColPickerOpen((v) => !v)}
          >
            <SlidersHorizontal className="me-col-picker-icon" strokeWidth={2} absoluteStrokeWidth />
          </button>
          </Tooltip>
          {colPickerOpen && (
            <div className="me-col-picker-panel">
              {COLUMNS.map((col) => (
                <label key={col.id} className="me-col-picker-row">
                  <input
                    type="checkbox"
                    checked={visibleCols.has(col.id)}
                    onChange={() => toggleCol(col.id)}
                  />
                  <span>{col.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const filterPills = FILTERS.filter((f) => f.id === 'all' || (counts[f.id] ?? 0) > 0).map((f) => (
    <button
      key={f.id}
      type="button"
      className={`media-filter${filter === f.id ? ' is-active' : ''}`}
      onClick={() => setFilter(f.id)}
    >
      {f.label}
      <span>{counts[f.id] ?? 0}</span>
    </button>
  ));

  const tagPills = allTags.length > 0 ? (
    <>
      <span className="media-filter-sep" />
      {allTags.map((tag) => {
        const isActive = activeTags.has(tag);
        const style = isActive ? tagStyle(tag) : {};
        return (
          <button
            key={tag}
            type="button"
            className={`media-filter media-tag-pill${isActive ? ' is-active' : ''}`}
            style={style}
            onClick={() => toggleActiveTag(tag)}
          >
            <span className="me-tag-dot" style={{ background: tagStyle(tag).background }} />
            {tag}
          </button>
        );
      })}
    </>
  ) : null;

  const actionButtons = (
    <>
      <Tooltip text="Importer des fichiers médias">
        <button className="btn media-import-btn" type="button" onClick={onImportMedia || onImportStories}>
          <FilePlus className="media-btn-icon" strokeWidth={2} absoluteStrokeWidth />
        </button>
      </Tooltip>
      {onImportMediaFolder && (
        <Tooltip text="Importer un dossier (récursif)">
          <button className="btn media-import-btn" type="button" onClick={onImportMediaFolder}>
            <FolderPlus className="media-btn-icon" strokeWidth={2} absoluteStrokeWidth />
          </button>
        </Tooltip>
      )}
    </>
  );

  const selectionBar = selectedCount > 1 ? (
    <div className="media-selection-bar">
      <span className="media-selection-count">{selectedCount} sélectionné{selectedCount > 1 ? 's' : ''}</span>
      {selectedAudioItems.length > 0 ? (
        <>
          <button className="btn media-selection-btn" type="button" onClick={() => copySelectedAudio('copy')}>
            Copier {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </button>
          <button className="btn media-selection-btn" type="button" onClick={() => copySelectedAudio('cut')}>
            Couper {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </button>
          {selectedAudioItems.length >= 2 && (
            <button className="btn btn-primary media-selection-btn" type="button" onClick={() => setAssemblyOpen(true)}>
              Assembler les audios
            </button>
          )}
        </>
      ) : null}
      {onAddMediaTag ? (
        <div className="media-selection-tag-wrap">
          <form className="media-selection-tag-form" onSubmit={applyBulkTag}>
            <input
              className="media-selection-tag-input"
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              onFocus={() => setBulkTagOpen(true)}
              onBlur={() => setTimeout(() => setBulkTagOpen(false), 150)}
              placeholder="+ Tag commun"
            />
            <button className="btn media-selection-btn" type="submit" disabled={!bulkTag.trim()}>
              Appliquer
            </button>
          </form>
          {bulkTagOpen && allTags.length > 0 && (
            <div className="media-tag-suggestions">
              {allTags
                .filter((t) => !bulkTag || t.toLowerCase().includes(bulkTag.toLowerCase()))
                .map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="media-tag-suggestion-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      for (const item of visibleSelectedItems) onAddMediaTag(item.path, tag);
                      setBulkTag('');
                      setBulkTagOpen(false);
                    }}
                  >
                    <span className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : null}
      <button className="btn media-selection-btn" type="button" onClick={clearSelection}>Effacer</button>
    </div>
  ) : null;

  return (
    <div ref={containerRef} className="media-explorer" data-os-drop-zone="mediaexplorer">
      <div className="media-toolbar">
        <div className="media-filter-pills">{filterPills}{tagPills}</div>
        <div className="media-search-wrap">
          <input
            className="media-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher…"
          />
          {query && (
            <button className="media-search-clear" type="button" onClick={() => setQuery('')} aria-label="Effacer la recherche">×</button>
          )}
        </div>
        <div className="me-toolbar-right">{viewSwitch}{actionButtons}</div>
      </div>

      {selectionBar}


      {isEmpty ? (
        <div className="media-empty">
          <Package className="media-empty-icon" strokeWidth={1.8} absoluteStrokeWidth />
          <span>Aucun média pour l'instant</span>
          <p className="media-empty-hint">Tes médias importés, générés ou extraits apparaîtront ici, prêts à être glissés-déposés.</p>
          <div className="media-empty-actions">
            <button className="btn media-empty-btn" type="button" onClick={onImportMedia || onImportStories}>
              + Importer un fichier
            </button>
            {onImportMediaFolder && (
              <button className="btn media-empty-btn" type="button" onClick={onImportMediaFolder}>
                + Importer un dossier
              </button>
            )}
          </div>
        </div>
      ) : sortedVisible.length === 0 ? (
        <div className="media-empty">
          <Package className="media-empty-icon" strokeWidth={1.8} absoluteStrokeWidth />
          <span>Aucun média pour ce filtre.</span>
        </div>
      ) : view === 'list' ? (
        <div className="media-list is-list" style={{ '--me-grid': gridCols }}>
          <div className="media-list-header" ref={headerRef}>
            <div />
            {COLUMNS.filter((c) => visibleCols.has(c.id)).map((col) => (
              <div key={col.id} className={`me-col-head${sortCol === col.id ? ' is-sorted' : ''}`}>
                <button type="button" className="me-col-sort-btn" onClick={() => handleSortClick(col.id)}>
                  {col.label}
                  {sortCol === col.id && <span className="me-col-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </button>
                <span className="me-col-resize" onPointerDown={(e) => startResize(e, col.id)} />
              </div>
            ))}
            <div />
          </div>
          <div className="media-list-scroll" ref={listScrollRef} onClick={handleBgClick} onContextMenu={handleBgContextMenu}>
            {sortedVisible.map((item, idx) => (
              <MediaTile
                key={item.id}
                item={item}
                view={view}
                getMeta={getMeta}
                markForProbe={markForProbe}
                onSelectNode={onSelectNode}
                onOpenAiQueue={onOpenAiQueue}
                index={idx}
                isPopoverOpen={activePopover?.idx === idx}
                onActivate={openPopoverAt}
                onNavigate={handleNavigate}
                itemTags={mediaTags?.[item.path] ?? []}
                allProjectTags={allTags}
                onAddMediaTag={onAddMediaTag}
                onRemoveMediaTag={onRemoveMediaTag}
                onDeleteRequest={onDeleteMedia ? handleDeleteRequest : null}
                onAssemble={selectedAudioItems.length >= 2 ? () => setAssemblyOpen(true) : null}
                mediaTags={mediaTags}
                isSelected={selectedIds.has(item.id)}
                selectedItems={visibleSelectedItems}
                selectedAudioItems={selectedAudioItems}
                onSelect={handleSelectItem}
                onContextMenuSelect={handleContextMenuSelect}
                visibleCols={visibleCols}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="media-list is-grid" onClick={handleBgClick} onContextMenu={handleBgContextMenu}>
          {visible.map((item, idx) => (
            <MediaTile
              key={item.id}
              item={item}
              view={view}
              getMeta={getMeta}
              markForProbe={markForProbe}
              onSelectNode={onSelectNode}
              onOpenAiQueue={onOpenAiQueue}
              index={idx}
              isPopoverOpen={activePopover?.idx === idx}
              onActivate={openPopoverAt}
              onNavigate={handleNavigate}
              itemTags={mediaTags?.[item.path] ?? []}
              allProjectTags={allTags}
              onAddMediaTag={onAddMediaTag}
              onRemoveMediaTag={onRemoveMediaTag}
              onDeleteRequest={onDeleteMedia ? handleDeleteRequest : null}
              onAssemble={selectedAudioItems.length >= 2 ? () => setAssemblyOpen(true) : null}
              mediaTags={mediaTags}
              isSelected={selectedIds.has(item.id)}
              selectedItems={visibleSelectedItems}
              selectedAudioItems={selectedAudioItems}
              onSelect={handleSelectItem}
              onContextMenuSelect={handleContextMenuSelect}
            />
          ))}
        </div>
      )}
      {activePopover && sortedVisible[activePopover.idx] && (
        <MediaPopover
          item={sortedVisible[activePopover.idx]}
          anchorRect={activePopover.rect}
          getMeta={getMeta}
          onSelectNode={onSelectNode}
          onOpenAiQueue={onOpenAiQueue}
          onClose={() => setActivePopover(null)}
          itemTags={mediaTags?.[sortedVisible[activePopover.idx]?.path] ?? []}
          allProjectTags={allTags}
          onAddMediaTag={onAddMediaTag}
          onRemoveMediaTag={onRemoveMediaTag}
        />
      )}
      {assemblyOpen && (
        <AudioAssemblyModal
          items={selectedAudioItems.map((item) => ({
            ...item,
            durationSecs: getMeta(item.path)?.duration_secs,
          }))}
          ignoredCount={selectedNonAudioCount}
          savePath={savePath}
          projectName={projectName}
          onClose={() => setAssemblyOpen(false)}
          onCreated={handleAudioAssemblyCreated}
          onDeleteMedia={onDeleteMedia}
        />
      )}
      {assemblyToast && (
        <div className="media-assembly-toast" role="status">
          {assemblyToast}
        </div>
      )}
      {bgCtxMenu && (
        <ContextMenu
          x={bgCtxMenu.x}
          y={bgCtxMenu.y}
          onClose={() => setBgCtxMenu(null)}
          actions={[
            { icon: <Download />, label: 'Importer des fichiers', fn: () => { setBgCtxMenu(null); (onImportMedia || onImportStories)?.(); } },
            ...(onImportMediaFolder ? [{ icon: <FolderInput />, label: 'Importer un dossier', fn: () => { setBgCtxMenu(null); onImportMediaFolder(); } }] : []),
            ...(selectedCount > 0 ? [
              'sep',
              ...(selectedAudioItems.length > 0 ? [
                { icon: <Copy />, label: `Copier ${selectedAudioItems.length} son${selectedAudioItems.length > 1 ? 's' : ''}`, fn: () => { setBgCtxMenu(null); copySelectedAudio('copy'); } },
                { icon: <Scissors />, label: `Couper ${selectedAudioItems.length} son${selectedAudioItems.length > 1 ? 's' : ''}`, fn: () => { setBgCtxMenu(null); copySelectedAudio('cut'); } },
              ] : []),
              ...(selectedAudioItems.length >= 2 ? [
                { icon: <Link2 />, label: `Assembler ${selectedAudioItems.length} sons`, fn: () => { setBgCtxMenu(null); setAssemblyOpen(true); } },
              ] : []),
              ...(onDeleteMedia ? [{ icon: <Trash2 />, label: `Supprimer ${selectedCount} fichier${selectedCount > 1 ? 's' : ''}`, fn: () => { setBgCtxMenu(null); handleDeleteRequest(visibleSelectedItems); }, danger: true }] : []),
            ] : []),
          ]}
        />
      )}
      {deleteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="gen-modal" style={{ width: 380, maxWidth: '92vw' }}>
            <div className="gen-header">
              <span className="gen-title">Supprimer {deleteConfirm.items.length > 1 ? `${deleteConfirm.items.length} fichiers` : '1 fichier'}</span>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {deleteConfirm.items.some((i) => i.projectUsedCount > 0) && (
                <div style={{ fontSize: 12, color: 'var(--color-warning-text, #f5c542)', lineHeight: 1.5 }}>
                  {deleteConfirm.items.filter((i) => i.projectUsedCount > 0).length === 1
                    ? '1 fichier est utilisé dans le projet'
                    : `${deleteConfirm.items.filter((i) => i.projectUsedCount > 0).length} fichiers sont utilisés dans le projet`}
                  {' '}— les liens correspondants seront supprimés.
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={deleteDisk} onChange={(e) => setDeleteDisk(e.target.checked)} />
                Supprimer aussi du disque
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', userSelect: 'none', color: 'var(--color-text-secondary)' }}>
                <input type="checkbox" checked={deleteRemember} onChange={(e) => setDeleteRemember(e.target.checked)} />
                Mémoriser ce choix
              </label>
            </div>
            <div className="gen-footer">
              <button className="btn" type="button" onClick={() => setDeleteConfirm(null)}>Annuler</button>
              <button className="btn" type="button" onClick={confirmDelete} style={{ background: 'oklch(0.50 0.18 20)', color: '#fff', border: 'none' }}>Supprimer</button>
            </div>
          </div>
        </div>
      )}
      {osDropHover && (
        <div className="media-os-drop-overlay">
          Déposer pour importer dans les médias
        </div>
      )}
    </div>
  );
}
