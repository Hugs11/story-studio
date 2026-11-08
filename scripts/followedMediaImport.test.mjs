import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { sameSubscriptionSource, setProjectSubscriptionLookup } from '../src/store/mediaSubscriptionSource.js';

let calls = [];
globalThis.__followedImportInvoke = async (command) => {
  calls.push(command);
  return { title: 'Source', episodes: [], videos: [], hasNext: false };
};
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/api/core') return { url: moduleUrl('export const invoke = (...args) => globalThis.__followedImportInvoke(...args);'), shortCircuit: true };
    if (specifier === '@tauri-apps/api/event') return { url: moduleUrl('export const listen = async () => () => {};'), shortCircuit: true };
    if (specifier === 'react/jsx-runtime') return { url: moduleUrl('export const Fragment = "fragment"; export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;'), shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const suffix of ['.js', '.jsx', '/index.js']) {
        const url = base.href + suffix;
        if (existsSync(fileURLToPath(url))) return next(url, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/AppModalPortal.jsx')) return { format: 'module', shortCircuit: true, source: 'export const AppModalPortal = ({children}) => children;' };
    if (url.endsWith('/useMessageLanguage.js')) return { format: 'module', shortCircuit: true, source: 'export const useMessageLanguage = () => {};' };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return { format: 'module', shortCircuit: true, source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code };
    }
    return next(url, context);
  },
});

const { useSubscriptionFollow } = await import('../src/components/MediaSubscriptions/useSubscriptionFollow.js');
const { PodcastImportModal } = await import('../src/components/PodcastImport/PodcastImportModal.jsx');
const { YoutubeImportFunnel } = await import('../src/components/YoutubeImport/YoutubeImportFunnel.jsx');
const { KEYS, write } = await import('../src/store/persistentSettings.js');
globalThis.window = { localStorage: { getItem: () => 'true', setItem() {} } };
write(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  // Déplier seulement les composants sans hooks utiles à ces interactions.
  if (typeof node.type === 'function' && ['FollowedSourceNotice', 'FollowedSourceChoices', 'AppModalPortal'].includes(node.type.name)) return elements(node.type(node.props));
  return [node, ...elements(node.props.children)];
}

for (const source of ['podcast', 'youtube']) {
  const Component = source === 'podcast' ? PodcastImportModal : YoutubeImportFunnel;
  const id = source === 'podcast' ? 'podcast-url-input' : 'youtube-funnel-url';
  const url = source === 'podcast' ? 'https://example.com/feed' : 'https://www.youtube.com/playlist?list=PL1';
  const config = { id: 'one', source, url, title: 'Ma source', state: 'active' };
  const checkbox = (nodes) => nodes.filter((n) => n.type === 'input' && n.props.type === 'checkbox');
  const input = (nodes) => nodes.find((n) => n.props.id === id);
  function mount(sources, props = {}) {
    const release = setProjectSubscriptionLookup((kind, value) => {
      const found = sources.find((s) => sameSubscriptionSource(s, { source: kind, url: value }));
      return found ? { subscriptionId: found.id, state: found.state } : null;
    }, (kind) => sources.filter((s) => s.source === kind));
    const host = runner(() => Component({ mode: 'editor', onClose() {}, onImport() {}, ...props }));
    calls = [];
    const render = () => elements(host.render());
    const nodes = render(); host.flush();
    return { host, nodes, render, dispose() { host.unmount(); release(); } };
  }

  test(`${source}: single followed source prefills without loading, replaces checkbox, supports normalized links and preferences`, () => {
    let managed = 0;
    const view = mount([config], { onManageSubscriptions() { managed++; } });
    try {
      assert.equal(input(view.nodes).props.value, url);
      assert.deepEqual(calls, []);
      assert.equal(checkbox(view.nodes).length, 0);
      assert.ok(view.nodes.some((n) => n.props.children === 'Déjà suivi pour ce projet'));
      const manageButton = view.nodes.find((n) => n.type === 'button' && n.props.children === 'Gérer les suivis des médias dans les préférences');
      assert.ok(manageButton, 'complete visible label also provides the accessible name without an arrow');
      manageButton.props.onClick();
      assert.equal(managed, 1);
      input(view.nodes).props.onChange({ target: { value: url + '#fragment' } });
      assert.equal(checkbox(view.render()).length, 0);
      input(view.render()).props.onChange({ target: { value: 'https://example.org/other' } });
      assert.equal(checkbox(view.render()).length, 1);
    } finally { view.dispose(); }
  });

  test(`${source}: multiple sources are titled choices, click fills without loading; paused is followed`, () => {
    const view = mount([config, { ...config, id: 'two', title: 'Autre source', url: url + '/other', state: 'paused' }]);
    try {
      assert.equal(input(view.nodes).props.value, '');
      assert.equal(checkbox(view.nodes).length, 1);
      const list = view.nodes.find((n) => n.type === 'ul');
      assert.ok(view.nodes.some((n) => n.type === 'p' && n.props.id === list.props['aria-labelledby']));
      view.nodes.find((n) => n.type === 'button' && n.props.children === 'Autre source').props.onClick();
      const nodes = view.render();
      assert.equal(input(nodes).props.value, url + '/other');
      assert.equal(checkbox(nodes).length, 0);
      assert.ok(nodes.some((n) => n.props.children === 'Déjà suivi (suspendu) pour ce projet'));
      assert.deepEqual(calls, []);
    } finally { view.dispose(); }
  });

  test(`${source}: no followed source keeps an empty field and checkbox`, () => {
    const view = mount([]);
    try {
      assert.equal(input(view.nodes).props.value, '');
      assert.equal(checkbox(view.nodes).length, 1);
      assert.deepEqual(calls, []);
    } finally { view.dispose(); }
  });

  test(`${source}: explicit load keeps followed source read-only in the episode list`, async () => {
    const view = mount([config]);
    try {
      await view.nodes.find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
      const nodes = view.render();
      assert.ok(calls.includes(source === 'podcast' ? 'fetch_podcast_feed' : 'fetch_youtube_list'));
      assert.equal(checkbox(nodes).length, 0);
      assert.ok(nodes.some((n) => n.props.children === 'Déjà suivi pour ce projet'));
    } finally { view.dispose(); }
  });

  test(`${source}: notification initialSource still loads automatically`, async () => {
    const view = mount([config], { initialSource: { ...config, subscriptionId: config.id, pendingIds: ['new'] } });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(calls.includes(source === 'podcast' ? 'fetch_podcast_feed' : 'fetch_youtube_list'));
      const nodes = view.render();
      assert.equal(checkbox(nodes).length, 0);
      assert.ok(nodes.some((n) => n.props.role === 'status' && n.props.children === 'Déjà suivi pour ce projet'));
      assert.equal(nodes.filter((n) => n.type === 'button' && n.props.children === 'Gérer les suivis des médias dans les préférences').length, 0);
    } finally { view.dispose(); }
  });
}

for (const source of ['podcast', 'youtube']) {
  test(source + ': reimport preserves existing subscription identity', () => {
    const release = setProjectSubscriptionLookup(() => ({ subscriptionId: 'existing', state: 'active' }));
    const host = runner(() => useSubscriptionFollow(source, null));
    try {
      host.render().sourceLoaded('https://example.com/source');
      assert.deepEqual(host.render().requestFields(), { enabled: true, enabledTouched: false, subscriptionId: 'existing' });
    } finally { host.unmount(); release(); }
  });
}
