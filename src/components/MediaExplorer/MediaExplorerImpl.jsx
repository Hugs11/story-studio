import { lazy, Suspense, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { collectMediaLibrary } from '../../store/mediaLibrary';
import { audioClipboard } from '../../store/fieldClipboard';
import { useMediaMetadata } from '../../hooks/useMediaMetadata';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { useErrorDialog } from '../common/Dialog';
import { FilePlus, FolderPlus, SlidersHorizontal, Copy, Scissors, FolderInput, Trash2, Link2, Download, Search } from '../icons/LucideLocal';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { isModalSurfaceOpen } from '../../utils/modalSurfaces';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { KEYS, write } from '../../store/persistentSettings';
import { basename } from '../../utils/fileUtils';
import { isDeletableWorkspaceMediaPath } from '../../store/workspaceDirs';
import {
  getAssemblyReplacementEligibility,
  getMediaToolProjectActions,
} from '../../store/mediaToolContext';
import { AudioAssemblyModal } from '../AudioAssemblyModal/AudioAssemblyModal';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { MediaExplorerContent } from './MediaExplorerContent';
import { MediaPopover } from './MediaPopover';
import { MediaDeleteDialog } from './MediaDeleteDialog';
import { MediaSelectionBar } from './MediaSelectionBar';
import { MediaToolResultBanner } from './MediaToolResultBanner';
import { pathKey } from '../../utils/fileUtils';
import { cleanPath, tagStyle } from './helpers';
import { COLUMNS, colsToGrid, useColumnWidths } from './useColumnWidths';
import { useMediaImageEdit } from './useMediaImageEdit';
import './MediaExplorer.css';

const AudioSplitterModal = lazy(() => import('../AudioSplitterModal/AudioSplitterModal')
  .then((m) => ({ default: m.AudioSplitterModal })));
const ImageEditorModal = lazy(() => import('../ImageEditorModal/ImageEditorModal')
  .then((m) => ({ default: m.ImageEditorModal })));

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


export function MediaExplorer({
  project,
  statusByPath,
  sdJobs,
  xttsJobs,
  extraPaths,
  onImportStories,
  onImportMedia,
  onImportMediaFolder,
  onSelectNode,
  mediaTags = {},
  onAddMediaTag,
  onRemoveMediaTag,
  onDeleteMedia,
  onMediaCatalogChanged,
  workspaceDir = '',
  savePath,
  projectName = '',
  onMediaCreated,
  mediaToolRequest = null,
  onAcknowledgeMediaToolRequest,
  onInvalidateMediaToolRequest,
  onValidateMediaToolRequest,
  onApplyMediaToolProjectAction,
}) {
  const { showErrorDialog } = useErrorDialog();
  const { activeDropZone, dropOnNode } = useMediaTransfer();
  const [activeFilters, setActiveFilters] = useState(() => new Set());
  const [view, setView] = useState('list');
  const osDropHover = activeDropZone === 'mediaexplorer';
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState(() => new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  const [assemblyItems, setAssemblyItems] = useState([]);
  const [assemblyRequest, setAssemblyRequest] = useState(null);
  const [splitterItem, setSplitterItem] = useState(null);
  const [splitterRequest, setSplitterRequest] = useState(null);
  const [toolResult, setToolResult] = useState(null);
  const [busyProjectAction, setBusyProjectAction] = useState('');
  const [pendingSelectPaths, setPendingSelectPaths] = useState([]);
  const [pendingRevealMediaId, setPendingRevealMediaId] = useState('');
  const { getMeta, markForProbe } = useMediaMetadata();

  const [bgCtxMenu, setBgCtxMenu] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteDisk, setDeleteDisk] = useState(false);

  const imageEdit = useMediaImageEdit({
    workspaceDir,
    mediaTags,
    onAddMediaTag,
    onMediaCreated,
    onCreated: (path) => {
      setPendingSelectPaths([path]);
      setActivePopover(null);
    },
    showErrorDialog,
  });

  const { colWidths, colWidthsRef, visibleCols, setColWidths, toggleCol } = useColumnWidths({
    sortCol,
    onSortColReset: () => setSortCol(null),
  });
  const [colPickerOpen, setColPickerOpen] = useState(false);
  const colPickerRef = useRef(null);
  const headerRef = useRef(null);
  const listScrollRef = useRef(null);
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const lastSelectedIndexRef = useRef(null);

  // Popover state — lifted here so arrow-key navigation can move between tiles.
  const [activePopover, setActivePopover] = useState(null); // { idx, rect } | null



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
      write(KEYS.MEDIA_EXPLORER_COL_WIDTHS, colWidthsRef.current, { serialize: JSON.stringify });
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const gridCols = colsToGrid(colWidths, visibleCols);

  const items = useMemo(
    () => collectMediaLibrary({ project, statusByPath, sdJobs, xttsJobs, extraPaths }),
    [project, statusByPath, sdJobs, xttsJobs, extraPaths],
  );

  useEffect(() => {
    if (!mediaToolRequest || mediaToolRequest.status !== 'pending') return;
    const validation = onValidateMediaToolRequest?.(mediaToolRequest);
    if (validation && !validation.valid) {
      onInvalidateMediaToolRequest?.(mediaToolRequest.requestId);
      return;
    }
    const catalogItems = mediaToolRequest.sourcePaths.map((sourcePath) => (
      items.find((candidate) => pathKey(candidate.path) === pathKey(sourcePath)) ?? null
    ));
    if (catalogItems.some((item) => !item)) return;
    const requestedItems = catalogItems.map((item, index) => ({
      ...item,
      id: mediaToolRequest.entryIds[index],
    }));

    setToolResult(null);
    setActivePopover(null);
    setQuery('');
    setActiveFilters(new Set(['audio']));
    setActiveTags(new Set());
    setSelectedIds(new Set(catalogItems.map((item) => item.id)));
    setPendingRevealMediaId(catalogItems[0]?.id ?? '');
    if (mediaToolRequest.tool === 'split') {
      setAssemblyOpen(false);
      setAssemblyItems([]);
      setAssemblyRequest(null);
      setSplitterRequest(mediaToolRequest);
      setSplitterItem({
        ...requestedItems[0],
        durationSecs: getMeta(requestedItems[0].path)?.duration_secs,
      });
    } else {
      setSplitterItem(null);
      setSplitterRequest(null);
      setAssemblyRequest(mediaToolRequest);
      setAssemblyItems(requestedItems);
      setAssemblyOpen(true);
    }
    onAcknowledgeMediaToolRequest?.(mediaToolRequest.requestId);
  }, [
    items,
    mediaToolRequest,
    onAcknowledgeMediaToolRequest,
    onInvalidateMediaToolRequest,
    onValidateMediaToolRequest,
  ]);

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
    const kindFilters = [
      activeFilters.has('image') ? 'image' : null,
      activeFilters.has('audio') ? 'audio' : null,
      activeFilters.has('zip') ? 'archive' : null,
    ].filter(Boolean);
    if (kindFilters.length > 0 && !kindFilters.includes(item.kind)) return false;

    const originFilters = [
      activeFilters.has('ai') ? 'ai' : null,
      activeFilters.has('imported') ? 'imported' : null,
      activeFilters.has('recorded') ? 'recorded' : null,
    ].filter(Boolean);
    if (originFilters.length > 0 && !originFilters.includes(item.origin)) return false;

    if (activeFilters.has('unused') && item.inProject) return false;

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

  // Close popover when filters, search, or active tags change
  useEffect(() => { setActivePopover(null); }, [activeFilters, query, activeTags]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const itemIds = new Set(items.map((item) => item.id));
      const next = new Set([...prev].filter((id) => itemIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    if (pendingSelectPaths.length === 0) return;
    const keys = new Set(pendingSelectPaths.map(pathKey));
    const createdItems = items.filter((candidate) => keys.has(pathKey(candidate.path)));
    if (createdItems.length !== keys.size) return;
    const createdKind = createdItems.every((item) => item.kind === createdItems[0]?.kind)
      ? createdItems[0]?.kind
      : null;
    setActiveFilters(new Set(
      createdKind === 'image' || createdKind === 'audio' ? [createdKind] : [],
    ));
    setActiveTags(new Set());
    setQuery('');
    setActivePopover(null);
    setSelectedIds(new Set(createdItems.map((item) => item.id)));
    setPendingRevealMediaId(createdItems[0]?.id ?? '');
    setPendingSelectPaths([]);
  }, [items, pendingSelectPaths]);

  useEffect(() => {
    if (!pendingRevealMediaId) return undefined;
    const frame = requestAnimationFrame(() => {
      const mediaElement = [...(containerRef.current?.querySelectorAll('[data-media-id]') ?? [])]
        .find((element) => element.dataset.mediaId === pendingRevealMediaId);
      mediaElement?.scrollIntoView({ block: 'nearest' });
      setPendingRevealMediaId('');
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingRevealMediaId, view]);

  // Remove stale active tags when allTags shrinks
  useEffect(() => {
    setActiveTags((prev) => {
      const next = new Set([...prev].filter((t) => allTags.includes(t)));
      return next.size === prev.size ? prev : next;
    });
  }, [allTags]);

  // Touche Suppr : la ref garde la sélection courante sans réenregistrer l'écouteur à chaque rendu.
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
      setDeleteDisk(false);
      setDeleteConfirm({ items });
    }
    const el = containerRef.current;
    if (!el) return undefined;
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onDeleteMedia]);

  const handleDeleteRequest = useCallback((items) => {
    if (!items?.length) return;
    setDeleteDisk(false);
    setDeleteConfirm({ items });
  }, []);

  async function confirmDelete() {
    if (!deleteConfirm) return;
    const items = deleteConfirm.items;
    if (items.some((item) => item.projectUsedCount > 0)) return;
    setDeleteConfirm(null);
    const diskErrors = [];
    const blockedItems = [];
    let removedCount = 0;
    for (const item of items) {
      const result = await onDeleteMedia(item, { deleteFromDisk: deleteDisk });
      if (result?.removed) removedCount += 1;
      if (result?.blocked) {
        blockedItems.push(item.name || item.path);
      }
      if (deleteDisk && result?.diskError) {
        diskErrors.push(`• ${item.name || item.path}\n  ${result.diskError}`);
      }
    }
    if (diskErrors.length > 0 || blockedItems.length > 0) {
      const sections = [];
      if (blockedItems.length > 0) {
        sections.push(`Médias encore utilisés :\n${blockedItems.map((name) => `• ${name}`).join('\n')}`);
      }
      if (diskErrors.length > 0) {
        const header = diskErrors.length === 1
          ? 'Suppression disque refusée pour ce fichier :'
          : `Suppression disque refusée pour ${diskErrors.length} fichiers :`;
        sections.push(`${header}\n${diskErrors.join('\n\n')}`);
      }
      showErrorDialog({
        title: 'Retrait incomplet',
        message: `${sections.join('\n\n')}\n\nLes fichiers concernés sont restés intacts dans la médiathèque et sur le disque.`,
        variant: 'warning',
      });
    }
    if (removedCount > 0) onMediaCatalogChanged?.();
  }



  useEffect(() => {
    if (!colPickerOpen) return undefined;
    function onDown(e) { if (!colPickerRef.current?.contains(e.target)) setColPickerOpen(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colPickerOpen]);

  useEffect(() => { setColPickerOpen(false); }, [view]);

  useEffect(() => {
    function onKeyDown(e) {
      // Même garde que useAppShortcuts : pas de raccourci global sous une modale.
      if (isModalSurfaceOpen()) return;
      const actionId = findShortcutAction(e, getCurrentShortcuts(), 'mediaPanel');
      if (actionId !== 'mediaSearch') return;
      e.preventDefault();
      e.stopPropagation();
      const input = searchInputRef.current;
      input?.focus();
      input?.select();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  function toggleActiveTag(tag) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  function toggleFilter(filterId) {
    setActiveFilters((prev) => {
      if (filterId === 'all') return new Set();
      const next = new Set(prev);
      if (next.has(filterId)) next.delete(filterId);
      else next.add(filterId);
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

  function openAudioAssembly() {
    onInvalidateMediaToolRequest?.();
    setToolResult(null);
    setAssemblyRequest(null);
    setAssemblyItems(selectedAudioItems);
    setAssemblyOpen(true);
  }

  function handleAudioAssemblyCreated(path, metadata = {}) {
    const request = assemblyRequest;
    onMediaCreated?.(path);
    setPendingSelectPaths([path]);
    setAssemblyOpen(false);
    setAssemblyItems([]);
    setAssemblyRequest(null);
    setToolResult({
      request,
      tool: 'assemble',
      mode: 'assemble',
      createdPaths: [path],
      inputPaths: metadata.inputPaths ?? [],
      failures: [],
      message: `Audio assemblé créé : ${basename(cleanPath(path))}`,
    });
  }

  function openAudioSplitter(item) {
    if (!item || item.kind !== 'audio' || !item.exists) return;
    onInvalidateMediaToolRequest?.();
    setToolResult(null);
    setSplitterRequest(null);
    setActivePopover(null);
    setSplitterItem({
      ...item,
      durationSecs: getMeta(item.path)?.duration_secs,
    });
  }

  function handleAudioSplitCreated(paths, failures = [], metadata = {}) {
    const createdPaths = paths.filter(Boolean);
    const request = splitterRequest
      ? { ...splitterRequest, mode: metadata.mode ?? splitterRequest.mode }
      : null;
    const sourcePath = splitterItem?.path;
    const sourceTags = sourcePath ? (mediaTags?.[sourcePath] ?? []) : [];
    const tagsToCopy = new Set([...sourceTags, 'découpe']);
    for (const path of createdPaths) {
      onMediaCreated?.(path);
      if (onAddMediaTag) {
        for (const tag of tagsToCopy) onAddMediaTag(path, tag);
      }
    }
    if (createdPaths.length > 0) setPendingSelectPaths(createdPaths);
    setSplitterItem(null);
    setSplitterRequest(null);
    setToolResult({
      request,
      tool: 'split',
      mode: metadata.mode ?? 'extract',
      createdPaths,
      failures,
      segments: metadata.segments ?? [],
      durationSec: metadata.durationSec,
      coverage: metadata.coverage,
      message: createdPaths.length === 1
        ? `Extrait audio créé : ${basename(cleanPath(createdPaths[0]))}`
        : `${createdPaths.length} extraits audio créés`,
    });

    if (failures.length > 0) {
      const details = failures
        .map((failure) => `• ${failure.outputFileName || 'Extrait'}\n  ${failure.error || 'Erreur inconnue'}`)
        .join('\n\n');
      showErrorDialog({
        title: 'Certaines découpes ont échoué',
        message: `${createdPaths.length} extrait${createdPaths.length > 1 ? 's ont été créés' : ' a été créé'}, mais ${failures.length} découpe${failures.length > 1 ? 's ont échoué' : ' a échoué'} :\n\n${details}`,
        variant: 'warning',
      });
    }
  }

  const contextualValidation = toolResult?.request
    ? onValidateMediaToolRequest?.(toolResult.request) ?? { valid: false, reason: 'Le contexte projet n’est plus disponible.' }
    : { valid: false, reason: '' };
  const assemblyEligibility = toolResult?.request?.tool === 'assemble'
    ? getAssemblyReplacementEligibility(project, toolResult.request.entryIds)
    : null;
  const availableProjectActions = getMediaToolProjectActions({
    request: toolResult?.request,
    result: toolResult,
    contextValidation: contextualValidation,
    replacementEligibility: assemblyEligibility,
  });
  let unavailableProjectActionReason = '';
  if (toolResult?.request && availableProjectActions.length === 0) {
    if (!contextualValidation.valid) unavailableProjectActionReason = contextualValidation.reason;
    else if (toolResult.request.tool === 'assemble' && !assemblyEligibility?.valid) unavailableProjectActionReason = assemblyEligibility?.reason;
    else if (toolResult.request.tool === 'assemble') unavailableProjectActionReason = 'L’ordre d’assemblage ne correspond plus à l’ordre des histoires.';
    else if (toolResult.request.mode === 'full-split' && !toolResult.coverage?.valid) unavailableProjectActionReason = toolResult.coverage?.reason;
    else if (toolResult.failures?.length) unavailableProjectActionReason = 'Toutes les parties requises n’ont pas pu être créées.';
  }

  function finishMediaToolResult() {
    if (toolResult?.request) onInvalidateMediaToolRequest?.(toolResult.request.requestId);
    setToolResult(null);
    setBusyProjectAction('');
  }

  function applyMediaToolProjectAction(action) {
    if (!toolResult?.request || busyProjectAction) return;
    setBusyProjectAction(action);
    const outcome = onApplyMediaToolProjectAction?.({
      request: toolResult.request,
      action,
      result: toolResult,
    });
    if (!outcome?.ok) {
      setBusyProjectAction('');
      setToolResult((current) => current ? { ...current, actionError: outcome?.reason || 'La modification du projet a échoué.' } : current);
      return;
    }
    setBusyProjectAction('');
    setToolResult((current) => current ? {
      ...current,
      request: null,
      projectApplied: true,
      message: 'La modification a été appliquée en une seule opération annulable.',
    } : current);
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
          <Button
            className={`me-col-picker-btn${colPickerOpen ? ' is-active' : ''}`}
            onClick={() => setColPickerOpen((v) => !v)}
          >
            <SlidersHorizontal className="me-col-picker-icon" strokeWidth={2} absoluteStrokeWidth />
          </Button>
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
      className={`media-filter${(f.id === 'all' ? activeFilters.size === 0 : activeFilters.has(f.id)) ? ' is-active' : ''}`}
      onClick={() => toggleFilter(f.id)}
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
      <Tooltip text="Importer audio, images, ZIP ou 7z">
        <Button className="media-import-btn" onClick={onImportMedia || onImportStories}>
          <FilePlus className="media-btn-icon" strokeWidth={2} absoluteStrokeWidth />
        </Button>
      </Tooltip>
      {onImportMediaFolder && (
        <Tooltip text="Importer un dossier (récursif)">
          <Button className="media-import-btn" onClick={onImportMediaFolder}>
            <FolderPlus className="media-btn-icon" strokeWidth={2} absoluteStrokeWidth />
          </Button>
        </Tooltip>
      )}
    </>
  );

  return (
    <div ref={containerRef} className="media-explorer" data-os-drop-zone="mediaexplorer">
      <div className="media-toolbar">
        <div className="media-filter-pills">{filterPills}{tagPills}</div>
        <div className="media-search-wrap">
          <span className="media-search-icon" aria-hidden="true">
            <Search width={12} height={12} strokeWidth={1.8} />
          </span>
          <input
            ref={searchInputRef}
            className="media-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher…"
          />
          {query ? (
            <button className="media-search-clear" type="button" onClick={() => setQuery('')} aria-label="Effacer la recherche">×</button>
          ) : null}
        </div>
        <div className="me-toolbar-right">{viewSwitch}{actionButtons}</div>
      </div>

      <MediaSelectionBar
        selectedCount={selectedCount}
        selectedAudioItems={selectedAudioItems}
        onCopyAudio={() => copySelectedAudio('copy')}
        onCutAudio={() => copySelectedAudio('cut')}
        onOpenAssembly={openAudioAssembly}
        onAddMediaTag={onAddMediaTag}
        bulkTag={bulkTag}
        onBulkTagChange={setBulkTag}
        bulkTagOpen={bulkTagOpen}
        onBulkTagOpenChange={setBulkTagOpen}
        allTags={allTags}
        visibleSelectedItems={visibleSelectedItems}
        onClear={clearSelection}
      />


      <MediaExplorerContent
        isEmpty={isEmpty}
        sortedVisible={sortedVisible}
        visible={visible}
        view={view}
        gridCols={gridCols}
        visibleCols={visibleCols}
        sortCol={sortCol}
        sortDir={sortDir}
        onSortClick={handleSortClick}
        onStartResize={startResize}
        headerRef={headerRef}
        listScrollRef={listScrollRef}
        onBackgroundClick={handleBgClick}
        onBackgroundContextMenu={handleBgContextMenu}
        getMeta={getMeta}
        markForProbe={markForProbe}
        activePopover={activePopover}
        onActivate={openPopoverAt}
        onNavigate={handleNavigate}
        mediaTags={mediaTags}
        allTags={allTags}
        onAddMediaTag={onAddMediaTag}
        onRemoveMediaTag={onRemoveMediaTag}
        onDeleteMedia={onDeleteMedia}
        onDeleteRequest={handleDeleteRequest}
        selectedAudioItems={selectedAudioItems}
        onOpenAssembly={openAudioAssembly}
        onOpenSplitter={openAudioSplitter}
        onEditImage={(item) => {
          setActivePopover(null);
          void imageEdit.openImageEditor(item);
        }}
        selectedIds={selectedIds}
        selectedItems={visibleSelectedItems}
        onSelectItem={handleSelectItem}
        onContextMenuSelect={handleContextMenuSelect}
        dropOnNode={dropOnNode}
        onImportMedia={onImportMedia}
        onImportStories={onImportStories}
        onImportMediaFolder={onImportMediaFolder}
      />
      {activePopover && sortedVisible[activePopover.idx] && (
        <MediaPopover
          item={sortedVisible[activePopover.idx]}
          anchorRect={activePopover.rect}
          getMeta={getMeta}
          onSelectNode={onSelectNode}
          onClose={() => setActivePopover(null)}
          itemTags={mediaTags?.[sortedVisible[activePopover.idx]?.path] ?? []}
          allProjectTags={allTags}
          onAddMediaTag={onAddMediaTag}
          onRemoveMediaTag={onRemoveMediaTag}
          onSplit={() => openAudioSplitter(sortedVisible[activePopover.idx])}
          onEditImage={(item) => {
            setActivePopover(null);
            void imageEdit.openImageEditor(item);
          }}
        />
      )}
      {assemblyOpen && (
        <AudioAssemblyModal
          items={assemblyItems.map((item) => ({
            ...item,
            durationSecs: getMeta(item.path)?.duration_secs,
          }))}
          ignoredCount={assemblyRequest ? 0 : selectedNonAudioCount}
          savePath={savePath}
          projectName={projectName}
          contextRequest={assemblyRequest}
          onClose={() => {
            if (assemblyRequest) onInvalidateMediaToolRequest?.(assemblyRequest.requestId);
            setAssemblyOpen(false);
            setAssemblyItems([]);
            setAssemblyRequest(null);
          }}
          onCreated={handleAudioAssemblyCreated}
        />
      )}
      {splitterItem && (
        <Suspense fallback={null}>
          <AudioSplitterModal
            item={splitterItem}
            savePath={savePath}
            contextRequest={splitterRequest}
            onClose={() => {
              if (splitterRequest) onInvalidateMediaToolRequest?.(splitterRequest.requestId);
              setSplitterItem(null);
              setSplitterRequest(null);
            }}
            onCreated={handleAudioSplitCreated}
          />
        </Suspense>
      )}
      {imageEdit.editSession && (
        <Suspense fallback={null}>
          <ImageEditorModal
            sourcePath={imageEdit.editSession.sourcePath}
            outputNameSourcePath={imageEdit.editSession.item.path}
            initialTransform={imageEdit.editSession.initialTransform}
            initialFilters={imageEdit.editSession.initialFilters}
            title="Modifier une image"
            confirmLabel="Enregistrer comme nouveau média"
            workspaceDir={imageEdit.editSession.workspaceDir}
            requireManagedOutput
            forceExport
            onConfirm={imageEdit.handleImageEditorConfirm}
            onCancel={imageEdit.closeImageEditor}
          />
        </Suspense>
      )}
      <MediaToolResultBanner
        result={toolResult}
        projectActions={availableProjectActions}
        unavailableReason={toolResult?.actionError || unavailableProjectActionReason}
        busyAction={busyProjectAction}
        onProjectAction={applyMediaToolProjectAction}
        onFinish={finishMediaToolResult}
      />
      {bgCtxMenu && (
        <ContextMenu
          x={bgCtxMenu.x}
          y={bgCtxMenu.y}
          onClose={() => setBgCtxMenu(null)}
          actions={[
            { icon: <Download />, label: 'Importer des médias', fn: () => { setBgCtxMenu(null); (onImportMedia || onImportStories)?.(); } },
            ...(onImportMediaFolder ? [{ icon: <FolderInput />, label: 'Importer un dossier', fn: () => { setBgCtxMenu(null); onImportMediaFolder(); } }] : []),
            ...(selectedCount > 0 ? [
              'sep',
              ...(selectedAudioItems.length > 0 ? [
                { icon: <Copy />, label: `Copier ${selectedAudioItems.length} son${selectedAudioItems.length > 1 ? 's' : ''}`, fn: () => { setBgCtxMenu(null); copySelectedAudio('copy'); } },
                { icon: <Scissors />, label: `Couper ${selectedAudioItems.length} son${selectedAudioItems.length > 1 ? 's' : ''}`, fn: () => { setBgCtxMenu(null); copySelectedAudio('cut'); } },
              ] : []),
              ...(selectedAudioItems.length >= 2 ? [
                { icon: <Link2 />, label: `Assembler ${selectedAudioItems.length} sons`, fn: () => { setBgCtxMenu(null); openAudioAssembly(); } },
              ] : []),
              ...(onDeleteMedia ? [{ icon: <Trash2 />, label: `Retirer ${selectedCount} fichier${selectedCount > 1 ? 's' : ''} de la médiathèque`, fn: () => { setBgCtxMenu(null); handleDeleteRequest(visibleSelectedItems); }, danger: true }] : []),
            ] : []),
          ]}
        />
      )}
      <MediaDeleteDialog
        items={deleteConfirm?.items}
        deleteDisk={deleteDisk}
        canDeleteFromDisk={!!deleteConfirm?.items?.length && deleteConfirm.items.every((item) => (
          isDeletableWorkspaceMediaPath(item.path, workspaceDir)
        ))}
        onDeleteDiskChange={setDeleteDisk}
        onCancel={() => { setDeleteConfirm(null); setDeleteDisk(false); }}
        onConfirm={confirmDelete}
      />
      {imageEdit.notice && (
        <div className="media-success-toast" role="status" aria-live="polite">
          {imageEdit.notice}
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
