import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';

import { runner } from './reactHookDriver.mjs';
import { action, presence, stage } from './advancedViewFixtures.mjs';

// Seules les frontières média/IPC et les composants décoratifs sont doublés.
// Navigation, contrôles, timeline, châssis et effets viennent de la production.
const doubles = new Map([
  ['react/jsx-runtime', 'export const Fragment = "fragment"; export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;'],
  ['@tauri-apps/api/core', 'export async function invoke() { return globalThis.__flatTestStory; }'],
  ['./FlatImage', 'export function FlatImage() { return null; }'],
  ['../../utils/logger', 'export const logger = { error() {} };'],
  ['../../utils/audioPlayer', 'export function disposeAudioPlayerRef(ref) { ref.current?.destroy(); ref.current = null; }'],
  ['./flatMedia.js', 'export async function loadFlatMedia(request) { return request; } export function createFlatAudio() { return globalThis.__flatTestAudio; }'],
  ['../../components/common/Tooltip', 'export function Tooltip({ children }) { return children; }'],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (doubles.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(doubles.get(specifier))}`, shortCircuit: true };
    }
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
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
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

const { FlatSimulator } = await import('../src/tabs/EmulatorTab/FlatSimulator.jsx');
const { LuniiShell } = await import('../src/tabs/EmulatorTab/LuniiShell.jsx');
const { documentFlatGraph, projectedFlatGraph } = await import('../src/tabs/EmulatorTab/flatGraph.js');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

for (const options of [['b', null, 'c'], ['b', null, null, 'c'], ['b', 'absent', 'c']]) {
  test(`la molette traverse les options pendantes dans les deux sens : ${JSON.stringify(options)}`, async (t) => {
    const stages = ['b', 'c'].map((uuid) => stage(uuid, {
      name: presence(uuid.toUpperCase()),
      controls: { presence: 'value', wheel: presence(true) },
    }));
    const view = { stages, actions: [action('choix', options)], entry: { status: 'missing' } };
    if (options.includes('absent')) view.actions[0].options[1].target.stagePath = null;
    const graph = documentFlatGraph(view, {});
    const originalOptions = [...graph.actions.get(view.actions[0].path).options];
    const { hook, shell } = await mountSimulator(t, { kind: 'document', graph, startId: stages[0].path });
    assert.equal(shell().title, 'B');
    shell().onRight();
    assert.equal(shell().title, 'C');
    assert.equal(shell().sub, `${options.length} / ${options.length}`);
    shell().onLeft();
    assert.equal(shell().title, 'B');
    shell().onLeft();
    assert.equal(shell().title, 'C');
    shell().onRight();
    assert.equal(shell().title, 'B');
    assert.deepEqual(graph.actions.get(view.actions[0].path).options, originalOptions);
    hook.flush();
  });
}

test('toutes les options pendantes laissent la molette sur place sans boucler', async (t) => {
  const b = stage('b', { name: presence('B'), controls: { presence: 'value', wheel: presence(true) } });
  const choice = action('choix', ['b', null, null]);
  const graph = documentFlatGraph({ stages: [b], actions: [choice], entry: { status: 'missing' } }, {});
  const { shell } = await mountSimulator(t, { kind: 'document', graph, startId: b.path });
  // Le contexte est déjà choisi ; rendre ses destinations pendantes éprouve
  // aussi la borne de recherche quand aucune option n'est jouable.
  graph.actions.get(choice.path).options[0] = null;
  for (const direction of ['onRight', 'onLeft']) {
    for (let turn = 0; turn < 3; turn += 1) shell()[direction]();
    assert.equal(shell().title, 'B');
    assert.equal(shell().sub, '1 / 3');
  }
  assert.deepEqual(graph.actions.get(choice.path).options, [null, null, null]);
});

function audioDouble() {
  return {
    currentTime: 0, duration: 30, paused: false,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    advance() { if (!this.paused) this.currentTime += 1; },
    destroy() {},
  };
}

function sourceFixture(origin, pause) {
  const controls = { wheel: true, ok: true, home: true, autoplay: false };
  if (pause !== undefined) controls.pause = pause;
  const story = {
    title: 'Essai',
    stageNodes: [{ uuid: 'b', name: 'B', squareOne: true, audio: 'son.mp3', controlSettings: controls }],
    actionNodes: [],
  };
  if (origin === 'archive') {
    globalThis.__flatTestStory = story;
    return { kind: 'pack', zipPath: '/travail/essai.zip' };
  }
  if (origin === 'projection') {
    return {
      kind: 'document',
      graph: projectedFlatGraph({ story, media: [{ assetName: 'son.mp3', kind: 'disk', path: '/travail/son.wav' }] }),
    };
  }
  const b = stage('b', {
    name: presence('B'), squareOne: presence(true),
    audio: { presence: 'value', assetRef: 'son.mp3' },
    controls: {
      presence: 'value', complete: pause !== undefined,
      ...Object.fromEntries(['wheel', 'ok', 'home', 'pause', 'autoplay'].map((key) => [key, presence(controls[key])])),
    },
  });
  return {
    kind: 'document',
    graph: documentFlatGraph({ stages: [b], actions: [], entry: { status: 'unique', stagePath: b.path } }, {
      authoring: { mediaBindings: [{ assetRef: 'son.mp3', path: '/travail/son.wav', status: 'resolved' }] },
    }),
  };
}

async function mountSimulator(t, source, extra = {}) {
  const hook = runner(() => FlatSimulator({ source, ...extra }));
  t.after(() => hook.unmount());
  hook.render();
  hook.flush();
  await settle();
  hook.render();
  hook.flush();
  await settle();
  return { hook, shell: () => hook.render().props };
}

for (const origin of ['archive', 'projection', 'document']) {
  for (const pause of [undefined, null, false, true]) {
    test(`Pause ${String(pause)} suit le contrôle de l'Écran (${origin})`, async (t) => {
      const audio = audioDouble();
      globalThis.__flatTestAudio = audio;
      const { shell } = await mountSimulator(t, sourceFixture(origin, pause));
      audio.advance();
      shell().onPause(); // Appel direct : la garde doit aussi être dans le handler.
      audio.advance();
      assert.equal(audio.currentTime, pause === true ? 1 : 2);
      assert.equal(shell().paused, pause === true);
      const buttons = elements(LuniiShell(shell())).filter((element) => element.type === 'button');
      const pauseButton = buttons.find((button) => ['Pause', 'Reprendre'].includes(button.props['aria-label']));
      assert.equal(Boolean(pauseButton.props.disabled), pause !== true);
      assert.equal(buttons.find((button) => button.props.children === 'Auto').props.disabled, undefined);
      assert.equal(buttons.find((button) => button.props.children === 'Transparence').props.disabled, undefined);
      shell().playbackControls.onSeek(12);
      assert.equal(audio.currentTime, 12, 'la navigation temporelle propre au simulateur reste active');
      if (pause === true) {
        shell().onPause();
        audio.advance();
        assert.equal(audio.currentTime, 13);
        assert.equal(shell().paused, false);
      }
    });
  }
}
