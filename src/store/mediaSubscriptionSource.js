import { importPresentationError } from '../i18n/importPresentation.js';

// Lecture complète d'une source sans téléchargement des médias. Une référence
// partielle ne permet jamais d'activer le suivi d'une grande playlist.
export const MAX_SUBSCRIPTION_PAGES = 25;
export const SUBSCRIPTIONS_SAVED_EVENT = 'story-studio:subscriptions-saved';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/**
 * Nature suivable d'une URL YouTube : `playlist`, `channel` ou `null`. Une
 * vidéo seule et un mix généré (`list=RD…`, propre à chaque lecture) ne se
 * suivent pas.
 */
export function youtubeSubscriptionKind(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.toLowerCase();
    const list = parsed.searchParams.get('list') ?? '';
    if (/^RD/.test(list)) return null;
    if (host === 'youtu.be') return list ? 'playlist' : null;
    if (!YOUTUBE_HOSTS.has(host)) return null;
    const path = parsed.pathname.replace(/\/+$/, '');
    if ((path === '/playlist' || path === '/watch') && list) return 'playlist';
    if (/^\/(channel|user|c)\/[^/]+(?:\/[^/]+)?$/i.test(path)) return 'channel';
    if (/^\/@[^/]+(?:\/[^/]+)?$/i.test(path)) return 'channel';
    return null;
  } catch {
    return null;
  }
}

