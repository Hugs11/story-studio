import { FavoriteStar } from '../FavoriteStar.jsx';
import { CoverImage } from './CoverImage.jsx';
import { OfflineBadge } from './OfflineBadge.jsx';
import { offlinePresentation } from '../../../store/catalogue/offlinePresentation.js';

/**
 * Jaquette d'une fiche avec ses repères en coin : étoile de favori (haut
 * droite, sauf `star={false}`) et badge « hors ligne » (bas gauche, jaquette grisée). Commun aux
 * vues Catalogue, Liste et Détails.
 */
export function CardCover({ card, size = 'large', view, tabIndex, star = true }) {
  const missing = offlinePresentation(card)?.reason === 'missing';
  return <div className={`catalogue-cover-frame catalogue-cover-frame--${size}${card.available ? '' : ' catalogue-cover-frame--offline'}${missing ? ' catalogue-cover-frame--missing' : ''}`}>
    <CoverImage ficheId={card.id} coverSignature={card.coverSignature} size={size} />
    <OfflineBadge card={card} compact={size === 'small'} />
    {star && <FavoriteStar favorite={card.favorite} busy={view.dataBusy} tabIndex={tabIndex} onChange={() => view.onFavorite?.(card)} />}
  </div>;
}
