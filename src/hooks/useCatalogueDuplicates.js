import { createDuplicateRequest } from '../store/catalogue/duplicateRequest.js';
import { useEffect, useRef, useState } from 'react';
import { catalogueFilesApi } from '../store/catalogue/catalogueFilesApi.js';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';
import { emptyDuplicateResults, appendDuplicatePage } from '../store/catalogue/duplicateModel.js';
export function useCatalogueDuplicates(ficheId = null) {
  const [state, setState] = useState({ phase: 'idle', results: emptyDuplicateResults(), error: null });
  const resultOwner = useRef(null); const request = useRef(null); const lock = useRef(false); const generation = useRef(0);
  if (!request.current) request.current = createDuplicateRequest({
    find: async (scope, requestId) => {
      const previous = resultOwner.current; resultOwner.current = null;
      if (previous) await catalogueFilesApi.releaseDuplicateResults(previous);
      return catalogueFilesApi.findDuplicates(scope, requestId);
    },
    cancel: operationId => catalogueApi().cancelOperation(operationId),
    onCancelError: error => setState(s => ({ ...s, error })),
  });
  useEffect(() => () => {
    generation.current += 1;
    if (resultOwner.current) void catalogueFilesApi.releaseDuplicateResults(resultOwner.current).catch(error => setState(s => ({ ...s, error })));
  }, []);
  async function start() {
    if (lock.current) return;
    lock.current = true; const current = ++generation.current;
    setState({ phase: 'running', results: emptyDuplicateResults(), error: null });
    try {
      const receipt = await request.current.start({ ficheId }, crypto.randomUUID());
      resultOwner.current = receipt.operationId;
      if (generation.current === current) setState(s => ({ ...s, operationId: receipt.operationId }));
      else await catalogueFilesApi.releaseDuplicateResults(receipt.operationId);
    } catch (error) { if (generation.current === current) setState(s => ({ ...s, phase: 'failed', error })); lock.current = false; }
  }
  useEffect(() => {
    if (state.phase !== 'running' || !state.operationId) return;
    let stopped = false; let timer;
    async function poll() {
      try {
        const report = await catalogueApi().getOperation(state.operationId, { limit: 1 });
        if (stopped) return;
        if (['success', 'failed', 'partial', 'cancelled'].includes(report.status)) {
          const results = report.status === 'success' ? await catalogueFilesApi.duplicateResults(state.operationId) : emptyDuplicateResults();
          if (!stopped) { request.current.finish(state.operationId); lock.current = false; setState(s => ({ ...s, phase: report.status, results, error: report.error })); }
          return;
        }
      } catch (error) {
        if (stopped) return;
        if (error.code === 'CATALOG_OPERATION_EXPIRED') {
          request.current.finish(state.operationId); lock.current = false;
          setState(s => ({ ...s, phase: 'failed', error })); return;
        }
        setState(s => ({ ...s, error }));
      }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [state.phase, state.operationId]);
  async function more() {
    if (lock.current || state.results.cursor === null) return;
    lock.current = true; const current = generation.current;
    try {
      const page = await catalogueFilesApi.duplicateResults(state.operationId, state.results.cursor);
      if (generation.current === current) setState(s => ({ ...s, results: appendDuplicatePage(s.results, page) }));
    } catch (error) { if (generation.current === current) setState(s => ({ ...s, error })); }
    finally { lock.current = false; }
  }
  async function cancel() {
    try { await request.current.cancel(); }
    catch (error) { setState(s => ({ ...s, error })); }
  }
  return { state, start, more, cancel };
}
