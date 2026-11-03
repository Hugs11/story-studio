import { Button } from '../common/Button';
import { presentMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

export function MediaToolResultBanner({
  result,
  unavailableReason = '',
  onFinish,
}) {
  const { t } = useMediaTranslation();
  if (!result) return null;
  const createdCount = result.createdPaths?.length ?? 0;
  const defaultMessage = createdCount === 1
    ? t('media:toolResult.created.single')
    : t('media:toolResult.created.count', { count: createdCount });
  // Message et raison retenus comme descripteurs : résolus dans la langue active.
  const message = presentMedia(result.message);
  const reason = presentMedia(unavailableReason);

  return (
    <div className="media-tool-result" role="status" aria-live="polite">
      <Button
        variant="icon"
        className="media-tool-result-close"
        onClick={onFinish}
        aria-label={t('media:toolResult.close.ariaLabel')}
        title={t('common:dialog.close.label')}
      >×</Button>
      <div className="media-tool-result-copy">
        <strong>{result.projectApplied ? t('media:toolResult.project.applied') : t('media:toolResult.files.created')}</strong>
        <span>{message || defaultMessage}</span>
        {reason ? (
          <small>{reason}{result.projectApplied ? '' : ` ${t('media:toolResult.files.stillAvailable')}`}</small>
        ) : null}
      </div>
    </div>
  );
}
