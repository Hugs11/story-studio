import { useEffect } from 'react';
import { Trans } from 'react-i18next';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { Button } from '../common/Button.jsx';
import { X } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';

const VISIBLE_MS = 10000;

/**
 * Message temporaire après l'ajout d'un dossier : « Dossier ajouté · Ajoutez-en
 * d'autres dans Préférences › Catalogue », le lien ouvre l'encart Catalogue des
 * Préférences. `stamp` change à chaque ajout et relance le délai.
 */
export function FolderAddedNotice({ stamp, onPreferences, onClose }) {
  const { t } = useCatalogueTranslation();
  useEffect(() => {
    if (!stamp) return undefined;
    const timer = setTimeout(onClose, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [stamp, onClose]);
  if (!stamp) return null;
  return <div className="catalogue-toast" role="status">
    <span className="catalogue-toast-text"><Trans i18nKey="catalogue:sources.addedHint.message" components={{ link: <button type="button" className="catalogue-toast-link" onClick={onPreferences} /> }} /></span>
    <Tooltip text={t('catalogue:data.close')} asChild wrap><Button variant="icon" size="sm" className="catalogue-toast-close" aria-label={t('catalogue:data.close')} onClick={onClose}><X width={14} height={14} /></Button></Tooltip>
  </div>;
}
