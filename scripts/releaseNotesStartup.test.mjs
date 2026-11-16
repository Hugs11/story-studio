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

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/components/common/AppModalPortal.jsx')) {
    return { format: 'module', source: 'export function AppModalPortal({ children }) { return children; }', shortCircuit: true };
  }
  return next(url, context);
} });
const { ReleaseNotesModal } = await import('../src/components/common/ReleaseNotesModal.jsx');
const { KEYS } = await import('../src/store/persistentSettings.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const version = RELEASE_NOTES.version;
const mount = (props) => mountSurface(createElement(I18nextProvider, { i18n: i18next },
  createElement(ReleaseNotesModal, { appVersion: version, ...props }))).html;
const titleHtml = () => i18next.t('common:releaseNotes.header.title', { version });

test('premier lancement : l\'instance racine s\'ouvre seule, celle d\'AppModals (autoOpen=false) jamais', async () => {
  await i18next.init(createTestI18n().options);
  await i18next.changeLanguage('fr');
  memory.clear();
  // Catalogue au démarrage + Crédits ouvert : les deux instances existent, une seule est visible.
  const root = mount({});
  const inAppModals = mount({ autoOpen: false });
  assert.ok(root.includes(titleHtml()), 'ouverture automatique à la racine, sans AppShell');
  assert.equal(inAppModals, '', 'AppModals ne rouvre jamais seul, même si la clé n\'est pas encore écrite');
  // Passage Catalogue -> Accueil avant fermeture : AppModals est remonté, la clé est toujours absente.
  assert.equal(memory.get(KEYS.RELEASE_NOTES_SEEN), undefined);
  assert.equal(mount({ autoOpen: false }), '', 'pas de seconde ouverture automatique au remontage');
});

test('réouverture depuis Crédits : forceOpen affiche la fenêtre, avec la clé déjà écrite', async () => {
  memory.set(KEYS.RELEASE_NOTES_SEEN, version);
  assert.equal(mount({}), '', 'une fois vue, plus d\'ouverture automatique');
  assert.equal(mount({ autoOpen: false }), '');
  assert.ok(mount({ autoOpen: false, forceOpen: true }).includes(titleHtml()));
});

test('câblage : un seul montage automatique à la racine de App, AppModals en réouverture manuelle', () => {
  const app = read('../src/App.jsx');
  const root = app.slice(app.indexOf('export default function App()'));
  assert.match(root, /<AppContent \/>[\s\S]*<ReleaseNotesStartup \/>/);
  assert.equal(app.match(/<ReleaseNotesStartup/g).length, 1);
  const modals = read('../src/components/AppModals.jsx');
  assert.equal(modals.match(/<ReleaseNotesModal/g).length, 1);
  assert.match(modals, /<ReleaseNotesModal[^>]*autoOpen=\{false\}[^>]*forceOpen=\{modals\.isOpen\('releaseNotes'\)\}/);
});
