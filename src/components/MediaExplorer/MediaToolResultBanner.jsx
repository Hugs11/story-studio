import { Button } from '../common/Button';

export function MediaToolResultBanner({
  result,
  unavailableReason = '',
  onFinish,
}) {
  if (!result) return null;
  const createdCount = result.createdPaths?.length ?? 0;
  const defaultMessage = createdCount === 1
    ? 'Le fichier créé est sélectionné dans Médias.'
    : `${createdCount} fichiers créés sont sélectionnés dans Médias.`;

  return (
    <div className="media-tool-result" role="status" aria-live="polite">
      <Button
        variant="icon"
        className="media-tool-result-close"
        onClick={onFinish}
        aria-label="Fermer la notification"
        title="Fermer"
      >×</Button>
      <div className="media-tool-result-copy">
        <strong>{result.projectApplied ? 'Projet mis à jour' : 'Fichiers créés dans Médias'}</strong>
        <span>{result.message || defaultMessage}</span>
        {unavailableReason ? (
          <small>{unavailableReason}{result.projectApplied ? '' : ' Les fichiers créés restent disponibles dans Médias.'}</small>
        ) : null}
      </div>
    </div>
  );
}
