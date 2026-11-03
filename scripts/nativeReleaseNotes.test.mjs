import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { RELEASE_NOTES } from '../src/config/releaseNotes.js';

// Simuler les notes embarquées avant l'arrivée des traductions, sans modifier
// leur règle d'affichage. Le seul paramètre remplacé est la version du contenu.
const historicalConfig = readFileSync(new URL('../src/config/releaseNotes.js', import.meta.url), 'utf8')
  .replace("from 'i18next'", `from '${import.meta.resolve('i18next')}'`)
  .replace(/version: '[^']+'/, "version: '0.9.9'");
const historicalConfigUrl = `data:text/javascript;base64,${Buffer.from(historicalConfig).toString('base64')}`;
registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/components/common/ReleaseNotesModal.jsx?historical')) {
    const loaded = next(url.replace('?historical', ''), context);
    return { ...loaded, source: String(loaded.source)
      .replace(/(['"])\.\.\/\.\.\/config\/releaseNotes\1/, `'${historicalConfigUrl}'`) };
  }
  if (url.endsWith('/src/components/common/AppModalPortal.jsx')) {
    return { format: 'module', source: 'export function AppModalPortal({ children }) { return children; }', shortCircuit: true };
  }
  return next(url, context);
} });
const { ReleaseNotesModal } = await import('../src/components/common/ReleaseNotesModal.jsx');
const { ReleaseNotesModal: HistoricalReleaseNotesModal } = await import('../src/components/common/ReleaseNotesModal.jsx?historical');

test('fenêtre réelle : version courante traduite ; notes antérieures à 0.9.10 en FR uniquement', async () => {
  await i18next.init(createTestI18n().options);
  const render = (appVersion, Component = ReleaseNotesModal) => mountSurface(createElement(I18nextProvider, { i18n: i18next },
    createElement(Component, { appVersion }))).html;
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const html = render(RELEASE_NOTES.version);
    assert.ok(html.includes(i18next.t('common:releaseNotes.header.title', { version: RELEASE_NOTES.version })));
    assert.ok(!html.includes('release-notes-letter'), 'le bloc personnel est retiré');
    assert.equal((html.match(/release-notes-badge--fix/g) ?? []).length, 1, 'une seule ligne globale de correctifs');
    for (const key of [...RELEASE_NOTES.highlights.flat(), ...RELEASE_NOTES.fixes.flat(), ...RELEASE_NOTES.chores.flat()]) {
      assert.ok(html.includes(i18next.t(key)), `${language} ${key}`);
    }
    assert.equal(render('0.9.8'), '');
    assert.equal(render('0.9.9'), '');
    assert.equal(render('0.9.10-beta.1'), '');
    const historical = render('0.9.9', HistoricalReleaseNotesModal);
    if (language === 'fr') assert.ok(historical.includes(i18next.t(RELEASE_NOTES.highlights[0][0])));
    else assert.equal(historical, '');
  }
});
