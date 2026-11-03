import { useEffect, useReducer, useRef, useState } from 'react';
import { emptyUndo, undoState } from '../store/catalogue/undoState.js';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';
export function useCatalogueUndo(revision, onError) {
  const [noticeToken, setNoticeToken] = useState(null);
  const [state, dispatch] = useReducer(undoState, undefined, emptyUndo);
  const latest = useRef({ loaded: false, token: null });
  useEffect(() => {
    let active = true;
    catalogueDataApi.lastUndo().then(outcome => {
      if (!active) return;
      if (latest.current.loaded && outcome.undoToken && outcome.undoToken !== latest.current.token) setNoticeToken(outcome.undoToken);
      latest.current = { loaded: true, token: outcome.undoToken ?? null };
      dispatch(outcome.undoToken ? { type: 'outcome', outcome } : { type: 'undone' });
    }, onError);
    return () => { active = false; };
  }, [revision, onError]);
  return { state, noticeToken, remember: outcome => { dispatch({ type: 'outcome', outcome }); if (outcome.undoToken) setNoticeToken(outcome.undoToken); }, done: () => dispatch({ type: 'undone' }), fail: error => dispatch({ type: 'error', error }) };
}
