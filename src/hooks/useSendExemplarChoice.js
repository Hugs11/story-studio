import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { choiceItems, choiceReducer, CLOSED_CHOICE } from '../store/catalogue/exemplarChoice.js';
import { sendChoiceAvailability } from '../store/catalogue/luniiSend.js';

/**
 * Chooser of the copy to send to a Lunii (D41), on the same box as « Ouvrir dans
 * l'éditeur ». `ask(card)` resolves to the chosen exemplar id, or null when the
 * user cancels (button or Échap); calls are served one after the other.
 */
export function useSendExemplarChoice() {
  const [choice, dispatch] = useReducer(choiceReducer, CLOSED_CHOICE);
  const [card, setCard] = useState(null);
  const pending = useRef(null);
  const queue = useRef(Promise.resolve());
  const items = useMemo(() => choiceItems(card?.exemplars, sendChoiceAvailability), [card]);

  const settle = useCallback(value => {
    const resolve = pending.current;
    pending.current = null;
    dispatch({ type: 'close', restoreFocus: false });
    setCard(null);
    resolve?.(value);
  }, []);

  const ask = useCallback(target => {
    const run = () => new Promise(resolve => {
      pending.current = resolve;
      setCard(target);
      dispatch({ type: 'open', cardId: target.id, command: 'send', referenceExemplarId: target.referenceExemplarId, revision: null,
        items: choiceItems(target.exemplars, sendChoiceAvailability) });
    });
    const next = queue.current.then(run);
    queue.current = next;
    return next;
  }, []);

  // An unmounted screen answers « cancelled » so nothing waits forever.
  useEffect(() => () => { pending.current?.(null); pending.current = null; }, []);

  return { ask, choice: { state: choice, card, items, dispatch,
    choose: item => { if (item?.enabled) settle(item.id); },
    cancel: () => settle(null) } };
}
