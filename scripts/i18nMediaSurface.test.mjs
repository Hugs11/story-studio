import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import { withBaseSourceAliases } from './baseSourceAliases.mjs';
import react from '@vitejs/plugin-react';
import i18next from 'i18next';
import fixture from './fixtures/media-fr-base-sources.json' with { type: 'json' };
import { pseudoText } from '../src/i18n/pseudo.js';
import { createTestI18n } from './i18nTestSetup.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { checkCatalogues } from './check-i18n.mjs';
import fr from '../src/locales/fr/media.json' with { type: 'json' };
import en from '../src/locales/en/media.json' with { type: 'json' };
import it from '../src/locales/it/media.json' with { type: 'json' };
import meta from '../src/locales/_meta/media.json' with { type: 'json' };
import frNative from '../src/locales/fr/native.json' with { type: 'json' };
import enNative from '../src/locales/en/native.json' with { type: 'json' };
import itNative from '../src/locales/it/native.json' with { type: 'json' };
import { presentMedia, mediaRefusal } from '../src/i18n/mediaPresentation.js';
import { presentStoredError, presentUserMessage } from '../src/i18n/userMessage.js';
import { collectMediaLibrary, getEditedImageTags } from '../src/store/mediaLibrary.js';
import { resolveAudioStoriesInProjectOrder, getAssemblyReplacementEligibility, buildMediaAudioToolRequest } from '../src/store/mediaToolContext.js';
import { replaceStoriesWithAssembledStory } from '../src/store/projectModel/audioTransformations.js';
import { fetchSubscriptionSnapshot } from '../src/store/mediaSubscriptionSource.js';
import { REGISTRY_UNREADABLE_ERROR, REGISTRY_WRITE_ERROR } from '../src/store/mediaSubscriptions.js';
import { fadeConfig } from '../src/components/AudioEditorModal/fadeUtils.js';

const BASE = '9e730689c3943cda333b1d7eb92e4d7f06524c77';
const plain = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const richPseudoFragments = new Set(Object.values(fr).flatMap(value => [...pseudoText(value).matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1])));

// Corrections FR du lot 6, appliquées uniquement aux attentes BASE.
function applyShiftLabels(value) {
  return value.replaceAll('Shift+I', 'Maj+I').replaceAll('Shift+O', 'Maj+O');
}

