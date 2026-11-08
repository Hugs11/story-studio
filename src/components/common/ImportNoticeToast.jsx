import { presentStoredError } from '../../i18n/userMessage.js';
import { useTranslation } from 'react-i18next';
import { Button } from './Button.jsx';
import { Info } from '../icons/LucideLocal';
import './ImportNoticeToast.css';

/** Annonce d'information dans le flux de l'accueil. */
export function ImportNoticeToast({ message, onClose, actionLabel, onAction }) {
  const { t } = useTranslation();
  return (
    <div className="import-notice import-notice--inline" role="status">
      <span className="import-notice-text">
        <Info className="import-notice-icon" />
        <span>{presentStoredError(message)}</span>
      </span>
      {onAction && <Button size="sm" onClick={onAction}>{actionLabel}</Button>}
      <button type="button" aria-label={t('common:dialog.close.label')} className="import-notice-close" onClick={onClose} title={t('common:dialog.close.label')}>✕</button>
    </div>
  );
}
