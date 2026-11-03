import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { graphVisibleSurface } from './i18nGraphSurfaceHarness.mjs';
import { editingHarness, openedEditingSources } from './i18nGraphEditingHarness.mjs';
import { assertTranslatedSurface } from './i18nGraphEditingSurface.mjs';
import { GRAPH_NEUTRAL_KEYS } from './check-i18n.mjs';
import { originalEditingSurfaces, originalOpenedEditingSurfaces, originalOpenedEditingSegments, originalGraphKeyNames } from './i18nGraphEditingSourceFixture.mjs';
import { applyLot413Deep, LOT_413_GRAPH } from './i18nLot413Corrections.mjs';
import { collapseSurface, collapseSegments } from './selectMigrationGraphLists.mjs';
import { commandKeyLabel } from '../src/utils/platformKeys.js';
import { installMountedDom, click } from './treeMountedDom.mjs';

// Adapter uniquement le raccourci Annuler des surfaces historiques BASE.
function platformUndoSurface(value) {
  if (typeof value === 'string') return value.replaceAll('Ctrl+Z', `${commandKeyLabel()}+Z`);
  if (Array.isArray(value)) return value.map(platformUndoSurface);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, platformUndoSurface(item)]));
  return value;
}

test('édition graphe : FR indépendant de git show BASE, attributs accessibles compris', async () => {
  const current = await editingHarness();
  try {
    for (const name of Object.keys(current.cases)) assert.deepEqual(graphVisibleSurface(current.render(name)), platformUndoSurface(applyLot413Deep(collapseSurface('editing', name, originalEditingSurfaces[name]), LOT_413_GRAPH)), name);
  } finally { await current.close(); }
});
test('édition graphe : surface pseudo réellement rendue et mutation FR détectée', async () => {
  const h = await editingHarness();
  try {
    for (const language of ['en', 'it', 'pseudo']) {
      await h.engine.changeLanguage(language);
      for (const name of Object.keys(h.cases)) {
        assertTranslatedSurface(h, name);
      }
    }
    await h.engine.changeLanguage('en');
    function assertNoFrenchLeak() {
      const surface = graphVisibleSurface(h.render('NodePicker'));
      assert.notEqual(surface.attributes.find(([attribute]) => attribute === 'placeholder')?.[1], h.engine.getResource('fr', 'graph', 'picker.filter.placeholder'));
    }
    assertNoFrenchLeak();
    const saved = h.engine.getResource('en', 'graph', 'picker.filter.placeholder');
    h.engine.addResource('en', 'graph', 'picker.filter.placeholder', h.engine.getResource('fr', 'graph', 'picker.filter.placeholder'));
    assert.throws(assertNoFrenchLeak, assert.AssertionError);
    h.engine.addResource('en', 'graph', 'picker.filter.placeholder', saved);
    assertNoFrenchLeak();
  } finally { await h.close(); }
});
test('édition graphe montée : dialogue conservé et nom capturé à la création, contrôles à chaud sans dirty/undo', async () => {
  const dom = installMountedDom();
  const elementPrototype = Object.getPrototypeOf(dom.document.createElement('select'));
  Object.defineProperty(elementPrototype, 'options', { configurable: true, get() { return this.querySelectorAll('option'); } });
  const h = await editingHarness();
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  const [Dialog, props] = h.rawCases.GraphLinkDialog; const [Controls, controlsProps] = h.rawCases.ControlsCompletion;
  const { useProjectStore } = await h.load('src/store/projectStore.js');
  let store; const gestures = [];
  function Mounted() { store = useProjectStore(); return React.createElement(React.Fragment, null, React.createElement(Dialog, { ...props, onConfirm: g => gestures.push(g) }), React.createElement(Controls, controlsProps)); }
  try {
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: h.engine }, React.createElement(Mounted))); });
    const dialog = host.querySelector('.advanced-dialog'); assert.ok(dialog);
    const input = host.querySelector('#graph-linked-name'); assert.ok(input);
    const name = input.value; const before = JSON.stringify(store.readProject()); const undo = store.readHistoryMark(); const pristine = store.isPristine();
    const open = host.querySelectorAll('button').find(b => b.textContent.includes('Définir les cinq')); assert.ok(open);
    await act(async () => { click(open); });
    for (const language of ['fr', 'en', 'it']) {
      await act(async () => { await h.engine.changeLanguage(language); });
      assert.equal(host.querySelector('#graph-linked-name'), input); assert.equal(input.value, name);
      assert.equal(host.querySelector('.advanced-dialog'), dialog);
      assert.ok(host.textContent.includes(h.engine.t('graph:link.create.list')));
      assert.ok(host.textContent.includes(h.engine.t('graph:controls.wheel.label')));
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), pristine);
    }
    const confirm = host.querySelectorAll('button').find(b => b.textContent === h.engine.t('graph:link.create.confirm')); assert.ok(confirm);
    await act(async () => { click(confirm); });
    assert.equal(gestures.length, 1); assert.equal(gestures[0].gesture, 'create-linked-node'); assert.equal(gestures[0].linked.action.name, name);
  } finally { await act(async () => root.unmount()); await h.close(); dom.restore(); }
});

