import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SUBSCRIPTION_PAGES,
  SUBSCRIPTIONS_SAVED_EVENT,
  announceSavedSubscriptions,
  collectPendingEntries,
  fetchSubscriptionSnapshot,
  youtubeSubscriptionKind,
} from '../src/store/mediaSubscriptionSource.js';
import {
  beginCheck,
  createEmptyRegistry,
  getNotifications,
  normalizeRegistry,
  recordCheckResult,
  syncProjectSubscriptions,
} from '../src/store/mediaSubscriptions.js';
import {
  decodeProjectFile,
  encodeProjectFile,
  normalizeProjectData,
  projectToSerializable,
  projectToRustExport,
} from '../src/store/projectModel.js';

const projectShell = (overrides = {}) => ({
  schemaVersion: 3,
  authoringMode: 'free',
  projectName: 'Projet suivi',
  projectType: 'pack',
  globalOptions: {},
  rootEntries: [],
  ...overrides,
});

function page(videos, hasNext, title = 'Chaîne') {
  return { title, videos, hasNext };
}

test('YouTube snapshot follows every page and deduplicates IDs across page boundaries', async () => {
  const calls = [];
  const pages = new Map([
    [1, page([{ id: 'a' }, { id: 'b' }], true)],
    [2, page([{ id: 'b' }, { id: 'c' }], true)],
    [3, page([{ id: 'd' }], false)],
  ]);
  const snapshot = await fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@channel/videos', title: 'Avant',
  }, async (command, args) => {
    calls.push([command, args]);
    return pages.get(args.page);
  }, { ytdlpPath: '/tools/yt-dlp' });

  assert.deepEqual(calls.map(([command, args]) => [command, args.page]), [
    ['fetch_youtube_list', 1],
    ['fetch_youtube_list', 2],
    ['fetch_youtube_list', 3],
  ]);
  assert.ok(calls.every(([, args]) => args.ytdlpPath === '/tools/yt-dlp'));
  assert.deepEqual(snapshot, { episodeIds: ['a', 'b', 'c', 'd'], title: 'Chaîne', complete: true });
});

test('reordering an unchanged playlist does not create a new episode notification', async () => {
  const original = await fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/playlist?list=PL123', title: 'Playlist',
  }, async () => page([{ id: 'video-a' }, { id: 'video-b' }], false));
  const project = normalizeProjectData(projectShell({
    mediaSubscriptions: [{
      id: 'playlist-follow', source: 'youtube', url: 'https://youtube.com/playlist?list=PL123',
      title: 'Playlist', baselineIds: original.episodeIds, enabled: true,
    }],
  }));
  const registry = syncProjectSubscriptions(
    createEmptyRegistry(), '/projects/story.mbah', project.projectName, project.mediaSubscriptions,
  );
  const reordered = await fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/playlist?list=PL123', title: 'Playlist',
  }, async () => page([{ id: 'video-b' }, { id: 'video-a' }], false));
  const check = beginCheck(registry, 'playlist-follow');
  const checked = recordCheckResult(check.registry, 'playlist-follow', check.revision, reordered);

  assert.deepEqual(reordered.episodeIds, ['video-b', 'video-a']);
  assert.deepEqual(getNotifications(checked), []);
});

test('podcast snapshot reads the RSS feed once without downloading media', async () => {
  const calls = [];
  const snapshot = await fetchSubscriptionSnapshot({
    source: 'podcast', url: 'https://example.com/feed.xml', title: 'Podcast',
  }, async (command, args) => {
    calls.push([command, args]);
    return { title: 'Podcast RSS', episodes: [{ id: 'ep-1' }, { id: 'ep-2' }] };
  });

  assert.deepEqual(snapshot, { episodeIds: ['ep-1', 'ep-2'], title: 'Podcast RSS', complete: true });
  assert.deepEqual(calls, [['fetch_podcast_feed', { url: 'https://example.com/feed.xml' }]]);
});

