import { useTranslation } from 'react-i18next';
import { presentUserMessage } from '../../i18n/userMessage.js';

export function TechnicalDetail({ value }) {
  const { t } = useTranslation();
  return value ? <details>
    <summary>{t('common:error.technicalDetails.summary')}</summary>
    <pre>{value}</pre>
  </details> : null;
}

export function UserMessage({ value }) {
  const { t, i18n } = useTranslation();
  const presented = presentUserMessage(value, { t, language: i18n.resolvedLanguage ?? 'fr' });
  return <>
    {presented.message}
    {presented.fallback && presented.technicalDetail && <details>
      <summary>{t('common:error.technicalDetails.summary')}</summary>
      <pre>{presented.technicalDetail}</pre>
    </details>}
  </>;
}
