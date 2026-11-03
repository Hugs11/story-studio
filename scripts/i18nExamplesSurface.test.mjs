import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { sources } from './i18nExamplesSourceFixture.mjs';

// Banc Vite : `original` remplace les dix fichiers du domaine par leur source
// de BASE (fixture `git show`), pour comparer les surfaces réellement rendues.
async function examplesHarness(original = false, mounted = false) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'story-studio-examples-'));
  const server = await createServer({ cacheDir, configFile: false, plugins: [{ name: 'examples-original-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0].replaceAll('\\', '/').replace(`${process.cwd().replaceAll('\\', '/')}/`, '');
    if (!mounted && file === 'src/components/common/AppModalPortal.jsx') return 'export function AppModalPortal({children}) { return <div>{children}</div>; }';
    return original && sources[file] ? sources[file] : code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const closeServer = server.close.bind(server);
  server.close = async () => { try { await closeServer(); } finally { await rm(cacheDir, { recursive: true, force: true }); } };
  const load = (file) => server.ssrLoadModule('/' + file);
  const { initializeI18n } = await load('src/i18n/index.js');
  const engine = initializeI18n('fr');
  const { ExampleDialog } = await load('src/components/AdvancedWorkspace/ExampleDialog.jsx');
  const { ExamplesMenu } = await load('src/components/AdvancedWorkspace/ExamplesMenu.jsx');
  const { ProjectContext } = await load('src/store/ProjectContext.js');
  const catalog = await load('src/store/advancedExamples/catalog.js');
  return { server, load, engine, ExampleDialog, ExamplesMenu, ProjectContext, catalog };
}

const PIPER = { backend: 'piper', piperVoice: 'fr_FR-siwis-medium' };
const noop = () => {};
function dialog(h, state, { xttsSettings = PIPER, replacesInitialRoot = true } = {}) {
  return React.createElement(h.ProjectContext.Provider, { value: { xttsSettings } },
    React.createElement(h.ExampleDialog, { state, replacesInitialRoot, disabled: false, onCancel: noop, onConfirm: noop, onStop: noop }));
}
// Texte hors catalogue en pseudo-locale ; le détail technique brut (<pre>,
// replié sous <details>) reste une donnée technique et en est exclu.
function outsideCatalogue(html) {
  assert.doesNotMatch(html, /<pre>(?![^<]*<\/pre><\/details>)/u, 'détail brut toujours replié');
  const shown = html.replace(/<pre>[^<]*<\/pre>/gu, '');
  return [...shown.matchAll(/>([^<>]+)</g), ...shown.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)]
    .map((m) => m[1].trim()).filter((value) => value && !value.includes('['));
}
const visible = (html) => ({
  text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
  attributes: [...html.matchAll(/\b(title|aria-label|alt|placeholder)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
});

// États équivalents : BASE reçoit les textes que l'ancien hook présentait,
// le nouveau reçoit des descripteurs. Comptes ≥ 2 (formes identiques en FR).
function states(example, modern) {
  const errorOf = (name, cause) => (modern
    ? { key: 'examples:error.media.item', params: { name, error: { userMessage: cause } } }
    : { userMessage: cause, prefix: `${name} : ` });
  const base = { example, busy: false, inserted: false, stopped: false, result: null, error: '', progress: null };
  return {
    initial: { ...base },
    progress: { ...base, busy: true, inserted: true, report: { replacedInitialRoot: true },
      progress: { completed: 3, total: 40, label: modern ? { key: 'examples:progress.image.item', params: { name: example.stages[2].name } } : `Image : ${example.stages[2].name}` } },
    preparing: { ...base, busy: true, progress: { completed: 0, total: 0, label: modern ? { key: 'examples:progress.graph.creating' } : 'Création du graphe…' } },
    result: { ...base, inserted: true, report: { replacedInitialRoot: true },
      result: { imageCount: 12, audioCount: 30, errors: [errorOf(example.stages[3].name, new Error('Disque indisponible'))] } },
    added: { ...base, inserted: true, report: { replacedInitialRoot: false }, result: { imageCount: 2, audioCount: 2, errors: [] } },
    stopped: { ...base, inserted: true, stopped: true, report: { replacedInitialRoot: true } },
    error: { ...base, error: modern ? { key: 'examples:error.insertion.notApplied' } : 'L’exemple n’a pas été ajouté. Termine le geste en cours puis réessaie.' },
  };
}

test('exemples : dialogue et menu FR identiques au rendu de BASE (texte et attributs accessibles)', async () => {
  const old = await examplesHarness(true);
  const baseline = {};
  try {
    const example = old.catalog.createAdvancedExample('grey-rabbit');
    for (const [name, state] of Object.entries(states(example, false))) {
      baseline[name] = visible(renderToStaticMarkup(dialog(old, state)));
      baseline[`${name}:added`] = visible(renderToStaticMarkup(dialog(old, state, { replacesInitialRoot: false, xttsSettings: {} })));
    }
    baseline.menu = visible(renderToStaticMarkup(React.createElement(old.ExamplesMenu, { disabled: false, onChoose: noop })));
    // Preuve de détection : la surface de BASE, codée en dur, sort du catalogue en pseudo-locale.
    await old.engine.changeLanguage('pseudo');
    const leaks = [states(example, false).progress, states(example, false).initial]
      .flatMap((state) => outsideCatalogue(renderToStaticMarkup(dialog(old, state))));
    for (const leak of ['Arrêter les médias', 'Images-titres', 'Générer les images-titres de cet exemple', 'Ajouter cet exemple']) {
      assert.ok(leaks.includes(leak) || leaks.includes('Créer cet exemple'), `${leak} : ${leaks.join(' | ')}`);
    }
    await old.engine.changeLanguage('fr');
  } finally { await old.server.close(); }
  const h = await examplesHarness();
  try {
    const example = h.catalog.createAdvancedExample('grey-rabbit', 'fr');
    for (const [name, state] of Object.entries(states(example, true))) {
      assert.deepEqual(visible(renderToStaticMarkup(dialog(h, state))), baseline[name], name);
      assert.deepEqual(visible(renderToStaticMarkup(dialog(h, state, { replacesInitialRoot: false, xttsSettings: {} }))), baseline[`${name}:added`], `${name}:added`);
    }
    assert.deepEqual(visible(renderToStaticMarkup(React.createElement(h.ExamplesMenu, { disabled: false, onChoose: noop }))), baseline.menu);
    // Écart nominatif signalé : à 0 et 1, le FR suit la catégorie CLDR « one »
    // (BASE écrivait « 0 audios ajoutés »). Aucune autre différence de texte.
    const zero = visible(renderToStaticMarkup(dialog(h, { ...states(example, true).added, result: { imageCount: 0, audioCount: 1, errors: [] } }, { replacesInitialRoot: false, xttsSettings: {} })));
    assert.equal(zero.text, baseline['added:added'].text.replace('2 images créées · 2 audios ajoutés à la file TTS', '0 image créée · 1 audio ajouté à la file TTS'));
    // Les seuls ajouts visibles : la ligne langue/voix et le choix d'installation.
    const withVoice = visible(renderToStaticMarkup(dialog(h, { ...states(example, true).initial,
      voice: { backend: 'piper', language: 'fr', voice: 'fr_FR-siwis-medium', adapted: false, status: 'ready' } })));
    assert.equal(withVoice.text.replace(` ${h.engine.t('examples:dialog.voice.summary', { language: 'Français', voice: 'fr_FR-siwis-medium' })}`, ''), baseline.initial.text);
  } finally { await h.server.close(); }
});

test('exemples : EN/IT sans texte FR, pseudo-locale sans texte hors catalogue (title, aria-label compris)', async () => {
  const h = await examplesHarness();
  try {
    const voiceStates = (example) => {
      const all = states(example, true);
      const missing = { backend: 'piper', language: 'en', voice: 'en_US-kristin-medium', adapted: true, status: 'missing' };
      return { ...all,
        choice: { ...all.initial, voice: missing, voiceChoice: true },
        offline: { ...all.initial, voice: missing, voiceChoice: true, voiceError: { code: 'PIPER_DOWNLOAD_REQUEST_FAILED', params: { service: 'huggingface.co', error: '_RAW_OFFLINE_' }, detail: '_RAW_DETAIL_' } },
        raw: { ...all.initial, error: { raw: '_RAW_OBJECT_' } },
      };
    };
    const frExample = h.catalog.createAdvancedExample('grey-rabbit', 'fr');
    const frenchTexts = new Set(Object.values(voiceStates(frExample)).flatMap((state) => visible(renderToStaticMarkup(dialog(h, state))).text.split(/(?<=[.:!?»])\s+/u)));
    for (const language of ['en', 'it']) {
      await h.engine.changeLanguage(language);
      const example = h.catalog.createAdvancedExample('grey-rabbit', language);
      for (const [name, state] of Object.entries(voiceStates(example))) {
        const html = renderToStaticMarkup(dialog(h, state));
        assert.doesNotMatch(html, /examples:[a-z]+\.|\[object Object\]/, `${language}:${name}`);
        for (const sentence of visible(html.replace(/<pre>[^<]*<\/pre>/gu, '')).text.split(/(?<=[.:!?»])\s+/u)) {
          if (sentence.length > 12 && !/^_RAW|Pico|Nino/u.test(sentence)) assert.ok(!frenchTexts.has(sentence) || /^\d/.test(sentence), `${language}:${name} : « ${sentence} » reste en français`);
        }
        if (name === 'choice') {
          assert.ok(html.includes(h.engine.t('examples:dialog.voice.install')));
          assert.ok(html.includes(h.engine.t('examples:dialog.voice.skipAudio')));
          assert.ok(!html.includes(h.engine.t('examples:dialog.confirm.create')), 'aucune confirmation implicite pendant le choix');
        }
        if (name === 'offline') {
          assert.ok(html.includes(h.engine.t('examples:dialog.voice.installFailed')));
          assert.match(html, /<details><summary>[^<]+<\/summary><pre>_RAW_DETAIL_<\/pre><\/details>|_RAW_OFFLINE_/u);
        }
      }
    }
    await h.engine.changeLanguage('pseudo');
    const example = h.catalog.createAdvancedExample('grey-rabbit', 'pseudo');
    const pages = Object.values(voiceStates(example)).map((state) => renderToStaticMarkup(dialog(h, state)));
    pages.push(renderToStaticMarkup(dialog(h, voiceStates(example).initial, { replacesInitialRoot: false, xttsSettings: {} })));
    pages.push(renderToStaticMarkup(React.createElement(h.ExamplesMenu, { disabled: false, onChoose: noop })));
    for (const html of pages) assert.deepEqual(outsideCatalogue(html), []);
  } finally { await h.engine.changeLanguage('fr'); await h.server.close(); }
});

test('exemples montés : menu ouvert et dialogue ouvert suivent FR → EN → IT, contenu capturé et projet intacts', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { installMountedDom, click, renderedText } = await import('./treeMountedDom.mjs');
  const dom = installMountedDom();
  const h = await examplesHarness(false, true);
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  const chosen = [];
  try {
    const { useProjectStore } = await h.load('src/store/projectStore.js');
    let store;
    const example = h.catalog.createAdvancedExample('lighthouse', 'fr');
    const state = { ...states(example, true).result, voice: { backend: 'piper', language: 'fr', voice: 'fr_FR-siwis-medium', adapted: false, status: 'ready' } };
    const snapshot = JSON.stringify(state);
    function App() {
      store = useProjectStore();
      return React.createElement(React.Fragment, null,
        React.createElement(h.ExamplesMenu, { disabled: false, onChoose: (created) => chosen.push(created) }),
        dialog(h, state));
    }
    await act(async () => root.render(React.createElement(App)));
    const project = JSON.stringify(store.readProject()); const history = store.readHistoryMark();
    const trigger = host.querySelector('.advanced-examples-trigger');
    await act(async () => click(trigger));
    const items = host.querySelectorAll('.advanced-examples-item');
    assert.equal(items.length, 5);
    const panel = dom.document.body.querySelector('.advanced-dialog');
    for (const language of ['fr', 'en', 'it']) {
      await act(async () => h.engine.changeLanguage(language));
      const t = (key, params) => h.engine.t(key, params);
      assert.equal(host.querySelector('.advanced-examples-item'), items[0], 'menu toujours ouvert, mêmes éléments');
      assert.equal(trigger.getAttribute('title'), t('examples:menu.trigger.title'));
      assert.equal(host.querySelector('.advanced-examples-list').getAttribute('aria-label'), t('examples:menu.list.ariaLabel'));
      assert.equal(items[3].querySelector('strong').textContent, t('examples:lighthouse.example.title'));
      assert.equal(items[3].querySelector('small').textContent, t('examples:menu.item.counts', {
        screens: t('examples:count.screens.label', { count: example.stages.length }), lists: t('examples:count.choiceLists.label', { count: example.actions.length }) }));
      assert.equal(dom.document.body.querySelector('.advanced-dialog'), panel, 'dialogue conservé ouvert');
      assert.equal(panel.getAttribute('aria-label'), t('examples:lighthouse.example.title'));
      const text = renderedText(panel);
      assert.ok(text.includes(t('examples:dialog.result.created', { screens: t('examples:count.screens.label', { count: example.stages.length }), lists: t('examples:count.choiceLists.label', { count: example.actions.length }) })));
      assert.ok(text.includes(t('examples:error.media.item', { name: example.stages[3].name, error: language === 'fr' ? 'Disque indisponible' : t('common:error.fallback.unexpected') })));
      if (language !== 'fr') assert.ok(text.includes(t('common:error.technicalDetails.summary')), 'cause brute repliée hors FR');
      assert.equal(JSON.stringify(state), snapshot, 'contenu de l’exemple et état inchangés');
      assert.equal(JSON.stringify(store.readProject()), project); assert.equal(store.readHistoryMark(), history);
    }
    // Choix en italien : l'exemple créé est en italien et ne change plus ensuite.
    await act(async () => click(items[3]));
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].language, 'it');
    assert.equal(chosen[0].stages[0].name, h.engine.t('examples:lighthouse.opening.entry'));
    const captured = JSON.stringify(chosen[0]);
    await act(async () => h.engine.changeLanguage('en'));
    assert.equal(JSON.stringify(chosen[0]), captured);
  } finally { await act(async () => root.unmount()); await h.engine.changeLanguage('fr'); await h.server.close(); dom.restore(); }
});
