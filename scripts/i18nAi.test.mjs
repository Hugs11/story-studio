import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import i18next from 'i18next';
import { sources, BASE } from './i18nAiSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { checkCatalogues, AI_NEUTRAL_KEYS, sourceHash } from './check-i18n.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import fr from '../src/locales/fr/ai.json' with { type: 'json' };
import en from '../src/locales/en/ai.json' with { type: 'json' };
import it from '../src/locales/it/ai.json' with { type: 'json' };
import meta from '../src/locales/_meta/ai.json' with { type: 'json' };
import { aiRef, presentAi } from '../src/i18n/aiPresentation.js';
import { presentUserMessage, presentStoredError, userMessageTransport } from '../src/i18n/userMessage.js';
import { getImageJobTargetRef } from '../src/store/aiJobLabels.js';

const resources = { fr: { ai: fr }, en: { ai: en }, it: { ai: it } };
// Lot select A : ces listes natives sont devenues le composant Select, fermé par défaut : seule l'option choisie
// est dans le DOM. L'ancien rendu est donc ramené à son option choisie (le texte visible reste celui de la source ; sans option choisie, le navigateur affiche la première).
const collapseNativeSelect = (html, isMigrated) => html.replace(/<select\b[^>]*>[\s\S]*?<\/select>/g, (block) => (
  isMigrated(block) ? `<span>${(block.match(/<option\b[^>]*\bselected=""[^>]*>([\s\S]*?)<\/option>/) ?? block.match(/<option\b[^>]*>([\s\S]*?)<\/option>/))?.[1] ?? ''}</span>` : block
));
const plain = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
function assertSurface(html) {
  assert.doesNotMatch(html, /ai:[a-z]+\.|\[object Object\]/);
  const texts = [...html.matchAll(/>([^<>]+)</g), ...html.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map(m => m[1].trim());
  for (const value of texts) {
    if (!/\p{L}{2}/u.test(value) || value.includes('_AUTHOR_') || ['Piper', 'XTTS', 'CPU', 'GPU CUDA', 'ComfyUI', 'voix-générées/', 'lunii_style, simple illustration, black and white line art, grayscale, children book style,', 'color, photo, realistic, watermark, text'].includes(value)) continue;
    assert.ok(value.includes('[') || /[ëïü]/.test(value), `hors catalogue : ${value}`);
  }
}
async function server(original = false) {
  return createServer({ configFile: false, plugins: [{ name: 'ai-source-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    if (id.endsWith('/common/Tooltip.jsx')) return 'import { createElement } from "react"; export function Tooltip({text,children}) { return createElement("span",{title:text},children); }';
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile(path) { return path; }';
    if (id.endsWith('/ProjectContext.js')) return 'export function useProjectContext() { return {workspaceDir:""}; }';
    if (id.endsWith('/TextImagePromptModal.jsx')) code = code.replace("import { createPortal } from 'react-dom';", '').replace('return createPortal(', 'return (').replace(/,\s*document.body,\s*\);/, ');');
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

// Les valeurs sont vérifiées contre les sources indépendantes, pas contre le nouveau rendu.
test('IA : source française figée, métadonnées et règle d’or par mutation', () => {
  assert.equal(BASE, 'ae7fa04f797c490441e360a10e031797f18705d0');
  assert.deepEqual(checkCatalogues(resources, { ai: meta }).errors, []);
  // Lot 4.13 : corrections FR explicites appliquées à la source BASE.
  const original = applyLot413(Object.values(sources).join('\n'));
  const templates = new Set(['voice.text.emptyCount', 'voice.text.tooLong', 'voice.output.help', 'voice.speed.label', 'voice.option.download', 'queue.progress.label', 'queue.image.preview', 'queue.audio.stopFile', 'queue.audio.playFile', 'image.submit.multiple', 'usage.screen.detail', 'usage.node.detail', 'usage.node.modified', 'usage.field.missing', 'usage.node.homeStep', 'target.story.home', 'target.stage.image', 'target.story.selection', 'target.folder.image', 'queue.example.target']);
  for (const [key, value] of Object.entries(fr)) {
    // Lot 4.13 : queue.example.target relue (statut ai → ai-reviewed).
    assert.equal(meta[key].en?.status ?? 'ai-reviewed', 'ai-reviewed');
    for (const lng of ['en', 'it']) if (key in resources[lng].ai) assert.equal(meta[key][lng].sourceHash, sourceHash(value));
    if (templates.has(key) || /_one|_many|_other/.test(key)) continue;
    // « Envoi... » / « Génération... » : la source corrigée (applyLot413) porte déjà « … ».
    const old = value;
    // Les options Piper sont une table partagée hors périmètre, figées ci-dessous.
    if (key === 'voice.language.enGB' || key === 'voice.language.enUS') { assert.equal(value, key.endsWith('GB') ? 'English UK' : 'English US'); continue; }
    assert.ok(original.includes(old) || original.includes(old.replaceAll('\n', '\\n').replaceAll("'", "\\'")), `${key} n’existe pas dans la source de base`);
  }
  for (const lng of ['en', 'it']) {
    const mutated = structuredClone(resources); mutated[lng].ai['voice.text.label'] = fr['voice.text.label'];
    assert.ok(checkCatalogues(mutated, { ai: meta }).errors.some(e => e.includes(`${lng}/ai:voice.text.label règle d’or`)));
    for (const [k, v] of Object.entries(resources[lng].ai)) if (!AI_NEUTRAL_KEYS[lng].has(k)) assert.notEqual(v, fr[k], `${lng}:${k}`);
  }
  assert.equal(fr['queue.status.submitting'], 'Envoi…');
  assert.equal(fr['queue.status.running'], 'Génération…');
});

test('IA : compteurs CLDR, enveloppes IPC, paramètres et état conservé à chaud', async () => {
  i18next.init(createTestI18n().options);
  const target = getImageJobTargetRef({ fieldId: 's:itemImage' }, { entryById: new Map() });
  const state = { error: aiRef('ai:voice.text.empty'), target, request: { text: 'Auteur récit...', language: 'fr', voice: 'v' } };
  const before = JSON.stringify(state); const seen = [];
  const coded = { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' };
  const serialized = userMessageTransport(coded);
  assert.deepEqual(JSON.parse(serialized), coded);
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    seen.push([presentStoredError(state.error), presentAi(target)]);
    const result = presentUserMessage(serialized, { allowLegacyFrench: false });
    assert.equal(result.code, coded.code); assert.equal(result.fallback, false); assert.equal(result.technicalDetail, '_RAW_TOOL_');
    for (const envelope of [
      { code: 'COMFYUI_WORKFLOW_NOT_FOUND', params: { workflowId: '_AUTHOR_WORKFLOW_' } },
      { code: 'COMFYUI_PROGRESS_STEPS', params: { value: 2, max: 20 } },
    ]) {
      const transport = userMessageTransport(envelope);
      assert.deepEqual(JSON.parse(transport), envelope);
      const presentation = presentUserMessage(transport, { allowLegacyFrench: false });
      assert.equal(presentation.code, envelope.code); assert.equal(presentation.fallback, false);
      assert.notEqual(presentation.code, 'COMFYUI_SERVICE_ERROR');
      assert.doesNotMatch(presentation.message, /\[object Object\]/);
    }
    assert.notEqual(result.code, 'XTTS_SERVICE_ERROR'); assert.doesNotMatch(result.message, /\[object Object\]/);
    assert.equal(i18next.t('ai:voice.text.emptyCount', { count: 0 }), resources[language].ai['voice.text.emptyCount'].replaceAll('{{count}}', 0));
    assert.equal(Object.keys(resources[language].ai).some(key => key.endsWith('_zero')), false);
    for (const count of [0, 1, 2, 1000000]) for (const base of ['voice.text.count', 'usage.audio.count', 'usage.image.count', 'usage.graphImage.count']) {
      const category = new Intl.PluralRules(language).select(count);
      const expected = resources[language].ai[`${base}_${category}`].replaceAll('{{count}}', count);
      assert.equal(i18next.t(`ai:${base}`, { count }), expected);
    }
    assert.equal(JSON.stringify(state), before);
  }
  assert.notEqual(seen[0][0], seen[1][0]); assert.notEqual(seen[0][1], seen[2][1]);
  await i18next.changeLanguage('fr');
});

test('IA : FR rendu contre git show BASE, EN/IT et surface pseudo avec attributs', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const runtime = initializeI18n('fr');
    for (const [ns, values] of Object.entries(pseudoResources(runtime.options.resources.fr))) runtime.addResourceBundle('pseudo', ns, values);
    const scenarios = [
      ['GenerateVoiceModal/GenerateVoiceModal', 'GenerateVoiceModal', { xttsSettings: { backend: 'piper' }, label: '_AUTHOR_LABEL_', initialText: '_AUTHOR_TEXT_' }],
      ['GenerateVoiceModal/GenerateVoiceModal', 'GenerateVoiceModal', { xttsSettings: { backend: 'xtts' }, label: '_AUTHOR_LABEL_', initialText: '_AUTHOR_TEXT_' }],
      ['SDGenerateModal/SDGenerateModal', 'SDGenerateModal', {}],
      ['TextImageGenerator/TextImagePromptModal', 'TextImagePromptModal', {}],
      ['SDQueuePanel/SDQueuePanel', 'SDQueuePanel', {}],
      ...['pending', 'submitting', 'running', 'done'].map(status => ['SDQueuePanel/SDQueuePanel', 'SDQueuePanel', { imageJobs: [{ id: 'i', status, resultPaths: ['/w/_AUTHOR_IMAGE_.png'] }], audioJobs: [{ id: 'a', status: 'done', kind: 'audio', resultPath: '/w/_AUTHOR_AUDIO_.wav' }] }]),
    ];
    for (const [file, name, props] of scenarios) {
      const now = (await current.ssrLoadModule(`/src/components/${file}.jsx`))[name];
      const old = (await original.ssrLoadModule(`/src/components/${file}.jsx`))[name];
      const render = component => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: runtime }, React.createElement(component, props)));
      await runtime.changeLanguage('fr');
      assert.equal(plain(render(now)), plain(applyLot413(name === 'GenerateVoiceModal' ? collapseNativeSelect(render(old), block => block.includes('tts-input')) : render(old))).replace('Envoi...', 'Envoi…').replace('Génération...', 'Génération…'), name);
      for (const language of ['en', 'it', 'pseudo']) {
        await runtime.changeLanguage(language); const html = render(now);
        assert.doesNotMatch(html, /\[object Object\]|ai:[a-z]+\./);
        if (language === 'pseudo') assertSurface(html);
      }
    }
    assert.throws(() => assertSurface('<span title="Texte à lire">Texte à lire</span>'), /hors catalogue/);
  } finally { await current.close(); await original.close(); }
});

