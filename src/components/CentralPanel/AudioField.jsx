import { lazy, Suspense, useRef, useState, useEffect } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { audioClipboard } from '../../store/fieldClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { pickAudio } from '../../hooks/useFileDialog';
import { useProjectContext } from '../../store/ProjectContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { basename, stripWindowsLongPathPrefix } from '../../utils/fileUtils';
import { RecordModal } from '../RecordModal/RecordModal';
// reason: lazy() pour sortir wavesurfer.js (~18 KB gz) + AudioEditorModal du
// chunk partage. Charge uniquement quand l'utilisateur ouvre l'editeur audio.
const AudioEditorModal = lazy(() => import('../AudioEditorModal/AudioEditorModal')
  .then((m) => ({ default: m.AudioEditorModal })));
import { GenerateVoiceModal } from '../GenerateVoiceModal/GenerateVoiceModal';
import { DeleteAudioDialog } from '../DeleteAudioDialog/DeleteAudioDialog';
import { Mic, Copy, Scissors, FolderOpen, ClipboardPaste, Speech } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { MediaPopover } from '../MediaExplorer/MediaPopover';

const WAVE_HEIGHTS = [6, 10, 14, 10, 16, 12, 8, 14, 10, 6, 12, 8, 14, 10, 16, 8, 12, 6, 10, 14];
const FILLED_WAVE_HEIGHTS = Array.from({ length: 96 }, (_, index) => WAVE_HEIGHTS[index % WAVE_HEIGHTS.length]);

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
}) {
  const { notifyCutPaste } = useMediaTransfer();
  const {
    savePath,
    workspaceDir,
    projectName,
    globalOptions,
    xttsSettings,
    pathAudit,
    onEnableConvert,
    onImportFile,
    onSave,
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
  const [showConvertNotice, setShowConvertNotice] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [playerAnchorRect, setPlayerAnchorRect] = useState(null);
  const filename = file ? basename(file) : null;
  const displayPath = file ? stripWindowsLongPathPrefix(file) : null;
  const fileAvailable = !!file && pathAudit[file] !== false;
  const showFilledState = !!file && fileAvailable;
  const tooltipText = description || displayPath || '';

  useEscapeKey(showConvertNotice, () => setShowConvertNotice(false));
  useEscapeKey(showNoSaveWarning && !savingGeneratedAudio, () => {
    setShowNoSaveWarning(false);
    setPendingGeneratedSource(null);
  });

  // Ferme le player quand le fichier change (navigation entre stories sans remount).
  useEffect(() => {
    setPlayerAnchorRect(null);
  }, [file]);

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
    const importedPath = await onImportFile?.(path) ?? path;
    const isWebm = importedPath.toLowerCase().endsWith('.webm');
    if (isWebm && onEnableConvert && !globalOptions?.convertFormat) {
      onEnableConvert();
      setShowConvertNotice(true);
    }
    if (onPick) await onPick(importedPath);
  }

  function handleRecorded(path) {
    setShowRecord(false);
    if (onPick) void onPick(path);
  }

  function handlePlay(e) {
    e.stopPropagation();
    if (playerAnchorRect) {
      setPlayerAnchorRect(null);
      return;
    }
    setPlayerAnchorRect(e.currentTarget.getBoundingClientRect());
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
    if (!file && !audioClipboard.get()) return;
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

  return (
    <>
      <div
        ref={dropWrapRef}
        data-drop-kind="audio"
        onContextMenu={handleContextMenu}
      >
        {!showFilledState ? (
          <div className="audio-empty-row">
            <div className={`audio-empty ${!file ? 'is-empty' : ''} ${file && !fileAvailable ? 'is-missing' : ''}`} onClick={handleReplace}>
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
              <span className="audio-empty-plus">+</span>
            </div>
            <Tooltip text="Enregistrer l'audio">
              <button className="mic-btn" onClick={handleMic}>
                <Mic className="mic-btn-icon" strokeWidth={2} absoluteStrokeWidth />
              </button>
            </Tooltip>
            {xttsSettings?.enabled && (
              <Tooltip text="Générer une voix depuis un texte">
                <button className="tts-btn" onClick={handleTts}>
                  <Speech className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
                </button>
              </Tooltip>
            )}
            {file && !fileAvailable && onClear && (
              <Tooltip text="Retirer le lien cassé">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 14, padding: '0 2px' }}
                >×</button>
              </Tooltip>
            )}
          </div>
        ) : (
          <div className="audio-empty-row">
          <div className={`audio-bar ${playerAnchorRect ? 'is-playing' : ''}`}>
            <Tooltip text={playerAnchorRect ? 'Fermer le lecteur' : 'Écouter'}>
              <button
                className="play-btn"
                onClick={handlePlay}
              >
                {playerAnchorRect
                  ? <div style={{ width: 8, height: 10, display: 'flex', gap: 2 }}>
                      <div style={{ width: 3, height: 10, background: 'currentColor', borderRadius: 1 }} />
                      <div style={{ width: 3, height: 10, background: 'currentColor', borderRadius: 1 }} />
                    </div>
                  : <div className="play-arrow" />
                }
              </button>
            </Tooltip>

            <div className="audio-label-wrap">
              <Tooltip text={tooltipText} wrap>
                <span className="audio-time">{label || filename}</span>
              </Tooltip>
            </div>

            <div className="wave" aria-hidden="true">
              {FILLED_WAVE_HEIGHTS.map((h, i) => (
                <div key={i} className="wbar" style={{ height: h }} />
              ))}
            </div>

            {onClear && (
              <Tooltip text="Supprimer">
                <button
                  className="audio-clear-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPlayerAnchorRect(null);
                    setShowDeleteDialog(true);
                  }}
                >×</button>
              </Tooltip>
            )}
          </div>
          <Tooltip text="Remplacer par un enregistrement">
            <button className="mic-btn" onClick={handleMic}>
              <Mic className="mic-btn-icon" strokeWidth={2} absoluteStrokeWidth />
            </button>
          </Tooltip>
          {xttsSettings?.enabled && (
            <Tooltip text="Générer une nouvelle voix depuis un texte">
              <button className="tts-btn" onClick={handleTts}>
                <Speech className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
              </button>
            </Tooltip>
          )}
          <Tooltip text="Éditer l'audio">
            <button className="tts-btn" onClick={() => setShowAudioEditor(true)}>
              <Scissors className="audio-action-icon" strokeWidth={2} absoluteStrokeWidth />
            </button>
          </Tooltip>
          </div>
        )}
      </div>

      {/* Notice conversion webm activée automatiquement */}
      {showConvertNotice && (
        <div className="modal-overlay">
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 340 }}>
            <div className="modal-header">
              <span>Conversion activée automatiquement</span>
              <button className="modal-close" onClick={() => setShowConvertNotice(false)}>×</button>
            </div>
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              Le fichier enregistré est au format <strong>.webm</strong>. L'option <strong>«&nbsp;Convertir au bon format&nbsp;»</strong> a été activée automatiquement dans les réglages de l'histoire pour garantir la compatibilité avec votre Boîte à Histoires.
            </div>
            <div style={{ padding: '0 20px 16px', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setShowConvertNotice(false)}>Compris</button>
            </div>
          </div>
        </div>
      )}

      {/* Warning projet non sauvegardé — propose de sauvegarder */}
      {showNoSaveWarning && (
        <div className="modal-overlay">
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <div className="modal-header">
              <span>Projet non sauvegardé</span>
              <button
                className="modal-close"
                onClick={() => { setShowNoSaveWarning(false); setPendingGeneratedSource(null); }}
                disabled={savingGeneratedAudio}
              >
                ×
              </button>
            </div>
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              {pendingGeneratedSource === 'tts' ? (
                <>
                  L'audio genere sera stocke dans <strong>voix-generees/</strong> a cote du fichier <strong>.mbah</strong>.
                  Sauvegardez d'abord le projet pour pouvoir utiliser XTTS.
                </>
              ) : (
                <>
                  L'audio sera stocke dans <strong>enregistrements/</strong> a cote du fichier <strong>.mbah</strong>.
                  Sauvegardez d'abord le projet pour pouvoir enregistrer.
                </>
              )}
            </div>
            <div style={{ padding: '0 20px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => { setShowNoSaveWarning(false); setPendingGeneratedSource(null); }}
                disabled={savingGeneratedAudio}
              >
                Annuler
              </button>
              <button className="btn btn-primary" onClick={handleSaveAndContinue} disabled={savingGeneratedAudio}>
                {savingGeneratedAudio ? 'Sauvegarde…' : 'Sauvegarder le projet…'}
              </button>
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
            onConfirm={(outputPath) => {
              setPlayerAnchorRect(null);
              setShowAudioEditor(false);
              if (outputPath !== file && onPick) void onPick(outputPath);
              if (outputPath && outputPath !== file) onMediaCreated?.(outputPath);
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

      {showTts && xttsSettings?.enabled && (
        <GenerateVoiceModal
          savePath={generatedAudioSavePath || savePath}
          xttsSettings={xttsSettings}
          label={label}
          initialText={ttsTextSuggestion}
          filenameHint={ttsFilenameHint}
          target={xttsTarget}
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
            ...(file ? [
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

      {playerAnchorRect && showFilledState && (
        <MediaPopover
          item={{
            kind: 'audio',
            path: file,
            name: filename || label || 'Audio',
            usages: [],
          }}
          anchorRect={playerAnchorRect}
          onClose={() => setPlayerAnchorRect(null)}
        />
      )}
    </>
  );
}
