import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { sources, BASE, originalSettings } from './i18nSettingsSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { commandKeyLabel } from '../src/utils/platformKeys.js';
import { checkCatalogues, SETTINGS_NEUTRAL_KEYS, sourceHash } from './check-i18n.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import fr from '../src/locales/fr/settings.json' with { type: 'json' };
import en from '../src/locales/en/settings.json' with { type: 'json' };
import it from '../src/locales/it/settings.json' with { type: 'json' };
import meta from '../src/locales/_meta/settings.json' with { type: 'json' };

const resources = { fr: { settings: fr }, en: { settings: en }, it: { settings: it } };
function assertSurface(html) {
  assert.doesNotMatch(html, /(?:settings|native|ai):[a-z]+\.|\[object Object\]/);
  const technical = new Set(['http://127.0.0.1:8188', 'http://127.0.0.1:8020', 'story-studio.log', 'CPU', 'GPU CUDA', 'Piper', 'XTTS', 'yt-dlp', '_RAW_TOOL_', 'Ctrl+S', 'Ctrl+Màj+S', 'Ctrl+Shift+S']);
  const values = [...html.matchAll(/>([^<>]+)</g), ...html.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map(m => m[1].trim());
  for (const value of values) if (/\p{L}{2}/u.test(value) && !technical.has(value) && !value.includes('_AUTHOR_')) assert.ok(value.includes('[') || /[ëïüôà]/.test(value), `hors catalogue : ${value}`);
}
const plain = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
async function server(original = false) {
  return createServer({ configFile: false, plugins: [{ name: 'settings-source-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    // Le banc i18n SSR inspecte tous les libellés, y compris les options masquées.
    // Le vrai Select ouvert et son clavier sont couverts par selectMigrationD1.test.mjs.
    if (id.endsWith('/common/Select.jsx')) return `import { createElement } from 'react';
      export function Select({ options, value, onChange, ...props }) {
        return createElement('select', { ...props, value, onChange }, options.map(option =>
          createElement('option', { key: option.value, value: option.value, disabled: option.disabled }, option.label)));
      }`;
    if (id.endsWith('/NodeEditorContent.jsx')) return 'export function NodeEditorContent() { return null; }';
    if (id.endsWith('/EndNodeEditor.jsx')) return 'import { createElement } from "react"; export function EndNodeEditor({endNodeName}) { return createElement("span", null, endNodeName); }';
    if (id.endsWith('/useProjectMediaDirectory.js')) return 'export function useProjectMediaDirectory() { return "/_AUTHOR_IMPORT_"; }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

test('réglages : parité, hashes, statuts préservés et mutation de fuite FR', () => {
  assert.equal(BASE, 'ac718abdd13b6fdb4a3e78ee56c945815d360156');
  assert.deepEqual(checkCatalogues(resources, { settings: meta }).errors, []);
  for (const language of ['en', 'it']) {
    for (const [key, value] of Object.entries(resources[language].settings)) {
      assert.equal(meta[key][language].sourceHash, sourceHash(fr[key]));
      if (!SETTINGS_NEUTRAL_KEYS.has(key)) assert.notEqual(value, fr[key], `${language}:${key}`);
    }
    const mutated = structuredClone(resources); mutated[language].settings['save.auto.description'] = fr['save.auto.description'];
    assert.ok(checkCatalogues(mutated, { settings: meta }).errors.some(e => e.includes(`${language}/settings:save.auto.description règle d’or`)));
  }
  // Valeurs EN/IT actualisées par la fusion de traduction ; la fixture BASE reste intacte.
  const updatedTargetExpectations = {
    en: { 'interface.selection.label': 'Open settings when you select a node' },
    it: {
      'interface.selection.label': 'Apri le impostazioni quando selezioni un nodo',
      'interface.language.availableCount_many': '{{count}} di lingue disponibili',
    },
  };
  // Lot 4.13 : valeurs FR corrigées volontairement (typographie, vocabulaire, raccourcis paramétrés),
  // listées au rapport du lot ; la fixture BASE reste intacte.
  const lot413 = {
    "interface.theme.description": "« Système » suit l’apparence configurée dans Windows, Linux et macOS.",
    "interface.selection.label": "Ouvrir les réglages quand on sélectionne un élément",
    "interface.selection.description": "Dans les trois éditeurs (Simplifié, par menus, Graphe) : un clic dans l’arbre, le diagramme, la liste ou le graphe rouvre les Réglages ou l’Inspecteur s’ils sont fermés.",
    "interface.shortcuts.description": "Voir et modifier les raccourcis de l’application",
    "navigation.sections.label": "Sections des Préférences",
    "preferences.home.action": "Retour à l’accueil",
    "images.start.progress": "Démarrage de ComfyUI en cours… (peut prendre jusqu’à 3 minutes)",
    "images.section.title": "Génération d’images IA — ComfyUI",
    "images.enable.label": "Activer la génération d’images IA",
    "images.enable.description": "Ajoute un bouton « Générer avec l’IA (ComfyUI) » sous chaque image dans l’éditeur.",
    "images.import.title": "Importer un workflow personnalisé",
    "diagnostic.verbose.description": "Enregistre les événements normaux (chargements, enregistrements, générations) dans le fichier de log, en plus des erreurs. Utile pour partager le contexte d’un bug dans une issue GitHub. Désactivé : seuls les avertissements et erreurs sont enregistrés.",
    "projects.workspace.label": "Utiliser l’emplacement de travail pour les nouveaux projets",
    "projects.location.progress": "Emplacement de travail en cours de résolution…",
    "save.auto.description": "Activé par défaut : enregistre le projet toutes les 5 minutes si des modifications sont en attente. Un projet jamais enregistré est copié dans le dossier sauvegardes/ de l’emplacement de travail.",
    "xtts.cpu.description": "XTTS s’exécute sur CPU — plus lent (~3×) mais libère le GPU pour ComfyUI.",
    "youtube.help.description": "Le parcours guidé « Pack depuis YouTube » télécharge automatiquement yt-dlp au premier usage et le garde à jour, ainsi que le moteur JavaScript Deno (environ 40 Mo) dont yt-dlp a besoin pour lire YouTube de façon fiable. Comme YouTube bloque les versions périmées, ces réglages ne servent qu’en cas de problème.",
    "youtube.update.description": "Force le téléchargement de la dernière version de yt-dlp et installe le moteur JavaScript s’il manque. Utile si un import échoue avec un message de version obsolète.",
    "xtts.device.fallback": "périphérique inconnu",
    "end.remove.title": "Supprimer le message de fin ?",
    "save.shortcuts.description": "Raccourcis : <save>{{save}}</save> pour enregistrer, <saveAs>{{saveAs}}</saveAs> pour enregistrer sous",
    "youtube.path.description": "Laisse vide pour utiliser la version gérée automatiquement. Renseigne le chemin complet d’un exécutable <windows>yt-dlp.exe</windows> sous Windows ou <unix>yt-dlp</unix> sous Linux/macOS pour l’utiliser à la place (le téléchargement auto est alors ignoré).",
  };
  for (const [key, value] of Object.entries(lot413)) assert.equal(fr[key], value, `lot 4.13 ${key}`);
  const exceptions = new Set(['interface.theme.description', 'interface.selection.description', ...Object.keys(lot413)]);
  for (const [key, value] of Object.entries(originalSettings.fr)) {
    if (!exceptions.has(key)) {
      assert.equal(fr[key], value, key);
      for (const language of ['en', 'it']) if (key in originalSettings[language]) {
        assert.equal(resources[language].settings[key], updatedTargetExpectations[language]?.[key] ?? originalSettings[language][key]);
        const expectedTargetMeta = Object.hasOwn(updatedTargetExpectations[language], key)
          ? { ...originalSettings._meta[key][language], status: 'ai-reviewed' }
          : originalSettings._meta[key][language];
        assert.deepEqual(meta[key][language], expectedTargetMeta);
      }
    }
  }
  assert.ok(Object.keys(fr).every(key => !key.endsWith('_zero')));
  assert.equal(fr['interface.theme.description'], '« Système » suit l’apparence configurée dans Windows, Linux et macOS.');
  assert.equal(fr['interface.selection.description'], "Dans les trois éditeurs (Simplifié, par menus, Graphe) : un clic dans l’arbre, le diagramme, la liste ou le graphe rouvre les Réglages ou l’Inspecteur s’ils sont fermés.");
  assert.equal(fr['projects.location.progress'], 'Emplacement de travail en cours de résolution…');
  assert.equal(fr['projects.consolidate.progress'], 'Consolidation…');
  assert.equal(fr['consolidate.start.progress'], 'Consolidation du projet…');
});

test('réglages : rendu FR comparé à BASE et surface pseudo, attributs inclus', async () => {
  const current = await server(), original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values);
    const scenarios = [
      ['AdvancedSection', {}], ['SaveSection', { autoSaveEnabled: true, autoSaveBackupLimit: 5 }],
      ['SaveSection', { autoSaveEnabled: false }], ['DiagnosticSection', {}],
      ['ProjectsMediaSection', { project: { projectType: 'pack' } }],
      ['ProjectsMediaSection', { displayedWorkspaceDir: '/_AUTHOR_WORKSPACE_', project: {} }],
      ['VoiceSection', { xttsSettings: { backend: 'piper' } }],
      ['VoiceSection', { xttsSettings: { backend: 'xtts', serverUrl: '', xttsDir: '', language: 'fr', favoriteVoices: [] } }],
      ['AiImagesSection', { sdSettings: { aiImageGen: true } }], ['AiImagesSection', { sdSettings: { aiImageGen: false } }],
      ['YoutubeSection', {}],
      ...['idle', 'loading', 'error', 'ok'].map(state => ['PiperVoiceSettings', { piperVoices: [{ id: '_AUTHOR_VOICE_', label: '_AUTHOR_VOICE_', language: 'fr_FR', installed: false }], piperLanguage: 'fr_FR', piperVoice: '_AUTHOR_VOICE_', piperSpeed: 1, piperProvision: { state, message: '' } }]),
      ...[[], ['_AUTHOR_VOICE_'], ['_AUTHOR_VOICE_', '_AUTHOR_VOICE2_']].map(favorites => ['XttsVoiceSettings', { xttsSettings: { language: 'fr' }, xttsProbe: { state: 'loading', message: '' }, xttsLogs: [{ message: '', technicalDetail: '_RAW_TOOL_' }], xttsVoicesLoaded: true, xttsVoices: ['_AUTHOR_VOICE_'], favoriteVoices: favorites }]),
    ];
    for (const [name, props] of scenarios) {
      const now = (await current.ssrLoadModule(`/src/tabs/OptionsTab/${name}.jsx`))[name];
      const old = (await original.ssrLoadModule(`/src/tabs/OptionsTab/${name}.jsx`))[name];
      const render = component => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component, component === old && name === 'XttsVoiceSettings' ? { ...props, xttsLogs: ['_RAW_TOOL_'] } : props)));
      await engine.changeLanguage('fr');
      // Évolution volontaire (signalement des sons à l'ajout) : la ligne ajoutée aux Projets et médias est retirée du rendu courant avant comparaison à BASE.
      assert.equal(plain(render(now)).replace(name === 'XttsVoiceSettings' ? 'Détailtechnique' : '\u0000', '').replace(plain(fr['projects.levelAlerts.label'] + fr['projects.levelAlerts.description']), ''), plain(applyLot413(render(old)).replaceAll('Ctrl+Shift+S', `${commandKeyLabel()}+Maj+S`).replaceAll('Ctrl+S', `${commandKeyLabel()}+S`)).replaceAll('Workspaceencoursderésolution…', 'Emplacementdetravailencoursderésolution…'), name);
      for (const language of ['en', 'it', 'pseudo']) { await engine.changeLanguage(language); const html = render(now); assert.doesNotMatch(html, /\[object Object\]|settings:[a-z]+\./); if (language === 'pseudo') assertSurface(html); }
    }
    const { SettingsPanelHeader } = await current.ssrLoadModule('/src/workspace/SettingsPanelHeader.jsx');
    const OldHeader = (await original.ssrLoadModule('/src/workspace/SettingsPanelHeader.jsx')).SettingsPanelHeader;
    for (const props of [{}, { selectedIds: new Set(['a', 'b']) }, { selectedId: 'end-node', project: {} }, ...['simple', 'pack'].map(projectType => ({ node: { type: 'root' }, project: { projectType } })), { node: { type: 'story', name: '_AUTHOR_TITLE_' }, project: {} }]) {
      const before = JSON.stringify(props); const render = c => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(c, { ...props, onClose() {} })));
      await engine.changeLanguage('fr'); assert.equal(plain(render(SettingsPanelHeader)), plain(render(OldHeader)));
      await engine.changeLanguage('pseudo'); assertSurface(render(SettingsPanelHeader)); assert.equal(JSON.stringify(props), before);
    }
    const { ErrorDialogProvider } = await current.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { OptionsTab } = await current.ssrLoadModule('/src/tabs/OptionsTab.jsx');
    for (const asModal of [false, true]) {
      await engine.changeLanguage('pseudo');
      const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(ErrorDialogProvider, null, React.createElement(OptionsTab, { asModal, onBackToHome() {}, xttsSettings: {}, sdSettings: {} }))));
      assertSurface(html);
    }
    const { SettingsPanel } = await current.ssrLoadModule('/src/workspace/SettingsPanel.jsx');
    const { ProjectActionsContext } = await current.ssrLoadModule('/src/store/ProjectActionsContext.js');
    for (const props of [{ selectedId: 'end-node' }, { selectedIds: new Set(['a', 'b']), node: {} }]) {
      const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(ProjectActionsContext.Provider, { value: {} }, React.createElement(SettingsPanel, { ...props, project: { rootEntries: [] } }))));
      assertSurface(html);
    }
    assert.throws(() => assertSurface('<input placeholder="Texte français oublié" />'), /hors catalogue/);
  } finally { await current.close(); await original.close(); }
});

