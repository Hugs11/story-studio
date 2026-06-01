import { useEffect, useRef, useState } from 'react';
import { useLocalFile } from '../../hooks/useLocalFile';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Tooltip } from '../common/Tooltip';
import { basename } from '../../utils/fileUtils';
import { mediaDrag } from '../../store/dragState';
import './SDQueuePanel.css';

function formatTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function CompactAudioPlayer({ url }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    setPlaying(false);
    setCurrent(0);
  }, [url]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else a.play().catch(() => {});
  }

  function seek(e) {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(a.currentTime);
  }

  const progress = duration ? (current / duration) * 100 : 0;

  return (
    <div className="sd-audio-mini">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />
      <button
        type="button"
        className="sd-audio-mini-btn"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Lecture'}
      >
        {playing ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5Z" />
          </svg>
        )}
      </button>
      <div className="sd-audio-mini-track" onClick={seek}>
        <div className="sd-audio-mini-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="sd-audio-mini-time">
        {formatTime(current)} / {formatTime(duration)}
      </span>
    </div>
  );
}

function startQueueMediaDrag(event, { kind, path, label, onDragStart = null }) {
  if (!path || (kind !== 'audio' && kind !== 'image') || event.button !== 0) return;
  if (event.target?.closest?.('input, textarea, [role="slider"], .sd-audio-mini')) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let ghost = null;
  let currentTarget = null;

  function findTarget(x, y) {
    return document.elementsFromPoint(x, y).find((el) => el.dataset.dropKind === kind) ?? null;
  }

  function onMove(ev) {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return;
      dragging = true;
      onDragStart?.();
      mediaDrag.start(kind, path);
      ghost = document.createElement('div');
      ghost.className = 'sd-queue-drag-ghost';
      ghost.textContent = label || basename(path);
      document.body.appendChild(ghost);
    }

    ghost.style.left = `${ev.clientX + 14}px`;
    ghost.style.top = `${ev.clientY - 14}px`;

    const nextTarget = findTarget(ev.clientX, ev.clientY);
    if (nextTarget !== currentTarget) {
      currentTarget?.classList.remove('is-drop-over');
      nextTarget?.classList.add('is-drop-over');
      currentTarget = nextTarget;
      ghost.classList.toggle('is-over-target', !!nextTarget);
    }
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (ghost) {
      document.body.removeChild(ghost);
      ghost = null;
    }
    currentTarget?.classList.remove('is-drop-over');

    if (dragging && currentTarget) {
      currentTarget.dispatchEvent(new CustomEvent('media-drop', {
        bubbles: false,
        detail: { path, kind },
      }));
    }
    mediaDrag.end();
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function JobResultThumb({ path, onPreview }) {
  const url = useLocalFile(path);
  const draggedRef = useRef(false);

  function handleClick(event) {
    if (draggedRef.current) {
      event.preventDefault();
      draggedRef.current = false;
      return;
    }
    onPreview(path);
  }

  return (
    <Tooltip text="Glisser vers un placeholder image, cliquer pour prévisualiser">
      <button
        className="sd-result-thumb"
        onPointerDown={(event) => startQueueMediaDrag(event, {
          kind: 'image',
          path,
          label: basename(path),
          onDragStart: () => { draggedRef.current = true; },
        })}
        onClick={handleClick}
      >
        {url ? (
          <img src={url} alt="" className="sd-result-img" />
        ) : (
          <div className="sd-result-placeholder" />
        )}
      </button>
    </Tooltip>
  );
}

function ImagePreviewModal({ path, onClose }) {
  const url = useLocalFile(path);
  const filename = basename(path);
  useEscapeKey(true, () => onClose?.());
  return (
    <div className="modal-overlay sd-preview-overlay" onMouseDown={onClose}>
      <div className="modal-box sd-preview-box" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{filename || 'Image générée'}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="sd-preview-body">
          {url ? <img src={url} alt={filename} className="sd-preview-img" /> : <div className="sd-result-placeholder" />}
        </div>
      </div>
    </div>
  );
}

function AudioResult({ path }) {
  const url = useLocalFile(path);
  const filename = basename(path);
  return (
    <div
      className="sd-audio-result"
      onPointerDown={(event) => startQueueMediaDrag(event, {
        kind: 'audio',
        path,
        label: filename,
      })}
    >
      <Tooltip text={path} wrap className="sd-audio-file-tooltip">
        <div className="sd-audio-file" title="Glisser vers un placeholder audio">{filename}</div>
      </Tooltip>
      {url && <CompactAudioPlayer url={url} />}
    </div>
  );
}

function progressPercent(progress) {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

function ProgressRing({ progress }) {
  const percent = progressPercent(progress);

  if (percent == null) {
    return <span className="sd-progress-ring sd-progress-ring-spin" aria-hidden="true" />;
  }

  return (
    <Tooltip text={`Progression ${percent}%`}>
      <span
        className="sd-progress-ring"
        style={{ '--progress': `${percent}%` }}
        aria-label={`Progression ${percent}%`}
      />
    </Tooltip>
  );
}

function UsageBadge({ usage }) {
  if (!usage) return null;
  return (
    <Tooltip text={usage.detail} wrap>
      <span className={`sd-usage-badge sd-usage-${usage.state}`}>
        {usage.label}
      </span>
    </Tooltip>
  );
}

function JobCard({ job, onRemove, onPreviewImage, onRegenerateImage, getAudioUsage, getImageUsage }) {
  const statusLabel = {
    pending: 'En attente',
    submitting: 'Envoi…',
    running: 'Génération…',
    done: 'Terminé',
    error: 'Erreur',
  }[job.status] ?? job.status;
  const isImageJob = job.kind !== 'audio';
  const title = isImageJob ? job.workflowName : job.label;
  const subtitle = isImageJob ? null : job.voiceLabel;
  const isActive = job.status === 'pending' || job.status === 'submitting' || job.status === 'running';
  const percent = progressPercent(job.progress);
  const audioUsage = !isImageJob ? getAudioUsage?.(job) : null;
  const imageUsage = isImageJob ? getImageUsage?.(job) : null;

  return (
    <div className={`sd-job-card sd-job-${job.status}`}>
      <div className="sd-job-header">
        <div className="sd-job-title-wrap">
          <span className="sd-job-name">{title}</span>
          {subtitle && <span className="sd-job-subtitle">{subtitle}</span>}
        </div>
        <div className={`sd-job-badge sd-badge-${job.status}`}>
          {isActive && <ProgressRing progress={job.progress} />}
          {isActive && percent != null ? `${percent}%` : statusLabel}
        </div>
        {job.status === 'done' && isImageJob && <UsageBadge usage={imageUsage} />}
        {job.status === 'done' && !isImageJob && <UsageBadge usage={audioUsage} />}
        {job.status === 'done' && isImageJob && (
          <button className="sd-job-action btn-xs" onClick={() => onRegenerateImage?.(job)}>
            Regénérer image
          </button>
        )}
        {(job.status === 'done' || job.status === 'error') && (
          <button className="sd-job-remove btn-xs" onClick={() => onRemove(job.id)}>✕</button>
        )}
      </div>
      {job.status === 'error' && job.errorMessage && (
        <div className="sd-job-error">{job.errorMessage}</div>
      )}
      {job.kind === 'audio' && !audioUsage && job.targetLabel && (
        <div className="sd-job-meta">Destination: {job.targetLabel}</div>
      )}
      {isImageJob && job.targetLabel && (
        <div className="sd-job-meta">Destination: {job.targetLabel}</div>
      )}
      {job.status === 'done' && isImageJob && job.resultPaths.length > 0 && (
        <div className="sd-job-results">
          {job.resultPaths.map(path => (
            <JobResultThumb key={path} path={path} onPreview={onPreviewImage} />
          ))}
        </div>
      )}
      {job.status === 'done' && !isImageJob && job.resultPath && (
        <AudioResult path={job.resultPath} />
      )}
    </div>
  );
}

export function SDQueuePanel({
  imageJobs = [],
  audioJobs = [],
  onRemoveImage,
  onRemoveAudio,
  getAudioUsage,
  getImageUsage,
  onRegenerateImage,
  onClearDone,
  onClose,
  embedded = false,
}) {
  const jobs = [...imageJobs, ...audioJobs].sort((a, b) => b.createdAt - a.createdAt);
  const hasDone = jobs.some(j => j.status === 'done' || j.status === 'error');
  const [previewPath, setPreviewPath] = useState(null);
  useEscapeKey(!embedded && !previewPath, () => onClose?.());

  const content = (
    <>
      <div className={embedded ? 'sd-queue-embedded-header' : 'modal-header'}>
        <span>Générations IA</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasDone && (
            <button className="btn btn-xs" onClick={onClearDone}>
              Effacer terminées
            </button>
          )}
          {!embedded && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>
      </div>

      <div className="sd-queue-body">
        {jobs.length === 0 ? (
          <div className="sd-queue-empty">Aucune génération en cours.</div>
        ) : (
          jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onRemove={job.kind === 'audio' ? onRemoveAudio : onRemoveImage}
              onPreviewImage={setPreviewPath}
              onRegenerateImage={onRegenerateImage}
              getAudioUsage={getAudioUsage}
              getImageUsage={getImageUsage}
            />
          ))
        )}
      </div>
      {previewPath && (
        <ImagePreviewModal path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </>
  );

  if (embedded) {
    return <div className="sd-queue-embedded">{content}</div>;
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box sd-queue-box">
        {content}
      </div>
    </div>
  );
}
