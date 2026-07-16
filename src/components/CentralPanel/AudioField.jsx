import { lazy, Suspense, useRef, useState, useEffect } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard } from '../../store/fieldClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { pickAudio } from '../../hooks/useFileDialog';
import { useLocalFile } from '../../hooks/useLocalFile';
import { notifyFileChanged } from '../../store/fileMetadataCache';
import { useProjectContext } from '../../store/ProjectContext';
import { isTtsAvailable } from '../../store/xttsSettings';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { basename, pathKey, stripWindowsLongPathPrefix } from '../../utils/fileUtils';
import { RecordModal } from '../RecordModal/RecordModal';
// reason: lazy() pour sortir wavesurfer.js (~18 KB gz) + AudioEditorModal du
// chunk partage. Charge uniquement quand l'utilisateur ouvre l'editeur audio.
const AudioEditorModal = lazy(() => import('../AudioEditorModal/AudioEditorModal')
  .then((m) => ({ default: m.AudioEditorModal })));
import { GenerateVoiceModal } from '../GenerateVoiceModal/GenerateVoiceModal';
import { DeleteAudioDialog } from '../DeleteAudioDialog/DeleteAudioDialog';
import { Mic, Copy, Scissors, FolderOpen, FolderInput, ClipboardPaste, Play, Speech } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { ContextMenu } from '../TreePanel/ContextMenu';

const WAVE_HEIGHTS = [6, 10, 14, 10, 16, 12, 8, 14, 10, 6, 12, 8, 14, 10, 16, 8, 12, 6, 10, 14];
const FILLED_WAVE_HEIGHTS = Array.from({ length: 96 }, (_, index) => WAVE_HEIGHTS[index % WAVE_HEIGHTS.length]);
let activeAudioFieldStop = null;

function formatAudioTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AudioField({
  label,
  description,
  file,
  onPick,
  onClear,
  required = true,
  ttsTextSuggestion = '',
  ttsFilenameHint = 'tts',
  xttsTarget = null,
  accentLabel = false,
  emptyBadge = null,
}) {
  const { notifyCutPaste } = useMediaTransfer();
  const {
    savePath,
    workspaceDir,
    projectName,
    xttsSettings,
    pathAudit,
    onImportFile,
    onSave,
    onUpdateXttsSettings,
    onQueueXttsGenerate,
    onMediaCreated,
  } = useProjectContext();
  const [showRecord, setShowRecord] = useState(false);
  const [showTts, setShowTts] = useState(false);
  const [showNoSaveWarning, setShowNoSaveWarning] = useState(false);
  const [savingGeneratedAudio, setSavingGeneratedAudio] = useState(false);
  const [generatedAudioSavePath, setGeneratedAudioSavePath] = useState(null);
  const [pendingGeneratedSource, setPendingGeneratedSource] = useState(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAudioEditor, setShowAudioEditor] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef(null);
  const filename = file ? basename(file) : null;
  const displayPath = file ? stripWindowsLongPathPrefix(file) : null;
  const fileAvailable = !!file && pathAudit[file] !== false;
  const ttsAvailable = isTtsAvailable(xttsSettings);
  const showFilledState = !!file && fileAvailable;
  const audioUrl = useLocalFile(showFilledState ? file : null);
  const tooltipText = description || displayPath || '';
  const progressRatio = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const playedBars = Math.round(progressRatio * FILLED_WAVE_HEIGHTS.length);

  useEscapeKey(showNoSaveWarning && !savingGeneratedAudio, () => {
    setShowNoSaveWarning(false);
    setPendingGeneratedSource(null);
  });

  useEffect(() => {
    stopPlayback();
    setCurrentTime(0);
    setDuration(0);
  }, [file]);

  useEffect(() => () => stopPlayback(), []);

  async function handleReplace() {
    const picked = await pickAudio();
    if (picked) await handlePicked(picked);
  }

  function ensureProjectSavedForGeneratedAudio(source) {
    if (!savePath && !workspaceDir) {
      setPendingGeneratedSource(source);
      setShowNoSaveWarning(true);
      return false;
    }
    setGeneratedAudioSavePath(null);
    return true;
  }

  function handleMic() {
    if (!ensureProjectSavedForGeneratedAudio('record')) return;
    setShowRecord(true);
  }

  function handleTts() {
    if (!ensureProjectSavedForGeneratedAudio('tts')) return;
    setShowTts(true);
  }

  async function handleSaveAndContinue() {
    setSavingGeneratedAudio(true);
    const path = await onSave?.();
    setSavingGeneratedAudio(false);
    if (path) {
      setShowNoSaveWarning(false);
      setGeneratedAudioSavePath(path);
      if (pendingGeneratedSource === 'record') setShowRecord(true);
      if (pendingGeneratedSource === 'tts') setShowTts(true);
      setPendingGeneratedSource(null);
    }
  }

  async function handlePicked(path) {
    if (!path) return;
    const previous = file;
    const importedPath = await onImportFile?.(path) ?? path;
    if (onPick) await onPick(importedPath);
    // L'ancien fichier n'est plus référencé : on le garde visible dans le
    // gestionnaire de médias (filtre « Non utilisés ») plutôt que de le rendre
    // orphelin invisible sur le disque.
    if (previous && pathKey(previous) !== pathKey(importedPath)) onMediaCreated?.(previous);
  }

  function handleRecorded(path) {
    setShowRecord(false);
    if (onPick) void onPick(path);
  }

  function stopPlayback(reset = false) {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      if (reset) audio.currentTime = 0;
    }
    setIsPlaying(false);
    if (reset) setCurrentTime(0);
    if (activeAudioFieldStop === stopPlayback) activeAudioFieldStop = null;
  }

  function ensureAudioElement() {
    if (!audioUrl) return null;
    const audio = audioRef.current;
    if (audio && audio.src === audioUrl) return audio;

    if (audio) audio.pause();
    const nextAudio = new Audio(audioUrl);
    nextAudio.preload = 'metadata';
    nextAudio.addEventListener('loadedmetadata', () => {
      setDuration(Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0);
    });
    nextAudio.addEventListener('timeupdate', () => {
      setCurrentTime(nextAudio.currentTime || 0);
    });
    nextAudio.addEventListener('ended', () => {
      nextAudio.currentTime = 0;
      setCurrentTime(Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0);
      setIsPlaying(false);
      if (activeAudioFieldStop === stopPlayback) activeAudioFieldStop = null;
      window.setTimeout(() => {
        if (audioRef.current === nextAudio && !nextAudio.paused) return;
        if (audioRef.current === nextAudio) setCurrentTime(0);
      }, 350);
    });
    nextAudio.addEventListener('pause', () => setIsPlaying(false));
    nextAudio.addEventListener('play', () => setIsPlaying(true));
    audioRef.current = nextAudio;
    return nextAudio;
  }

  async function handlePlay(e) {
    e.stopPropagation();
    const audio = ensureAudioElement();
    if (!audio) return;
    if (isPlaying) {
      stopPlayback();
      return;
    }
    if (activeAudioFieldStop && activeAudioFieldStop !== stopPlayback) activeAudioFieldStop();
    activeAudioFieldStop = stopPlayback;
    try {
      await audio.play();
    } catch {
      setIsPlaying(false);
    }
  }

  function handleWaveScrub(e) {
    e.stopPropagation();
    const audio = ensureAudioElement();
    if (!audio) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const knownDuration = Number.isFinite(audio.duration) ? audio.duration : duration;
    if (!knownDuration) return;
    const nextTime = ratio * knownDuration;
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  const dropWrapRef = useRef(null);
  const handlePickedRef = useRef(handlePicked);
  handlePickedRef.current = handlePicked;

  useEffect(() => {
    const el = dropWrapRef.current;
    if (!el) return;
    function onMediaDrop(e) {
      void handlePickedRef.current(e.detail.path);
    }
    el.addEventListener('media-drop', onMediaDrop);
    return () => el.removeEventListener('media-drop', onMediaDrop);
  }, []);

  function handleContextMenu(e) {
    if (!file && !audioClipboard.get() && !onPick) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  function pasteClipboardAudio() {
    const clip = audioClipboard.getEntry();
    if (!clip?.path) return;
    if (clip.mode === 'cut') {
      notifyCutPaste({ path: clip.path, kind: 'audio' });
    }
    void handlePicked(clip.path);
    if (clip.mode === 'cut') audioClipboard.clear();
  }

  function stopButtonEvent(e) {
    e.stopPropagation();
  }

  return (
    <>
      <div
        ref={dropWrapRef}
        data-drop-kind="audio"
        onContextMenu={handleContextMenu}
      >
        {!showFilledState ? (
          <div className="audio-empty-row">
            <div className={`audio-empty ${!file ? (required ? 'is-empty' : 'is-silent') : ''} ${file && !fileAvailable ? 'is-missing' : ''}`}>
              <div
                className="audio-empty-import"
                role="button"
                tabIndex={0}
                onClick={handleReplace}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  void handleReplace();
                }}
              >
                <div className="audio-empty-wave" aria-hidden="true">
                  {WAVE_HEIGHTS.slice(0, 12).map((h, i) => (
                    <span key={i} className="audio-empty-wave-bar" style={{ height: h }} />
                  ))}
                </div>
                <span className="audio-empty-text">
                  {file && !fileAvailable
                    ? 'Fichier audio introuvable — cliquer pour en choisir un autre'
                    : (label || 'Cliquer pour importer un fichier audio')}
                </span>
                {!file && required ? <span className="audio-required-badge">Requis</span> : null}
                {!file && emptyBadge ? <span className="audio-silent-badge">{emptyBadge}</span> : null}
                <span className="audio-empty-plus">+</span>
              </div>
              <div className="audio-bar-actions" aria-label="Actions audio">
                <Tooltip text="Enregistrer l'audio">
                  <Button variant="icon" size="sm" onPointerDown={stopButtonEvent} onClick={(e) => { e.stopPropagation(); handleMic(); }} aria-label="Enregistrer l'audio">
                    <Mic className="mic-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  </Button>
                </Tooltip>
                {ttsAvailable && (
                  <Tooltip text="Générer une voix depuis un texte">
                    <Button variant="icon" size="sm" onPointerDown={stopButtonEvent} onClick={(e) => { e.stopPropagation(); handleTts(); }} aria-label="Générer une voix depuis un texte">
                      <Speech className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
                    </Button>
                  </Tooltip>
                )}
              </div>
              {file && !fileAvailable && onClear && (
                <Tooltip text="Retirer le lien cassé">
                  <button
                    className="audio-clear-btn"
                    type="button"
                    onPointerDown={stopButtonEvent}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClear();
                    }}
                    aria-label="Retirer le lien cassé"
                  >×</button>
                </Tooltip>
              )}
            </div>
          </div>
        ) : (
          <div className="audio-empty-row">
          <div className={`audio-bar ${isPlaying ? 'is-playing' : ''}`}>
            <Tooltip text={isPlaying ? 'Pause' : 'Écouter'}>
              <button
                className="play-btn"
                onClick={handlePlay}
                aria-label={isPlaying ? 'Mettre en pause' : 'Lire'}
              >
                {isPlaying
                  ? <span className="audio-pause-icon"><span className="audio-pause-bar" /><span className="audio-pause-bar" /></span>
                  : <Play className="play-icon" strokeWidth={2.2} absoluteStrokeWidth />
                }
              </button>
            </Tooltip>

            <div className="audio-label-wrap">
              <Tooltip text={tooltipText} wrap>
                <span className="audio-time">{label || filename}</span>
              </Tooltip>
            </div>

            <Tooltip text="Se déplacer dans l'audio" className="audio-wave-tip">
              <button
                type="button"
                className="wave"
                onPointerDown={handleWaveScrub}
                aria-label="Se déplacer dans l'audio"
                style={{ '--audio-progress': `${progressRatio * 100}%` }}
              >
                {FILLED_WAVE_HEIGHTS.map((h, i) => (
                  <span key={i} className={`wbar${i < playedBars ? ' is-played' : ''}`} style={{ height: h }} />
                ))}
                <span className="wave-playhead" aria-hidden="true" />
              </button>
            </Tooltip>

            <span className="audio-duration" aria-label="Temps de lecture">
              {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
            </span>

            {onClear && (
              <Tooltip text="Supprimer">
                <button
                  className="audio-clear-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    stopPlayback(true);
                    setShowDeleteDialog(true);
                  }}
                  aria-label="Retirer l'audio"
                >×</button>
              </Tooltip>
            )}
            <div className="audio-bar-actions" aria-label="Actions audio">
              <Tooltip text="Remplacer par un enregistrement">
                <Button variant="icon" size="sm" onClick={handleMic} aria-label="Remplacer par un enregistrement">
                  <Mic className="mic-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                </Button>
              </Tooltip>
              {ttsAvailable && (
                <Tooltip text="Générer une nouvelle voix depuis un texte">
                  <Button variant="icon" size="sm" onClick={handleTts} aria-label="Générer une nouvelle voix depuis un texte">
                    <Speech className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
                  </Button>
                </Tooltip>
              )}
              <Tooltip text="Éditer l'audio">
                <Button variant="icon" size="sm" onClick={() => setShowAudioEditor(true)} aria-label="Éditer l'audio">
                  <Scissors className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
                </Button>
              </Tooltip>
            </div>
          </div>
          </div>
        )}
      </div>

      {/* Notice conversion webm activée automatiquement */}
      {/* Warning projet non enregistré — propose d'enregistrer */}
      {showNoSaveWarning && (
        <div className="modal-overlay">
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <div className="modal-header">
              <span>Projet non enregistré</span>
              <Button
                variant="icon"
                className="modal-close"
                onClick={() => { setShowNoSaveWarning(false); setPendingGeneratedSource(null); }}
                disabled={savingGeneratedAudio}
              >
                ×
              </Button>
            </div>
            <div className="audio-notice-body">
              {pendingGeneratedSource === 'tts' ? (
                <>
                  L'audio genere sera stocke dans <strong>voix-generees/</strong> a cote du fichier <strong>.mbah</strong>.
                  Enregistre d'abord le projet pour pouvoir utiliser XTTS.
                </>
              ) : (
                <>
                  L'audio sera stocke dans <strong>enregistrements/</strong> a cote du fichier <strong>.mbah</strong>.
                  Enregistre d'abord le projet pour pouvoir enregistrer.
                </>
              )}
            </div>
            <div className="audio-notice-actions">
              <Button
                onClick={() => { setShowNoSaveWarning(false); setPendingGeneratedSource(null); }}
                disabled={savingGeneratedAudio}
              >
                Annuler
              </Button>
              <Button variant="primary" onClick={handleSaveAndContinue} disabled={savingGeneratedAudio}>
                {savingGeneratedAudio ? 'Enregistrement…' : 'Enregistrer le projet…'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal d'édition audio */}
      {showAudioEditor && (
        <Suspense fallback={null}>
          <AudioEditorModal
            filePath={file}
            savePath={savePath}
            workspaceDir={workspaceDir}
            onConfirm={(result) => {
              stopPlayback(true);
              setShowAudioEditor(false);
              const outputPath = typeof result === 'string' ? result : result?.output_path;
              const originalPath = typeof result === 'object' ? result?.original_path : null;
              const pathChanged = typeof result === 'object' ? !!result?.path_changed : outputPath !== file;
              if (originalPath && (!outputPath || pathKey(originalPath) !== pathKey(outputPath))) {
                onMediaCreated?.(originalPath);
              }
              if (outputPath && outputPath !== file) {
                if (onPick) void onPick(outputPath);
                onMediaCreated?.(outputPath);
                if (pathChanged && file) onMediaCreated?.(file);
              } else if (outputPath) {
                // Édition en place (format de travail FLAC/WAV) : même chemin,
                // contenu modifié. useLocalFile est mémoïsé sur le chemin et ne se
                // rafraîchit pas seul -> on force une relecture du fichier.
                notifyFileChanged(outputPath);
              }
            }}
            onCancel={() => setShowAudioEditor(false)}
          />
        </Suspense>
      )}

      {/* Modal d'enregistrement */}
      {showRecord && (
        <RecordModal
          savePath={generatedAudioSavePath || savePath}
          workspaceDir={workspaceDir}
          projectName={projectName}
          onSaved={handleRecorded}
          onClose={() => setShowRecord(false)}
        />
      )}

      {showTts && ttsAvailable && (
        <GenerateVoiceModal
          savePath={generatedAudioSavePath || savePath}
          xttsSettings={xttsSettings}
          label={label}
          initialText={ttsTextSuggestion}
          filenameHint={ttsFilenameHint}
          target={xttsTarget}
          onUpdateXttsSettings={onUpdateXttsSettings}
          onQueueGenerate={onQueueXttsGenerate}
          onClose={() => setShowTts(false)}
        />
      )}

      {/* Dialog de suppression */}
      {showDeleteDialog && onClear && (
        <DeleteAudioDialog
          file={file}
          workspaceDir={workspaceDir}
          onDeleted={() => { setShowDeleteDialog(false); onClear(); }}
          onClose={() => setShowDeleteDialog(false)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          actions={[
            ...(onPick ? [
              { icon: <FolderInput />, label: file ? "Remplacer l'audio…" : 'Choisir un fichier audio…', fn: handleReplace },
            ] : []),
            ...(file ? [
              ...(onPick ? ['sep'] : []),
              { icon: <Copy />, label: 'Copier', fn: () => audioClipboard.set(file) },
              { icon: <Scissors />, label: 'Couper', fn: () => audioClipboard.set(file, { mode: 'cut' }) },
              { icon: <FolderOpen />, label: 'Afficher dans l\'explorateur', fn: () => revealItemInDir(file) },
            ] : []),
            ...(audioClipboard.get() && onPick ? [
              {
                icon: <ClipboardPaste />,
                label: audioClipboard.getEntry()?.mode === 'cut' ? 'Déplacer ici' : 'Coller',
                fn: pasteClipboardAudio,
              },
            ] : []),
          ]}
        />
      )}

    </>
  );
}
