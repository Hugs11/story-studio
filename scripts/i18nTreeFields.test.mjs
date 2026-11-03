import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import { withBaseSourceAliases } from './baseSourceAliases.mjs';
import react from '@vitejs/plugin-react';
import fixture from './fixtures/tree-fields-fr-base-sources.json' with { type: 'json' };
import { applyLot413Deep, LOT_413_TREE } from './i18nLot413Corrections.mjs';
import metadata from '../src/locales/_meta/tree.json' with { type: 'json' };
import { createTestI18n } from './i18nTestSetup.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { checkCatalogues, sourceHash } from './check-i18n.mjs';

const names = ['AudioField', 'ImageField', 'ZipEditor', 'story/StoryDisclosure', 'EndMessagePlaybackControl', 'EndNodeEditor', 'MenuEditor', 'MultiEditor', 'NativeGraphEditor', 'RootEditor', 'StoryEditor', 'story/AfterPlaySection', 'story/DuringPlaySection', 'story/EndSequenceEditor'];
const resources = createTestI18n().options.resources;
const pseudoFragments = new Set(Object.values(pseudoResources(resources.fr).tree).flatMap(value => value.split(/<[^>]*>/).map(part => part.replace(/{{[^}]*}}/g, '').trim()).filter(Boolean)));
// Un dossier de pack vaut une archive : le nœud Zip gagne un bouton « Choisir un dossier »
// après celui de l'archive (ajout volontaire, absent de la base).
const withZipFolderButton = (name, texts) => {
  if (name !== 'ZipEditor') return texts;
  const at = texts.findIndex((text) => text === 'Choisir' || text === 'Remplacer');
  return at < 0 ? texts : [...texts.slice(0, at + 1), 'Choisir un dossier', ...texts.slice(at + 1)];
};
const sourceTexts = (html) => [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1])
  .concat([...html.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]+)"/g)].map((m) => m[1]))
  .map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

