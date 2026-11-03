import { BadgeCheck } from '../../icons/LucideLocal.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';

/**
 * Pastille « Officielle » d'une fiche officielle (forme de la pastille « Introuvable ») ; l'infobulle dit pourquoi elle ne part pas sur la Lunii.
 */
export function OfficialBadge({ card }) {
  const { t } = useCatalogueTranslation();
  if (card?.official !== true) return null;
  return <Tooltip asChild wrap text={t('catalogue:lunii.officialTagHelp')}>
    <span className="catalogue-official-tag" data-official="true">
      <BadgeCheck width={11} height={11} aria-hidden="true" />{t('catalogue:lunii.officialTag')}
    </span>
  </Tooltip>;
}
