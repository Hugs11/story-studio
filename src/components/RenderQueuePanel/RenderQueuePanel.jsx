import { useState, useEffect, useRef } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { logger } from '../../utils/logger';
import { basename } from '../../utils/fileUtils';
import { Button } from '../common/Button';
import './RenderQueuePanel.css';

const STATUS_LABEL = {
  pending: 'En attente',
  running: 'Génération…',
  done: 'Terminé',
  error: 'Erreur',
  canceled: 'Annulé',
};
const PANEL_DEFAULT_HEIGHT = 340;
const PANEL_MIN_HEIGHT = 120;
const PANEL_BOTTOM_OFFSET = 33;
const PANEL_TOP_MARGIN = 72;

function clampPanelHeight(value) {
  const maxHeight = typeof window === 'undefined'
    ? PANEL_DEFAULT_HEIGHT
    : Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_TOP_MARGIN);
  return Math.min(Math.max(value, PANEL_MIN_HEIGHT), maxHeight);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function JobCard({ job, expanded, onToggle, onRemove, onCancel }) {
  const logsEndRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState('idle');
  const [openFolderError, setOpenFolderError] = useState(false);
  const copyResetRef = useRef(null);
  const openFolderResetRef = useRef(null);

  useEffect(() => {
    if (expanded) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [job.logs, expanded]);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    if (openFolderResetRef.current) clearTimeout(openFolderResetRef.current);
  }, []);

  const folderName = basename(job.outputFolder);
  const allText = [...job.logs, ...(job.errorMessage ? [job.errorMessage] : [])].join('\n');

  async function handleCopyLogs() {
    try {
      await navigator.clipboard.writeText(allText);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyStatus('idle'), 2000);
  }

  async function handleOpenFolder() {
    const folder = job.resultPath
      ? job.resultPath.replace(/[\\/][^\\/]+$/, '')
      : job.outputFolder;
    try {
      await openPath(folder);
    } catch (error) {
      setOpenFolderError(true);
      if (openFolderResetRef.current) clearTimeout(openFolderResetRef.current);
      openFolderResetRef.current = setTimeout(() => setOpenFolderError(false), 2000);
      logger.warn('render-queue:open-folder-error', error);
    }
  }

  return (
    <div className={`rq-job rq-job-${job.status}`}>
      <div className="rq-job-header" onClick={onToggle} role="button">
        <div className="rq-job-meta">
          <span className="rq-job-name">{job.projectName}</span>
          <span className="rq-job-folder" title={job.outputFolder}>{folderName}</span>
          <span className="rq-job-time">{formatTime(job.createdAt)}</span>
        </div>
        <div className="rq-job-right">
          <span className={`rq-badge rq-badge-${job.status}`}>
            {job.status === 'running' && <span className="rq-spinner" />}
            {job.cancelRequested ? 'Annulation…' : STATUS_LABEL[job.status]}
          </span>
          {(job.status === 'pending' || job.status === 'running') && (
            <Button
              size="sm"
              className="rq-cancel-btn"
              title={job.status === 'pending' ? 'Annuler ce rendu' : 'Annuler la génération en cours'}
              disabled={job.cancelRequested}
              onClick={(e) => { e.stopPropagation(); onCancel?.(job.id); }}
            >Annuler</Button>
          )}
          {(job.status === 'done' || job.status === 'error' || job.status === 'canceled') && (
            <Button
              size="sm"
              className="rq-remove-btn"
              title="Retirer"
              onClick={(e) => { e.stopPropagation(); onRemove(job.id); }}
            >✕</Button>
          )}
          <span className="rq-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="rq-job-detail">
          <div className="rq-job-logs">
            {job.logs.length === 0 && job.status === 'pending' && (
              <div className="rq-log-empty">En attente de démarrage…</div>
            )}
            {job.logs.map((line, i) => (
              <div key={i} className="rq-log-line">{line}</div>
            ))}
            {job.status === 'error' && job.errorMessage && (
              <div className="rq-log-line rq-log-error">{job.errorMessage}</div>
            )}
            <div ref={logsEndRef} />
          </div>
          <div className="rq-job-actions">
            {job.logs.length > 0 && (
              <Button size="sm" onClick={handleCopyLogs}>
                {copyStatus === 'copied' ? 'Copié ✓' : copyStatus === 'error' ? 'Erreur' : 'Copier logs'}
              </Button>
            )}
            {(job.status === 'done' || job.status === 'error' || job.status === 'canceled') && (
              <Button size="sm" onClick={handleOpenFolder}>
                {openFolderError ? 'Erreur' : 'Ouvrir dossier'}
              </Button>
            )}
            {job.status === 'done' && job.resultPath && (
              <span className="rq-result-path" title={job.resultPath}>
                → {basename(job.resultPath)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RenderQueuePanel({ jobs, onRemove, onCancel, onClearDone, onClose, embedded = false }) {
  const [expandedId, setExpandedId] = useState(null);
  const [panelHeight, setPanelHeight] = useState(PANEL_DEFAULT_HEIGHT);
  const resizingRef = useRef(false);
  const panelHeightRef = useRef(panelHeight);

  useEffect(() => {
    panelHeightRef.current = panelHeight;
  }, [panelHeight]);

  // Auto-expand le job en cours
  useEffect(() => {
    const running = jobs.find(j => j.status === 'running');
    if (running && expandedId === null) setExpandedId(running.id);
  }, [jobs, expandedId]);

  useEffect(() => {
    function handlePointerMove(event) {
      if (!resizingRef.current) return;
      const nextHeight = clampPanelHeight(window.innerHeight - event.clientY - PANEL_BOTTOM_OFFSET);
      panelHeightRef.current = nextHeight;
      setPanelHeight(nextHeight);
    }

    function handlePointerUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.classList.remove('rq-panel-resizing');
    }

    function handleWindowResize() {
      setPanelHeight((current) => clampPanelHeight(current));
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('resize', handleWindowResize);
      document.body.classList.remove('rq-panel-resizing');
    };
  }, []);

  function handleResizeStart(event) {
    event.preventDefault();
    resizingRef.current = true;
    document.body.classList.add('rq-panel-resizing');
  }

  const activeCount = jobs.filter(j => j.status === 'pending' || j.status === 'running').length;
  const doneCount = jobs.filter(j => j.status === 'done' || j.status === 'error' || j.status === 'canceled').length;

  return (
    <div className={`rq-panel${embedded ? ' is-embedded' : ''}`} style={{ '--rq-panel-height': `${panelHeight}px` }}>
      {!embedded && (
        <div
          className="rq-panel-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionner la file de rendu"
          title="Redimensionner"
          onPointerDown={handleResizeStart}
        />
      )}
      <div className="rq-panel-header">
        <span className="rq-panel-title">
          File de rendu
          {activeCount > 0 && <span className="rq-panel-count">{activeCount} en cours</span>}
        </span>
        <div className="rq-panel-header-actions">
          {doneCount > 0 && (
            <Button size="sm" onClick={onClearDone}>Vider terminés</Button>
          )}
          <Button size="sm" onClick={onClose} title="Fermer">✕</Button>
        </div>
      </div>

      <div className="rq-panel-body">
        {jobs.length === 0 ? (
          <div className="rq-empty">Aucun rendu en file d'attente.</div>
        ) : (
          jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              expanded={expandedId === job.id}
              onToggle={() => setExpandedId(id => id === job.id ? null : job.id)}
              onRemove={onRemove}
              onCancel={onCancel}
            />
          ))
        )}
      </div>
    </div>
  );
}