async function server(original) {
  return createServer({ configFile: false, plugins: [{ name: 'media-fixtures', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && fixture.sources[file]) code = fixture.sources[file];
    if (original) code = withBaseSourceAliases(code, id);
    if (id.endsWith('/AppModalPortal.jsx')) return 'export function AppModalPortal({children}) { return children; }';
    // Infobulles rendues au survol seulement : exposées en attribut pour l'épreuve SSR.
    if (id.endsWith('/common/Tooltip.jsx')) return 'import { createElement } from "react"; export function Tooltip({ text, children }) { return createElement("span", { title: text }, children); }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

// Données d'auteur et détails bruts marqués : ils ne doivent jamais être traduits.
const audio = { id: 'a', path: '/w/_AUTHOR_a.mp3', name: '_AUTHOR_a.mp3', kind: 'audio', ext: 'mp3', exists: true, usages: [{ label: '_AUTHOR_LABEL_', entryId: 'e1' }], usedCount: 2, projectUsedCount: 2, inProject: true, usageKnown: true };
const image = { id: 'b', path: '/w/_AUTHOR_b.png', name: '_AUTHOR_b.png', kind: 'image', ext: 'png', exists: false, usages: [{ label: '_AUTHOR_IMG_' }], usedCount: 1, projectUsedCount: 0, inProject: false, usageKnown: false };
const audio2 = { ...audio, id: 'c', path: '/w/_AUTHOR_c.mp3', name: '_AUTHOR_c.mp3', projectUsedCount: 0, inProject: false };
const noop = () => {};

async function surfaces(s, original = false) {
  const { initializeI18n } = await s.ssrLoadModule('/src/i18n/index.js');
  const runtime = initializeI18n('fr');
  const load = async (file, name) => (await s.ssrLoadModule(`/src/components/${file}.jsx`))[name];
  const fade = await s.ssrLoadModule('/src/components/AudioEditorModal/fadeUtils.js');
  const fadeState = { fadeInSec: 1, fadeOutSec: 0, cutFadeSec: 0, outputFadeMax: 3, cutFadeMax: 2 };
  const components = {
    content: await load('MediaExplorer/MediaExplorerContent', 'MediaExplorerContent'),
    selection: await load('MediaExplorer/MediaSelectionBar', 'MediaSelectionBar'),
    deletion: await load('MediaExplorer/MediaDeleteDialog', 'MediaDeleteDialog'),
    banner: await load('MediaExplorer/MediaToolResultBanner', 'MediaToolResultBanner'),
    badge: await load('MediaExplorer/UsageBadge', 'UsageBadge'),
    tags: await load('MediaExplorer/TagSection', 'TagSection'),
    relink: await load('MissingMediaRelink/MissingMediaRelinkModal', 'MissingMediaRelinkModal'),
    triage: await load('SessionMediaTriage/SessionMediaTriageModal', 'SessionMediaTriageModal'),
    assembly: await load('AudioAssemblyModal/AudioAssemblyModal', 'AudioAssemblyModal'),
    splitter: await load('AudioSplitterModal/AudioSplitterModal', 'AudioSplitterModal'),
    editor: await load('AudioEditorModal/AudioEditorModal', 'AudioEditorModal'),
    transport: await load('AudioEditorModal/AudioEditorTransportBar', 'AudioEditorTransportBar'),
    overlays: await load('AudioEditorModal/AudioEditorFadeOverlays', 'AudioEditorFadeOverlays'),
    imageEditor: await load('ImageEditorModal/ImageEditorModal', 'ImageEditorModal'),
    record: await load('RecordModal/RecordModal', 'RecordModal'),
    packAudio: await load('layout/PackAudioProcessingFields', 'PackAudioProcessingFields'),
    subscriptions: original ? await load('MediaSubscriptions/MediaSubscriptionsPanel', 'MediaSubscriptionsPanel') : await load('MediaSubscriptions/MediaSubscriptionsToast', 'MediaSubscriptionsToast'),
  };
  const cols = new Set(['name', 'usage', 'size', 'dim', 'dur', 'fmt', 'date', 'path', 'tags']);
  const contentProps = { sortedVisible: [audio, image], visible: [audio, image], view: 'list', gridCols: '', visibleCols: cols, sortCol: 'name', sortDir: 'asc', onSortClick: noop, onStartResize: noop, headerRef: null, listScrollRef: null, onBackgroundClick: noop, onBackgroundContextMenu: noop, getMeta: () => null, markForProbe: noop, activePopover: null, onActivate: noop, onNavigate: noop, mediaTags: {}, tagsOf: () => ['_AUTHOR_TAG_'], allTags: ['_AUTHOR_TAG_'], onAddMediaTag: noop, onRemoveMediaTag: noop, onDeleteMedia: noop, onDeleteRequest: noop, selectedAudioItems: [], onOpenAssembly: noop, onOpenSplitter: noop, onEditImage: noop, selectedIds: new Set(), selectedItems: [], onSelectItem: noop, onContextMenuSelect: noop, onSelectNode: noop, onRevealGraphNode: noop, dropOnNode: noop, onImportMedia: noop, onImportStories: noop, onImportMediaFolder: noop };
  const scenarios = [
    ['content', { ...contentProps, isEmpty: true }],
    ['content', { ...contentProps, isEmpty: false, sortedVisible: [] }],
    ['content', { ...contentProps, isEmpty: false }],
    ['content', { ...contentProps, isEmpty: false, view: 'grid' }],
    ['selection', { selectedCount: 3, graphMediaTarget: null, onAssignToGraph: noop, selectedAudioItems: [audio, audio2], onCopyAudio: noop, onCutAudio: noop, onOpenAssembly: noop, onAddMediaTag: noop, bulkTag: '', onBulkTagChange: noop, bulkTagOpen: true, onBulkTagOpenChange: noop, allTags: ['_AUTHOR_TAG_'], visibleSelectedItems: [audio, audio2, image], onClear: noop }],
    ['selection', { selectedCount: 1, graphMediaTarget: { label: '_AUTHOR_TARGET_' }, onAssignToGraph: noop, selectedAudioItems: [audio], allTags: [], visibleSelectedItems: [audio], bulkTag: '' }],
    ['deletion', { items: [audio, { ...audio2, projectUsedCount: 3, inProject: true, usages: [] }], deleteDisk: false, canDeleteFromDisk: false, onDeleteDiskChange: noop, onCancel: noop, onConfirm: noop }],
    ['deletion', { items: [{ ...audio, usages: [], usageKnown: false }], deleteDisk: false, canDeleteFromDisk: false, onDeleteDiskChange: noop, onCancel: noop, onConfirm: noop }],
    ['deletion', { items: [audio2, { ...audio2, id: 'd' }], deleteDisk: true, canDeleteFromDisk: true, onDeleteDiskChange: noop, onCancel: noop, onConfirm: noop }],
    ['deletion', { items: [audio2], deleteDisk: false, canDeleteFromDisk: false, onDeleteDiskChange: noop, onCancel: noop, onConfirm: noop }],
    ['badge', { count: 0, known: false }],
    ['tags', { paths: ['/w/a', '/w/b'], mediaTags: {}, itemTags: [], allProjectTags: ['_AUTHOR_TAG_'], onAddMediaTag: noop, onRemoveMediaTag: noop }],
    ['tags', { paths: ['/w/a'], mediaTags: {}, itemTags: [], allProjectTags: [], onAddMediaTag: noop, onRemoveMediaTag: noop }],
    ['relink', { missingMedia: [{ path: '/_AUTHOR_old/_AUTHOR_x.mp3', fileName: '_AUTHOR_x.mp3', kind: 'audio', labels: ['_AUTHOR_LABEL_'], count: 1 }, { path: '/_AUTHOR_old/_AUTHOR_y.png', fileName: '_AUTHOR_y.png', kind: 'image', labels: [], count: 1 }, { path: '/_AUTHOR_other/_AUTHOR_z.zip', fileName: '_AUTHOR_z.zip', kind: 'archive', labels: [], count: 1 }], workspaceDir: '/_AUTHOR_w', onApply: noop, onClose: noop }],
    ['triage', { items: [{ path: '/_AUTHOR_s/voix-generees/_AUTHOR_1.wav', filename: '_AUTHOR_1.wav' }, { path: '/_AUTHOR_s/enregistrements/_AUTHOR_2.webm', filename: '_AUTHOR_2.webm' }], onResolve: noop }],
    ['triage', { items: [{ path: '/_AUTHOR_s/_AUTHOR_1.wav', filename: '_AUTHOR_1.wav' }], onResolve: noop }],
    ['assembly', { items: [audio, audio2], ignoredCount: 2, onClose: noop, onCreated: noop, contextRequest: { storyNames: ['_AUTHOR_S1_', '_AUTHOR_S2_'] }, projectAction: null, projectActionUnavailableReason: '' }],
    ['assembly', { items: [audio, audio2], ignoredCount: 1, onClose: noop, onCreated: noop, contextRequest: { storyNames: ['_AUTHOR_S1_', '_AUTHOR_S2_'] }, projectAction: 'replace-stories-with-assembly' }],
    ['splitter', { item: audio, onClose: noop, onCreated: noop, contextRequest: { storyNames: [''] } }],
    ['editor', { filePath: '/w/_AUTHOR_a.mp3', onConfirm: noop, onCancel: noop }],
    ['transport', { fadeInSec: 1, fadeOutSec: 0, fadeMax: 3, isPlaying: false, canOperate: true, canCut: true, onOpenFadePopover: noop }],
    ['transport', { fadeInSec: 0, fadeOutSec: 2, fadeMax: 3, isPlaying: true, onOpenFadePopover: noop }],
    ['overlays', { fadeContextMenu: { x: 0, y: 0, target: 'out' }, fadePopover: { x: 0, y: 0, target: 'in' }, currentFadeValue: () => 0, fadeConfig: (target) => fade.fadeConfig(target, fadeState), onOpenContextFadePopover: noop, onSetFadeValue: noop, onPopoverOk: noop }],
    ['overlays', { fadeContextMenu: { x: 0, y: 0, target: 'cut' }, fadePopover: { x: 0, y: 0, target: 'cut' }, currentFadeValue: () => 0, fadeConfig: (target) => fade.fadeConfig(target, fadeState), onOpenContextFadePopover: noop, onSetFadeValue: noop, onPopoverOk: noop }],
    ['overlays', { fadeContextMenu: { x: 0, y: 0, target: 'in' }, fadePopover: { x: 0, y: 0, target: 'out' }, currentFadeValue: () => 1, fadeConfig: (target) => fade.fadeConfig(target, fadeState), onOpenContextFadePopover: noop, onSetFadeValue: noop, onPopoverOk: noop }],
    ['imageEditor', { sourcePath: '/w/_AUTHOR_b.png', onConfirm: noop, onCancel: noop }],
    ['record', { workspaceDir: '/_AUTHOR_w', onSaved: noop, onClose: noop }],
    ['packAudio', { values: { silenceMode: 'add', harmonizeLoudness: true, leadingSilenceSec: 2 }, onChange: noop }],
    ['packAudio', { values: { silenceMode: 'normalize', harmonizeLoudness: false }, onChange: noop }],
    ['packAudio', { values: { silenceMode: 'off', harmonizeLoudness: true }, onChange: noop }],
    ['subscriptions', { subscriptions: [{ id: 's', title: '_AUTHOR_SRC_', projectName: '_AUTHOR_P_', source: 'youtube', status: 'missing', enabled: false }], notifications: [], toast: { id: 'n', title: '_AUTHOR_SRC_', projectName: '_AUTHOR_P_', source: 'podcast', count: 3 } }],
    ['subscriptions', { subscriptions: [{ id: 's', title: '_AUTHOR_SRC_', projectName: '_AUTHOR_P_', source: 'youtube', status: 'active', enabled: true }], notifications: [{ id: 'n' }, { id: 'm' }], toast: { id: 'n', title: '_AUTHOR_SRC_', projectName: '_AUTHOR_P_', source: 'youtube', count: 1 } }],
  ];
  const render = () => scenarios.map(([name, props]) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: runtime }, React.createElement(components[name], props))));
  return { runtime, render, components, s };
}

function assertPseudoSurface(html, label) {
  assert.doesNotMatch(html, /(?:media|native):[a-zA-Z]+\.|\[object Object\]/, label);
  const values = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1]);
  values.push(...[...html.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]+)"/g)].map(m => m[1]));
  for (const raw of values) {
    const value = raw.replaceAll('&#x27;', '\'').replaceAll('&amp;', '&').replaceAll('&quot;', '"');
    // Données marquées, glyphes, nombres, durées et extensions techniques.
    if (!/\p{L}{2,}/u.test(value) || value.includes('_AUTHOR_') || /^(?:YouTube|Podcast|\.webm|\{|\}|×[0-9.]+|[0-9.: +-]+(?:s|px|%|°)?|[A-Z0-9]{2,5}|\.[a-z0-9]{2,4}|voix-generees|enregistrements|fichiers-importes|images-generees)$/u.test(value.trim())) continue;
    // Fragment intérieur d’un <Trans> : voyelles pseudo-accentuées (ë, ï, ü) sans crochet.
    assert.ok(value.includes('[') || value.includes(']') || richPseudoFragments.has(value) || /[ëïü]/u.test(value), `${label} hors catalogue : ${value}`);
  }
}