async function surfaceServer(original) {
  return createServer({ configFile: false, plugins: [{ name: 'tree-field-fixtures', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && fixture.sources[file]) code = fixture.sources[file];
    if (original) code = withBaseSourceAliases(code, id);
    if (id.endsWith('/ProjectContext.js')) return `export function useProjectContext() { return { pathAudit: globalThis.__treeFieldFixture.missing ? { '/_AUTHOR_FILE_.wav': false, '/_AUTHOR_FILE_.png': false } : {}, xttsSettings: {}, sdSettings: { aiImageGen: true }, sdJobs: globalThis.__treeFieldFixture.jobs ?? [], onOpenSDGenerate() {} }; }`;
    if (id.endsWith('/MediaTransferContext.js')) return 'export function useMediaTransfer() { return { notifyCutPaste() {} }; }';
    if (id.endsWith('/ProjectActionsContext.js')) return 'export function useProjectActions() { return { onAttachStoryEndToGlobal() {} }; }';
    if (id.endsWith('/Dialog.jsx')) return 'export function useErrorDialog() { return { showConfirmDialog() {}, showErrorDialog() {} }; }';
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile(path) { return path; }';
    if (id.endsWith('/useMediaMetadata.js')) return 'export function useMediaMetadata() { return { getMeta() { return null; }, markForProbe() {} }; }';
    if (id.endsWith('/xttsSettings.js')) return 'export function isTtsAvailable() { return true; }';
    if (id.endsWith('/useZipCover.js')) return 'export function useZipCover() { return "/_AUTHOR_COVER_"; }';
    if (id.endsWith('/Tooltip.jsx')) return 'export function Tooltip({text,children}) { return <span title={text}>{children}</span>; }';
    if (id.endsWith('/ContextMenu.jsx')) return 'export function ContextMenu({actions}) { return <div>{actions.filter(x => typeof x === "object").map((x,i) => <span key={i}>{x.label}</span>)}</div>; }';
    if (id.endsWith('/RecordModal.jsx')) return 'export function RecordModal() { return null; }';
    if (id.endsWith('/GenerateVoiceModal.jsx')) return 'export function GenerateVoiceModal() { return null; }';
    if (id.endsWith('/DuringPlaySection.jsx')) code = code.replace('useState(duringPlaySelectionAdvancedOpen)', 'useState(true)');
    if (id.endsWith('/AfterPlaySection.jsx')) code = code.replace('const [showAdvanced, setShowAdvanced] = useState(false)', 'const [showAdvanced, setShowAdvanced] = useState(true)').replace('const [showPromptField, setShowPromptField] = useState(false)', 'const [showPromptField, setShowPromptField] = useState(true)').replace('const [showSequenceEditor, setShowSequenceEditor] = useState(false)', 'const [showSequenceEditor, setShowSequenceEditor] = useState(true)');
    if (id.endsWith('/AudioField.jsx')) code = code
      .replace('useState(false);\n  const [savingGeneratedAudio', 'useState(globalThis.__treeFieldFixture.notice);\n  const [savingGeneratedAudio')
      .replace('const [isPlaying, setIsPlaying] = useState(false)', 'const [isPlaying, setIsPlaying] = useState(globalThis.__treeFieldFixture.playing ?? false)')
      .replace('const [savingGeneratedAudio, setSavingGeneratedAudio] = useState(false)', 'const [savingGeneratedAudio, setSavingGeneratedAudio] = useState(globalThis.__treeFieldFixture.saving ?? false)')
      .replace('const [pendingGeneratedSource, setPendingGeneratedSource] = useState(null)', 'const [pendingGeneratedSource, setPendingGeneratedSource] = useState(globalThis.__treeFieldFixture.source)');
    if (/\/(AudioField|ImageField)\.jsx$/.test(id)) code = code.replace('const [ctxMenu, setCtxMenu] = useState(null)', 'const [ctxMenu, setCtxMenu] = useState(globalThis.__treeFieldFixture.menu ? { x: 0, y: 0 } : null)');
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

async function load(server) {
  const components = {};
  for (const name of names) Object.assign(components, await server.ssrLoadModule(`/src/components/editors/${name}.jsx`));
  components.__clipboard = await server.ssrLoadModule('/src/store/fieldClipboard.js');
  return components;
}

const noop = () => {};
const story = { id: 's', type: 'story', name: '_AUTHOR_STORY_', audio: null, controlSettings: {} };
const project = { projectType: 'pack', rootName: '', rootEntries: [story], globalOptions: {}, packMetadata: {} };
const graph = { document: { stageNodes: [{ uuid: '_AUTHOR_STAGE_ID_', name: '_AUTHOR_STAGE_', controlSettings: {}, squareOne: true }], actionNodes: [] } };
const baseProps = { project, allMenus: [], allStories: [story], onUpdate: noop, onDelete: noop }; 
const scenarios = [
  ...[null, '/_AUTHOR_FILE_.wav'].flatMap((file) => [false, true].map((missing) => ['AudioField', { file, onPick: noop, onClear: noop }, { missing, menu: true }])),
  ...['record', 'tts'].map((source) => ['AudioField', { onPick: noop }, { notice: true, source }]),
  ...[null, '/_AUTHOR_FILE_.png'].flatMap((file) => [false, true].map((missing) => ['ImageField', { file, onPick: noop, onClear: noop }, { missing, menu: true }])),
  ['ImageField', { file: null, extraActions: [{ key: 'generate-text', onClick: noop }] }, {}],
  ...[null, '/_AUTHOR_ARCHIVE_.zip'].map((zipPath) => ['ZipEditor', { node: { zipPath, name: '_AUTHOR_NAME_', coverImage: 'cover.png' }, onUpdate: noop, onDelete: noop }, {}]),
  ['StoryDisclosure', { open: true, onToggle: noop }, {}],
  ...['copy', 'cut'].flatMap(clipboard => [['AudioField', { file: '/_AUTHOR_FILE_.wav', onPick: noop, onClear: noop }, { clipboard, menu: true }], ['ImageField', { file: '/_AUTHOR_FILE_.png', onPick: noop, onClear: noop }, { clipboard, menu: true }]]),
  ['ImageField', { fieldId: 'author-image', onPick: noop, onClear: noop }, { jobs: [{ id: 'job', fieldId: 'author-image', status: 'running' }] }],
  ['ImageField', { fieldId: 'author-image', file: '/_AUTHOR_FILE_.png', onPick: noop, onClear: noop }, { jobs: [{ id: 'job', fieldId: 'author-image', status: 'done', resultPaths: ['/_AUTHOR_RESULT_.png'] }] }],
  ['AudioField', { file: '/_AUTHOR_FILE_.wav', onPick: noop, onClear: noop }, { playing: true, menu: true }],
  ['AudioField', {}, { notice: true, saving: true, source: 'record' }],
  ...['wait', 'auto', 'mixed'].map(mode => ['EndMessagePlaybackControl', { summary: { total: 2, waitingOk: 1, autoPlay: 1, stays: 1, mode } }, {}]),
  ['EndNodeEditor', { ...baseProps, onUpdateNightModeAudio: noop }, {}],
  ['MenuEditor', { ...baseProps, node: { id: 'm', type: 'menu', name: '_AUTHOR_MENU_', children: [] } }, {}],
  ['MenuEditor', { ...baseProps, node: { id: 'm', type: 'menu', name: '_AUTHOR_MENU_', children: [story], importedContinuation: { sourceStoryName: '_AUTHOR_SOURCE_', sourceStepName: '_AUTHOR_STEP_' }, nativeGraph: graph } }, {}],
  ['NativeGraphEditor', { graph, onChange: noop }, {}],
  ...['pack', 'simple'].map(projectType => ['RootEditor', { node: project, projectType, onUpdateRoot: noop, onUpdateMedia: noop, onUpdateStoryAudio: noop }, {}]),
  ['StoryEditor', { ...baseProps, node: story }, {}],
  ['DuringPlaySection', { ...baseProps, node: story }, {}],
  ['AfterPlaySection', { ...baseProps, node: story }, {}],
  ['AfterPlaySection', { ...baseProps, project: { ...project, nightModeAudio: '/_AUTHOR_AUDIO_', globalOptions: { nightMode: true } }, node: { ...story, afterPlaybackPromptAudio: '/_AUTHOR_LOCAL_AUDIO_' } }, {}],
  ['AfterPlaySection', { ...baseProps, node: { ...story, afterPlaybackPromptAudio: '/_AUTHOR_LOCAL_AUDIO_', afterPlaybackPromptHomeNone: true } }, {}],
  ['EndSequenceEditor', { ...baseProps, node: story, steps: [{ id: 'step', name: '_AUTHOR_STEP_', controlSettings: {} }], homeStep: { id: 'home', name: '_AUTHOR_HOME_', controlSettings: {} } }, {}],
  ['MultiEditor', { ...baseProps, selectedIds: new Set(['s']), onBulkUpdateItems: noop, onBulkDeleteItems: noop }, {}],
];

test('champs arbre : FR rendu contre git show BASE indépendant, EN/IT/pseudo, attributs accessibles compris', async () => {
  assert.equal(fixture.base, 'ca3f88dda46034f00efee3f9c4e866062331f74f');
  const server = await surfaceServer(false), originalServer = await surfaceServer(true);
  const previous = globalThis.__treeFieldFixture;
  const instance = i18next;
  instance.init(createTestI18n().options);
  for (const [ns, catalogue] of Object.entries(pseudoResources(resources.fr))) instance.addResourceBundle('pseudo', ns, catalogue);
  const render = (component, props) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: instance }, React.createElement(component, props)));
  try {
    const current = await load(server), original = await load(originalServer);
    for (const [name, props, state] of scenarios) {
      globalThis.__treeFieldFixture = state;
      for (const surface of [current, original]) for (const kind of ['audioClipboard', 'imageClipboard']) { surface.__clipboard[kind].clear(); if (state.clipboard) surface.__clipboard[kind].set('/_AUTHOR_CLIP_', { mode: state.clipboard }); }
      await instance.changeLanguage('fr');
      assert.deepEqual(sourceTexts(render(current[name], props)), withZipFolderButton(name, applyLot413Deep(sourceTexts(render(original[name], props)), LOT_413_TREE)), `FR ${name} ${JSON.stringify(state)}`);
      const before = JSON.stringify(props);
      for (const language of ['en', 'it', 'pseudo']) {
        await instance.changeLanguage(language);
        const html = render(current[name], props);
        assert.doesNotMatch(html, /tree:|\[object Object\]|{{/);
        if (language === 'pseudo') for (const value of sourceTexts(html)) {
          if (!/\p{L}/u.test(value) || value.includes('_AUTHOR_') || /^#[0-9a-f]{6}$/i.test(value)) continue;
          assert.ok(value.includes('[') || value.includes(']') || pseudoFragments.has(value), `hors pseudo ${name}: ${value}`);
        }
        assert.equal(JSON.stringify(props), before);
      }
    }
  } finally { globalThis.__treeFieldFixture = previous; await server.close(); await originalServer.close(); }
});

test('catalogue tree : hash, paramètres, statuts et fuite FR détectée par mutation en mémoire', () => {
  const catalogues = Object.fromEntries(['fr', 'en', 'it'].map((language) => [language, { tree: resources[language].tree }]));
  assert.deepEqual(checkCatalogues(catalogues, { tree: metadata }).errors, []);
  for (const [key, value] of Object.entries(resources.fr.tree)) {
    if (metadata[key].en) assert.equal(metadata[key].en.sourceHash, sourceHash(value));
    if (metadata[key].it) assert.equal(metadata[key].it.sourceHash, sourceHash(value));
    if (metadata[key].en) assert.equal(metadata[key].en.status, 'ai-reviewed'); if (metadata[key].it) assert.equal(metadata[key].it.status, 'ai-reviewed');
    for (const language of ['en', 'it']) {
      if (resources[language].tree[key] === undefined) { assert.ok(language === 'en' && key.endsWith('_many') || key.endsWith('_zero'));  continue; }
      // Lot 4.3b : modèles de ponctuation sans prose et marqueur de format ZIP ; les assertions des anciennes clés restent identiques.
      const neutral = new Set(['display.option.aria', 'context.disabled.aria', 'nodeType.zip', 'control.ok.short', 'root.image.badge', 'nativeGraph.counts.summary', 'nativeGraph.stage.name', 'endPlayback.mixed.summary', 'media.image.label', 'navigation.destination.label', 'multi.image.progress', 'media.native.audio', 'media.native.image']);
      // Lot 4.13 : « l’audio » (IT), « Pause » (EN) et « OK » sont identiques dans la langue cible (TREE_LANGUAGE_NEUTRAL_KEYS).
      if ({ en: ['nativeGraph.control.pause', 'nativeGraph.control.ok'], it: ['context.file.audio', 'nativeGraph.control.ok'] }[language].includes(key)) continue;
      // Relecture Opus : mots identiques dans la langue cible, déclarés aussi dans TREE_NEUTRAL_KEYS.
      if (neutral.has(key) || ['color.orange.label', 'diagram.focus.short'].includes(key)) continue;
      assert.notEqual(resources[language].tree[key], value);
      const mutated = structuredClone(catalogues);
      mutated[language].tree[key] = value;
      assert.ok(checkCatalogues(mutated, { tree: metadata }).errors.some((error) => error.includes(`${language}/tree:${key} règle d’or`)), key);
    }
  }
  assert.equal(resources.fr.common['project.saveAs.fallbackLabel'], 'Enregistrer sous…');
});

test('pluriels véritables : catégories complètes et count 0/1/2/1 000 000 dans chaque langue', async () => {
  const instance = createTestI18n();
  const bases = Object.keys(resources.fr.tree).filter(k => k.endsWith('_one')).map(k => k.slice(0, -4));
  assert.ok(bases.includes('count.items.label')); assert.ok(bases.includes('endPlayback.wait.summary'));
  for (const language of ['fr', 'en', 'it']) {
    await instance.changeLanguage(language);
    for (const base of bases) for (const count of [0, 1, 2, 1_000_000]) {
      const category = new Intl.PluralRules(language).select(count);
      const key = base + '_' + category;
      assert.ok(Object.hasOwn(resources[language].tree, key), `${language}/${key}`);
      const rendered = instance.t('tree:' + base, { count, items: '_AUTHOR_NAMES_' });
      assert.ok(rendered.includes(String(count))); assert.doesNotMatch(rendered, /tree:|{{count}}/);
      assert.equal(rendered, resources[language].tree[key].replaceAll('{{count}}', String(count)).replaceAll('{{items}}', '_AUTHOR_NAMES_'));
    }
  }
  // Source indépendante : le compteur historique de formatFrenchCount conserve le pluriel à zéro.
  assert.equal(instance.t('tree:count.items.emptyLabel', { lng: 'fr', count: 0 }), '0 éléments');
  assert.equal(instance.t('tree:count.items.label', { lng: 'fr', count: 1 }), '1 élément');
});

test('création dans la langue active, noms auteur intacts, références média et export résolus au déclenchement, codes/params IPC', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const model = await server.ssrLoadModule('/src/store/projectModel/index.js');
    const metadataModel = await server.ssrLoadModule('/src/store/packMetadataModel.js');
    const { presentUserMessage, presentStoredError } = await server.ssrLoadModule('/src/i18n/userMessage.js');
    i18next.init(createTestI18n().options);
    const capturedName = model.createMenuEntry();
    const refs = [...model.walkProjectMediaReferences({ rootAudio: '/_AUTHOR_AUDIO_', rootEntries: [{ id: 'author', type: 'story', name: '_AUTHOR_NAME_', audio: '/_AUTHOR_STORY_AUDIO_' }] })];
    const recap = metadataModel.advancedPackRecap({ documentOrigin: 'created' });
    const held = metadataModel.metadataSaveDecision({ status: 'held' });
    assert.equal(held.noticeRef.key, 'tree:metadata.save.held');
    const message = { code: 'VALIDATION_FIELD_MISSING_MASCULINE', params: { label: { key: 'tree:control.home.label' } }, detail: 'RAW_DETAIL' };
    const before = structuredClone(message);
    for (const [language, folder, cover, version] of [['fr', 'Nouveau dossier', 'Audio de couverture', 'v1 par défaut à la génération'], ['en', 'New folder', 'Cover audio', 'Defaults to v1 when generated'], ['it', 'Nuova cartella', 'Audio di copertina', 'v1 se non specificata alla generazione']]) {
      await i18next.changeLanguage(language);
      assert.equal(model.createMenuEntry().name, folder); assert.equal(model.createMenuEntry({ name: 'Auteur …' }).name, 'Auteur …');
      assert.equal(capturedName.name, 'Nouveau dossier');
      // Ces objets existaient avant le changement : la lecture d'export suit la langue du déclenchement.
      assert.equal(refs[0].label, cover); assert.equal(recap.line, version);
      assert.ok(refs[1].label.includes('_AUTHOR_NAME_')); assert.equal(refs[1].path, '/_AUTHOR_STORY_AUDIO_');
      assert.equal(JSON.parse(JSON.stringify(refs))[0].label, cover);
      assert.equal(presentStoredError(held.noticeRef), held.notice);
      const presented = presentUserMessage(message);
      assert.equal(presented.code, 'VALIDATION_FIELD_MISSING_MASCULINE'); assert.notEqual(presented.code, 'UNEXPECTED_ERROR'); assert.equal(presented.fallback, false);
      assert.equal(presented.technicalDetail, 'RAW_DETAIL'); assert.doesNotMatch(presented.message, /RAW_DETAIL|\[object Object\]|VALIDATION_FIELD_MISSING_MASCULINE/);
      assert.ok(presented.message.includes(i18next.t('tree:control.home.label'))); assert.deepEqual(message, before);
    }
  } finally { await server.close(); }
});

test('nom automatique reconnu indépendamment de FR → EN → IT : callback audio BASE et auteur conservé', async () => {
  const updated = [];
  const captured = [];
  globalThis.__treeCaptureAudio = captured;
  async function server(original) {
    return createServer({ configFile: false, plugins: [{ name: 'story-audio-callback', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/StoryEditor.jsx') && original) return fixture.sources['src/components/editors/StoryEditor.jsx'];
      if (id.endsWith('/AudioField.jsx')) return 'export function AudioField(props) { globalThis.__treeCaptureAudio.push(props); return null; }';
      if (id.endsWith('/AfterPlaySection.jsx')) return 'export function AfterPlaySection() { return null; }';
      if (id.endsWith('/DuringPlaySection.jsx')) return 'export function DuringPlaySection() { return null; }';
      return code;
    } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  }
  const currentServer = await server(false), baseServer = await server(true);
  i18next.init(createTestI18n().options);
  const render = (Component, name) => {
    captured.length = 0;
    renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: i18next }, React.createElement(Component, { ...baseProps, node: { ...story, name }, onUpdate: fields => updated.push(fields) })));
    return captured.find(props => props.onPick && props.ttsFilenameHint?.startsWith('histoire-complete-')).onPick;
  };
  try {
    const { StoryEditor: current } = await currentServer.ssrLoadModule('/src/components/editors/StoryEditor.jsx');
    const { StoryEditor: base } = await baseServer.ssrLoadModule('/src/components/editors/StoryEditor.jsx');
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      for (const name of ['Nouvelle histoire', 'New story', 'Nuova storia', '', 'Récit d’Alice', 'Nouvelle histoire personnelle']) {
        updated.length = 0;
        await render(current, name)('/a/Le loup.mp3');
        const expected = { audio: '/a/Le loup.mp3', ...(['Nouvelle histoire', 'New story', 'Nuova storia', ''].includes(name) ? { name: 'Le loup' } : {}) };
        assert.deepEqual(updated[0], expected, `${language}/${name}`);
        if (['Nouvelle histoire', '', 'Récit d’Alice', 'Nouvelle histoire personnelle'].includes(name)) {
          const converted = updated[0];
          updated.length = 0; await render(base, name)('/a/Le loup.mp3');
          assert.deepEqual(converted, updated[0], `BASE ${language}/${name}`);
        }
      }
    }
  } finally { delete globalThis.__treeCaptureAudio; await currentServer.close(); await baseServer.close(); }
});
