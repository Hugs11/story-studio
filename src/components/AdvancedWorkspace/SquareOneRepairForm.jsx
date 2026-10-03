// Réparer un compte de racines faux.
//
// Ouvert seulement depuis « À corriger », quand le document a zéro ou plusieurs
// Écrans racines : un pack malformé s'ouvre dans le graphe, et le retrait d'une
// racine est refusé. Le graphe n'a pas de commande permanente de racine ; ce
// formulaire n'existe que le temps de l'erreur.
//
// Aucun Écran n'est proposé d'office : le choix de l'entrée du pack revient à
// l'auteur, même quand deux racines se disputent la place.

import { useState } from 'react';

import { Button } from '../common/Button';
import { STAGE_KIND } from '../../store/advancedGraphView/graphViewModel.js';
import { advancedGestures } from '../../store/projectModel/advancedGestures.js';
import { GESTURE_APPLIED } from '../../hooks/useAdvancedAuthoring.js';
import { NodePicker } from './NodePicker.jsx';

const PICKER_ID = 'advanced-square-one-repair';

export function SquareOneRepairForm({ index, disabled, onGesture, onClose }) {
  const [stagePath, setStagePath] = useState(null);
  const entry = stagePath ? index?.byPath.get(stagePath) ?? null : null;
  const chosen = entry?.kind === STAGE_KIND ? entry : null;

  const apply = async () => {
    if (!chosen || disabled) return;
    // Un seul geste : l'Écran choisi devient la racine, les autres cessent de
    // l'être. Une seule annulation le défait.
    const outcome = await onGesture(advancedGestures.setSquareOne(chosen.node.uuid));
    if (outcome?.status === GESTURE_APPLIED) onClose();
  };

  return (
    <div className="advanced-field__form" role="group" aria-label="Choisir l’Écran racine">
      <p className="advanced-field__note">
        Le pack doit avoir un seul Écran racine : c’est par lui que l’écoute commence.
        L’Écran choisi le devient, et les autres cessent de l’être.
      </p>
      <label htmlFor={PICKER_ID}>Écran racine</label>
      <NodePicker
        id={PICKER_ID}
        index={index}
        kind="stage"
        value={stagePath}
        onChange={setStagePath}
        disabled={disabled}
      />
      <div className="advanced-field__actions">
        <Button size="sm" variant="primary" disabled={!chosen || disabled} onClick={apply}>
          Définir comme racine
        </Button>
        <Button size="sm" onClick={onClose}>Annuler</Button>
      </div>
    </div>
  );
}
