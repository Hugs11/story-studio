// Affichage de l'histogramme de luminance derrière les curseurs de niveaux.
// Dessine 256 bins (échelle log douce pour rendre visibles les petits bins) et
// trois repères verticaux : point noir, tons moyens (gamma), point blanc.

import { useEffect, useRef } from 'react';

const HIST_W = 256;
const HIST_H = 64;

export function Histogram({ bins, black = 0, white = 255, gamma = 1 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, HIST_W, HIST_H);
    if (!bins) return;

    let max = 0;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] > max) max = bins[i];
    }

    if (max > 0) {
      // La couleur des barres suit le thème via la propriété CSS `color`.
      ctx.fillStyle = getComputedStyle(canvas).color || 'rgba(150,150,160,0.9)';
      const norm = Math.log1p(max);
      for (let i = 0; i < bins.length; i++) {
        if (!bins[i]) continue;
        const h = (Math.log1p(bins[i]) / norm) * HIST_H;
        ctx.fillRect(i, HIST_H - h, 1, h);
      }
    }

    // Repères des poignées (statiques en V1, pas encore draggables).
    const marker = (x, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(Math.max(0, Math.min(HIST_W - 1, Math.round(x))), 0, 1, HIST_H);
    };
    marker(black, 'rgba(0,0,0,0.55)');
    marker(white, 'rgba(255,255,255,0.75)');
    // Position du ton moyen qui sera mappé sur 128 : black + (white-black)·0.5^gamma
    marker(black + (white - black) * Math.pow(0.5, gamma), 'rgba(128,128,128,0.8)');
  }, [bins, black, white, gamma]);

  return (
    <canvas
      ref={canvasRef}
      width={HIST_W}
      height={HIST_H}
      className="levels-histogram"
    />
  );
}
