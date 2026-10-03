// La capture de recette : le rendu **complet** de la surface, pas le seul PNG
// du moteur.
//
// `engine.exportImage()` rend ce que le moteur a peint, et rien d'autre. Or la
// moitié de la maquette vit dans la couche HTML posée au-dessus : les noms
// sous les cartes, les pastilles de rôle, les zones de groupe. Une capture qui
// les perd n'est plus la preuve du rendu qu'elle prétend être — elle montre un
// graphe gris, sans un seul des repères sur lesquels la recette porte.
//
// Cette fonction compose les deux, à partir du PNG du moteur et du **même**
// relevé de surimpressions que l'écran affiche. Elle ne recalcule aucune
// position : ce qu'elle peint est, par construction, ce que la surface a
// publié à cet instant.

import { farLandmarkMarks, LANDMARK_KINDS } from './farLandmarks.js';
import { readEngineColors } from './engines/engineColors.js';
import { PORT_OVERHANG } from './engines/engineContract.js';
import { actionCountFontPx, nodeLabelWidthPx } from './nodeOverlayMetrics.js';

const GROUP_TONES = ['#6b8f5e', '#8f7d68', '#87904e', '#a86a86', '#5f87a8', '#7a8494'];

function groupTone(id) {
  let hash = 0;
  for (const character of String(id)) hash = ((hash * 31) + character.codePointAt(0)) | 0;
  return GROUP_TONES[Math.abs(hash) % GROUP_TONES.length];
}

// Le même écrêtage que la feuille de style, transcrit pour le canvas.
//
// La couche HTML borne ses textes — 112 px pour un nom de carte, la largeur de
// la carte moins ses marges pour une pastille, 220 px pour un repère — avec
// `overflow: hidden` et `text-overflow: ellipsis`. `fillText`, lui, ne borne
// rien : un libellé de repli qui vaut un UUID de 36 caractères était peint sur
// trois fois la largeur de sa carte. La capture montrait alors un
// enchevêtrement que l'écran n'a jamais affiché — une preuve de recette qui
// **charge** le rendu est aussi fausse qu'une preuve qui le flatte.
function fitText(context, text, maxWidth) {
  const value = String(text ?? '');
  if (maxWidth <= 0 || context.measureText(value).width <= maxWidth) return value;
  const ellipsis = '…';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(value.slice(0, middle) + ellipsis).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? value.slice(0, low) + ellipsis : ellipsis;
}

// Les bornes de la feuille de style, nommées une fois.
const LANDMARK_MAX_PX = 220;
const BADGE_MARGIN_PX = 10;

// La palette de la couche peinte, **relue sur le conteneur** comme celle du
// moteur.
//
// Elle était écrite en dur aux valeurs du thème sombre. Le PNG du moteur, lui,
// prend désormais le fond du thème courant : une capture en thème clair
// composait donc un rendu clair avec des pastilles et des noms peints pour le
// sombre — moitié d'un thème, moitié de l'autre, et un rendu qui n'a jamais
// existé à l'écran. Les replis restent les valeurs sombres : ils servent aux
// essais purs, qui n'ont pas de conteneur à interroger.
const OVERLAY_COLOR_TOKENS = Object.freeze({
  surface: ['--bg0', '#15181c'],
  secondary: ['--text-secondary', '#a6a2c0'],
  accent: ['--accent', '#d79b66'],
  accentText: ['--accent-text', '#efb471'],
  accentBorder: ['--accent-border', '#946f4b'],
  focus: ['--focus-ring', '#f0b26f'],
  warning: ['--warning', '#dfc24f'],
  warningBorder: ['--warning-border', '#8c793e'],
  action: ['--graph-action-bg', '#52c0b9'],
  actionBorder: ['--graph-action-border', '#83d4ce'],
});

const FALLBACK_OVERLAY_COLORS = Object.freeze(
  Object.fromEntries(Object.entries(OVERLAY_COLOR_TOKENS).map(([name, [, hex]]) => [name, hex])),
);

// Le fond d'une pastille : la surface du thème, à 82 % comme la feuille de
// style. `color-mix` n'existe pas pour un canvas ; l'opacité est donc portée
// par le contexte, ce qui donne le même résultat sur un fond déjà peint.
function paintBadgeBackground(context, colors, draw) {
  context.save();
  context.globalAlpha = 0.82;
  context.fillStyle = colors.surface;
  draw();
  context.restore();
}

function roleBadge(node) {
  if (node.isEntry) return { text: 'RACINE', warning: false };
  return null;
}

// `loadImage` est isolée pour que les essais puissent fournir une image déjà
// décodée : un `Image` ne se charge pas hors navigateur.
function loadImage(view, dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new view.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Rendu du moteur illisible'));
    image.src = dataUrl;
  });
}