test('sélection montée : rejets audio FR/EN/IT, noms auteur conservés et erreurs traduites à chaud', async () => {
  for (const initialLanguage of ['fr', 'en', 'it']) {
    const dom = installMountedDom();
    const h = await editingHarness();
    const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
    const root = createRoot(host);
    const { GraphSelectionEditor } = await h.load('src/components/AdvancedWorkspace/GraphSelectionEditor.jsx');
    const { ProjectContext } = await h.load('src/store/ProjectContext.js');
    const { ErrorDialogProvider } = await h.load('src/components/common/Dialog.jsx');
    const { useProjectStore } = await h.load('src/store/projectStore.js');
    const source = h.index.entries.find(entry => entry.kind === 'stage');
    const names = ['Mon titre auteur', 'Second titre auteur'];
    const entries = names.map((name, ordinal) => ({ ...source, path: `${source.path}-${ordinal}`, node: { ...source.node, uuid: `audio-stage-${ordinal}` }, label: { label: name, isFallback: false } }));
    const requests = [];
    let reject = true; let store;
    const context = {
      workspaceDir: '', xttsSettings: { backend: 'piper', piperVoice: '_AUTHOR_VOICE_' },
      onQueueXttsGenerate: async request => { requests.push(request); if (reject) throw new Error('RAW_QUEUE_FAILURE'); },
    };
    function Mounted() {
      store = useProjectStore();
      return React.createElement(ProjectContext.Provider, { value: context }, React.createElement(ErrorDialogProvider, null, React.createElement(GraphSelectionEditor, { entries, projectEpoch: 42 })));
    }
    function audioButton() { return host.querySelectorAll('button').find(button => button.textContent === h.engine.t('graph:selection.audios.label')); }
    try {
      await h.engine.changeLanguage(initialLanguage);
      await act(async () => root.render(React.createElement(I18nextProvider, { i18n: h.engine }, React.createElement(Mounted))));
      const panel = host.querySelector('.advanced-selection-editor'); assert.ok(panel);
      const before = JSON.stringify(store.readProject()); const undo = store.readHistoryMark(); const pristine = store.isPristine();
      assert.ok(audioButton()); assert.equal(audioButton().disabled, false);
      await act(async () => click(audioButton()));
      const alert = host.querySelector('.advanced-selection-editor__error'); assert.ok(alert);
      assert.equal(alert.getAttribute('role'), 'alert');
      assert.deepEqual(requests.map(request => request.request.text), names);
      assert.deepEqual(requests.map(request => request.target.kind), ['advancedStage', 'advancedStage']);
      assert.ok(requests.every(request => request.target.projectEpoch === 42 && request.voiceLabel === '_AUTHOR_VOICE_'));
      const captured = JSON.stringify(requests);
      for (const language of ['fr', 'en', 'it']) {
        await act(async () => { await h.engine.changeLanguage(language); });
        assert.equal(host.querySelector('.advanced-selection-editor'), panel);
        assert.equal(host.querySelector('.advanced-selection-editor__error'), alert);
        // Texte historique de git show BASE, indépendant du nouveau catalogue.
        const expected = language === 'fr'
          ? 'Mon titre auteur : job de voix non ajouté · Second titre auteur : job de voix non ajouté'
          : names.map(name => h.engine.t('graph:selection.error.audio', { name })).join(' · ');
        assert.equal(alert.textContent, expected);
        assert.doesNotMatch(host.textContent, /\[object Object\]|RAW_QUEUE_FAILURE/);
        if (language !== 'fr') assert.doesNotMatch(alert.textContent, /job de voix non ajouté/);
        assert.equal(audioButton().disabled, false);
        assert.equal(JSON.stringify(requests), captured);
        assert.equal(JSON.stringify(store.readProject()), before);
        assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), pristine);
      }
      reject = false;
      await act(async () => click(audioButton()));
      assert.equal(host.querySelector('.advanced-selection-editor__error'), null);
      assert.equal(host.querySelector('.advanced-selection-editor'), panel);
      assert.equal(requests.length, 4);
    } finally { await act(async () => root.unmount()); await h.close(); dom.restore(); }
  }
});