test('réglages : CLDR 0/1/2/million et descripteurs IPC traduits sans mutation', async () => {
  const srv = await server();
  try {
    const { initializeI18n } = await srv.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { presentStoredError, presentUserMessage, userMessageTransport } = await srv.ssrLoadModule('/src/i18n/userMessage.js');
    const state = { key: 'settings:images.import.error', params: { message: { userMessage: { code: 'COMFYUI_WORKFLOW_NOT_FOUND', params: { workflowId: '_AUTHOR_WF_' }, detail: '_RAW_TOOL_' } } } };
    const before = JSON.stringify(state), texts = [];
    for (const language of ['fr', 'en', 'it']) {
      await engine.changeLanguage(language); texts.push(presentStoredError(state));
      for (const key of Object.keys(fr).filter(k => k.endsWith('_one')).map(k => k.slice(0, -4))) for (const count of [0, 1, 2, 1_000_000]) {
        const category = new Intl.PluralRules(language).select(count);
        assert.equal(engine.t(`settings:${key}`, { count }), resources[language].settings[`${key}_${category}`].replace('{{count}}', count));
      }
      for (const envelope of [
        { code: 'PIPER_DOWNLOAD_STARTED', params: { service: '_AUTHOR_SERVICE_' } },
      ]) {
        assert.deepEqual(JSON.parse(userMessageTransport(envelope)), envelope);
        const presented = presentUserMessage(envelope, { allowLegacyFrench: false });
        assert.equal(presented.code, envelope.code); assert.equal(presented.fallback, false);
        assert.notEqual(presented.code, 'PIPER_UNKNOWN_ERROR');
      }
      assert.doesNotMatch(presentStoredError({ key: 'settings:consolidate.error.message', params: { message: { userMessage: 'Erreur française brute', codedOnly: true } } }), /Erreur française brute|\[object Object\]/);
      const envelope = state.params.message.userMessage;
      assert.deepEqual(JSON.parse(userMessageTransport(envelope)), envelope);
      const presented = presentUserMessage(envelope, { allowLegacyFrench: false });
      assert.equal(presented.code, 'COMFYUI_WORKFLOW_NOT_FOUND'); assert.notEqual(presented.code, 'COMFYUI_SERVICE_ERROR'); assert.equal(presented.fallback, false); assert.equal(presented.technicalDetail, '_RAW_TOOL_');
      assert.doesNotMatch(presentStoredError(state), /\[object Object\]|_RAW_TOOL_/);
    }
    assert.equal(new Set(texts).size, 3); assert.equal(JSON.stringify(state), before);
    const common = await srv.ssrLoadModule('/src/locales/fr/common.json'); assert.equal(common.default['project.saveAs.fallbackLabel'], 'Enregistrer sous…');
  } finally { await srv.close(); }
});
