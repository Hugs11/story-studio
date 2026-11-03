import { useTranslation, Trans } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// Retirer une option ne choisit jamais une autre destination à la place de
// l'auteur. Les transitions qui visaient cette occurrence perdent leur lien ;
// le moteur les signale ensuite comme raccords rompus.

import { AdvancedDialog } from './AdvancedDialog.jsx';
import { optionRemovalImpact } from '../../store/advancedAuthoring/authoringPlans.js';
import { advancedGestures, selectionResolution } from '../../store/projectModel/advancedGestures.js';

export function RemoveOptionDialog({ index, actionPath, ordinal, busy, onCancel, onConfirm }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const entry = index.byPath.get(actionPath);
  const impact = optionRemovalImpact(index, actionPath, ordinal);

  const confirm = () => {
    onConfirm(advancedGestures.removeActionOption(
      entry.node.id,
      ordinal,
      impact.decisions.map((row) => ({
        stageUuid: row.stageUuid,
        slot: row.slot,
        resolution: selectionResolution.removeAsAbsent(),
      })),
    ));
  };

  return (
    <AdvancedDialog
      title={t('graph:remove.option.title', { ordinal })}
      description={impact.decisions.length === 0
        ? t('graph:remove.option.empty')
        : t('graph:remove.option.impact', { count: impact.decisions.length })}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel={t('graph:remove.confirm.label')}
      confirmKind="danger"
      busy={busy}
    >
      {impact.decisions.length > 0 && (
        <ul className="advanced-decision-list">
          {impact.decisions.map((row) => (
            <li key={`${row.stagePath}#${row.slot}`} className="advanced-decision-list__row">
              <span className="advanced-decision-list__what">
                <Trans i18n={graphTranslationEngine()} t={t} i18nKey="graph:remove.reference.row" values={{ name: row.stageLabel, slot: row.slot === 'ok' ? t('graph:exit.ok.label') : t('graph:exit.home.label') }} components={{ strong: <strong /> }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </AdvancedDialog>
  );
}
