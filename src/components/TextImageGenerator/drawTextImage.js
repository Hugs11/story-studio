export const TEXT_IMG_W = 320;
export const TEXT_IMG_H = 240;

export function drawTextImage(ctx, text) {
  const label = (text || 'Sans titre').trim() || 'Sans titre';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, TEXT_IMG_W, TEXT_IMG_H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawAutoText(ctx, label, TEXT_IMG_W / 2, TEXT_IMG_H / 2, 280, TEXT_IMG_H - 32);
}

function drawAutoText(ctx, text, cx, cy, maxW, maxH) {
  const words = text.split(' ');
  for (let size = 36; size >= 12; size -= 2) {
    ctx.font = `600 ${size}px sans-serif`;
    const lines = buildLines(ctx, words, maxW);
    const lineH = size * 1.3;
    const totalH = lines.length * lineH;
    if (totalH <= maxH) {
      const startY = cy - totalH / 2 + lineH / 2;
      lines.forEach((line, i) => ctx.fillText(line, cx, startY + i * lineH));
      return;
    }
  }
  ctx.font = '600 12px sans-serif';
  const lines = buildLines(ctx, words, maxW);
  const lineH = 12 * 1.3;
  const startY = cy - (lines.length * lineH) / 2 + lineH / 2;
  lines.forEach((line, i) => ctx.fillText(line, cx, startY + i * lineH));
}

function buildLines(ctx, words, maxW) {
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxW && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}
