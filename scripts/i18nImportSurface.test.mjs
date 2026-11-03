import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import i18next from 'i18next';
import fixture from './fixtures/import-fr-base-sources.json' with { type: 'json' };
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { pseudoText } from '../src/i18n/pseudo.js';
import { createTestI18n } from './i18nTestSetup.mjs';
import { checkCatalogues } from './check-i18n.mjs';
import fr from '../src/locales/fr/import.json' with { type: 'json' };
import en from '../src/locales/en/import.json' with { type: 'json' };
import it from '../src/locales/it/import.json' with { type: 'json' };
import meta from '../src/locales/_meta/import.json' with { type: 'json' };
import { presentImportError, isFreeEditorRefusal } from '../src/components/EditPack/importErrorPresentation.js';
import { describeChildVerdict } from '../src/components/EditPack/bundleChildren.js';
import { sanitizeImportedEntries } from '../src/store/importedNames.js';
import { importFilesToMediaLibrary } from '../src/hooks/mediaLibraryImport.js';

const richPseudoFragments = new Set(Object.values(fr).flatMap(value => [...pseudoText(value).matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1])));
const plain = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
async function server(original) {
  return createServer({ configFile: false, plugins: [{ name: 'import-fixtures', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && fixture.sources[file]) code = fixture.sources[file];
    if (id.endsWith('/AppModalPortal.jsx')) return 'export function AppModalPortal({children}) { return children; }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}
async function surfaces(s) {
  const { initializeI18n } = await s.ssrLoadModule('/src/i18n/index.js');
  const runtime = initializeI18n('fr');
  const components = {};
  for (const [name, file] of Object.entries({ BundleChildStep: 'EditPack/BundleChildStep', PodcastImportFunnel: 'PodcastImport/PodcastImportFunnel', PodcastImportModal: 'PodcastImport/PodcastImportModal', YoutubeImportFunnel: 'YoutubeImport/YoutubeImportFunnel', ImportErrorNotice: 'EditPack/ImportErrorNotice', ImportNoticeToast: 'common/ImportNoticeToast' })) {
    components[name] = (await s.ssrLoadModule(`/src/components/${file}.jsx`))[name];
  }
  const noop = () => {};
  const scenarios = [
    ['BundleChildStep', { containerLabel: '_AUTHOR_ARCHIVE_', packs: [{ childId: 'a', displayName: '_AUTHOR_TITLE_', sizeBytes: 1024, status: 'editable', selectable: true }, { childId: 'b', displayName: '_AUTHOR_OTHER_', sizeBytes: 10, status: 'read-only', reason: 'RAW_TECHNICAL' }], selectedChildId: 'a', onSelect: noop, onContinue: noop, onBack: noop }],
    ['PodcastImportFunnel', { onClose: noop, onImport: noop }],
    ['PodcastImportModal', { onClose: noop, onImport: noop }],
    ['YoutubeImportFunnel', { onClose: noop, onImport: noop }],
    ['ImportErrorNotice', { error: 'RAW_TECHNICAL' }],
    ['ImportNoticeToast', { message: '_AUTHOR_NOTICE_', onClose: noop }],
  ];
  return { runtime, render: () => scenarios.map(([name, props]) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: runtime }, React.createElement(components[name], props)))) };
}

// Évolution volontaire : l’adresse accepte aussi les liens Apple Podcasts.
// La fixture historique reste intacte ; seules ces attentes de texte changent.
function applePodcastCopy(text) {
  return text
    .replace('Choisis un flux RSS, puis les épisodes à transformer en histoires.', 'Choisis un podcast via son lien Apple Podcasts ou son flux RSS, puis les épisodes à transformer en histoires.')
    .replace('1Flux RSS2Épisodes', '1Adresse2Épisodes')
    .replace('Colle l’URL du flux RSS pour afficher les épisodes disponibles.', 'Colle un lien Apple Podcasts ou l’URL d’un flux RSS pour afficher les épisodes disponibles.')
    .replace('Adresse du flux RSS', 'Lien Apple Podcasts ou flux RSS')
    .replace('Colle l’URL du flux RSS du podcast.', 'Colle un lien Apple Podcasts ou l’URL du flux RSS du podcast.');
}

test('Imports : comparaison FR avec source indépendante et surfaces pseudo réellement rendues', async () => {
  assert.equal(fixture.base, '033ca57c929cc284b109ba37e694078044d923c4');
  const s = await server(false), original = await server(true);
  try {
    const now = await surfaces(s), before = await surfaces(original);
    assert.deepEqual(now.render().map(plain), before.render().map((html) => applePodcastCopy(plain(applyLot413(html)))));
    for (const lng of ['en', 'it', 'pseudo']) {
      await now.runtime.changeLanguage(lng);
      for (const html of now.render()) {
        assert.doesNotMatch(html, /import:|\[object Object\]/);
        if (lng !== 'pseudo') continue;
        const values = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1]);
        values.push(...[...html.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]+)"/g)].map(m => m[1]));
        for (const value of values) {
          if (!/\p{L}/u.test(value) || value.includes('_AUTHOR_') || value.includes('RAW_TECHNICAL')) continue;
          assert.ok(value.includes('[') || value.includes(']') || richPseudoFragments.has(value), `hors catalogue : ${value}`);
        }
      }
    }
  } finally { await s.close(); await original.close(); }
});

