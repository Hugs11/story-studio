import { AppModalPortal } from './AppModalPortal';
import './CreditsModal.css';

/** Modale « À propos de Story Studio » (crédits). */
export function CreditsModal({ appVersion, onClose }) {
  return (
    <AppModalPortal>
      <div className="modal-box credits-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>À propos de Story Studio</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="credits-body">
          <div className="credits-head">
            <span className="credits-name">Story Studio</span>
            {appVersion && <span className="credits-version">v{appVersion}</span>}
          </div>
          <div className="credits-line">
            Né d'une envie simple : créer des histoires pour Armand.
          </div>
          <div className="credits-line">
            Créé par hugs11, assisté de Claude-code et Codex
          </div>
          <div className="credits-line credits-thanks">
            Grâce au travail de<br />
            <strong>Jersou</strong>, <strong>Dantsu</strong>, <strong>o.Daneel</strong> et{' '}
            <strong>LuckyTheCookie</strong>
          </div>
        </div>
      </div>
    </AppModalPortal>
  );
}