test('Médias : FR identique à la source BASE indépendante, puis EN/IT/pseudo sans fuite', async () => {
  assert.equal(fixture.base, BASE);
  const now = await server(false), original = await server(true);
  try {
    const current = await surfaces(now), before = await surfaces(original, true);
    // M23 : le toast est conservé à l’identique ; seul le déclencheur permanent
    // est supprimé. Vérifier exactement les anciens déclencheurs avant retrait.
    const withoutRemovedTrigger = (html, index) => {
      if (index < 30) return html;
      const count = index === 30 ? '' : '<span class="media-subscriptions-count">2</span>';
      const label = index === 30 ? 'Notifications' : '2 notifications';
      const trigger = `<div class="media-subscriptions"><button type="button" class="media-subscriptions-trigger" aria-expanded="false" aria-controls="media-subscriptions-panel" aria-label="${label}">Notifications${count}</button></div>`;
      assert.ok(html.startsWith(trigger), `déclencheur BASE ${index}`);
      return html.slice(trigger.length);
    };
    const currentHtml = current.render();
    const currentFr = currentHtml.map(plain), beforeFr = before.render().map((html, index) => plain(withoutRemovedTrigger(applyShiftLabels(applyLot413(html)), index)));
    assert.equal(currentFr.length, beforeFr.length);
    // Changement UI volontaire : les deux choix restent, l'arrêt passe par Toggle.
    const packAudioScenarios = new Set([27, 28, 29]);
    currentFr.forEach((html, index) => {
      if (!packAudioScenarios.has(index)) assert.equal(html, beforeFr[index], `scénario ${index}`);
      else {
        const expected = beforeFr[index].replace('Ne rien faire', '')
          .replace('Ne touche pas aux silences de début et de fin.', 'Recommandé : mesure les silences et les ramène à exactement 0,4 s au début et 0,4 s à la fin (coupe si trop long, complète si trop court).');
        assert.equal(html, expected, `scénario ${index}`);
      }
    });
    // Attributs accessibles et infobulles compris : HTML FR complet identique.
    const beforeHtml = before.render().map((html, index) => withoutRemovedTrigger(applyShiftLabels(applyLot413(html)), index));
    currentHtml.forEach((html, index) => {
      if (!packAudioScenarios.has(index)) assert.equal(html, beforeHtml[index], `scénario ${index} (HTML)`);
      else {
        assert.match(html, /aria-label="Activer le traitement des silences de début et de fin"/);
        assert.doesNotMatch(html, /Ne rien faire/);
        assert.equal(/<fieldset[^>]*disabled=""[^>]*inert=""/.test(html), index === 29);
      }
    });
    for (const lng of ['en', 'it', 'pseudo']) {
      await current.runtime.changeLanguage(lng);
      const htmls = current.render();
      htmls.forEach((html, index) => {
        assert.doesNotMatch(html, /media:|native:|\[object Object\]/, `${lng} scénario ${index}`);
        if (lng === 'pseudo') assertPseudoSurface(html, `scénario ${index}`);
        // Les infobulles (Tooltip) ne sont rendues qu'au survol : un scénario sans texte
        // ni attribut accessible n'a rien à comparer en SSR (recette manuelle).
        else if (/\p{L}{2,}/u.test(plain(currentHtml[index]).replaceAll('_AUTHOR_', '')) || /(?:title|aria-label|placeholder)="/.test(currentHtml[index])) {
          assert.notEqual(html, currentHtml[index], `${lng} scénario ${index} identique au FR`);
        }
      });
    }
    await current.runtime.changeLanguage('fr');
    // L'épreuve pseudo détecte bien un texte resté hors catalogue (mutation en mémoire).
    assert.throws(() => assertPseudoSurface('<span title="Vue grille">x</span>', 'mutation'), /hors catalogue : Vue grille/);
    assert.throws(() => assertPseudoSurface('<p>Aucun média pour ce filtre.</p>', 'mutation'), /hors catalogue/);
  } finally { await now.close(); await original.close(); }
});

