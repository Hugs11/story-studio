import { useEffect } from 'react';
import { requalifiedMediaBindings } from '../store/projectWorkState';

// Le shell tient déjà l'audit disque de toutes les références médias, liaisons
// avancées comprises : c'est lui qui rend son dernier état connu à chaque
// liaison, après une sauvegarde comme après un retour de focus.
//
// La requalification passe hors historique — annuler une édition ne doit pas
// ramener un statut périmé — et hors signature de travail : un relevé de disque
// ne rend pas le projet non enregistré. Un projet Libre n'a aucune liaison, le
// hook n'y fait donc rien.
export function useAdvancedBindingAudit({
  project,
  syncProjectWithoutHistory,
  statusByPath,
  pending,
}) {
  useEffect(() => {
    if (pending) return;
    const requalified = requalifiedMediaBindings(project, statusByPath);
    if (requalified) syncProjectWithoutHistory(requalified);
  }, [pending, project, statusByPath, syncProjectWithoutHistory]);
}
