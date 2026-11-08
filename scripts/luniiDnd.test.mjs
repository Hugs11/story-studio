import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import i18next from 'i18next';
import { DndContext } from '@dnd-kit/core';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { card } from './catalogueFixtures.mjs';
import { CATALOGUE_COLUMNS } from '../src/store/catalogue/listColumns.js';
import { dropTargetOf, edgeScrollSpeed, pinScrollAncestors, probePoint, reorderIndex, sendRowKey } from '../src/store/catalogue/luniiDndTargets.js';
const { DraggableCard, DraggableRow } = await import('../src/components/Catalogue/lunii/CatalogueDragSources.jsx');
const { LuniiGrip } = await import('../src/components/Catalogue/lunii/LuniiGrip.jsx');
const { LuniiDndFrame, snapToPointer } = await import('../src/components/Catalogue/lunii/LuniiDndFrame.jsx');

const at = (kind, deviceId, rowKey) => ({ closest: () => ({ dataset: { luniiDrop: kind, deviceId, rowKey } }) });

test('drop surfaces are read from the DOM; rows, the header and the dedicated end area take a reorder drop', () => {
  assert.equal(dropTargetOf(null), null);
  assert.equal(dropTargetOf({ closest: () => null }), null);
  assert.deepEqual(dropTargetOf(at('row', 'd', 'c')), { kind: 'row', deviceId: 'd', rowKey: 'c' });
  assert.equal(dropTargetOf(at('tab', 'e', 'ignored')).rowKey, null);
  assert.equal(sendRowKey(dropTargetOf(at('row', 'd', 'c'))), 'c');
  for (const kind of ['orphan', 'header', 'scroll', 'end', 'tab', 'collapsed']) assert.equal(sendRowKey(dropTargetOf(at(kind, 'd'))), null, `${kind}: end of the list`);
  const device = { id: 'd', stories: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] };
  assert.equal(reorderIndex(dropTargetOf(at('row', 'd', 'b')), device), 1);
  assert.equal(reorderIndex(dropTargetOf(at('header', 'd')), device), 3);
  assert.equal(reorderIndex(dropTargetOf(at('end', 'd')), device), 3, 'only the dedicated end area accepts the final reorder boundary');
  for (const target of [at('scroll', 'd'), at('end', 'other'), at('scroll', 'other'), at('orphan', 'd'), at('tab', 'd'), at('row', 'other', 'b'), at('row', 'd', 'gone')]) assert.equal(reorderIndex(dropTargetOf(target), device), null);
});

test('the probe is the pointer, or the centre of the moved handle for a keyboard drag', () => {
  assert.deepEqual(probePoint({ activatorEvent: { clientX: 10, clientY: 20 }, delta: { x: 5, y: -2 } }), { x: 15, y: 18 });
  assert.deepEqual(probePoint({ activatorEvent: { type: 'keydown' }, delta: { x: 0, y: 0 }, active: { rect: { current: { translated: { left: 10, top: 20, width: 10, height: 6 } } } } }), { x: 15, y: 23 });
  assert.equal(probePoint({ activatorEvent: { type: 'keydown' } }), null);
  const rect = { top: 100, bottom: 400 };
  assert.equal(edgeScrollSpeed(rect, 250), 0); assert.ok(edgeScrollSpeed(rect, 105) < 0); assert.ok(edgeScrollSpeed(rect, 395) > 0);
});

test('the ghost sits below the pointer; a keyboard drag keeps the overlay as is', () => {
  const transform = { x: 3, y: 4, scaleX: 1, scaleY: 1 };
  assert.deepEqual(snapToPointer({ activatorEvent: { clientX: 110, clientY: 60 }, activeNodeRect: { left: 100, top: 50 }, transform }), { x: 27, y: 28, scaleX: 1, scaleY: 1 });
  assert.equal(snapToPointer({ activatorEvent: { type: 'keydown' }, activeNodeRect: { left: 100, top: 50 }, transform }), transform);
});

test('dnd-kit scroll is disabled: both sources use the list under the pointer', () => {
  assert.match(readFileSync('src/components/Catalogue/lunii/LuniiDndFrame.jsx', 'utf8'), /<DndContext[^>]*autoScroll=\{false\}/);
});

test('a dragged card pins the catalogue that scrolls around it, never a Lunii list, until released', () => {
  const node = (names, overflow, parentElement = null) => {
    const listeners = new Set();
    return { nodeType: 1, parentElement, overflow, scrollTop: 40, scrollLeft: 0, classList: { contains: name => names.includes(name) },
      addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn), scroll() { listeners.forEach(fn => fn()); } };
  };
  const view = { getComputedStyle: el => ({ overflowX: 'hidden', overflowY: el.overflow }) };
  const catalogue = node(['catalogue-results'], 'auto');
  const list = node(['lunii-scroll'], 'auto', catalogue);
  const card = node(['catalogue-card'], 'visible', list);
  const release = pinScrollAncestors(card, view);
  catalogue.scrollTop = 300; catalogue.scroll();
  list.scrollTop = 300; list.scroll();
  assert.equal(catalogue.scrollTop, 40, 'the catalogue is put back');
  assert.equal(list.scrollTop, 300, 'a Lunii list keeps scrolling');
  release();
  catalogue.scrollTop = 120; catalogue.scroll();
  assert.equal(catalogue.scrollTop, 120, 'released after the drop');
  assert.doesNotThrow(() => pinScrollAncestors(null, view)());
});

