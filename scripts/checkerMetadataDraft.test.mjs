import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { parseConventionName } from '../src/utils/packConvention.js';
import { resolveImportedPackMetadata } from '../src/store/importedPackMetadata.js';

register('./nodeSourceResolver.mjs', import.meta.url);
const doubles = new Map([
  ['@tauri-apps/api/core', 'export async function invoke() { return null; }'],
  ['../icons/LucideLocal', 'export const CircleCheck = () => null; export const FilePen = () => null; export const Package = () => null; export const TriangleAlert = () => null; export const X = () => null;'],
  ['../common/Tooltip', 'export function Tooltip() { return null; }'],
  ['../common/Button', 'export function Button() { return null; }'],
  ['../common/Dialog', 'export function useErrorDialog() { return { showConfirmDialog: async () => false }; }'],
  ['../../hooks/useEscapeKey', 'export function useEscapeKey() {}'],
  ['../../i18n/useCheckerTranslation.js', 'export function useCheckerTranslation() { return { t: key => key }; } export function checkerText(key) { return key; }'],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (doubles.has(specifier)) return { url: `data:text/javascript,${encodeURIComponent(doubles.get(specifier))}`, shortCircuit: true };
    if (specifier === 'react/jsx-runtime') return { url: `data:text/javascript,${encodeURIComponent('export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;')}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('/CommunityPackMetadataModal.jsx')) {
      const path = fileURLToPath(url);
      return { format: 'module', shortCircuit: true, source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code };
    }
    return next(url, context);
  },
});
const { CommunityPackMetadataModal } = await import('../src/components/CommunityPackChecker/CommunityPackMetadataModal.jsx');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...elements(node.props.children)];
}
function modal(report, props = {}) {
  return runner(() => CommunityPackMetadataModal({ report, ...props }));
}
const find = (tree, predicate) => elements(tree).find(predicate);
const titleInput = tree => find(tree, e => e.type === 'input' && e.props.autoFocus);
const correction = tree => find(tree, e => e.props.className?.includes('checker-correction-cta'));
const heading = tree => find(tree, e => e.type === 'h2').props.children;
const field = (tree, key) => find(tree, e => e.type === 'input' && e.props.placeholder === key);

test('D10: explain the missing age, then hide the message once an age is chosen', () => {
  const message = tree => find(tree, e => e.props.children === 'checker:metadata.age.requiredForCorrection');
  const hook = modal({ packTitle: 'Le prince' });
  assert.ok(message(hook.render()));
  find(hook.render(), e => e.type === 'button' && e.props.children?.[0] === '6').props.onClick();
  assert.equal(message(hook.render()), undefined);
  assert.equal(message(modal({ packTitle: '5+ Le prince' }).render()), undefined);
});

test('D10: no invented age, no selected chip, correction disabled until an age is chosen', () => {
  const hook = modal({ packTitle: 'Le prince' });
  let tree = hook.render();
  assert.equal(correction(tree).props.disabled, true);
  assert.equal(find(tree, e => e.props.className === 'is-active'), undefined);
  assert.equal(field(tree, 'checker:metadata.age.other').props.value, '');
  find(tree, e => e.type === 'button' && e.props.children?.[0] === '6').props.onClick();
  tree = hook.render();
  assert.equal(correction(tree).props.disabled, false);
  assert.equal(heading(tree), '6+]Le_prince_V2');
});

test('D11: a typed leading age updates both selection and the exported name', () => {
  const hook = modal({ packTitle: 'Le prince' });
  let tree = hook.render();
  titleInput(tree).props.onChange({ target: { value: '5+ Le prince' } });
  tree = hook.render();
  assert.equal(field(tree, 'checker:metadata.age.other').props.value, '5');
  assert.equal(heading(tree), '5+]Le_prince_V2');
  assert.equal(correction(tree).props.disabled, false);
});

test('D11: a chosen age can override the age previously typed in the title', () => {
  const hook = modal({ packTitle: '5+ Le prince' });
  let tree = hook.render();
  find(tree, e => e.type === 'button' && e.props.children?.[0] === '6').props.onClick();
  assert.equal(heading(hook.render()), '6+]Le_prince_V2');
});

test('typing a title keeps the spaces between words', () => {
  const hook = modal({ packTitle: '' });
  for (const value of ['L', 'Le', 'Le ', 'Le p', 'Le prince']) {
    titleInput(hook.render()).props.onChange({ target: { value } });
    assert.equal(titleInput(hook.render()).props.value, value);
  }
});

for (const extension of ['.zip', '.7Z']) {
  test(`D12: fallback filename and typed title never carry ${extension}`, () => {
    const hook = modal({ packName: `Promenons-nous avec les chiffres !${extension}` });
    let tree = hook.render();
    assert.equal(titleInput(tree).props.value, 'Promenons-nous avec les chiffres !');
    titleInput(tree).props.onChange({ target: { value: `5+ Le prince${extension}` } });
    tree = hook.render();
    assert.equal(titleInput(tree).props.value, 'Le prince');
    assert.equal(heading(tree), '5+]Le_prince_V2');
  });
}

for (const marker of ['by', 'By']) {
  test(`D14: [${marker}_ is read as an author, including in shared import consumers`, () => {
    const parsed = parseConventionName(`5+]PrismaMedia_-_Les_contes_de_Noel[${marker}_Gayel+Mat_V2.zip`);
    assert.equal(parsed.author, 'Gayel+Mat');
    assert.equal(parsed.title, 'Les contes de Noel');
    assert.equal(parsed.producer, 'PrismaMedia');
    assert.equal(parsed.version, 2);
    const imported = resolveImportedPackMetadata({ fileName: `5+]PrismaMedia_-_Les_contes_de_Noel[${marker}_Gayel+Mat_V2.zip` });
    assert.equal(imported.title, 'Les contes de Noel');
    assert.equal(imported.author, 'Gayel+Mat');
  });
  test(`D14/#57: valid filename preserves producer separator and [${marker}_, only version changes`, async () => {
    const name = `5+]PrismaMedia_-_Les_contes_de_Noel[${marker}_Gayel+Mat_V2`;
    let submitted;
    const hook = modal({ packName: `${name}.zip`, packTitle: name, packVersion: 3 }, { onSubmit: patch => { submitted = patch; } });
    const tree = hook.render();
    assert.equal(field(tree, 'checker:metadata.author.placeholder').props.value, 'Gayel+Mat');
    assert.equal(titleInput(tree).props.value, 'Les contes de Noel');
    assert.equal(heading(tree), name.replace(/V2$/, 'V4'));
    const preview = find(tree, e => e.props.className === 'checker-meta-preview');
    const text = elements(preview).filter(e => e.type === 'em').map(e => e.props.children).join('');
    assert.equal(text, `${heading(tree)}.zip`);
    await correction(tree).props.onClick();
    assert.equal(submitted.exportName, heading(tree), 'the engine receives exactly the preview name');
  });
}

test('D14: the valid filename spelling takes precedence over an equivalent composed pack title', () => {
  const hook = modal({
    packName: '5+]Maison_-_Titre[By_Auteur_V2.zip',
    packTitle: '5+]Maison-Titre[by_Auteur_V2',
  });
  assert.equal(heading(hook.render()), '5+]Maison_-_Titre[By_Auteur_V3');
});

test('D14: editing the title composes a new name rather than keeping the source name', () => {
  const hook = modal({ packName: '5+]Maison_-_Titre[By_Auteur_V2.zip' });
  titleInput(hook.render()).props.onChange({ target: { value: 'Autre titre' } });
  assert.equal(heading(hook.render()), '5+]Maison-Autre_titre[by_Auteur_V3');
});

for (const source of ['packName', 'packTitle']) {
  for (const [name, expected] of [
    ['5+]Les contes de Noel[by_Gayel_V2', '5+]Les_contes_de_Noel[by_Gayel_V3'],
    ['5+]Les_contes_de_Noel[By_Gayel_V2', '5+]Les_contes_de_Noel[By_Gayel_V3'],
    ['5+]Contes : Noel/hiver[by_Gayel_V2', '5+]Contes___Noel_hiver[by_Gayel_V3'],
  ]) {
    test(`#57: ${source} ${name} previews the filename written by Rust`, async () => {
      let submitted;
      const hook = modal({ [source]: `${name}.zip` }, { onSubmit: patch => { submitted = patch; } });
      const tree = hook.render();
      assert.equal(heading(tree), expected);
      const preview = find(tree, e => e.props.className === 'checker-meta-preview');
      assert.equal(elements(preview).filter(e => e.type === 'em').map(e => e.props.children).join(''), `${expected}.zip`);
      await correction(tree).props.onClick();
      assert.equal(submitted.exportName, expected);
      // filename_token côté Rust : oracle indépendant du calcul de l'aperçu.
      assert.equal(submitted.exportName.replace(/\s+/g, '_').replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').replace(/^_+|_+$/g, ''), expected);
    });
  }
}

test('D16: heading and preview use the same font to render U+0027', () => {
  const css = readFileSync(new URL('../src/components/CommunityPackChecker/CommunityPackMetadataModal.css', import.meta.url), 'utf8');
  for (const selector of ['.checker-meta-heading h2', '.checker-meta-preview > div']) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /font-family: var\(--font-mono\)/);
  }
});