test('IA : usages rendus et replis de destination comparés aux sources indépendantes', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values);
    const now = await current.ssrLoadModule('/src/hooks/useAiJobUsage.js'); const old = await original.ssrLoadModule('/src/hooks/useAiJobUsage.js');
    const entries = [{ id: 'm', type: 'menu', name: '', audio: '/a', image: '/i' }, { id: 's', type: 'story', name: '', itemAudio: '/a', audio: '/b', itemImage: '/i' }];
    const index = { entryById: new Map(entries.map(e => [e.id, e])), flatEntries: entries };
    const audio = { kind: 'audio', status: 'done', resultPath: '/a' }, image = { status: 'done', resultPaths: ['/i'] };
    const scenarios = [
      [{ rootAudio: '/a', rootImage: '/i' }, null, audio, image],
      [{}, null, { ...audio, resultPath: '/missing', target: { kind: 'story', entryId: 's', field: 'audio' } }, { ...image, resultPaths: ['/missing'] }],
      [{}, null, { ...audio, resultPath: '/missing', target: { kind: 'story', entryId: 'absent', field: 'audio' } }, image],
      ...[null, [], [{ assetRef: 'ref', usages: [{ field: 'image', label: '_AUTHOR_SCREEN_' }, { field: 'audio', label: '_AUTHOR_SCREEN2_' }] }]].map(usages => [{ authoringMode: 'advanced', authoring: { mediaBindings: [{ assetRef: 'ref', path: '/i' }] } }, usages, { ...audio, resultPath: '/i' }, image]),
    ];
    for (const [project, advancedMediaUsages, a, i] of scenarios) {
      const before = JSON.stringify(project);
      const render = module => {
        function Usage() { const usage = module.useAiJobUsage({ project, projectIndex: index, advancedMediaUsages }); return React.createElement('div', null, ...[usage.getAudioJobUsage(a), usage.getImageJobUsage(i)].map((u, n) => React.createElement('span', { key: n, title: u.detail }, u.label))); }
        return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Usage)));
      };
      await engine.changeLanguage('fr'); assert.equal(render(now), applyLot413(render(old)));
      await engine.changeLanguage('pseudo'); assertSurface(render(now));
      assert.equal(JSON.stringify(project), before);
    }
    const currentLabels = await current.ssrLoadModule('/src/store/aiJobLabels.js'); const originalLabels = await original.ssrLoadModule('/src/store/aiJobLabels.js');
    await engine.changeLanguage('fr');
    for (const fieldId of ['root:coverImage', 'root:rootImage', 'root:thumbnailImage', 's:homeStep:image', 'stage:s:image', 's:itemImage', 'm:image']) assert.equal(currentLabels.getImageJobTargetLabel({ fieldId }, index), applyLot413(originalLabels.getImageJobTargetLabel({ fieldId }, index)));
    const drawing = await current.ssrLoadModule('/src/components/TextImageGenerator/drawTextImage.js');
    const calls = []; const ctx = { fillRect() {}, measureText: text => ({ width: text.length }), fillText: text => calls.push(text) };
    for (const lng of ['fr', 'en', 'it']) { await engine.changeLanguage(lng); calls.length = 0; drawing.drawTextImage(ctx, ''); assert.equal(calls.join(' '), engine.t('ai:textImage.title.fallback')); calls.length = 0; drawing.drawTextImage(ctx, '_AUTHOR_TEXT_'); assert.equal(calls.join(' '), '_AUTHOR_TEXT_'); }
  } finally { await current.close(); await original.close(); }
});

