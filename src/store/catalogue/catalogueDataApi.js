import { toCatalogueError } from './catalogueApi.js';
export const REVISION_CONFLICT = 'CATALOG_REVISION_CONFLICT';
export function createCatalogueDataApi(bridge = {}) {
  async function call(command, args) {
    try { const invoke = bridge.invoke ?? (await import('@tauri-apps/api/core')).invoke; return await invoke(command, args); }
    catch (error) { throw toCatalogueError(error); }
  }
  return {
    listUnreferenced: ({ limit, cursor }) => call('catalogue_list_unreferenced', { limit, cursor }),
    previewRemoveCards: ficheIds => call('catalogue_preview_remove_cards', { ficheIds }),
    removeCards: (ficheIds, expectedCatalogueRevision) => call('catalogue_remove_cards', { ficheIds, expectedCatalogueRevision }),
    removeMissingExemplar: (exemplarId, expectedCatalogueRevision) => call('catalogue_remove_missing_exemplar', { exemplarId, expectedCatalogueRevision }),
    previewForget: ficheIds => call('catalogue_preview_forget', { ficheIds }),
    lastUndo: () => call('catalogue_last_undo'),
    listTags: () => call('catalogue_list_tags'),
    // `inspectArchives`: an opened fiche asks the engine to count the packs
    // really held by its archives (trash availability); other readers do not.
    getCard: (ficheId, { inspectArchives = false } = {}) => call('catalogue_get_card', inspectArchives ? { ficheId, inspectArchives: true } : { ficheId }),
    mutate: (mutation, expectedCatalogueRevision) => call('catalogue_mutate', { mutation, expectedCatalogueRevision }),
    stageCover: path => call('catalogue_stage_cover', { path }),
    discardCovers: coverStagingIds => call('catalogue_discard_covers', { coverStagingIds }),
  };
}
export const catalogueDataApi = createCatalogueDataApi();
