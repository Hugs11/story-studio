// Retirer plusieurs nœuds d'un coup : la confirmation de Suppr sur une
// sélection, et de « Retirer… » au clic droit dans une sélection.
//
// Un seul nœud passe par `DeleteNodeDialog`, qui détaille chaque référence. À
// plusieurs, le geste est celui de Couper, sans le presse-papier : les nœuds
// partent ensemble, en **une** étape d'annulation, et ce qui les visait depuis
// le reste du graphe passe à « à raccorder » au lieu d'être recâblé en silence.
// La confirmation liste ce qui part et dit combien de raccords seront à
// reprendre ; elle ne retire jamais sans ce récapitulatif.

import { AdvancedDialog } from './AdvancedDialog.jsx';
import { selectionRemovalImpact } from '../../store/advancedAuthoring/authoringPlans.js';
import { STAGE_KIND } from '../../store/advancedGraphView/graphViewModel.js';
import { useShortcutLabels } from '../../store/ShortcutLabelsContext.js';

const ENTRY_NOT_REMOVABLE = 'L’Écran racine ne se retire pas : désignez d’abord un autre Écran racine.';

export function DeleteSelectionDialog({ index, paths, busy, onCancel, onConfirm }) {
  const labels = useShortcutLabels();
  const {
    entries, entryIncluded, loose, counted, gesture,
  } = selectionRemovalImpact(index, paths);

  const confirm = () => {
    if (gesture) onConfirm(gesture);
  };

  return (
    <AdvancedDialog
      title={`Retirer ${entries.length} éléments`}
      description={`${counted} seront retirés ensemble. ${labels.undo
        ? `${labels.undo} les rétablit en une fois.`
        : 'Annuler les rétablit en une fois.'}`}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel="Retirer"
      confirmKind="danger"
      confirmDisabled={!gesture}
      busy={busy}
    >
      <ul className="advanced-decision-list">
        {entries.map((entry) => (
          <li key={entry.path} className="advanced-decision-list__row">
            <span className="advanced-decision-list__what">
              <strong>{entry.label.label}</strong> — {entry.kind === STAGE_KIND ? 'Écran' : 'Liste de choix'}
            </span>
          </li>
        ))}
      </ul>
      {entryIncluded && (
        <p className="advanced-field__warning" role="alert">{ENTRY_NOT_REMOVABLE}</p>
      )}
      {!entryIncluded && loose > 0 && (
        <p className="advanced-field__note">
          {loose === 1
            ? 'Un raccord venu du reste du graphe visait cette sélection : il restera à raccorder, dans « À corriger ».'
            : `${loose} raccords venus du reste du graphe visaient cette sélection : ils resteront à raccorder, dans « À corriger ».`}
        </p>
      )}
    </AdvancedDialog>
  );
}
