// Ce qu'un travail **graphe** de la file de rendu a produit, ou ce qu'un refus a
// empêché.
//
// Le rapport commun — état, progression, chemin produit, problème — est peint
// par `ProductionReport` pour les deux natures. Ce composant est le détail que
// seule la chaîne graphe sait dire : refus typé avec ses médias manquants, ses
// collisions et ses désaccords. Après un succès, il n'ajoute que l'action de
// simulation propre au graphe ; le compte rendu reste celui des deux éditeurs.
//
// Il **vit avec le travail** : il se lit sur la carte du travail, qui survit à
// la fermeture du projet.
//
// Les quatre raccords vers l'éditeur graphe sont **facultatifs**, et c'est le
// point : quand le projet est fermé, la ligne reste consultable et seuls les
// gestes qui demandent un canvas disparaissent.

import { Button } from '../common/Button';
import { ExportRefusalReport } from '../AdvancedWorkspace/ExportReport.jsx';
import { EXPORT_REFUSAL } from '../../store/advancedExport/exportOutcome.js';
import { JOB_STATUS } from '../../store/production/renderQueueWork.js';

export function AdvancedJobReport({
  job,
  stagePaths = null,
  onFocusPath = null,
  onOpenDiagnostics = null,
  onReview = null,
}) {
  if (job.status === JOB_STATUS.DONE && job.result) {
    if (!onReview) return null;
    return (
      <div className="production-report__actions">
        <Button size="sm" variant="primary" onClick={() => onReview(job.result)}>
          Simuler le pack produit
        </Button>
      </div>
    );
  }
  // Une annulation n'a rien à ajouter à l'état « Production annulée ».
  if (job.refusal && job.refusal.kind !== EXPORT_REFUSAL.CANCELLED) {
    return (
      <ExportRefusalReport
        refusal={job.refusal}
        // Le titre et le message sont déjà dans le rapport commun.
        embedded
        stagePaths={stagePaths}
        onFocusPath={onFocusPath}
        onOpenDiagnostics={onOpenDiagnostics}
      />
    );
  }
  return null;
}
