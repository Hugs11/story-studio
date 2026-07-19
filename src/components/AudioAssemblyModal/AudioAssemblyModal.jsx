import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sanitizeProjectPrefix } from '../../utils/projectPrefix';
import { basename } from '../../utils/fileUtils';
import { useProjectContext } from '../../store/ProjectContext';
import { KEYS, read, write } from '../../store/persistentSettings';
import { Button } from '../common/Button';
import './AudioAssemblyModal.css';

function fileStem(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const s = Math.round(value);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function defaultOutputName(items) {
  const firstName = fileStem(items[0]?.name || 'audio');
  if (items.length <= 1) return `${firstName}_assemble.flac`;
  const commonPrefix = items
    .map((item) => fileStem(item.name || 'audio'))
    .reduce((prefix, name) => {
      let i = 0;
      while (i < prefix.length && i < name.length && prefix[i].toLowerCase() === name[i].toLowerCase()) i += 1;
      return prefix.slice(0, i);
    }, firstName)
    .replace(/[_\-\s]+$/g, '');
  return `${commonPrefix || firstName}_assemble.flac`;
}

export function AudioAssemblyModal({
  items,
  ignoredCount = 0,
  savePath,
  projectName = '',
  onClose,
  onCreated,
  contextRequest = null,
}) {
  const { workspaceDir } = useProjectContext();
  const initialItems = useMemo(
    () => items.map((item) => ({
      id: item.id || item.path,
      name: item.name || basename(item.path),
      path: item.path,
      durationSecs: item.durationSecs,
    })),
    [items],
  );
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
    const base = defaultOutputName(initialItems);
    const prefix = sanitizeProjectPrefix(projectName);
    return prefix ? `${prefix}__${base}` : base;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [dragOverPosition, setDragOverPosition] = useState(null); // 'above' | 'below'

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
    const text = String(value || '').trim();
    if (!text) return "L'assemblage audio a échoué.";
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || text;
    if (/ffmpeg|invalid data|error/i.test(text)) {
      return `FFmpeg n'a pas pu assembler ces fichiers. ${firstLine}`;
    }
    return firstLine;
  }

  async function handleSubmit() {
    setError('');
    if (!savePath && !workspaceDir) {
      setError('Enregistrez le projet avant de créer un fichier assemblé.');
      return;
    }
    if (orderedItems.length < 2) {
      setError('Conservez au moins deux audios à assembler.');
      return;
    }
    const silence = addSilence ? Number(String(silenceSec).replace(',', '.')) : 0;
    if (!Number.isFinite(silence) || silence < 0 || silence > 30) {
      setError('La durée du silence doit être comprise entre 0 et 30 secondes.');
      return;
    }

    setSubmitting(true);
    try {
      const inputPaths = orderedItems.map((item) => item.path);
      // Le backend force l'extension du fichier de travail (FLAC) ; on n'envoie
      // que le radical, en retirant une extension audio éventuellement saisie.
      const rawName = outputFileName.trim().replace(/\.(mp3|flac|wav|ogg|m4a)$/i, '') || 'montage';
      const outputPath = await invoke('concat_audio_files', {
        savePath: savePath || '',
        inputPaths,
        outputFileName: rawName,
        silenceBetweenSec: silence,
        workspaceDir: workspaceDir || null,
      });
      onCreated?.(outputPath, { inputPaths });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box audio-assembly-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Assembler des audios</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="audio-assembly-body">
          <div className="audio-assembly-intro">
            {contextRequest ? (
              <strong>Depuis {contextRequest.storyNames.length} histoires sélectionnées</strong>
            ) : null}
            <span>Crée une piste audio unique à partir des fichiers sélectionnés.</span>
            <span>Les fichiers originaux ne seront pas modifiés.</span>
            {contextRequest ? <span>Le projet ne sera pas modifié automatiquement.</span> : null}
          </div>

          {ignoredCount > 0 && (
            <div className="audio-assembly-note">
              Seuls les fichiers audio peuvent être assemblés. {ignoredCount} média{ignoredCount > 1 ? 's' : ''} non audio ignoré{ignoredCount > 1 ? 's' : ''}.
            </div>
          )}

          <section className="audio-assembly-section">
            <h3>Audios à assembler</h3>
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
                  <Button variant="icon" className="audio-assembly-icon-btn" onClick={() => moveItem(index, -1)} disabled={submitting || index === 0} title="Monter">↑</Button>
                  <Button variant="icon" className="audio-assembly-icon-btn" onClick={() => moveItem(index, 1)} disabled={submitting || index === orderedItems.length - 1} title="Descendre">↓</Button>
                  <Button variant="icon" className="audio-assembly-icon-btn is-danger" onClick={() => removeItem(index)} disabled={submitting || orderedItems.length <= 2} title="Retirer">×</Button>
                </div>
              ))}
            </div>
          </section>

          <section className="audio-assembly-section">
            <h3>Options</h3>
            <label className="audio-assembly-check">
              <input
                type="checkbox"
                checked={addSilence}
                onChange={(e) => { setAddSilence(e.target.checked); saveOpts({ addSilence: e.target.checked }); }}
                disabled={submitting}
              />
              <span>Ajouter un silence entre les fichiers</span>
            </label>
            {addSilence && (
              <label className="audio-assembly-field is-inline">
                <span>Durée</span>
                <input
                  type="number"
                  min="0"
                  max="30"
                  step="0.1"
                  value={silenceSec}
                  onChange={(e) => { setSilenceSec(e.target.value); saveOpts({ silenceSec: e.target.value }); }}
                  disabled={submitting}
                />
                <span>secondes</span>
              </label>
            )}
            <div className="audio-assembly-note">
              Les fichiers sources restent dans la médiathèque. Ils pourront ensuite être retirés ou supprimés depuis l’onglet Médias.
            </div>
          </section>

          <section className="audio-assembly-section">
            <label className="audio-assembly-field">
              <span>Nom du fichier final</span>
              <input
                value={outputFileName}
                onChange={(e) => setOutputFileName(e.target.value)}
                disabled={submitting}
                placeholder="histoire_complete.flac"
              />
            </label>
            <div className="audio-assembly-destination">
              <span>Destination</span>
              <strong>fichiers-importes/</strong>
            </div>
          </section>

          {error && <div className="audio-assembly-error">{error}</div>}
        </div>

        <div className="audio-assembly-footer">
          <Button onClick={onClose} disabled={submitting}>Annuler</Button>
          <Button variant="primary" className="audio-assembly-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <span className="audio-assembly-spinner" />}
            {submitting ? 'Assemblage…' : 'Assembler'}
          </Button>
        </div>
      </div>
    </div>
  );
}
