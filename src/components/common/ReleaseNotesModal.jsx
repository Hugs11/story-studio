import { useCommonTranslation } from '../../i18n/commonPresentation.js';
import { getIntlLocale } from '../../i18n/language.js';
import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppModalPortal } from './AppModalPortal';
import { Button } from './Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { RELEASE_NOTES, shouldShowReleaseNotes } from '../../config/releaseNotes';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import './ReleaseNotesModal.css';

export function ReleaseNotesModal({ appVersion, forceOpen = false, onClose }) {
  const { t } = useCommonTranslation();
  const [open, setOpen] = useState(() => shouldShowReleaseNotes(appVersion, read(KEYS.RELEASE_NOTES_SEEN)));
  const [linkError, setLinkError] = useState('');
  const boxRef = useRef(null);
  const visible = open || forceOpen;
  function close() {
    write(KEYS.RELEASE_NOTES_SEEN, appVersion);
    setOpen(false);
    onClose?.();
  }
  useEscapeKey(visible, close);
  useEffect(() => {
    if (!visible) return undefined;
    const previous = document.activeElement;
    boxRef.current?.querySelector('.release-notes-start')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [visible]);
  async function openLink(event, url) {
    if (!isTauriRuntime()) return;
    event.preventDefault();
    try { await openUrl(url); } catch { setLinkError(true); }
  }
  if (!visible) return null;
  return (
    <AppModalPortal>
      <section
        ref={boxRef}
        className="modal-box release-notes-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const targets = boxRef.current.querySelectorAll('a, button');
          const first = targets[0];
          const last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <header className="release-notes-header">
          <span className="release-notes-eyebrow">
            STORY STUDIO · {appVersion} · <time dateTime={RELEASE_NOTES.date}>
              {new Date(RELEASE_NOTES.date).toLocaleDateString(getIntlLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
            </time>
          </span>
          <h2 id="release-notes-title">{t('common:releaseNotes.header.title', { version: appVersion })}</h2>
          <p>{t('common:releaseNotes.header.description')}</p>
        </header>
        <div className="release-notes-body">
          <section aria-label={t('common:releaseNotes.changes.ariaLabel')}>
            <h3>{t('common:releaseNotes.changes.title')}</h3>
            <ul className="release-notes-highlights">
              {[
                ...RELEASE_NOTES.highlights.map((entry) => ['new', ...entry]),
                ...RELEASE_NOTES.fixes.map((entry) => ['fix', ...entry]),
                ...RELEASE_NOTES.chores.map((entry) => ['chore', ...entry]),
              ].map(([kind, title, detail]) => (
                <li key={title}>
                  <span className={`release-notes-badge release-notes-badge--${kind}`}>{kind === 'new' ? t('common:releaseNotes.badge.new') : kind === 'fix' ? t('common:releaseNotes.badge.fix') : t('common:releaseNotes.badge.chore')}</span>
                  <div><strong>{t(title)}</strong>{detail && <>{' — '}<span>{t(detail)}</span></>}</div>
                </li>
              ))}
            </ul>
          </section>
          <div className="release-notes-links">
            <a href={RELEASE_NOTES.discordUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => openLink(event, RELEASE_NOTES.discordUrl)}>{t('common:releaseNotes.discord.label')}</a>
            <a href={RELEASE_NOTES.changelogUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => openLink(event, RELEASE_NOTES.changelogUrl)}>{t('common:releaseNotes.changelog.label')}</a>
          </div>
          {linkError && <p role="alert">{t('common:releaseNotes.link.error')}</p>}
        </div>
        <footer className="release-notes-footer">
          <span>{t('common:releaseNotes.footer.thanks')}</span>
          <Button variant="primary" className="release-notes-start" onClick={close}>{t('common:releaseNotes.start.label')}</Button>
        </footer>
      </section>
    </AppModalPortal>
  );
}
