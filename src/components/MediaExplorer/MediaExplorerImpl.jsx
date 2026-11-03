import { lazy, Suspense, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { getIntlLocale } from '../../i18n/language.js';
import { mediaRef, presentMedia, translateMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { presentStoredError } from '../../i18n/userMessage.js';
import { collectMediaLibrary } from '../../store/mediaLibrary';
import { createMediaTagLookup } from '../../store/mediaTags';
import { audioClipboard } from '../../store/fieldClipboard';
import { useMediaMetadata } from '../../hooks/useMediaMetadata';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { useErrorDialog } from '../common/Dialog';
import { FilePlus, FolderPlus, SlidersHorizontal, Copy, Scissors, FolderInput, Trash2, Link2, Download, Search } from '../icons/LucideLocal';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { normalizeSearchText } from '../../utils/frenchText';
import { isModalSurfaceOpen } from '../../utils/modalSurfaces';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { basename } from '../../utils/fileUtils';
import { isDeletableWorkspaceMediaPath } from '../../store/workspaceDirs';
import {
  getMediaToolAutomaticProjectAction,
  getAssemblyReplacementEligibility,
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

// Clés résolues à l'affichage, pour suivre la langue active.
const FILTERS = [
  { id: 'all', labelKey: 'media:explorer.filter.all' },
  { id: 'image', labelKey: 'media:explorer.filter.images' },
  { id: 'audio', labelKey: 'media:explorer.filter.audio' },
  { id: 'zip', labelKey: 'media:explorer.filter.zip' },
  { id: 'ai', labelKey: 'media:explorer.filter.ai' },
  { id: 'imported', labelKey: 'media:explorer.filter.imported' },
  { id: 'recorded', labelKey: 'media:explorer.filter.recorded' },
  { id: 'unused', labelKey: 'media:explorer.filter.unused' },
];


export function MediaExplorer({
  project,
  statusByPath,
  sdJobs,
  xttsJobs,
  extraPaths,
  advancedMediaUsages = null,
  onImportStories,
  onImportMedia,
  onImportMediaFolder,
  onSelectNode,
  onRevealGraphNode,
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
  pendingMediaReveal = null,
  onMediaRevealConsumed,
}) {
  const { t, language } = useMediaTranslation();
  const { showErrorDialog } = useErrorDialog();
  const { activeDropZone, dropOnNode, graphMediaTarget } = useMediaTransfer();
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

  const { colWidths, visibleCols, toggleCol, startResize } = useColumnWidths({
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

  const gridCols = colsToGrid(colWidths, visibleCols);

  const items = useMemo(
    () => collectMediaLibrary({
      project, statusByPath, sdJobs, xttsJobs, extraPaths,
      advancedUsages: advancedMediaUsages,
    }),
    // La langue recalcule les libellés de repli des usages, sans toucher au projet.
    [project, statusByPath, sdJobs, xttsJobs, extraPaths, advancedMediaUsages, language],
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

  // Les étiquettes sont indexées par chemin, et un même fichier peut être
  // désigné sous deux formes : les champs médias racines portent des antislashs
  // sous Windows quand les chemins résolus portent des `/`. Un accès direct
  // `mediaTags[item.path]` perdait donc les étiquettes du média de couverture,
  // sur cette plateforme seulement. Le lecteur compare par `pathKey`.
  const tagsOf = useMemo(() => createMediaTagLookup(mediaTags), [mediaTags]);

  // All tags that appear on at least one item in the library
  const allTags = useMemo(() => {
    const set = new Set();
    for (const item of items) {
      for (const t of tagsOf(item.path)) set.add(t);
    }
    return [...set].sort();
  }, [items, tagsOf]);

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

  const normalizedQuery = normalizeSearchText(query).trim();
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
      const itemTagList = tagsOf(item.path);
      for (const t of activeTags) {
        if (!itemTagList.includes(t)) return false;
      }
    }
    if (!normalizedQuery) return true;
    const haystack = `${item.name} ${item.path} ${item.usages.map((u) => u.label).join(' ')}`;
    return normalizeSearchText(haystack).includes(normalizedQuery);
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
      case 'name':  return dir * a.name.localeCompare(b.name, getIntlLocale(), { sensitivity: 'base' });
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
      case 'tags':  { const ta = tagsOf(a.path).join(','); const tb = tagsOf(b.path).join(','); return dir * ta.localeCompare(tb, getIntlLocale(), { sensitivity: 'base' }); }
      default:      return 0;
    }
  });

  const visibleSelectedItems = visible.filter((item) => selectedIds.has(item.id));
  const selectedAudioItems = visibleSelectedItems.filter((item) => item.kind === 'audio' && item.exists);
  const selectedNonAudioCount = visibleSelectedItems.filter((item) => item.kind !== 'audio').length;
  const selectedCount = visibleSelectedItems.length;
  const selectedGraphMedia = selectedCount === 1 && visibleSelectedItems[0]?.exists
    && ['audio', 'image'].includes(visibleSelectedItems[0].kind)
    ? visibleSelectedItems[0] : null;

  async function assignSelectedToGraph() {
    if (!selectedGraphMedia || !graphMediaTarget) return;
    try {
      await graphMediaTarget.assign({ kind: selectedGraphMedia.kind, path: selectedGraphMedia.path });
    } catch (error) {
      showErrorDialog({
        get title() { return translateMedia('media:explorer.assign.error'); },
        message: error,
      });
    }
  }

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

  // Atteindre un média depuis l'emplacement d'un Écran du graphe.
  //
  // C'est le pendant exact du menu contextuel de l'arbre — « Découper l'audio
  // dans Médias… » —, et il produit le même effet : le fichier est révélé ici,
  // l'outil s'ouvre, et **le projet n'est pas modifié**. Aucun contexte de
  // projet ne circule, parce qu'il n'y a rien à appliquer ensuite.
  //
  // La demande attend que le catalogue porte le fichier plutôt que de se perdre :
  // le panneau peut s'ouvrir avant que la liste soit dressée.
  useEffect(() => {
    if (!pendingMediaReveal) return;
    const wanted = (pendingMediaReveal.paths ?? []).map((wantedPath) => (
      items.find((candidate) => pathKey(candidate.path) === pathKey(wantedPath)) ?? null
    ));
    if (wanted.length === 0 || wanted.some((item) => !item)) return;
    setToolResult(null);
    setPendingSelectPaths(wanted.map((item) => item.path));
    if (pendingMediaReveal.tool === 'split') openAudioSplitter(wanted[0]);
    onMediaRevealConsumed?.();
  }, [items, pendingMediaReveal, onMediaRevealConsumed]);

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
        diskErrors.push({ name: item.name || item.path, error: result.diskError });
      }
    }
    if (diskErrors.length > 0 || blockedItems.length > 0) {
      // Message composé à la lecture : le dialogue ouvert suit la langue active.
      const incompleteMessage = () => {
        const sections = [];
        if (blockedItems.length > 0) {
          sections.push(`${translateMedia('media:explorer.removal.usedHeader')}\n${blockedItems.map((name) => `• ${name}`).join('\n')}`);
        }
        if (diskErrors.length > 0) {
          const header = diskErrors.length === 1
            ? translateMedia('media:explorer.removal.diskSingle')
            : translateMedia('media:explorer.removal.diskCount', { count: diskErrors.length });
          const details = diskErrors.map(({ name, error }) => `• ${name}\n  ${error}`);
          sections.push(`${header}\n${details.join('\n\n')}`);
        }
        return `${sections.join('\n\n')}\n\n${translateMedia('media:explorer.removal.untouched')}`;
      };
      showErrorDialog({
        get title() { return translateMedia('media:explorer.removal.title'); },
        get message() { return incompleteMessage(); },
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
    setPendingSelectPaths([path]);
    setAssemblyOpen(false);
    setAssemblyItems([]);
    setAssemblyRequest(null);
    const result = {
      request,
      tool: 'assemble',
      mode: 'assemble',
      createdPaths: [path],
      inputPaths: metadata.inputPaths ?? [],
      logicalName: metadata.logicalName ?? '',
      failures: [],
      message: mediaRef('media:toolResult.assembled.created', { name: basename(cleanPath(path)) }),
    };
    if (request && metadata.projectAction) {
      const outcome = onApplyMediaToolProjectAction?.({
        request,
        action: metadata.projectAction,
        result,
      });
      onMediaCreated?.(path);
      if (outcome?.ok) {
        setToolResult({
          ...result,
          request: null,
          projectApplied: true,
          message: mediaRef('media:toolResult.assembled.replaced'),
        });
        return;
      }
      onInvalidateMediaToolRequest?.(request.requestId);
      setToolResult({
        ...result,
        request: null,
        unavailableReason: outcome?.reasonRef || mediaRef('media:toolResult.replacement.refused'),
      });
      return;
    }
    onMediaCreated?.(path);
    if (request) onInvalidateMediaToolRequest?.(request.requestId);
    setToolResult({
      ...result,
      request: null,
      // Raison retenue comme descripteur : la bannière la résout à l'affichage.
      unavailableReason: metadata.projectActionUnavailableReason
        ? (automaticAssemblyUnavailableRef ?? metadata.projectActionUnavailableReason)
        : '',
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

  function handleAudioSplitCreated(paths, failures = []) {
    const createdPaths = paths.filter(Boolean);
    const request = splitterRequest;
    const sourcePath = splitterItem?.path;
    const sourceTags = tagsOf(sourcePath);
    // Étiquette écrite dans le projet : langue active au moment de la découpe.
    const tagsToCopy = new Set([...sourceTags, translateMedia('media:explorer.split.tag')]);
    for (const path of createdPaths) {
      onMediaCreated?.(path);
      if (onAddMediaTag) {
        for (const tag of tagsToCopy) onAddMediaTag(path, tag);
      }
    }
    if (createdPaths.length > 0) setPendingSelectPaths(createdPaths);
    if (request) onInvalidateMediaToolRequest?.(request.requestId);
    setSplitterItem(null);
    setSplitterRequest(null);
    setToolResult({
      request: null,
      tool: 'split',
      createdPaths,
      failures,
      message: createdPaths.length === 1
        ? mediaRef('media:toolResult.split.single', { name: basename(cleanPath(createdPaths[0])) })
        : mediaRef('media:toolResult.split.count', { count: createdPaths.length }),
    });

    if (failures.length > 0) {
      const createdCount = createdPaths.length;
      const failureMessage = () => translateMedia('media:explorer.split.failedSummary', {
        created: translateMedia('media:explorer.split.created', { count: createdCount }),
        failed: translateMedia('media:explorer.split.failed', { count: failures.length }),
        details: failures
          .map((failure) => `• ${failure.outputFileName || translateMedia('media:explorer.split.fallbackName')}\n  ${presentStoredError(failure.error) || translateMedia('media:explorer.split.unknownError')}`)
          .join('\n\n'),
      });
      showErrorDialog({
        get title() { return translateMedia('media:explorer.split.failedTitle'); },
        get message() { return failureMessage(); },
        variant: 'warning',
      });
    }
  }

  const assemblyContextValidation = assemblyRequest
    ? onValidateMediaToolRequest?.(assemblyRequest) ?? { valid: false, reasonRef: mediaRef('media:toolResult.context.unavailable') }
    : { valid: false, reasonRef: null };
  const liveAssemblyEligibility = assemblyRequest
    ? getAssemblyReplacementEligibility(project, assemblyRequest.entryIds)
    : null;
  const automaticAssemblyProjectAction = getMediaToolAutomaticProjectAction({
    request: assemblyRequest,
    contextValidation: assemblyContextValidation,
    replacementEligibility: liveAssemblyEligibility,
  });
  const automaticAssemblyUnavailableRef = assemblyRequest && !automaticAssemblyProjectAction
    ? (assemblyContextValidation.reasonRef || liveAssemblyEligibility?.reasonRef || mediaRef('media:toolResult.replacement.unsafe'))
    : null;
  const automaticAssemblyUnavailableReason = automaticAssemblyUnavailableRef ? presentMedia(automaticAssemblyUnavailableRef) : '';

  function finishMediaToolResult() {
    if (toolResult?.request) onInvalidateMediaToolRequest?.(toolResult.request.requestId);
    setToolResult(null);
  }

  const viewSwitch = (
    <div className="media-view-switch-row">
      <div className="media-view-switch">
        <Tooltip text={t('media:explorer.view.grid')}><button className={view === 'grid' ? 'is-active' : ''} type="button" onClick={() => setView('grid')}>⊞</button></Tooltip>
        <Tooltip text={t('media:explorer.view.list')}><button className={view === 'list' ? 'is-active' : ''} type="button" onClick={() => setView('list')}>≡</button></Tooltip>
      </div>
      {view === 'list' && (
        <div className="me-col-picker-wrap" ref={colPickerRef}>
          <Tooltip text={t('media:explorer.columns.tooltip')}>
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
                  <span>{t(col.labelKey)}</span>
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
      {t(f.labelKey)}
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
      <Tooltip text={t('media:explorer.import.tooltip')}>
        <Button className="media-import-btn" onClick={onImportMedia || onImportStories}>
          <FilePlus className="media-btn-icon" strokeWidth={2} absoluteStrokeWidth />
        </Button>
      </Tooltip>
      {onImportMediaFolder && (
        <Tooltip text={t('media:explorer.importFolder.tooltip')}>
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
            placeholder={t('media:explorer.search.placeholder')}
          />
          {query ? (
            <button className="media-search-clear" type="button" onClick={() => setQuery('')} aria-label={t('media:explorer.search.clear')}>×</button>
          ) : null}
        </div>
        <div className="me-toolbar-right">{viewSwitch}{actionButtons}</div>
      </div>

      <MediaSelectionBar
        selectedCount={selectedCount}
        graphMediaTarget={selectedGraphMedia ? graphMediaTarget : null}
        onAssignToGraph={assignSelectedToGraph}
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
        tagsOf={tagsOf}
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
        onSelectNode={onSelectNode}
        onRevealGraphNode={onRevealGraphNode}
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
          onRevealGraphNode={onRevealGraphNode}
          onClose={() => setActivePopover(null)}
          itemTags={tagsOf(sortedVisible[activePopover.idx]?.path)}
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
          projectAction={automaticAssemblyProjectAction}
          projectActionUnavailableReason={automaticAssemblyUnavailableReason}
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
            title={t('media:explorer.imageEditor.title')}
            confirmLabel={t('media:explorer.imageEditor.confirm')}
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
        unavailableReason={toolResult?.unavailableReason}
        onFinish={finishMediaToolResult}
      />
      {bgCtxMenu && (
        <ContextMenu
          x={bgCtxMenu.x}
          y={bgCtxMenu.y}
          onClose={() => setBgCtxMenu(null)}
          actions={[
            { icon: <Download />, label: t('media:explorer.context.importMedia'), fn: () => { setBgCtxMenu(null); (onImportMedia || onImportStories)?.(); } },
            ...(onImportMediaFolder ? [{ icon: <FolderInput />, label: t('media:explorer.context.importFolder'), fn: () => { setBgCtxMenu(null); onImportMediaFolder(); } }] : []),
            ...(selectedCount > 0 ? [
              'sep',
              ...(selectedAudioItems.length > 0 ? [
                { icon: <Copy />, label: t('media:selection.audio.copy', { count: selectedAudioItems.length }), fn: () => { setBgCtxMenu(null); copySelectedAudio('copy'); } },
                { icon: <Scissors />, label: t('media:selection.audio.cut', { count: selectedAudioItems.length }), fn: () => { setBgCtxMenu(null); copySelectedAudio('cut'); } },
              ] : []),
              ...(selectedAudioItems.length >= 2 ? [
                { icon: <Link2 />, label: t('media:tile.audio.assemble', { count: selectedAudioItems.length }), fn: () => { setBgCtxMenu(null); openAudioAssembly(); } },
              ] : []),
              ...(onDeleteMedia ? [{ icon: <Trash2 />, label: t('media:tile.files.remove', { count: selectedCount }), fn: () => { setBgCtxMenu(null); handleDeleteRequest(visibleSelectedItems); }, danger: true }] : []),
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
          {presentMedia(imageEdit.notice)}
        </div>
      )}
      {osDropHover && (
        <div className="media-os-drop-overlay">
          {t('media:explorer.drop.overlay')}
        </div>
      )}
    </div>
  );
}
