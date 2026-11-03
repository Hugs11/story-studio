import { translateImport as t } from '../../i18n/importPresentation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { presentImportError } from './importErrorPresentation';

export function ImportErrorNotice({ error, context = 'open', role = 'alert' }) {
  useMessageLanguage();
  if (!error) return null;
  const presented = error?.message && Object.hasOwn(error, 'technicalDetail')
    ? error
    : presentImportError(error, context);
  return (
    <div className="funnel-error" role={role}>
      <div>{presented.message}</div>
      {presented.technicalDetail && (
        <details className="funnel-error-details">
          <summary>{t('common:error.technicalDetails.summary')}</summary>
          <pre>{presented.technicalDetail}</pre>
        </details>
      )}
    </div>
  );
}
