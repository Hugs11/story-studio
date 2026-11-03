export const INITIAL_ASSEMBLY = { phase: 'idle', operationId: null, preparation: null, progress: null, error: null };
export function assemblyReducer(state, action) {
  switch (action.type) {
    case 'start': return { ...INITIAL_ASSEMBLY, phase: 'preparing' };
    case 'receipt': return { ...state, operationId: action.receipt.operationId };
    case 'progress': return { ...state, progress: action.progress };
    case 'ready': return { ...state, phase: 'ready', preparation: action.preparation };
    case 'error': return { ...state, phase: 'error', preparation: action.preparation ?? state.preparation, error: action.error };
    case 'close': return INITIAL_ASSEMBLY;
    default: return state;
  }
}

// OperationPage serializes Progress at its root (serde flatten).
export async function followAssemblyOperation(api, task, dispatch, pause = () => new Promise(resolve => setTimeout(resolve, 250))) {
  for (;;) {
    const operation = await api.operation(task.operationId);
    if (['success', 'failed', 'partial', 'cancelled'].includes(operation.status)) {
      task.preparationId = operation.result?.preparationId;
      if (task.closed) {
        if (task.preparationId) await api.release(task.preparationId);
        return;
      }
      if (operation.status !== 'success' || !operation.result) {
        dispatch({ type: 'error', error: operation.error, preparation: operation.result });
        return;
      }
      dispatch({ type: 'ready', preparation: operation.result });
      return;
    }
    if (!task.closed) dispatch({ type: 'progress', progress: operation });
    await pause();
  }
}
