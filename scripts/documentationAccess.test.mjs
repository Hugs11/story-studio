import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mountSurface } from './chromeBench.mjs';
import { createElement } from 'react';
import frHelp from '../src/locales/fr/help.json' with { type: 'json' };
import { register } from 'node:module';
register('./nodeSourceResolver.mjs', import.meta.url);
const { ErrorDialogProvider } = await import('../src/components/common/Dialog.jsx');
const { ModeSelector } = await import('../src/components/ModeSelector/ModeSelector.jsx');
const { TitleBar } = await import('../src/components/layout/TitleBar.jsx');

const creditsSource = await readFile(
  new URL('../src/components/common/CreditsModal.jsx', import.meta.url),
  'utf8',
);
const modeSelectorSource = await readFile(
  new URL('../src/components/ModeSelector/ModeSelector.jsx', import.meta.url),
  'utf8',
);
const appShellSource = await readFile(
  new URL('../src/components/AppShell.jsx', import.meta.url),
  'utf8',
);
const defaultCapability = JSON.parse(await readFile(
  new URL('../src-tauri/capabilities/default.json', import.meta.url),
  'utf8',
));

test('la modale À propos route la documentation selon le runtime', () => {
  assert.match(
    creditsSource,
    /const DOCUMENTATION_URL = 'https:\/\/hugs11\.github\.io\/story-studio\/docs\/'/,
  );
  assert.match(creditsSource, /if \(!isTauriRuntime\(\)\) return;/);
  assert.match(creditsSource, /await openUrl\(DOCUMENTATION_URL\);/);
  assert.match(creditsSource, /href=\{DOCUMENTATION_URL\}/);
  assert.match(creditsSource, /target="_blank"/);
  assert.match(creditsSource, /rel="noopener noreferrer"/);
  assert.match(creditsSource, /translateHelp\('help:credits\.documentation\.errorTitle'\)/);
  // Même attente française : sa source est désormais le catalogue, vérifié au rendu dans i18nHelp.test.mjs.
  assert.match(frHelp['credits.documentation.errorTitle'], /Documentation inaccessible/);
});

test('le bouton d’aide et la permission opener restent accessibles', () => {
  const { html } = mountSurface(createElement(TitleBar, { onOpenCredits() {} }));
  assert.match(html, /aria-label="Aide et à propos"/);
  assert.ok(defaultCapability.permissions.includes('opener:default'));
});

test('l’accueil propose un accès direct à la documentation', () => {
  assert.match(
    modeSelectorSource,
    /const DOCUMENTATION_URL = 'https:\/\/hugs11\.github\.io\/story-studio\/docs\/'/,
  );
  assert.match(modeSelectorSource, /await openUrl\(DOCUMENTATION_URL\);/);
  assert.match(modeSelectorSource, /href=\{DOCUMENTATION_URL\}/);
  assert.match(mountSurface(createElement(ErrorDialogProvider, null, createElement(ModeSelector, { onSelect() {} }))).html, />Documentation<\/span>/);
});

test('l’accueil présente les menus puis le graphe puis le simplifié', () => {
  const html = mountSurface(createElement(ErrorDialogProvider, null, createElement(ModeSelector, { onSelect() {} }))).html;
  const simple = html.indexOf('Éditeur simplifié');
  const menus = html.indexOf('Éditeur par menus');
  const graph = html.indexOf('Éditeur graphe');
  assert.ok(menus >= 0 && graph > menus && simple > graph);
  assert.doesNotMatch(html, />Éditeur libre</);
  assert.match(modeSelectorSource, /onClick:\s*onSelectGraph/);
  assert.match(
    appShellSource,
    /onStartAdvancedProject=\{workspace\.onStartAdvancedProject\}/,
  );
});
