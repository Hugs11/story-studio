import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgeEpisodes,
  beginCheck,
  createEmptyRegistry,
  dismissNotification,
  getNotifications,
  loadRegistry,
  markSubscriptionMissing,
  normalizeProjectSubscriptions,
  normalizeRegistry,
  recordCheckResult,
  relocateSubscription,
  removeSubscription,
  saveRegistry,
  setSubscriptionPaused,
  syncProjectSubscriptions,
} from '../src/store/mediaSubscriptions.js';
import { KEYS } from '../src/store/persistentSettings.js';

function config(overrides = {}) {
  return {
    id: 'subscription-1',
    source: 'podcast',
    url: 'https://example.com/feed.xml',
    title: 'Mon podcast',
    baselineIds: ['old-episode'],
    ...overrides,
  };
}

function addProject(configs = [config()], path = '/projects/story.mbah') {
  return syncProjectSubscriptions(createEmptyRegistry(), path, 'Story', configs);
}

function completeCheck(registry, id, result) {
  const check = beginCheck(registry, id);
  assert.notEqual(check.revision, null);
  return recordCheckResult(check.registry, id, check.revision, result);
}

test('normalizes project subscriptions and deduplicates IDs without accepting invalid sources', () => {
  assert.deepEqual(
    normalizeProjectSubscriptions([
      config({ baselineIds: ['old-episode', 'old-episode', '  ', 'new-id'] }),
      config({ source: 'youtube', url: 'https://youtube.com/@other' }),
      config({ id: 'youtube-follow', source: 'youtube', url: 'https://youtube.com/@other' }),
      config({ id: 'invalid', source: 'other', url: 'https://example.com' }),
    ]),
    [
      {
        id: 'subscription-1',
        source: 'podcast',
        url: 'https://example.com/feed.xml',
        title: 'Mon podcast',
        baselineIds: ['old-episode', 'new-id'],
        enabled: true,
      },
      {
        id: 'youtube-follow',
        source: 'youtube',
        url: 'https://youtube.com/@other',
        title: 'Mon podcast',
        baselineIds: ['old-episode'],
        enabled: true,
      },
    ],
  );
});

test('new episodes create a durable per-subscription notification and dismissal prevents repeats', () => {
  const registry = addProject();
  const discovered = completeCheck(registry, 'subscription-1', {
    episodeIds: ['old-episode', 'episode-a', 'episode-a'],
    title: 'Flux à jour',
    checkedAt: 1234,
  });

  assert.deepEqual(getNotifications(discovered), [{
    id: 'subscription-1',
    subscriptionId: 'subscription-1',
    projectPath: '/projects/story.mbah',
    projectName: 'Story',
    source: 'podcast',
    url: 'https://example.com/feed.xml',
    title: 'Flux à jour',
    count: 1,
    episodeIds: ['episode-a'],
    checkedAt: 1234,
  }]);

  const dismissed = dismissNotification(discovered, 'subscription-1');
  assert.deepEqual(getNotifications(dismissed), []);
  assert.equal(dismissed.subscriptions[0].seenIds.includes('episode-a'), true);

  const checkedAgain = completeCheck(dismissed, 'subscription-1', {
    episodeIds: ['old-episode', 'episode-a'],
  });
  assert.deepEqual(getNotifications(checkedAgain), []);
});

test('supports several sources and relocates existing subscriptions on Save As', () => {
  const configs = [
    config(),
    config({
      id: 'youtube-channel',
      source: 'youtube',
      url: 'https://youtube.com/@channel/videos',
      title: 'Chaîne',
      baselineIds: ['video-1'],
    }),
  ];
  const first = addProject(configs);
  const withPending = completeCheck(first, 'subscription-1', { episodeIds: ['episode-new'] });
  const reorderedBaseline = configs.map((item) => ({
    ...item,
    baselineIds: [...item.baselineIds].reverse(),
  }));
  const relocated = syncProjectSubscriptions(
    withPending,
    'C:\\Projects\\Story Copy.mbah',
    'Story Copy',
    reorderedBaseline,
  );

  assert.equal(relocated.subscriptions.length, 2);
  assert.equal(relocated.subscriptions.find((item) => item.id === 'subscription-1').projectPath,
    'C:\\Projects\\Story Copy.mbah');
  assert.deepEqual(getNotifications(relocated).map(({ projectPath }) => projectPath), [
    'C:\\Projects\\Story Copy.mbah',
  ]);
});

test('source changes invalidate late results and establish a new baseline', () => {
  const registry = addProject();
  const check = beginCheck(registry, 'subscription-1');
  const changed = syncProjectSubscriptions(
    check.registry,
    '/projects/story.mbah',
    'Story',
    [config({ url: 'https://example.com/new-feed.xml', baselineIds: ['new-baseline'] })],
  );
  const late = recordCheckResult(changed, 'subscription-1', check.revision, {
    episodeIds: ['late-episode'],
  });

  assert.deepEqual(late, changed);
  assert.deepEqual(changed.subscriptions[0].baselineIds, ['new-baseline']);
  assert.deepEqual(changed.subscriptions[0].seenIds, []);
  assert.deepEqual(getNotifications(changed), []);
});

