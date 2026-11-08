import { presentStoredError, userMessageTransport } from '../i18n/userMessage.js';
import { translateMedia } from '../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../i18n/useMediaTranslation.js';
import { importPresentationError } from '../i18n/importPresentation.js';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import {
  loadRegistryState, persistRegistry, syncProjectSubscriptions, beginCheck, recordCheckResult,
  getNotifications, dismissNotification, removeSubscription, setSubscriptionPaused, acknowledgeEpisodes,
  markSubscriptionMissing, relocateSubscription, REGISTRY_WRITE_ERROR, REGISTRY_UNREADABLE_ERROR,
} from '../store/mediaSubscriptions.js';
import {
  fetchSubscriptionSnapshot, SUBSCRIPTIONS_SAVED_EVENT, sameSubscriptionSource,
  setProjectSubscriptionLookup, youtubeSubscriptionKind, TOOL_MISSING_CODE, normalizeToolStatus,
} from '../store/mediaSubscriptionSource.js';
import { KEYS, read } from '../store/persistentSettings.js';
import { pathKey } from '../utils/fileUtils.js';
import { generateUuid } from '../utils/uuid.js';
import { loadProjectFromPath } from '../store/projectIO.js';
import { isTauriRuntime } from '../utils/tauriRuntime.js';
import { logger } from '../utils/logger.js';

// États écrits dans le registre local : des clés stables, jamais une phrase
// figée dans une langue. Présentées à chaque rendu dans la langue active.
const MISSING_PROJECT_ERROR = 'media:subscriptions.error.missingProject';
// yt-dlp n'est préparé (téléchargé, mis à jour) qu'après l'accord donné dans
// l'import YouTube : une vérification de fond ne le déclenche jamais d'elle-même.
const YOUTUBE_NOT_READY_ERROR = 'media:subscriptions.error.youtubeNotReady';
const SOURCE_REFUSAL_KEYS = ['media:subscriptions.check.cancelled', 'media:subscriptions.source.incomplete', 'media:subscriptions.source.unstableId', 'media:subscriptions.source.tooLarge'];
const STATE_KEYS = new Set([MISSING_PROJECT_ERROR, YOUTUBE_NOT_READY_ERROR, REGISTRY_UNREADABLE_ERROR, REGISTRY_WRITE_ERROR, ...SOURCE_REFUSAL_KEYS]);

// Un refus codé de la lecture de source est retenu par sa clé, jamais par sa phrase.
function checkErrorValue(error) {
  const key = error?.presentationRef?.key;
  return STATE_KEYS.has(key) ? key : userMessageTransport(error);
}

// Les erreurs d'outils (enveloppes) restent présentées par le panneau.
function presentSubscriptionState(value) {
  return typeof value === 'string' && STATE_KEYS.has(value) ? translateMedia(value) : value;
}

const NO_TOOL_UPDATE = { running: false, error: null };

function toolStatusNeedsAction(status) {
  return !!status && (status.ytdlpMissing || status.ytdlpUpdateDue || status.jsRuntimeMissing);
}

function samePath(left, right) {
  return !!left && !!right && pathKey(left) === pathKey(right);
}