// Comparaison FR indépendante : chaque segment statique d'une valeur FR figure
// dans la source BASE (git show), pas dans le code converti.
test('chaque texte FR du catalogue provient de la source BASE', () => {
  const sources = Object.values(fixture.sources).join('\n')
    .replaceAll('\\\'', '\'').replaceAll('\\n', '\n')
  // Lot 4.13 : corrections FR explicites appliquées à la source BASE.
  const sourcesFixed = applyShiftLabels(applyLot413(sources));
  // Gabarits réassemblés depuis des ternaires/fragments BASE, vérifiés par le rendu SSR ci-dessus
  // ou par les tests ciblés de ce fichier ; libellés neutres de pluriels créés par CLDR.
  const composed = new Set([
    'toolResult.created.count_one', 'toolResult.split.count_one', 'delete.reason.count_one', 'delete.used.count_one', 'delete.used.message_one',
    'selection.count_one', 'selection.audio.copy_one', 'selection.audio.cut_one', 'tile.audio.assemble_one', 'tile.audio.assemble_many', 'tile.drag.sounds_one',
    'tile.files.remove_one', 'tile.files.remove_many', 'explorer.removal.diskCount_one', 'explorer.split.created_one', 'explorer.split.created_many',
    'explorer.split.created_other', 'explorer.split.failed_one', 'explorer.split.failed_many', 'explorer.split.failed_other', 'explorer.split.failedSummary',
    'assembly.context.stories_one', 'assembly.ignored.notice_one', 'assembly.ignored.notice_many', 'assembly.ignored.notice_other',
    'assembly.project.unchanged', 'assembly.project.unchangedReason', 'triage.unused.count_many', 'triage.unused.count_other',
    'relink.row.ambiguous_one', 'relink.remaining.count_one', 'relink.group.resolved_one', 'relink.group.missing_one',
    'relink.group.resolved_many', 'relink.group.resolved_other', 'relink.group.missing_many', 'relink.group.missing_other',
    'subscriptions.newVideos.count_one', 'subscriptions.newVideos.count_many', 'subscriptions.newVideos.count_other',
    'subscriptions.newEpisodes.count_one', 'subscriptions.newEpisodes.count_many', 'subscriptions.newEpisodes.count_other',
    'tile.usage.line', 'popover.image.size', 'usage.label.homeStep', 'explorer.tags.bulkHeader',
    'splitter.segment.defaultName', 'record.preview.playing', 'record.preview.paused', 'record.duration.label', 'relink.progress.label_one', 'relink.progress.label_many', 'relink.progress.label_other', 'relink.ready.label_one', 'relink.ready.label_many', 'relink.ready.label_other',
    'triage.copy.incompleteMessage', 'transfer.incomplete.message',
    // Nouveau contrôle UI, absent de la source BASE : vérifié en SSR ci-dessus.
    'packAudio.silence.ariaLabel',
  ]);
  // Nouveaux avertissements du relink : absents de BASE, ajout visible volontaire.
  const scanWarnings = {
    'relink.scan.truncated': 'Recherche incomplète : limite de {{limit}} fichiers atteinte. Choisissez un dossier plus précis ou les fichiers restants individuellement.',
    'relink.scan.unreadable': 'Recherche incomplète : des dossiers sont illisibles ({{count}}). Vérifiez leur accès ou choisissez les fichiers restants individuellement.',
  };
  for (const [key, value] of Object.entries(scanWarnings)) assert.equal(fr[key], value);
  // Nouveau rappel volontaire au démarrage, absent de BASE : attentes explicites.
  const startupReminder = {
    'subscriptions.reminder.title': 'Nouveautés en attente',
    'subscriptions.reminder.action': 'Voir',
    'subscriptions.reminder.count_one': '{{count}} suivi a des nouveautés',
    'subscriptions.reminder.count_many': '{{count}} suivis ont des nouveautés',
    'subscriptions.reminder.count_other': '{{count}} suivis ont des nouveautés',
  };
  for (const [key, value] of Object.entries(startupReminder)) assert.equal(fr[key], value);
  assert.equal(fr['subscriptions.section.title'], 'Suivis des médias');
  const missing = [];
  for (const [key, value] of Object.entries(fr)) {
    if (Object.hasOwn(scanWarnings, key) || Object.hasOwn(startupReminder, key) || key === 'subscriptions.section.title') continue;
    if (composed.has(key)) continue;
    const segments = value.split(/{{[^}]+}}|<\/?strong>/).map((part) => part.trim()).filter((part) => /\p{L}/u.test(part));
    if (segments.some((segment) => !sourcesFixed.includes(segment))) missing.push(key);
  }
  assert.deepEqual(missing, []);
});

