import { pathKey } from '../utils/fileUtils.js';
import { KEYS, read, write } from './persistentSettings.js';

const REGISTRY_VERSION = 1;
const SOURCES = new Set(['podcast', 'youtube']);
const STATUSES = new Set(['active', 'checking', 'error', 'missing', 'paused']);

// La pause est une décision de l'utilisateur, portée par `paused` et
// indépendante de l'état technique : un suivi en pause dont le projet devient
// introuvable reste en pause (`status: 'missing'`, `paused: true`). Le statut
// `paused` reste écrit tant que le projet est trouvé, et les registres
// antérieurs, qui ne connaissaient que ce statut, sont relus comme en pause.
function statusFor(status, paused) {
  if (status === 'missing') return 'missing';
  if (paused) return 'paused';
  return status === 'paused' ? 'active' : status;
}

function uniqueIds(values) {
  if (!Array.isArray(values)) return [];
  const ids = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nextRevision(subscription) {
  return normalizedRevision(subscription.revision) + 1;
}

function normalizedCheckedAt(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normalizedConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const id = normalizedText(config.id);
  const source = normalizedText(config.source);
  const url = normalizedText(config.url);
  if (!id || !SOURCES.has(source) || !url) return null;
  return {
    id,
    source,
    url,
    title: normalizedText(config.title),
    baselineIds: uniqueIds(config.baselineIds),
    enabled: config.enabled !== false,
  };
}

/** Normalizes project-owned subscription settings without accessing storage. */
export function normalizeProjectSubscriptions(configs) {
  if (!Array.isArray(configs)) return [];
  const byId = new Map();
  for (const config of configs) {
    const normalized = normalizedConfig(config);
    if (normalized && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
  }
  return [...byId.values()];
}

export function createEmptyRegistry() {
  return { version: REGISTRY_VERSION, subscriptions: [] };
}

function normalizedSubscription(raw) {
  const config = normalizedConfig(raw);
  const projectPath = normalizedText(raw?.projectPath);
  if (!config || !projectPath) return null;

  const baselineIds = config.baselineIds;
  // La référence n'est pas recopiée dans les identifiants vus. Les registres
  // écrits avant cette séparation la contenaient : elle en est retirée à la
  // lecture, sans rien perdre puisqu'elle reste connue par `baselineIds`.
  const baseline = new Set(baselineIds);
  const seenIds = uniqueIds(raw.seenIds).filter((id) => !baseline.has(id));
  const seen = new Set(seenIds);
  const pendingIds = uniqueIds(raw.pendingIds).filter((id) => !seen.has(id) && !baseline.has(id));
  const rawStatus = STATUSES.has(raw.status) ? raw.status : 'active';
  const paused = raw.paused === true || rawStatus === 'paused';
  const status = statusFor(rawStatus, paused);
  const error = normalizedText(raw.error) || null;

  return {
    id: config.id,
    projectPath,
    projectName: normalizedText(raw.projectName),
    source: config.source,
    url: config.url,
    title: config.title,
    baselineIds,
    seenIds,
    pendingIds,
    status,
    paused,
    error,
    checkedAt: normalizedCheckedAt(raw.checkedAt),
    revision: normalizedRevision(raw.revision),
  };
}

/** Normalizes a persisted registry and drops malformed or duplicate records. */
export function normalizeRegistry(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.subscriptions)) {
    return createEmptyRegistry();
  }
  const subscriptions = [];
  const ids = new Set();
  for (const raw of value.subscriptions) {
    const subscription = normalizedSubscription(raw);
    if (subscription && !ids.has(subscription.id)) {
      ids.add(subscription.id);
      subscriptions.push(subscription);
    }
  }
  return { version: REGISTRY_VERSION, subscriptions };
}