// Le registre ne contient que les suivis explicitement activés sur cette machine.
// Les écritures projet sont observées après succès ; aucune vérification ne
// modifie un .mbah ni les médias de l'utilisateur.
export function useMediaSubscriptions({ store, openProject, onShowImport, showErrorDialog, leaveGuard }) {
  useMediaTranslation();
  const [initial] = useState(loadRegistryState);
  const [registry, setRegistry] = useState(initial.registry);
  const [storageError, setStorageError] = useState(initial.error);
  const [checking, setChecking] = useState(false);
  // Capture avant la vérification du démarrage : seules les notifications
  // déjà au registre contribuent au rappel, jamais les nouveautés du réseau.
  // Une seule notification en attente reprend le toast ordinaire (même file,
  // même identifiant : la vérification du démarrage le met à jour sans doublon).
  const [toasts, setToasts] = useState(() => {
    const pending = getNotifications(initial.registry);
    if (pending.length === 1) return [pending[0]];
    return pending.length ? [{ kind: 'startup-reminder', count: pending.length }] : [];
  });
  // État des outils YouTube constaté par la dernière vérification de fond. Il
  // n'est pas persisté : chaque lancement le constate à nouveau, sans
  // jamais télécharger, et le panneau propose la mise à jour.
  const [toolStatus, setToolStatus] = useState(null);
  const [toolUpdate, setToolUpdate] = useState(NO_TOOL_UPDATE);
  const updatingTools = useRef(false);
  const toast = toasts[0] ?? null;
  const registryRef = useRef(registry);
  // Registre illisible qu'aucune copie n'a pu protéger : il n'est pas écrasé.
  const readOnly = useRef(initial.readOnly === true);
  const live = useRef({ store, openProject, onShowImport, showErrorDialog, leaveGuard });
  live.current = { store, openProject, onShowImport, showErrorDialog, leaveGuard };
  const authorized = useRef(new Set());
  const running = useRef(false);
  const checkAgain = useRef(false);
  const opening = useRef(false);
  const mounted = useRef(false);

  function update(transform) {
    const next = transform(registryRef.current);
    registryRef.current = next;
    const saved = !readOnly.current && persistRegistry(next);
    if (!saved && !readOnly.current) logger.warn('media-subscriptions:registry-write-failed');
    if (mounted.current) {
      setStorageError((current) => (saved
        ? (current === REGISTRY_WRITE_ERROR ? null : current)
        : (current || REGISTRY_WRITE_ERROR)));
      setRegistry(next);
      const notifications = getNotifications(next);
      setToasts((queue) => queue.flatMap((item) => {
        if (item.kind === 'startup-reminder') return [item];
        const notification = notifications.find((entry) => entry.id === item.id);
        return notification ? [notification] : [];
      }));
    }
    return next;
  }

  async function check() {
    if (!isTauriRuntime()) return;
    if (running.current) { checkAgain.current = true; return; }
    running.current = true;
    setChecking(true);
    try {
      for (const item of [...registryRef.current.subscriptions]) {
        if (!mounted.current) break;
        if (item.paused) continue;
        const started = beginCheck(registryRef.current, item.id);
        update(() => started.registry);
        const isCurrent = () => mounted.current && registryRef.current.subscriptions.some((entry) => entry.id === item.id && entry.revision === started.revision && !entry.paused);
        try {
          if (!(await exists(item.projectPath))) {
            if (!isCurrent()) continue;
            update((current) => recordCheckResult(current, item.id, started.revision, { error: MISSING_PROJECT_ERROR, status: 'missing' }));
            continue;
          }
          if (item.source === 'youtube' && read(KEYS.YOUTUBE_CGU_ACCEPTED) !== 'true') {
            if (isCurrent()) update((current) => recordCheckResult(current, item.id, started.revision, { error: YOUTUBE_NOT_READY_ERROR }));
            continue;
          }
          // Jamais de téléchargement d'outil en arrière-plan : la mise à jour
          // est proposée dans le panneau et reste une action explicite.
          const snapshot = await fetchSubscriptionSnapshot(item, invoke, {
            ytdlpPath: read(KEYS.YTDLP_CUSTOM_PATH) || null, isCurrent,
            knownIds: new Set([...item.baselineIds, ...item.seenIds, ...item.pendingIds]),
            installedToolsOnly: item.source === 'youtube',
          });
          if (snapshot.tools && mounted.current) setToolStatus(snapshot.tools);
          if (!isCurrent()) continue;
          const before = getNotifications(registryRef.current).find((notification) => notification.subscriptionId === item.id)?.count ?? 0;
          const next = update((current) => recordCheckResult(current, item.id, started.revision, snapshot));
          const notification = getNotifications(next).find((entry) => entry.subscriptionId === item.id);
          if (notification && notification.count > before) setToasts((queue) => [
            ...queue.filter((entry) => entry.id !== notification.id), notification,
          ]);
        } catch (error) {
          if (error?.code === TOOL_MISSING_CODE && mounted.current) setToolStatus(normalizeToolStatus({ ytdlpMissing: true }));
          if (isCurrent()) update((current) => recordCheckResult(current, item.id, started.revision, { error: checkErrorValue(error) }));
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setChecking(false);
      if (mounted.current && checkAgain.current) {
        checkAgain.current = false;
        void check();
      }
    }
  }

  // Abonnement du registre rattaché au projet ouvert lui-même, pas à une copie
  // de son fichier enregistrée ailleurs.
  function registeredHere(id) {
    const entry = registryRef.current.subscriptions.find((item) => item.id === id);
    return entry && samePath(entry.projectPath, live.current.store.savePath) ? entry : null;
  }

  function findConfig(request) {
    const configs = live.current.store.project?.mediaSubscriptions ?? [];
    return (request.subscriptionId && configs.find((item) => item.id === request.subscriptionId && item.source === request.source))
      || configs.find((item) => sameSubscriptionSource(item, request))
      || null;
  }

  useEffect(() => {
    mounted.current = true;
    function saved(event) {
      const { projectPath, previousProjectPath, projectName, configs } = event.detail;
      const known = new Set(registryRef.current.subscriptions.filter((item) => pathKey(item.projectPath) === pathKey(projectPath)
        || (previousProjectPath && pathKey(item.projectPath) === pathKey(previousProjectPath))).map((item) => item.id));
      update((current) => {
        const allowed = configs.filter((item) => known.has(item.id) || authorized.current.has(item.id))
          .map((config) => {
            const existing = current.subscriptions.find((item) => item.id === config.id);
            // A local pause/resume is authoritative until another explicit
            // checkbox action, even when the saved project carries an older flag.
            return existing && !authorized.current.has(config.id)
              ? { ...config, enabled: !existing.paused } : config;
          });
        let next = syncProjectSubscriptions(current, projectPath, projectName, allowed);
        for (const config of allowed) {
          if (authorized.current.has(config.id)) next = setSubscriptionPaused(next, config.id, config.enabled === false);
        }
        return next;
      });
      for (const item of configs) authorized.current.delete(item.id);
    }
    window.addEventListener(SUBSCRIPTIONS_SAVED_EVENT, saved);
    const releaseLookup = setProjectSubscriptionLookup((source, url) => {
      const config = findConfig({ source, url });
      if (!config) return null;
      const entry = registeredHere(config.id);
      const state = entry
        ? (entry.paused ? 'paused' : 'active')
        : (authorized.current.has(config.id) && config.enabled ? 'pending' : 'inactive');
      return { subscriptionId: config.id, state };
    }, (source) => {
      if (!live.current.store.savePath) return [];
      return (live.current.store.project?.mediaSubscriptions ?? [])
        .filter((config) => config.source === source)
        .flatMap((config) => {
          const entry = registeredHere(config.id);
          return entry ? [{ ...config, state: entry.paused ? 'paused' : 'active' }] : [];
        });
    });
    // Deferred so the StrictMode probe cannot launch a second network batch.
    const timer = setTimeout(() => { void check(); }, 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      releaseLookup();
      window.removeEventListener(SUBSCRIPTIONS_SAVED_EVENT, saved);
    };
    // Runtime refs keep callbacks current without checking on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepareRequest(request) {
    if (!request?.enabled) return request;
    const epoch = live.current.store.workEpochRef.current;
    if (request.baselineComplete !== false) return request;
    // Sans changement explicite de la case, ou pour un suivi déjà au registre
    // de ce projet, la référence connue reste celle du suivi : aucune relecture.
    const existing = findConfig(request);
    if (existing && (request.enabledTouched !== true || registeredHere(existing.id))) return request;
    const snapshot = await fetchSubscriptionSnapshot(request, invoke, { ytdlpPath: read(KEYS.YTDLP_CUSTOM_PATH) || null });
    if (epoch !== live.current.store.workEpochRef.current) throw importPresentationError('import:media.follow.projectChanged', {}, { code: 'IMPORT_PROJECT_CHANGED' });
    return { ...request, baselineIds: snapshot.episodeIds, baselineComplete: true };
  }

  function replaceConfig(currentStore, previousId, config) {
    currentStore.setProject((project) => ({ ...project, mediaSubscriptions: [
      ...(project.mediaSubscriptions ?? []).filter((item) => item.id !== previousId && item.id !== config.id), config,
    ] }));
  }

  function applyRequest(request, importedEpisodeIds = []) {
    if (!request) return;
    const currentStore = live.current.store;
    const followable = request.source !== 'youtube' || !!youtubeSubscriptionKind(request.url);
    const existing = findConfig(request);
    if (!existing) {
      if (!request.enabled || !followable) return;
      const id = generateUuid();
      authorized.current.add(id);
      replaceConfig(currentStore, id, {
        id, source: request.source, url: request.url, title: request.title, baselineIds: request.baselineIds, enabled: true,
      });
      return;
    }
    if (registeredHere(existing.id)) update((current) => acknowledgeEpisodes(current, existing.id, importedEpisodeIds));
    // Seul un changement explicite de la case modifie le suivi : un import
    // fait sans y toucher ne peut ni l'activer ni le suspendre.
    if (request.enabledTouched !== true) return;
    const entry = registryRef.current.subscriptions.find((item) => item.id === existing.id);
    if (entry && !samePath(entry.projectPath, currentStore.savePath)) {
      // Copie de fichier d'un projet suivi : l'identifiant appartient à
      // l'original. La copie reçoit le sien plutôt que de lui prendre son suivi.
      if (!request.enabled) {
        replaceConfig(currentStore, existing.id, { ...existing, enabled: false });
        return;
      }
      const id = generateUuid();
      authorized.current.add(id);
      replaceConfig(currentStore, existing.id, { ...existing, id, baselineIds: request.baselineIds, enabled: true });
      return;
    }
    authorized.current.add(existing.id);
    replaceConfig(currentStore, existing.id, {
      ...existing, enabled: !!request.enabled, ...(!entry ? { baselineIds: request.baselineIds } : {}),
    });
  }

  async function openNotification(id) {
    if (opening.current) return;
    const item = registryRef.current.subscriptions.find((entry) => entry.id === id);
    if (!item) return;
    opening.current = true;
    try {
      if (live.current.leaveGuard?.current && !(await live.current.leaveGuard.current())) return;
      const currentStore = live.current.store;
      if (pathKey(currentStore.savePath ?? '') !== pathKey(item.projectPath)) {
        if (!(await exists(item.projectPath))) {
          update((current) => markSubscriptionMissing(current, id, MISSING_PROJECT_ERROR));
          setToasts((queue) => queue.filter((entry) => entry.id !== id));
          live.current.showErrorDialog({
            get title() { return translateMedia('media:subscriptions.open.title'); },
            get message() { return translateMedia('media:subscriptions.open.missing', { name: item.projectName || item.projectPath }); },
            variant: 'warning',
          });
          return;
        }
        const opened = await live.current.openProject(item.projectPath);
        if (!opened) return;
      }
      const current = registryRef.current.subscriptions.find((entry) => entry.id === id);
      if (!mounted.current || !current || current.projectPath !== item.projectPath) return;
      setToasts((queue) => queue.filter((entry) => entry.id !== id));
      live.current.onShowImport({ ...current, enabled: !current.paused, subscriptionId: current.id });
    } catch (error) {
      live.current.showErrorDialog({ get title() { return translateMedia('media:subscriptions.open.title'); }, message: error });
    } finally {
      opening.current = false;
    }
  }

  async function relocate(id) {
    // Filtre natif résolu à l'ouverture, dans la langue active.
    const path = await open({ multiple: false, filters: [{ name: translateMedia('native:subscriptions.project.filterLabel'), extensions: ['mbah'] }] });
    if (!path) return;
    const relocateTitle = { get title() { return translateMedia('media:subscriptions.project.relocate'); } };
    try {
      const { data: project } = await loadProjectFromPath(path);
      if (!project.mediaSubscriptions?.some((item) => item.id === id)) {
        live.current.showErrorDialog({
          get title() { return relocateTitle.title; },
          get message() { return translateMedia('media:subscriptions.relocate.mismatch'); },
        });
        return;
      }
      // Un suivi mis en pause par l'utilisateur reste en pause une fois retrouvé.
      update((current) => relocateSubscription(current, id, path, project.projectName));
    } catch (error) {
      live.current.showErrorDialog({ get title() { return relocateTitle.title; }, message: error });
    }
  }

  // Installation ou mise à jour explicite, par la commande des préférences
  // (yt-dlp et moteur JavaScript), puis nouvelle vérification.
  async function updateTools() {
    if (updatingTools.current) return;
    updatingTools.current = true;
    setToolUpdate({ running: true, error: null });
    try {
      await invoke('update_ytdlp');
      if (!mounted.current) return;
      setToolStatus(null);
      setToolUpdate(NO_TOOL_UPDATE);
      void check();
    } catch (error) {
      if (mounted.current) setToolUpdate({ running: false, error: { userMessage: error, prefix: { key: 'media:subscriptions.tools.updateFailedPrefix' } } });
    } finally {
      updatingTools.current = false;
    }
  }

  const followsYoutube = registry.subscriptions.some((item) => item.source === 'youtube');
  const youtubeTools = followsYoutube && toolStatusNeedsAction(toolStatus)
    ? { missing: toolStatus.ytdlpMissing, updating: toolUpdate.running, error: toolUpdate.error == null ? null : presentStoredError(toolUpdate.error) }
    : null;

  return {
    prepareRequest, applyRequest,
    panelProps: {
      subscriptions: registry.subscriptions.map((item) => ({ ...item, enabled: !item.paused, error: presentSubscriptionState(item.error) })),
      notifications: getNotifications(registry), checking, toast, storageError: presentSubscriptionState(storageError),
      youtubeTools, onUpdateTools: updateTools,
      onCheck: check, onOpenNotification: openNotification,
      onCloseToast: () => setToasts((queue) => queue.slice(1)),
      onDismissNotification: (id) => update((current) => dismissNotification(current, id)),
      onToggleSubscription: (id) => {
        const item = registryRef.current.subscriptions.find((entry) => entry.id === id);
        if (!item) return;
        const paused = !item.paused;
        update((current) => setSubscriptionPaused(current, id, paused));
        if (!paused) void check();
      },
      onRemoveSubscription: (id) => { authorized.current.delete(id); update((current) => removeSubscription(current, id)); },
      onRelocateSubscription: relocate,
    },
  };
}
