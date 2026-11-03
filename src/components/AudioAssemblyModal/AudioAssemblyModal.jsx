import { presentUserMessage, rustMessageEnvelope } from '../../i18n/userMessage.js';
import { presentMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { TechnicalDetail } from '../common/UserMessage';
import { sanitizeProjectPrefix } from '../../utils/projectPrefix';
import { useProjectMediaDirectory } from '../../hooks/useProjectMediaDirectory';
import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { withProjectMediaOutput } from '../../store/projectMediaOutput';
import { basename } from '../../utils/fileUtils';
import { useProjectContext } from '../../store/ProjectContext';
import { getAudioAssemblyLogicalFileName } from '../../store/mediaToolContext';
import { KEYS, read, write } from '../../store/persistentSettings';
import { Button } from '../common/Button';
import './AudioAssemblyModal.css';

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const s = Math.round(value);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Échec FFmpeg reconnu sur des valeurs indépendantes de la langue : code Rust,
// paramètres et détail techniques, ou texte brut d'un échec non codé. Le
// verdict ne dépend jamais de la phrase traduite.
export function looksLikeFfmpegFailure(value) {
  const envelope = rustMessageEnvelope(value);
  const parts = envelope?.code
    ? [/ffmpeg/i.test(envelope.code) ? 'ffmpeg' : '', ...Object.values(envelope.params ?? {}).map(String), String(envelope.detail ?? '')]
    : [typeof value === 'string' ? value : String(value?.message ?? '')];
  return /ffmpeg|invalid data|error/i.test(parts.join('\n'));
}

export function AudioAssemblyModal({
  items,
  projectName = '',
  ignoredCount = 0,
  onClose,
  onCreated,
  contextRequest = null,
  projectAction = null,
  projectActionUnavailableReason = '',
}) {
  const importDirectory = useProjectMediaDirectory('fichiers-importes');
  const { workspaceDir, mediaStorage } = useProjectContext();
  const initialItems = useMemo(
    () => items.map((item) => ({
      id: item.id || item.path,
      name: item.name || basename(item.path),
      path: item.path,
      durationSecs: item.durationSecs,
    })),
    [items],
  );
  const { t } = useMediaTranslation();
  const [orderedItems, setOrderedItems] = useState(initialItems);
  const savedOpts = useMemo(
    () => read(KEYS.AUDIO_ASSEMBLY_OPTIONS, { parse: JSON.parse, defaultValue: {} }) ?? {},
    [],
  );
  const [addSilence, setAddSilence] = useState(() => savedOpts.addSilence ?? false);
  const [silenceSec, setSilenceSec] = useState(() => savedOpts.silenceSec ?? '0.5');

  function saveOpts(patch) {
    const current = read(KEYS.AUDIO_ASSEMBLY_OPTIONS, { parse: JSON.parse, defaultValue: {} }) ?? {};
    write(KEYS.AUDIO_ASSEMBLY_OPTIONS, { ...current, ...patch }, { serialize: JSON.stringify });
  }
  const [outputFileName, setOutputFileName] = useState(() => {
    return getAudioAssemblyLogicalFileName({
      items: initialItems,
      storyNames: contextRequest?.storyNames,
      projectPrefix: sanitizeProjectPrefix(projectName),
    });
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [dragOverPosition, setDragOverPosition] = useState(null); // 'above' | 'below'
  const willReplaceStories = projectAction === 'replace-stories-with-assembly';
  // Radical de repli écrit dans le nom du fichier créé : langue active à la création.
  const logicalStem = outputFileName.trim().replace(/\.(mp3|flac|wav|ogg|m4a)$/i, '') || t('media:assembly.fallback.stem');
  const storageFileName = `${logicalStem}.flac`;

  function handleGripPointerDown(e, index) {
    if (e.button !== 0 || submitting) return;
    e.preventDefault();
    const startY = e.clientY;
    let dragging = false;
    let overIdx = null;
    let overPos = null;

    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        setDragIndex(index);
      }
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const rowEl = els.find((el) => el.dataset.assemblyIndex !== undefined);
      if (rowEl) {
        const nextIdx = parseInt(rowEl.dataset.assemblyIndex, 10);
        const rect = rowEl.getBoundingClientRect();
        const nextPos = ev.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
        if (nextIdx !== overIdx || nextPos !== overPos) {
          overIdx = nextIdx; overPos = nextPos;
          setDragOverIndex(nextIdx); setDragOverPosition(nextPos);
        }
      } else {
        overIdx = null; overPos = null;
        setDragOverIndex(null); setDragOverPosition(null);
      }
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (dragging && overIdx !== null) {
        const insertBefore = overPos === 'above' ? overIdx : overIdx + 1;
        setOrderedItems((current) => {
          const next = [...current];
          const [item] = next.splice(index, 1);
          const adjusted = insertBefore > index ? insertBefore - 1 : insertBefore;
          next.splice(Math.max(0, Math.min(adjusted, next.length)), 0, item);
          return next;
        });
      }
      setDragIndex(null);
      setDragOverIndex(null);
      setDragOverPosition(null);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const canSubmit = orderedItems.length >= 2 && outputFileName.trim() && !submitting;

  function moveItem(index, delta) {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= orderedItems.length) return;
    setOrderedItems((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  function removeItem(index) {
    setOrderedItems((current) => current.filter((_, i) => i !== index));
  }


  function readableError(value) {
    if (value?.key) return presentMedia(value);
    const text = presentUserMessage(value).message.trim();
    if (!text) return t('media:assembly.error.generic');
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || text;
    if (looksLikeFfmpegFailure(value)) {
      return t('media:assembly.error.ffmpeg', { detail: firstLine });
    }
    return firstLine;
  }
  const errorPresentation = error && !error.key ? presentUserMessage(error) : null;

  async function handleSubmit() {
    setError('');
    if (!workspaceDir) {
      setError({ key: 'media:assembly.workspace.missing' });
      return;
    }
    if (orderedItems.length < 2) {
      setError({ key: 'media:assembly.items.tooFew' });
      return;
    }
    const silence = addSilence ? Number(String(silenceSec).replace(',', '.')) : 0;
    if (!Number.isFinite(silence) || silence < 0 || silence > 30) {
      setError({ key: 'media:assembly.silence.invalid' });
      return;
    }

    setSubmitting(true);
    try {
      const inputPaths = orderedItems.map((item) => item.path);
      // Le backend force l'extension du fichier de travail (FLAC) ; on n'envoie
      // que le radical, en retirant une extension audio éventuellement saisie.
      const rawName = logicalStem;
      const outputPath = await withProjectMediaOutput(mediaStorage ?? { root: workspaceDir, ephemeral: true }, async (output) => invoke('concat_audio_files', {
        inputPaths,
        outputFileName: rawName,
        silenceBetweenSec: silence,
        ...await output.arguments(),
      }));
      onCreated?.(outputPath, {
        inputPaths,
        logicalName: logicalStem,
        projectAction,
        projectActionUnavailableReason,
      });
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box audio-assembly-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{willReplaceStories ? t('media:assembly.replace.title') : t('media:assembly.title')}</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="audio-assembly-body">
          <div className="audio-assembly-intro">
            {contextRequest ? (
              <strong>{t('media:assembly.context.stories', { count: contextRequest.storyNames.length })}</strong>
            ) : null}
            <span>{t('media:assembly.intro.description')}</span>
            <span>{t('media:assembly.intro.originals')}</span>
            {willReplaceStories ? (
              <span>{t('media:assembly.intro.replace')}</span>
            ) : null}
            {contextRequest && !willReplaceStories ? (
              <span>{projectActionUnavailableReason
                ? t('media:assembly.project.unchangedReason', { reason: projectActionUnavailableReason })
                : t('media:assembly.project.unchanged')}</span>
            ) : null}
          </div>

          {ignoredCount > 0 && (
            <div className="audio-assembly-note">
              {t('media:assembly.ignored.notice', { count: ignoredCount })}
            </div>
          )}

          <section className="audio-assembly-section">
            <h3>{t('media:assembly.list.title')}</h3>
            <div className="audio-assembly-list">
              {orderedItems.map((item, index) => (
                <div
                  className={`audio-assembly-row${dragIndex === index ? ' is-dragging' : ''}${dragOverIndex === index && dragIndex !== index && dragOverPosition === 'above' ? ' is-drag-over-above' : ''}${dragOverIndex === index && dragIndex !== index && dragOverPosition === 'below' ? ' is-drag-over-below' : ''}`}
                  key={item.id}
                  data-assembly-index={index}
                >
                  <span
                    className="audio-assembly-grip"
                    aria-hidden="true"
                    onPointerDown={(e) => handleGripPointerDown(e, index)}
                  >≡</span>
                  <span className="audio-assembly-name" title={item.name}>{index + 1}. {item.name}</span>
                  <span className="audio-assembly-duration">{formatDuration(item.durationSecs)}</span>
                  <Button variant="icon" className="audio-assembly-icon-btn" onClick={() => moveItem(index, -1)} disabled={submitting || index === 0} title={t('media:assembly.item.up')}>↑</Button>
                  <Button variant="icon" className="audio-assembly-icon-btn" onClick={() => moveItem(index, 1)} disabled={submitting || index === orderedItems.length - 1} title={t('media:assembly.item.down')}>↓</Button>
                  <Button variant="icon" className="audio-assembly-icon-btn is-danger" onClick={() => removeItem(index)} disabled={submitting || orderedItems.length <= 2} title={t('media:delete.remove.action')}>×</Button>
                </div>
              ))}
            </div>
          </section>

          <section className="audio-assembly-section">
            <h3>{t('media:assembly.options.title')}</h3>
            <label className="audio-assembly-check">
              <input
                type="checkbox"
                checked={addSilence}
                onChange={(e) => { setAddSilence(e.target.checked); saveOpts({ addSilence: e.target.checked }); }}
                disabled={submitting}
              />
              <span>{t('media:assembly.silence.label')}</span>
            </label>
            {addSilence && (
              <label className="audio-assembly-field is-inline">
                <span>{t('media:explorer.column.duration')}</span>
                <input
                  type="number"
                  min="0"
                  max="30"
                  step="0.1"
                  value={silenceSec}
                  onChange={(e) => { setSilenceSec(e.target.value); saveOpts({ silenceSec: e.target.value }); }}
                  disabled={submitting}
                />
                <span>{t('media:assembly.silence.unit')}</span>
              </label>
            )}
            <div className="audio-assembly-note">
              {t('media:assembly.sources.note')}
            </div>
          </section>

          <section className="audio-assembly-section">
            <label className="audio-assembly-field">
              <span>{t('media:assembly.output.label')}</span>
              <input
                value={outputFileName}
                onChange={(e) => setOutputFileName(e.target.value)}
                disabled={submitting}
                placeholder={t('media:assembly.output.placeholder')}
              />
            </label>
            <div className="audio-assembly-destination">
              <span>{t('media:assembly.output.created')}</span>
              <strong title={`${importDirectory}/${storageFileName}`}>{importDirectory}/{storageFileName}</strong>
            </div>
          </section>

          {error && <div className="audio-assembly-error">{readableError(error)}<TechnicalDetail value={errorPresentation?.fallback ? errorPresentation.technicalDetail : ''} /></div>}
        </div>

        <div className="audio-assembly-footer">
          <Button onClick={onClose} disabled={submitting}>{t('common:dialog.cancel.label')}</Button>
          <Button variant="primary" className="audio-assembly-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <span className="audio-assembly-spinner" />}
            {submitting ? t('media:assembly.submit.progress') : (willReplaceStories ? t('media:assembly.submit.replace') : t('media:assembly.submit.action'))}
          </Button>
        </div>
      </div>
    </div>
  );
}
