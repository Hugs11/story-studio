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
import { ContextMenu } from '../TreePanel/ContextMenu';
import {
  Copy, Scissors, FolderOpen, ClipboardPaste, Sparkles, ArrowRightLeft, Pencil, Trash2,
  CaseUpper, Image as ImageIcon,
} from '../icons/LucideLocal';
import './ImageField.css';

// Les trois gestes portés par l'aperçu, en **icônes seules** à toutes les
// tailles : un libellé lisible demanderait une largeur que la miniature n'a
// plus, et deux rendus selon la taille donneraient deux ergonomies à tenir.
//
// **Table unique et volontairement isolée.** Changer une icône se fait ici, sur
// une ligne, sans toucher au rendu ni au CSS, et le changement porte partout —
// Libre et graphe, écran, dossier, histoire et menu racine.
const IMAGE_ACTIONS = Object.freeze({
  replace: { Icon: ArrowRightLeft, label: 'Remplacer l’image' },
  edit: { Icon: Pencil, label: 'Éditer l’image' },
  // Les actions apportées par un consommateur sont retrouvées **par leur clé**,
  // pour que l'icône vive ici comme les autres plutôt que dans six appels.
  'generate-text': { Icon: CaseUpper, label: 'Générer une image-titre' },
  ai: { Icon: Sparkles, label: 'Générer avec l’IA (ComfyUI)' },
  clear: { Icon: Trash2, label: 'Supprimer l’image' },
});

function ToolbarButton({ action, onClick, title = null, disabled = false, tone = null, busy = false }) {
  const { Icon, label } = IMAGE_ACTIONS[action];
  const text = title || label;
  const button = (
    <button
      type="button"
      className={`image-tool${tone ? ` image-tool--${tone}` : ''}${busy ? ' is-busy' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      // L'infobulle maison ne s'ouvre pas sur une cible éteinte ; celle du
      // système, si. Elle n'est posée que là, pour ne jamais en afficher deux.
      title={disabled ? text : undefined}
    >
      <Icon aria-hidden="true" />
    </button>
  );
  return disabled ? button : <Tooltip text={text}>{button}</Tooltip>;
}

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

  const toolCount = 2
    + extraActions.length
    + (aiEnabled ? 1 : 0)
    + (onClear ? 1 : 0);

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

      {/* **Le cadre soude l'aperçu et sa barre d'outils.** Un seul contour, un
          filet d'un pixel entre les deux, et la barre prend la hauteur de
          l'image parce qu'elle est son voisine de rangée — aucune hauteur
          n'est recopiée nulle part. */}
      {/* Le nombre de boutons décide à quelle largeur la barre doit se plier :
          quatre gestes tiennent en hauteur là où cinq débordent déjà. Le CSS ne
          peut pas les compter, on le lui dit. */}
      <div className="image-slot" data-tools={toolCount}>
        <div className="image-slot__frame">
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
                    <span className="image-placeholder-icon"><ImageIcon aria-hidden="true" /></span>
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
            </div>
          </Tooltip>

          <div className="image-slot__toolbar">
            <ToolbarButton action="replace" onClick={handlePick} />
            {/* Éditer et Supprimer n'ont pas d'objet sur un emplacement vide ou
                sur un fichier perdu : ils s'éteignent au lieu de refuser après
                coup. Remplacer, lui, est justement ce qui répare les deux. */}
            <ToolbarButton action="edit" onClick={handleEdit} disabled={!showFilledState} />
            {extraActions.map((action) => (
              <ToolbarButton
                key={action.key}
                action={action.key}
                title={action.title || action.label}
                onClick={action.onClick}
              />
            ))}
            {aiEnabled && (
              <ToolbarButton
                action="ai"
                tone="ai"
                busy={isGeneratingForField}
                disabled={isGeneratingForField}
                title={isGeneratingForField ? 'Génération en cours…' : null}
                onClick={() => onOpenSDGenerate({
                  currentImagePath: fileAvailable ? file : null,
                  currentImageLabel: label || 'image actuelle',
                  fieldId,
                })}
              />
            )}
            {onClear && (
              <ToolbarButton
                action="clear"
                tone="danger"
                disabled={!file}
                onClick={onClear}
              />
            )}
          </div>
        </div>
      </div>

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
