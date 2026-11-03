import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_DENSITIES, gridColumnCount, gridCardHeight, windowLayout, catalogueWindow, scrollToIndex } from '../src/store/catalogue/windowing.js';
import { readViewPrefs, writeViewPrefs } from '../src/store/catalogue/viewPrefs.js';
import { KEYS } from '../src/store/persistentSettings.js';

const rem = 16;
test('density columns at measured screen widths, with panels and the 11rem floor', () => {
  assert.deepEqual(CARD_DENSITIES.map(level => level.cardsPerWindow), [10, 8, 6]);
  for (const [width, windowWidth, expected] of [
    [1796, 1846, [9, 8, 6]], [1298, 1846, [6, 6, 4]],
    [2530, 2554, [10, 8, 6]], [1990, 2554, [8, 6, 5]],
    [1024, 1024, [5, 5, 5]], [512, 1024, [2, 2, 2]],
  ]) {
    assert.deepEqual(CARD_DENSITIES.map(({ id: density }) => gridColumnCount({ width, windowWidth, rem, density })), expected);
  }
});

test('cards preserve the measured 302.25 by 280 shape at each width and density', () => {
  assert.equal(gridCardHeight({ width: 2530, rem, columns: 8 }), 280);
  for (const density of CARD_DENSITIES) for (const width of [100, 512, 1298, 1796, 1990, 2530]) {
    const columns = gridColumnCount({ width, windowWidth: 2554, rem, density: density.id });
    const cardWidth = (width - (columns - 1) * rem) / columns;
    const height = gridCardHeight({ width, rem, columns });
    assert.ok(Math.abs(height / cardWidth - 280 / 302.25) < 1e-12);
  }
});

test('density alone survives restart; missing and invalid stored values use Normal', () => {
  const values = new Map();
  const settings = { read: key => values.get(key), write: (key, value) => { values.set(key, value); return true; } };
  assert.equal(readViewPrefs(settings).density, 'normal');
  for (const { id: density } of CARD_DENSITIES) {
    assert.equal(writeViewPrefs({ view: 'cards', density }, settings), true);
    assert.equal(readViewPrefs(settings).density, density);
    assert.equal(values.get(KEYS.CATALOGUE_CARD_DENSITY), density);
  }
  for (const invalid of [null, '', 'tiny', '10', '{}']) {
    values.set(KEYS.CATALOGUE_CARD_DENSITY, invalid);
    assert.equal(readViewPrefs(settings).density, 'normal');
  }
});

test('fractional card heights scroll without missing or duplicate rows at every density', () => {
  for (const { id: density } of CARD_DENSITIES) for (const width of [512, 1298, 2530]) {
    const columns = gridColumnCount({ width, windowWidth: 2554, rem, density });
    const rowHeight = gridCardHeight({ width, rem, columns });
    const pitch = rowHeight + rem;
    const count = 1003, viewport = 537;
    const layout = windowLayout({ count, columns, rowHeight, gap: rem });
    for (let top = 0.125; top < layout.total - viewport; top += pitch / 3) {
      const window = catalogueWindow(layout, { scrollTop: top, viewport, margin: 0 });
      const rows = window.segments.filter(s => s.kind === 'row');
      assert.equal(rows[0].row, Math.floor(top / pitch));
      assert.equal(rows.at(-1).row, Math.floor((top + viewport) / pitch));
      const indices = rows.flatMap(row => Array.from({ length: row.end - row.start }, (_, i) => row.start + i));
      assert.equal(new Set(indices).size, indices.length);
      assert.deepEqual(indices, window.visibleIndices);
      assert.ok(Math.abs(window.segments.reduce((sum, segment) => sum + segment.height, 0) - layout.total) < 1e-6);
    }
    const index = count - 1;
    const top = scrollToIndex(layout, index, 0, viewport);
    assert.ok(top <= Math.floor(index / columns) * pitch);
    assert.ok(top + viewport >= layout.total);
  }
});
