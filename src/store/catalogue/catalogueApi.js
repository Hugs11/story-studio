// Adaptateur IPC du catalogue des packs : seul point d'appel de `invoke` et
// `listen` pour le catalogue côté interface. Il convertit chaque réponse en
// modèle interne et chaque erreur `UserMessage` en erreur présentable (jamais
// « [object Object] »).
//
// Le pont Tauri est injectable : les tests fournissent leurs doublures.

import i18n from 'i18next';
import { releaseTauriListener } from '../../utils/tauriListener.js';
import { normalizeEntries } from './entryModel.js';
import { presentUserMessage, rustMessageEnvelope } from '../../i18n/userMessage.js';

/** Page maximale acceptée par le moteur. */
export const ENTRY_PAGE_LIMIT = 200;
const CURSOR_EXPIRED = 'CATALOG_ENTRIES_CURSOR_EXPIRED';
const MAX_RESTARTS = 5;

/** Erreur du catalogue : conserve l'enveloppe `{code, params, detail}` d'origine. */
export class CatalogueError extends Error {
  constructor(envelope, cause) {
    super(envelope?.code ?? 'CATALOG_UNKNOWN_ERROR', { cause });
    this.name = 'CatalogueError';
    this.code = envelope?.code ?? null;
    this.userMessage = envelope;
  }
}

/** Erreur levée quand un chargement est annulé par son appelant. */
export class CatalogueAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/** Convertit toute valeur d'échec IPC en `CatalogueError`. */
export function toCatalogueError(raw) {
  if (raw instanceof CatalogueError) return raw;
  const envelope = rustMessageEnvelope(raw);
  if (envelope?.code) return new CatalogueError(envelope, raw);
  // Sans code : détail technique seul, présenté par le message générique.
  const detail = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  return new CatalogueError({ code: null, params: {}, detail }, raw);
}

/** Message et détail technique présentables d'une erreur du catalogue. */
export function presentCatalogueError(error, options) {
  const envelope = error instanceof CatalogueError ? error.userMessage : rustMessageEnvelope(error);
  return presentUserMessage(envelope?.code ? envelope : { detail: envelope?.detail ?? '' }, { ...options, allowLegacyFrench: false });
}

async function tauriBridge() {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  return { invoke, listen };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new CatalogueAbortError();
}

/**
 * @param {{invoke?: Function, listen?: Function}} [bridge] doublures de test
 */
