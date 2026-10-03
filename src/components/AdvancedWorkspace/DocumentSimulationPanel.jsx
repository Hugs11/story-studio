// La simulation du document en cours, dans l'espace de travail avancé.
//
// C'est **le simulateur du dépôt**, pas une seconde implémentation : le même
// `FlatSimulator`, la même navigation, le même tirage d'option. Seule sa source
// change — le document en cours au lieu d'une archive produite.

import { FloatingSimulator } from '../FloatingSimulator/FloatingSimulator';
import { EDITOR_LAYOUT_SCOPE } from '../../store/persistentSettings.js';

export function DocumentSimulationPanel({ simulation, onActiveNodeChange = null, onClose }) {
  if (!simulation) return null;
  return (
    <FloatingSimulator
      documentGraph={simulation.graph}
      documentStartId={simulation.startId}
      onActiveNodeChange={onActiveNodeChange}
      hostSelector=".workspace"
      layoutScope={EDITOR_LAYOUT_SCOPE.ADVANCED}
      onClose={onClose}
    />
  );
}
