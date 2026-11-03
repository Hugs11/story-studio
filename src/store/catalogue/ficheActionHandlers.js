import { ficheOpenRequest } from './cardActions.js';
import { tagPopoverAt } from './tagPopover.js';

/**
 * Gestionnaires d'une fiche affichée (panneau latéral ou grande fiche) :
 * favori, étiquettes, copie de l'UUID, révélation, menu d'exemplaire,
 * corbeille, simulation et éditeur. Un seul endroit pour les deux surfaces.
 *
 * @param {object} options
 * @param {object|null} options.card fiche affichée
 * @param {boolean} [options.selectionTargets] le sélecteur d'étiquettes vise toute la sélection multiple (panneau)
 * @param {(trigger: HTMLElement|null) => string|null} options.returnFocusId focus rendu après Simuler / Éditer
 * @param {() => void} [options.onTrashSettled] appelé avant l'annonce de fin de corbeille
 * @returns {object|null} props à étaler sur `FichePanel` / `FicheModal`
 */
export function ficheActionHandlers({ card, revision, data, actions, setTagPopover, actionFocus, simulate, edit, onFilterTag, onAnnounce, onRefresh, onError,
  selectionTargets = false, returnFocusId = trigger => trigger?.id ?? null, onTrashSettled }) {
  if (!card) return null;
  const open = (kind, command, trigger) => {
    try {
      const request = ficheOpenRequest(card, command, revision, returnFocusId(trigger));
      if (kind === 'simulate') simulate(request);
      else edit({ ...request, purpose: command.purpose ?? 'edit' });
    } catch (error) { onError(error); }
  };
  return {
    dataBusy: data.busy,
    onFavorite: () => data.favorite([card]),
    onFilterTag,
    onRemoveTag: tagId => data.mutate({ kind: 'changeTags', ficheIds: [card.id], addLabels: [], addTagIds: [], removeTagIds: [tagId] }),
    onTags: event => {
      const trigger = event.currentTarget;
      setTagPopover(tagPopoverAt(trigger, (selectionTargets && data.targets.length > 1 ? data.targets : [card]).map(item => item.id)));
    },
    onCopyUuid: uuid => actions.copy('copyUuid', { ...card, uuids: [uuid] }),
    onExemplarAction: (exemplar, action, trigger) => {
      if (!action.enabled) return;
      actionFocus.current = trigger;
      if (action.id === 'reveal') void actions.reveal({ card, revision }, exemplar);
    },
    onTrashDone: notice => { onTrashSettled?.(); onAnnounce(notice); void onRefresh?.(); },
    onTrashFailed: error => onError(error),
    onEdit: (command, trigger) => open('edit', command, trigger),
    onSimulate: (command, trigger) => open('simulate', command, trigger),
  };
}
