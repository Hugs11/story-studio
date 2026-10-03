import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';

import { runner } from './reactHookDriver.mjs';

// Les composants de présentation et l'IPC sont doublés. Le shell, le workspace,
// la sélection et la projection restent ceux de production.
const doubles = new Map([
  ['react/jsx-runtime', 'export const Fragment = "fragment"; export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;'],
  ['@tauri-apps/api/core', 'export function invoke(command, args) { return globalThis.__switchProjection(command, args); }'],
  ['../store/ProjectActionsContext', 'export const ProjectActionsContext = { Provider: "actions" }; export function useProjectActions() { return { onSelect: (id) => globalThis.__switchSelections.push(id) }; }'],
  ['../store/ProjectContext', 'export const ProjectContext = { Provider: "project" };'],
  ['../store/ShortcutLabelsContext', 'export const ShortcutLabelsContext = { Provider: "shortcuts" };'],
  ['../store/MediaTransferContext', 'export const MediaTransferProvider = "transfer";'],
  ['./renderDeferred', 'export const renderDeferred = (element) => element;'],
]);
for (const [specifier, names] of [
  ['../components/diagram/DiagramPanel', ['DiagramPanel']],
  ['../components/FloatingSimulator/FloatingSimulator', ['FloatingSimulator']],
  ['../components/ModeSelector/ModeSelector', ['ModeSelector']],
  ['../components/structure/StructurePanel', ['StructurePanel']],
  ['../components/structure/PanelResizeHandle', ['PanelResizeHandle']],
  ['./PanelSortContext', ['PanelSortContext', 'SortablePanelItem']],
  ['./SettingsPanel', ['SettingsPanel']],
  ['./SettingsPanelHeader', ['SettingsPanelHeader']],
  ['./WorkspaceEmptyState', ['WorkspaceEmptyState']],
  ['./layout/TitleBar', ['TitleBar']],
  ['./layout/Toolbar', ['Toolbar']],
  ['./AppModals', ['AppModals']],
]) {
  doubles.set(specifier, names.map((name) => `export const ${name} = '${name}';`).join('\n'));
}
const uiReact = `export * from '${new URL('./reactHookDriver.mjs', import.meta.url).href}';
  export const Fragment = 'fragment'; export const Suspense = 'suspense';
  export const lazy = (load) => ({ load });`;
registerHooks({
  resolve(specifier, context, next) {
    const source = specifier === 'react' && /\/(WorkspaceView|AppShell)\.jsx$/.test(context.parentURL ?? '')
      ? uiReact : doubles.get(specifier);
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL) {
      const direct = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(direct))) {
        for (const suffix of ['.js', '.jsx']) {
          const url = new URL(`${specifier}${suffix}`, context.parentURL);
          if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return {
        format: 'module', shortCircuit: true,
        source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code,
      };
    }
    return next(url, context);
  },
});

const { useProjectedSimulation } = await import('../src/hooks/useProjectedSimulation.js');
const { normalizeProjectData, projectToRustExport } = await import('../src/store/projectModel/schema.js');
const { WorkspaceView } = await import('../src/workspace/WorkspaceView.jsx');
const { AppShell } = await import('../src/components/AppShell.jsx');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const idle = { status: 'idle', graph: null, error: null };

function fixture(projectType, title) {
  return normalizeProjectData({
    projectType, projectName: title, packMetadata: { title },
    rootEntries: [{ id: 'identique', type: 'story', name: title, audio: '/media/lecture.wav' }],
  });
}