/** Forme de comparaison d'une adresse de source : casse de l'hôte, fragment et barre finale ignorés. */
export function normalizeSubscriptionUrl(sourceUrl) {
  const trimmed = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

export function sameSubscriptionSource(left, right) {
  return !!left && !!right && left.source === right.source
    && normalizeSubscriptionUrl(left.url) === normalizeSubscriptionUrl(right.url);
}

export const TOOL_MISSING_CODE = 'tool_missing';

/** État des outils YouTube rapporté par Rust en mode « installés uniquement ». */
export function normalizeToolStatus(value) {
  return {
    ytdlpMissing: value?.ytdlpMissing === true,
    ytdlpUpdateDue: value?.ytdlpUpdateDue === true,
    jsRuntimeMissing: value?.jsRuntimeMissing === true,
  };
}

/**
 * Lit une source page par page. `knownIds` permet à une vérification de
 * chaîne (nouveautés en tête) de s'arrêter dès qu'une page ne contient que des
 * identifiants connus : le résultat est alors marqué `complete: false` et ne
 * sert jamais de référence ni de purge.
 *
 * `installedToolsOnly` (vérification de fond) demande à Rust de n'utiliser que
 * les outils YouTube déjà installés, sans jamais rien télécharger ; l'état des
 * outils qu'il rapporte est rendu dans `tools`. Sans yt-dlp, l'appel échoue
 * avec le code `tool_missing`.
 */
export async function fetchSubscriptionSnapshot(source, invoke, {
  ytdlpPath = null, isCurrent = () => true, knownIds = null, installedToolsOnly = false,
} = {}) {
  const ids = new Set();
  let title = source.title;
  let tools = null;
  const youtubeArgs = (page) => (installedToolsOnly
    ? { url: source.url, ytdlpPath, page, installedToolsOnly: true }
    : { url: source.url, ytdlpPath, page });
  const done = (complete) => ({ episodeIds: [...ids], title, complete, ...(tools ? { tools } : {}) });
  const stopOnKnownPage = source.source === 'youtube' && knownIds instanceof Set && knownIds.size > 0
    && youtubeSubscriptionKind(source.url) === 'channel';
  for (let page = 1; page <= MAX_SUBSCRIPTION_PAGES; page += 1) {
    // Refus codés : la clé est retenue (registre) et présentée dans la langue active.
    if (!isCurrent()) throw importPresentationError('media:subscriptions.check.cancelled', {}, { code: 'SUBSCRIPTION_CHECK_CANCELLED' });
    const list = source.source === 'podcast'
      ? await invoke('fetch_podcast_feed', { url: source.url })
      : await invoke('fetch_youtube_list', youtubeArgs(page));
    if (!isCurrent()) throw importPresentationError('media:subscriptions.check.cancelled', {}, { code: 'SUBSCRIPTION_CHECK_CANCELLED' });
    const items = source.source === 'podcast' ? list?.episodes : list?.videos;
    if (!Array.isArray(items) || (source.source === 'youtube' && typeof list?.hasNext !== 'boolean')) {
      throw importPresentationError('media:subscriptions.source.incomplete', {}, { code: 'SUBSCRIPTION_SOURCE_INCOMPLETE' });
    }
    title = list.title || title;
    if (list.tools && typeof list.tools === 'object') tools = normalizeToolStatus(list.tools);
    let onlyKnown = items.length > 0;
    for (const item of items) {
      if (typeof item.id !== 'string' || !item.id.trim()) throw importPresentationError('media:subscriptions.source.unstableId', {}, { code: 'SUBSCRIPTION_SOURCE_UNSTABLE_ID' });
      ids.add(item.id);
      if (!knownIds?.has(item.id)) onlyKnown = false;
    }
    if (source.source === 'podcast' || !list.hasNext) return done(true);
    if (stopOnKnownPage && onlyKnown) return done(false);
  }
  throw importPresentationError('media:subscriptions.source.tooLarge', {}, { code: 'SUBSCRIPTION_SOURCE_TOO_LARGE' });
}

/**
 * Cherche dans les pages d'une playlist les entrées en attente, à partir d'une
 * première page déjà lue. Bornée à `MAX_SUBSCRIPTION_PAGES` ; s'arrête dès que
 * toutes sont trouvées. Une page illisible arrête la recherche sans perdre les
 * entrées déjà trouvées. Rien n'est sélectionné ici.
 */
export async function collectPendingEntries({ firstPage, pendingIds, fetchPage, onPage = () => {}, isCurrent = () => true }) {
  const wanted = new Set(pendingIds ?? []);
  const found = new Map();
  let page = firstPage;
  let pageNumber = 1;
  while (page) {
    for (const entry of page.videos ?? []) {
      if (wanted.has(entry?.id) && !found.has(entry.id)) found.set(entry.id, entry);
    }
    if (found.size >= wanted.size || !page.hasNext || pageNumber >= MAX_SUBSCRIPTION_PAGES) break;
    pageNumber += 1;
    try {
      page = await fetchPage(pageNumber);
    } catch {
      break;
    }
    if (!isCurrent()) return null;
    onPage(pageNumber, page);
  }
  return [...found.values()];
}

// Le projet ouvert est détenu par l'hôte ; les surfaces d'import le consultent
// par cette recherche, installée par le hook de suivi, sans recevoir le projet.
let projectSubscriptionLookup = null;
let projectSubscriptionList = null;

export function setProjectSubscriptionLookup(lookup, list = null) {
  projectSubscriptionLookup = lookup;
  projectSubscriptionList = list;
  return () => {
    if (projectSubscriptionLookup === lookup) {
      projectSubscriptionLookup = null;
      projectSubscriptionList = null;
    }
  };
}

/** Sources réellement suivies ici, y compris en pause, pour l'import éditeur. */
export function getProjectFollowedSources(source) {
  return projectSubscriptionList?.(source) ?? [];
}

/**
 * État du suivi d'une source dans le projet ouvert :
 * `{ subscriptionId, state }` où `state` vaut `active`, `paused`, `pending`
 * (activation demandée, en attente d'enregistrement) ou `inactive` (configuré
 * dans le projet, non activé sur cette machine) ; `null` sinon.
 */
export function findProjectSubscription(source, url) {
  try {
    return projectSubscriptionLookup?.(source, url) ?? null;
  } catch {
    return null;
  }
}

export function announceSavedSubscriptions(projectPath, project, previousProjectPath = null) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(SUBSCRIPTIONS_SAVED_EVENT, {
    detail: { projectPath, previousProjectPath, projectName: project.projectName, configs: project.mediaSubscriptions ?? [] },
  }));
}
