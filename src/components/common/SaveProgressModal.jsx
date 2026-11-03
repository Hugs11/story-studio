import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { presentStoredError } from '../../i18n/userMessage.js';
import { Loader2 } from '../icons/LucideLocal';
import { AppModalPortal } from './AppModalPortal';
import './SaveProgressModal.css';

export function SaveProgressModal({ data, title, doneTitle }) {
  useMessageLanguage();
  return (
    <AppModalPortal>
      <div className="modal-box save-progress-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="save-progress-header">
            {data.complete ? (
              <>✓ {presentStoredError(doneTitle)}</>
            ) : (
              <>
                <Loader2 className="save-progress-spinner" /> {presentStoredError(title)}
              </>
            )}
          </span>
        </div>
        <div className="save-progress-body">
          {data.lines.map((line, i) => {
            const isLast = i === data.lines.length - 1;
            const done = !isLast || data.complete;
            return (
              <div key={i} className={`save-progress-line ${done ? 'is-done' : 'is-active'}`}>
                {done ? (
                  <span className="save-progress-check" aria-hidden="true">✓</span>
                ) : (
                  <span className="save-progress-bullet" aria-hidden="true" />
                )}
                <span className="save-progress-text">{presentStoredError(line)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </AppModalPortal>
  );
}
