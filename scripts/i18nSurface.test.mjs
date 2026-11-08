import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { createTestI18n } from './i18nTestSetup.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { installMountedDom, click } from './treeMountedDom.mjs';

async function languageOptions(InterfaceSection, instance) {
  const dom = installMountedDom();
  dom.document.defaultView.innerWidth = 1280;
  dom.document.defaultView.innerHeight = 900;
  dom.document.getElementById = id => dom.document.body.querySelectorAll('*').find(node => node.getAttribute('id') === id) ?? null;
  const create = dom.document.createElement.bind(dom.document);
  dom.document.createElement = name => {
    const element = create(name);
    element.offsetWidth = 180; element.scrollHeight = 240;
    element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 180, bottom: 30, width: 180, height: 30 });
    return element;
  };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: instance }, React.createElement(InterfaceSection, { themePreference: 'system' }))));
    const trigger = host.querySelector('#ui-language');
    assert.equal(trigger.getAttribute('role'), 'combobox');
    await act(async () => click(trigger));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    return dom.document.body.querySelectorAll('.select-option').map(node => node.textContent);
  } finally { await act(async () => root.unmount()); dom.restore(); }
}

// Rendre les vrais composants sans ouvrir de port ni dépendre d'un navigateur.
for (const development of [true, false]) {
  test(`surface pilote raccordée, sélecteur ${development ? 'visible en développement' : 'visible en production'}`, async () => {
    const server = await createServer({
      configFile: false, plugins: [react()],
      define: { 'import.meta.env.DEV': String(development) },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    });
    try {
      const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
      const { InterfaceSection } = await server.ssrLoadModule('/src/tabs/OptionsTab/InterfaceSection.jsx');
      const { OptionsSectionNav, OPTION_SECTION_IDS } = await server.ssrLoadModule('/src/tabs/OptionsTab/OptionsSectionNav.jsx');
      const engine = await server.ssrLoadModule('/src/i18n/index.js');
      const languageHelpers = await server.ssrLoadModule('/src/i18n/language.js');
      assert.deepEqual(languageHelpers.AVAILABLE_LANGUAGES, development ? ['fr', 'en', 'it', 'pseudo'] : ['fr', 'en', 'it']);
      assert.equal(languageHelpers.resolveLanguage({ systemLanguage: 'en-US' }), 'en');
      assert.equal(languageHelpers.resolveLanguage({ preference: 'it' }), 'it');
      const runtime = engine.initializeI18n('fr');
      const oldStorage = globalThis.localStorage;
      const values = new Map();
      const writes = [];
      globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { writes.push([key, value]); values.set(key, value); },
      };
      try {
        assert.equal(languageHelpers.loadLanguage('en-US'), 'en');
        assert.deepEqual(writes, [['storyStudio.uiLanguage', 'en']]);
        values.clear();
        writes.length = 0;
        values.set('storyStudio.uiLanguage', 'it');
        assert.equal(languageHelpers.loadLanguage('en-US'), 'it');
        assert.deepEqual(writes, []);
        await languageHelpers.changeUiLanguage('en');
        assert.deepEqual(writes, [['storyStudio.uiLanguage', 'en']]);
        const beforePseudo = [...writes];
        await languageHelpers.changeUiLanguage('pseudo');
        assert.deepEqual(writes, beforePseudo);
      } finally {
        globalThis.localStorage = oldStorage;
      }
      assert.equal(runtime.isInitialized, true);
      assert.equal(runtime.options.initAsync, false);
      assert.equal(runtime.options.returnNull, false);
      assert.equal(runtime.options.interpolation.escapeValue, false);
      assert.deepEqual(runtime.options.fallbackLng, ['en']);
      await languageHelpers.changeUiLanguage('en');
      assert.equal(languageHelpers.getIntlLocale(), 'en-US');
      await languageHelpers.changeUiLanguage('it');
      assert.equal(languageHelpers.getIntlLocale(), 'it-IT');
      await languageHelpers.changeUiLanguage('pseudo');
      assert.equal(runtime.language, development ? 'pseudo' : 'en');
      assert.equal(languageHelpers.getIntlLocale(), development ? 'fr-FR' : 'en-US');
      assert.equal(runtime.hasResourceBundle('pseudo', 'settings'), development);
      if (development) assert.match(runtime.t('settings:interface.theme.label'), /^\[.*\]$/);
      const instance = createTestI18n();
      const frenchResources = instance.options.resources.fr;
      for (const [namespace, catalogue] of Object.entries(pseudoResources(frenchResources))) instance.addResourceBundle('pseudo', namespace, catalogue);
      const render = () => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: instance },
        React.createElement(ErrorDialogProvider, null,
          React.createElement(InterfaceSection, { themePreference: 'system' }),
          React.createElement(OptionsSectionNav, { activeSectionId: 'interface' }),
        ),
      ));
      for (const [language, theme, edit, nav] of [
        ['fr', 'Thème', 'Modifier', 'Sections des Préférences'],
        ['en', 'Theme', 'Edit', 'Preferences sections'],
        ['it', 'Tema', 'Modifica', 'Sezioni delle Preferenze'],
      ]) {
        await instance.changeLanguage(language);
        const html = render();
        assert.ok(html.includes(theme));
        assert.ok(html.includes(`>${edit}</button>`));
        assert.ok(html.includes(`aria-label="${nav}"`));
        assert.equal(html.includes('id="ui-language"'), true);
        const options = await languageOptions(InterfaceSection, instance);
        const languageKeys = { fr: 'french', en: 'english', it: 'italian', pseudo: 'pseudo' };
        assert.deepEqual(options, languageHelpers.AVAILABLE_LANGUAGES.map(value => instance.t(`settings:interface.language.${languageKeys[value]}`)));
        assert.equal(options.includes(instance.t('settings:interface.language.pseudo')), development);
        {
          const count = languageHelpers.AVAILABLE_LANGUAGES.filter((value) => value !== 'pseudo').length;
          assert.ok(html.includes(instance.t('settings:interface.language.availableCount', { count })));
          assert.equal(options.length, languageHelpers.AVAILABLE_LANGUAGES.length);
        }
        assert.doesNotMatch(html, /settings:|common:/);
        {
          for (const label of ['Français', 'English', 'Italiano']) assert.ok(options.includes(label));
        }
      }
      await instance.changeLanguage('fr');
      const frenchHtml = render();
      for (const text of ['« Système » suit l’apparence configurée dans Windows, Linux et macOS.', 'Ouvrir les réglages quand on sélectionne un élément', 'Voir et modifier les raccourcis de l’application', 'Intelligence artificielle', 'YouTube (yt-dlp)']) assert.ok(frenchHtml.includes(text));
      await instance.changeLanguage('pseudo');
      assert.ok(render().includes('[Môdïfïër'));
      assert.deepEqual(OPTION_SECTION_IDS, ['save', 'interface', 'catalogue', 'media-subscriptions', 'projects-media', 'xtts', 'comfyui', 'advanced', 'youtube', 'diagnostic']);
    } finally {
      await server.close();
    }
  });
}

test('AdvancedGraphCanvas présente vraiment le rejet du codec via UserMessage', async () => {
  const server = await createServer({ configFile: false,
    plugins: [{ name: 'rejected-view-fixture', transform(_code, id) {
      if (id.endsWith('/useAdvancedGraphView.js')) return `export function useAdvancedGraphView() { return { status: 'failed', error: { code: 'VALIDATION_FIELD_MISSING_MASCULINE', params: { label: { code: 'LABEL_PROJECT_ROOT_AUDIO', params: {} } } } }; }`;
    } }, react()], optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  try {
    const { default: Canvas } = await server.ssrLoadModule('/src/components/AdvancedGraphCanvas/AdvancedGraphCanvas.jsx');
    for (const [language, expected] of [['fr', 'Audio racine manquant.'], ['en', 'Missing: Top menu audio.'], ['it', 'Elemento mancante: Audio del menu iniziale.']]) {
      const engine = createTestI18n();
      await engine.changeLanguage(language);
      const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Canvas, { payload: '{}' })));
      assert.ok(html.includes(expected), html);
      assert.doesNotMatch(html, /\[object Object\]|&quot;code&quot;/);
    }
  } finally { await server.close(); }
});