test('pluriels CLDR 0/1/2/1 000 000, sans _zero, count transmis', () => {
  const runtime = createTestI18n();
  const plural = (catalogue) => [...new Set(Object.keys(catalogue).filter(k => /_(one|many|other)$/.test(k)).map(k => k.replace(/_(one|many|other)$/, '')))];
  const sets = [['media', { fr, en, it }], ['native', { fr: frNative, en: enNative, it: itNative }]];
  for (const lng of ['fr', 'en', 'it']) {
    runtime.changeLanguage(lng);
    for (const [ns, catalogues] of sets) {
      const catalogue = catalogues[lng];
      assert.ok(!Object.keys(catalogue).some(k => k.endsWith('_zero')));
      for (const base of plural(catalogues.fr)) {
        for (const count of [0, 1, 2, 1000000]) {
          const category = new Intl.PluralRules(lng).select(count);
          const expected = catalogue[`${base}_${category}`].replaceAll('{{count}}', String(count)).replaceAll('{{files}}', 'F');
          assert.equal(runtime.t(`${ns}:${base}`, { count, files: 'F' }), expected, `${lng} ${ns}:${base} ${count}`);
        }
      }
    }
  }
  // FR : 0 au singulier (convention CLDR du chantier), 1 000 000 en « many ».
  runtime.changeLanguage('fr');
  assert.equal(runtime.t('media:selection.count', { count: 0 }), '0 sélectionné');
  assert.equal(runtime.t('media:selection.count', { count: 2 }), '2 sélectionnés');
  assert.equal(runtime.t('media:selection.count', { count: 1000000 }), '1000000 sélectionnés');
});

