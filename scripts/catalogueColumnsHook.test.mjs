import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { usePersistentColumns } = await import('../src/hooks/usePersistentColumns.js');
const { useColumnWidths, COLUMNS, colsToGrid } = await import('../src/components/MediaExplorer/useColumnWidths.js');
const { CATALOGUE_COLUMNS } = await import('../src/store/catalogue/listColumns.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { VIEW_MODES, normalizeView } = await import('../src/store/catalogue/viewModes.js');
const { browseSession } = await import('../src/store/catalogue/browseSession.js');
const { useCatalogueViewPrefs } = await import('../src/hooks/useCatalogueViewPrefs.js');

test('card density persists across hook remounts and view changes', () => environment(({ values }) => {
  let hook = runner(useCatalogueViewPrefs);
  let view = hook.render();
  assert.equal(view.density, 'normal');
  view.setDensity('compact');
  view = hook.render();
  view.setView('list');
  hook.unmount();
  hook = runner(useCatalogueViewPrefs);
  view = hook.render();
  assert.equal(view.density, 'compact');
  assert.equal(view.view, 'list');
  view.setView('cards');
  view = hook.render();
  assert.equal(view.density, 'compact');
  view.setDensity('large');
  assert.equal(values.get(KEYS.CATALOGUE_CARD_DENSITY), 'large');
  hook.unmount();
}));

function environment(run) {
  const previous = { localStorage: globalThis.localStorage, document: globalThis.document };
  const values = new Map(); const events = new Map();
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  globalThis.document = { body: { style: { cursor: '' } }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  try { run({ values, events }); } finally {
    browseSession.clear();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}

test('fiche column choices persist across remounts, independently of media', () => environment(({ values }) => {
  values.set(KEYS.MEDIA_EXPLORER_VISIBLE_COLS, JSON.stringify(['name', 'tags']));
  const hook = runner(() => usePersistentColumns(CATALOGUE_COLUMNS));
  let columns = hook.render(); hook.flush();
  assert.deepEqual([...columns.visibleCols], CATALOGUE_COLUMNS.defaultVisible);
  columns.toggleCol('title'); columns.toggleCol('producer'); columns.toggleCol('bonus');
  columns = hook.render();
  assert.ok(columns.visibleCols.has('title'));
  assert.ok(!columns.visibleCols.has('producer')); assert.ok(!columns.visibleCols.has('bonus'));
  hook.unmount();
  const remounted = runner(() => usePersistentColumns(CATALOGUE_COLUMNS));
  assert.deepEqual([...remounted.render().visibleCols], [...columns.visibleCols]);
  remounted.unmount();
  assert.equal(values.get(KEYS.MEDIA_EXPLORER_VISIBLE_COLS), '["name","tags"]');
}));

test('pointer resize clamps, persists under catalogue key and cleans up when unmounted', () => environment(({ values, events }) => {
  values.set(KEYS.MEDIA_EXPLORER_COL_WIDTHS, '{"name":333}');
  const hook = runner(() => usePersistentColumns(CATALOGUE_COLUMNS));
  let columns = hook.render(); hook.flush(); let prevented = false;
  columns.startResize({ clientX: 100, preventDefault: () => { prevented = true; } }, 'title');
  assert.equal(prevented, true);
  events.get('pointermove')({ clientX: 180 }); columns = hook.render();
  assert.equal(columns.colWidths.title, 320);
  events.get('pointerup')(); assert.equal(events.size, 0);
  assert.equal(JSON.parse(values.get(KEYS.CATALOGUE_COL_WIDTHS)).title, 320);
  assert.equal(values.get(KEYS.MEDIA_EXPLORER_COL_WIDTHS), '{"name":333}');
  hook.unmount();
  const mounted = runner(() => usePersistentColumns(CATALOGUE_COLUMNS));
  columns = mounted.render(); mounted.flush(); assert.equal(columns.colWidths.title, 320);
  columns.startResize({ clientX: 100, preventDefault() {} }, 'title');
  events.get('pointermove')({ clientX: -1000 }); columns = mounted.render();
  assert.equal(columns.colWidths.title, 40);
  mounted.unmount(); assert.equal(events.size, 0); assert.equal(document.body.style.cursor, '');
}));

test('media retains all defaults, legacy widths migration, sort reset, last column and its exact keys', () => environment(({ values, events }) => {
  values.set(KEYS.MEDIA_EXPLORER_COL_WIDTHS, '[222,123,12,88,105,280,130]');
  values.set(KEYS.MEDIA_EXPLORER_VISIBLE_COLS, '["name","tags","obsolete"]');
  let resets = 0;
  const hook = runner(() => useColumnWidths({ sortCol: 'tags', onSortColReset: () => { resets++; } }));
  let columns = hook.render(); hook.flush();
  assert.deepEqual(columns.colWidths, { name: 222, usage: 123, size: 40, dim: 88, dur: 72, fmt: 105, date: 110, path: 280, tags: 130 });
  assert.deepEqual([...columns.visibleCols], ['name', 'tags']);
  assert.equal(colsToGrid(columns.colWidths, columns.visibleCols), '56px 222px 130px 30px');
  columns.toggleCol('tags'); columns = hook.render(); assert.equal(resets, 1);
  columns.toggleCol('name'); columns = hook.render(); assert.deepEqual([...columns.visibleCols], ['name']);
  columns.startResize({ clientX: 0, preventDefault() {} }, 'name');
  events.get('pointermove')({ clientX: 50 }); events.get('pointerup')();
  assert.equal(JSON.parse(values.get('me-col-widths-v2')).name, 272);
  assert.equal(values.get('me-visible-cols-v2'), '["name"]');
  assert.equal(values.has(KEYS.CATALOGUE_COL_WIDTHS), false); hook.unmount();
  values.clear();
  const fresh = runner(() => useColumnWidths()); columns = fresh.render();
  assert.deepEqual([...columns.visibleCols], COLUMNS.map(c => c.id));
  assert.equal(columns.colWidths.name, 200); fresh.unmount();
}));

test('two view switch preserves sort; legacy session details restores List and its scroll', () => environment(() => {
  assert.deepEqual(VIEW_MODES.map(v => v.id), ['cards', 'list']);
  assert.equal(normalizeView('details'), 'list');
  browseSession.save({ view: 'details', scroll: { cards: 120, details: 760 }, selection: { ids: ['a'] } });
  assert.equal(browseSession.restore().view, 'list'); assert.equal(browseSession.restore().scroll.list, 760);
  const hook = runner(useCatalogueViewPrefs); let view = hook.render();
  assert.equal(view.view, 'list');
  view.setSortKey('age'); view = hook.render();
  view.setView('cards'); view = hook.render(); assert.equal(view.view, 'cards'); assert.equal(view.sort.key, 'age');
  view.setView('list'); view = hook.render(); assert.equal(view.view, 'list'); assert.equal(view.sort.key, 'age');
  hook.unmount();
}));

test('tri : un nouveau critère prend son sens naturel, pas celui du précédent', () => environment(() => {
  const hook = runner(useCatalogueViewPrefs); let view = hook.render();
  view.setSortKey('size'); view = hook.render();
  assert.deepEqual({ ...view.sort }, { key: 'size', direction: 'desc' });
  view.toggleDirection(); view = hook.render();
  assert.deepEqual({ ...view.sort }, { key: 'size', direction: 'asc' });
  view.setSortKey('author'); view = hook.render();
  assert.deepEqual({ ...view.sort }, { key: 'author', direction: 'asc' });
  view.setSortKey('modifiedAt'); view = hook.render();
  assert.deepEqual({ ...view.sort }, { key: 'modifiedAt', direction: 'desc' });
  hook.unmount();
}));
