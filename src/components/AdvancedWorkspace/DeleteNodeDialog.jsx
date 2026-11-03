import { useTranslation, Trans } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// Retirer un nœud en conservant les raccords que le geste ne vise pas.
// Une Action qui menait à un Écran supprimé garde sa place de destination,
// signalée comme à compléter. Annuler ne touche pas au projet.

import { AdvancedDialog } from './AdvancedDialog.jsx';
import {
  advancedGestures,
  optionResolution,
  presence,
} from '../../store/projectModel/advancedGestures.js';
import {
  actionRemovalImpact,
  stageRemovalImpact,
} from '../../store/advancedAuthoring/authoringPlans.js';

function DeleteStageBody({ index, stagePath, busy, onCancel, onConfirm }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const entry = index.byPath.get(stagePath);
  const incoming = stageRemovalImpact(index, stagePath).occurrences;

  const confirm = () => {
    const plan = advancedGestures.stageRemovalPlan({
      options: incoming.map((row) => ({
        actionId: row.actionId,
        ordinal: row.ordinal,
        resolution: optionResolution.null(),
      })),
    });
    onConfirm(advancedGestures.deleteStage(
      entry.node.uuid,
      incoming.length === 0 ? null : plan,
    ));
  };

  return (
    <AdvancedDialog
      title={t('graph:remove.stage.title', { name: entry.label.label })}
      description={incoming.length > 0 ? t('graph:remove.stage.impact', { count: incoming.length }) : t('graph:remove.stage.empty')}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel={t('graph:remove.confirm.label')}
      confirmKind="danger"
      busy={busy}
    >
      {incoming.length > 0 && (
        <ul className="advanced-decision-list">
          {incoming.map((row) => (
            <li key={row.optionId} className="advanced-decision-list__row">
              <span className="advanced-decision-list__what">
                <Trans i18n={graphTranslationEngine()} t={t} i18nKey="graph:remove.stage.references" values={{ name: row.actionLabel, ordinal: row.ordinal + 1 }} components={{ strong: <strong /> }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {incoming.length > 0 && (
        <p className="advanced-field__note">{t('graph:remove.stage.missing')}</p>
      )}
    </AdvancedDialog>
  );
}

function DeleteActionBody({ index, actionPath, busy, onCancel, onConfirm }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const entry = index.byPath.get(actionPath);
  const impact = actionRemovalImpact(index, actionPath);

  const confirm = () => {
    const plan = advancedGestures.actionRemovalPlan(impact.transitions.map((row) => ({
      stageUuid: row.stageUuid,
      slot: row.slot,
      update: presence.absent(),
    })));
    onConfirm(advancedGestures.deleteAction(
      entry.node.id,
      impact.transitions.length === 0 ? null : plan,
    ));
  };

  return (
    <AdvancedDialog
      title={t('graph:remove.action.title', { name: entry.label.label })}
      description={
        impact.transitions.length === 0
          ? t('graph:remove.action.empty')
          : t('graph:remove.action.impact', { count: impact.transitions.length })
      }
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel={t('graph:remove.confirm.label')}
      confirmKind="danger"
      busy={busy}
    >
      {impact.transitions.length > 0 && (
        <ul className="advanced-decision-list">
          {impact.transitions.map((row) => (
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

export function DeleteNodeDialog({ index, kind, path, busy, onCancel, onConfirm }) {
  return kind === 'stage'
    ? <DeleteStageBody index={index} stagePath={path} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
    : <DeleteActionBody index={index} actionPath={path} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />;
}