test('relink : progression et pied accordés par count (0/1/2/1 000 000, FR/EN/IT)', () => {
  const runtime = createTestI18n();
  const expected = {
    fr: { progress: ['0 relié sur 3', '1 relié sur 3', '2 reliés sur 3', '1000000 reliés sur 3'], ready: ['0 / 3 prêt à appliquer', '1 / 3 prêt à appliquer', '2 / 3 prêts à appliquer', '1000000 / 3 prêts à appliquer'] },
    en: { progress: ['0 of 3 relinked', '1 of 3 relinked', '2 of 3 relinked', '1000000 of 3 relinked'], ready: ['0 / 3 ready to apply', '1 / 3 ready to apply', '2 / 3 ready to apply', '1000000 / 3 ready to apply'] },
    it: { progress: ['0 su 3 ricollegati', '1 su 3 ricollegato', '2 su 3 ricollegati', '1000000 su 3 ricollegati'], ready: ['0 / 3 pronti da applicare', '1 / 3 pronto da applicare', '2 / 3 pronti da applicare', '1000000 / 3 pronti da applicare'] },
  };
  for (const lng of ['fr', 'en', 'it']) {
    runtime.changeLanguage(lng);
    [0, 1, 2, 1000000].forEach((count, index) => {
      assert.equal(plain(runtime.t('media:relink.progress.label', { count, total: 3 })), expected[lng].progress[index], `${lng} progress ${count}`);
      assert.equal(plain(runtime.t('media:relink.ready.label', { count, total: 3 })), expected[lng].ready[index], `${lng} ready ${count}`);
    });
  }
});

