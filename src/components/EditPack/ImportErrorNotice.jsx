import { presentImportError } from './importErrorPresentation';

export function ImportErrorNotice({ error, context = 'open', role = 'alert' }) {
  if (!error) return null;
  const presented = error?.message && Object.hasOwn(error, 'technicalDetail')
    ? error
    : presentImportError(error, context);
  return (
    <div className="funnel-error" role={role}>
      <div>{presented.message}</div>
      {presented.technicalDetail && (
        <details className="funnel-error-details">
          <summary>Détail technique</summary>
          <pre>{presented.technicalDetail}</pre>
        </details>
      )}
    </div>
  );
}
