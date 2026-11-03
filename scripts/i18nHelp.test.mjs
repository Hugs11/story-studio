import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { sources, BASE, SAVE_AS_FALLBACK } from './i18nHelpSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { checkCatalogues, HELP_NEUTRAL_KEYS, sourceHash } from './check-i18n.mjs';
import { pseudoResources, pseudoText } from '../src/i18n/pseudo.js';
import fr from '../src/locales/fr/help.json' with { type: 'json' };
import en from '../src/locales/en/help.json' with { type: 'json' };
import it from '../src/locales/it/help.json' with { type: 'json' };
import commonFr from '../src/locales/fr/common.json' with { type: 'json' };
import meta from '../src/locales/_meta/help.json' with { type: 'json' };

const resources = { fr: { help: fr }, en: { help: en }, it: { help: it } };
export async function helpHarness(original = false, mounted = false) {
  // Les suites Vite s’exécutent en parallèle ; ce banc ne partage aucun cache de transformation.
  const cacheDir = await mkdtemp(join(tmpdir(), 'story-studio-help-'));
  const server = await createServer({ cacheDir, configFile: false, plugins: [{ name: 'help-original-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0].replaceAll('\\', '/').replace(`${process.cwd().replaceAll('\\', '/')}/`, '');
    // SSR : remplacer uniquement le portail, conserver le vrai rendu des crédits.
    if (!mounted && file === 'src/components/common/AppModalPortal.jsx') return 'export function AppModalPortal({children}) { return <div>{children}</div>; }';
    return original && sources[file] ? sources[file] : code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const closeServer = server.close.bind(server);
  server.close = async () => { try { await closeServer(); } finally { await rm(cacheDir, { recursive: true, force: true }); } };
  const load = file => server.ssrLoadModule('/' + file);
  const { initializeI18n } = await load('src/i18n/index.js'); const engine = initializeI18n('fr');
  const { CreditsModal } = await load('src/components/common/CreditsModal.jsx');
  const { HelpHint } = await load('src/components/common/HelpHint.jsx');
  const { KeyboardShortcutsModal } = await load('src/components/StorySettingsModal/KeyboardShortcutsModal.jsx');
  const { ErrorDialogProvider } = await load('src/components/common/Dialog.jsx');
  const keyboard = await load('src/store/keyboardShortcuts.js');
  const { useHelpTranslation } = await load('src/i18n/helpPresentation.js');
  return { server, load, engine, CreditsModal, HelpHint, KeyboardShortcutsModal, ErrorDialogProvider, keyboard, useHelpTranslation };
}
function render(h, type) {
  const noop = () => {};
  const component = type === 'credits' ? React.createElement(h.CreditsModal, { appVersion: '_VERSION_', onClose: noop })
    : type === 'hint' ? React.createElement(h.HelpHint, { text: h.engine.t('help:keyboard.capture.instructions') })
      : React.createElement(h.KeyboardShortcutsModal, { shortcuts: h.keyboard.DEFAULT_SHORTCUTS, onClose: noop, onChange: noop });
  return renderToStaticMarkup(React.createElement(h.ErrorDialogProvider, null, component));
}
const visible = html => ({
  text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
  attributes: [...html.matchAll(/\b(title|aria-label|alt|placeholder)="([^"]*)"/g)].map(m => [m[1], m[2]]),
});
// Valeurs techniques nominatives uniquement : marques, symboles et combinaisons clavier.
export function assertPseudoValues(values) {
  const names = { marian: 'marian-m12l', jersou: 'Jersou', dantsu: 'Dantsu', daneel: 'o.Daneel', lucky: 'LuckyTheCookie', studio: 'STUdio', luniiQt: 'Lunii.QT' };
  const richFragments = new Set(pseudoText(fr['credits.thanks.message']).replace(/{{(\w+)}}/g, (_, key) => names[key]).split(/<[^>]+>/).map(v => v.trim()));
  for (const value of values.map(v => v.trim()).filter(Boolean)) {
    if (richFragments.has(value)) continue;
    if (['Story Studio', 'v_VERSION_', '?', '✕', 'marian-m12l', 'Jersou', 'Dantsu', 'o.Daneel', 'LuckyTheCookie'].includes(value)) continue;
    if (/^(?:(?:Ctrl|⌘|Shift|Alt|Meta)\+)*(?:[A-Z0-9]|F2|[+−=,;.'\[\]←→↑↓⌫-]|Home|End|Tab|Page[↑↓])$/.test(value)) continue;
    assert.ok(value.includes('['), `hors catalogue : ${value}`);
  }
}

test('aides : catalogues, paramètres, métadonnées, formes neutres et mutation FR détectée', () => {
  assert.equal(BASE, 'b7f3903925285e37cf5dd8b184ed956db93d0e31');
  assert.equal(Object.keys(fr).length, 121); // Titre de l’encadré Aide supprimé.
  assert.equal(SAVE_AS_FALLBACK, 'Enregistrer sous...');
  // Lot 4.13 : repli affiché, « ... » de la source corrigé en « … ».
  assert.equal(commonFr['project.saveAs.fallbackLabel'], SAVE_AS_FALLBACK.replace('...', '…'));
  assert.deepEqual(checkCatalogues(resources, { help: meta }).errors, []);
  for (const language of ['en', 'it']) {
    for (const [key, value] of Object.entries(resources[language].help)) {
      assert.equal(meta[key][language].sourceHash, sourceHash(fr[key])); assert.equal(meta[key][language].status, 'ai-reviewed');
      if (!HELP_NEUTRAL_KEYS[language].has(key)) assert.notEqual(value, fr[key], `${language}:${key}`);
      assert.doesNotMatch(key, /_zero$/);
    }
    const mutated = structuredClone(resources); mutated[language].help['keyboard.capture.instructions'] = fr['keyboard.capture.instructions'];
    assert.ok(checkCatalogues(mutated, { help: meta }).errors.some(e => e.includes(`${language}/help:keyboard.capture.instructions règle d’or`)));
  }
  // Les clés à paramètres reproduisent les phrases de la source indépendante.
  const original = sources['src/components/StorySettingsModal/KeyboardShortcutsModal.jsx'];
  assert.ok(original.includes('Déjà utilisé par « ${conflict.label} » dans ${scopeLabel}.'));
  // Lot 4.13 : article ajouté (« dans la section « … » »).
  assert.equal(fr['keyboard.conflict.message'], 'Déjà utilisé par « {{action}} » dans la section « {{scope}} ».');
  assert.ok(original.includes('Aucun raccourci ne correspond à « {query} ».'));
  assert.equal(fr['keyboard.search.empty'], 'Aucun raccourci ne correspond à « {{query}} ».');
  assert.ok(original.includes('Restaurer les valeurs par défaut pour « ${scope.label} »'));
  assert.equal(fr['keyboard.scope.resetTitle'], 'Restaurer les valeurs par défaut pour « {{scope}} »');
  assert.ok(original.includes('Défaut : {formatShortcut(DEFAULT_SHORTCUTS[definition.id] ?? definition.defaultShortcut)}'));
  assert.equal(fr['keyboard.shortcut.defaultLabel'], 'Défaut : {{shortcut}}');
  const credits = sources['src/components/common/CreditsModal.jsx'];
  assert.ok(credits.includes("title: 'Documentation inaccessible'"));
  assert.equal(fr['credits.documentation.errorTitle'], 'Documentation inaccessible');
  assert.ok(credits.includes('Impossible d’ouvrir la documentation dans le navigateur : ${error}'));
  assert.equal(fr['credits.documentation.errorMessage'], 'Impossible d’ouvrir la documentation dans le navigateur : {{error}}');
  const keyboard = sources['src/store/keyboardShortcuts.js'];
  for (const [code, key, value] of [['Enter', 'enter', 'Entrée'], ['Space', 'space', 'Espace'], ['Escape', 'escape', 'Échap'], ['Delete', 'delete', 'Suppr'], ['Click', 'click', 'Clic'], ['Drag', 'drag', 'Glisser']]) {
    assert.ok(keyboard.includes(`if (code === '${code}') return '${value}';`));
    assert.equal(fr[`keyboard.key.${key}`], value);
  }
  assert.ok(keyboard.includes('`${text} (${shortcutLabel})`'));
  assert.equal(fr['keyboard.tooltip.withShortcut'], '{{text}} ({{shortcut}})');
});

test('aides : équivalence FR avec git show, tables et touches résolues à la lecture, surface pseudo SSR', async () => {
  const old = await helpHarness(true);
  const baseline = {};
  let originalScopes, originalDefinitions;
  try {
    const { commandKeyLabel } = await old.load('src/utils/platformKeys.js');
    const command = commandKeyLabel();
    // Lot 6 : seule évolution FR des combinaisons, Shift+ devient Maj+.
    for (const type of ['credits', 'hint', 'shortcuts']) baseline[type] = JSON.parse(applyLot413(JSON.stringify(visible(render(old, type)))).replaceAll('Shift+', 'Maj+'));
    // Évolution voulue : retrait du titre « Aide », les accès restent directement visibles.
    assert.ok(baseline.credits.text.includes(' Aide Documentation '));
    baseline.credits.text = baseline.credits.text.replace(' Aide Documentation ', ' Documentation ');
    // LUh restores the original creator signature, already present in the git-show baseline.
    // Catalogue shortcuts: explicit additive surface, kept separate from the git-show baseline.
    baseline.shortcuts.text = baseline.shortcuts.text.replace('Navigation standard lecture seule', `Catalogue des packs Réinitialiser Actifs dans l’écran Catalogue, hors menus et fiche ouverte. Annuler la dernière modification multiple Défaut : ${command}+Z ${command}+Z Rechercher dans le catalogue Défaut : ${command}+F ${command}+F Sélectionner toutes les fiches affichées Défaut : ${command}+A ${command}+A Vider la sélection du catalogue Défaut : Échap Échap Navigation standard lecture seule`);
    baseline.shortcuts.text = baseline.shortcuts.text.replace(`Retour à l’accueil Défaut : ${command}+N`, `Retour au catalogue Défaut : ${command}+Alt+C ${command}+Alt+C Retour à l’accueil Défaut : ${command}+N`);
    baseline.shortcuts.attributes.push(['title', 'Restaurer les valeurs par défaut pour « Catalogue des packs »']);
    originalScopes = old.keyboard.SHORTCUT_SCOPES; originalDefinitions = old.keyboard.SHORTCUT_DEFINITIONS;
  } finally { await old.server.close(); }
  const h = await helpHarness();
  try {
    for (const type of ['credits', 'hint', 'shortcuts']) assert.deepEqual(visible(render(h, type)), baseline[type], type);
    for (const [current, originals] of [[h.keyboard.SHORTCUT_SCOPES, originalScopes], [h.keyboard.SHORTCUT_DEFINITIONS, originalDefinitions]]) {
      for (const entry of current) {
        const original = originals.find(o => o.id === entry.id);
        if (!original) {
          const additions = {
            returnToCatalogue: { id: 'returnToCatalogue', scope: 'general', labelKey: 'catalogue:open.return.label', defaultShortcut: { ctrl: true, alt: true, key: 'c', code: 'KeyC' } },
            catalogue: { id: 'catalogue', contexts: ['catalogue'], labelKey: 'help:scope.catalogue.label', descriptionKey: 'help:scope.catalogue.description' },
            catalogueUndo: { id: 'catalogueUndo', scope: 'catalogue', labelKey: 'catalogue:data.undo.title', defaultShortcut: { ctrl: true, key: 'z', code: 'KeyZ' } },
            catalogueSearch: { id: 'catalogueSearch', scope: 'catalogue', labelKey: 'help:shortcut.catalogueSearch.label', defaultShortcut: { ctrl: true, key: 'f', code: 'KeyF' }, aliases: [{ ctrl: true, key: 'k', code: 'KeyK' }] },
            catalogueSelectAll: { id: 'catalogueSelectAll', scope: 'catalogue', labelKey: 'help:shortcut.catalogueSelectAll.label', defaultShortcut: { ctrl: true, key: 'a', code: 'KeyA' } },
            catalogueClearSelection: { id: 'catalogueClearSelection', scope: 'catalogue', labelKey: 'help:shortcut.catalogueClearSelection.label', defaultShortcut: { key: 'Escape', code: 'Escape' } },
          };
          assert.deepEqual(entry, additions[entry.id], entry.id + ': ajout catalogue explicite');
          continue;
        }
        for (const field of ['label', 'description', 'readOnlyReason']) if (original[field]) assert.equal(h.engine.t(entry[field + 'Key']), applyLot413(original[field]), entry.id + ':' + field);
        const stripped = Object.fromEntries(Object.entries(entry).filter(([key]) => !key.endsWith('Key')));
        const oldStripped = Object.fromEntries(Object.entries(original).filter(([key]) => !['label', 'description', 'readOnlyReason'].includes(key)));
        assert.deepEqual(stripped, oldStripped, entry.id + ': contrat clavier intact');
      }
    }
    const saved = structuredClone(h.keyboard.DEFAULT_SHORTCUTS);
    const savedBefore = JSON.stringify(saved);
    const { commandKeyLabel } = await h.load('src/utils/platformKeys.js');
    const expectedSaveAs = commandKeyLabel() === '⌘'
      ? { fr: '⌘+Maj+S', en: '⌘+Shift+S', it: '⌘+Maiusc+S' }
      : { fr: 'Ctrl+Maj+S', en: 'Ctrl+Shift+S', it: 'Ctrl+Maiusc+S' };
    const labels = h.keyboard.getShortcutLabelMap(saved), tables = JSON.stringify(h.keyboard.SHORTCUT_DEFINITIONS);
    for (const language of ['fr', 'en', 'it', 'fr']) {
      await h.engine.changeLanguage(language);
      assert.equal(h.keyboard.formatShortcut(saved.saveAs), expectedSaveAs[language]);
      assert.equal(labels.saveAs, expectedSaveAs[language]);
      assert.equal(JSON.stringify(saved), savedBefore);
      assert.equal(labels.selectionDelete, h.engine.t('help:keyboard.key.delete'));
      assert.equal(h.keyboard.DEFAULT_SHORTCUT_LABELS.selectionDelete, labels.selectionDelete);
      assert.equal(JSON.stringify(h.keyboard.SHORTCUT_DEFINITIONS), tables);
    }
    const pseudo = pseudoResources({ help: fr, common: h.engine.getResourceBundle('fr', 'common') });
    for (const [ns, bundle] of Object.entries(pseudo)) h.engine.addResourceBundle('pseudo', ns, bundle);
    await h.engine.changeLanguage('pseudo');
    for (const type of ['credits', 'hint', 'shortcuts']) {
      const html = render(h, type); assert.doesNotMatch(html, /help:[a-z]+\.|\[object Object\]/);
      const values = [...html.matchAll(/>([^<>]+)</g), ...html.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map(m => m[1]);
      assertPseudoValues(values);
    }
  } finally { await h.server.close(); }
});

test('aides montées : capture, conflit, recherche et erreur déjà ouverts suivent la langue sans modifier projet/undo', async () => {
  const { act } = await import('react'); const { createRoot } = await import('react-dom/client');
  const { installMountedDom, click } = await import('./treeMountedDom.mjs');
  const dom = installMountedDom();
  dom.document.defaultView.innerWidth = 1200; dom.document.defaultView.innerHeight = 800;
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = name => { const node = createElement(name); node.offsetWidth = 100; node.offsetHeight = 40; node.matches = () => true; node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }); return node; };
  const h = await helpHarness(false, true); const calls = [];
  let rejection = { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' };
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: async (command, params) => {
    calls.push({ command, params }); assert.equal(command, 'plugin:opener|open_url'); throw rejection;
  } };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  const { useProjectStore } = await h.load('src/store/projectStore.js');
  let store; let changes = 0;
  function App() {
    store = useProjectStore(); const { t } = h.useHelpTranslation();
    return React.createElement(h.ErrorDialogProvider, null,
      React.createElement(h.CreditsModal, { appVersion: '_VERSION_', onClose() {} }),
      React.createElement(h.KeyboardShortcutsModal, { shortcuts: h.keyboard.DEFAULT_SHORTCUTS, onClose() {}, onChange() { changes++; } }),
      React.createElement(h.HelpHint, { text: t('help:keyboard.capture.instructions') }));
  }
  const props = node => node[Object.keys(node).find(key => key.startsWith('__reactProps$'))];
  const event = data => ({ preventDefault() {}, stopPropagation() {}, ...data });
  try {
    await act(async () => root.render(React.createElement(App)));
    const project = JSON.stringify(store.readProject()), history = store.readHistoryMark();
    const tables = JSON.stringify([h.keyboard.SHORTCUT_SCOPES, h.keyboard.SHORTCUT_DEFINITIONS]);
    const capture = host.querySelector('.keyboard-shortcut-capture');
    await act(async () => click(capture));
    assert.equal(capture.textContent, h.engine.t('help:keyboard.capture.waiting'));
    await act(async () => props(capture).onKeyDown(event({ key: 'o', code: 'KeyO', ctrlKey: true })));
    assert.equal(changes, 0);
    const message = host.querySelector('.keyboard-shortcuts-message'); assert.ok(message);
    await act(async () => click(dom.document.body.querySelector('.credits-documentation-link')));
    const dialog = dom.document.body.querySelector('.dialog-panel'); assert.ok(dialog);
    assert.equal(dialog.querySelector('details').getAttribute('open'), null);
    assert.equal(dialog.querySelector('pre').textContent, '_RAW_TOOL_');
    const search = host.querySelector('input');
    for (const language of ['fr', 'en', 'it']) {
      await act(async () => h.engine.changeLanguage(language));
      assert.equal(dom.document.body.querySelector('.dialog-panel'), dialog);
      assert.equal(host.querySelector('.keyboard-shortcut-capture'), capture);
      assert.equal(capture.textContent, h.engine.t('help:keyboard.capture.waiting'));
      assert.equal(message.textContent, h.engine.t('help:keyboard.conflict.message', { action: h.engine.t('help:shortcut.openProject.label'), scope: h.engine.t('help:scope.general.label') }));
      assert.ok(dialog.textContent.includes(h.engine.t('help:credits.documentation.errorTitle')));
      assert.ok(dialog.textContent.includes(h.engine.t('help:credits.documentation.errorMessage', { error: h.engine.t('rust:COMFYUI_SERVICE_ERROR') })));
      assert.equal(search.getAttribute('placeholder'), h.engine.t('help:keyboard.search.placeholder'));
      assert.equal(host.querySelector('.help-hint').getAttribute('aria-label'), h.engine.t('help:keyboard.capture.instructions'));
      assert.equal(JSON.stringify(store.readProject()), project); assert.equal(store.readHistoryMark(), history);
      assert.equal(JSON.stringify([h.keyboard.SHORTCUT_SCOPES, h.keyboard.SHORTCUT_DEFINITIONS]), tables);
      assert.equal(changes, 0);
    }
    assert.deepEqual(calls, [{ command: 'plugin:opener|open_url', params: { url: 'https://hugs11.github.io/story-studio/docs/', with: undefined } }]);
    // Recherche réellement filtrée sur la traduction active ; la saisie reste une donnée utilisateur.
    await act(async () => props(search).onChange({ target: { value: 'Save the project' } }));
    assert.ok(host.querySelector('.keyboard-shortcuts-empty'));
    await act(async () => h.engine.changeLanguage('en'));
    assert.equal(host.querySelector('.keyboard-shortcuts-empty'), null);
    assert.ok(host.textContent.includes('Save the project'));
    await act(async () => props(search).onChange({ target: { value: '' } }));
    // Un échec brut n’est jamais interpolé dans la phrase ; diagnostic sous details fermé.
    await act(async () => click(dialog.querySelectorAll('button').find(b => b.textContent === h.engine.t('common:dialog.close.label'))));
    rejection = { raw: '_RAW_OBJECT_' };
    await act(async () => click(dom.document.body.querySelector('.credits-documentation-link')));
    const rawDialog = dom.document.body.querySelector('.dialog-panel');
    assert.equal(rawDialog.querySelector('details').getAttribute('open'), null);
    assert.ok(rawDialog.querySelector('pre').textContent.includes('_RAW_OBJECT_'));
    assert.doesNotMatch(rawDialog.textContent, /\[object Object\]|COMFYUI_SERVICE_ERROR/);
    assert.ok(rawDialog.textContent.includes(h.engine.t('common:error.fallback.unexpected')));
    // Pseudo-locale sur la surface montée : capture, conflit, vide, aria, title et infobulle ouverte.
    for (const [ns, bundle] of Object.entries(pseudoResources({ help: fr, common: h.engine.getResourceBundle('fr', 'common') }))) h.engine.addResourceBundle('pseudo', ns, bundle);
    await act(async () => h.engine.changeLanguage('pseudo'));
    const hint = host.querySelector('.help-hint');
    await act(async () => { props(hint).onFocus({ currentTarget: hint }); await new Promise(resolve => setTimeout(resolve, 650)); });
    const bubble = dom.document.body.querySelector('.tooltip-bubble'); assert.ok(bubble);
    assert.equal(bubble.textContent, h.engine.t('help:keyboard.capture.instructions'));
    assertPseudoValues([host.querySelector('.keyboard-shortcut-capture').textContent, message.textContent, search.getAttribute('placeholder'), hint.getAttribute('aria-label'), bubble.textContent]);
    await act(async () => props(search).onChange({ target: { value: '_AUTHOR_QUERY_' } }));
    const empty = host.querySelector('.keyboard-shortcuts-empty'); assert.equal(empty.textContent, h.engine.t('help:keyboard.search.empty', { query: '_AUTHOR_QUERY_' }));
    assert.equal(JSON.stringify(store.readProject()), project); assert.equal(store.readHistoryMark(), history); assert.equal(changes, 0);
  } finally { await act(async () => root.unmount()); await h.server.close(); dom.restore(); }
});

test('aides : actions et menus graphe/arbre/diagramme déjà créés relisent les raccourcis FR → EN → IT', async () => {
  const { act } = await import('react'); const { createRoot } = await import('react-dom/client');
  const { installMountedDom } = await import('./treeMountedDom.mjs');
  const dom = installMountedDom(); dom.document.defaultView.innerWidth = 1200; dom.document.defaultView.innerHeight = 800;
  const h = await helpHarness(false, true);
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { buildGraphContextActions, buildGraphSurfaceActions } = await h.load('src/components/AdvancedWorkspace/graphContextMenuActions.jsx');
    const { buildTreeContextActions } = await h.load('src/components/TreePanel/treeContextMenuActions.jsx');
    const { buildDiagramContextActions } = await h.load('src/components/diagram/diagram/diagramContextMenu.jsx');
    const { ContextMenu } = await h.load('src/components/TreePanel/ContextMenu.jsx');
    let calls = 0; const noop = () => { calls++; };
    const inspected = { kind: 'stage', path: '_PATH_', node: { squareOne: { presence: 'value', value: false } } };
    const defaults = h.keyboard.getShortcutLabelMap(h.keyboard.DEFAULT_SHORTCUTS);
    const defaultAction = buildGraphContextActions({ inspected, onDelete: noop, shortcutLabels: defaults }).find(a => a.danger);
    // Chaque copie équivalente est éprouvée avec une touche localisable, même si
    // son défaut habituel est une combinaison neutre telle que Ctrl+C.
    const shortcuts = Object.fromEntries(h.keyboard.SHORTCUT_DEFINITIONS.map(d => [d.id, { key: 'Delete', code: 'Delete' }]));
    const shortcutLabels = h.keyboard.getShortcutLabelMap(shortcuts);
    const project = { rootEntries: [{ id: 'z', type: 'zip', name: '_AUTHOR_' }], globalOptions: {} };
    const clipboardRef = { current: { entries: [{ id: 'copy', type: 'zip', name: '_AUTHOR_COPY_' }], isCut: false } };
    const common = { project, nodeId: 'z', nodeType: 'zip', selectedIds: new Set(['z']), clipboardRef,
      getEntry: () => project.rootEntries[0], getParentId: () => null, getTopLevelSelected: () => ['z'],
      handleCopy: noop, handleCut: noop, handlePaste: noop, onDuplicate: noop, onDeleteItem: noop,
      handleDeleteSelection: noop, shortcutLabels };
    const groups = [
      buildGraphContextActions({ inspected, onCopy: noop, onCut: noop, onDuplicate: noop, onDelete: noop, shortcutLabels }),
      buildGraphSurfaceActions({ graphPoint: { x: 1, y: 2 }, onCreateStage: noop, onCreateAction: noop, onPaste: noop, clipboard: { stages: [{}] }, shortcutLabels }),
      buildTreeContextActions({ ...common, projectType: 'pack' }),
      buildDiagramContextActions(common),
    ].map(actions => actions.filter(a => a && typeof a === 'object' && Object.hasOwn(a, 'shortcut')));
    assert.deepEqual(groups.map(a => a.length), [4, 3, 5, 5]);
    const actions = groups.flat();
    for (const action of actions) assert.equal(typeof Object.getOwnPropertyDescriptor(action, 'shortcut').get, 'function');
    const before = JSON.stringify({ project, shortcuts, clipboard: clipboardRef.current });
    await act(async () => root.render(React.createElement(React.Fragment, null, ...groups.map((group, i) =>
      React.createElement(ContextMenu, { key: i, x: 10, y: 10, onClose: noop, actions: group })))));
    const menus = host.querySelectorAll('.ctx-menu'); const keys = host.querySelectorAll('kbd');
    assert.equal(menus.length, 4); assert.equal(keys.length, 17);
    for (const [language, expected] of [['fr', 'Suppr'], ['en', 'Delete'], ['it', 'Canc']]) {
      await act(async () => h.engine.changeLanguage(language));
      assert.equal(defaultAction.shortcut, expected);
      assert.equal(defaultAction.label, h.engine.t('graph:action.menu.remove'));
      for (const action of actions) assert.equal(action.shortcut, expected);
      assert.deepEqual(host.querySelectorAll('.ctx-menu'), menus);
      assert.deepEqual(host.querySelectorAll('kbd'), keys);
      for (const key of keys) assert.equal(key.textContent, expected);
      if (language !== 'fr') assert.ok(keys.every(key => !key.textContent.includes('Suppr')));
      assert.equal(JSON.stringify({ project, shortcuts, clipboard: clipboardRef.current }), before);
      assert.equal(calls, 0);
    }
  } finally { await act(async () => root.unmount()); await h.server.close(); dom.restore(); }
});
