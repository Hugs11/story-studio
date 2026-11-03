import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { coverAddress } from '../../../store/catalogue/coverAddress.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';


/**
 * What follows the pointer during a drag (rendered inside the DragOverlay):
 * the dragged cards with the position they would take, or the stories being
 * reordered.
 */
export function LuniiDragGhost({ send, cardsById, active }) {
  const { t } = useCatalogueTranslation();
  const firstCard = send?.drag ? cardsById.get(send.drag.cardIds[0]) : null;
  const ghostCover = useDisplayableCover(firstCard ? coverAddress(firstCard.id, firstCard.coverSignature) : null);
  if (active?.kind === 'row') {
    const plan = active.repatriation;
    return <div className="lunii-drag-ghost" aria-hidden="true"><span>{active.count > 1 ? t('catalogue:lunii.dragCount', { count: active.count }) : active.title || t('catalogue:lunii.untitled')}</span>
      {plan?.refusal === 'write' ? <span className="lunii-drag-ghost-refused">{presentCatalogueError({ code: plan.writeCode, params: {} }).message}</span>
        : plan?.refusal ? <span className="lunii-drag-ghost-refused">{plan.refusal === 'official' ? t('catalogue:lunii.officialReason') : plan.refusal === 'present' ? t('catalogue:lunii.alreadyInCatalogue') : t('catalogue:lunii.orphanHelp')}</span>
          : plan && <span className="lunii-drag-ghost-position">{plan.eligible.length < plan.total ? t('catalogue:lunii.dropRepatriateSome', { count: plan.eligible.length, total: plan.total }) : t('catalogue:lunii.dropRepatriate')}</span>}
    </div>;
  }
  if (!send?.drag) return null;
  const count = send.drag.cardIds.length;
  const over = send.over;
  return <div className="lunii-drag-ghost" aria-hidden="true">
    {ghostCover && <img src={ghostCover} alt="" />}
    <span>{t('catalogue:lunii.dragCount', { count })}</span>
    {over?.refused ? <span className="lunii-drag-ghost-refused">{over.refused === 'damaged' ? presentCatalogueError(over.reason).message : t('catalogue:lunii.officialReason')}</span>
      : over && <span className="lunii-drag-ghost-position">{t('catalogue:lunii.dragPosition', { position: over.position })}</span>}
  </div>;
}