test('règle d’or : fuite FR détectée par mutation en mémoire, neutres nominatifs seulement', () => {
  const clean = checkCatalogues({ fr: { media: fr }, en: { media: en }, it: { media: it } }, { media: meta });
  assert.deepEqual(clean.errors, []);
  for (const [lng, key] of [['en', 'explorer.empty.title'], ['it', 'assembly.title']]) {
    const resources = { fr: { media: fr }, en: { media: structuredClone(en) }, it: { media: structuredClone(it) } };
    resources[lng].media[key] = fr[key];
    assert.ok(checkCatalogues(resources, { media: meta }).errors.includes(`${lng}/media:${key} règle d’or : texte français`));
  }
  for (const key of Object.keys(fr)) {
    assert.ok(meta[key]?.context?.length > 20, `contexte ${key}`);
    for (const lng of ['en', 'it']) if (Object.hasOwn({ en, it }[lng], key)) assert.equal(meta[key][lng].status, 'ai-reviewed');
  }
});

test('descripteurs retenus : refus, erreurs et dialogues relus FR → EN → IT sans mutation', async () => {
  i18next.init(createTestI18n().options);
  const project = { projectType: 'pack', rootAudio: '/w/_AUTHOR_root.wav', rootEntries: [
    { id: 's1', type: 'story', name: '', audio: '' },
    { id: 'm1', type: 'menu', name: '', children: [{ id: 's2', type: 'story', name: '_AUTHOR_S2_', audio: '/w/_AUTHOR_s2.wav' }] },
  ], globalOptions: {} };
  const before = JSON.stringify(project);
  const missingAudio = resolveAudioStoriesInProjectOrder(project, ['s1']);
  const mixed = buildMediaAudioToolRequest({ project, entryIds: ['m1'], tool: 'split', requestId: 'r' });
  const replaced = replaceStoriesWithAssembledStory(project, { entryIds: ['s2'], outputPath: '' });
  const library = () => collectMediaLibrary({ project });
  const stored = { userMessage: { code: 'FILES_MEDIA_COPY', params: { error: 'RAW' }, detail: 'RAW' }, prefix: { key: 'media:record.write.failedPrefix' } };
  const expectations = {
    fr: ['L’histoire « sans nom » ne possède pas d’audio principal.', 'Sélectionne uniquement des histoires.', 'Accueil'],
    en: ['The story “untitled” has no main audio.', 'Select only stories.', 'Cover'],
    it: ['La storia «senza nome» non ha un audio principale.', 'Seleziona solo storie.', 'Copertina'],
  };
  const tagAtCreation = {};
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    assert.equal(missingAudio.code, 'missing-audio'); assert.notEqual(missingAudio.code, 'mixed-selection');
    assert.deepEqual(missingAudio.reasonRef, { key: 'media:tool.refusal.missingAudio', params: { name: { key: 'media:story.unnamed' } } });
    assert.equal(missingAudio.reason, expectations[lng][0]);
    assert.equal(mixed.code, 'mixed-selection'); assert.equal(mixed.reason, expectations[lng][1]);
    assert.equal(replaced.ok, false); assert.equal(replaced.code, 'missing-output'); assert.equal(replaced.reason, presentMedia({ key: 'media:tool.refusal.missingOutput' }));
    assert.equal(library().find(item => item.path === '/w/_AUTHOR_root.wav').usages[0].label, expectations[lng][2]);
    assert.equal(library().find(item => item.path === '/w/_AUTHOR_s2.wav').usages[0].label, '_AUTHOR_S2_');
    const shown = presentStoredError(stored);
    assert.ok(shown.startsWith(i18next.t('media:record.write.failedPrefix')));
    assert.ok(shown.endsWith(presentUserMessage(stored.userMessage).message));
    assert.doesNotMatch(shown, /\[object Object\]|media:/);
    tagAtCreation[lng] = getEditedImageTags({}, '/w/x.png');
    assert.deepEqual(fadeConfig('in', { fadeInSec: 1, outputFadeMax: 2 }), { labelKey: 'media:audioEditor.fade.in', value: 1, max: 2 });
  }
  assert.deepEqual(tagAtCreation, { fr: ['modifiée'], en: ['edited'], it: ['modificata'] });
  assert.equal(JSON.stringify(project), before, 'aucune mutation du projet');
  await i18next.changeLanguage('fr');
});