test('a failed page yields no snapshot or project baseline', async () => {
  const request = {
    enabled: true,
    source: 'youtube',
    url: 'https://youtube.com/@channel/videos',
    baselineIds: [],
    baselineComplete: false,
  };
  const before = structuredClone(request);
  let calls = 0;

  await assert.rejects(fetchSubscriptionSnapshot(request, async (_command, args) => {
    calls += 1;
    if (args.page === 2) throw new Error('HTTP 503');
    return page([{ id: 'video-a' }], true);
  }, { isCurrent: () => true }), /HTTP 503/);

  assert.equal(calls, 2);
  assert.deepEqual(request, before);
  assert.deepEqual(normalizeProjectData(projectShell()).mediaSubscriptions ?? [], []);
});

test('cancellation between pages stops before requesting the next page', async () => {
  let current = true;
  let calls = 0;
  await assert.rejects(fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@channel/videos',
  }, async () => {
    calls += 1;
    current = false;
    return page([{ id: 'video-a' }], true);
  }, { isCurrent: () => current }), /Vérification annulée/);

  assert.equal(calls, 1);
});

test('the page limit rejects a partial snapshot but accepts a complete final page at the limit', async () => {
  let calls = 0;
  await assert.rejects(fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@huge/videos',
  }, async () => {
    calls += 1;
    return page([{ id: `partial-${calls}` }], true);
  }), /dépasse la limite de 10 000 entrées/);
  assert.equal(calls, MAX_SUBSCRIPTION_PAGES);

  calls = 0;
  const complete = await fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@large/videos',
  }, async (_command, args) => {
    calls += 1;
    return page([{ id: `video-${args.page}` }], args.page < MAX_SUBSCRIPTION_PAGES);
  });
  assert.equal(calls, MAX_SUBSCRIPTION_PAGES);
  assert.equal(complete.episodeIds.length, MAX_SUBSCRIPTION_PAGES);
});

test('Save As invalidates an in-flight check tied to the previous project path', () => {
  const project = normalizeProjectData(projectShell({
    mediaSubscriptions: [{
      id: 'feed-follow', source: 'podcast', url: 'https://example.com/feed.xml',
      baselineIds: ['old-episode'], enabled: true,
    }],
  }));
  const registry = syncProjectSubscriptions(
    createEmptyRegistry(), '/projects/old-story.mbah', project.projectName, project.mediaSubscriptions,
  );
  const started = beginCheck(registry, 'feed-follow');
  const savedAs = syncProjectSubscriptions(
    started.registry,
    '/projects/new-story.mbah',
    project.projectName,
    project.mediaSubscriptions,
  );
  const staleMissingResult = recordCheckResult(savedAs, 'feed-follow', started.revision, {
    status: 'missing', error: 'The old project path disappeared.',
  });

  assert.equal(savedAs.subscriptions[0].projectPath, '/projects/new-story.mbah');
  assert.notEqual(savedAs.subscriptions[0].revision, started.revision);
  assert.equal(savedAs.subscriptions[0].status, 'active');
  assert.deepEqual(staleMissingResult, savedAs);
});

test('a malformed YouTube page cannot be mistaken for an empty complete baseline', async () => {
  await assert.rejects(fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@channel/videos',
  }, async () => ({ title: 'Réponse incomplète' })), /incomplète|invalide/i);
  await assert.rejects(fetchSubscriptionSnapshot({
    source: 'youtube', url: 'https://youtube.com/@channel/videos',
  }, async () => page([{ id: '' }], false)), /identifiant stable/i);
});

