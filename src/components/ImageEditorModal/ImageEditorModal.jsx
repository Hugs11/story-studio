import { useState, useRef, useEffect } from 'react';
import { logger } from '../../utils/logger';
import { readFile, writeFile, mkdir, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join, tempDir } from '@tauri-apps/api/path';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';

const WORKSPACE_DIR_KEY = 'storyStudioWorkspaceDir';
import { coverFit, containFit, renderFrame, buildFilter, CANVAS_W, CANVAS_H } from './useImageEditor';
import { Tooltip } from '../common/Tooltip';
import './ImageEditorModal.css';

const DEFAULT_FILTERS = { brightness: 0, contrast: 0, saturation: 0, grayscale: false, hue: 0, sepia: 0, blur: 0, invert: false, thickness: 0 };

export function ImageEditorModal({ sourcePath, onConfirm, onCancel, initialTransform, initialFilters }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const objectUrlRef = useRef(null);

  const [transform, setTransform] = useState({ offsetX: 0, offsetY: 0, scale: 1 });
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);

  const dragRef = useRef(null);
  const isDirtyRef = useRef(false);

  // Chargement de l'image source depuis le disque via Tauri
  useEffect(() => {
    if (!sourcePath) return;
    setImgLoaded(false);
    setLoadError(null);
    imgRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const ext = sourcePath.split('.').pop().toLowerCase();
    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
    };
    const mime = mimeMap[ext] || 'image/png';

    readFile(sourcePath)
      .then(data => {
        const blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const img = new Image();
        img.onload = () => {
          if (objectUrlRef.current === url) {
            URL.revokeObjectURL(url);
            objectUrlRef.current = null;
          }
          imgRef.current = img;
          try {
            isDirtyRef.current = false;
            setTransform(initialTransform ?? coverFit(img));
            setFilters(initialFilters ?? DEFAULT_FILTERS);
            setImgLoaded(true);
            logger.info('[ImageEditorModal] image loaded', {
              sourcePath,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
            });
          } catch (error) {
            logger.error('[ImageEditorModal] init failed', error);
            setLoadError("Impossible d'initialiser l'image.");
          }
        };
        img.onerror = () => {
          if (objectUrlRef.current === url) {
            URL.revokeObjectURL(url);
            objectUrlRef.current = null;
          }
          setLoadError('Impossible de charger l\'image.');
        };
        img.src = url;
      })
      .catch((error) => {
        logger.error('[ImageEditorModal] readFile failed', sourcePath, error);
        setLoadError('Impossible de lire le fichier.');
      });

    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [sourcePath]);

  // Re-render canvas quand transform ou filtres changent
  useEffect(() => {
    if (!imgLoaded) return;
    try {
      renderFrame(canvasRef.current, imgRef.current, transform, filters);
    } catch (error) {
      logger.error('[ImageEditorModal] render effect failed', {
        sourcePath,
        transform,
        filters,
        error,
      });
      setLoadError("Le rendu de l'image a echoue.");
    }
  }, [transform, filters, imgLoaded]);

  // Wheel non-passif pour pouvoir appeler preventDefault (évite le scroll de la page)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  });

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // Pan — mousedown
  function handleMouseDown(e) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX - transform.offsetX, startY: e.clientY - transform.offsetY };
  }

  // Pan — mousemove
  function handleMouseMove(e) {
    const dragState = dragRef.current;
    if (!dragState) return;
    const nextOffsetX = e.clientX - dragState.startX;
    const nextOffsetY = e.clientY - dragState.startY;
    isDirtyRef.current = true;
    setTransform(t => ({
      ...t,
      offsetX: nextOffsetX,
      offsetY: nextOffsetY,
    }));
  }

  function handleMouseUp() { dragRef.current = null; }

  // Zoom vers curseur — wheel
  function handleWheel(e) {
    e.preventDefault();
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    if (!rect.width || !Number.isFinite(rect.width)) return;
    const cssScale = rect.width / CANVAS_W; // CSS scaling factor (640/320 = 2)
    if (!Number.isFinite(cssScale) || cssScale <= 0) return;
    const cursorX = (e.clientX - rect.left) / cssScale;
    const cursorY = (e.clientY - rect.top) / cssScale;
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    isDirtyRef.current = true;
    setTransform(t => {
      const currentScale = Number.isFinite(t.scale) && t.scale > 0 ? t.scale : 1;
      const newScale = Math.max(0.05, Math.min(20, currentScale * factor));
      const ratio = newScale / currentScale;
      if (!Number.isFinite(ratio)) return t;
      return {
        scale: newScale,
        offsetX: cursorX - (cursorX - t.offsetX) * ratio,
        offsetY: cursorY - (cursorY - t.offsetY) * ratio,
      };
    });
  }

  function handleCoverFit() {
    if (imgRef.current) { isDirtyRef.current = true; setTransform(coverFit(imgRef.current)); }
  }

  function handleContainFit() {
    if (imgRef.current) { isDirtyRef.current = true; setTransform(containFit(imgRef.current)); }
  }

  function setFilter(key, value) {
    isDirtyRef.current = true;
    setFilters(f => ({ ...f, [key]: value }));
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  // Export PNG 320×240 et sauvegarde dans %TEMP%/story_studio_images/
  async function handleConfirm() {
    if (!isDirtyRef.current) {
      onConfirm(sourcePath, { transform, filters });
      return;
    }
    setSaving(true);
    try {
      const offscreen = document.createElement('canvas');
      offscreen.width = CANVAS_W;
      offscreen.height = CANVAS_H;
      renderFrame(offscreen, imgRef.current, transform, filters);

      const blob = await new Promise(resolve => offscreen.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas export returned null blob');
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      const basename = `edited_${Date.now()}.png`;
      await mkdir(TEMP_IMAGES_DIR, { baseDir: BaseDirectory.Temp, recursive: true });
      const tempRelPath = `${TEMP_IMAGES_DIR}/${basename}`;
      await writeFile(tempRelPath, bytes, { baseDir: BaseDirectory.Temp });
      const tmp = await tempDir();
      const tempAbsPath = await join(tmp, tempRelPath);

      let finalPath = tempAbsPath;
      const workspaceDir = localStorage.getItem(WORKSPACE_DIR_KEY);
      if (workspaceDir) {
        try {
          const destDir = `${workspaceDir}/images-generees`;
          await mkdir(destDir, { recursive: true });
          const destPath = `${destDir}/${basename}`;
          await copyFile(tempAbsPath, destPath);
          finalPath = destPath;
        } catch {
          // fallback to temp path
        }
      }

      logger.info('[ImageEditorModal] image saved', { sourcePath, finalPath });
      onConfirm(finalPath, { transform, filters });
    } catch (err) {
      logger.error('[ImageEditorModal] save failed:', err);
      setLoadError("L'export de l'image a echoue.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="image-editor-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Recadrer et ajuster l'image</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="image-editor-body">
          {/* Canvas de recadrage */}
          <div className="image-editor-canvas-wrap">
            {loadError && <div className="image-editor-error">{loadError}</div>}
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="image-editor-canvas"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ cursor: 'grab' }}
            />
            <div className="image-editor-canvas-hint">Glisser pour repositionner · Molette pour zoomer</div>
            <div className="image-editor-fit-btns">
              <Tooltip text="Remplir le cadre (rogné)">
                <button className="btn-xs" onClick={handleCoverFit}>Ajuster</button>
              </Tooltip>
              <Tooltip text="Image entière visible">
                <button className="btn-xs" onClick={handleContainFit}>Centrer</button>
              </Tooltip>
            </div>
          </div>

          {/* Panneau filtres */}
          <div className="image-editor-filters">
            <div className="filter-section-title">Filtres</div>

            <FilterSlider label="Luminosité" value={filters.brightness} min={-50} max={50}
              onChange={v => setFilter('brightness', v)} />
            <FilterSlider label="Contraste" value={filters.contrast} min={-50} max={50}
              onChange={v => setFilter('contrast', v)} />
            <FilterSlider label="Saturation" value={filters.saturation} min={-100} max={100}
              onChange={v => setFilter('saturation', v)} />
            <FilterSlider label="Flou" value={filters.blur} min={0} max={8} unit="px"
              onChange={v => setFilter('blur', v)} />
            <FilterSlider label="Épaisseur" value={filters.thickness} min={0} max={5}
              onChange={v => setFilter('thickness', v)} />

            <div className="filter-row filter-toggle">
              <span className="filter-label">Niveaux de gris</span>
              <input type="checkbox" checked={filters.grayscale}
                onChange={e => setFilter('grayscale', e.target.checked)} />
            </div>
            <div className="filter-row filter-toggle">
              <span className="filter-label">Inverser</span>
              <input type="checkbox" checked={filters.invert}
                onChange={e => setFilter('invert', e.target.checked)} />
            </div>

            <button className="filter-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
              {showAdvanced ? '▲ Avancé' : '▼ Avancé'}
            </button>

            {showAdvanced && (
              <>
                <FilterSlider label="Teinte" value={filters.hue} min={0} max={360} unit="°"
                  onChange={v => setFilter('hue', v)} />
                <FilterSlider label="Sépia" value={filters.sepia} min={0} max={100} unit="%"
                  onChange={v => setFilter('sepia', v)} />
              </>
            )}

            <button className="btn-xs filter-reset" onClick={resetFilters}>Réinitialiser les filtres</button>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>Annuler</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={!imgLoaded || saving}>
            {saving ? 'Enregistrement…' : 'Utiliser cette image'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterSlider({ label, value, min, max, unit = '', onChange }) {
  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="filter-slider"
      />
      <span className="filter-value">{value > 0 ? `+${value}` : value}{unit}</span>
    </div>
  );
}
