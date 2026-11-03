import { presentStoredError } from '../../i18n/userMessage.js';
import { useTranslation } from 'react-i18next';
import { Button } from './Button.jsx';
import { TriangleAlert, Info } from '../icons/LucideLocal';
import './ImportNoticeToast.css';

/** Bandeau d'avertissement ancré en bas (notice d'import). */
export function ImportNoticeToast({ message, onClose, inline = false, actionLabel, onAction }) {
  const { t } = useTranslation();
  return (
    <div className={`import-notice${inline ? ' import-notice--inline' : ''}`} role={inline ? 'status' : undefined}>
      <span className="import-notice-text">
        {inline ? <Info className="import-notice-icon" /> : <TriangleAlert className="import-notice-icon" />}
        <span>{presentStoredError(message)}</span>
      </span>
      {onAction && <Button size="sm" onClick={onAction}>{actionLabel}</Button>}
      <button type="button" aria-label={inline ? t('common:dialog.close.label') : undefined} className="import-notice-close" onClick={onClose} title={t('common:dialog.close.label')}>✕</button>
    </div>
  );
}
