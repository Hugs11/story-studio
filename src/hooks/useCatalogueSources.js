import { useErrorDialog } from '../components/common/Dialog.jsx';
import { useCatalogueTranslation } from '../i18n/useCatalogueTranslation.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sourceAddResult } from '../store/catalogue/sourceView.js';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';
import { createReloadScheduler } from '../store/catalogue/entriesState.js';

export function useCatalogueSources(workspaceDir, { api = catalogueApi() } = {}) {
  const { showChoiceDialog } = useErrorDialog();
  const { t } = useCatalogueTranslation();
  const [state, setState] = useState({ items: [], sourcesRevision: null, loading: true, exclusions: null, error: null, notice: null, busy: false });
  const alive = useRef(false);
  const stateRef = useRef(state);
  const mutating = useRef(false);
  useEffect(() => { stateRef.current = state; }, [state]);
  const revision = useRef(null);
  const reload = useRef(null);
  const lastList = useRef(null);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    const scheduler = createReloadScheduler({ run: async () => {
      try {
        const list = await api.listSources(workspaceDir);
        lastList.current = list;
        if (!stopped) { revision.current = list.sourcesRevision; setState((s) => ({ ...s, ...list, loading: false, error: null })); }
        return list.catalogueRevision;
      } catch (error) { if (!stopped) setState((s) => ({ ...s, loading: false, error })); return null; }
    } });
    reload.current = scheduler;
    const unsubscribe = api.subscribeChanges(() => scheduler.request());
    const seen = new Map();
    const operations = api.subscribeOperations((snapshot) => {
      const signature = `${snapshot.status}:${snapshot.currentSourceId ?? ''}`;
      if (seen.get(snapshot.operationId) !== signature) {
        seen.set(snapshot.operationId, signature);
        scheduler.request();
      }
    }).then((stop) => { if (stopped) stop(); return stop; }).catch(() => null);
    void api.getExclusions().then((exclusions) => { if (!stopped) setState((s) => ({ ...s, exclusions })); }).catch((error) => { if (!stopped) setState((s) => ({ ...s, error })); });
    void scheduler.now();
    return () => { alive.current = false; stopped = true; scheduler.dispose(); unsubscribe(); void operations.then((stop) => stop?.()); };
  }, [api, workspaceDir]);
  const mutate = useCallback(async (kind, target, declined = false) => {
    if (mutating.current) return null;
    mutating.current = true;
    setState((s) => ({ ...s, busy: true, error: null, mutationError: null }));
    try {
      let result;
      if (kind === 'remove') {
        const preview = await api.previewRemoveSource(target);
        const confirmed = await showChoiceDialog({
          title: t('catalogue:sources.remove.title'),
          message: preview.remaining > 0
            ? (preview.remaining === 1
              ? t('catalogue:sources.remove.withRemainingOne', { count: preview.count, remaining: preview.remaining })
              : t('catalogue:sources.remove.withRemainingOther', { count: preview.count, remaining: preview.remaining }))
            : t('catalogue:sources.remove.confirm', { count: preview.count }),
          actions: [
            { value: false, label: t('catalogue:sources.remove.cancel'), autoFocus: true },
            { value: true, label: t('catalogue:sources.remove.accept'), kind: 'danger' },
          ],
        });
        if (confirmed !== true) return null;
        result = await api.removeSource(target, preview.sourcesRevision, preview.catalogueRevision);
      } else result = await api.addSource(target, revision.current, declined);
      revision.current = result.sourcesRevision;
      const before = stateRef.current.items;
      await reload.current.now();
      const view = sourceAddResult(before, result, declined, lastList.current?.items);
      if (alive.current) setState((s) => ({ ...s, notice: kind === 'remove' ? { key: 'catalogue:sources.removed.message', params: {} } : view.notice }));
      return { ...result, alreadyActive: view.alreadyActive };
    } catch (error) {
      if (alive.current) setState((s) => ({ ...s, mutationError: error }));
      // Conflicting revisions require a fresh list before a user retry.
      await reload.current.now();
      return null;
    } finally { mutating.current = false; if (alive.current) setState((s) => ({ ...s, busy: false })); }
  }, [api, showChoiceDialog, t]);
  return { ...state, add: (path, declined) => mutate('add', path, declined), remove: (id) => mutate('remove', id), refresh: () => reload.current?.now() };
}
