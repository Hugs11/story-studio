// Section « Niveaux » de la modale d'édition d'image : histogramme + curseurs
// Noir / Gamma / Blanc. Les niveaux sont non destructifs (clés levels* du
// modèle filters, ré-appliquées au rendu et à l'export).

import { useEffect, useState } from 'react';
import { FilterSlider } from './FilterSlider';
import { Histogram } from './Histogram';
import { drawFilteredImage, CANVAS_W, CANVAS_H } from './useImageEditor';
import { computeLuminanceHistogram } from './imageHistogram';
import { LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX } from './imageLevels';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

export function LevelsControl({ filters, setFilter, image, transform, imgLoaded }) {
  const { t } = useMediaTranslation();
  const [histogram, setHistogram] = useState(null);

  const { levelsBlack, levelsWhite, levelsGamma } = filters;
  // Clés CSS uniquement : l'histogramme se recalcule sur l'image / la transform /
  // les filtres CSS, mais PAS sur les curseurs de niveaux (qui ne changent pas
  // la source, seulement le mapping).
  const { brightness, contrast, saturation, grayscale, hue, sepia, blur, invert, thickness } = filters;

  useEffect(() => {
    if (!imgLoaded || !image) {
      setHistogram(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const cssFilters = { brightness, contrast, saturation, grayscale, hue, sepia, blur, invert, thickness };
    let drawn = false;
    try {
      drawn = drawFilteredImage(ctx, image, transform, cssFilters);
    } catch {
      drawn = false;
    }
    if (!drawn) {
      setHistogram(null);
      return;
    }
    try {
      const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      setHistogram(computeLuminanceHistogram(data));
    } catch {
      setHistogram(null);
    }
  }, [imgLoaded, image, transform, brightness, contrast, saturation, grayscale, hue, sepia, blur, invert, thickness]);

  // Garde-fou : white doit rester >= black + 1 (sinon division par zéro / inversion).
  function handleBlack(v) {
    setFilter('levelsBlack', Math.min(v, levelsWhite - 1));
  }
  function handleWhite(v) {
    setFilter('levelsWhite', Math.max(v, levelsBlack + 1));
  }

  return (
    <div className="filter-group">
      <div className="filter-group-title">{t('media:imageEditor.levels.title')}</div>
      <div className="filter-group-help">{t('media:imageEditor.levels.help')}</div>

      <Histogram bins={histogram} black={levelsBlack} white={levelsWhite} gamma={levelsGamma} />

      <FilterSlider label={t('media:imageEditor.levels.black')} value={levelsBlack} min={0} max={255} signed={false}
        onChange={handleBlack} />
      <FilterSlider label={t('media:imageEditor.levels.gamma')} value={levelsGamma} min={LEVELS_GAMMA_MIN} max={LEVELS_GAMMA_MAX}
        step={0.01} signed={false} format={v => Number(v).toFixed(2)}
        onChange={v => setFilter('levelsGamma', v)} />
      <FilterSlider label={t('media:imageEditor.levels.white')} value={levelsWhite} min={0} max={255} signed={false}
        onChange={handleWhite} />
    </div>
  );
}