const EDITING_KEYS = Object.keys(JSON.parse(readFileSync(new URL('../src/locales/fr/graph.json', import.meta.url), 'utf8'))).filter(key => !originalGraphKeyNames.includes(key));
test('édition graphe : règle d’or sur chaque clé, paramètres et métadonnées ai intacts', () => {
  const catalogues = Object.fromEntries(['fr', 'en', 'it'].map(language => [language, JSON.parse(readFileSync(new URL(`../src/locales/${language}/graph.json`, import.meta.url), 'utf8'))]));
  const meta = JSON.parse(readFileSync(new URL('../src/locales/_meta/graph.json', import.meta.url), 'utf8'));
  const parameters = value => [...value.matchAll(/{{(.*?)}}/g)].map(match => match[1]).sort();
  for (const key of EDITING_KEYS) {
    assert.doesNotMatch(key, /_zero$/);
    const source = catalogues.fr[key];
    const hash = createHash('sha256').update(source.normalize('NFC').replace(/\r\n?/g, '\n')).digest('hex').slice(0, 12);
    for (const language of ['en', 'it']) {
      if (catalogues[language][key] === undefined) { assert.equal(language, 'en'); assert.ok(key.endsWith('_many')); continue; }
      if (!GRAPH_NEUTRAL_KEYS.has(key)) assert.notEqual(catalogues[language][key], source, `${language}:${key}`);
      assert.deepEqual(parameters(catalogues[language][key]), parameters(source), `${language}:${key}`);
      assert.equal(meta[key][language].sourceHash, hash);
      assert.equal(meta[key][language].status, 'ai-reviewed');
    }
    assert.ok(meta[key].context.includes('Éditeur graphe'));
    if (meta[key].maxLength !== undefined) assert.ok(Number.isInteger(meta[key].maxLength) && meta[key].maxLength > 0);
  }
});

test('mutations de sources en mémoire : fuite de texte et aria refusée en EN, IT et pseudo', async () => {
  const mutations = [
    { file: 'src/components/AdvancedWorkspace/NodePicker.jsx', before: 'aria-label={t("graph:picker.filter.aria")}', after: 'aria-label="Filtrer les nœuds proposés"', scenario: 'NodePicker', leak: /Filtrer les nœuds proposés/ },
    { file: 'src/components/AdvancedWorkspace/ActionSelectionFields.jsx', before: '{t("graph:landing.fixed.label")}', after: 'Toujours le même choix', scenario: 'ActionSelectionFields', leak: /Toujours le même choix/ },
  ];
  for (const mutation of mutations) {
    const source = readFileSync(new URL('../' + mutation.file, import.meta.url), 'utf8');
    assert.ok(source.includes(mutation.before));
    const h = await editingHarness({ [mutation.file]: source.replace(mutation.before, mutation.after) });
    try {
      for (const language of ['en', 'it', 'pseudo']) {
        await h.engine.changeLanguage(language);
        assert.match(h.render(mutation.scenario), mutation.leak);
        assert.throws(() => assertTranslatedSurface(h, mutation.scenario), error => error instanceof assert.AssertionError && mutation.leak.test(error.message));
      }
    } finally { await h.close(); }
  }
});