test('modale vide : français historique à zéro identique au composant de BASE', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const now = (await current.ssrLoadModule('/src/components/GenerateVoiceModal/GenerateVoiceModal.jsx')).GenerateVoiceModal;
    const old = (await original.ssrLoadModule('/src/components/GenerateVoiceModal/GenerateVoiceModal.jsx')).GenerateVoiceModal;
    const render = component => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component, { xttsSettings: { backend: 'piper' }, initialText: '' })));
    const countText = html => html.match(/class="tts-count">([^<]+)</)?.[1].trim();
    assert.equal(countText(render(old)), '0 caractères');
    assert.equal(countText(render(now)), countText(render(old)));
    assert.equal(countText(render(now)), '0 caractères');
    assert.equal(new Intl.PluralRules('fr').select(0), 'one');
    assert.equal(Object.keys(fr).some(key => key.endsWith('_zero')), false);
    assert.equal(fr['voice.text.emptyCount'], '{{count}} caractères');
    for (const backend of ['piper', 'xtts']) {
      for (const count of [0, 1, 2, 1000000]) {
        const props = { xttsSettings: { backend }, initialText: 'x'.repeat(count) };
        const markup = component => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component, props)));
        assert.equal(countText(markup(now)), countText(markup(old)), `${backend}: ${count}`);
      }
    }
  } finally { await current.close(); await original.close(); }
});
