import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useReleaseConsent } from '../hooks/useReleaseConsent.js';
import { allowedReleaseUrl, checkReleaseOnce, claimReleaseNotice, shouldAskReleaseConsent, writeReleaseConsent } from '../store/releaseNotice.js';
import { ContentDialog } from './common/ContentDialog.jsx';
import { Button } from './common/Button';
import { NotificationToast } from './common/NotificationToast.jsx';

// Wait for the startup surfaces to settle. Observe all app dialogs, including
// portalled dialogs and native HTML <dialog>, rather than just one editor host.
export function waitForDialogSpace(onReady) {
  let timer = null;
  const hasDialog = () => Boolean(document.querySelector('[aria-modal="true"], dialog[open], .modal-overlay, .dialog-overlay'));
  const schedule = () => {
    if (hasDialog()) {
      clearTimeout(timer);
      timer = null;
    } else if (timer === null) {
      // Unrelated progress updates must not postpone the question indefinitely.
      timer = setTimeout(() => {
        timer = null;
        if (!hasDialog()) {
          observer.disconnect();
          onReady();
        }
      }, 1000);
    }
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
  schedule();
  return () => { observer.disconnect(); clearTimeout(timer); };
}

export function ReleaseNotice() {
  const { t } = useTranslation('settings');
  const consent = useReleaseConsent();
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (!shouldAskReleaseConsent(consent, false)) return;
    return waitForDialogSpace(() => setAsking(true));
  }, [consent]);
  useEffect(() => {
    if (consent !== true) return;
    let active = true;
    checkReleaseOnce(invoke).then(release => {
      if (active && claimReleaseNotice(release)) setNotice(release);
    });
    return () => { active = false; };
  }, [consent]);
  function answer(enabled) {
    setAsking(false);
    writeReleaseConsent(enabled);
  }
  return <>
    {asking && consent === null && <ContentDialog label={t('settings:releaseCheck.question.title')} onClose={() => answer(false)}>
      <div className="dialog-header"><h2>{t('settings:releaseCheck.question.title')}</h2></div>
      <div className="dialog-message" id="release-check-description" ref={node => {
        node?.closest('dialog')?.setAttribute('aria-describedby', 'release-check-description');
      }}>{t('settings:releaseCheck.description')}</div>
      <div className="dialog-actions">
        <Button id="release-check-decline" onClick={() => answer(false)}>{t('settings:releaseCheck.decline')}</Button>
        <Button variant="primary" onClick={() => answer(true)}>{t('settings:releaseCheck.accept')}</Button>
      </div>
    </ContentDialog>}
    <NotificationToast visible={Boolean(notice) && consent === true}
      title={t('settings:releaseCheck.notice', { version: notice?.version })}
      actionLabel={t('settings:releaseCheck.open')}
      onClose={() => setNotice(null)} onAction={() => {
        if (allowedReleaseUrl(notice?.url)) openUrl(notice.url).catch(() => {});
        setNotice(null);
      }} />
  </>;
}