// La boîte d'un nom de repère, à la place tranchée par `farLandmarks`.
function landmarkNameBox(node, placement, offset, width) {
  if (placement === 'above') return { x: node.x - width / 2, y: node.y - offset - 16 };
  if (placement === 'right') return { x: node.x + offset, y: node.y - 8 };
  if (placement === 'left') return { x: node.x - offset - width, y: node.y - 8 };
  return { x: node.x - width / 2, y: node.y + offset };
}

export async function captureGraphSurface({
  engine,
  overlay,
  size,
  // Le conteneur dont la palette est relue. Sans lui, la couche peinte garde
  // ses replis sombres : c'est le cas des essais purs.
  container = typeof document === 'undefined' ? null : document.querySelector('.advanced-canvas__stage'),
  view = typeof window === 'undefined' ? null : window,
  decode = loadImage,
}) {
  if (!engine || !view?.document) return null;
  const engineImage = await engine.exportImage();
  if (!engineImage) return null;
  const width = Math.max(1, Math.round(size?.width ?? 0));
  const height = Math.max(1, Math.round(size?.height ?? 0));
  const canvas = view.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return engineImage;

  const painted = await decode(view, engineImage);
  context.drawImage(painted, 0, 0, width, height);
  paintOverlay(
    context,
    overlay ?? {},
    container ? readEngineColors(container, OVERLAY_COLOR_TOKENS) : FALLBACK_OVERLAY_COLORS,
  );
  return canvas.toDataURL('image/png');
}