for (const [from, to] of [['simple', 'pack'], ['pack', 'simple']]) {
  for (const pending of [false, true]) {
    test(`remplacer ${from} par ${to} invalide la projection ${pending ? 'en cours' : 'terminée'}`, async (t) => {
      let project = fixture(from, 'Projet A');
      let projectEpoch = 1;
      const launch = { nodeId: 'root' };
      let finish;
      let calls = 0;
      const projectStory = () => {
        calls += 1;
        return new Promise((resolve) => { finish = resolve; });
      };
      const projection = { story: { title: 'Projet A', stageNodes: [], actionNodes: [] }, media: [] };
      const hook = runner(() => useProjectedSimulation({ project, projectEpoch, launch, projectStory }));
      t.after(() => hook.unmount());
      hook.render();
      hook.flush();
      await settle();
      if (!pending) {
        finish(projection);
        await settle();
        assert.equal(hook.render().status, 'ready');
      }
      project = fixture(to, 'Projet B');
      projectEpoch = 2;
      assert.deepEqual(hook.render(), idle, 'aucun ancien graphe dès le premier rendu, avant les effets');
      hook.flush();
      if (pending) finish(projection);
      await settle();

      assert.deepEqual(hook.render(), idle);
      assert.equal(calls, 1, 'le lancement de A ne doit pas reprojeter B');
    });
  }
}

test('éditer conserve l’instantané ; changer de travail exige un nouveau lancement', async (t) => {
  let project = fixture('pack', 'Projet A');
  const nameA = projectToRustExport(project).name;
  const nameB = projectToRustExport(fixture('pack', 'Projet B')).name;
  let projectEpoch = 1;
  let launch = { nodeId: 'root' };
  const titles = [];
  const projectStory = async (dto) => {
    titles.push(dto.name);
    return { story: { title: dto.name, stageNodes: [], actionNodes: [] }, media: [] };
  };
  const hook = runner(() => useProjectedSimulation({ project, projectEpoch, launch, projectStory }));
  t.after(() => hook.unmount());
  hook.render(); hook.flush(); await settle();
  const snapshot = hook.render().graph;
  project = fixture('pack', 'Projet A modifié');
  assert.equal(hook.render().graph, snapshot);
  hook.flush(); await settle();
  assert.deepEqual(titles, [nameA]);
  project = fixture('pack', 'Projet B');
  projectEpoch = 2;
  assert.deepEqual(hook.render(), idle);
  hook.flush(); await settle();
  assert.deepEqual(titles, [nameA]);
  launch = { nodeId: 'root' };
  hook.render(); hook.flush(); await settle();
  assert.equal(hook.render().graph.title, nameB);
  assert.deepEqual(titles, [nameA, nameB]);
});

test('une projection quittée avant son appel ne lit jamais le nouveau projet', async (t) => {
  let project = fixture('simple', 'Projet A');
  let projectEpoch = 1;
  const launch = { nodeId: 'root' };
  const calls = [];
  const projectStory = async (dto) => { calls.push(dto.name); return null; };
  const hook = runner(() => useProjectedSimulation({ project, projectEpoch, launch, projectStory }));
  t.after(() => hook.unmount());
  hook.render(); hook.flush();
  project = fixture('pack', 'Projet B');
  projectEpoch = 2;
  hook.render(); hook.flush(); await settle();
  assert.deepEqual(calls, []);
  assert.deepEqual(hook.render(), idle);
});

test('un refus tardif de A ne remplace pas la projection prête de B', async (t) => {
  let project = fixture('simple', 'Projet A');
  const nameA = projectToRustExport(project).name;
  const nameB = projectToRustExport(fixture('pack', 'Projet B')).name;
  let projectEpoch = 1;
  let launch = { nodeId: 'root' };
  let rejectA;
  const projectStory = (dto) => dto.name === nameA
    ? new Promise((_resolve, reject) => { rejectA = reject; })
    : Promise.resolve({ story: { title: dto.name, stageNodes: [], actionNodes: [] }, media: [] });
  const hook = runner(() => useProjectedSimulation({ project, projectEpoch, launch, projectStory }));
  t.after(() => hook.unmount());
  hook.render(); hook.flush(); await settle();
  project = fixture('pack', 'Projet B'); projectEpoch = 2; launch = { nodeId: 'root' };
  hook.render(); hook.flush(); await settle();
  rejectA(new Error('Refus ancien')); await settle();
  assert.equal(hook.render().status, 'ready');
  assert.equal(hook.render().graph.title, nameB);
});

