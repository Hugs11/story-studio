// Calcul de l'histogramme de luminance (256 bins) pour l'éditeur de niveaux.
// La source = pixels du canvas APRÈS filtres CSS, AVANT niveaux (= ce sur quoi
// les curseurs agissent). Les niveaux ne changent pas cette source, seulement
// le mapping → l'histogramme ne se recalcule pas à chaque tick des curseurs.

export const HISTOGRAM_BINS = 256;

/**
 * Histogramme de luminance perceptuelle (Rec.601 : 0.299 R + 0.587 V + 0.114 B).
 * Les pixels totalement transparents sont ignorés (bords hors image).
 */
export function computeLuminanceHistogram(imageData) {
  const bins = new Uint32Array(HISTOGRAM_BINS);
  if (!imageData) return bins;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const y = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    bins[y]++;
  }
  return bins;
}
