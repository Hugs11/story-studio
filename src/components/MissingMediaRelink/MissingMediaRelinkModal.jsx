import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists, readDir } from '@tauri-apps/plugin-fs';
import { AppModalPortal } from '../common/AppModalPortal';
import { CircleCheck, CircleX, FolderOpen, Link2, Loader2, TriangleAlert } from '../icons/LucideLocal';
import { basename, dirname, joinPath, pathKey } from '../../utils/fileUtils';
import { candidatePathsForRelinkRoot, mediaKindFromPath } from '../../store/missingMediaRelink';
import './MissingMediaRelinkModal.css';

const MAX_SCAN_FILES = 12000;

function statusLabel(status) {
  if (status === 'found') return 'Retrouvé';
  if (status === 'ambiguous') return 'À choisir';
  return 'Introuvable';
}

function rowStatusIcon(status) {
  if (status === 'found') return <CircleCheck />;
  if (status === 'ambiguous') return <TriangleAlert />;
  return <CircleX />;
}

function buildInitialRows(missingMedia) {
  return missingMedia.map((item) => ({
    ...item,
    status: 'missing',
    replacementPath: '',
    matches: [],
  }));
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

export function MissingMediaRelinkModal({ missingMedia, onApply, onClose }) {
  const [rows, setRows] = useState(() => buildInitialRows(missingMedia));
  const [selectedRoot, setSelectedRoot] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setRows(buildInitialRows(missingMedia));
    setScanMessage('');
  }, [missingMedia]);

  const resolvedRows = rows.filter((row) => row.status === 'found' && row.replacementPath);
  const ambiguousCount = rows.filter((row) => row.status === 'ambiguous').length;
  const missingCount = rows.length - resolvedRows.length - ambiguousCount;
  const replacements = useMemo(() => Object.fromEntries(
    resolvedRows.map((row) => [row.path, row.replacementPath]),
  ), [resolvedRows]);

  async function handleChooseFolder() {
    const folder = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choisir le dossier où chercher les médias manquants',
      defaultPath: selectedRoot || dirname(rows[0]?.path),
    });
    if (!folder) return;
    setSelectedRoot(folder);
    setScanning(true);
    setScanMessage('Recherche des médias...');
    try {
      const directResolved = new Map();
      const unresolved = [];
      for (const row of rows) {
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
      let truncated = false;
      if (unresolved.length > 0) {
        const names = new Set(unresolved.map((row) => row.fileName));
        const scanResult = await scanFolderByName(folder, names);
        truncated = scanResult.truncated;
        for (const row of unresolved) {
          const rowMatches = scanResult.matches.get(row.fileName.toLowerCase()) ?? [];
          if (rowMatches.length === 1) {
            resolved.set(pathKey(row.path), {
              status: 'found',
              replacementPath: rowMatches[0],
              matches: rowMatches,
            });
          } else if (rowMatches.length > 1) {
            resolved.set(pathKey(row.path), {
              status: 'ambiguous',
              replacementPath: '',
              matches: rowMatches,
            });
          } else {
            resolved.set(pathKey(row.path), {
              status: 'missing',
              replacementPath: '',
              matches: [],
            });
          }
        }
      }
      setRows((current) => mergeResolvedRows(current, resolved));
      const found = [...resolved.values()].filter((row) => row.status === 'found').length;
      const ambiguous = [...resolved.values()].filter((row) => row.status === 'ambiguous').length;
      setScanMessage(`${found} média(s) retrouvé(s), ${ambiguous} choix à confirmer${truncated ? ' — recherche limitée' : ''}.`);
    } finally {
      setScanning(false);
    }
  }

  async function handleChooseFile(row) {
    const file = await openDialog({
      multiple: false,
      title: `Relier ${row.fileName}`,
      defaultPath: dirname(row.path),
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

  async function handleApply({ saveAfter = false } = {}) {
    if (resolvedRows.length === 0) return;
    setApplying(true);
    try {
      await onApply(replacements, { saveAfter });
    } finally {
      setApplying(false);
    }
  }

  return (
    <AppModalPortal className="modal-overlay">
      <div className="modal-box missing-media-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span>Médias introuvables</span>
          <button className="modal-close" type="button" onClick={onClose} disabled={applying}>×</button>
        </div>

        <div className="missing-media-body">
          <div className="missing-media-summary">
            <div className="missing-media-summary-icon"><Link2 /></div>
            <div>
              <strong>{rows.length} média(s) à relier</strong>
              <p>Choisis le dossier qui contient les médias déplacés. Story Studio essaiera de relier les chemins par structure puis par nom de fichier.</p>
            </div>
          </div>

          <div className="missing-media-actions">
            <button className="btn btn-primary" type="button" onClick={handleChooseFolder} disabled={scanning || applying}>
              {scanning ? <Loader2 className="missing-media-spin" /> : <FolderOpen />}
              Retrouver un dossier
            </button>
            {selectedRoot && <span className="missing-media-root" title={selectedRoot}>{selectedRoot}</span>}
          </div>

          <div className="missing-media-stats">
            <span className="is-found">{resolvedRows.length} retrouvé(s)</span>
            <span className="is-ambiguous">{ambiguousCount} à choisir</span>
            <span className="is-missing">{missingCount} restant(s)</span>
          </div>
          {scanMessage && <div className="missing-media-scan-message">{scanMessage}</div>}

          <div className="missing-media-list">
            {rows.map((row) => (
              <div className={`missing-media-row is-${row.status}`} key={row.path}>
                <div className="missing-media-row-icon" title={statusLabel(row.status)}>
                  {rowStatusIcon(row.status)}
                </div>
                <div className="missing-media-main">
                  <div className="missing-media-name" title={row.fileName}>{row.fileName}</div>
                  <div className="missing-media-meta">
                    <span>{row.kind}</span>
                    <span>{row.labels.slice(0, 2).join(' · ')}{row.labels.length > 2 ? ` +${row.labels.length - 2}` : ''}</span>
                  </div>
                  <div className="missing-media-path" title={row.path}>{row.path}</div>
                  {row.replacementPath && (
                    <div className="missing-media-new-path" title={row.replacementPath}>{row.replacementPath}</div>
                  )}
                </div>
                <div className="missing-media-row-actions">
                  {row.status === 'ambiguous' && (
                    <select
                      value={row.replacementPath}
                      onChange={(event) => handleAmbiguousChoice(row, event.target.value)}
                      disabled={applying}
                    >
                      <option value="">Choisir...</option>
                      {row.matches.map((match) => (
                        <option key={match} value={match}>{match}</option>
                      ))}
                    </select>
                  )}
                  <button className="btn-xs" type="button" onClick={() => handleChooseFile(row)} disabled={applying}>
                    Choisir
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="missing-media-footer">
          <button className="btn" type="button" onClick={onClose} disabled={applying}>Ignorer</button>
          <button className="btn" type="button" onClick={() => handleApply({ saveAfter: false })} disabled={resolvedRows.length === 0 || applying}>
            Appliquer
          </button>
          <button className="btn btn-primary" type="button" onClick={() => handleApply({ saveAfter: true })} disabled={resolvedRows.length === 0 || applying}>
            {applying ? 'Application...' : 'Appliquer et sauvegarder'}
          </button>
        </div>
      </div>
    </AppModalPortal>
  );
}
