import { openUrl } from '@tauri-apps/plugin-opener';
import { AppModalPortal } from './AppModalPortal';
import { Button } from './Button';
import { useErrorDialog } from './Dialog';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import './CreditsModal.css';

const DOCUMENTATION_URL = 'https://hugs11.github.io/story-studio/docs/';

/** Modale « À propos de Story Studio » (crédits). */
export function CreditsModal({ appVersion, onClose }) {
  const { showErrorDialog } = useErrorDialog();

  async function handleDocumentationClick(event) {
    // En développement web, laisser le lien HTTPS suivre son comportement natif.
    if (!isTauriRuntime()) return;
    event.preventDefault();
    try {
      await openUrl(DOCUMENTATION_URL);
    } catch (error) {
      showErrorDialog({
        title: 'Documentation inaccessible',
        message: `Impossible d’ouvrir la documentation dans le navigateur : ${error}`,
      });
    }
  }

  return (
    <AppModalPortal>
      <div
        className="modal-box credits-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credits-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span id="credits-modal-title">À propos de Story Studio</span>
          <Button variant="icon" className="modal-close" onClick={onClose} aria-label="Fermer">✕</Button>
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
          <section className="credits-help" aria-labelledby="credits-help-title">
            <span id="credits-help-title" className="credits-help-title">Aide</span>
            <a
              className="credits-documentation-link"
              href={DOCUMENTATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleDocumentationClick}
            >
              Documentation
            </a>
          </section>
          <div className="credits-line credits-thanks">
            Remerciements<br />
            <strong>Jersou</strong>, <strong>Dantsu</strong>, <strong>o.Daneel</strong> et{' '}
            <strong>LuckyTheCookie</strong>
          </div>
        </div>
      </div>
    </AppModalPortal>
  );
}
