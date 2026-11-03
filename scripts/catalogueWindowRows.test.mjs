import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueWindow, sameWindowRows, windowLayout } from '../src/store/catalogue/windowing.js';

// Scrolling re-renders the catalogue only when the rendered rows change.
test('sameWindowRows agrees with the rows catalogueWindow renders', () => {
  const layout = windowLayout({ count: 400, columns: 4, rowHeight: 280, gap: 16, expanded: [], expansionHeight: 0 });
  const rows = top => { const w = catalogueWindow(layout, { scrollTop: top, viewport: 720 }); return `${w.first}:${w.last}`; };
  for (let a = 0; a < 6000; a += 37) {
    for (const delta of [1, 15, 150, 296, 900]) {
      assert.equal(sameWindowRows(layout, a, a + delta, 720), rows(a) === rows(a + delta), `${a} → ${a + delta}`);
    }
  }
  assert.equal(sameWindowRows(layout, 300, 310, 720), true);
  assert.equal(sameWindowRows(layout, 0, 2000, 720), false);
  assert.equal(sameWindowRows(windowLayout({ count: 0, rowHeight: 44 }), 0, 500, 720), true);
});