test('suivi des médias : registre neutre (clés), refus de lecture codés et relus dans la langue active', async () => {
  i18next.init(createTestI18n().options);
  assert.equal(REGISTRY_UNREADABLE_ERROR, 'media:subscriptions.registry.unreadable');
  assert.equal(REGISTRY_WRITE_ERROR, 'media:subscriptions.registry.writeFailed');
  const errors = [];
  try { await fetchSubscriptionSnapshot({ source: 'podcast', url: 'u' }, async () => ({ title: 'x' })); } catch (error) { errors.push(error); }
  try { await fetchSubscriptionSnapshot({ source: 'podcast', url: 'u' }, async () => ({ episodes: [{ id: '' }] })); } catch (error) { errors.push(error); }
  assert.deepEqual(errors.map(error => error.code), ['SUBSCRIPTION_SOURCE_INCOMPLETE', 'SUBSCRIPTION_SOURCE_UNSTABLE_ID']);
  assert.deepEqual(errors.map(error => error.presentationRef.key), ['media:subscriptions.source.incomplete', 'media:subscriptions.source.unstableId']);
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    assert.equal(errors[0].message, i18next.t('media:subscriptions.source.incomplete'));
    const presented = presentUserMessage(errors[1]);
    assert.equal(presented.message, i18next.t('media:subscriptions.source.unstableId'));
    assert.equal(presented.fallback, false); assert.notEqual(presented.code, 'UNEXPECTED_ERROR');
    if (lng !== 'fr') assert.ok(!errors[0].message.includes('incomplète'));
  }
  await i18next.changeLanguage('fr');
});

test('refus d’outil : mediaRefusal garde le code et la clé, le texte suit la langue', async () => {
  i18next.init(createTestI18n().options);
  const refusal = mediaRefusal({ ok: false, code: 'not-consecutive' }, 'media:tool.refusal.notConsecutive');
  const eligibility = getAssemblyReplacementEligibility({ projectType: 'pack', rootEntries: [{ id: 'a', type: 'story', audio: '/a' }], globalOptions: {} }, ['a']);
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    assert.equal(refusal.code, 'not-consecutive'); assert.equal(refusal.reason, i18next.t('media:tool.refusal.notConsecutive'));
    assert.equal(eligibility.code, 'assemble-count'); assert.equal(eligibility.reason, i18next.t('media:tool.refusal.twoStoriesNeeded'));
    assert.equal(JSON.parse(JSON.stringify(refusal)).reasonRef.key, 'media:tool.refusal.notConsecutive');
  }
  await i18next.changeLanguage('fr');
});

test('media subscriptions preferences section renders in FR, EN, IT and pseudo', async () => {
  const s = await server(false);
  try {
    const { initializeI18n } = await s.ssrLoadModule('/src/i18n/index.js');
    const runtime = initializeI18n('fr');
    const { MediaSubscriptionsSection } = await s.ssrLoadModule('/src/tabs/OptionsTab/MediaSubscriptionsSection.jsx');
    for (const language of ['fr', 'en', 'it', 'pseudo']) {
      await runtime.changeLanguage(language);
      const html = renderToStaticMarkup(React.createElement(MediaSubscriptionsSection, { className: 'opts-card', subscriptions: {} }));
      assert.match(html, /<section id="media-subscriptions" class="opts-card">/);
      assert.doesNotMatch(html, /media:|\[object Object\]|media-subscriptions-trigger/);
      if (language === 'pseudo') assertPseudoSurface(html, 'section suivis');
      else assert.ok(plain(html).includes(({ fr, en, it })[language]['subscriptions.section.title']));
    }
  } finally { await s.close(); }
});
