// La géométrie de la vue d'ensemble.
//
// Elle est ici, et pas dans le composant, pour une raison précise : c'est une
// projection, et une projection se vérifie. La miniature précédente
// normalisait X et Y **séparément**, ce qui déformait le rapport
// largeur/hauteur et montrait une disposition qui n'était pas celle du canvas.
//
// Une seule échelle pour les deux axes, la même pour les marques et pour le
// cadre de caméra : c'est ce qui garantit que le rectangle désigne bien ce que
// les marques montrent.

import { nodeRoles } from './graphRoles.js';

// Les unités du `viewBox` de la miniature.
export const MAP_WIDTH = 212;
export const MAP_HEIGHT = 104;
const MAP_PADDING = 6;

// L'encombrement d'une carte : l'étendue projetée est celle du graphe
// **peint**, pas celle de ses seuls centres.
const CARD_HALF_WIDTH = 52;
const CARD_HALF_HEIGHT = 40;

// Marques dessinées au plus. Les repères — entrée et carrefours — sont posés
// d'abord et ne sont jamais échantillonnés : les perdre au profit
// d'un nœud quelconque ferait rater exactement ce qu'on cherche sur un gros
// pack.
const MARK_BUDGET = 400;

// `livePositions` porte les nœuds déplacés depuis le montage, tant que le
// document ne les a pas repris : sans elle, la miniature montrerait la
// position d'avant le glisser.
export function buildOverview(index, livePositions = null) {
  const entries = index?.entries ?? [];
  if (entries.length === 0) return null;
  const roles = nodeRoles(index);

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const landmarks = [];
  const ordinary = [];
  for (const entry of entries) {
    const moved = livePositions?.get(entry.path);
    const x = moved?.x ?? entry.node.layout?.x ?? 0;
    const y = moved?.y ?? entry.node.layout?.y ?? 0;
    minX = Math.min(minX, x - CARD_HALF_WIDTH);
    maxX = Math.max(maxX, x + CARD_HALF_WIDTH);
    minY = Math.min(minY, y - CARD_HALF_HEIGHT);
    maxY = Math.max(maxY, y + CARD_HALF_HEIGHT);
    const role = roles.of(entry.path);
    const tone = role.entry ? 'entry'
      : role.hub ? 'hub'
        : null;
    (tone ? landmarks : ordinary).push({ path: entry.path, x, y, kind: entry.kind, tone });
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const innerWidth = MAP_WIDTH - MAP_PADDING * 2;
  const innerHeight = MAP_HEIGHT - MAP_PADDING * 2;
  const scale = Math.min(innerWidth / width, innerHeight / height);
  const offsetX = MAP_PADDING + (innerWidth - width * scale) / 2 - minX * scale;
  const offsetY = MAP_PADDING + (innerHeight - height * scale) / 2 - minY * scale;

  // Les repères passent en premier et ne sont échantillonnés que s'ils
  // débordent à eux seuls le budget — un pack peut porter des centaines de
  // nœuds sans entrée, et dessiner une marque par nœud ferait de la miniature
  // un aplat aussi illisible que le graphe entier.
  const keptLandmarks = sample(landmarks, MARK_BUDGET);
  const keptOrdinary = sample(ordinary, Math.max(0, MARK_BUDGET - keptLandmarks.length));
  const marks = keptLandmarks.concat(keptOrdinary).map((mark) => ({
    ...mark,
    px: mark.x * scale + offsetX,
    py: mark.y * scale + offsetY,
  }));

  return {
    marks,
    total: entries.length,
    shown: marks.length,
    scale,
    project: (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY }),
    unproject: (px, py) => ({ x: (px - offsetX) / scale, y: (py - offsetY) / scale }),
  };
}

// Échantillonnage régulier, déterministe : deux lectures du même document
// donnent la même carte.
function sample(all, budget) {
  if (budget <= 0) return [];
  if (all.length <= budget) return all;
  const stride = Math.ceil(all.length / budget);
  return all.filter((_, position) => position % stride === 0).slice(0, budget);
}

// La caméra, dans les unités de la miniature. Elle passe par **la même**
// projection que les marques ; elle n'est pas bornée au cadre, c'est le
// découpage du dessin qui s'en charge — un rectangle replié de force
// mentirait sur ce que la vue montre réellement.
export function overviewCamera(overview, viewport, size) {
  if (!overview || !viewport || !(size?.width > 0) || !(size?.height > 0)) return null;
  const zoom = viewport.zoom || 1;
  const topLeft = overview.project(-viewport.x / zoom, -viewport.y / zoom);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(2, (size.width / zoom) * overview.scale),
    height: Math.max(2, (size.height / zoom) * overview.scale),
  };
}