function pathIdentity(path) {
  const key = pathKey(path);
  if (!key) return '';
  const withoutTrailingSeparators = key.replace(/\/+$/, '');
  return withoutTrailingSeparators || key;
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function makeSubscription(config, projectPath, projectName) {
  return {
    ...config,
    projectPath,
    projectName,
    seenIds: [],
    pendingIds: [],
    status: config.enabled ? 'active' : 'paused',
    paused: !config.enabled,
    error: null,
    checkedAt: null,
    revision: 0,
  };
}

/**
 * Synchronizes the local registry with a saved project's subscription settings.
 * The caller must only pass subscriptions whose local monitoring was explicitly
 * enabled; the registry never records projects without an active subscription.
 */
export function syncProjectSubscriptions(registry, projectPath, projectName, projectConfigs) {
  const current = normalizeRegistry(registry);
  const savedPath = normalizedText(projectPath);
  if (!savedPath || !Array.isArray(projectConfigs)) return current;

  const projectKey = pathIdentity(savedPath);
  const name = normalizedText(projectName);
  const configs = normalizeProjectSubscriptions(projectConfigs);
  const configIds = new Set(configs.map(({ id }) => id));
  const byId = new Map(current.subscriptions.map((subscription) => [subscription.id, subscription]));

  for (const config of configs) {
    const existing = byId.get(config.id);
    if (!existing) {
      if (config.enabled) byId.set(config.id, makeSubscription(config, savedPath, name));
      continue;
    }

    const sourceChanged = existing.source !== config.source
      || existing.url !== config.url
      || !sameIds(existing.baselineIds, config.baselineIds);
    const pathChanged = pathIdentity(existing.projectPath) !== projectKey;
    // Un enregistrement ne reprend jamais un suivi mis en pause localement.
    const paused = !config.enabled || existing.paused;
    // Le projet vient d'être enregistré à ce chemin : il n'est plus introuvable.
    const found = existing.status === 'missing' || (pathChanged && existing.status === 'checking');
    const next = sourceChanged
      ? {
          ...makeSubscription(config, savedPath, name),
          status: statusFor('active', paused),
          paused,
          revision: nextRevision(existing),
        }
      : {
          ...existing,
          projectPath: savedPath,
          projectName: name,
          title: config.title || existing.title,
          status: statusFor(found ? 'active' : existing.status, paused),
          paused,
          error: found ? null : existing.error,
          revision: pathChanged || paused !== existing.paused
            ? nextRevision(existing)
            : existing.revision,
        };
    byId.set(config.id, next);
  }

  const subscriptions = current.subscriptions
    .filter((subscription) => (
      pathIdentity(subscription.projectPath) !== projectKey || configIds.has(subscription.id)
    ))
    .map((subscription) => byId.get(subscription.id) ?? subscription);
  const included = new Set(subscriptions.map(({ id }) => id));
  for (const config of configs) {
    const subscription = byId.get(config.id);
    if (subscription && !included.has(config.id)) subscriptions.push(subscription);
  }
  return normalizeRegistry({ subscriptions });
}

/** Starts a check and returns its single-use revision token. */
export function beginCheck(registry, id) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  const subscription = current.subscriptions.find((item) => item.id === subscriptionId);
  if (!subscription || subscription.paused) {
    return { registry: current, revision: null };
  }
  const revision = nextRevision(subscription);
  const subscriptions = current.subscriptions.map((item) => item.id === subscriptionId
    ? { ...item, status: 'checking', error: null, revision }
    : item);
  return { registry: { ...current, subscriptions }, revision };
}

/** Applies a check only while the subscription still has the captured revision. */
export function recordCheckResult(registry, id, revision, result = {}) {
  const current = normalizeRegistry(registry);
  const checkResult = result && typeof result === 'object' ? result : {};
  const subscriptionId = normalizedText(id);
  const existing = current.subscriptions.find((item) => item.id === subscriptionId);
  if (!existing || !Number.isSafeInteger(revision) || existing.revision !== revision) return current;

  const error = normalizedText(checkResult.error);
  const resultTitle = normalizedText(checkResult.title);
  const isMissing = checkResult.status === 'missing';
  const checkedAt = normalizedCheckedAt(checkResult.checkedAt) ?? Date.now();
  const subscriptions = current.subscriptions.map((item) => {
    if (item.id !== subscriptionId) return item;
    const known = new Set([...item.baselineIds, ...item.seenIds]);
    let pendingIds = new Set(item.pendingIds);
    if (!error && !isMissing) {
      const episodeIds = uniqueIds(checkResult.episodeIds);
      // Seule une lecture complète peut dire qu'un épisode a disparu de la
      // source ; une lecture partielle n'oublie rien.
      if (checkResult.complete === true) {
        const present = new Set(episodeIds);
        pendingIds = new Set([...pendingIds].filter((episodeId) => present.has(episodeId)));
      }
      for (const episodeId of episodeIds) {
        if (!known.has(episodeId)) pendingIds.add(episodeId);
      }
    }
    return {
      ...item,
      title: resultTitle || item.title,
      pendingIds: [...pendingIds],
      status: statusFor(isMissing ? 'missing' : error ? 'error' : 'active', item.paused),
      error: error || null,
      checkedAt,
      revision: nextRevision(item),
    };
  });
  return { ...current, subscriptions };
}

/**
 * Marks a subscription whose project file is missing, so it can be relocated.
 * Its pause, if any, is kept apart in `paused`.
 */
export function markSubscriptionMissing(registry, id, error) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  return {
    ...current,
    subscriptions: current.subscriptions.map((subscription) => subscription.id === subscriptionId
      ? { ...subscription, status: 'missing', error: normalizedText(error) || null, revision: nextRevision(subscription) }
      : subscription),
  };
}

/** Returns one durable notification per subscription with pending episodes. */
export function getNotifications(registry) {
  return normalizeRegistry(registry).subscriptions
    .filter(({ pendingIds }) => pendingIds.length > 0)
    .map((subscription) => ({
      id: subscription.id,
      subscriptionId: subscription.id,
      projectPath: subscription.projectPath,
      projectName: subscription.projectName,
      source: subscription.source,
      url: subscription.url,
      title: subscription.title,
      count: subscription.pendingIds.length,
      episodeIds: [...subscription.pendingIds],
      checkedAt: subscription.checkedAt,
    }));
}