test('project normalization and .mbah codec retain only valid subscription settings', async () => {
  const source = projectShell({
    mediaSubscriptions: [
      {
        id: 'podcast-follow', source: 'podcast', url: 'https://example.com/feed.xml', title: ' Flux RSS ',
        baselineIds: ['ep-1', 'ep-1', '', null], enabled: true, privateField: 'drop',
      },
      {
        id: 'youtube-follow', source: 'youtube', url: 'https://youtube.com/@channel/videos', title: 'Chaîne',
        baselineIds: ['v-1'], enabled: false,
      },
      { id: 'bad-source', source: 'other', url: 'https://example.com' },
      { id: 'missing-url', source: 'podcast', baselineIds: ['ep-2'] },
      { id: 'podcast-follow', source: 'youtube', url: 'https://youtube.com/@other' },
    ],
  });
  const normalized = normalizeProjectData(source);
  const expected = [
    {
      id: 'podcast-follow', source: 'podcast', url: 'https://example.com/feed.xml',
      title: 'Flux RSS', baselineIds: ['ep-1'], enabled: true,
    },
    {
      id: 'youtube-follow', source: 'youtube', url: 'https://youtube.com/@channel/videos',
      title: 'Chaîne', baselineIds: ['v-1'], enabled: false,
    },
  ];

  assert.deepEqual(normalized.mediaSubscriptions, expected);
  assert.deepEqual(source.mediaSubscriptions[0].baselineIds, ['ep-1', 'ep-1', '', null]);
  assert.deepEqual(projectToSerializable(normalized).mediaSubscriptions, expected);
  assert.equal(Object.hasOwn(projectToRustExport(normalized), 'mediaSubscriptions'), false);

  const encoded = encodeProjectFile(normalized);
  assert.deepEqual(JSON.parse(encoded).mediaSubscriptions, expected);
  const decoded = await decodeProjectFile(encoded);
  assert.deepEqual(decoded.project.mediaSubscriptions, expected);
});

test('successful project writes publish the persisted subscription configs to the root listener', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const events = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: (event) => events.push(event) },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class FakeCustomEvent {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
  });

  try {
    const project = normalizeProjectData(projectShell({
      mediaSubscriptions: [{
        id: 'saved-follow', source: 'podcast', url: 'https://example.com/feed.xml',
        baselineIds: ['ep-1'], enabled: true,
      }],
    }));
    announceSavedSubscriptions('/projects/story.mbah', project);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, SUBSCRIPTIONS_SAVED_EVENT);
    assert.deepEqual(events[0].detail, {
      projectPath: '/projects/story.mbah',
      previousProjectPath: null,
      projectName: 'Projet suivi',
      configs: project.mediaSubscriptions,
    });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
    else delete globalThis.CustomEvent;
  }
});

function followedRegistry(url = 'https://youtube.com/@channel/videos', baselineIds = ['video-old']) {
  return syncProjectSubscriptions(createEmptyRegistry(), '/projects/story.mbah', 'Projet', [{
    id: 'follow', source: 'youtube', url, title: 'Chaîne', baselineIds, enabled: true,
  }]);
}

function checked(registry, result) {
  const check = beginCheck(registry, 'follow');
  return recordCheckResult(check.registry, 'follow', check.revision, result);
}

test('only a complete check forgets pending entries that left the source', () => {
  const pending = checked(followedRegistry(), { episodeIds: ['video-old', 'video-a', 'video-b'], complete: true });
  assert.deepEqual(getNotifications(pending)[0].episodeIds, ['video-a', 'video-b']);

  const partial = checked(pending, { episodeIds: ['video-old'], complete: false });
  assert.deepEqual(getNotifications(partial)[0].episodeIds, ['video-a', 'video-b'], 'lecture partielle : rien n’est oublié');

  const complete = checked(partial, { episodeIds: ['video-old', 'video-b'], complete: true });
  assert.deepEqual(getNotifications(complete)[0].episodeIds, ['video-b']);
  const failed = checked(complete, { error: 'HTTP 503' });
  assert.deepEqual(getNotifications(failed)[0].episodeIds, ['video-b']);
});

test('registries written with the baseline copied into seen IDs are read without duplication or new notifications', () => {
  const legacy = normalizeRegistry({ version: 1, subscriptions: [{
    id: 'follow', projectPath: '/projects/story.mbah', source: 'podcast', url: 'https://example.com/feed.xml',
    baselineIds: ['ep-1', 'ep-2'], seenIds: ['ep-1', 'ep-2', 'ep-3'], pendingIds: ['ep-2', 'ep-4'], enabled: true,
  }] });
  assert.deepEqual(legacy.subscriptions[0].seenIds, ['ep-3']);
  assert.deepEqual(legacy.subscriptions[0].pendingIds, ['ep-4']);
  const check = beginCheck(legacy, 'follow');
  const result = recordCheckResult(check.registry, 'follow', check.revision, { episodeIds: ['ep-1', 'ep-2', 'ep-3', 'ep-4'], complete: true });
  assert.deepEqual(getNotifications(result)[0].episodeIds, ['ep-4']);
  assert.deepEqual(result.subscriptions[0].seenIds, ['ep-3']);
});

