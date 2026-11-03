import { useTranslation, Trans } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
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

const ENTRY_NOT_REMOVABLE = 'graph:remove.selection.entry';

export function DeleteSelectionDialog({ index, paths, busy, onCancel, onConfirm }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const labels = useShortcutLabels();
  const {
    entries, entryIncluded, loose, counted, gesture,
  } = selectionRemovalImpact(index, paths);

  const confirm = () => {
    if (gesture) onConfirm(gesture);
  };

  return (
    <AdvancedDialog
      title={t('graph:remove.selection.title', { count: entries.length })}
      description={t('graph:remove.selection.description', { selection: counted, undo: labels.undo || t('common:dialog.cancel.label') })}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel={t('graph:remove.confirm.label')}
      confirmKind="danger"
      confirmDisabled={!gesture}
      busy={busy}
    >
      <ul className="advanced-decision-list">
        {entries.map((entry) => (
          <li key={entry.path} className="advanced-decision-list__row">
            <span className="advanced-decision-list__what">
              <Trans i18n={graphTranslationEngine()} t={t} i18nKey="graph:remove.selection.row" values={{ name: entry.label.label, kind: entry.kind === STAGE_KIND ? t('graph:type.stage.label') : t('graph:type.action.label') }} components={{ strong: <strong /> }} />
            </span>
          </li>
        ))}
      </ul>
      {entryIncluded && (
        <p className="advanced-field__warning" role="alert">{t(ENTRY_NOT_REMOVABLE)}</p>
      )}
      {!entryIncluded && loose > 0 && (
        <p className="advanced-field__note">
          {t('graph:remove.selection.loose', { count: loose })}
        </p>
      )}
    </AdvancedDialog>
  );
}
