// Shared source mutations: adding a folder starts its scan; a failed scan reloads revisions.
export function useCatalogueSourceActions(sources, operations, setActionError) {
  async function refresh(sourceId, paths) {
    setActionError(null);
    try { await operations.start(sources.sourcesRevision, { sourceIds: sourceId ? [sourceId] : undefined, paths }); }
    catch (error) { setActionError(error); await sources.refresh(); }
  }
  async function add(path, declined = false) {
    setActionError(null);
    const result = await sources.add(path, declined);
    if (result && !declined && !result.alreadyActive) {
      try { await operations.start(result.sourcesRevision, { sourceIds: [result.sourceId] }); }
      catch (error) { setActionError(error); }
    }
    return result;
  }
  return { add, refresh };
}