export function createCatalogueApi(bridge = {}) {
  let resolved = bridge.invoke && bridge.listen ? Promise.resolve(bridge) : null;
  const getBridge = () => {
    resolved ??= tauriBridge();
    return resolved;
  };

  async function call(command, args) {
    const { invoke } = await getBridge();
    try {
      return await invoke(command, args);
    } catch (error) {
      throw toCatalogueError(error);
    }
  }

  /**
   * Charge toutes les fiches page par page. Si l'index change pendant le
   * chargement (curseur périmé ou révision différente), le chargement
   * recommence depuis le début, sans erreur affichée.
   * @returns {Promise<{revision: number, cards: Array, restarts: number}>}
   */
  async function listAllEntries({ signal, pageSize = ENTRY_PAGE_LIMIT, includeUnavailable = true } = {}) {
    throwIfAborted(signal);
    const limit = Math.max(1, Math.min(ENTRY_PAGE_LIMIT, pageSize));
    for (let restarts = 0; restarts <= MAX_RESTARTS; restarts += 1) {
      let cursor = null;
      let revision = null;
      const items = [];
      let restart = false;
      do {
        throwIfAborted(signal);
        let page;
        try {
          page = await call('catalogue_list_entries', { limit, cursor, includeUnavailable });
        } catch (error) {
          if (error.code === CURSOR_EXPIRED) { restart = true; break; }
          throw error;
        }
        throwIfAborted(signal);
        if (revision !== null && page.catalogueRevision !== revision) { restart = true; break; }
        revision = page.catalogueRevision;
        items.push(...(Array.isArray(page.items) ? page.items : []));
        cursor = page.cursor ?? null;
      } while (cursor !== null);
      if (!restart) return { revision, cards: normalizeEntries(items), restarts };
    }
    throw new CatalogueError({ code: CURSOR_EXPIRED, params: {} });
  }

  /**
   * S'abonne à `catalogue-changed`. Renvoie une fonction de désabonnement
   * utilisable immédiatement, même avant l'installation de l'écoute.
   */
  function subscribeChanges(callback) {
    let stopped = false;
    let unlisten = null;
    getBridge()
      .then(({ listen }) => listen('catalogue-changed', (event) => {
        if (!stopped) callback({ revision: event?.payload?.catalogueRevision ?? null, scope: event?.payload?.scope ?? null });
      }))
      .then((stop) => {
        if (stopped) void releaseTauriListener(stop);
        else unlisten = stop;
      })
      .catch(() => { /* Hors Tauri : aucun événement, le chargement explicite suffit. */ });
    return () => {
      stopped = true;
      void releaseTauriListener(unlisten);
    };
  }

  async function subscribeOperations(callback) {
    const { listen } = await getBridge();
    const stops = [];
    try {
      for (const event of ['catalogue-operation-progress', 'catalogue-operation-finished']) {
        stops.push(await listen(event, ({ payload }) => callback(payload)));
      }
    } catch (error) {
      await Promise.all(stops.map((stop) => releaseTauriListener(stop)));
      throw toCatalogueError(error);
    }
    return () => { for (const stop of stops) void releaseTauriListener(stop); };
  }
  return {
    luniiPermission: () => call('catalogue_lunii_permission'),
    setLuniiPermission: (allowed) => call('catalogue_lunii_set_permission', { allowed, locale: i18n.language ?? 'en' }),
    openCatalogue: () => call('catalogue_lunii_open', { locale: i18n.language ?? 'en' }).catch(() => {}),
    listAllEntries, subscribeChanges, subscribeOperations,
    listSources: (workspaceDir) => call('catalogue_list_sources', { workspaceDir }),
    addSource: (path, expectedSourcesRevision, declined = false) => call('catalogue_add_source', { path, expectedSourcesRevision, declined }),
    previewRemoveSource: (sourceId) => call('catalogue_preview_remove_source', { sourceId }),
    removeSource: (sourceId, expectedSourcesRevision, expectedCatalogueRevision) => call('catalogue_remove_source', { sourceId, expectedSourcesRevision, expectedCatalogueRevision }),
    getExclusions: () => call('catalogue_get_source_exclusions'),
    explainPath: (path) => call('catalogue_explain_path', { path }),
    listOperations: (limit = 20) => call('catalogue_list_operations', { limit }),
    getOperation: (operationId, { limit = 100, cursor = null, issuesOnly = false } = {}) => call('catalogue_get_operation', { operationId, limit, cursor, ...(issuesOnly ? { issuesOnly: true } : {}) }),
    startScan: (args) => call('catalogue_start_scan', args),
    cancelOperation: (operationId) => call('catalogue_cancel_operation', { operationId }),
    /**
     * Affiche un exemplaire dans l'explorateur après revalidation ; un enfant
     * d'archive montre son archive. Une révision différente est refusée.
     * @returns {Promise<{revealed: boolean, fallbackParentOpened: boolean}>}
     */
    revealExemplar: ({ exemplarId, expectedRevision }) =>
      call('catalogue_reveal_exemplar', { exemplarId, expectedRevision }).then(revealResult),
    /** Affiche un chemin du rapport de scan (sous une source active seulement). */
    revealPath: (path) => call('catalogue_reveal_path', { path }).then(revealResult),
  };
}

/** Résultat d'une révélation, champs booléens garantis. */
export function revealResult(raw) {
  return { revealed: raw?.revealed === true, fallbackParentOpened: raw?.fallbackParentOpened === true };
}

let shared = null;

/** Adaptateur partagé de l'application (pont Tauri réel). */
export function catalogueApi() {
  shared ??= createCatalogueApi();
  return shared;
}
