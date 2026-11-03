import { isTerminalTrackingError } from '../store/catalogue/fileOperationTracking.js';
import { useEffect, useReducer, useRef } from 'react';
import { catalogueBackupApi } from '../store/catalogue/catalogueBackupApi.js';
import { INITIAL_IMPORT, importPreviewReducer, canApplyImport } from '../store/catalogue/importPreviewState.js';
import { choicePayload } from '../store/catalogue/importConflicts.js';
export function useCatalogueImport({ api = catalogueBackupApi } = {}) {
  const [state, dispatch] = useReducer(importPreviewReducer, INITIAL_IMPORT);
  const alive = useRef(true); const lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function preview() {
    if (lock.current || !state.path.trim()) return;
    const context = {};
    lock.current = true; dispatch({ type: 'begin', mode: 'preview', context });
    try {
      const associations = Object.fromEntries(Object.entries(state.associations).filter(([, target]) => target.trim()));
      const receipt = await api.previewImport(state.path, crypto.randomUUID(), associations);
      if (alive.current) dispatch({ type: 'receipt', receipt, context });
    } catch (error) { if (alive.current) dispatch({ type: 'failed', error, context }); }
    finally { lock.current = false; }
  }
  async function page(offset) {
    if (lock.current || state.phase !== 'preview') return;
    const context = state.context;
    lock.current = true;
    try {
      const next = await api.importPage(state.preview.previewId, offset);
      if (alive.current) dispatch({ type: 'page', page: next, context });
    } catch (error) { if (alive.current) dispatch({ type: 'failed', error, context }); }
    finally { lock.current = false; }
  }
  async function apply() {
    if (lock.current || !canApplyImport(state)) return;
    const context = state.context;
    lock.current = true; dispatch({ type: 'begin', mode: 'apply' });
    try {
      // Enumerate only bounded pages; the global decision covers unseen conflicts.
      const choices = {};
      for (let offset = 0; offset < state.preview.conflicts.total; offset += 100) {
        const next = await api.importPage(state.preview.previewId, offset);
        Object.assign(choices, choicePayload(state, next.conflicts.items));
      }
      const receipt = await api.applyImport({ previewId: state.preview.previewId, choices,
        associations: Object.fromEntries(Object.entries(state.associations).filter(([, target]) => target.trim())),
        expectedCatalogueRevision: state.preview.expectedCatalogueRevision, requestId: crypto.randomUUID() });
      if (alive.current) dispatch({ type: 'receipt', receipt, context });
    } catch (error) { if (alive.current) dispatch({ type: 'failed', error, context }); }
    finally { lock.current = false; }
  }
  useEffect(() => {
    if (!state.receipt || !['preparing', 'applying', 'cancelling'].includes(state.phase)) return;
    const context = state.context;
    let stopped = false; let timer;
    async function poll() {
      try {
        const progress = await api.importOperation(state.receipt.operationId, state.mode);
        if (stopped) return;
        if (progress.status === 'success' && state.mode === 'preview') {
          try {
            const next = await api.importPage(progress.result.previewId);
            if (!stopped) dispatch({ type: 'page', page: next, prepared: true, context });
          } catch (error) {
            if (!stopped) dispatch({ type: 'failed', error, context });
          }
          return;
        } else dispatch({ type: 'progress', progress, context });
        if (['success', 'failed', 'cancelled', 'partial'].includes(progress.status)) return;
      } catch (error) { if (stopped) return; dispatch({ type: isTerminalTrackingError(error) ? 'failed' : 'trackingError', error, context }); if (isTerminalTrackingError(error)) return; }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [api, state.receipt, state.phase, state.mode, state.context]);
  async function cancel() {
    if (!state.receipt || !['preparing', 'applying'].includes(state.phase)) return;
    const context = state.context;
    dispatch({ type: 'cancel' });
    try { await api.cancel(state.receipt.operationId); }
    catch (error) { if (alive.current) dispatch({ type: 'failed', error, context }); }
  }
  return { state, dispatch, preview, page, apply, cancel };
}