test('a channel check stops at the first page holding only known IDs, a playlist check reads everything', async () => {
  const channelCalls = [];
  const known = new Set(['a', 'b']);
  const channel = await fetchSubscriptionSnapshot({ source: 'youtube', url: 'https://youtube.com/@channel/videos' },
    async (_command, args) => { channelCalls.push(args.page); return page([{ id: 'a' }, { id: 'b' }], true); },
    { knownIds: known });
  assert.deepEqual(channelCalls, [1]);
  assert.equal(channel.complete, false);

  const withNew = [];
  const fresh = await fetchSubscriptionSnapshot({ source: 'youtube', url: 'https://youtube.com/@channel/videos' },
    async (_command, args) => {
      withNew.push(args.page);
      return args.page === 1 ? page([{ id: 'new' }, { id: 'a' }], true) : page([{ id: 'b' }], true);
    }, { knownIds: known });
  assert.deepEqual(withNew, [1, 2]);
  assert.deepEqual(fresh.episodeIds, ['new', 'a', 'b']);

  const playlistCalls = [];
  const playlist = await fetchSubscriptionSnapshot({ source: 'youtube', url: 'https://youtube.com/playlist?list=PL1' },
    async (_command, args) => { playlistCalls.push(args.page); return page([{ id: `p${args.page}` }], args.page < 3); },
    { knownIds: new Set(['p1', 'p2', 'p3']) });
  assert.deepEqual(playlistCalls, [1, 2, 3]);
  assert.equal(playlist.complete, true);
});

test('YouTube mixes and single videos are not followable', () => {
  assert.equal(youtubeSubscriptionKind('https://www.youtube.com/watch?v=abc&list=RDabc'), null);
  assert.equal(youtubeSubscriptionKind('https://youtu.be/abc?list=RDMMabc'), null);
  assert.equal(youtubeSubscriptionKind('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(youtubeSubscriptionKind('https://www.youtube.com/watch?v=abc&list=PL123'), 'playlist');
  assert.equal(youtubeSubscriptionKind('https://www.youtube.com/@chaine/videos'), 'channel');
});

test('pending entries are searched in later pages, bounded, without selecting anything', async () => {
  const fetched = [];
  const found = await collectPendingEntries({
    firstPage: page([{ id: 'v1' }], true),
    pendingIds: ['v41', 'v42'],
    fetchPage: async (number) => {
      fetched.push(number);
      return page(number === 4 ? [{ id: 'v41' }, { id: 'v42' }] : [{ id: `v${number}` }], true);
    },
  });
  assert.deepEqual(found.map((video) => video.id), ['v41', 'v42']);
  assert.deepEqual(fetched, [2, 3, 4]);

  let calls = 0;
  const missing = await collectPendingEntries({
    firstPage: page([{ id: 'v1' }], true),
    pendingIds: ['gone'],
    fetchPage: async () => { calls += 1; return page([{ id: 'other' }], true); },
  });
  assert.deepEqual(missing, []);
  assert.equal(calls, MAX_SUBSCRIPTION_PAGES - 1);
});

test('installed-tools-only snapshots ask Rust not to download and return the reported tool state', async () => {
  const calls = [];
  const snapshot = await fetchSubscriptionSnapshot({ source: 'youtube', url: 'https://youtube.com/playlist?list=PL1' },
    async (command, args) => {
      calls.push([command, args]);
      return { ...page([{ id: `p${args.page}` }], args.page < 2), tools: { ytdlpUpdateDue: args.page === 2, jsRuntimeMissing: true } };
    },
    { installedToolsOnly: true });
  assert.deepEqual(calls.map(([, args]) => args.installedToolsOnly), [true, true]);
  assert.deepEqual(snapshot.tools, { ytdlpMissing: false, ytdlpUpdateDue: true, jsRuntimeMissing: true });

  const manual = await fetchSubscriptionSnapshot({ source: 'youtube', url: 'https://youtube.com/playlist?list=PL1' },
    async (_command, args) => {
      assert.equal('installedToolsOnly' in args, false, 'le mode manuel garde ses arguments historiques');
      return page([{ id: 'p1' }], false);
    });
  assert.equal('tools' in manual, false);
});