test('tables déjà créées, erreur retenue et noms auteur : FR → EN → IT sans mutation', async () => {
  i18next.init(createTestI18n().options);
  const error = { code: 'PACK_NOT_EDITABLE', params: {}, detail: 'RAW_TECHNICAL' };
  const original = JSON.stringify(error);
  const heldError = presentImportError(error);
  const verdict = describeChildVerdict({ status: 'read-only', reason: 'RAW_TECHNICAL' });
  const authored = [{ type: 'story', name: 'Auteur conservé' }];
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    assert.equal(isFreeEditorRefusal(error), true);
    assert.equal(isFreeEditorRefusal({ code: 'IMPORT_INVALID_ARCHIVE', params: {} }), false);
    assert.equal(isFreeEditorRefusal('PACK_NOT_EDITABLE'), false);
    assert.equal(heldError.message, i18next.t('rust:PACK_NOT_EDITABLE'));
    assert.equal(verdict.label, i18next.t('import:bundle.verdict.readOnly'));
    assert.equal(heldError.technicalDetail, 'RAW_TECHNICAL');
    assert.deepEqual(sanitizeImportedEntries(authored), authored);
    assert.equal(sanitizeImportedEntries([{ type: 'story', name: '' }])[0].name, i18next.t('import:names.story.fallback'));
  }
  assert.equal(JSON.stringify(error), original);
  await i18next.changeLanguage('fr');
});

test('pluriels CLDR 0/1/2/1000000 ; fuite FR détectée par mutation en mémoire', () => {
  const runtime = createTestI18n();
  for (const lng of ['fr', 'en', 'it']) {
    runtime.changeLanguage(lng);
    const catalogue = { fr, en, it }[lng];
    assert.ok(!Object.keys(catalogue).some(k => k.endsWith('_zero')));
    for (const base of ['bundle.archive.description', 'podcast.episodes.count', 'podcast.import.action', 'youtube.import.action', 'media.selected.count', 'youtube.selection.notice', 'podcast.batch.partial', 'youtube.batch.partial', 'youtube.blocked.imported', 'youtube.blocked.skipped']) {
      for (const count of [0, 1, 2, 1000000]) {
        const category = new Intl.PluralRules(lng).select(count);
        assert.equal(runtime.t(`import:${base}`, { count, name: '_AUTHOR_', total: 10, notice: '_NOTICE_' }), catalogue[`${base}_${category}`].replaceAll('{{count}}', String(count)).replaceAll('{{name}}', '_AUTHOR_').replaceAll('{{total}}', '10').replaceAll('{{notice}}', '_NOTICE_'));
      }
    }
  }
  const resources = { fr: { import: fr }, en: { import: structuredClone(en) }, it: { import: it } };
  resources.en.import['podcast.load.action'] = fr['podcast.load.action'];
  assert.ok(checkCatalogues(resources, { import: meta }).errors.includes('en/import:podcast.load.action règle d’or : texte français'));
});

