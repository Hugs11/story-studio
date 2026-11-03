import { Trans, useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';

export function DiagnosticSection({
  className,
  sectionRef,
  verboseLogging,
  onVerboseLoggingChange,
  onCopyLogPath,
  onResolveLogPath,
}) {
  const { t } = useTranslation('settings');
  const [copiedLogPath, setCopiedLogPath] = useState(null);
  const [resolvedLogPath, setResolvedLogPath] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!onResolveLogPath) return undefined;
    onResolveLogPath().then((path) => {
      if (!cancelled && path) setResolvedLogPath(path);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [onResolveLogPath]);

  async function handleCopyLogPathClick() {
    if (!onCopyLogPath) return;
    const file = await onCopyLogPath();
    if (file) {
      setCopiedLogPath(file);
      setTimeout(() => setCopiedLogPath(null), 2200);
    }
  }

  return (
    <section id="diagnostic" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:diagnostic.section.title')}</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:diagnostic.verbose.label')}</div>
          <div className="opts-row-sub">{t('settings:diagnostic.verbose.description')}</div>
        </div>
        <Toggle on={!!verboseLogging} onChange={onVerboseLoggingChange} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:diagnostic.folder.label')}</div>
          <div className="opts-row-sub">
            {resolvedLogPath ? (
              <Trans i18nKey="settings:diagnostic.file.resolved" components={{ path: <code />, file: <code /> }} values={{ path: resolvedLogPath }} />
            ) : (
              <Trans i18nKey="settings:diagnostic.file.fallback" components={{ file: <code /> }} />
            )}
            {copiedLogPath ? (
              <span style={{ color: 'var(--accent-2-text)', marginLeft: 6 }}>{t('settings:diagnostic.copied.badge')}</span>
            ) : null}
          </div>
        </div>
        <Button onClick={handleCopyLogPathClick} disabled={!onCopyLogPath} style={{ flexShrink: 0 }}>{t('settings:diagnostic.copy.action')}</Button>
      </div>
      <div className="opts-help">{t('settings:diagnostic.privacy.description')}</div>
    </section>
  );
}
