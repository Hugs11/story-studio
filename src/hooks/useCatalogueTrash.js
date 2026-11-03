import { isTerminalTrackingError } from '../store/catalogue/fileOperationTracking.js';
import { useEffect, useRef, useState } from 'react';
import { catalogueFilesApi } from '../store/catalogue/catalogueFilesApi.js';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';
import { catalogueDataApi } from '../store/catalogue/catalogueDataApi.js';
import { launchRemoval, trashGestureArmed } from '../store/catalogue/trashPlan.js';
import { rememberRemovalTitle } from '../store/catalogue/operationView.js';

export function useCatalogueTrash(card, exemplar, { filesApi = catalogueFilesApi, dataApi = catalogueDataApi, operationApi = catalogueApi, now = Date.now } = {}) {
  const [state, setState] = useState({ phase: 'choices', plan: null, error: null });
  const generation = useRef(0);
  const busy = useRef(false);
  const appearedAt = useRef(0);
  const heldPlan = useRef(null);
  function release(plan = heldPlan.current) {
    if (!plan) return;
    if (heldPlan.current === plan) heldPlan.current = null;
    void filesApi.releasePlan?.(plan.planId).catch(() => {});
  }
  useEffect(() => () => { generation.current++; release(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function planTarget() {
    const fresh = await dataApi.getCard(card.ficheId ?? card.id);
    return filesApi.plan([{ ficheId: fresh.ficheId ?? fresh.id, exemplarId: exemplar.id, expectedRevision: fresh.catalogueRevision }], { mode: 'replace' }, 'trash');
  }
  function review(plan, permanentPending = false) {
    heldPlan.current = plan;
    appearedAt.current = now();
    setState({ phase: 'review', plan, permanentPending, error: null });
  }
  function reset() {
    if (busy.current || ['running', 'finished'].includes(state.phase)) return;
    generation.current++;
    release();
    appearedAt.current = now();
    setState({ phase: 'choices', plan: null, error: null });
  }
  async function preview() {
    if (busy.current || ['running', 'finished'].includes(state.phase)) return;
    const id = ++generation.current;
    appearedAt.current = now();
    setState({ phase: 'planning', plan: null, error: null });
    try {
      release();
      const plan = await planTarget();
      if (generation.current === id) review(plan);
      else release(plan);
    } catch (error) { if (generation.current === id) setState({ phase: 'failed', plan: null, error }); }
  }
  async function confirm() {
    if (busy.current || state.phase !== 'review' || !trashGestureArmed(appearedAt.current, now())) return;
    busy.current = true;
    const id = generation.current;
    setState(s => ({ ...s, phase: 'confirming' }));
    try {
      let receipt;
      let current = state.plan;
      const permanent = state.permanentPending || current.action === 'deletePermanently';
      async function prepareAndLaunch(plan) {
        current = plan.action === 'trash' && permanent
          ? await filesApi.preparePermanentDelete(plan.planId) : plan;
        heldPlan.current = current;
        setState(s => ({ ...s, plan: current, permanentPending: false }));
        const requestId = crypto.randomUUID();
        rememberRemovalTitle(requestId, card, exemplar);
        return launchRemoval(filesApi, current, requestId);
      }
      try { receipt = await prepareAndLaunch(current); }
      catch (error) {
        if (error.code !== 'CATALOG_REVISION_CONFLICT') throw error;
        const fresh = await planTarget();
        if (fresh.targets[0].sourceToken !== state.plan.targets[0].sourceToken) {
          release(fresh);
          throw { code: 'CATALOG_FILE_SOURCE_CHANGED' };
        }
        release();
        receipt = await prepareAndLaunch(fresh);
      }
      if (generation.current === id) setState(s => ({ ...s, phase: 'running', receipt }));
    } catch (error) { busy.current = false; if (generation.current === id) setState(s => ({ ...s, phase: 'failed', error })); }
    // Keep the launch latched until its terminal report.
  }
  useEffect(() => {
    if (state.phase !== 'running') return;
    let stopped = false; let timer;
    async function poll() {
      try {
        const progress = await operationApi().getOperation(state.receipt.operationId);
        if (stopped) return;
        if (['success', 'failed', 'partial', 'cancelled'].includes(progress.status)) {
          // A volume may lose its trash after preview. Require a new labelled
          // gesture rather than silently destroying the file on that receipt.
          if (progress.error?.code === 'CATALOG_TRASH_UNAVAILABLE') {
            busy.current = false;
            review(state.plan, true);
          } else { busy.current = false; setState(s => ({ ...s, phase: progress.status === 'success' ? 'finished' : 'failed', error: progress.error ?? (progress.status === 'success' ? null : { code: 'CATALOG_TRASH_FAILED' }) })); }
          return;
        }
      } catch (error) {
        if (stopped) return;
        if (isTerminalTrackingError(error)) { busy.current = false; setState(s => ({ ...s, phase: 'failed', error })); return; }
      }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [state.phase, state.receipt, state.plan, operationApi, filesApi, now]);
  return { state, preview, confirm, reset };
}