test('progression extraction : ellipse autorisée et état retenu traduit à chaud', async () => {
  i18next.init(createTestI18n().options);
  const phases = [];
  await importFilesToMediaLibrary({ files: ['/a.mp3'], maybeCopyToProject: async p => p, extractAudioEmbeddedImage: async () => null, setImporting: state => phases.push(state) });
  assert.equal(phases[0].phase, 'Copie dans le projet…');
  assert.equal(phases[1].phase, 'Extraction de la jaquette…');
  await i18next.changeLanguage('en');
  assert.equal(phases[0].phase, 'Copying into the project…');
  assert.equal(phases[1].phase, 'Extracting the cover…');
  await i18next.changeLanguage('fr');
});

test('exceptions FR nominatives : seule la progression remplace ... par …', () => {
  const changes = [
    ['pack.analysis.progress', 'src/hooks/useImportSession.js', 'Analyse du pack importé...'],
    ['audio.import.progress', 'src/hooks/useImportSession.js', "Import de l'audio..."],
    ['pack.metadata.progress', 'src/hooks/useImportSession.js', 'Lecture des métadonnées du pack...'],
    ['audio.analysis.progress', 'src/hooks/useImportSession.js', "Analyse de l'audio importé..."],
    ['media.preparation.progress', 'src/hooks/useImportSession.js', "Préparation de l'import..."],
    ['archive.import.progress', 'src/hooks/useImportSession.js', "Import de l'archive..."],
    ['folder.analysis.progress', 'src/hooks/useImportSession.js', 'Analyse du dossier...'],
    ['folder.scan.progress', 'src/hooks/useImportSession.js', 'Scan du dossier...'],
    ['media.thumbnail.progress', 'src/hooks/useImportSession.js', 'Récupération de la vignette...'],
    ['media.copy.progress', 'src/hooks/mediaLibraryImport.js', 'Copie dans le projet...'],
    ['media.cover.progress', 'src/hooks/mediaLibraryImport.js', 'Extraction de la jaquette...'],
    ['project.save.progress', 'src/store/projectIO.js', 'Enregistrement du projet...'],
    ['project.save.takeoff', 'src/store/projectIO.js', 'Décollage vers la lune...'],
  ];
  for (const [key, file, before] of changes) {
    assert.ok(fixture.sources[file].includes(before), `${file} texte indépendant de BASE`);
    // Lot 4.13 : « ... » → « … », plus apostrophe typographique.
    // folder.scan.progress : « Scan du dossier » reformulé au lot 4.13 (§D).
    assert.equal(fr[key], key === 'folder.scan.progress' ? 'Recherche dans le dossier…' : before.slice(0, -3).replaceAll("'", '’') + '…');
  }
  assert.ok(fixture.sources['src/hooks/useImportSession.js'].includes('`Téléchargement de la ${itemLabel}...`'));
  assert.equal(fr['youtube.download.progress'], 'Téléchargement de la vidéo…');
  // Lot 4.13 : « de la épisode » corrigé.
  assert.equal(fr['podcast.download.progress'], 'Téléchargement de l’épisode…');
  assert.equal(createTestI18n().t('common:project.saveAs.fallbackLabel'), 'Enregistrer sous…');
});

