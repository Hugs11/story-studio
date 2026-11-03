import { domId } from '../../../store/catalogue/viewModes.js';
import { ficheActionHandlers } from '../../../store/catalogue/ficheActionHandlers.js';
import { FicheModal } from './FicheModal.jsx';

/** Branche la grande fiche sur les services du catalogue, avec les gestionnaires du panneau. */
export function CatalogueFicheModal({ modal, cardsById, ...services }) {
  const card = modal.modal ? cardsById.get(modal.modal.id) : null;
  const handlers = ficheActionHandlers({ ...services, card, returnFocusId: () => card && domId('catalogue-item', card.id) });
  if (!card) return null;
  return <FicheModal key={card.id} card={card} position={modal.position} onStep={delta => modal.step(delta)} onClose={modal.close} {...handlers} />;
}