test('cards, list rows and story handles are drag sources without any native drag attribute', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const c = card({ id: 'x', title: 'Histoire', exemplars: [{ id: 'x1', format: 'zip' }] });
  const item = { card: c, exemplars: c.exemplars, representative: c.exemplars[0] };
  const luniiSend = { drag: { dragIds: null, idsFor: id => [id] }, stateOf: () => ({ kind: 'none' }), onSend() {}, onSee() {} };
  const view = { selected: new Set(), activeId: c.id, expanded: new Set(), luniiSend, onItemClick() {}, onOpenModal() {}, onItemKeyDown() {}, onCardMenu() {}, onFormatClick() {}, onToggleExpanded() {} };
  const cardSurface = mountSurface(React.createElement(DndContext, null, React.createElement(DraggableCard, { item, index: 0, view })));
  assert.match(cardSurface.html, /data-card-id="x"/); assert.doesNotMatch(cardSurface.html, /draggable="true"/);
  const rowSurface = mountSurface(React.createElement(DndContext, null, React.createElement('table', null, React.createElement('tbody', null, React.createElement(DraggableRow, { item, index: 1, columns: CATALOGUE_COLUMNS.columns, view })))));
  assert.match(rowSurface.html, /data-card-id="x"/); assert.doesNotMatch(rowSurface.html, /draggable="true"/);
  const device = { id: 'd' };
  const grip = mountSurface(React.createElement(DndContext, null, React.createElement(LuniiGrip, { story: { key: 'a', title: 'A' }, device, disabledReason: null, dragging: false })));
  assert.match(grip.html, /aria-label="Déplacer l’histoire"/); assert.match(grip.html, /aria-roledescription="poignée de déplacement"/); assert.doesNotMatch(grip.html, / disabled=""|draggable="true"/);
  const locked = mountSurface(React.createElement(DndContext, null, React.createElement(LuniiGrip, { story: { key: 'a' }, device, disabledReason: 'Lecture seule', dragging: false })));
  assert.match(locked.html, / disabled=""/);
  const frame = mountSurface(React.createElement(LuniiDndFrame, { dnd: { handlers: {}, active: null }, send: null, cardsById: new Map() }, React.createElement('p', null, 'contenu')));
  assert.match(frame.html, /contenu/);
  assert.match(i18next.t('catalogue:dnd.instructions'), /Espace ou Entrée/, 'screen-reader instructions are the French ones');
});

test('no native HTML5 drag remains in the catalogue send paths', () => {
  const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
  const files = [...walk('src/components/Catalogue').filter(path => /\.jsx?$/.test(path)), 'src/hooks/useLuniiSend.js', 'src/hooks/useCatalogueSendUi.js', 'src/hooks/useLuniiDnd.js'];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    if (path.endsWith('AddSourceControl.jsx')) continue; // system folder drop notice, not an internal drag
    assert.doesNotMatch(source, /\bdraggable=|\bonDrag[A-Z]\w*=|\bonDrop=|dataTransfer/, path);
  }
});

test('a press on an interactive part of a card never starts a drag; elsewhere it does', async () => {
  const { ignoreInteractive } = await import('../src/components/Catalogue/lunii/CatalogueDragSources.jsx');
  const started = [];
  const handler = ignoreInteractive(event => started.push(event.id));
  const on = (id, interactive) => ({ id, target: { closest: selector => { assert.match(selector, /button/); assert.match(selector, /\[data-no-drag\]/); assert.match(selector, /\[role="button"\]/); return interactive ? {} : null; } } });
  handler(on('button', true)); handler(on('card', false));
  assert.deepEqual(started, ['card']);
  assert.equal(ignoreInteractive(undefined), undefined);
});


test('the dedicated final boundary moves A after B,C and dropping C there performs no write', async () => {
  const { createLuniiGestures } = await import('../src/store/catalogue/luniiGestures.js');
  const device = { id: 'd', stories: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] };
  const writes = [];
  const gestures = createLuniiGestures({ store: { mutate: async (...args) => { writes.push(args); } } }, () => '', async () => true, () => {});
  const index = reorderIndex(dropTargetOf(at('end', 'd')), device);
  await gestures.reorder(device, ['a'], index);
  assert.deepEqual(writes, [['d', 'reorder', [{ rowKey: null, index: 3 }], ['a'], { a: '' }]]);
  writes.length = 0;
  await gestures.reorder(device, ['c'], index);
  assert.deepEqual(writes, []);
});
