import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists, readDir } from '@tauri-apps/plugin-fs';
import { AppModalPortal } from '../common/AppModalPortal';
import { Select } from '../common/Select';
import {
  Check,
  ChevronDown,
  CircleX,
  FolderOpen,
  Link2,
  Loader2,
  Search,
  TriangleAlert,
  X,
} from '../icons/LucideLocal';
import { basename, dirname, joinPath, pathKey } from '../../utils/fileUtils';
import { candidatePathsForRelinkRoot, mediaKindFromPath, refreshRelinkRows } from '../../store/missingMediaRelink';
import { Trans } from 'react-i18next';
import { translateMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import './MissingMediaRelinkModal.css';

const MAX_SCAN_FILES = 12000;

function buildInitialRows(missingMedia) {
  return missingMedia.map((item) => ({
    ...item,
    status: 'missing',
    replacementPath: '',
    matches: [],
  }));
}

function isResolved(row) {
  return row.status === 'found' && Boolean(row.replacementPath);
}

// Coupe le nom à la dernière extension pour styliser celle-ci à part.
function splitFileName(fileName) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

// Types fermés de mediaKindFromPath, présentés dans la langue active.
const KIND_LABEL_KEYS = {
  audio: 'media:relink.kind.audio',
  image: 'media:relink.kind.image',
  archive: 'media:relink.kind.archive',
  media: 'media:relink.kind.media',
};

function rowMeta(row) {
  if (isResolved(row)) return translateMedia('media:relink.row.resolved');
  if (row.status === 'ambiguous') return translateMedia('media:relink.row.ambiguous', { count: row.matches.length });
  const labels = row.labels ?? [];
  if (labels.length === 0) return translateMedia('media:relink.row.missing');
  return `${labels.slice(0, 2).join(' · ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}`;
}

async function findFirstExisting(candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function scanFolderByName(rootDir, wantedNames) {
  const wanted = new Set([...wantedNames].map((name) => String(name).toLowerCase()));
  const matches = new Map([...wanted].map((name) => [name, []]));
  let scanned = 0;

  async function walk(dir) {
    if (scanned >= MAX_SCAN_FILES) return;
    let entries = [];
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = joinPath(dir, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
        if (scanned >= MAX_SCAN_FILES) return;
        continue;
      }
      if (!entry.isFile && entry.children == null) continue;
      scanned += 1;
      const key = String(entry.name || basename(fullPath)).toLowerCase();
      if (wanted.has(key)) matches.get(key).push(fullPath);
      if (scanned >= MAX_SCAN_FILES) return;
    }
  }

  await walk(rootDir);
  return { matches, scanned, truncated: scanned >= MAX_SCAN_FILES };
}

function mergeResolvedRows(rows, resolvedByPath) {
  return rows.map((row) => {
    const resolved = resolvedByPath.get(pathKey(row.path));
    if (!resolved) return row;
    return { ...row, ...resolved };
  });
}

// Rôle représentatif d'un groupe : préfixes distincts des libellés (avant « : »).
function groupRoleSummary(rows) {
  const roles = new Set();
  for (const row of rows) {
    for (const label of row.labels ?? []) {
      const role = String(label).split(':')[0].trim();
      if (role) roles.add(role);
    }
  }
  const list = [...roles];
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list[0]} +${list.length - 1}`;
}

// Regroupe les médias par dossier d'origine, en préservant l'ordre des lignes.
function groupRowsByFolder(rows) {
  const groups = new Map();
  for (const row of rows) {
    const dir = dirname(row.path) || row.path;
    const key = pathKey(dir);
    let group = groups.get(key);
    if (!group) {
      group = { key, dir, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

function rowMatchesQuery(row, query) {
  if (!query) return true;
  const haystack = `${row.fileName} ${row.path} ${(row.labels ?? []).join(' ')}`.toLowerCase();
  return haystack.includes(query);
}

function rowMatchesFilter(row, filter) {
  if (filter === 'resolved') return isResolved(row);
  if (filter === 'remaining') return !isResolved(row);
  return true;
}

export function MissingMediaRelinkModal({ missingMedia, workspaceDir = '', onApply, onClose }) {
  const { t } = useMediaTranslation();
  const [rows, setRows] = useState(() => buildInitialRows(missingMedia));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [scanningKey, setScanningKey] = useState('');
  const [applying, setApplying] = useState(false);

  // Un nouvel audit (retour de focus, fichier remis en place) renouvelle la
  // liste : les fichiers déjà reliés gardent leur choix.
  useEffect(() => {
    setRows((current) => refreshRelinkRows(current, missingMedia));
  }, [missingMedia]);

  const total = rows.length;
  const resolvedRows = useMemo(() => rows.filter(isResolved), [rows]);
  const resolvedCount = resolvedRows.length;
  const remainingCount = total - resolvedCount;
  const replacements = useMemo(() => Object.fromEntries(
    resolvedRows.map((row) => [row.path, row.replacementPath]),
  ), [resolvedRows]);

  const groups = useMemo(() => groupRowsByFolder(rows), [rows]);
  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => (
    groups
      .map((group) => ({
        ...group,
        visibleRows: group.rows.filter(
          (row) => rowMatchesQuery(row, normalizedQuery) && rowMatchesFilter(row, filter),
        ),
      }))
      .filter((group) => group.visibleRows.length > 0)
  ), [groups, normalizedQuery, filter]);

  async function runFolderScan(folder, targetRows) {
    const directResolved = new Map();
    const unresolved = [];
    for (const row of targetRows) {
      const direct = await findFirstExisting(candidatePathsForRelinkRoot(row.path, folder));
      if (direct) {
        directResolved.set(pathKey(row.path), {
          status: 'found',
          replacementPath: direct,
          matches: [direct],
        });
      } else {
        unresolved.push(row);
      }
    }

    const resolved = new Map(directResolved);
    if (unresolved.length > 0) {
      const names = new Set(unresolved.map((row) => row.fileName));
      const scanResult = await scanFolderByName(folder, names);
      for (const row of unresolved) {
        const rowMatches = scanResult.matches.get(row.fileName.toLowerCase()) ?? [];
        if (rowMatches.length === 1) {
          resolved.set(pathKey(row.path), { status: 'found', replacementPath: rowMatches[0], matches: rowMatches });
        } else if (rowMatches.length > 1) {
          resolved.set(pathKey(row.path), { status: 'ambiguous', replacementPath: '', matches: rowMatches });
        } else {
          resolved.set(pathKey(row.path), { status: 'missing', replacementPath: '', matches: [] });
        }
      }
    }
    setRows((current) => mergeResolvedRows(current, resolved));
  }

  async function handleChooseGroupFolder(group) {
    if (scanningKey || applying) return;
    const folder = await openDialog({
      directory: true,
      multiple: false,
      title: t('native:relink.folder.title'),
      defaultPath: group.dir || workspaceDir || dirname(group.rows[0]?.path),
    });
    if (!folder) return;
    setScanningKey(group.key);
    try {
      await runFolderScan(folder, group.rows);
    } finally {
      setScanningKey('');
    }
  }

  async function handleScanWorkspace() {
    if (!workspaceDir || scanningKey || applying) return;
    setScanningKey('__workspace__');
    try {
      await runFolderScan(workspaceDir, rows);
    } finally {
      setScanningKey('');
    }
  }

  async function handleChooseFile(row) {
    if (applying) return;
    const file = await openDialog({
      multiple: false,
      title: t('native:relink.file.title', { name: row.fileName }),
      defaultPath: dirname(row.path) || workspaceDir,
    });
    if (!file) return;
    setRows((current) => current.map((item) => (
      pathKey(item.path) === pathKey(row.path)
        ? { ...item, status: 'found', replacementPath: file, matches: [file], kind: mediaKindFromPath(file) }
        : item
    )));
  }

  function handleAmbiguousChoice(row, value) {
    setRows((current) => current.map((item) => (
      pathKey(item.path) === pathKey(row.path)
        ? { ...item, status: value ? 'found' : 'ambiguous', replacementPath: value }
        : item
    )));
  }

  function toggleGroup(key) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleApply() {
    if (resolvedCount === 0 || applying) return;
    setApplying(true);
    try {
      await onApply(replacements, { saveAfter: true });
    } finally {
      setApplying(false);
    }
  }

  const progressPct = total === 0 ? 0 : Math.round((resolvedCount / total) * 100);

  return (
    <AppModalPortal>
      <div className="relink-modal" role="dialog" aria-label={t('media:relink.title')} onClick={(event) => event.stopPropagation()}>
        <header className="relink-head">
          <span className="relink-head-icon"><Link2 /></span>
          <span className="relink-head-title">{t('media:relink.title')}</span>
          <span className="relink-head-count">
            {remainingCount > 0 ? t('media:relink.remaining.count', { count: remainingCount }) : t('media:relink.all.resolved')}
          </span>
          <span className="relink-spacer" />
          <button type="button" className="relink-icon-btn" aria-label={t('common:dialog.close.label')} onClick={onClose} disabled={applying}>
            <X />
          </button>
        </header>

        <div className="relink-subhead">
          <div className="relink-progress">
            <span className="relink-progress-label">
              <Trans i18nKey="media:relink.progress.label" count={resolvedCount} values={{ count: resolvedCount, total }} components={{ strong: <b /> }} />
            </span>
            <div className="relink-bar"><div className="relink-bar-fill" style={{ width: `${progressPct}%` }} /></div>
          </div>
          <div className="relink-toolbar">
            <label className="relink-search">
              <Search />
              <input
                type="text"
                placeholder={t('media:relink.search.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="relink-segmented" role="group" aria-label={t('media:relink.filter.ariaLabel')}>
              <button type="button" className="relink-seg" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                {t('media:relink.filter.all')} <span className="relink-seg-n">{total}</span>
              </button>
              <button type="button" className="relink-seg" aria-pressed={filter === 'remaining'} onClick={() => setFilter('remaining')}>
                {t('media:relink.filter.remaining')} <span className="relink-seg-n">{remainingCount}</span>
              </button>
              <button type="button" className="relink-seg" aria-pressed={filter === 'resolved'} onClick={() => setFilter('resolved')}>
                {t('media:relink.filter.resolved')} <span className="relink-seg-n">{resolvedCount}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="relink-scroll">
          {visibleGroups.length === 0 && (
            <div className="relink-empty">
              <Search />
              <span>{t('media:relink.filter.empty')}</span>
            </div>
          )}

          {visibleGroups.map((group) => {
            const groupRemaining = group.rows.filter((row) => !isResolved(row)).length;
            const groupResolved = groupRemaining === 0;
            const isCollapsed = collapsed.has(group.key);
            const isScanning = scanningKey === group.key;
            const groupRole = groupRoleSummary(group.rows);
            return (
              <div
                key={group.key}
                className={`relink-group${groupResolved ? ' is-resolved' : ''}${isCollapsed ? ' is-collapsed' : ''}`}
              >
                <div className="relink-ghead">
                  <button
                    type="button"
                    className="relink-ghead-chev"
                    aria-label={isCollapsed ? t('media:relink.group.expand') : t('media:relink.group.collapse')}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <ChevronDown />
                  </button>
                  <span className="relink-ghead-icon">{groupResolved ? <Check /> : <FolderOpen />}</span>
                  <div className="relink-ghead-main">
                    <div className="relink-ghead-path" title={group.dir}>{group.dir}</div>
                    <div className="relink-ghead-sub">
                      {groupResolved
                        ? t('media:relink.group.resolved', { count: group.rows.length })
                        : t('media:relink.group.missing', { count: groupRemaining })}
                      {groupRole && ` · ${groupRole}`}
                    </div>
                  </div>
                  {group.rows.length > 1 && (
                    <button
                      type="button"
                      className="relink-gbtn"
                      onClick={() => handleChooseGroupFolder(group)}
                      disabled={Boolean(scanningKey) || applying}
                    >
                      {isScanning ? <Loader2 className="relink-spin" /> : <FolderOpen />}
                      {groupResolved ? t('media:relink.folder.change') : t('media:relink.folder.choose')}
                    </button>
                  )}
                </div>

                <div className="relink-glist">
                  {group.visibleRows.map((row) => {
                    const resolved = isResolved(row);
                    const [base, ext] = splitFileName(row.fileName);
                    return (
                      <div className={`relink-row is-${row.status}`} key={row.path}>
                        <span className="relink-row-orb">
                          {resolved ? <Check /> : row.status === 'ambiguous' ? <TriangleAlert /> : <CircleX />}
                        </span>
                        <div className="relink-row-main">
                          <div className="relink-row-name" title={row.path}>
                            {base}<span className="relink-row-ext">{ext}</span>
                          </div>
                          <div className="relink-row-meta">
                            <span className="relink-kind">{KIND_LABEL_KEYS[row.kind] ? t(KIND_LABEL_KEYS[row.kind]) : row.kind}</span>
                            <span title={resolved ? row.replacementPath : undefined}>{rowMeta(row)}</span>
                          </div>
                        </div>
                        {!resolved && (
                          <div className="relink-row-actions">
                            {row.status === 'ambiguous' && (
                              <Select
                                className="relink-row-select"
                                aria-label={t('media:relink.match.placeholder')}
                                value={row.replacementPath ?? ''}
                                onChange={(match) => handleAmbiguousChoice(row, match)}
                                disabled={applying}
                                options={[
                                  { value: '', label: t('media:relink.match.placeholder') },
                                  ...row.matches.map((match) => ({ value: match, label: match })),
                                ]}
                              />
                            )}
                            <button
                              type="button"
                              className="relink-row-cta"
                              onClick={() => handleChooseFile(row)}
                              disabled={applying}
                            >
                              {t('media:relink.file.choose')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <footer className="relink-foot">
          <button type="button" className="relink-btn relink-btn-ghost" onClick={onClose} disabled={applying}>
            {t('media:relink.ignoreAll.action')}
          </button>
          {workspaceDir && (
            <button
              type="button"
              className="relink-btn relink-btn-ghost"
              onClick={handleScanWorkspace}
              disabled={Boolean(scanningKey) || applying}
              title={workspaceDir}
            >
              {scanningKey === '__workspace__' ? <Loader2 className="relink-spin" /> : <FolderOpen />}
              {t('media:relink.workspace.scan')}
            </button>
          )}
          <span className="relink-spacer" />
          <span className="relink-foot-status"><Trans i18nKey="media:relink.ready.label" count={resolvedCount} values={{ count: resolvedCount, total }} components={{ strong: <b /> }} /></span>
          <button
            type="button"
            className="relink-btn relink-btn-primary"
            onClick={handleApply}
            disabled={resolvedCount === 0 || applying}
          >
            {applying && <Loader2 className="relink-spin" />}
            {applying ? t('media:audioEditor.apply.progress') : t('media:relink.apply.action')}
          </button>
        </footer>
      </div>
    </AppModalPortal>
  );
}