test('revue 3 : Provider avec dialogue déjà ouvert, notices et progression réellement rendus à chaud', async () => {
  const previous = { hooks: globalThis.__importProviderHooks, runtime: globalThis.__importProviderRuntime, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  const slots = []; let cursor = 0;
  const stateHook = initial => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
  };
  globalThis.__importProviderHooks = { useState: stateHook, useRef: initial => stateHook({ current: initial })[0], useMemo: fn => fn(), useCallback: fn => fn };
  globalThis.document = { activeElement: null, body: {}, documentElement: { lang: 'fr' } };
  globalThis.HTMLElement = class {};
  const s = await createServer({ configFile: false, plugins: [{ name: 'retained-import-dialog', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/AppModalPortal.jsx')) return 'export function AppModalPortal({ children }) { return children; }';
    if (!id.endsWith('/Dialog.jsx')) return code;
    code = code.replace("import { createPortal } from 'react-dom';", 'const createPortal = children => children;');
    // Seul l'ordonnanceur des hooks du Provider est doublé ; son code de stockage est intact.
    const start = code.indexOf('export function ErrorDialogProvider(');
    const end = code.indexOf('export function useErrorDialog()', start);
    let provider = code.slice(start, end).replace('const { t } = useCommonTranslation();', 'const t = globalThis.__importProviderRuntime.t.bind(globalThis.__importProviderRuntime);');
    for (const hook of ['useState', 'useRef', 'useMemo', 'useCallback']) provider = provider.replaceAll(`${hook}(`, `globalThis.__importProviderHooks.${hook}(`);
    return code.slice(0, start) + provider + code.slice(end);
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await s.ssrLoadModule('/src/i18n/index.js');
    const runtime = initializeI18n('fr');
    globalThis.__importProviderRuntime = runtime;
    const { ErrorDialogProvider } = await s.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { ImportNoticeToast } = await s.ssrLoadModule('/src/components/common/ImportNoticeToast.jsx');
    const { SaveProgressModal } = await s.ssrLoadModule('/src/components/common/SaveProgressModal.jsx');
    const { presentStoredError } = await s.ssrLoadModule('/src/i18n/userMessage.js');
    const batch = { key: 'import:youtube.failure.known', params: { message: { key: 'import:youtube.import.failure' }, reason: { userMessage: { code: 'blocked', params: {}, detail: '_RAW_TOOL_' }, codedOnly: true } } };
    const notice = { parts: [{ key: 'import:pack.transitions.notice' }, { key: 'import:pack.autoNext.notice' }], separator: '\n\n' };
    const progress = { lines: [{ key: 'import:project.save.progress' }, { key: 'import:project.media.copy', params: { done: 2, total: 7 } }, { key: 'import:project.save.done' }], complete: false };
    cursor = 0;
    let provider = ErrorDialogProvider({ children: null });
    provider.props.value.showErrorDialog({ get title() { return runtime.t('import:youtube.import.title'); }, message: batch, technicalDetail: '_RAW_TOOL_' });
    const retainedState = slots[0];
    const serialized = JSON.stringify([batch, notice, progress]);
    const output = [];
    for (const language of ['fr', 'en', 'it', 'pseudo']) {
      await runtime.changeLanguage(language);
      cursor = 0;
      provider = ErrorDialogProvider({ children: null });
      const tree = React.createElement(I18nextProvider, { i18n: runtime }, React.createElement(React.Fragment, null,
        provider,
        React.createElement(ImportNoticeToast, { message: notice, onClose: () => {} }),
        React.createElement(SaveProgressModal, { data: progress, title: runtime.t('common:appModals.save.progress'), doneTitle: runtime.t('common:titleBar.save.saved') }),
      ));
      const html = renderToStaticMarkup(tree);
      output.push(html);
      assert.equal(slots[0], retainedState, 'same open dialogue, no new catch');
      assert.equal(JSON.stringify([batch, notice, progress]), serialized);
      assert.doesNotMatch(html, /\[object Object\]|import:/);
      assert.ok(html.includes('Auteur') === false);
      assert.ok(plain(html).includes(presentStoredError(progress.lines[1])));
      if (language === 'en' || language === 'it') assert.doesNotMatch(html, /demande une vérification|Certaines transitions|Enregistrement du projet/);
      if (language === 'pseudo') {
        assert.ok(plain(html).includes('['));
        assert.doesNotMatch(html, /Certaines transitions|Projet enregistré/);
      }
    }
    assert.notEqual(output[0], output[1]); assert.notEqual(output[0], output[2]);
  } finally {
    await s.close();
    globalThis.__importProviderHooks = previous.hooks; globalThis.__importProviderRuntime = previous.runtime;
    globalThis.document = previous.document; globalThis.HTMLElement = previous.HTMLElement;
  }
});
