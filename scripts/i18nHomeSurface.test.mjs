import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/home-fr-base-sources.json' with { type: 'json' };
import { applyLot413 } from './i18nLot413Corrections.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { I18nextProvider } from 'react-i18next';

const BASE = 'aa8801c85ca6c2ac0ae1e8915c4f8241d64e0d7d';
const callbacks = Object.fromEntries(['onSelect', 'onSelectGraph', 'onEditPack', 'onPodcastFunnel', 'onYoutubeFunnel', 'onAggregatePacks', 'onCheckPack', 'onOpen', 'onClose'].map((key) => [key, () => {}]));
assert.equal(fixture.base, BASE);
const sourceAtBase = (file) => fixture.sources[file];
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function surfaceServer(original = false) {
  return createServer({ configFile: false, plugins: [{ name: 'home-surface-fixtures', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/Dialog.jsx')) code = code.replace("import { createPortal } from 'react-dom';", 'const createPortal = (children) => children;').replace('function Dialog(', 'export function Dialog(').replace('document.body,', 'null,');
    if (id.endsWith('/AppModalPortal.jsx')) return 'export function AppModalPortal({children}) { return children; }';
    // Ces surfaces appartiennent aux prochains lots ; leurs props visibles sont conservées.
    if (id.endsWith('/ImageField.jsx')) return 'export function ImageField({badge,formatHint}) { return <div><span>{badge}</span><span>{formatHint}</span></div>; }';
    if (id.endsWith('/PackAudioProcessingFields.jsx')) return 'export function PackAudioProcessingFields() { return null; }';
    if (original && /\/(ModeSelector|AggregatePacksFunnel|PackNameModal)\.jsx$/.test(id)) code = sourceAtBase(id.slice(id.indexOf('/src/') + 1));
    if (id.endsWith('/AggregatePacksFunnel.jsx')) code = code
      .replace('const [step, setStep] = useState(0)', 'const [step, setStep] = useState(globalThis.__homeFixture.step)')
      .replace('const [phase, setPhase] = useState(\'collect\')', 'const [phase, setPhase] = useState(globalThis.__homeFixture.phase)')
      .replace('const [packs, setPacks] = useState([])', 'const [packs, setPacks] = useState(globalThis.__homeFixture.packs)')
      .replace('const [packs, setPacks] = useState(() => preparation ? assemblyPacks(preparation) : [])', 'const [packs, setPacks] = useState(globalThis.__homeFixture.packs)')
      .replace('const [result, setResult] = useState(null)', 'const [result, setResult] = useState(globalThis.__homeFixture.result)');
    if (id.endsWith('/PackNameModal.jsx')) code = code.replace('const [saving, setSaving] = useState(null)', 'const [saving, setSaving] = useState(globalThis.__homeFixture.saving ?? null)');
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

async function load(server) {
  const engine = await server.ssrLoadModule('/src/i18n/index.js');
  const { ModeSelector } = await server.ssrLoadModule('/src/components/ModeSelector/ModeSelector.jsx');
  const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
  const { AggregatePacksFunnel } = await server.ssrLoadModule('/src/components/AggregatePacks/AggregatePacksFunnel.jsx');
  const { PackNameModal } = await server.ssrLoadModule('/src/components/layout/PackNameModal.jsx');
  const { FunnelFooter } = await server.ssrLoadModule('/src/components/funnels/FunnelFooter.jsx');
  const { FunnelGenerationState } = await server.ssrLoadModule('/src/components/funnels/FunnelGenerationState.jsx');
  const { FunnelDoneState } = await server.ssrLoadModule('/src/components/funnels/FunnelDoneState.jsx');
  const runtime = engine.initializeI18n('fr');
  const render = (component, props) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: runtime }, React.createElement(component, props)));
  return { runtime, render, ModeSelector, ErrorDialogProvider, AggregatePacksFunnel, PackNameModal, FunnelFooter, FunnelGenerationState, FunnelDoneState };
}

const pack = { id: '_AUTHOR_ID_', name: '_AUTHOR_TITLE_', fileName: '_AUTHOR_FILE_.zip', path: '/_AUTHOR_PATH_.zip', storyCount: 2, sizeBytes: 1024 * 1024 };
const scenarios = (s) => [
  () => s.render(s.ErrorDialogProvider, { children: React.createElement(s.ModeSelector, { ...callbacks, recentProjects: [{ ...pack, projectName: '_AUTHOR_NAME_', projectType: 'pack', updatedAt: Date.now() }], sessionRecoveries: [{ sessionDir: '/_AUTHOR_SESSION_', projectName: '', projectType: 'simple', modifiedAtMs: Date.now() - 86400000 }] }) }),
  ...[0, 1, 2, 3].map((step) => () => { globalThis.__homeFixture = { step, phase: 'collect', packs: [pack] }; return s.render(s.AggregatePacksFunnel, callbacks); }),
  ...['generating', 'done'].map((phase) => () => { globalThis.__homeFixture = { step: 0, phase, packs: [pack], result: { fileName: '_AUTHOR_FILE_.zip', storyCount: 2, packCount: 1, warnings: [] } }; return s.render(s.AggregatePacksFunnel, callbacks); }),
  ...[false, true].map((graph) => () => { globalThis.__homeFixture = {}; return s.render(s.PackNameModal, { ...callbacks, open: true, embedded: true, catalogImage: null, fallbackImage: null, project: { rootEntries: [{ type: 'story', audio: '/_AUTHOR_AUDIO_' }] }, advanced: graph ? { draft: { title: '', namingMode: 'legacy' }, governance: { version: { editable: true }, uuid: { editable: true } }, counters: { stages: 2, actions: 2, options: 2, media: 2 } } : null }); }),
];

test('Accueil et funnels : FR comparé aux sources indépendantes de la base, rendu EN/IT/pseudo', async () => {
  const server = await surfaceServer(); const originalServer = await surfaceServer(true);
  const oldFixture = globalThis.__homeFixture;
  try {
    globalThis.__homeFixture = {};
    const s = await load(server); const original = await load(originalServer);
    const renders = scenarios(s); const originals = scenarios(original);
    for (let i = 0; i < renders.length; i++) {
      // Les attendus proviennent du code de BASE, jamais du nouveau catalogue.
      let expected = text(applyLot413(originals[i]()));
      // The final destination is a deliberate addition to the original funnel.
      if (i === 4) expected += 'Destination de l’assemblageOuvrir dans l’éditeur par menusGénérer directementLe choix ne lance aucune génération. Les noms, les images et l’ordre restent modifiables.';
      if (i === 5) expected = expected.replace('Génération du pack…', 'AnnulerGénération du pack…');
      // FICHED: the editor description is free text, with explicit help.
      expected = expected.replace('Description notes de version', 'Description Texte libre : présentation, contenu, notes de version…');
      // Un dossier de pack vaut une archive : formats élargis et second bouton (ajout volontaire).
      expected = expected.replace('Formats acceptés : .zip, .7z · plusieurs à la fois', 'Formats acceptés : .zip, .7z ou dossier · plusieurs à la fois')
        .replace('Parcourir…', 'Parcourir…Parcourir un dossier…');
      assert.equal(text(renders[i]()), expected, `FR scénario ${i}`);
    }
    for (const language of ['en', 'it', 'pseudo']) {
      await s.runtime.changeLanguage(language);
      for (const render of renders) {
        const html = render();
        assert.doesNotMatch(html, /home:|\[object Object\]|&quot;code&quot;/);
        if (language === 'pseudo') {
          const values = [...html.matchAll(/>([^<>]+)</g)].map((match) => match[1]);
          values.push(...[...html.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]+)"/g)].map((match) => match[1]));
          for (const value of values) {
            if (!/\p{L}/u.test(value) || value.includes('_AUTHOR_') || value === 'Story Studio') continue;
            assert.ok(value.includes('[') || value.includes(']'), `texte hors pseudo : ${value}`);
          }
        }
      }
    }
    // Les défauts des composants partagés sont aussi réellement rendus.
    for (const [component, fragment] of [[s.FunnelFooter, 'Précédent'], [s.FunnelGenerationState, 'Génération'], [s.FunnelDoneState, 'Terminé']]) {
      await s.runtime.changeLanguage('fr'); assert.ok(s.render(component, {}).includes(fragment));
      await s.runtime.changeLanguage('pseudo'); assert.ok(s.render(component, {}).includes('['));
    }
    for (const [saving, expected] of [['save', 'Application…'], ['generate', 'Préparation…']]) {
      globalThis.__homeFixture = { saving }; await s.runtime.changeLanguage('fr');
      const html = s.render(s.PackNameModal, { open: true, embedded: true });
      assert.ok(html.includes(expected)); assert.doesNotMatch(html, /Application\.\.\.|Préparation\.\.\./);
    }
  } finally { globalThis.__homeFixture = oldFixture; await server.close(); await originalServer.close(); }
});


test('frontières corrigées : refus de funnel et dialogue avec détails repliés réellement rendus', async () => {
  const server = await surfaceServer();
  try {
    const s = await load(server);
    const { presentImportError } = await server.ssrLoadModule('/src/components/EditPack/importErrorPresentation.js');
    const { ImportErrorNotice } = await server.ssrLoadModule('/src/components/EditPack/ImportErrorNotice.jsx');
    const { Dialog } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { HomeText } = await server.ssrLoadModule('/src/i18n/useHomeTranslation.js');
    const { presentUserMessage } = await server.ssrLoadModule('/src/i18n/userMessage.js');
    const stored = ['noStories', 'depthLimit'].map((name) => presentImportError({ key: `home:project.landing.${name}`, params: {} }));
    const cause = { code: 'FILES_SESSION_FOLDER_CREATE_FAILED', params: { error: 'EACCES' }, detail: 'OS_ACCESS_DENIED' };
    const dialog = { title: React.createElement(HomeText, { messageKey: 'home:project.creation.title' }), message: { userMessage: cause, codedOnly: true, prefix: { key: 'home:project.landing.preparePrefix' } }, technicalDetail: presentUserMessage(cause).technicalDetail };
    for (const language of ['fr', 'en', 'it', 'pseudo']) {
      await s.runtime.changeLanguage(language);
      for (const error of stored) {
        const html = s.render(ImportErrorNotice, { error });
        assert.ok(text(html).includes(error.message));
        assert.doesNotMatch(html, /Ce pack n’a pas pu être ouvert|home:|\[object Object\]/);
        if (language === 'pseudo') assert.ok(text(html).includes('['));
      }
      const html = s.render(Dialog, { dialog });
      assert.match(html, /<details><summary>.*?<\/summary><pre>OS_ACCESS_DENIED<\/pre><\/details>/);
      assert.doesNotMatch(html, /<details open|\[object Object\]|FILES_SESSION_FOLDER_CREATE_FAILED/);
      assert.equal((html.match(/OS_ACCESS_DENIED/g) ?? []).length, 1);
      assert.ok(text(html).includes('EACCES'));
      if (language === 'pseudo') assert.ok(text(html).includes('['));
    }
  } finally { await server.close(); }
});