function elements(node) {
  if (typeof node === 'function') return elements(node({ dragHandleProps: {} }));
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

function workspaceHarness(t, from) {
  let project = fixture(from, 'Projet A');
  let projectEpoch = 1;
  const selections = [];
  const requests = [];
  globalThis.__switchSelections = selections;
  globalThis.__switchProjection = (command, args) => {
    assert.equal(command, 'project_pack_for_simulation');
    return new Promise((resolve) => requests.push({ dto: JSON.parse(args.projectJson), resolve }));
  };
  const workspaceViewState = {
    showTree: true, showSettings: false, showDiagram: false,
    panelOrder: ['structure', 'settings', 'diagram'], treePanelWidth: 320, settingsPanelWidth: 400,
  };
  const hook = runner(() => WorkspaceView({ project, projectEpoch, selectedId: 'root', workspaceViewState }));
  hook.render(); hook.flush();
  t.after(() => {
    hook.unmount();
    delete globalThis.__switchSelections; delete globalThis.__switchProjection;
  });
  const props = (name) => elements(hook.render()).find((element) => element.type === name).props;
  return {
    hook, requests, selections, props,
    replace(to) { project = fixture(to, 'Projet B'); projectEpoch += 1; },
  };
}

function selectableProjection(title) {
  return {
    story: { title, stageNodes: [{ uuid: 'stage', squareOne: true, audio: 'lecture.wav' }], actionNodes: [] },
    media: [{ assetName: 'lecture.wav', kind: 'disk', path: '/media/lecture.wav', entryId: 'identique' }],
    entryIdByStage: { stage: 'identique' },
  };
}

for (const [from, to] of [['simple', 'pack'], ['pack', 'simple']]) {
  test(`le workspace ferme l’écoute ${from}→${to} et refuse sa sélection tardive`, async (t) => {
    const f = workspaceHarness(t, from);
    f.props('StructurePanel').onSimulateRoot();
    f.hook.render(); f.hook.flush(); await settle();
    f.requests[0].resolve(selectableProjection('Projet A')); await settle();
    const oldSimulator = f.props('FloatingSimulator');
    assert.equal(oldSimulator.anchorId, 'root');
    assert.equal(oldSimulator.documentStatus, 'ready');
    oldSimulator.onActiveNodeChange('stage');
    assert.deepEqual(f.selections, ['identique'], 'la sélection fonctionne pendant l’écoute de A');
    f.selections.length = 0;
    f.replace(to);
    const closed = f.props('FloatingSimulator');
    assert.equal(closed.anchorId, null);
    assert.equal(closed.documentGraph, null);
    assert.equal(closed.documentStatus, 'idle');
    oldSimulator.onActiveNodeChange('stage');
    assert.deepEqual(f.selections, [], 'le même identifiant ne sélectionne rien dans B');
    f.hook.flush(); await settle();
    assert.equal(f.requests.length, 1);
    f.props('StructurePanel').onSimulateRoot();
    f.hook.render(); f.hook.flush(); await settle();
    assert.equal(f.requests[1].dto.name, projectToRustExport(fixture(to, 'Projet B')).name);
    f.requests[1].resolve(selectableProjection('Projet B')); await settle();
    assert.equal(f.props('FloatingSimulator').documentGraph.title, 'Projet B');
  });
}

test('le workspace ferme aussi une écoute ZIP lors du changement de projet', (t) => {
  const f = workspaceHarness(t, 'pack');
  f.props('StructurePanel').onSimulateZip('/media/pack.zip');
  assert.equal(f.props('FloatingSimulator').zipPath, '/media/pack.zip');
  f.hook.flush();
  f.replace('simple');
  assert.equal(f.props('FloatingSimulator').zipPath, null);
  f.hook.flush();
  assert.equal(f.props('FloatingSimulator').zipPath, null);
});

test('App transmet l’époque du store et AppShell la passe au workspace', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /workspace:\s*\{\s*project:\s*store\.project,\s*projectEpoch:\s*store\.workEpochRef\.current,/);
  const project = fixture('pack', 'Projet');
  const workspace = { project, projectEpoch: 42 };
  const shell = AppShell({
    mediaTransfer: {}, titleBar: {}, toolbar: {}, workspace, bottomPanel: {}, bottomBar: {},
  });
  const view = elements(shell).find((element) => element.props.project === project);
  assert.equal(view.props.projectEpoch, 42);
});
