import { isTerminalTrackingError } from '../store/catalogue/fileOperationTracking.js';
import { useEffect, useReducer, useRef } from 'react';
import { catalogueBackupApi } from '../store/catalogue/catalogueBackupApi.js';
import { backupExportReducer, INITIAL_EXPORT, canExport } from '../store/catalogue/backupExportState.js';
export function useCatalogueBackup(revision, { api = catalogueBackupApi } = {}) {
  const [state, dispatch] = useReducer(backupExportReducer, INITIAL_EXPORT);
  const lock = useRef(false);
  const alive = useRef(true);
  const request = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function preview() {
    if (lock.current || !state.path.trim()) return;
    lock.current = true; dispatch({ type: 'planning' });
    try {
      const plan = await api.plan(state.path, revision);
      request.current = crypto.randomUUID();
      if (alive.current) dispatch({ type: 'planned', plan });
    } catch (error) { if (alive.current) dispatch({ type: 'failed', error }); }
    finally { lock.current = false; }
  }
  async function start() {
    if (lock.current || !canExport(state)) return;
    lock.current = true; dispatch({ type: 'starting' });
    try {
      const receipt = await api.start(state.plan.planId, { summaryValidated: true, replaceExisting: state.replaceExisting }, request.current);
      if (alive.current) dispatch({ type: 'started', receipt });
    } catch (error) { if (alive.current) dispatch({ type: 'failed', error }); }
    finally { lock.current = false; }
  }
  useEffect(() => {
    if (!state.receipt || !['running', 'cancelling'].includes(state.phase)) return;
    let stopped = false; let timer;
    async function poll() {
      try {
        const progress = await api.operation(state.receipt.operationId);
        if (stopped) return;
        dispatch({ type: 'progress', progress });
        if (['success', 'failed', 'partial', 'cancelled'].includes(progress.status)) return;
      } catch (error) { if (stopped) return; dispatch({ type: isTerminalTrackingError(error) ? 'failed' : 'trackingError', error }); if (isTerminalTrackingError(error)) return; }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, state.receipt, state.phase]);
  async function cancel() {
    if (state.phase !== 'running') return;
    dispatch({ type: 'cancel' });
    try { await api.cancel(state.receipt.operationId); }
    catch (error) { if (alive.current) dispatch({ type: 'cancelError', error }); }
  }
  return { state, dispatch, preview, start, cancel };
}