test('pausing preserves pending notifications, while acknowledging selected episodes leaves the rest', () => {
  const discovered = completeCheck(addProject(), 'subscription-1', {
    episodeIds: ['episode-a', 'episode-b'],
  });
  const acknowledged = acknowledgeEpisodes(discovered, 'subscription-1', ['episode-a']);
  assert.deepEqual(getNotifications(acknowledged)[0].episodeIds, ['episode-b']);

  const paused = setSubscriptionPaused(acknowledged, 'subscription-1', true);
  assert.equal(beginCheck(paused, 'subscription-1').revision, null);
  assert.deepEqual(getNotifications(paused)[0].episodeIds, ['episode-b']);

  const synced = syncProjectSubscriptions(
    paused,
    '/projects/story.mbah',
    'Story',
    [config()],
  );
  assert.equal(synced.subscriptions[0].status, 'paused');

  const projectDisabled = syncProjectSubscriptions(
    synced,
    '/projects/story.mbah',
    'Story',
    [config({ enabled: false })],
  );
  assert.equal(projectDisabled.subscriptions[0].status, 'paused');

  const resumed = setSubscriptionPaused(projectDisabled, 'subscription-1', false);
  assert.equal(resumed.subscriptions[0].status, 'active');
  assert.deepEqual(getNotifications(resumed)[0].episodeIds, ['episode-b']);
});

test('missing subscriptions can be checked again after the project becomes available', () => {
  const check = beginCheck(addProject(), 'subscription-1');
  const missing = recordCheckResult(check.registry, 'subscription-1', check.revision, {
    status: 'missing',
    error: 'Projet introuvable',
  });
  assert.equal(missing.subscriptions[0].status, 'missing');

  const retry = beginCheck(missing, 'subscription-1');
  assert.notEqual(retry.revision, null);
  const available = recordCheckResult(retry.registry, 'subscription-1', retry.revision, {
    episodeIds: ['episode-a'],
  });
  assert.equal(available.subscriptions[0].status, 'active');
  assert.deepEqual(getNotifications(available)[0].episodeIds, ['episode-a']);
});

test('a paused subscription whose project goes missing stays paused, and resumes paused once relocated', () => {
  const paused = setSubscriptionPaused(addProject(), 'subscription-1', true);
  const missing = markSubscriptionMissing(paused, 'subscription-1', 'Projet introuvable');
  const [entry] = missing.subscriptions;
  assert.equal(entry.status, 'missing');
  assert.equal(entry.paused, true, 'la pause survit à l’état introuvable');
  assert.equal(beginCheck(missing, 'subscription-1').revision, null, 'aucune vérification d’un suivi en pause');

  const relocated = relocateSubscription(missing, 'subscription-1', '/moved/story.mbah', 'Story déplacée');
  assert.equal(relocated.subscriptions[0].status, 'paused');
  assert.equal(relocated.subscriptions[0].paused, true);
  assert.equal(relocated.subscriptions[0].projectPath, '/moved/story.mbah');
  assert.equal(relocated.subscriptions[0].error, null);

  const active = relocateSubscription(markSubscriptionMissing(addProject(), 'subscription-1', 'x'), 'subscription-1', '/moved/story.mbah');
  assert.equal(active.subscriptions[0].status, 'active');
  assert.equal(active.subscriptions[0].paused, false);
});

test('pausing or resuming a missing subscription keeps it missing until it is relocated', () => {
  const missing = markSubscriptionMissing(addProject(), 'subscription-1', 'Projet introuvable');
  const paused = setSubscriptionPaused(missing, 'subscription-1', true);
  assert.equal(paused.subscriptions[0].status, 'missing');
  assert.equal(paused.subscriptions[0].paused, true);
  assert.equal(paused.subscriptions[0].error, 'Projet introuvable');
  const resumed = setSubscriptionPaused(paused, 'subscription-1', false);
  assert.equal(resumed.subscriptions[0].status, 'missing');
  assert.equal(resumed.subscriptions[0].paused, false);
});

test('saving the project of a paused missing subscription clears missing without resuming it', () => {
  const missing = markSubscriptionMissing(setSubscriptionPaused(addProject(), 'subscription-1', true), 'subscription-1', 'x');
  const saved = syncProjectSubscriptions(missing, '/projects/story.mbah', 'Story', [config()]);
  assert.equal(saved.subscriptions[0].status, 'paused');
  assert.equal(saved.subscriptions[0].paused, true);
  assert.equal(saved.subscriptions[0].error, null);
});

test('registries written before the separate pause flag are read with their pause intact', () => {
  const base = { ...config(), projectPath: '/projects/story.mbah', projectName: 'Story', seenIds: [], pendingIds: [] };
  const legacy = normalizeRegistry({ subscriptions: [
    { ...base, id: 'paused-one', status: 'paused' },
    { ...base, id: 'missing-one', status: 'missing' },
    { ...base, id: 'active-one', status: 'active' },
    { ...base, id: 'flagged-one', status: 'error', paused: true },
  ] });
  const byId = Object.fromEntries(legacy.subscriptions.map((item) => [item.id, item]));
  assert.deepEqual([byId['paused-one'].status, byId['paused-one'].paused], ['paused', true]);
  assert.deepEqual([byId['missing-one'].status, byId['missing-one'].paused], ['missing', false]);
  assert.deepEqual([byId['active-one'].status, byId['active-one'].paused], ['active', false]);
  assert.deepEqual([byId['flagged-one'].status, byId['flagged-one'].paused], ['paused', true]);
  assert.deepEqual(normalizeRegistry(legacy), legacy, 'la relecture est stable');
});

test('unsubscription removes its notification and makes a late result harmless', () => {
  const check = beginCheck(addProject(), 'subscription-1');
  const removed = removeSubscription(check.registry, 'subscription-1');
  const late = recordCheckResult(removed, 'subscription-1', check.revision, {
    episodeIds: ['late-episode'],
  });

  assert.deepEqual(late, removed);
  assert.deepEqual(getNotifications(removed), []);
});

test('registry persistence uses the declared persistent setting key', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });

  try {
    const expected = completeCheck(addProject(), 'subscription-1', { episodeIds: ['episode-a'] });
    assert.deepEqual(saveRegistry(expected), expected);
    assert.equal(values.has(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY), true);
    assert.deepEqual(loadRegistry(), expected);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
