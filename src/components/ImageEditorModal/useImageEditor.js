import { logger } from '../../utils/logger';

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

/**
 * Construit la string ctx.filter CSS à partir des valeurs de filtre.
 *
 * Ordre important :
 * 1. thickness (blur+contrast morphologique) — doit être en premier
 * 2. blur simple
 * 3. ajustements couleur
 * 4. invert — en dernier pour ne pas interagir avec les autres
 *
 * brightness/contrast : delta [-50,+50]   → 1 + val/100
 * saturation          : delta [-100,+100] → 1 + val/100
 * blur                : px [0,8]
 * thickness           : [0,5] — blur+contrast combinés pour gonfler les traits
 * grayscale/invert    : boolean
 * hue                 : degrés [0,360]
 * sepia               : % [0,100]
 */
export function buildFilter({ brightness, contrast, saturation, grayscale, hue, sepia, blur, invert, thickness }) {
  const parts = [];
  // Trick morphologique : blur étale les bords, contrast re-binarise → traits plus épais
  if (thickness > 0) {
    parts.push(`blur(${(thickness * 0.6).toFixed(1)}px)`);
    parts.push(`contrast(${(2 + thickness * 1.8).toFixed(1)})`);
  }
  if (blur > 0) parts.push(`blur(${blur}px)`);
  if (brightness !== 0) parts.push(`brightness(${1 + brightness / 100})`);
  if (contrast !== 0) parts.push(`contrast(${1 + contrast / 100})`);
  if (saturation !== 0) parts.push(`saturate(${1 + saturation / 100})`);
  if (grayscale) parts.push('grayscale(1)');
  if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
  if (sepia !== 0) parts.push(`sepia(${sepia / 100})`);
  if (invert) parts.push('invert(1)');
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * Rend l'image sur le canvas avec la transform et les filtres donnés
 */
export function renderFrame(canvas, img, transform, filters) {
  if (!canvas || !img) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    logger.error('[ImageEditorModal] 2d context unavailable');
    return;
  }
  const scale = Number.isFinite(transform?.scale) ? transform.scale : 1;
  const offsetX = Number.isFinite(transform?.offsetX) ? transform.offsetX : 0;
  const offsetY = Number.isFinite(transform?.offsetY) ? transform.offsetY : 0;
  if (!Number.isFinite(scale) || scale <= 0) {
    logger.error('[ImageEditorModal] invalid scale for render', transform);
    return;
  }
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.filter = buildFilter(filters);
  try {
    ctx.drawImage(
      img,
      offsetX,
      offsetY,
      img.naturalWidth * scale,
      img.naturalHeight * scale,
    );
  } catch (error) {
    logger.error('[ImageEditorModal] renderFrame failed', {
      error,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      transform,
      filters,
    });
    throw error;
  }
  ctx.filter = 'none';
}
