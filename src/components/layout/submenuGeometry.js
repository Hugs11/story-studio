// Géométrie des sous-menus en cascade : placement à côté du parent et tolérance
// de trajectoire du pointeur. Fonctions pures, en coordonnées de la fenêtre.

const MARGIN = 8;

/**
 * Position (`left`, `top`) d'un sous-menu de taille `size`. Il s'ouvre à droite
 * du menu parent (`parent`), son premier élément aligné sur l'entrée (`anchor`,
 * `inset` = marge intérieure du sous-menu) ; sans place à droite il se retourne
 * à gauche, et il est recalé verticalement pour rester dans la fenêtre.
 */
export function submenuPlacement({ parent, anchor, size, viewport, inset = 0, overlap = 2 }) {
  const rightLeft = parent.right - overlap;
  const leftLeft = parent.left + overlap - size.width;
  const fitsRight = rightLeft + size.width <= viewport.width - MARGIN;
  const left = fitsRight ? rightLeft : leftLeft >= MARGIN ? leftLeft : Math.max(MARGIN, viewport.width - MARGIN - size.width);
  const top = Math.max(MARGIN, Math.min(anchor.top - inset, viewport.height - MARGIN - size.height));
  return { left, top, flipped: !fitsRight };
}

const side = (p, a, b) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);

/**
 * Vrai si `point` est dans le triangle formé par le point où le pointeur a quitté
 * l'entrée et le bord proche du sous-menu (`rect`) : le pointeur va vers lui, on
 * ne ferme pas pendant qu'il traverse les entrées voisines.
 */
export function insideIntentTriangle(point, origin, rect, flipped = false) {
  const edge = flipped ? rect.right : rect.left;
  const a = origin; const b = { x: edge, y: rect.top }; const c = { x: edge, y: rect.bottom };
  const d1 = side(point, a, b); const d2 = side(point, b, c); const d3 = side(point, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
