import { useCallback, useEffect, useReducer, useRef } from 'react';
import { catalogueAssemblyApi } from '../store/catalogue/catalogueAssemblyApi.js';
import { INITIAL_ASSEMBLY, assemblyReducer, followAssemblyOperation } from '../store/catalogue/assemblyState.js';
export function useCatalogueAssembly(api = catalogueAssemblyApi) {
  const [state, dispatch] = useReducer(assemblyReducer, INITIAL_ASSEMBLY);
  const current = useRef(null);
  const close = useCallback(async () => {
    const task = current.current; current.current = null;
    try {
      if (task) { task.closed = true; if (task.operationId && !task.preparationId) await api.cancel(task.operationId); if (task.preparationId) await api.release(task.preparationId); }
    } finally { dispatch({ type: 'close' }); }
  }, [api]);
  useEffect(() => () => {
    const task = current.current; current.current = null;
    if (task) { task.closed = true; if (task.operationId && !task.preparationId) void api.cancel(task.operationId).catch(() => {}); if (task.preparationId) void api.release(task.preparationId).catch(() => {}); }
  }, [api]);
  async function start(orderedSelection) {
    if (current.current) return;
    const task = { closed: false }; current.current = task;
    dispatch({ type: 'start' });
    try {
      const receipt = await api.prepare({ orderedSelection, exemplarChoices: {}, requestId: crypto.randomUUID() });
      task.operationId = receipt.operationId;
      if (task.closed) await api.cancel(task.operationId);
      else dispatch({ type: 'receipt', receipt });
      await followAssemblyOperation(api, task, dispatch);
    } catch (error) { if (!task.closed) dispatch({ type: 'error', error }); }
  }
  return { state, start, close };
}
