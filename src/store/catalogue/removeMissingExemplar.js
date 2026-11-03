/** Keep the revision captured before confirmation; later scans invalidate the request. */
export async function removeMissingExemplar({ card, exemplar, api, showChoiceDialog, t }) {
  const snapshot = await api.getCard(card.id);
  const confirmed = await showChoiceDialog({
    title: t('catalogue:actions.removeFromCatalogue.label'),
    message: t('catalogue:fiche.copies.remove.confirm'),
    actions: [
      { value: false, label: t('catalogue:sources.remove.cancel'), autoFocus: true },
      { value: true, label: t('catalogue:sources.remove.accept'), kind: 'danger' },
    ],
  });
  if (confirmed !== true) return false;
  await api.removeMissingExemplar(exemplar.id, snapshot.catalogueRevision);
  return true;
}
