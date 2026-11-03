import { Trans } from 'react-i18next';
import { useHelpTranslation, translateHelp } from '../../i18n/helpPresentation.js';
import { presentUserMessage } from '../../i18n/userMessage.js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppModalPortal } from './AppModalPortal';
import { Button } from './Button';
import { useErrorDialog } from './Dialog';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import './CreditsModal.css';

const DOCUMENTATION_URL = 'https://hugs11.github.io/story-studio/docs/';

/** Modale « À propos de Story Studio » (crédits). */
export function CreditsModal({ appVersion, onClose, onOpenReleaseNotes }) {
  const { t } = useHelpTranslation();
  const { showErrorDialog } = useErrorDialog();

  async function handleDocumentationClick(event) {
    // En développement web, laisser le lien HTTPS suivre son comportement natif.
    if (!isTauriRuntime()) return;
    event.preventDefault();
    try {
      await openUrl(DOCUMENTATION_URL);
    } catch (error) {
      showErrorDialog({
        get title() { return translateHelp('help:credits.documentation.errorTitle'); },
        get message() { return translateHelp('help:credits.documentation.errorMessage', { error: presentUserMessage(error, { allowLegacyFrench: false }).message }); },
        technicalDetail: presentUserMessage(error, { allowLegacyFrench: false }).technicalDetail,
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
          <span id="credits-modal-title">{t('help:credits.modal.title', { appName: 'Story Studio' })}</span>
          <Button variant="icon" className="modal-close" onClick={onClose} aria-label={t('common:dialog.close.label')}>✕</Button>
        </div>
        <div className="credits-body">
          <div className="credits-head">
            <span className="credits-name">Story Studio</span>
            {appVersion && <span className="credits-version">v{appVersion}</span>}
          </div>
          <div className="credits-line">
            {t('help:credits.origin.message', { name: 'Armand' })}
          </div>
          <div className="credits-line">
            {t('help:credits.creator.message', { creator: 'hugs11' })}
          </div>
          <div className="credits-actions">
            {onOpenReleaseNotes && <Button size="sm" onClick={onOpenReleaseNotes}>{t('common:releaseNotes.open.label')}</Button>}
            <a
              className="btn-xs credits-documentation-link"
              href={DOCUMENTATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleDocumentationClick}
            >
              {t('help:credits.documentation.label')}
            </a>
          </div>
          <div className="credits-line credits-thanks">
            {t('help:credits.thanks.title')}<br />
            <Trans t={t} i18nKey="help:credits.thanks.message" values={{
              marian: 'marian-m12l', jersou: 'Jersou', dantsu: 'Dantsu',
              daneel: 'o.Daneel', lucky: 'LuckyTheCookie', studio: 'STUdio', luniiQt: 'Lunii.QT',
            }} components={{
              marian: <strong />, jersou: <strong />, dantsu: <strong />,
              daneel: <strong />, lucky: <strong />,
            }} />
          </div>
        </div>
      </div>
    </AppModalPortal>
  );
}
