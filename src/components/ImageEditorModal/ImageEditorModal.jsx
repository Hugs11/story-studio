import { useState, useRef, useEffect } from 'react';
import { logger } from '../../utils/logger';
import { readFile } from '@tauri-apps/plugin-fs';
import { coverFit, containFit, renderFrame, CANVAS_W, CANVAS_H } from './useImageEditor';
import { Tooltip } from '../common/Tooltip';
import { FilterSlider } from './FilterSlider';
import { exportEditedImage } from './imageEditorExport';
import { useImageCanvasInteractions } from './useImageCanvasInteractions';
import './ImageEditorModal.css';

const DEFAULT_FILTERS = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  grayscale: false,
  hue: 0,
  sepia: 0,
  blur: 0,
  invert: false,
  thickness: 0,
  vignette: 0,
  vignetteSize: 70,
  vignetteFeather: 35,
};

function createDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}

function normalizeFilters(filters = {}) {
  return { ...DEFAULT_FILTERS, ...filters };
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return String(error);
}

export function ImageEditorModal({ sourcePath, onConfirm, onCancel, initialTransform, initialFilters }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const objectUrlRef = useRef(null);

  const [transform, setTransform] = useState({ offsetX: 0, offsetY: 0, scale: 1 });
  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);

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
            // Sans metadata d'edition, on preserve l'image entiere pour qu'un
            // simple changement de filtre ne modifie pas aussi le cadrage.
            setTransform(initialTransform ?? containFit(img));
            setFilters(normalizeFilters(initialFilters));
            setImgLoaded(true);
            logger.info('image-editor:image-loaded', {
              sourcePath,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
            });
          } catch (error) {
            logger.error('image-editor:init-error', error);
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
        logger.error('image-editor:read-file-error', sourcePath, error);
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
      logger.error('image-editor:render-effect-error', {
        sourcePath,
        transform,
        filters,
        error: serializeError(error),
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

  const { handleMouseDown, handleMouseMove, handleMouseUp, handleWheel } = useImageCanvasInteractions({
    transform,
    setTransform,
    canvasRef,
    onDirty: () => { isDirtyRef.current = true; },
  });

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
    const nextFilters = createDefaultFilters();
    isDirtyRef.current = true;
    setFilters(nextFilters);
    if (imgLoaded && canvasRef.current && imgRef.current) {
      renderFrame(canvasRef.current, imgRef.current, transform, nextFilters);
    }
  }

  async function handleConfirm() {
    if (!isDirtyRef.current) {
      onConfirm(sourcePath, { transform, filters });
      return;
    }
    setSaving(true);
    try {
      const finalPath = await exportEditedImage({ image: imgRef.current, transform, filters, sourcePath });
      logger.info('image-editor:image-saved', { sourcePath, finalPath });
      onConfirm(finalPath, { sourcePath, transform, filters });
    } catch (err) {
      logger.error('image-editor:save-error', err);
      setLoadError("L'export de l'image a echoue.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="image-editor-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Recadrer et ajuster l'image</span>
          <button className="btn btn-icon modal-close" onClick={onCancel}>×</button>
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

            <div className="filter-group">
              <div className="filter-group-title">Vignettage</div>
              <div className="filter-group-help">Assombrit les bords de l’image.</div>
              <FilterSlider label="Intensité" value={filters.vignette} min={0} max={100} unit="%" signed={false}
                onChange={v => setFilter('vignette', v)} />
              <FilterSlider label="Taille" value={filters.vignetteSize} min={30} max={100} unit="%" signed={false}
                onChange={v => setFilter('vignetteSize', v)} />
              <FilterSlider label="Diffusion" value={filters.vignetteFeather} min={5} max={80} unit="%" signed={false}
                onChange={v => setFilter('vignetteFeather', v)} />
            </div>

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
