import { logger } from '../../utils/logger';
import { applyLevels } from './imageLevels';
import {
  applyPortableImageFilters,
  hasPortableImageFilters,
} from './imageFilters';

export const CANVAS_W = 320;
export const CANVAS_H = 240;

/**
 * Calcule la transform initiale en mode "cover" (remplit le cadre, rogné si nécessaire)
 */
export function coverFit(img) {
  const scale = Math.max(CANVAS_W / img.naturalWidth, CANVAS_H / img.naturalHeight);
  return {
    scale,
    offsetX: (CANVAS_W - img.naturalWidth * scale) / 2,
    offsetY: (CANVAS_H - img.naturalHeight * scale) / 2,
  };
}

/**
 * Calcule la transform initiale en mode "contain" (image entière visible, fond noir)
 */
export function containFit(img) {
  const scale = Math.min(CANVAS_W / img.naturalWidth, CANVAS_H / img.naturalHeight);
  return {
    scale,
    offsetX: (CANVAS_W - img.naturalWidth * scale) / 2,
    offsetY: (CANVAS_H - img.naturalHeight * scale) / 2,
  };
}

function applyVignette(ctx, filters = {}) {
  const strength = Math.max(0, Math.min(100, Number(filters.vignette) || 0)) / 100;
  if (strength <= 0) return;

  const minDim = Math.min(CANVAS_W, CANVAS_H);
  const centerX = CANVAS_W / 2;
  const centerY = CANVAS_H / 2;
  const size = Math.max(30, Math.min(100, Number(filters.vignetteSize) || 70)) / 100;
  const feather = Math.max(5, Math.min(80, Number(filters.vignetteFeather) || 35)) / 100;
  const innerRadius = (minDim / 2) * size;
  const outerRadius = Math.min(
    Math.hypot(CANVAS_W / 2, CANVAS_H / 2),
    innerRadius + (minDim / 2) * feather,
  );

  const gradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${strength.toFixed(3)})`);
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();
}

/**
 * Dessine l'image puis applique les filtres portables directement aux pixels.
 * Réutilisé tel quel pour calculer l'histogramme (source = pixels après
 * filtres, avant niveaux et vignette).
 * Retourne false si la transform est invalide (rien dessiné).
 */
export function drawFilteredImage(ctx, img, transform, filters) {
  const scale = Number.isFinite(transform?.scale) ? transform.scale : 1;
  const offsetX = Number.isFinite(transform?.offsetX) ? transform.offsetX : 0;
  const offsetY = Number.isFinite(transform?.offsetY) ? transform.offsetY : 0;
  if (!Number.isFinite(scale) || scale <= 0) {
    logger.error('image-editor:invalid-scale', transform);
    return false;
  }
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  try {
    ctx.drawImage(
      img,
      offsetX,
      offsetY,
      img.naturalWidth * scale,
      img.naturalHeight * scale,
    );
  } catch (error) {
    logger.error('image-editor:render-frame-error', {
      error,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      transform,
      filters,
    });
    throw error;
  }
  if (hasPortableImageFilters(filters)) {
    try {
      const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      applyPortableImageFilters(imageData, filters, CANVAS_W, CANVAS_H);
      ctx.putImageData(imageData, 0, 0);
    } catch (error) {
      logger.error('image-editor:filter-error', {
        error,
        filters,
      });
      throw error;
    }
  }
  return true;
}

/**
 * Rend l'image sur le canvas avec la transform et les filtres donnés.
 *
 * Pipeline :
 * 1. drawImage + filtres pixels portables (drawFilteredImage)
 * 2. passe niveaux pixel (LUT) — sautée si neutre
 * 3. vignettage (overlay) — toujours en dernier
 */
export function renderFrame(canvas, img, transform, filters) {
  if (!canvas || !img) return;
  // willReadFrequently : la passe niveaux relit le canvas via getImageData à
  // chaque tick de curseur → contexte optimisé pour les readbacks répétés.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    logger.error('image-editor:context-unavailable');
    return;
  }
  if (!drawFilteredImage(ctx, img, transform, filters)) return;
  applyLevels(ctx, filters, CANVAS_W, CANVAS_H);
  applyVignette(ctx, filters);
}
