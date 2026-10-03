import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppModalPortal } from './AppModalPortal';
import { Button } from './Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { KEYS, read, write } from '../../store/persistentSettings';
import { RELEASE_NOTES, shouldShowReleaseNotes } from '../../config/releaseNotes';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import './ReleaseNotesModal.css';

export function ReleaseNotesModal({ appVersion }) {
  const [open, setOpen] = useState(() => shouldShowReleaseNotes(appVersion, read(KEYS.RELEASE_NOTES_SEEN)));
  const [linkError, setLinkError] = useState('');
  const boxRef = useRef(null);
  function close() {
    write(KEYS.RELEASE_NOTES_SEEN, appVersion);
    setOpen(false);
  }
  useEscapeKey(open, close);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    boxRef.current?.querySelector('.release-notes-start')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
  async function openLink(event, url) {
    if (!isTauriRuntime()) return;
    event.preventDefault();
    try { await openUrl(url); } catch { setLinkError('Le lien n’a pas pu être ouvert. Réessaie dans un instant.'); }
  }
  if (!open) return null;
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
              {new Date(RELEASE_NOTES.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
            </time>
          </span>
          <h2 id="release-notes-title">Bienvenue dans la {appVersion}</h2>
          <p>De nouvelles façons de donner vie à tes histoires.</p>
        </header>
        <div className="release-notes-body">
          <section aria-label="Les nouveautés">
            <h3>Ce qui change</h3>
            <ul className="release-notes-highlights">
              {[
                ...RELEASE_NOTES.highlights.map((entry) => ['new', ...entry]),
                ...RELEASE_NOTES.fixes.map((entry) => ['fix', ...entry]),
                ...RELEASE_NOTES.chores.map((entry) => ['chore', ...entry]),
              ].map(([kind, title, detail]) => (
                <li key={title}>
                  <span className={`release-notes-badge release-notes-badge--${kind}`}>{kind.toUpperCase()}</span>
                  <div><strong>{title}</strong>{' — '}<span>{detail}</span></div>
                </li>
              ))}
            </ul>
          </section>
          <section className="release-notes-letter" aria-label="Un mot du créateur">
            <h3>Un mot de ma part</h3>
            {RELEASE_NOTES.message.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            <span className="release-notes-signature">— hugs11</span>
          </section>
          <div className="release-notes-links">
            <a href={RELEASE_NOTES.discordUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => openLink(event, RELEASE_NOTES.discordUrl)}>Rejoindre le Discord ↗</a>
            <a href={RELEASE_NOTES.changelogUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => openLink(event, RELEASE_NOTES.changelogUrl)}>Voir le changelog complet ↗</a>
          </div>
          {linkError && <p role="alert">{linkError}</p>}
        </div>
        <footer className="release-notes-footer">
          <span>Merci pour ton aide et tes retours.</span>
          <Button variant="primary" className="release-notes-start" onClick={close}>C’est parti !</Button>
        </footer>
      </section>
    </AppModalPortal>
  );
}
