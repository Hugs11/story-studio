export const emptyUndo = () => ({ token: null, status: 'empty', conflicts: [] });
export function undoState(state, event) {
  if (event.type === 'outcome' && event.outcome.undoToken) return { token: event.outcome.undoToken, status: 'ready', conflicts: [] };
  if (event.type === 'undone') return emptyUndo();
  if (event.type === 'error' && event.error.code === 'CATALOG_UNDO_EXPIRED') return { token: null, status: 'expired', conflicts: [] };
  if (event.type === 'error' && event.error.code === 'CATALOG_UNDO_CONFLICT') return { ...state, status: 'conflict', conflicts: event.error.userMessage?.params?.conflicts ?? [] };
  return state;
}
