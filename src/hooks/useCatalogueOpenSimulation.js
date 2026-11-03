import { useCallback, useEffect, useMemo, useRef } from 'react';
import { simulateCommand } from '../store/catalogue/cardActions.js';
import { choiceItems, choiceTarget } from '../store/catalogue/exemplarChoice.js';
import { simulationAvailability } from '../store/catalogue/simulationAvailability.js';
import { domId } from '../store/catalogue/viewModes.js';
import { useCatalogueConsultation } from './useCatalogueConsultation.js';

/**
 * « Simuler » depuis le catalogue : exemplaire désigné, seul exemplaire qui
 * convient, ou choix (D69) ; puis consultation au-dessus du catalogue.
 *
 * Pas de pile de fenêtres : une fiche complète ouverte se ferme au lancement
 * et se rouvre à la fermeture du simulateur ; sinon le focus revient à la
 * carte (ou au déclencheur) d'origine. La boîte de choix suit les
 * actualisations sans jamais viser un autre fichier.
 */
export function useCatalogueOpenSimulation({ api, active, cardsById, revision, ficheId, setFicheId, menus, onError }) {
  const restore = useCallback((origin) => {
    if (origin?.ficheId) {
      setFicheId(origin.ficheId);
    }
    if (!origin?.focusId) return;
    requestAnimationFrame(() => document.getElementById(origin.focusId)?.focus({ preventScroll: true }));
  }, [setFicheId]);
  const consultation = useCatalogueConsultation({ api, active, onClosed: restore, onCleanupFailed: onError });
  const pendingOrigin = useRef(null);
  const { choice, dispatchChoice } = menus;

  const start = useCallback((card, exemplar, expectedRevision, origin) => {
    // La fiche se ferme pendant l'écoute (sans retour de focus) et revient après.
    if (ficheId !== null) setFicheId(null);
    void consultation.launch({ exemplar, cardId: card.id, expectedRevision }, { ...origin, ficheId: origin?.ficheId ?? ficheId });
  }, [consultation, ficheId, setFicheId]);

  /**
   * @param {{card: object, exemplar?: object|null, revision: number, returnFocusId?: string|null}} request
   *   `revision` : révision à laquelle la cible a été affichée.
   */
  const simulate = useCallback(({ card, exemplar = null, revision: shown, returnFocusId = null }) => {
    const origin = { ficheId, focusId: returnFocusId ?? domId('catalogue-item', card.id) };
    if (exemplar) {
      start(card, exemplar, shown, origin);
      return;
    }
    const command = simulateCommand(card, card.exemplars);
    if (!command.enabled) return;
    if (command.exemplarId) {
      start(card, card.exemplars.find((item) => item.id === command.exemplarId), shown, origin);
      return;
    }
    pendingOrigin.current = origin;
    dispatchChoice({
      type: 'open',
      cardId: card.id,
      command: 'simulate',
      referenceExemplarId: card.referenceExemplarId,
      revision: shown,
      items: choiceItems(card.exemplars, simulationAvailability),
      returnFocusId: origin.focusId,
    });
  }, [ficheId, start, dispatchChoice]);

  const choiceCard = choice.open ? cardsById.get(choice.cardId) ?? null : null;
  const items = useMemo(() => (choiceCard ? choiceItems(choiceCard.exemplars, simulationAvailability) : []), [choiceCard]);
  const shownItems = useRef(items);
  // Actualisation pendant le choix : liste recalculée, ligne active gardée
  // par identifiant, révision courante (le moteur revalide encore au clic).
  useEffect(() => {
    if (!choice.open) {
      shownItems.current = [];
      return;
    }
    const previous = shownItems.current;
    shownItems.current = items;
    if (previous === items || !previous.length) return;
    dispatchChoice({ type: 'refresh', items, revision, activeId: previous[choice.activeIndex]?.id ?? null });
  // reason: seule une nouvelle liste ou révision déclenche l'actualisation ;
  // la ligne active est lue au moment de celle-ci.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, revision, choice.open]);

  const choose = useCallback((item) => {
    const target = choiceTarget(choice, item);
    if (!target || !choiceCard) return;
    dispatchChoice({ type: 'close', restoreFocus: false });
    start(choiceCard, item.exemplar, target.expectedRevision, pendingOrigin.current);
  }, [choice, choiceCard, dispatchChoice, start]);

  const cancelChoice = useCallback(() => {
    const origin = pendingOrigin.current;
    // Choix repris après une cible périmée : la fiche d'origine revient.
    if (origin?.ficheId && ficheId === null) {
      dispatchChoice({ type: 'close', restoreFocus: false });
      setFicheId(origin.ficheId);
      return;
    }
    dispatchChoice({ type: 'close' });
  }, [dispatchChoice, ficheId, setFicheId]);

  /** Cible périmée : la liste actualisée est proposée de nouveau. */
  const chooseAgain = useCallback((state) => {
    const card = cardsById.get(state.target?.cardId);
    consultation.close({ restore: !card });
    if (!card) return;
    pendingOrigin.current = state.origin;
    dispatchChoice({
      type: 'open',
      cardId: card.id,
      command: 'simulate',
      referenceExemplarId: card.referenceExemplarId,
      revision,
      items: choiceItems(card.exemplars, simulationAvailability),
      returnFocusId: state.origin?.focusId ?? null,
    });
  }, [cardsById, consultation, dispatchChoice, revision]);

  return {
    consultation,
    simulate,
    chooseAgain,
    choice: { state: choice, card: choiceCard, items, dispatch: dispatchChoice, choose, cancel: cancelChoice },
    blocking: consultation.visible || choice.open,
  };
}
