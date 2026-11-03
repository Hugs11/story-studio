import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { choiceDecision, choiceItems, choiceReducer, choiceTarget, CLOSED_CHOICE } from '../store/catalogue/exemplarChoice.js';
import { simulationAvailability } from '../store/catalogue/simulationAvailability.js';
import { openTarget } from '../store/catalogue/openTargets.js';
import { editWarning } from '../store/catalogue/editWarning.js';

const STALE_TARGET = ['CATALOG_TARGET_REVISION_CHANGED', 'CATALOG_TARGET_REVISION_STALE'];

function editorAvailability(exemplar, purpose = 'edit') {
  if (purpose === 'editAndGenerate' && exemplar.format !== 'project') return { enabled: false, reasonKey: 'catalogue:reason.action.unsupportedFormat' };
  return simulationAvailability(exemplar);
}

/** Editor openings only: revalidate the explicit target, then delegate to the host. */
export function useCatalogueOpen({ api, cardsById, revision, onOpen, onError, onRefresh, onWarning }) {
  const [choice, dispatch] = useReducer(choiceReducer, CLOSED_CHOICE);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const card = choice.open ? cardsById.get(choice.cardId) : null;
  const items = useMemo(() => choiceItems(card?.exemplars, exemplar => editorAvailability(exemplar,choice.command)), [card, choice.command]);
  const previousItems = useRef(items);
  useEffect(() => {
    const before = previousItems.current;
    previousItems.current = items;
    if (choice.open) dispatch({ type: 'refresh', items, revision, activeId: before[choice.activeIndex]?.id });
  // reason: refresh on publication only; preserve the selected identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, revision, choice.open]);
  const start = useCallback(async (exemplar, expectedRevision, origin, purpose = 'edit', retryStale = false) => {
    if (busy.current || !onOpen) return;
    busy.current = true;
    try {
      let revision = expectedRevision;
      for (;;) {
        try {
          let entry = await api.prepareEditorEntry({ exemplarId: exemplar.id, expectedRevision: revision, purpose });
          if (!mounted.current) return;
          const warning = editWarning(entry);
          if (warning) {
            const decision = await onWarning(warning);
            if (!mounted.current || decision === null) return;
            // Revalidate again after the warning, including its project choice.
            entry = await api.prepareEditorEntry({ exemplarId: decision === 'project' ? warning.project.exemplarId : exemplar.id, expectedRevision: revision, purpose });
          }
          if (mounted.current) await onOpen({ ...openTarget(entry), purpose, target: { exemplar, cardId: origin.card.id, expectedRevision: revision } });
          return;
        } catch (error) {
          if (!STALE_TARGET.includes(error.code)) { onError(error); return; }
          // A direct opening (the only exemplar, or the one named by the user) is
          // retried once on the SAME exemplar at the reloaded revision: some
          // catalogue changes do not reach the list before the click.
          if (retryStale) {
            retryStale = false;
            const fresh = await onRefresh?.();
            if (!mounted.current) return;
            if (Number.isInteger(fresh) && fresh !== revision) { revision = fresh; continue; }
          } else {
            onError(error);
            await onRefresh?.();
          }
          if (mounted.current) dispatch({ type: 'open', cardId: origin.card.id, command: purpose, referenceExemplarId: origin.card.referenceExemplarId, revision: expectedRevision, items: choiceItems(origin.card.exemplars, editorAvailability), returnFocusId: origin.returnFocusId });
          return;
        }
      }
    } finally { busy.current = false; }
  }, [api, onOpen, onError, onRefresh, onWarning]);
  const edit = useCallback((request) => {
    if (!onOpen) return;
    const { card, exemplar, revision, returnFocusId = null, purpose = 'edit' } = request;
    const decision = exemplar ? { kind: 'direct', exemplarId: exemplar.id } : choiceDecision(card.exemplars, { policy: 'always', availability: exemplar => editorAvailability(exemplar,purpose) });
    if (decision.kind === 'direct') void start(exemplar ?? card.exemplars.find(e => e.id === decision.exemplarId), revision, request, purpose, true);
    else if (decision.kind === 'choose') dispatch({ type: 'open', cardId: card.id, command: purpose, referenceExemplarId: card.referenceExemplarId, revision, items: decision.items, returnFocusId });
  }, [onOpen, start]);
  return { edit, choice: { state: choice, card, items, dispatch,
    choose: item => { const target = choiceTarget(choice,item); if (!target || !card) return; dispatch({ type:'close',restoreFocus:false }); void start(item.exemplar,target.expectedRevision,{ card, returnFocusId:choice.returnFocusId }, choice.command === 'editAndGenerate' ? 'editAndGenerate' : 'edit'); },
    cancel: () => dispatch({ type: 'close' }),
  } };
}
