import test from 'node:test';
import { readFileSync } from 'node:fs';
import { beforeFicheAbandon, protectDraft } from '../src/store/catalogue/metadataDraft.js';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { runner } from './reactHookDriver.mjs';
import { announceSavedSubscriptions, findProjectSubscription, getProjectFollowedSources } from '../src/store/mediaSubscriptionSource.js';
import { KEYS } from '../src/store/persistentSettings.js';

const mockModuleSources = new Map([
  ['@tauri-apps/api/core', `export const invoke = (...args) => globalThis.__mediaSubscriptionHookMocks.invoke(...args);`],
  ['@tauri-apps/plugin-fs', `export const exists = (...args) => globalThis.__mediaSubscriptionHookMocks.exists(...args);`],
  ['@tauri-apps/plugin-dialog', `export const open = (...args) => globalThis.__mediaSubscriptionHookMocks.open(...args);`],
]);
const mockModuleUrls = new Map([...mockModuleSources].map(([specifier, source]) => [
  specifier,
  `data:text/javascript,${encodeURIComponent(source)}`,
]));

registerHooks({
  resolve(specifier, context, next) {
    const url = mockModuleUrls.get(specifier);
    if (url) return { url, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.includes('/src/')) {
      return { url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/src/store/projectIO.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function loadProjectFromPath(...args) {
          return globalThis.__mediaSubscriptionHookMocks.loadProjectFromPath(...args);
        }`,
      };
    }
    if (url.endsWith('/src/hooks/useImportSession.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export function useImportSession() {
          return {
            captureImport: () => ({ copies: {}, isCurrent: () => true, release() {} }),
            dispatchFiles: (...args) => globalThis.__mediaSubscriptionHookMocks.dispatchFiles(...args),
            handleImportMediaEpisodes: (...args) => globalThis.__mediaSubscriptionHookMocks.handleImportMediaEpisodes(...args),
          };
        }`,
      };
    }
    if (url.endsWith('/src/hooks/useOsFileDrop.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export function useOsFileDrop(...args) {
          return globalThis.__mediaSubscriptionHookMocks.useOsFileDrop(...args);
        }`,
      };
    }
    return next(url, context);
  },
});

const { useMediaSubscriptions } = await import('../src/hooks/useMediaSubscriptions.js');
const { useMediaImport } = await import('../src/hooks/useMediaImport.js');

const PROJECT_PATH = '/projects/story.mbah';
const COPY_PATH = '/projects/story-copy.mbah';
const PODCAST_REQUEST = {
  enabled: true,
  source: 'podcast',
  url: 'https://example.com/feed.xml',
  title: 'Podcast suivi',
  baselineIds: ['episode-old'],
  baselineComplete: true,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storageFor(values = new Map()) {
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function createHarness({ values = new Map() } = {}) {
  const previousGlobals = new Map();
  for (const key of ['window', 'localStorage', 'CustomEvent', 'setTimeout', 'clearTimeout', '__mediaSubscriptionHookMocks']) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const storage = storageFor(values);
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 0;
  const browserWindow = {
    localStorage: storage,
    __TAURI_INTERNALS__: {},
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
      return true;
    },
  };

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: FakeCustomEvent });
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    writable: true,
    value: (callback, _delay, ...args) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, args });
      return id;
    },
  });
  Object.defineProperty(globalThis, 'clearTimeout', {
    configurable: true,
    writable: true,
    value: (id) => timers.delete(id),
  });

  const calls = {
    invoke: [], exists: [], open: [], openProject: [], showImport: [], errors: [],
    mediaImports: [], subscriptionApplications: [],
  };
  let invokeHandler = async (command) => (command === 'fetch_podcast_feed'
    ? { title: 'Podcast à jour', episodes: [{ id: 'episode-old' }, { id: 'episode-new' }] }
    : { title: 'Chaîne à jour', videos: [{ id: 'video-new' }], hasNext: false });
  let existsHandler = async () => true;
  let openHandler = async () => null;
  let openProjectHandler = async (path) => {
    store.savePath = path;
    return true;
  };

  const mocks = {
    invoke: (...args) => {
      calls.invoke.push(args);
      return invokeHandler(...args);
    },
    exists: (...args) => {
      calls.exists.push(args);
      return existsHandler(...args);
    },
    open: (...args) => {
      calls.open.push(args);
      return openHandler(...args);
    },
    loadProjectFromPath: async (...args) => ({ data: { projectName: 'Projet suivi', mediaSubscriptions: [] }, args }),
    dispatchFiles: async () => {},
    handleImportMediaEpisodes: async (items) => {
      calls.mediaImports.push(items);
      return {
        total: items.length,
        failures: 0,
        imported: items.length,
        importedPaths: [],
        importedEpisodeIds: [],
      };
    },
    useOsFileDrop: () => {},
  };
  Object.defineProperty(globalThis, '__mediaSubscriptionHookMocks', {
    configurable: true,
    writable: true,
    value: mocks,
  });

  const store = {
    project: { projectName: 'Projet suivi', mediaSubscriptions: [] },
    savePath: null,
    workEpochRef: { current: 0 },
    setSelectedId() {},
    setProject(next) {
      this.project = typeof next === 'function' ? next(this.project) : next;
    },
  };
  const leaveGuard = { current: null };
  const hookRunner = runner(() => useMediaSubscriptions({
    store,
    leaveGuard,
    openProject: (path) => {
      calls.openProject.push(path);
      return openProjectHandler(path);
    },
    onShowImport: (source) => calls.showImport.push(source),
    showErrorDialog: (error) => calls.errors.push(error),
  }));
  hookRunner.render();
  hookRunner.flush();

  return {
    values,
    leaveGuard,
    storage,
    store,
    calls,
    render: () => hookRunner.render(),
    replayEffects: () => hookRunner.replayEffects(),
    async runStartup() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback(...timer.args);
      }
      await flushAsyncWork();
      return hookRunner.render().panelProps;
    },
    setInvoke(handler) { invokeHandler = handler; },
    setExists(handler) { existsHandler = handler; },
    setOpen(handler) { openHandler = handler; },
    setOpenProject(handler) { openProjectHandler = handler; },
    saveProject(path, project = store.project, previousProjectPath = null) {
      store.savePath = path;
      announceSavedSubscriptions(path, project, previousProjectPath);
    },
    registry() {
      const raw = storage.getItem(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY);
      return raw == null ? null : JSON.parse(raw);
    },
    unmount() { hookRunner.unmount(); },
    dispose() {
      hookRunner.unmount();
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function activate(harness, request = PODCAST_REQUEST, path = PROJECT_PATH) {
  harness.render().applyRequest(request);
  const config = harness.store.project.mediaSubscriptions[0];
  harness.saveProject(path);
  return config.id;
}

test('import source list belongs to the saved project path, includes pauses, excludes foreign and unsaved follows', () => {
  const harness = createHarness();
  try {
    harness.render().applyRequest(PODCAST_REQUEST);
    assert.deepEqual(getProjectFollowedSources('podcast'), []);
    harness.saveProject(PROJECT_PATH);
    const id = harness.store.project.mediaSubscriptions[0].id;
    assert.deepEqual(getProjectFollowedSources('podcast').map((s) => [s.id, s.url, s.state]), [[id, PODCAST_REQUEST.url, 'active']]);
    assert.deepEqual(getProjectFollowedSources('youtube'), []);
    harness.render().panelProps.onToggleSubscription(id);
    assert.equal(getProjectFollowedSources('podcast')[0].state, 'paused');
    harness.store.savePath = COPY_PATH;
    assert.deepEqual(getProjectFollowedSources('podcast'), []);
    harness.store.savePath = null;
    assert.deepEqual(getProjectFollowedSources('podcast'), []);
  } finally { harness.dispose(); }
  assert.deepEqual(getProjectFollowedSources('podcast'), []);
});

async function checkOnce(harness) {
  await harness.render().panelProps.onCheck();
  return harness.render().panelProps;
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a local follow enters the registry only after its configured project is saved', async () => {
  const harness = createHarness();
  try {
    const api = harness.render();
    api.applyRequest(PODCAST_REQUEST);

    assert.equal(harness.registry()?.subscriptions.length ?? 0, 0);
    await harness.render().panelProps.onCheck();
    assert.equal(harness.calls.invoke.length, 0);

    const config = harness.store.project.mediaSubscriptions[0];
    harness.saveProject(PROJECT_PATH);
    const saved = harness.registry().subscriptions;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, config.id);
    assert.equal(saved[0].status, 'active');
  } finally {
    harness.dispose();
  }
});

test('following a source with no selected episodes does not download its cover image', async () => {
  const harness = createHarness();
  const request = { ...PODCAST_REQUEST };
  const importRunner = runner(() => useMediaImport({
    store: harness.store,
    subscriptions: {
      prepareRequest: async (value) => value,
      applyRequest: (...args) => harness.calls.subscriptionApplications.push(args),
    },
    maybeCopyToProject: async (path) => path,
    copyGeneratedMediaToProject: async (path) => path,
    extractAudioEmbeddedImage: async () => null,
    addPathsToMediaLibrary: async () => {},
    persistProjectSnapshot: async () => {},
    workspaceDirRef: { current: null },
    importedPackPendingMetaRef: { current: false },
    runFunnelLanding: async (_mode, run) => run(),
    onRevealImportedMedia: () => {},
    setImportNotice: () => {},
    setActiveDropZone: () => {},
    showErrorDialog: () => {},
  }));
  try {
    const imports = importRunner.render();
    importRunner.flush();
    await imports.handlePodcastFunnelImport([], {
      title: 'Podcast suivi',
      imageUrl: 'https://example.com/cover.jpg',
    }, null, request);

    assert.deepEqual(harness.calls.invoke, []);
    assert.deepEqual(harness.calls.mediaImports, [[]]);
    assert.equal(harness.calls.subscriptionApplications.length, 1);
    assert.equal(harness.calls.subscriptionApplications[0][0], request);
  } finally {
    importRunner.unmount();
    harness.dispose();
  }
});

test('saving a project config from another machine does not locally activate it', async () => {
  const harness = createHarness();
  try {
    const foreignProject = {
      projectName: 'Projet importé',
      mediaSubscriptions: [{
        id: 'foreign-follow', source: 'youtube', url: 'https://youtube.com/@story/videos',
        title: 'Chaîne', baselineIds: ['video-old'], enabled: true,
      }],
    };
    harness.saveProject(PROJECT_PATH, foreignProject);

    assert.deepEqual(harness.registry().subscriptions, []);
    await harness.render().panelProps.onCheck();
    assert.equal(harness.calls.exists.length, 0);
  } finally {
    harness.dispose();
  }
});

test('local pause survives project saves, resume checks again, and dismissal persists across remount', async () => {
  const values = new Map();
  const harness = createHarness({ values });
  let id;
  try {
    id = activate(harness);
    let panel = await checkOnce(harness);
    assert.deepEqual(panel.notifications[0].episodeIds, ['episode-new']);

    panel.onToggleSubscription(id);
    harness.saveProject(PROJECT_PATH);
    assert.equal(harness.registry().subscriptions[0].status, 'paused');
    panel = harness.render().panelProps;
    assert.deepEqual(panel.notifications[0].episodeIds, ['episode-new']);
    await panel.onCheck();
    assert.equal(harness.calls.invoke.length, 1);

    panel.onToggleSubscription(id);
    await flushAsyncWork();
    panel = harness.render().panelProps;
    assert.equal(harness.registry().subscriptions[0].status, 'active');
    assert.equal(harness.calls.invoke.length, 2);
    assert.deepEqual(panel.notifications[0].episodeIds, ['episode-new']);

    panel.onDismissNotification(id);
    assert.deepEqual(harness.render().panelProps.notifications, []);
    const persisted = JSON.parse(values.get(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY));
    assert.deepEqual(persisted.subscriptions[0].pendingIds, []);
    assert.ok(persisted.subscriptions[0].seenIds.includes('episode-new'));
  } finally {
    harness.dispose();
  }

  const remounted = createHarness({ values });
  try {
    assert.deepEqual(remounted.render().panelProps.notifications, []);
  } finally {
    remounted.dispose();
  }
});

test('an explicit subscription checkbox save applies its enabled value after registry sync', () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    harness.render().applyRequest({ ...PODCAST_REQUEST, enabled: false, enabledTouched: true });
    harness.saveProject(PROJECT_PATH);
    assert.equal(harness.registry().subscriptions[0].status, 'paused');

    harness.render().applyRequest({ ...PODCAST_REQUEST, enabled: true, enabledTouched: true });
    harness.saveProject(PROJECT_PATH);
    assert.equal(harness.registry().subscriptions[0].id, id);
    assert.equal(harness.registry().subscriptions[0].status, 'active');
  } finally {
    harness.dispose();
  }
});

test('canceling the guarded project change leaves its durable notification untouched', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);
    harness.store.savePath = '/projects/other.mbah';
    harness.setOpenProject(async () => false);

    await harness.render().panelProps.onOpenNotification(id);

    assert.deepEqual(harness.calls.openProject, [PROJECT_PATH]);
    assert.equal(harness.calls.showImport.length, 0);
    assert.deepEqual(harness.render().panelProps.notifications[0].episodeIds, ['episode-new']);
    assert.deepEqual(harness.registry().subscriptions[0].pendingIds, ['episode-new']);
  } finally {
    harness.dispose();
  }
});

test('a notification for the already open project goes straight to its configured import', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);

    await harness.render().panelProps.onOpenNotification(id);

    assert.deepEqual(harness.calls.openProject, []);
    assert.equal(harness.calls.showImport.length, 1);
    assert.equal(harness.calls.showImport[0].subscriptionId, id);
    assert.equal(harness.calls.showImport[0].source, 'podcast');
    assert.equal(harness.calls.showImport[0].url, PODCAST_REQUEST.url);
    assert.deepEqual(harness.registry().subscriptions[0].pendingIds, ['episode-new']);
  } finally {
    harness.dispose();
  }
});

test('concurrent clicks while opening a followed project trigger only one guarded load', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);
    harness.store.savePath = '/projects/other.mbah';
    const openingProject = deferred();
    harness.setOpenProject(async (path) => {
      await openingProject.promise;
      harness.store.savePath = path;
      return true;
    });

    const firstOpen = harness.render().panelProps.onOpenNotification(id);
    await harness.render().panelProps.onOpenNotification(id);
    assert.deepEqual(harness.calls.openProject, [PROJECT_PATH]);
    assert.equal(harness.calls.showImport.length, 0);

    openingProject.resolve();
    await firstOpen;
    assert.equal(harness.calls.showImport.length, 1);
    assert.equal(harness.calls.showImport[0].subscriptionId, id);
  } finally {
    harness.dispose();
  }
});

test('Save As moves one subscription and a later save at the old path cannot take it back', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);

    harness.saveProject(COPY_PATH, harness.store.project, PROJECT_PATH);
    assert.equal(harness.registry().subscriptions.length, 1);
    assert.equal(harness.registry().subscriptions[0].id, id);
    assert.equal(harness.registry().subscriptions[0].projectPath, COPY_PATH);
    assert.deepEqual(harness.registry().subscriptions[0].pendingIds, ['episode-new']);

    harness.saveProject(PROJECT_PATH);
    assert.equal(harness.registry().subscriptions.length, 1);
    assert.equal(harness.registry().subscriptions[0].projectPath, COPY_PATH);
  } finally {
    harness.dispose();
  }
});

test('a late check result is ignored after Save As changes the subscription path', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    const reply = deferred();
    const invoked = deferred();
    harness.setInvoke((command) => {
      invoked.resolve(command);
      return reply.promise;
    });
    const checking = harness.render().panelProps.onCheck();
    assert.equal(await invoked.promise, 'fetch_podcast_feed');

    harness.saveProject(COPY_PATH, harness.store.project, PROJECT_PATH);
    reply.resolve({ title: 'Podcast à jour', episodes: [{ id: 'episode-late' }] });
    await checking;

    const saved = harness.registry().subscriptions[0];
    assert.equal(saved.id, id);
    assert.equal(saved.projectPath, COPY_PATH);
    assert.equal(saved.status, 'active');
    assert.deepEqual(saved.pendingIds, []);
    assert.deepEqual(harness.render().panelProps.notifications, []);
  } finally {
    harness.dispose();
  }
});

test('unsubscribing during a check prevents its late result from restoring the subscription', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    const reply = deferred();
    const invoked = deferred();
    harness.setInvoke((command) => {
      invoked.resolve(command);
      return reply.promise;
    });
    const checking = harness.render().panelProps.onCheck();
    await invoked.promise;

    harness.render().panelProps.onRemoveSubscription(id);
    reply.resolve({ title: 'Podcast à jour', episodes: [{ id: 'episode-late' }] });
    await checking;

    assert.deepEqual(harness.registry().subscriptions, []);
    assert.deepEqual(harness.render().panelProps.notifications, []);
  } finally {
    harness.dispose();
  }
});

test('resuming during a check coalesces one fresh check after the stale result is discarded', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    const firstReply = deferred();
    const firstInvoke = deferred();
    const secondInvoke = deferred();
    let callCount = 0;
    harness.setInvoke(() => {
      callCount += 1;
      if (callCount === 1) {
        firstInvoke.resolve();
        return firstReply.promise;
      }
      secondInvoke.resolve();
      return { title: 'Podcast à jour', episodes: [{ id: 'episode-old' }, { id: 'episode-new' }] };
    });
    const checking = harness.render().panelProps.onCheck();
    await firstInvoke.promise;

    const toggle = harness.render().panelProps.onToggleSubscription;
    toggle(id);
    toggle(id);
    firstReply.resolve({ title: 'Podcast tardif', episodes: [{ id: 'episode-stale' }] });
    await checking;
    await secondInvoke.promise;
    await flushAsyncWork();

    assert.equal(callCount, 2);
    assert.deepEqual(harness.render().panelProps.notifications[0].episodeIds, ['episode-new']);
    assert.equal(harness.registry().subscriptions[0].status, 'active');
  } finally {
    harness.dispose();
  }
});

test('several new source notifications are shown in order without overwriting the first toast', async () => {
  const harness = createHarness();
  try {
    const first = activate(harness);
    harness.render().applyRequest({ ...PODCAST_REQUEST, url: 'https://example.com/second.xml', title: 'Deuxième source' });
    const second = harness.store.project.mediaSubscriptions[1].id;
    harness.saveProject(PROJECT_PATH);
    let panel = await checkOnce(harness);
    assert.equal(panel.notifications.length, 2);
    assert.equal(panel.toast.id, first);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.equal(panel.toast.id, second);
    assert.equal(panel.notifications.length, 2, 'fermer un toast ne supprime pas son historique');
    panel.onDismissNotification(second);
    panel = harness.render().panelProps;
    assert.equal(panel.toast, null);
    assert.deepEqual(panel.notifications.map((item) => item.id), [first]);
  } finally {
    harness.dispose();
  }
});

test('an import made without touching the follow checkbox never suspends the subscription', () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    // Case affichée décochée par défaut (ancienne surface) mais jamais modifiée.
    harness.render().applyRequest({ ...PODCAST_REQUEST, enabled: false, enabledTouched: false }, ['episode-new']);
    harness.saveProject(PROJECT_PATH);
    assert.equal(harness.registry().subscriptions[0].id, id);
    assert.equal(harness.registry().subscriptions[0].status, 'active');
    assert.equal(harness.store.project.mediaSubscriptions[0].enabled, true);
  } finally {
    harness.dispose();
  }
});

test('the import surfaces see the open project follow state, pending until the first save', () => {
  const harness = createHarness();
  try {
    assert.equal(findProjectSubscription('podcast', PODCAST_REQUEST.url), null);
    harness.render().applyRequest(PODCAST_REQUEST);
    const id = harness.store.project.mediaSubscriptions[0].id;
    // Hôte en casse différente et barre finale : même source.
    assert.deepEqual(findProjectSubscription('podcast', 'https://EXAMPLE.com/feed.xml/'), { subscriptionId: id, state: 'pending' });
    assert.equal(findProjectSubscription('youtube', PODCAST_REQUEST.url), null);

    harness.saveProject(PROJECT_PATH);
    assert.deepEqual(findProjectSubscription('podcast', PODCAST_REQUEST.url), { subscriptionId: id, state: 'active' });
    harness.render().panelProps.onToggleSubscription(id);
    assert.equal(findProjectSubscription('podcast', PODCAST_REQUEST.url).state, 'paused');
  } finally {
    harness.dispose();
  }
  assert.equal(findProjectSubscription('podcast', PODCAST_REQUEST.url), null, 'la recherche est retirée au démontage');
});

test('a project config never enabled on this machine is reported inactive', () => {
  const harness = createHarness();
  try {
    harness.store.project = {
      projectName: 'Projet importé',
      mediaSubscriptions: [{ id: 'foreign', source: 'podcast', url: PODCAST_REQUEST.url, title: 'Flux', baselineIds: [], enabled: true }],
    };
    harness.store.savePath = PROJECT_PATH;
    assert.deepEqual(findProjectSubscription('podcast', PODCAST_REQUEST.url), { subscriptionId: 'foreign', state: 'inactive' });
  } finally {
    harness.dispose();
  }
});

test('opening a YouTube notification does not re-read a registered source before importing', async () => {
  const harness = createHarness();
  try {
    const youtube = {
      enabled: true, source: 'youtube', url: 'https://youtube.com/playlist?list=PL123', title: 'Playlist',
      baselineIds: ['video-old'], baselineComplete: true,
    };
    const id = activate(harness, youtube);
    harness.calls.invoke.length = 0;
    const request = { ...youtube, subscriptionId: id, baselineIds: ['video-old'], baselineComplete: false, enabledTouched: false };
    assert.equal(await harness.render().prepareRequest(request), request);
    const touched = { ...request, enabledTouched: true };
    assert.equal(await harness.render().prepareRequest(touched), touched);
    assert.equal(harness.calls.invoke.length, 0);

    const fresh = { ...youtube, url: 'https://youtube.com/playlist?list=PL999', baselineComplete: false };
    const prepared = await harness.render().prepareRequest(fresh);
    assert.equal(harness.calls.invoke.length, 1);
    assert.equal(prepared.baselineComplete, true);
  } finally {
    harness.dispose();
  }
});

test('a notification whose project disappeared marks the follow missing instead of opening a recent project', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);
    harness.store.savePath = '/projects/other.mbah';
    harness.setExists(async () => false);

    await harness.render().panelProps.onOpenNotification(id);

    assert.deepEqual(harness.calls.openProject, []);
    assert.equal(harness.calls.showImport.length, 0);
    assert.equal(harness.calls.errors.length, 1);
    const saved = harness.registry().subscriptions[0];
    assert.equal(saved.status, 'missing');
    assert.deepEqual(saved.pendingIds, ['episode-new'], 'la notification reste disponible');
    assert.equal(harness.render().panelProps.subscriptions[0].status, 'missing');
  } finally {
    harness.dispose();
  }
});

test('following a file copy of a followed project gives the copy its own ID; Save As still transfers', () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    // Copie de fichier ouverte : même configuration, autre chemin.
    harness.store.savePath = COPY_PATH;
    harness.render().applyRequest({ ...PODCAST_REQUEST, enabledTouched: true });
    const copyConfig = harness.store.project.mediaSubscriptions;
    assert.equal(copyConfig.length, 1);
    assert.notEqual(copyConfig[0].id, id);
    harness.saveProject(COPY_PATH);

    const saved = harness.registry().subscriptions;
    assert.equal(saved.length, 2);
    assert.equal(saved.find((item) => item.id === id).projectPath, PROJECT_PATH);
    assert.equal(saved.find((item) => item.id === copyConfig[0].id).projectPath, COPY_PATH);
  } finally {
    harness.dispose();
  }
});

test('a registry write refused by local storage is reported without crashing', () => {
  const harness = createHarness();
  try {
    harness.storage.setItem = () => { throw new Error('QuotaExceededError'); };
    harness.render().applyRequest(PODCAST_REQUEST);
    harness.saveProject(PROJECT_PATH);
    const panel = harness.render().panelProps;
    assert.equal(panel.subscriptions.length, 1, 'le suivi reste actif en mémoire');
    assert.match(panel.storageError, /pas pu être enregistrés/);
  } finally {
    harness.dispose();
  }
});

test('an unreadable registry is backed up under its declared key instead of being silently overwritten', () => {
  const values = new Map([[KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY, '{"subscriptions": [tronqué']]);
  const harness = createHarness({ values });
  try {
    assert.equal(values.get(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY_BACKUP), '{"subscriptions": [tronqué');
    assert.match(harness.render().panelProps.storageError, /illisible/);
    activate(harness);
    assert.equal(values.get(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY_BACKUP), '{"subscriptions": [tronqué');
    assert.equal(harness.registry().subscriptions.length, 1);
  } finally {
    harness.dispose();
  }
});

test('a background YouTube check is postponed while yt-dlp was never prepared on this machine', async () => {
  const harness = createHarness();
  try {
    activate(harness, {
      enabled: true, source: 'youtube', url: 'https://youtube.com/@story/videos', title: 'Chaîne',
      baselineIds: ['video-old'], baselineComplete: true,
    });
    const panel = await checkOnce(harness);
    assert.equal(harness.calls.invoke.length, 0);
    assert.equal(panel.subscriptions[0].status, 'error');
    assert.match(panel.subscriptions[0].error, /reportée/);
    assert.deepEqual(panel.notifications, []);

    harness.storage.setItem(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    await checkOnce(harness);
    assert.equal(harness.calls.invoke.length, 1);
    assert.deepEqual(harness.registry().subscriptions[0].pendingIds, ['video-new']);
  } finally {
    harness.dispose();
  }
});

const YOUTUBE_REQUEST = {
  enabled: true, source: 'youtube', url: 'https://youtube.com/@story/videos', title: 'Chaîne',
  baselineIds: ['video-old'], baselineComplete: true,
};

test('the background check reads YouTube with installed tools only, never the manual provisioning mode', async () => {
  const harness = createHarness();
  try {
    harness.storage.setItem(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    activate(harness, YOUTUBE_REQUEST);
    await checkOnce(harness);
    const [command, args] = harness.calls.invoke.at(-1);
    assert.equal(command, 'fetch_youtube_list');
    assert.equal(args.installedToolsOnly, true);

    // L'activation explicite depuis l'import garde le comportement manuel.
    harness.calls.invoke.length = 0;
    await harness.render().prepareRequest({ ...YOUTUBE_REQUEST, url: 'https://youtube.com/playlist?list=PL9', baselineComplete: false });
    assert.equal(harness.calls.invoke[0][1].installedToolsOnly, undefined);
  } finally {
    harness.dispose();
  }
});

test('a due tool update is offered in the panel, and its button updates then checks again', async () => {
  const harness = createHarness();
  try {
    harness.storage.setItem(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    activate(harness, YOUTUBE_REQUEST);
    harness.setInvoke(async (command) => (command === 'update_ytdlp' ? undefined : {
      title: 'Chaîne', videos: [{ id: 'video-new' }], hasNext: false,
      tools: { ytdlpMissing: false, ytdlpUpdateDue: true, jsRuntimeMissing: false },
    }));
    let panel = await checkOnce(harness);
    assert.deepEqual(panel.youtubeTools, { missing: false, updating: false, error: null });
    assert.deepEqual(harness.registry().subscriptions[0].pendingIds, ['video-new'], 'la lecture a eu lieu avec la copie installée');

    const update = deferred();
    harness.setInvoke(async (command) => (command === 'update_ytdlp' ? update.promise : {
      title: 'Chaîne', videos: [{ id: 'video-new' }], hasNext: false,
      tools: { ytdlpMissing: false, ytdlpUpdateDue: false, jsRuntimeMissing: false },
    }));
    harness.calls.invoke.length = 0;
    const running = panel.onUpdateTools();
    assert.equal(harness.render().panelProps.youtubeTools.updating, true);
    update.resolve();
    await running;
    await flushAsyncWork();
    assert.deepEqual(harness.calls.invoke.map(([command]) => command), ['update_ytdlp', 'fetch_youtube_list']);
    panel = harness.render().panelProps;
    assert.equal(panel.youtubeTools, null, 'outils à jour : plus rien n’est proposé');
  } finally {
    harness.dispose();
  }
});

test('a missing YouTube tool is a soft per-subscription error with an install offer, and update errors stay readable', async () => {
  const harness = createHarness();
  try {
    harness.storage.setItem(KEYS.YOUTUBE_CGU_ACCEPTED, 'true');
    activate(harness, YOUTUBE_REQUEST);
    harness.setInvoke(async (command) => {
      if (command === 'update_ytdlp') throw { code: 'network', message: 'Réseau indisponible.' };
      throw { code: 'tool_missing', message: 'L’outil YouTube n’est pas installé : vérification reportée.' };
    });
    let panel = await checkOnce(harness);
    assert.deepEqual(panel.youtubeTools, { missing: true, updating: false, error: null });
    assert.equal(panel.subscriptions[0].status, 'error');
    assert.deepEqual(panel.notifications, []);
    assert.deepEqual(harness.calls.invoke.map(([command]) => command), ['fetch_youtube_list'], 'aucune installation implicite');

    await panel.onUpdateTools();
    panel = harness.render().panelProps;
    assert.equal(panel.youtubeTools.missing, true);
    assert.match(panel.youtubeTools.error, /Mise à jour impossible : Réseau indisponible/);
    assert.equal(harness.calls.errors.length, 0, 'pas de popup');
  } finally {
    harness.dispose();
  }
});

test('without a YouTube subscription the tool offer never appears', async () => {
  const harness = createHarness();
  try {
    activate(harness);
    const panel = await checkOnce(harness);
    assert.equal(panel.youtubeTools, null);
    assert.equal(harness.calls.invoke[0][1]?.installedToolsOnly, undefined);
  } finally {
    harness.dispose();
  }
});

test('relocating a paused follow whose project went missing keeps it paused until explicitly resumed', async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);
    harness.render().panelProps.onToggleSubscription(id);
    harness.store.savePath = '/projects/other.mbah';
    harness.setExists(async () => false);
    await harness.render().panelProps.onOpenNotification(id);
    let entry = harness.render().panelProps.subscriptions[0];
    assert.equal(entry.status, 'missing');
    assert.equal(entry.enabled, false, 'la pause reste visible');

    globalThis.__mediaSubscriptionHookMocks.loadProjectFromPath = async () => ({
      data: { projectName: 'Projet retrouvé', mediaSubscriptions: [{ id }] },
    });
    harness.setOpen(async () => '/moved/story.mbah');
    await harness.render().panelProps.onRelocateSubscription(id);
    entry = harness.render().panelProps.subscriptions[0];
    assert.equal(entry.status, 'paused');
    assert.equal(entry.enabled, false);
    assert.equal(harness.registry().subscriptions[0].paused, true);
    assert.equal(harness.registry().subscriptions[0].projectPath, '/moved/story.mbah');

    harness.render().panelProps.onToggleSubscription(id);
    await flushAsyncWork();
    assert.equal(harness.registry().subscriptions[0].paused, false);
  } finally {
    harness.dispose();
  }
});

// La fiche réelle fournit protectDraft via beforeFicheAbandon ; la question et
// ses réponses sont pilotées ici, sans remplacer le chemin de chargement du hook.
for (const alreadyOpen of [false, true]) test(`Catalogue dirty draft gates notification opening (already open=${alreadyOpen})`, async () => {
  const harness = createHarness();
  try {
    const id = activate(harness);
    await checkOnce(harness);
    if (!alreadyOpen) harness.store.savePath = '/projects/other.mbah';
    const draft = { original: { title: { state: 'source', value: '' } }, entries: { title: { state: 'defined', value: 'Modifié' } } };
    let choice = 'stay';
    let questions = 0;
    const ficheAbandon = { current: () => protectDraft(draft, { ask: async () => { questions++; return choice; }, save: async () => true }) };
    harness.leaveGuard.current = () => beforeFicheAbandon(ficheAbandon, () => true);
    await harness.render().panelProps.onOpenNotification(id);
    assert.equal(questions, 1, 'Annuler répond à la question d’abandon');
    assert.deepEqual(harness.calls.openProject, []);
    assert.deepEqual(harness.calls.showImport, [], 'le Catalogue reste ouvert');
    assert.equal(harness.render().panelProps.toast.id, id);
    choice = 'discard';
    await harness.render().panelProps.onOpenNotification(id);
    assert.equal(questions, 2);
    assert.deepEqual(harness.calls.openProject, alreadyOpen ? [] : [PROJECT_PATH]);
    assert.equal(harness.calls.showImport.length, 1, 'le chemin de sortie du Catalogue et d’import est atteint');
    assert.equal(harness.calls.showImport[0].subscriptionId, id);
    assert.equal(harness.render().panelProps.toast, null);
    assert.equal(harness.render().panelProps.notifications.length, 1, 'ouvrir ne supprime pas les nouveautés non importées');
  } finally { harness.dispose(); }
});

test('Catalogue exposes its existing fiche guard and opening an import leaves Catalogue and preferences', () => {
  const catalogue = readFileSync(new URL('../src/components/Catalogue/CatalogueScreen.jsx', import.meta.url), 'utf8');
  assert.match(catalogue, /leaveGuard.current = \(\) => beforeFicheAbandon\(ficheAbandon, \(\) => true\)/);
  assert.match(catalogue, /return \(\) => \{ leaveGuard.current = null; \}/);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const callback = app.match(/onShowImport: (\(source\) => \{[\s\S]*?\n    \}),/)[1];
  for (const source of [{ source: 'podcast' }, { source: 'youtube' }]) {
    const calls = [];
    const onShowImport = new Function('modals', 'setSubscriptionImportSource', 'setYoutubeFunnelMode', `return (${callback});`)(
      { close: name => calls.push(['close', name]), open: name => calls.push(['open', name]) },
      item => calls.push(['source', item]), mode => calls.push(['youtube', mode]),
    );
    onShowImport(source);
    assert.deepEqual(calls, [['close', 'catalogue'], ['close', 'prefs'], ['source', source], source.source === 'podcast' ? ['open', 'podcastImport'] : ['youtube', 'editor']]);
  }
  assert.match(app, /openProject: handleLoadRecent/);
  assert.match(app, /optionsTabProps: \{ \.\.\.optionsTabProps, subscriptions: subscriptions.panelProps \}/);
});


test('startup without unread notifications has no reminder, even after new checks', async () => {
  const harness = createHarness();
  try {
    assert.equal(harness.render().panelProps.toast, null);
    const id = activate(harness);
    const panel = await harness.runStartup();
    assert.equal(panel.toast.id, id);
    assert.equal(panel.toast.kind, undefined);
    panel.onCloseToast();
    await harness.render().panelProps.onCheck();
    assert.equal(harness.render().panelProps.toast, null);
  } finally { harness.dispose(); }
});

test('startup with a single pending notification shows its ordinary toast once, even when the check brings it again', async () => {
  const values = new Map();
  const seed = createHarness({ values });
  let id;
  try {
    id = activate(seed);
    await checkOnce(seed);
    seed.saveProject(PROJECT_PATH);
  } finally { seed.dispose(); }
  const harness = createHarness({ values });
  try {
    const first = harness.render().panelProps;
    assert.equal(first.notifications.length, 1);
    assert.deepEqual(first.toast, first.notifications[0], 'exactement le toast ordinaire de la notification');
    assert.equal(first.toast.id, id);
    harness.setInvoke(async () => ({ title: 'Podcast à jour', episodes: [
      { id: 'episode-old' }, { id: 'episode-new' }, { id: 'episode-newer' },
    ] }));
    harness.replayEffects();
    let panel = await harness.runStartup();
    assert.equal(panel.toast.id, id);
    assert.equal(panel.toast.count, 2);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.equal(panel.toast, null, 'un seul toast, pas de doublon');
    assert.equal(panel.notifications[0].count, 2, 'la croix ne marque rien comme lu');
    await harness.render().panelProps.onCheck();
    assert.equal(harness.render().panelProps.toast, null);
  } finally { harness.dispose(); }
});

const SECOND_REQUEST = { ...PODCAST_REQUEST, url: 'https://example.com/second.xml', title: 'Second suivi' };

test('startup with a single pending notification keeps its toast first when the check brings another follow', async () => {
  const values = new Map();
  const seed = createHarness({ values });
  let id;
  try {
    id = activate(seed);
    await checkOnce(seed);
    seed.render().applyRequest(SECOND_REQUEST);
    seed.saveProject(PROJECT_PATH);
  } finally { seed.dispose(); }
  const harness = createHarness({ values });
  try {
    assert.equal(harness.render().panelProps.toast.id, id);
    harness.replayEffects();
    let panel = await harness.runStartup();
    assert.equal(panel.notifications.length, 2);
    assert.equal(panel.toast.id, id, 'le toast du snapshot reste le premier');
    assert.equal(panel.toast.count, 1);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.notEqual(panel.toast.id, id, 'le toast de l’autre suivi suit, sans perte');
    assert.deepEqual(panel.toast, panel.notifications.find((entry) => entry.id === panel.toast.id));
    panel.onCloseToast();
    assert.equal(harness.render().panelProps.toast, null);
    assert.equal(harness.render().panelProps.notifications.length, 2, 'la croix ne marque rien comme lu');
  } finally { harness.dispose(); }
});

test('startup with a single pending notification: the same notification with the same count stays in place, not moved to the end', async () => {
  const values = new Map();
  const seed = createHarness({ values });
  let secondId;
  try {
    // Le premier suivi n'a rien de nouveau ; seul le second a une notification.
    seed.setInvoke(async (command, args) => ({ title: 'Podcast', episodes: args.url === SECOND_REQUEST.url
      ? [{ id: 'episode-old' }, { id: 'episode-new' }] : [{ id: 'episode-old' }] }));
    activate(seed);
    seed.render().applyRequest(SECOND_REQUEST);
    seed.saveProject(PROJECT_PATH);
    secondId = seed.store.project.mediaSubscriptions.find((item) => item.url === SECOND_REQUEST.url).id;
    await checkOnce(seed);
    assert.deepEqual(seed.render().panelProps.notifications.map((entry) => entry.id), [secondId]);
  } finally { seed.dispose(); }
  const harness = createHarness({ values });
  try {
    assert.equal(harness.render().panelProps.toast.id, secondId);
    harness.replayEffects();
    // Premier suivi vérifié avant le second : il ramène une nouveauté, le second le même compte.
    let panel = await harness.runStartup();
    assert.equal(panel.notifications.length, 2);
    assert.equal(panel.toast.id, secondId, 'le toast déjà affiché n’est pas remis en fin de file');
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.notEqual(panel.toast.id, secondId);
    panel.onCloseToast();
    assert.equal(harness.render().panelProps.toast, null, 'aucun doublon');
  } finally { harness.dispose(); }
});

test('startup with a single pending notification: Open uses the ordinary notification path', async () => {
  const values = new Map();
  const seed = createHarness({ values });
  let id;
  try {
    id = activate(seed);
    await checkOnce(seed);
    seed.saveProject(PROJECT_PATH);
  } finally { seed.dispose(); }
  const harness = createHarness({ values });
  try {
    const panel = harness.render().panelProps;
    assert.equal(panel.toast.id, id);
    await panel.onOpenNotification(panel.toast.id);
    assert.equal(harness.calls.showImport.length, 1);
    assert.equal(harness.calls.showImport[0].subscriptionId, id);
  } finally { harness.dispose(); }
});

test('startup reminder snapshots unread follows once, before new individual toasts, and closing preserves unread state', async () => {
  const values = new Map();
  const seed = createHarness({ values });
  let ids;
  try {
    activate(seed);
    seed.render().applyRequest(SECOND_REQUEST);
    seed.saveProject(PROJECT_PATH);
    await checkOnce(seed);
    seed.render().applyRequest({ ...PODCAST_REQUEST, url: 'https://example.com/third.xml', title: 'Troisième suivi' });
    seed.saveProject(PROJECT_PATH);
    ids = seed.store.project.mediaSubscriptions.map((item) => item.id);
    assert.equal(seed.render().panelProps.notifications.length, 2);
  } finally { seed.dispose(); }
  const harness = createHarness({ values });
  try {
    assert.deepEqual(harness.render().panelProps.toast, { kind: 'startup-reminder', count: 2 });
    harness.setInvoke(async () => ({ title: 'Podcast à jour', episodes: [
      { id: 'episode-old' }, { id: 'episode-new' }, { id: 'episode-newer' },
    ] }));
    harness.replayEffects(); // La sonde StrictMode ne recrée pas le rappel.
    let panel = await harness.runStartup();
    assert.deepEqual(panel.toast, { kind: 'startup-reminder', count: 2 });
    assert.equal(panel.notifications.length, 3, 'le nouveau suivi découvert au démarrage ne rejoint pas le rappel');
    assert.equal(panel.notifications[0].count, 2);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.equal(panel.toast.id, ids[0], 'le toast individuel de la vérification suit le rappel');
    assert.equal(panel.toast.count, 2);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.equal(panel.toast.id, ids[1]);
    panel.onCloseToast();
    panel = harness.render().panelProps;
    assert.equal(panel.toast.id, ids[2], 'le nouveau suivi garde aussi son toast individuel');
    panel.onCloseToast();
    assert.equal(harness.render().panelProps.notifications[0].count, 2, 'la croix ne marque rien comme lu');
    harness.replayEffects();
    await harness.runStartup();
    await harness.render().panelProps.onCheck();
    assert.equal(harness.render().panelProps.toast, null, 'ni rerendu, ni retour écran, ni vérification ne répète le rappel');
  } finally { harness.dispose(); }
});

for (const source of ['podcast', 'youtube']) {
  test(source + ': reimporting an existing follow keeps one project and registry entry', () => {
    const harness = createHarness();
    try {
      const request = { ...PODCAST_REQUEST, source, url: source === 'podcast' ? PODCAST_REQUEST.url : 'https://youtube.com/playlist?list=PL123' };
      const id = activate(harness, request);
      harness.render().applyRequest({ ...request, subscriptionId: id, enabledTouched: false }, ['new-entry']);
      harness.saveProject(PROJECT_PATH);
      assert.deepEqual(harness.store.project.mediaSubscriptions.map((item) => item.id), [id]);
      assert.deepEqual(harness.registry().subscriptions.map((item) => item.id), [id]);
    } finally { harness.dispose(); }
  });
}
