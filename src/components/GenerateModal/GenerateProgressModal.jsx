import { Loader2 } from '../icons/LucideLocal';
import { AppModalPortal } from '../common/AppModalPortal';
import './GenerateModal.css';

/**
 * Modale de progression bloquante (extraction de pack, import de fichiers).
 * `children` = lignes de détail (.gen-progress-name / -desc / -meta).
 */
export function GenerateProgressModal({ title, children }) {
  return (
    <AppModalPortal className="gen-overlay">
      <div className="gen-modal gen-progress-modal">
        <div className="gen-header">
          <span className="gen-title gen-title-icon">
            <Loader2 />
            {title}
          </span>
        </div>
        <div className="gen-progress-body">
          <div className="gen-spinner" />
          <div className="gen-progress-text">{children}</div>
        </div>
      </div>
    </AppModalPortal>
  );
}
