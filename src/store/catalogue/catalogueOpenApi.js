// Adaptateur IPC des ouvertures depuis le catalogue (simulation par session de
// consultation). Comme `catalogueApi.js`, c'est un des seuls points d'appel de
// `invoke` pour le catalogue : chaque réponse devient un modèle interne et
// chaque `UserMessage` d'erreur une `CatalogueError` présentable.
//
// Aucune commande ne reçoit de chemin : la cible est toujours
// `{exemplarId, expectedRevision}` tels que publiés par la liste des fiches.
//
// Le pont Tauri est injectable : les tests fournissent leurs doublures.

import { toCatalogueError } from './catalogueApi.js';

export const CONSULTATION_EXPIRED = 'CATALOG_CONSULTATION_EXPIRED';

async function tauriInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

function text(value) {
  return typeof value === 'string' && value ? value : null;
}

/** Poignée de consultation, champs garantis. */
export function consultationHandle(raw) {
  const mediaTypes = {};
  for (const [id, type] of Object.entries(raw?.mediaTypes ?? {})) {
    if (typeof type === 'string') mediaTypes[id] = type;
  }
  return {
    consultationId: String(raw?.consultationId ?? ''),
    exemplarId: String(raw?.exemplarId ?? ''),
    sourceRevision: Number.isInteger(raw?.sourceRevision) ? raw.sourceRevision : null,
    kind: raw?.kind === 'document' ? 'document' : 'pack',
    graph: raw?.graph ?? null,
    startId: text(raw?.startId),
    mediaCount: Number.isInteger(raw?.mediaCount) ? raw.mediaCount : 0,
    mediaTypes,
  };
}

/** Résultat d'une fermeture, champs booléens garantis. */
export function closedConsultation(raw) {
  return {
    closed: raw?.closed === true,
    cleanupFailed: raw?.cleanupFailed === true,
    cleanup: raw?.cleanup ?? null,
  };
}

/** Octets d'un média, quelle que soit la forme du transport binaire. */
export function assetBytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  return new Uint8Array(0);
}

/**
 * @param {{invoke?: Function}} [bridge] doublure de test
 */
export function createCatalogueOpenApi(bridge = {}) {
  let resolved = bridge.invoke ? Promise.resolve(bridge.invoke) : null;
  const getInvoke = () => {
    resolved ??= tauriInvoke();
    return resolved;
  };

  async function call(command, args) {
    const invoke = await getInvoke();
    try {
      return await invoke(command, args);
    } catch (error) {
      throw toCatalogueError(error);
    }
  }

  return {
    releaseEditorExtractions: ownerId => call('catalogue_release_editor_extractions', { ownerId }),
    recordGeneration: ({ projectPath, outputPath, generatedProjectJson, generatedOutputFingerprint }) => call('catalogue_record_generation', { projectPath, outputPath, ...(generatedProjectJson !== undefined ? { generatedProjectJson } : {}), ...(generatedOutputFingerprint !== undefined ? { generatedOutputFingerprint } : {}) }),
    prepareEditorEntry: ({ exemplarId, expectedRevision, purpose }) => call('catalogue_prepare_editor_entry', { exemplarId, expectedRevision, purpose }),
    /**
     * Prépare la simulation d'un exemplaire revalidé. `projectJson` : projet
     * par menus déjà normalisé en lecture seule (voir le hook).
     */
    openConsultation: ({ consultationId, exemplarId, expectedRevision, projectJson = null }) =>
      call('catalogue_open_consultation', { consultationId, exemplarId, expectedRevision, projectJson })
        .then(consultationHandle),
    readConsultationAsset: ({ consultationId, mediaId }) =>
      call('catalogue_read_consultation_asset', { consultationId, mediaId }).then(assetBytes),
    closeConsultation: (consultationId) =>
      call('catalogue_close_consultation', { consultationId }).then(closedConsultation),
  };
}

let shared = null;

/** Adaptateur partagé de l'application (pont Tauri réel). */
export function catalogueOpenApi() {
  shared ??= createCatalogueOpenApi();
  return shared;
}
