import { useProjectContext } from '../../store/ProjectContext';
import { useState, useRef, useEffect } from 'react';
import { logger } from '../../utils/logger';
import { readFile } from '@tauri-apps/plugin-fs';
import { coverFit, containFit, renderFrame, CANVAS_W, CANVAS_H } from './useImageEditor';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { FilterSlider } from './FilterSlider';
import { LevelsControl } from './LevelsControl';
import { exportEditedImage } from './imageEditorExport';
import { useImageCanvasInteractions } from './useImageCanvasInteractions';
import { presentMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
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
  // Niveaux — plage 0..255, gamma 0.1..9.99 (1 = neutre). Neutres par défaut :
  // la passe pixel est sautée tant que ces valeurs ne bougent pas.
  levelsBlack: 0,
  levelsWhite: 255,
  levelsGamma: 1.0,
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

export function ImageEditorModal({
  sourcePath,
  onConfirm,
  onCancel,
  initialTransform,
  initialFilters,
  title,
  confirmLabel,
  workspaceDir = '',
  requireManagedOutput = false,
  outputNameSourcePath = sourcePath,
  forceExport = false,
}) {
  const { t } = useMediaTranslation();
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const objectUrlRef = useRef(null);

  const { mediaStorage } = useProjectContext();
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
    if (ext === 'gif') {
      setLoadError({ key: 'media:imageEditor.gif.unsupported' });
      return undefined;
    }
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
            setLoadError({ key: 'media:imageEditor.init.failed' });
          }
        };
        img.onerror = () => {
          if (objectUrlRef.current === url) {
            URL.revokeObjectURL(url);
            objectUrlRef.current = null;
          }
          setLoadError({ key: 'media:imageEditor.load.failed' });
        };
        img.src = url;
      })
      .catch((error) => {
        logger.error('image-editor:read-file-error', sourcePath, error);
        setLoadError({ key: 'media:imageEditor.read.failed' });
      });

    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [sourcePath]);

  // Redessiner le canvas quand transform ou filtres changent.
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
      setLoadError({ key: 'media:imageEditor.render.failed' });
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
    if (!forceExport && !isDirtyRef.current) {
      onConfirm(sourcePath, { transform, filters });
      return;
    }
    setSaving(true);
    try {
      const finalPath = await exportEditedImage({
        image: imgRef.current,
        transform,
        filters,
        sourcePath,
        outputNameSourcePath,
        workspaceDir,
        mediaStorage,
        requireManagedOutput,
      });
      logger.info('image-editor:image-saved', { sourcePath, finalPath });
      onConfirm(finalPath, { sourcePath, transform, filters });
    } catch (err) {
      logger.error('image-editor:save-error', err);
      setLoadError(err?.userMessageRef || { key: 'media:imageEditor.export.failed' });
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="image-editor-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title ?? t('media:imageEditor.default.title')}</span>
          <Button variant="icon" className="modal-close" onClick={onCancel}>×</Button>
        </div>

        <div className="image-editor-body">
          {/* Canvas de recadrage */}
          <div className="image-editor-canvas-wrap">
            {loadError && <div className="image-editor-error">{presentMedia(loadError)}</div>}
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
            <div className="image-editor-canvas-hint">{t('media:imageEditor.canvas.hint')}</div>
            <div className="image-editor-fit-btns">
              <Tooltip text={t('media:imageEditor.cover.tooltip')}>
                <Button size="sm" onClick={handleCoverFit}>{t('media:imageEditor.cover.action')}</Button>
              </Tooltip>
              <Tooltip text={t('media:imageEditor.contain.tooltip')}>
                <Button size="sm" onClick={handleContainFit}>{t('media:imageEditor.contain.action')}</Button>
              </Tooltip>
            </div>
          </div>

          {/* Panneau filtres */}
          <div className="image-editor-filters">
            <div className="filter-section-title">{t('media:imageEditor.filters.title')}</div>

            <FilterSlider label={t('media:imageEditor.filter.brightness')} value={filters.brightness} min={-50} max={50}
              onChange={v => setFilter('brightness', v)} />
            <FilterSlider label={t('media:imageEditor.filter.contrast')} value={filters.contrast} min={-50} max={50}
              onChange={v => setFilter('contrast', v)} />
            <FilterSlider label={t('media:imageEditor.filter.saturation')} value={filters.saturation} min={-100} max={100}
              onChange={v => setFilter('saturation', v)} />
            <FilterSlider label={t('media:imageEditor.filter.blur')} value={filters.blur} min={0} max={8} unit="px"
              onChange={v => setFilter('blur', v)} />
            <FilterSlider label={t('media:imageEditor.filter.thickness')} value={filters.thickness} min={0} max={5}
              onChange={v => setFilter('thickness', v)} />

            <div className="filter-group">
              <div className="filter-group-title">{t('media:imageEditor.vignette.title')}</div>
              <div className="filter-group-help">{t('media:imageEditor.vignette.help')}</div>
              <FilterSlider label={t('media:imageEditor.vignette.intensity')} value={filters.vignette} min={0} max={100} unit="%" signed={false}
                onChange={v => setFilter('vignette', v)} />
              <FilterSlider label={t('media:imageEditor.vignette.size')} value={filters.vignetteSize} min={30} max={100} unit="%" signed={false}
                onChange={v => setFilter('vignetteSize', v)} />
              <FilterSlider label={t('media:imageEditor.vignette.feather')} value={filters.vignetteFeather} min={5} max={80} unit="%" signed={false}
                onChange={v => setFilter('vignetteFeather', v)} />
            </div>

            <LevelsControl
              filters={filters}
              setFilter={setFilter}
              image={imgRef.current}
              transform={transform}
              imgLoaded={imgLoaded}
            />

            <div className="filter-row filter-toggle">
              <span className="filter-label">{t('media:imageEditor.filter.grayscale')}</span>
              <input type="checkbox" checked={filters.grayscale}
                onChange={e => setFilter('grayscale', e.target.checked)} />
            </div>
            <div className="filter-row filter-toggle">
              <span className="filter-label">{t('media:imageEditor.filter.invert')}</span>
              <input type="checkbox" checked={filters.invert}
                onChange={e => setFilter('invert', e.target.checked)} />
            </div>

            <button className="filter-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
              {showAdvanced ? t('media:imageEditor.advanced.hide') : t('media:imageEditor.advanced.show')}
            </button>

            {showAdvanced && (
              <>
                <FilterSlider label={t('media:imageEditor.filter.hue')} value={filters.hue} min={0} max={360} unit="°"
                  onChange={v => setFilter('hue', v)} />
                <FilterSlider label={t('media:imageEditor.filter.sepia')} value={filters.sepia} min={0} max={100} unit="%"
                  onChange={v => setFilter('sepia', v)} />
              </>
            )}

            <Button size="sm" className="filter-reset" onClick={resetFilters}>{t('media:imageEditor.filters.reset')}</Button>
          </div>
        </div>

        <div className="modal-footer">
          <Button onClick={onCancel}>{t('common:dialog.cancel.label')}</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!imgLoaded || saving}>
            {saving ? t('media:imageEditor.save.progress') : (confirmLabel ?? t('media:imageEditor.default.confirm'))}
          </Button>
        </div>
      </div>
    </div>
  );
}
