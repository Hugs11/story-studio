import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
function luminance(hex) {
  const rgb = hex.match(/../g).map(h => parseInt(h, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
for (const format of ['project','zip','seven-zip','folder']) test(`${format}: format text contrast in both themes`, () => {
  const colors = role => [...css.matchAll(new RegExp(`--catalogue-format-${format}-${role}: #([0-9a-f]{6})`, 'g'))].map(m => luminance(m[1]));
  const texts = colors('text');
  const backgrounds = colors('bg');
  assert.equal(texts.length, 2);
  for (let i = 0; i < 2; i++) assert.ok((Math.max(texts[i], backgrounds[i]) + .05) / (Math.min(texts[i], backgrounds[i]) + .05) >= 4.5);
});
