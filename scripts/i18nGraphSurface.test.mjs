import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { graphSurfaceHarness, graphVisibleSurface, GRAPH_FILES } from './i18nGraphSurfaceHarness.mjs';
import { originalGraphSurfaces, originalGraphLiteralFixtures } from './i18nGraphSourceFixture.mjs';
import { applyLot413, applyLot413Deep, LOT_413_GRAPH } from './i18nLot413Corrections.mjs';
import { collapseSurface } from './selectMigrationGraphLists.mjs';
import { installMountedDom } from './treeMountedDom.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { checkCatalogues, checkSource, sourceHash } from './check-i18n.mjs';

const catalogue = lang => JSON.parse(readFileSync(new URL(`../src/locales/${lang}/graph.json`, import.meta.url), 'utf8'));

test('FR : surfaces comparées au rendu indépendant de la base, attentes historiques intactes', async () => {
  const fr = catalogue('fr');
  assert.equal(originalGraphLiteralFixtures.length, 193);
  // Lot 4.13 : corrections FR explicites (i18nLot413Corrections.mjs) appliquées à l’attente d’origine.
  // Lot 4.13 : formes plurielles corrigées (gabarits sans nombre résolu), écrites en clair.
  const lot413Plurals = {
    'overlay.nodes.zoneCount_one': '{{count}} nœud dans cette zone',
    'canvas.anchors.ignoredCount_one': '{{count}} ancrage mémorisé ne désigne plus rien : ignoré, non supprimé.',
    'canvas.anchors.ignoredCount_many': '{{count}} ancrages mémorisés ne désignent plus rien : ignorés, non supprimés.',
    'canvas.anchors.ignoredCount_other': '{{count}} ancrages mémorisés ne désignent plus rien : ignorés, non supprimés.',
  };
  for (const fixture of originalGraphLiteralFixtures) assert.equal(fr[fixture.key], lot413Plurals[fixture.key] ?? applyLot413(fixture.expectedFrench, LOT_413_GRAPH), `${fixture.source}:${fixture.line} ${fixture.key}`);
  const h = await graphSurfaceHarness();
  try {
    for (const [name, expected] of Object.entries(originalGraphSurfaces)) assert.deepEqual(graphVisibleSurface(h.render(name)), applyLot413Deep(collapseSurface('surface', name, expected), LOT_413_GRAPH), name);
  } finally { await h.close(); }
});

test('catalogues : parité des paramètres, hashes NFC/LF et détection réelle d’une fuite FR par mutation', () => {
  const resources = Object.fromEntries(['fr', 'en', 'it'].map(lang => [lang, { graph: catalogue(lang) }]));
  const metadata = { graph: catalogue('_meta') };
  assert.deepEqual(checkCatalogues(resources, metadata).errors, []);
  for (const [key, entry] of Object.entries(metadata.graph)) {
    for (const lang of ['en', 'it']) if (entry[lang]) assert.equal(entry[lang].sourceHash, sourceHash(resources.fr.graph[key]), key);
  }
  for (const lang of ['en', 'it']) {
    const mutated = structuredClone(resources);
    assert.equal(typeof mutated.fr.graph['canvas.unableToRead.label'], 'string');
    mutated[lang].graph['canvas.unableToRead.label'] = mutated.fr.graph['canvas.unableToRead.label'];
    assert.ok(checkCatalogues(mutated, metadata).errors.some(e => e.includes(`${lang}/graph:canvas.unableToRead.label règle d’or`)));
  }
});