test('pluriels du domaine : catégories CLDR exactes, count transmis, 0/1/2/1 000 000', async () => {
  const h = await editingHarness();
  const french = JSON.parse(readFileSync(new URL('../src/locales/fr/graph.json', import.meta.url), 'utf8'));
  const families = EDITING_KEYS.filter(key => key.endsWith('_many')).map(key => key.slice(0, -5));
  assert.ok(families.length >= 30);
  try {
    for (const language of ['fr', 'en', 'it']) {
      await h.engine.changeLanguage(language);
      const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories.sort();
      assert.deepEqual(categories, language === 'en' ? ['one', 'other'] : ['many', 'one', 'other']);
      for (const family of families) {
        const actualCategories = Object.keys(h.engine.getResourceBundle(language, 'graph')).filter(key => key.startsWith(family + '_')).map(key => key.slice(family.length + 1)).sort();
        assert.deepEqual(actualCategories, categories, `${language}:${family}`);
        for (const count of [0, 1, 2, 1_000_000]) {
          const params = { count, selection: '_AUTHOR_SELECTION_' };
          const result = h.engine.t('graph:' + family, params);
          const category = new Intl.PluralRules(language).select(count);
          const reference = h.engine.getResource(language, 'graph', family + '_' + category).replace(/{{(.*?)}}/g, (_, name) => String(params[name]));
          assert.equal(result, reference, `${language}:${family}:${count}`);
          assert.doesNotMatch(result, /{{|graph:|undefined/);
          if (language === 'fr') {
            // Attentes indépendantes de la traduction : graphies historiques de BASE.
            if (family === 'selection.stages.count') assert.equal(result, `${count} Écran${count > 1 ? 's' : ''}`);
            if (family === 'selection.actions.count') assert.equal(result, `${count} liste${count > 1 ? 's' : ''} de choix`);
            if (family === 'feedback.removed.count') assert.equal(result, count <= 1 ? `${count} raccord a été retiré.` : `${count} raccords ont été retirés.`);
            if (family === 'feedback.maintained.count') assert.equal(result, count <= 1 ? `${count} transition a conservé sa destination.` : `${count} transitions ont conservé leur destination.`);
          }
          assert.ok(french[family + '_' + category] || language === 'en');
        }
      }
    }
  } finally { await h.close(); }
});

test('messages locaux, menus et diagnostics précréés : présentation chaude, codes et paramètres stables', async () => {
  const h = await editingHarness();
  try {
    const { presentUserMessage } = await h.load('src/i18n/userMessage.js');
    const { applyAdvancedGesture } = await h.load('src/store/projectModel/authoring.js');
    let payloadError;
    await assert.rejects(() => applyAdvancedGesture({ authoring: {} }, {}), error => { payloadError = error; return error.code === 'ADVANCED_CODEC_REQUIRED'; });
    assert.equal(payloadError.path, '/authoring/payload');
    assert.equal(payloadError.found, 'absent');
    assert.equal(payloadError.expected, "un projet avancé porteur d'un payload d'auteur");
    assert.equal(payloadError.presentationRef, undefined);
    assert.equal(presentUserMessage(payloadError, { development: false }).fallback, true);
    const payloadProof = payloadError.message;
    assert.notEqual(payloadError.code, 'INVALID_MEDIA_BINDING');
    const { advancedGestures } = await h.load('src/store/projectModel/advancedGestures.js');
    const { graphLinkPorts, buildExistingGraphLinkGesture } = await h.load('src/store/advancedAuthoring/graphLinkDraft.js');
    const { planStageMediaAssignment } = await h.load('src/store/advancedAuthoring/mediaDrop.js');
    const { buildGraphContextActions } = await h.load('src/components/AdvancedWorkspace/graphContextMenuActions.jsx');
    const { buildAdvancedBlockingIssues, resolutionsForDiagnostic } = await h.load('src/store/advancedAuthoring/diagnosticResolutions.js');
    const nodes = h.index.entries;
    const menus = buildGraphContextActions({ inspected: nodes[0], onSimulateFrom() {}, onDelete() {} });
    const ports = graphLinkPorts(nodes[0]);
    const drop = planStageMediaAssignment({ project: {}, stageUuid: null, kind: 'audio', path: '_PATH_' });
    const dropError = Object.assign(new Error(drop.reason), { code: drop.code });
    assert.equal(drop.code, 'no-stage'); assert.equal(drop.ok, false); assert.notEqual(drop.code, 'no-path');
    let local;
    assert.throws(() => advancedGestures.setStageControls('', { home: { form: 'set', value: true } }), error => { local = error; return error instanceof TypeError; });
    assert.deepEqual(local.presentationRef, { key: 'graph:guard.text.required', params: { field: 'stageUuid' } });
    assert.notEqual(local.presentationRef.key, 'graph:guard.enum.required');
    let enumError;
    assert.throws(() => advancedGestures.setStageControls('_UUID_', { invalid: { form: 'set', value: true } }), error => { enumError = error; return error instanceof TypeError; });
    assert.deepEqual(enumError.presentationRef, { key: 'graph:guard.enum.required', params: { field: { key: 'graph:guard.control.label' }, allowed: 'wheel, ok, home, pause, autoplay' } });
    assert.notEqual(enumError.presentationRef.key, 'graph:guard.text.required');
    let linkError;
    assert.throws(() => buildExistingGraphLinkGesture(null), error => { linkError = error; return error instanceof TypeError; });
    assert.deepEqual(linkError.presentationRef, { key: 'graph:link.guard.existing', params: {} });
    const issues = buildAdvancedBlockingIssues({ summary: { blocking: [{ source: 'authoring', code: 'HOME_LOOPS_TO_SELF', path: '_PATH_' }] }, index: h.index });
    const diagnostic = { code: 'SQUARE_ONE_COUNT', path: '_PATH_', resolutions: [] };
    const resolutions = resolutionsForDiagnostic({ diagnostic, view: h.view, index: h.index });
    const before = JSON.stringify({ code: diagnostic.code, refs: [local.presentationRef, linkError.presentationRef], dropCode: drop.code });
    for (const language of ['fr', 'en', 'it']) {
      await h.engine.changeLanguage(language);
      const payloadPresented = presentUserMessage(payloadError, { development: false });
      assert.equal(payloadPresented.message, h.engine.t('common:error.fallback.unexpected'));
      assert.equal(payloadPresented.technicalDetail, payloadProof);
      assert.equal(payloadError.message, payloadProof);
      if (language !== 'fr') assert.doesNotMatch(payloadPresented.message, /un projet avancé|trouvé|attendu/);
      assert.equal(payloadError.code, 'ADVANCED_CODEC_REQUIRED');
      assert.equal(menus[0].label, h.engine.t('graph:context.preview.label'));
      assert.equal(ports[0].label, h.engine.t('graph:link.port.route'));
      assert.equal(drop.reason, h.engine.t('graph:drop.reason.stage'));
      const dropPresented = presentUserMessage(dropError, { development: false });
      assert.equal(dropPresented.code, 'no-stage');
      assert.equal(dropPresented.message, h.engine.t('common:error.fallback.unexpected'));
      assert.equal(dropPresented.technicalDetail, h.engine.t('graph:drop.reason.stage'));
      if (language !== 'fr') assert.doesNotMatch(dropPresented.technicalDetail, /Aucun Écran/);
      assert.equal(issues[0].message, h.engine.t('graph:diagnostics.home.loop'));
      assert.equal(resolutions[0].label, h.engine.t('graph:diagnostics.entry.choose'));
      assert.equal(presentUserMessage(local).message, h.engine.t('graph:guard.text.required', { field: 'stageUuid' }));
      assert.equal(presentUserMessage(enumError).message, h.engine.t('graph:guard.enum.required', { field: h.engine.t('graph:guard.control.label'), allowed: 'wheel, ok, home, pause, autoplay' }));
      assert.doesNotMatch(presentUserMessage(enumError).message, /\[object Object\]/);
      if (language !== 'fr') assert.doesNotMatch(presentUserMessage(enumError).message, /contrôle/);
      assert.equal(presentUserMessage(linkError).message, h.engine.t('graph:link.guard.existing'));
      assert.equal(JSON.stringify({ code: diagnostic.code, refs: [local.presentationRef, linkError.presentationRef], dropCode: drop.code }), before);
    }
  } finally { await h.close(); }
});

test('formulaires et progressions ouverts en SSR : FR de BASE et chacun des segments/attributs traduit', async () => {
  const h = await editingHarness(openedEditingSources());
  try {
    for (const name of Object.keys(h.cases)) assert.deepEqual(graphVisibleSurface(h.render(name)), platformUndoSurface(applyLot413Deep(collapseSurface('opened', name, originalOpenedEditingSurfaces[name]), LOT_413_GRAPH)), name);
    for (const language of ['en', 'it', 'pseudo']) {
      await h.engine.changeLanguage(language);
      for (const name of Object.keys(h.cases)) assertTranslatedSurface(h, name, collapseSegments('opened', name, originalOpenedEditingSegments[name]));
    }
  } finally { await h.close(); }
});
