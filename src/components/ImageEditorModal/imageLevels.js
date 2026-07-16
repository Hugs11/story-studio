// Réglage de Niveaux (Levels) appliqué au niveau pixel.
// Les filtres CSS (ctx.filter) ne savent pas faire point noir / point blanc /
// gamma arbitraire : on applique donc une LUT de 256 entrées APRÈS le drawImage
// filtré (getImageData -> LUT -> putImageData). Non destructif : seuls les
// paramètres levels* sont stockés et ré-appliqués au rendu/export.

import { logger } from '../../utils/logger';

export const LEVELS_GAMMA_MIN = 0.1;
export const LEVELS_GAMMA_MAX = 9.99;

/**
 * Vrai quand les niveaux n'ont aucun effet → la passe pixel est sautée
 * (perf + évite un getImageData inutile pour les images non retouchées).
 */
function isLevelsNeutral({ levelsBlack = 0, levelsWhite = 255, levelsGamma = 1 } = {}) {
  return levelsBlack <= 0 && levelsWhite >= 255 && Math.abs(levelsGamma - 1) < 1e-3;
}

/**
 * Construit la LUT 256 entrées du réglage de niveaux.
 *   t = clamp((v - black) / (white - black), 0, 1)
 *   t = t ^ (1 / gamma)        // gamma > 1 éclaircit les tons moyens
 *   lut[v] = round(t * 255)
 *
 * Garde-fous : white >= black + 1 (évite division par zéro / inversion),
 * gamma borné [0.1, 9.99].
 */
function buildLevelsLUT(black, white, gamma) {
  const lo = Math.max(0, Math.min(255, Math.round(Number(black) || 0)));
  const hi = Math.max(lo + 1, Math.min(255, Math.round(Number(white) || 255)));
  const g = Math.max(LEVELS_GAMMA_MIN, Math.min(LEVELS_GAMMA_MAX, Number(gamma) || 1));
  const invGamma = 1 / g;
  const range = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let t = (v - lo) / range;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    t = Math.pow(t, invGamma);
    lut[v] = Math.round(t * 255);
  }
  return lut;
}

/**
 * Applique les niveaux sur tout le canvas via une passe getImageData/putImageData.
 * No-op si les niveaux sont neutres. La même LUT est appliquée à R, V et B
 * indépendamment (mode global « RVB combiné »).
 */
export function applyLevels(ctx, filters, width, height) {
  if (isLevelsNeutral(filters)) return;
  const lut = buildLevelsLUT(filters.levelsBlack, filters.levelsWhite, filters.levelsGamma);

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch (error) {
    logger.error('image-editor:levels-getimagedata-failed', error);
    return;
  }

  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];         // R
    data[i + 1] = lut[data[i + 1]]; // V
    data[i + 2] = lut[data[i + 2]]; // B
    // alpha (i+3) inchangé
  }
  ctx.putImageData(imageData, 0, 0);
}