test('pluriels : 0, 1, 2 et 1 000 000 dans FR/EN/IT ; morphologie FR historique préservée', async () => {
  const h = await graphSurfaceHarness();
  try {
    for (const lang of ['fr', 'en', 'it']) {
      await h.engine.changeLanguage(lang);
      for (const count of [0, 1, 2, 1_000_000]) {
        const result = h.engine.t(count === 0 ? 'graph:search.summary.stageCountAtZero' : 'graph:search.summary.stageCount', { count });
        assert.ok(result.includes(String(count)), `${lang}/${count}`);
        assert.doesNotMatch(result, /{{|graph:/);
        assert.match(result, lang === 'fr' ? new RegExp(count === 1 ? 'Écran$' : 'Écrans$') : lang === 'en' ? new RegExp(count === 1 ? 'Screen$' : 'Screens$') : new RegExp(count === 1 ? 'Schermata$' : 'Schermate$'));
        for (const key of Object.keys(catalogue('fr')).filter(k => k.endsWith('_other')).map(k => k.slice(0, -6))) {
          assert.doesNotMatch(h.engine.t('graph:' + key, { count, name: '_AUTHOR_', remaining: 2, selection: '_AUTHOR_SELECTION_' }), /{{|graph:/);
        }
      }
    }
  } finally { await h.close(); }
});

test('React monté : FR → EN → IT à chaud, dialogue existant, table et index conservés, travail/undo inchangés', async () => {
  const dom = installMountedDom();
  // Complément DOM ciblé : React lit la collection options des vrais <select>.
  Object.defineProperty(globalThis.HTMLElement.prototype, 'options', { configurable: true,
    get() { return this.querySelectorAll('option'); },
  });
  const h = await graphSurfaceHarness();
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  let store, mounts = 0;
  try {
    const { useProjectStore } = await h.load('src/store/projectStore.js');
    const { createAdvancedProject, withAuthoringPayload } = await h.load('src/store/projectModel/authoring.js');
    const { nextDefaultNodeName } = await h.load('src/store/advancedAuthoring/defaultNodeNames.js');
    const { searchGraph } = await h.load('src/store/advancedGraphView/graphSearch.js');
    function Mounted() {
      store = useProjectStore(); React.useEffect(() => { mounts++; }, []);
      return React.createElement(React.Fragment, null, ...['dialog', 'defaultsDialog', 'construction', 'controls', 'inspectorList'].map(name => {
        const [component, props] = h.scenarios[name]; return React.createElement(component, { ...props, key: name });
      }));
    }
    await act(async () => { root.render(React.createElement(Mounted)); });
    await act(async () => { store.loadProject(createAdvancedProject({ payload: '_ORIGINAL_OPAQUE_PAYLOAD_', projectName: '_AUTHOR_TITLE_' })); });
    await act(async () => { store.setProject(project => withAuthoringPayload(project, '_EDITED_OPAQUE_PAYLOAD_')); });
    await act(async () => { store.markPristine(); });
    assert.equal(store.canUndo, true);
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark(), originalIndex = h.index;
    const dialog = host.querySelector('.advanced-dialog'); assert.ok(dialog);
    const defaultsDialog = host.querySelectorAll('.advanced-dialog')[1];
    const constructionDialog = host.querySelectorAll('.advanced-dialog')[2];
    const switches = defaultsDialog.querySelectorAll('[role="switch"]').map(n => n.getAttribute('aria-checked'));
    for (const [lang, inspector, apply, unnamed] of [['fr', 'Inspecteur', 'Appliquer', 'Liste sans nom'], ['en', 'Inspector', 'Apply', 'Unnamed list'], ['it', 'Ispettore', 'Applica', 'Lista senza nome']]) {
      await act(async () => { await h.engine.changeLanguage(lang); });
      assert.equal(host.querySelector('.advanced-dialog'), dialog);
      assert.equal(host.querySelectorAll('.advanced-dialog')[1], defaultsDialog);
      assert.equal(host.querySelectorAll('.advanced-dialog')[2], constructionDialog);
      assert.ok(defaultsDialog.textContent.includes(lang === 'fr' ? 'Boutons des nouveaux Écrans' : lang === 'en' ? 'New Screen buttons' : 'Tasti delle nuove Schermate'));
      assert.ok(constructionDialog.textContent.includes(lang === 'fr' ? 'Constructions dérivées' : lang === 'en' ? 'Story structures' : 'Strutture narrative'));
      assert.deepEqual(defaultsDialog.querySelectorAll('[role="switch"]').map(n => n.getAttribute('aria-checked')), switches);
      assert.ok(dialog.textContent.includes(apply));
      assert.ok(host.querySelectorAll('aside').some(n => n.getAttribute('aria-label') === inspector));
      assert.ok(host.textContent.includes(unnamed));
      assert.equal(h.index, originalIndex);
      assert.equal(searchGraph(h.index, { query: unnamed }).total, 1);
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
      assert.match(nextDefaultNodeName(h.index, 'stage', ['Écran 3', 'Screen 7', 'Schermata 5']), lang === 'fr' ? /^Écran 8$/ : lang === 'en' ? /^Screen 8$/ : /^Schermata 8$/);
    }
    assert.equal(mounts, 1);
  } finally { await act(async () => root.unmount()); await h.close(); dom.restore(); }
});

test('pseudo-locale : vraie surface SSR et attributs accessibles, capture et frontières de présentation', async () => {
  const h = await graphSurfaceHarness();
  try {
    const resources = { graph: catalogue('fr'), common: JSON.parse(readFileSync(new URL('../src/locales/fr/common.json', import.meta.url))), tree: JSON.parse(readFileSync(new URL('../src/locales/fr/tree.json', import.meta.url))) };
    for (const [ns, values] of Object.entries(pseudoResources(resources))) h.engine.addResourceBundle('pseudo', ns, values, true, true);
    await h.engine.changeLanguage('pseudo');
    for (const name of ['inspectorEmpty', 'inspectorStage', 'inspectorList', 'controls', 'search', 'dialog', 'defaults', 'defaultsDialog', 'construction', 'overlay', 'canvas']) {
      const visible = graphVisibleSurface(h.render(name)); assert.match(visible.text, /\[/, name);
      for (const [, value] of visible.attributes) {
        if (value === 'OK' || value === 'HOME' || /^_AUTHOR_/.test(value)) continue;
        // Ces deux attributs viennent de NodePicker, explicitement hors lot 4.4a.
        if (name === 'construction' && ['Filtrer par nom ou identifiant', 'Filtrer les nœuds proposés'].includes(value)) {
          const picker = readFileSync(new URL('../src/components/AdvancedWorkspace/NodePicker.jsx', import.meta.url), 'utf8');
          assert.ok(picker.includes(value)); assert.ok(!GRAPH_FILES.includes('src/components/AdvancedWorkspace/NodePicker.jsx'));
          continue;
        }
        assert.match(value, /\[/, `${name}: ${value}`);
      }
      for (const literal of ['Inspecteur', 'Vue d’ensemble', 'Caméra mémorisée inutilisable', 'Liste sans nom', 'Rechercher dans la liste des nœuds', 'Lecture du graphe…']) assert.ok(!visible.text.includes(literal), `${name}: ${literal}`);
    }
    const { paintOverlay } = await h.load('src/components/AdvancedGraphCanvas/graphSurfaceCapture.js');
    const painted = []; const context = new Proxy({ measureText: text => ({ width: String(text).length * 4 }), fillText: text => painted.push(text) }, { get: (o, k) => o[k] ?? (() => {}) });
    paintOverlay(context, { detailLevel: 'full', zoom: 1, nodes: [{ path: '_PATH_', kind: 'stage', label: '_AUTHOR_', isEntry: true, x: 0, y: 0, width: 100, height: 100 }] });
    assert.ok(painted.some(text => String(text).includes('['))); assert.ok(!painted.includes('ENTRÉE'));
    const { presentGraphLandmarks } = await h.load('src/i18n/graphPresentation.js');
    const marks = presentGraphLandmarks([{ kind: 'hub', node: { label: '_AUTHOR_', degree: 2 }, label: '_AUTHOR_ · 2 liens', title: '_AUTHOR_ · 2 liens', x: 1, y: 2 }]);
    assert.match(marks[0].label, /\[/); assert.ok(!marks[0].label.includes('liens')); assert.equal(marks[0].x, 1);
  } finally { await h.close(); }
});

test('périmètre : tous les fichiers sont protégés par no-literal-string et saveAs reste inchangé', () => {
  const config = readFileSync(new URL('../eslint.config.js', import.meta.url), 'utf8');
  GRAPH_FILES.forEach(file => assert.ok(config.includes(file), file));
  const common = JSON.parse(readFileSync(new URL('../src/locales/fr/common.json', import.meta.url)));
  assert.equal(common['project.saveAs.fallbackLabel'], 'Enregistrer sous…');
});

test('IPC : commande initiale localisée, codes/paramètres conservés et détails techniques repliés', async () => {
  const h = await graphSurfaceHarness();
  try {
    const { acquireCreatedAdvancedProject } = await h.load('src/store/projectModel/authoring.js');
    const { createAdvancedViewSession } = await h.load('src/store/advancedGraphView/advancedViewSession.js');
    const { presentUserMessage } = await h.load('src/i18n/userMessage.js');
    const { createGraphCopyFlow } = await h.load('src/hooks/graphCopyFlow.js');
    for (const [language, initialStageName] of [['fr', 'Écran 1'], ['en', 'Screen 1'], ['it', 'Schermata 1']]) {
      await h.engine.changeLanguage(language);
      const calls = [];
      const created = await acquireCreatedAdvancedProject({ title: '_AUTHOR_TITLE_', invokeCommand: async (command, params) => { calls.push({ command, params }); return '_OPAQUE_PAYLOAD_'; } });
      assert.deepEqual(calls, [{ command: 'create_advanced_document', params: { title: '_AUTHOR_TITLE_', initialStageName } }]);
      assert.equal(created.projectName, '_AUTHOR_TITLE_');
      const error = { code: 'FILES_PROJECT_FOLDER_RESOLUTION_FAILED', params: { savePath: '/_AUTHOR_.mbah' }, detail: '_RAW_TECHNICAL_DETAIL_' };
      const session = createAdvancedViewSession({ readGraphView: async () => h.view, readViewCache: async () => { throw error; }, writeViewCache: async () => {} });
      await session.open({ projectEpoch: 1, project: { savePath: '/_AUTHOR_.mbah' } });
      assert.equal(session.state.notices[0].message, error);
      assert.equal(session.state.notices[0].message.code, 'FILES_PROJECT_FOLDER_RESOLUTION_FAILED');
      assert.deepEqual(session.state.notices[0].message.params, { savePath: '/_AUTHOR_.mbah' });
      assert.notEqual(session.state.notices[0].message.code, 'ENTRY_STAGE_AS_OPTION');
      const presented = presentUserMessage(error, { t: h.engine.t.bind(h.engine), language });
      assert.equal(presented.code, error.code); assert.equal(presented.fallback, false);
      assert.equal(presented.technicalDetail, '_RAW_TECHNICAL_DETAIL_');
      assert.doesNotMatch(presented.message, /_RAW_TECHNICAL_DETAIL_|\[object Object\]/);
      const dialog = [];
      const flow = createGraphCopyFlow({ currentProject: () => ({ projectType: 'pack' }), currentSavePath: () => '/_AUTHOR_.mbah', fileExists: async () => false, choose: async () => 'copy', confirmLeaveOriginal: async () => true, buildCopy: async () => { throw error; }, showError: value => dialog.push(value) });
      assert.equal(await flow.continueInGraph(), false);
      assert.equal(dialog[0].technicalDetail, '_RAW_TECHNICAL_DETAIL_');
      assert.doesNotMatch(dialog[0].message, /_RAW_TECHNICAL_DETAIL_|\[object Object\]/);
      // Le canvas de cache affiche le message d’état et conserve le diagnostic dans <details> fermé.
      h.scenarios.canvas[1].view.notices = session.state.notices;
      const html = h.render('canvas');
      assert.match(html, /<details>/); assert.doesNotMatch(html, /<details[^>]*open|\[object Object\]/);
      assert.ok(html.includes('_RAW_TECHNICAL_DETAIL_'));
      await session.close();
    }
  } finally { await h.close(); }
});


test('React monté : recherche sans callback, demande de focus puis fermeture par Échap', async () => {
  const dom = installMountedDom();
  globalThis.HTMLElement.prototype.select = function () {};
  globalThis.HTMLElement.prototype.blur = function () { this.ownerDocument.activeElement = this.ownerDocument.body; };
  const h = await graphSurfaceHarness();
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const [Search, props] = h.scenarios.search;
    await act(async () => { root.render(React.createElement(Search, { ...props, searchActive: false, searchFocusTrigger: 1 })); });
    await act(async () => { root.render(React.createElement(Search, { ...props, searchActive: true, searchFocusTrigger: 1 })); });
    const input = host.querySelector('input');
    assert.equal(dom.document.activeElement, input);
    await act(async () => { host.querySelector('.tree-search-controls').dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true, stopPropagation() { this.cancelBubble = true; } }); });
    assert.equal(dom.document.activeElement, dom.document.body);
    await act(async () => { root.render(React.createElement(Search, { ...props, searchActive: false, searchFocusTrigger: 1 })); });
    assert.equal(host.querySelector('input'), null);
  } finally { await act(async () => root.unmount()); await h.close(); dom.restore(); }
});

test('capture : langue figée avant export et décodage différés, badges, repères et erreur', async () => {
  const h = await graphSurfaceHarness();
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  try {
    const { captureGraphSurface } = await h.load('src/components/AdvancedGraphCanvas/graphSurfaceCapture.js');
    const node = { path: '_PATH_', kind: 'stage', label: '_AUTHOR_', isEntry: true, x: 0, y: 0, width: 100, height: 100 };
    for (const detailLevel of ['full', 'simplified']) {
      await h.engine.changeLanguage('fr');
      const painted = [];
      const context = new Proxy({ measureText: text => ({ width: String(text).length }), fillText: text => painted.push(text) }, { get: (target, key) => target[key] ?? (() => {}) });
      const view = { document: { createElement: () => ({ getContext: () => context, toDataURL: () => '_PNG_' }) } };
      const exported = deferred(), decoded = deferred(), decoding = deferred();
      const pending = captureGraphSurface({ engine: { exportImage: () => exported.promise }, overlay: { detailLevel, nodes: [node] }, size: { width: 200, height: 200 }, view, container: null,
        decode: () => { decoding.resolve(); return decoded.promise; } });
      await h.engine.changeLanguage('en'); exported.resolve('_ENGINE_PNG_'); await decoding.promise;
      await h.engine.changeLanguage('it'); decoded.resolve({});
      assert.equal(await pending, '_PNG_');
      assert.ok(painted.includes('ENTRÉE'), detailLevel);
      assert.ok(!painted.includes('START') && !painted.includes('INIZIO'), detailLevel);
      assert.equal(node.label, '_AUTHOR_');
    }
    await h.engine.changeLanguage('fr');
    let image; const decoding = deferred();
    const context = new Proxy({}, { get: () => () => {} });
    const view = { Image: class { constructor() { image = this; } set src(_value) { decoding.resolve(); } }, document: { createElement: () => ({ getContext: () => context }) } };
    const pending = captureGraphSurface({ engine: { exportImage: async () => '_ENGINE_PNG_' }, view, container: null });
    await decoding.promise; await h.engine.changeLanguage('it'); image.onerror();
    await assert.rejects(pending, { message: 'Rendu du moteur illisible' });
  } finally { await h.close(); }
});


test('catalogues plats et présentateur : imbrication et clés erronées détectées, zéro réellement utilisé', () => {
  const resources = Object.fromEntries(['fr', 'en', 'it'].map(lang => [lang, { graph: catalogue(lang) }]));
  const metadata = { graph: catalogue('_meta') };
  for (const lang of ['en', 'it']) {
    assert.ok(Object.values(resources[lang].graph).every(value => typeof value === 'string'));
    const mutated = structuredClone(resources);
    mutated[lang].graph = { canvas: { unableToRead: { label: resources[lang].graph['canvas.unableToRead.label'] } } };
    assert.ok(checkCatalogues(mutated, metadata).errors.some(error => error.includes('catalogue imbriqué')));
  }
  const source = readFileSync(new URL('../src/i18n/graphPresentation.js', import.meta.url), 'utf8');
  const result = checkSource(source, 'src/i18n/graphPresentation.js', resources);
  assert.deepEqual(result.errors, []);
  assert.ok(result.used.has('graph:overlay.landmark.linkCountAtZero'));
  assert.ok(result.used.has('graph:overlay.landmark.linkCount'));
  const mutated = source.replace('graph:overlay.landmark.linkCountAtZero', 'graph:overlay.landmark.missing');
  assert.ok(checkSource(mutated, 'src/i18n/graphPresentation.js', resources).errors.some(error => error.includes('clé FR absente')));
  assert.ok(checkSource("translator(undeclaredKey)", 'src/i18n/graphPresentation.js', resources).errors.some(error => error.includes('clé dynamique non déclarée')));
});
