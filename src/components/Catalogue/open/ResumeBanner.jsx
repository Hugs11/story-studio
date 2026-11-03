import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { getIntlLocale } from '../../../i18n/language.js';
const formatRecentDate = value => Number.isFinite(value) ? new Date(value).toLocaleString(getIntlLocale()) : ''; 

/** La reprise la plus récente et sa phrase, partagées avec la pastille d'activité. */
export function latestRecovery(recoveries = []) {
  return [...recoveries].sort((a,b) => b.modifiedAtMs - a.modifiedAtMs)[0] ?? null;
}
export function recoveryMessage(t, recoveries, latest) {
  return t('catalogue:startup.resume.message', { count: recoveries.length, name: latest.projectName || t('catalogue:startup.resume.untitled'), date: formatRecentDate(latest.modifiedAtMs) });
}

export function ResumeBanner({ recoveries = [], onRecoverSession, onIgnoreSessionRecovery }) {
  const { t } = useCatalogueTranslation();
  const latest = latestRecovery(recoveries);
  if (!latest) return null;
  return <aside className="catalogue-notice" aria-label={t('catalogue:startup.resume.title')}>
    <p>{recoveryMessage(t, recoveries, latest)}</p>
    <button type="button" onClick={() => onRecoverSession?.(latest)}>{t('catalogue:startup.resume.action')}</button>
    <button type="button" onClick={() => onIgnoreSessionRecovery?.(latest)}>{t('catalogue:startup.resume.ignore')}</button>
  </aside>;
}