// Le dessin de la couche HTML, avec les mêmes règles que la feuille de style :
// mêmes rayons, mêmes tailles de texte, mêmes tons de groupe. Ce n'est pas un
// second langage visuel, c'est le même, transcrit une fois pour la capture.
export function paintOverlay(context, overlay, colors = FALLBACK_OVERLAY_COLORS) {
  const {
    detailLevel = 'full', nodes = [], groups = [], zoom = 1, bounds = null, viewport = null,
  } = overlay;
  // Le nom se pose sous la prise du bas, comme dans la feuille de style.
  const labelOffset = PORT_OVERHANG * zoom + 13;
  const simplified = detailLevel === 'simplified';
  const full = detailLevel === 'full';

  if (!simplified) {
    for (const group of groups) {
      const tone = groupTone(group.id);
      context.save();
      context.setLineDash([4, 3]);
      context.strokeStyle = tone;
      context.globalAlpha = 0.34;
      roundedRect(context, group.x, group.y, group.width, group.height, 12);
      context.stroke();
      context.globalAlpha = 0.07;
      context.fillStyle = tone;
      context.fill();
      context.restore();

      context.save();
      context.fillStyle = tone;
      context.font = '800 10px "Space Grotesk", sans-serif';
      context.fillText(String(group.id).toLocaleUpperCase('fr-FR'), group.x + 12, group.y + 18);
      context.restore();
    }
  }

  // Le régime éloigné est peint depuis `farLandmarkMarks`, la **même** règle
  // que la couche HTML : même choix de repères, même texte, mêmes noms écartés
  // quand ils se gêneraient. C'est ce qui fait de la capture une preuve du
  // rendu plutôt qu'une seconde interprétation de la maquette.
  if (simplified) {
    const marks = farLandmarkMarks(nodes, { bounds, viewport });
    // Les étiquettes rangées dans la marge et leurs traits, sous les marques.
    for (const { node, label, callout } of marks) {
      if (!callout) continue;
      context.save();
      context.strokeStyle = colors.secondary;
      context.globalAlpha = 0.55;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(callout.x, callout.y);
      context.stroke();
      context.globalAlpha = 1;
      context.font = '600 13px "Space Grotesk", sans-serif';
      const text = fitText(context, label, Math.min(LANDMARK_MAX_PX, callout.maxWidth));
      const width = context.measureText(text).width + 12;
      const left = callout.side === 'right' ? callout.x : callout.x - width;
      paintBadgeBackground(context, colors, () => {
        roundedRect(context, left, callout.y - 8, width, 16, 4);
        context.fill();
      });
      context.fillStyle = colors.secondary;
      context.textAlign = 'left';
      context.fillText(text, left + 6, callout.y + 4);
      context.restore();
    }
    for (const {
      node, kind, count, grouped, label, isTag, placement, offset,
    } of marks) {
      const ring = kind === LANDMARK_KINDS.ENTRY ? { radius: 28, color: colors.accent, width: 3 }
        : kind === LANDMARK_KINDS.SELECTED ? { radius: 12, color: colors.focus, width: 2 }
          : kind === LANDMARK_KINDS.WARNING
            ? { radius: grouped ? 11 : 10, color: colors.warning, width: grouped ? 2 : 2.5 }
            : { radius: 5.5, color: colors.secondary, width: 2 };
      context.save();
      context.strokeStyle = ring.color;
      context.lineWidth = ring.width;
      context.beginPath();
      context.arc(node.x, node.y, ring.radius, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = ring.color;
      context.textAlign = 'center';
      if (grouped) {
        context.font = '800 10px "Space Grotesk", sans-serif';
        context.textBaseline = 'middle';
        context.fillText(String(count), node.x, node.y);
        context.textBaseline = 'alphabetic';
      } else if (label !== null && placement !== 'callout') {
        context.font = isTag
          ? '800 13px "Space Grotesk", sans-serif'
          : '600 13px "Space Grotesk", sans-serif';
        const text = fitText(context, label, LANDMARK_MAX_PX);
        // La place et l'écart viennent de `farLandmarks`, comme à l'écran :
        // la boîte de 16 px du nom, posée dessous, dessus, à droite ou à gauche.
        const width = context.measureText(text).width + 10;
        const box = landmarkNameBox(node, placement, offset, width);
        // Le fond du canevas sous le nom, comme la feuille de style : les
        // nœuds restent peints sous 3 % et le nom se poserait sur leur trame.
        paintBadgeBackground(context, colors, () => {
          roundedRect(context, box.x, box.y, width, 16, 4);
          context.fill();
        });
        context.fillStyle = ring.color;
        context.fillText(text, box.x + width / 2, box.y + 12);
      }
      context.restore();
    }
    return;
  }

  for (const node of nodes) {
    const left = node.x - node.width / 2;
    const top = node.y - node.height / 2;
    const badge = roleBadge(node);

    if (node.kind === 'action' && full) {
      const fontPx = actionCountFontPx(zoom);
      const text = String(node.outgoingCount ?? 0);
      const height = fontPx * 1.64;
      const padding = fontPx * 0.45;
      context.save();
      context.font = `600 ${fontPx}px "Space Grotesk", sans-serif`;
      const width = Math.max(height, context.measureText(text).width + padding * 2);
      const left = node.x - width / 2;
      const top = node.y - node.height / 2 - 5 - height;
      context.globalAlpha = 0.16;
      context.fillStyle = colors.action;
      roundedRect(context, left, top, width, height, height / 2);
      context.fill();
      context.globalAlpha = 0.45;
      context.strokeStyle = colors.actionBorder;
      context.lineWidth = 1;
      roundedRect(context, left, top, width, height, height / 2);
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = colors.secondary;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(text, node.x, top + height / 2);
      context.restore();
    }

    if (full && badge) {
      context.save();
      context.font = '800 8px "Space Grotesk", sans-serif';
      const padding = 6;
      const room = Math.max(0, node.width - BADGE_MARGIN_PX - padding * 2);
      const text = fitText(context, badge.text, room);
      const textWidth = context.measureText(text).width;
      paintBadgeBackground(context, colors, () => {
        roundedRect(context, left + 5, top + 5, textWidth + padding * 2, 14, 7);
        context.fill();
      });
      roundedRect(context, left + 5, top + 5, textWidth + padding * 2, 14, 7);
      context.strokeStyle = badge.warning ? colors.warningBorder : colors.accentBorder;
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = badge.warning ? colors.warning : colors.accentText;
      context.fillText(text, left + 5 + padding, top + 15);
      context.restore();
    }

    if (full && node.label) {
      context.save();
      context.fillStyle = node.isEntry ? colors.accentText : colors.secondary;
      context.font = `${node.isEntry ? 700 : 500} 10px "Space Grotesk", sans-serif`;
      context.textAlign = 'center';
      context.fillText(fitText(context, node.label, nodeLabelWidthPx(zoom)), node.x, top + node.height + labelOffset);
      context.restore();
    }

    if (node.selected) {
      context.save();
      context.strokeStyle = colors.accent;
      context.lineWidth = 2;
      roundedRect(context, left - 6, top - 6, node.width + 12, node.height + 12, 11);
      context.stroke();
      context.restore();
    }
  }
}

function roundedRect(context, x, y, width, height, radius) {
  const limit = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, limit);
    return;
  }
  context.moveTo(x + limit, y);
  context.arcTo(x + width, y, x + width, y + height, limit);
  context.arcTo(x + width, y + height, x, y + height, limit);
  context.arcTo(x, y + height, x, y, limit);
  context.arcTo(x, y, x + width, y, limit);
  context.closePath();
}