/** Dismisses the notification and remembers its episodes so they stay dismissed. */
export function dismissNotification(registry, id) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  return {
    ...current,
    subscriptions: current.subscriptions.map((subscription) => {
      if (subscription.id !== subscriptionId || subscription.pendingIds.length === 0) return subscription;
      return {
        ...subscription,
        seenIds: uniqueIds([...subscription.seenIds, ...subscription.pendingIds]),
        pendingIds: [],
        revision: nextRevision(subscription),
      };
    }),
  };
}

/** Acknowledges imported or individually ignored episodes without dismissing others. */
export function acknowledgeEpisodes(registry, id, episodeIds) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  const acknowledged = new Set(uniqueIds(episodeIds));
  if (acknowledged.size === 0) return current;
  return {
    ...current,
    subscriptions: current.subscriptions.map((subscription) => {
      if (subscription.id !== subscriptionId) return subscription;
      const acknowledgedPending = subscription.pendingIds.filter((episodeId) => acknowledged.has(episodeId));
      if (acknowledgedPending.length === 0) return subscription;
      return {
        ...subscription,
        seenIds: uniqueIds([...subscription.seenIds, ...acknowledgedPending]),
        pendingIds: subscription.pendingIds.filter((episodeId) => !acknowledged.has(episodeId)),
        revision: nextRevision(subscription),
      };
    }),
  };
}

/** Removes an active or suspended subscription; late results then become no-ops. */
export function removeSubscription(registry, id) {
  const subscriptionId = normalizedText(id);
  const current = normalizeRegistry(registry);
  return {
    ...current,
    subscriptions: current.subscriptions.filter((subscription) => subscription.id !== subscriptionId),
  };
}

/**
 * Suspends or resumes local checking while preserving seen and pending
 * episodes. A missing project stays missing until it is relocated.
 */
export function setSubscriptionPaused(registry, id, paused) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  const shouldPause = Boolean(paused);
  return {
    ...current,
    subscriptions: current.subscriptions.map((subscription) => {
      if (subscription.id !== subscriptionId || subscription.paused === shouldPause) return subscription;
      const missing = subscription.status === 'missing';
      return {
        ...subscription,
        status: statusFor(missing ? 'missing' : 'active', shouldPause),
        paused: shouldPause,
        error: shouldPause || missing ? subscription.error : null,
        revision: nextRevision(subscription),
      };
    }),
  };
}

/**
 * Attaches a subscription to its relocated project file. It stays paused if
 * the user had paused it, active otherwise.
 */
export function relocateSubscription(registry, id, projectPath, projectName) {
  const current = normalizeRegistry(registry);
  const subscriptionId = normalizedText(id);
  const path = normalizedText(projectPath);
  if (!path) return current;
  return {
    ...current,
    subscriptions: current.subscriptions.map((subscription) => subscription.id === subscriptionId
      ? {
          ...subscription,
          projectPath: path,
          projectName: normalizedText(projectName) || subscription.projectName,
          status: statusFor('active', subscription.paused),
          error: null,
          revision: nextRevision(subscription),
        }
      : subscription),
  };
}

// Descripteurs d'état (clés), présentés dans la langue active par useMediaSubscriptions.
export const REGISTRY_UNREADABLE_ERROR = 'media:subscriptions.registry.unreadable';
export const REGISTRY_WRITE_ERROR = 'media:subscriptions.registry.writeFailed';

/**
 * Lit le registre. Un contenu illisible n'est jamais écrasé en silence : il est
 * d'abord copié sous une clé de sauvegarde déclarée, et l'erreur est rendue.
 */
export function loadRegistryState() {
  const raw = read(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY);
  if (raw == null) return { registry: createEmptyRegistry(), error: null };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.subscriptions)) {
    return { registry: normalizeRegistry(parsed), error: null };
  }
  if (read(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY_BACKUP) !== raw) {
    if (!write(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY_BACKUP, raw)) {
      // Sans copie possible, le contenu illisible reste en place : on ne
      // l'écrase pas, et le suivi fonctionne en mémoire pour cette session.
      return { registry: createEmptyRegistry(), error: REGISTRY_WRITE_ERROR, readOnly: true };
    }
  }
  return { registry: createEmptyRegistry(), error: REGISTRY_UNREADABLE_ERROR };
}

export function loadRegistry() {
  return loadRegistryState().registry;
}

/** Writes the registry and reports whether local storage accepted it. */
export function persistRegistry(registry) {
  return write(KEYS.MEDIA_SUBSCRIPTIONS_REGISTRY, JSON.stringify(normalizeRegistry(registry)));
}

export function saveRegistry(registry) {
  const normalized = normalizeRegistry(registry);
  persistRegistry(normalized);
  return normalized;
}
