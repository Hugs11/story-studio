import { TriangleAlert } from '../icons/LucideLocal';
import './ImportNoticeToast.css';

/** Bandeau d'avertissement ancré en bas (notice d'import). */
export function ImportNoticeToast({ message, onClose }) {
  return (
    <div className="import-notice">
      <span className="import-notice-text">
        <TriangleAlert className="import-notice-icon" />
        <span>{message}</span>
      </span>
      <button className="import-notice-close" onClick={onClose} title="Fermer">✕</button>
    </div>
  );
}
