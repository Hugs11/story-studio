import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { card } from './catalogueFixtures.mjs';
import { formatTags } from '../src/store/catalogue/formatTag.js';

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { FormatTag, FormatTagRow } = await import('../src/components/Catalogue/FormatTag.jsx');
const { CardFormatTags } = await import('../src/components/Catalogue/views/CardFormatTags.jsx');
const { CompactExemplar } = await import('../src/components/Catalogue/open/CompactExemplar.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
const render = (Component, props) => { const app = runner(() => Component(props)); try { return app.render(); } finally { app.unmount(); } };

const SENTENCE = 'b.zip : une image est abîmée (écran « La girafe »)';
const pack = () => card({ exemplars: [
  { id: 'a', format: 'zip', path: '/p/a.zip', modifiedAt: 300 },
  { id: 'b', format: 'zip', path: '/p/b.zip', modifiedAt: 200, damagedMedia: { kind: 'image', screen: 'La girafe' } },
  { id: 'f', format: 'folder', path: '/p/f' },
] });

test('the engine value reaches the copy; anything else is ignored', () => {
  const [a, b] = pack().exemplars.slice().sort((x, y) => x.id.localeCompare(y.id));
  assert.equal(a.damagedMedia, null);
  assert.deepEqual(b.damagedMedia, { kind: 'image', screen: 'La girafe' });
  const odd = card({ exemplars: [{ damagedMedia: { kind: 'image', screen: '  ' } }, { damagedMedia: { kind: 'sound', screen: 'x' } }, { damagedMedia: 'x' }] }).exemplars;
  assert.deepEqual(odd.map(e => e.damagedMedia), [{ kind: 'image', screen: null }, null, null]);
});

test('only the tag of a format holding a damaged copy carries the sentence naming the copy and the screen', () => {
  const tags = formatTags(pack().exemplars);
  assert.deepEqual(tags.map(t => [t.format, t.damaged.length]), [['zip', 1], ['folder', 0]]);
  assert.deepEqual(tags[0].damaged[0], { exemplarId: 'b', line: { key: 'catalogue:damagedMedia.image', params: { exemplar: 'b.zip', screen: 'La girafe' } } });
  assert.equal(formatTags(card({ exemplars: [{ damagedMedia: { kind: 'image', screen: null }, path: '/p/n.zip' }] }).exemplars)[0].damaged[0].line.key, 'catalogue:damagedMedia.imageUnnamed');
});

const badges = tree => elements(tree).filter(e => e.props?.className === 'catalogue-format-tag-damaged');
const hint = tree => elements(tree).find(e => e.type === Tooltip)?.props.text;

test('List: the tag shows a « ! » before its label, a tooltip and hidden text with the sentence; healthy tags show none', () => {
  const tags = formatTags(pack().exemplars);
  const row = render(FormatTagRow, { tags, idPrefix: 't', compact: true, onActivate() {} });
  const rendered = elements(row).filter(e => e.type === FormatTag).map(e => render(FormatTag, e.props));
  assert.equal(badges(rendered[0]).length, 1); assert.equal(badges(rendered[0])[0].props['aria-hidden'], 'true');
  assert.equal(text(badges(rendered[0])[0]), '!');
  assert.equal(hint(rendered[0]), SENTENCE, 'the app tooltip, never a native title');
  assert.ok(elements(rendered[0]).every(e => e.props?.title === undefined));
  assert.match(text(rendered[0]), /ZIP.*une image est abîmée/s);
  assert.equal(badges(rendered[1]).length, 0); assert.equal(hint(rendered[1]), undefined);
  const hidden = elements(rendered[0]).filter(e => e.props?.className === 'catalogue-visually-hidden').map(e => text(e));
  assert.ok(hidden.some(h => h.includes(SENTENCE)), 'screen readers hear it');
});

test('Grid: the card tags carry the same « ! » and tooltip', () => {
  const previous = { ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.requestAnimationFrame = fn => { fn(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ columnGap: '4' });
  try {
    const tree = render(CardFormatTags, { tags: formatTags(pack().exemplars), idPrefix: 'g', tabIndex: 0, onActivate() {} });
    const shown = elements(tree).filter(e => e.type === FormatTag && e.props.onActivate).map(e => render(FormatTag, e.props));
    assert.equal(shown.length, 2);
    assert.equal(badges(shown[0]).length, 1); assert.equal(hint(shown[0]), SENTENCE);
    assert.equal(badges(shown[1]).length, 0);
  } finally { Object.assign(globalThis, previous); }
});

test('compact mentions and the damage sentence share the one tooltip', () => {
  const c = card({ exemplars: [{ format: 'zip', path: '/p/multi.zip', member: 'b.zip', damagedMedia: { kind: 'image', screen: 'La girafe' } }] });
  const t = render(FormatTag, { tag: formatTags(c.exemplars)[0], compact: true });
  assert.match(hint(t), /multi\.zip.* · b\.zip : une image est abîmée/);
});

test('Fiche: the row of the damaged copy starts with « ! » and the sentence; others do not', () => {
  const [a, b] = ['a', 'b'].map(id => pack().exemplars.find(e => e.id === id));
  const hurtRow = render(CompactExemplar, { exemplar: b, showName: true });
  const damaged = elements(hurtRow).find(e => e.props?.className === 'catalogue-compact-exemplar-damaged');
  assert.ok(damaged); assert.match(text(damaged), /!\s+b\.zip : une image est abîmée \(écran « La girafe »\)/);
  assert.equal(elements(render(CompactExemplar, { exemplar: a, showName: true })).some(e => e.props?.className === 'catalogue-compact-exemplar-damaged'), false);
});
