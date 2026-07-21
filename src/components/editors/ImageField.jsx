import { lazy, Suspense, useMemo, useRef, useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { imageClipboard } from '../../store/fieldClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { pickImage } from '../../hooks/useFileDialog';
import { useLocalFile } from '../../hooks/useLocalFile';
import { useProjectContext } from '../../store/ProjectContext';
import { basename, stripWindowsLongPathPrefix } from '../../utils/fileUtils';
import { readImageEditMetadata, writeImageEditMetadata } from '../../store/imageEditMetadata';
// reason: lazy() pour sortir ImageEditorModal (~3 KB gz) + canvas/PNG export
// du chunk partage. Charge uniquement quand l'utilisateur edite une image.
const ImageEditorModal = lazy(() => import('../ImageEditorModal/ImageEditorModal')
  .then((m) => ({ default: m.ImageEditorModal })));
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { Copy, Scissors, FolderOpen, ClipboardPaste, Sparkles, Image as ImageIcon } from '../icons/LucideLocal';
import './ImageField.css';

function SdResultThumb({ path, onPick, onRemove }) {
  const url = useLocalFile(path);
  return (
    <div className="image-sd-thumb-wrap">
      <Tooltip text="Utiliser cette image">
        <button className="image-sd-thumb" onClick={() => onPick(path)}>
          {url ? <img src={url} alt="" /> : <div className="image-sd-thumb-placeholder" />}
        </button>
      </Tooltip>
      <Tooltip text="Supprimer" className="image-sd-thumb-remove-wrap">
        <button
          className="image-sd-thumb-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label="Supprimer"
        >×</button>
      </Tooltip>
    </div>
  );
}

export function ImageField({
  label,
  file,
  onPick,
  onClear,
  extraActions = [],
  compact = false,
  align = 'center',
  fieldId = null,
  formatHint = 'Format recommandé : 320 × 240 px',
  badge = null,
}) {
  const { notifyCutPaste } = useMediaTransfer();
  const {
    pathAudit,
    sdSettings,
    sdJobs,
    workspaceDir,
    onOpenSDGenerate,
    onRemoveSdResult,
    onImportFile,
  } = useProjectContext();
  const aiEnabled = sdSettings?.aiImageGen && !!onOpenSDGenerate;
  const previewUrl = useLocalFile(file);
  const filename = file ? basename(file) : null;
  const displayPath = file ? stripWindowsLongPathPrefix(file) : null;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSource, setEditorSource] = useState(null);
  const [editorInitialTransform, setEditorInitialTransform] = useState(null);
  const [editorInitialFilters, setEditorInitialFilters] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const autoAppliedSdResultsRef = useRef(new Set());
  const editorRequestIdRef = useRef(0);
  const fileAvailable = !!file && pathAudit[file] !== false;
  const showFilledState = !!file && fileAvailable;
  const isGeneratingForField = useMemo(
    () => !!fieldId && (sdJobs ?? []).some(j => (
      j.fieldId === fieldId
      && (j.status === 'pending' || j.status === 'submitting' || j.status === 'running')
    )),
    [sdJobs, fieldId],
  );

  const sdResults = useMemo(
    () => (sdJobs ?? [])
      .filter(j => j.status === 'done' && j.resultPaths.length > 0 && (fieldId ? j.fieldId === fieldId : !j.fieldId))
      .flatMap(j => j.resultPaths.map(path => ({ path, jobId: j.id }))),
    [sdJobs, fieldId],
  );

  useEffect(() => {
    if (file || !onPick || sdResults.length === 0) return;
    const next = sdResults.find(({ path }) => !autoAppliedSdResultsRef.current.has(path));
    if (!next?.path) return;
    autoAppliedSdResultsRef.current.add(next.path);
    onPick(next.path);
  }, [file, onPick, sdResults]);

  async function handlePick() {
    const picked = await pickImage();
    if (!picked) return;
    editorRequestIdRef.current += 1;
    setEditorSource(picked);
    setEditorInitialTransform(null);
    setEditorInitialFilters(null);
    setEditorOpen(true);
  }

  async function openEditor(path) {
    const requestId = ++editorRequestIdRef.current;
    const metadata = await readImageEditMetadata(path);
    if (requestId !== editorRequestIdRef.current) return;
    setEditorSource(metadata?.sourcePath || path);
    setEditorInitialTransform(metadata?.transform ?? null);
    setEditorInitialFilters(metadata?.filters ?? null);
    setEditorOpen(true);
  }

  function handleEdit(e) {
    e.stopPropagation();
    if (!fileAvailable) return;
    openEditor(file);
  }

  async function handleEditorConfirm(editedPath, editMetadata = null) {
    editorRequestIdRef.current += 1;
    setEditorOpen(false);
    setEditorSource(null);
    setEditorInitialTransform(null);
    setEditorInitialFilters(null);
    if (!onPick) return;
    const finalPath = await onImportFile?.(editedPath) ?? editedPath;
    if (editMetadata?.sourcePath) {
      await writeImageEditMetadata(finalPath, editMetadata);
    }
    onPick(finalPath);
  }

  function handleEditorCancel() {
    editorRequestIdRef.current += 1;
    setEditorOpen(false);
    setEditorSource(null);
    setEditorInitialTransform(null);
    setEditorInitialFilters(null);
  }

  function handleContextMenu(e) {
    if (!file && !imageClipboard.get()) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  function pasteClipboardImage() {
    const clip = imageClipboard.getEntry();
    if (!clip?.path || !onPick) return;
    if (clip.mode === 'cut') {
      notifyCutPaste({ path: clip.path, kind: 'image' });
    }
    onPick(clip.path);
    if (clip.mode === 'cut') imageClipboard.clear();
  }

  const dropRef = useRef(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    async function onMediaDrop(e) {
      const path = e.detail?.path;
      if (!path) return;
      const requestId = ++editorRequestIdRef.current;
      const metadata = await readImageEditMetadata(path);
      if (requestId !== editorRequestIdRef.current) return;
      if (metadata) {
        onPickRef.current?.(path);
        return;
      }
      setEditorSource(path);
      setEditorInitialTransform(null);
      setEditorInitialFilters(null);
      setEditorOpen(true);
    }
    el.addEventListener('media-drop', onMediaDrop);
    return () => {
      editorRequestIdRef.current += 1;
      el.removeEventListener('media-drop', onMediaDrop);
    };
  }, []);

  return (
    <div
      className={`image-field ${compact ? 'is-compact' : ''} ${align === 'start' ? 'is-align-start' : 'is-align-center'}`}
      onContextMenu={handleContextMenu}
    >
      {label && <div className="media-label">{label}</div>}
      <Tooltip text={displayPath || 'Cliquer pour choisir'} wrap={!!displayPath} className="image-drop-wrap">
      <div
        ref={dropRef}
        data-drop-kind="image"
        className={`image-drop ${showFilledState ? 'filled' : file && !fileAvailable ? 'missing' : 'empty'}`}
        onClick={showFilledState ? undefined : handlePick}
      >
        {previewUrl
          ? <img src={previewUrl} alt={filename} className="image-preview" />
          : (
            <div className="image-placeholder">
              <span className="image-placeholder-icon"><ImageIcon style={{ width: 24, height: 24 }} /></span>
              <span className="image-placeholder-text image-placeholder-text--strong">
                {file && !fileAvailable ? 'Image introuvable' : 'Cliquer pour choisir une image'}
              </span>
              <span className="image-placeholder-text">
                {file && !fileAvailable ? 'Le fichier lié est inaccessible' : formatHint}
              </span>
            </div>
          )
        }
        {badge && showFilledState ? <span className="image-badge">{badge}</span> : null}
        {showFilledState ? (
          <div className="image-overlay">
            <div className="image-overlay-actions">
              <button className="overlay-btn" onClick={e => { e.stopPropagation(); handlePick(); }}>Remplacer</button>
              <button className="overlay-btn" onClick={handleEdit}>Éditer</button>
              {onClear && (
                <button className="overlay-btn overlay-btn-danger" onClick={e => { e.stopPropagation(); onClear(); }}>Retirer</button>
              )}
            </div>
          </div>
        ) : (
          <div className="image-overlay">
            {(file && !fileAvailable) && onClear ? (
              <button className="overlay-btn overlay-btn-danger" onClick={e => { e.stopPropagation(); onClear(); }}>Retirer</button>
            ) : (
              <span>Choisir</span>
            )}
          </div>
        )}
      </div>
      </Tooltip>
      {(aiEnabled || extraActions.length > 0) && (
        <div className="image-action-row">
          {aiEnabled && (
            <Button
              variant="secondary-violet"
              className={`image-gen-btn${isGeneratingForField ? ' is-generating' : ''}`}
              onClick={() => onOpenSDGenerate({
                currentImagePath: fileAvailable ? file : null,
                currentImageLabel: label || 'image actuelle',
                fieldId,
              })}
              disabled={isGeneratingForField}
            >
              <span className="image-gen-btn-icon" aria-hidden="true">
                {isGeneratingForField ? <span className="image-gen-spinner" /> : <Sparkles style={{ width: 12, height: 12 }} />}
              </span>
              <span>{isGeneratingForField ? 'Génération…' : 'Générer IA'}</span>
            </Button>
          )}
          {extraActions.map((action) => (
            <Tooltip key={action.key} text={action.title || action.label}>
              <Button
                variant="secondary-violet"
                className="image-gen-btn"
                onClick={action.onClick}
              >
                {action.icon && <span className="image-gen-btn-icon" aria-hidden="true">{action.icon}</span>}
                <span>{action.label}</span>
              </Button>
            </Tooltip>
          ))}
        </div>
      )}
      {sdResults.length > 0 && (
        <div className="image-sd-results">
          {sdResults.map(({ path, jobId }) => (
            <SdResultThumb
              key={path}
              path={path}
              onPick={onPick}
              onRemove={() => onRemoveSdResult?.(jobId, path)}
            />
          ))}
        </div>
      )}
      {editorOpen && editorSource && (
        <Suspense fallback={null}>
          <ImageEditorModal
            sourcePath={editorSource}
            initialTransform={editorInitialTransform}
            initialFilters={editorInitialFilters}
            workspaceDir={workspaceDir}
            forceExport
            onConfirm={handleEditorConfirm}
            onCancel={handleEditorCancel}
          />
        </Suspense>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          actions={[
            ...(file ? [
              { icon: <Copy />, label: 'Copier', fn: () => imageClipboard.set(file) },
              { icon: <Scissors />, label: 'Couper', fn: () => imageClipboard.set(file, { mode: 'cut' }) },
              { icon: <FolderOpen />, label: 'Afficher dans l\'explorateur', fn: () => revealItemInDir(file) },
            ] : []),
            ...(imageClipboard.get() && onPick ? [
              {
                icon: <ClipboardPaste />,
                label: imageClipboard.getEntry()?.mode === 'cut' ? 'Déplacer ici' : 'Coller',
                fn: pasteClipboardImage,
              },
            ] : []),
          ]}
        />
      )}
    </div>
  );
}
