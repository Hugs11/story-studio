import { useMemo, useRef, useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { imageClipboard } from '../../store/fieldClipboard';
import { pickImage } from '../../store/useFileDialog';
import { useLocalFile } from '../../store/useLocalFile';
import { useProjectContext } from '../../store/ProjectContext';
import { ImageEditorModal } from '../ImageEditorModal/ImageEditorModal';
import { Tooltip } from '../common/Tooltip';
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
      <button
        className="image-sd-thumb-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Supprimer"
      >×</button>
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
  accentLabel = false,
  fieldId = null,
  formatHint = 'Format recommandé : 320 × 240 px',
  badge = null,
}) {
  const { pathAudit, sdSettings, sdJobs, onOpenSDGenerate, onRemoveSdResult, onImportFile } = useProjectContext();
  const aiEnabled = sdSettings?.aiImageGen && !!onOpenSDGenerate;
  const previewUrl = useLocalFile(file);
  const filename = file ? file.split(/[\\/]/).pop() : null;
  const displayPath = file ? file.replace(/^\\\\\?\\/, '') : null;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSource, setEditorSource] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const fileAvailable = !!file && pathAudit[file] !== false;
  const showFilledState = !!file && fileAvailable;

  const sdResults = useMemo(
    () => (sdJobs ?? [])
      .filter(j => j.status === 'done' && j.resultPaths.length > 0 && (fieldId ? j.fieldId === fieldId : !j.fieldId))
      .flatMap(j => j.resultPaths.map(path => ({ path, jobId: j.id }))),
    [sdJobs, fieldId],
  );

  async function handlePick() {
    const picked = await pickImage();
    if (!picked) return;
    setEditorSource(picked);
    setEditorOpen(true);
  }

  function handleEdit(e) {
    e.stopPropagation();
    if (!fileAvailable) return;
    setEditorSource(file);
    // Re-editer une image deja exportee doit repartir de son raster courant.
    // Rejouer un ancien crop/filtre sur une image deja aplatie provoque des incoherences.
    setEditorOpen(true);
  }

  async function handleEditorConfirm(editedPath) {
    setEditorOpen(false);
    setEditorSource(null);
    if (!onPick) return;
    const finalPath = await onImportFile?.(editedPath) ?? editedPath;
    onPick(finalPath);
  }

  function handleEditorCancel() {
    setEditorOpen(false);
    setEditorSource(null);
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
      document.dispatchEvent(new CustomEvent('media-clipboard-cut-paste', {
        detail: { path: clip.path, kind: 'image' },
      }));
    }
    onPick(clip.path);
    if (clip.mode === 'cut') imageClipboard.clear();
  }

  const dropRef = useRef(null);
  const openEditorRef = useRef(null);
  openEditorRef.current = (path) => { setEditorSource(path); setEditorOpen(true); };

  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    function onMediaDrop(e) { openEditorRef.current(e.detail.path); }
    el.addEventListener('media-drop', onMediaDrop);
    return () => el.removeEventListener('media-drop', onMediaDrop);
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
                <button className="overlay-btn overlay-btn-danger" onClick={e => { e.stopPropagation(); onClear(); }}>Supprimer</button>
              )}
            </div>
          </div>
        ) : (
          <div className="image-overlay">
            {(file && !fileAvailable) && onClear ? (
              <button className="overlay-btn overlay-btn-danger" onClick={e => { e.stopPropagation(); onClear(); }}>Supprimer</button>
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
            <button
              className="image-gen-btn image-gen-btn--accent"
              onClick={() => onOpenSDGenerate({
                currentImagePath: fileAvailable ? file : null,
                currentImageLabel: label || 'image actuelle',
                fieldId,
              })}
            >
              <span className="image-gen-btn-icon" aria-hidden="true"><Sparkles style={{ width: 12, height: 12 }} /></span>
              <span>Générer IA</span>
            </button>
          )}
          {extraActions.map((action) => (
            <Tooltip key={action.key} text={action.title || action.label}>
              <button
                className="image-gen-btn"
                onClick={action.onClick}
              >
                {action.icon && <span className="image-gen-btn-icon" aria-hidden="true">{action.icon}</span>}
                <span>{action.label}</span>
              </button>
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
        <ImageEditorModal
          sourcePath={editorSource}
          onConfirm={handleEditorConfirm}
          onCancel={handleEditorCancel}
        />
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
