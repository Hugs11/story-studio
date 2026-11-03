import { FileX, WifiOff } from '../../icons/LucideLocal.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { offlinePresentation } from '../../../store/catalogue/offlinePresentation.js';

/**
 * Badge hors ligne : neutre pour un disque débranché, warning pour un fichier
 * introuvable ; l'infobulle garde le motif et l'emplacement. Les petites vues restent compactes.
 */
export function OfflineBadge({ card, compact = true }) {
  const { t } = useCatalogueTranslation();
  const offline = offlinePresentation(card);
  if (!offline) return null;
  const path = offline.paths.join(', ');
  const missing = offline.reason === 'missing';
  const label = missing ? t('catalogue:offline.missing.label') : t('catalogue:offline.unavailable.label');
  const detail = missing
    ? (path ? t('catalogue:offline.missing.help', { path }) : '')
    : [path, t('catalogue:offline.unavailable.help')].filter(Boolean).join(' ');
  const Icon = missing ? FileX : WifiOff;
  return <Tooltip asChild wrap text={detail ? `${label} — ${detail}` : label}>
    <span className={`catalogue-offline-badge${missing ? ' catalogue-offline-badge--missing' : ''}`} role="img" aria-label={detail ? `${label}. ${detail}` : label} tabIndex={-1}>
      <Icon width={14} height={14} />
      {missing && !compact && <span>{t('catalogue:offline.missing.badge')}</span>}
    </span>
  </Tooltip>;
}
