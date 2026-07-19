import { Button } from '../common/Button';

const ACTION_LABELS = {
  'use-as-item-audio': 'Utiliser comme titre audio',
  'replace-story-audio': 'Remplacer l’audio principal',
  'replace-story-with-parts': 'Remplacer l’histoire par les parties',
  'replace-stories-with-assembly': 'Remplacer les histoires par le résultat',
};

export function MediaToolResultBanner({
  result,
  projectActions = [],
  unavailableReason = '',
  busyAction = '',
  onProjectAction,
  onFinish,
}) {
  if (!result) return null;
  const createdCount = result.createdPaths?.length ?? 0;
  const contextual = !!result.request && !result.projectApplied;
  const defaultMessage = createdCount === 1
    ? 'Le fichier créé est sélectionné dans Médias.'
    : `${createdCount} fichiers créés sont sélectionnés dans Médias.`;

  return (
    <div className="media-tool-result" role="status" aria-live="polite">
      <div className="media-tool-result-copy">
        <strong>{result.projectApplied ? 'Projet mis à jour' : 'Fichiers créés dans Médias'}</strong>
        <span>{result.message || defaultMessage}</span>
        {contextual && unavailableReason ? (
          <small>{unavailableReason} Les fichiers créés restent disponibles dans Médias.</small>
        ) : null}
      </div>
      <div className="media-tool-result-actions">
        {projectActions.map((action) => (
          <Button
            key={action}
            variant="primary"
            disabled={!!busyAction}
            onClick={() => onProjectAction?.(action)}
          >
            {busyAction === action ? 'Application…' : ACTION_LABELS[action]}
          </Button>
        ))}
        <Button disabled={!!busyAction} onClick={onFinish}>
          {contextual ? 'Terminer sans modifier le projet' : 'Fermer'}
        </Button>
      </div>
    </div>
  );
}
