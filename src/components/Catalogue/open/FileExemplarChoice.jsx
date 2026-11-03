import { useReducer } from 'react';
import { choiceItems, choiceReducer, CLOSED_CHOICE } from '../../../store/catalogue/exemplarChoice.js';
import { ExemplarChoiceDialog } from './ExemplarChoiceDialog.jsx';

/** The same compact chooser for file actions, with an explicit exemplar target. */
export function FileExemplarChoice({ card, command, availability, onChoose, onClose }) {
  const items = choiceItems(card.exemplars, availability);
  const [choice, dispatch] = useReducer(choiceReducer, null, () => choiceReducer(CLOSED_CHOICE, {
    type: 'open', cardId: card.ficheId ?? card.id, command, items, referenceExemplarId: card.referenceExemplarId ?? card.reference?.exemplarId,
  }));
  return <ExemplarChoiceDialog choice={choice} card={card} items={items} dispatch={dispatch}
    onChoose={item => { if (item?.enabled) onChoose([item.exemplar]); }} onCancel={onClose} />;
}
