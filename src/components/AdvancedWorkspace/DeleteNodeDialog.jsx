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
  const entry = index.byPath.get(stagePath);
  const incoming = stageRemovalImpact(index, stagePath).occurrences;
  const destinationNotice = incoming.length === 1
    ? ' Un choix devra être remplacé dans la liste de choix concernée.'
    : ` ${incoming.length} choix devront être remplacés dans les listes de choix concernées.`;

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
      title={`Retirer l'Écran « ${entry.label.label} »`}
      description={`Cet Écran sera retiré.${incoming.length > 0
        ? `${destinationNotice} Les raccords depuis les autres Écrans resteront en place.`
        : ''}`}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel="Retirer"
      confirmKind="danger"
      busy={busy}
    >
      {incoming.length > 0 && (
        <ul className="advanced-decision-list">
          {incoming.map((row) => (
            <li key={row.optionId} className="advanced-decision-list__row">
              <span className="advanced-decision-list__what">
                <strong>{row.actionLabel}</strong> — destination {row.ordinal + 1}
              </span>
            </li>
          ))}
        </ul>
      )}
      {incoming.length > 0 && (
        <p className="advanced-field__note">
          Les destinations manquantes apparaîtront dans « À corriger ».
        </p>
      )}
    </AdvancedDialog>
  );
}

function DeleteActionBody({ index, actionPath, busy, onCancel, onConfirm }) {
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
      title={`Retirer la liste de choix « ${entry.label.label} »`}
      description={
        impact.transitions.length === 0
          ? "Cette liste de choix sera retirée."
          : `Cette liste de choix sera retirée. ${impact.transitions.length} raccord(s) vers elle seront coupés et signalés dans « À corriger ».`
      }
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel="Retirer"
      confirmKind="danger"
      busy={busy}
    >
      {impact.transitions.length > 0 && (
        <ul className="advanced-decision-list">
          {impact.transitions.map((row) => (
            <li key={`${row.stagePath}#${row.slot}`} className="advanced-decision-list__row">
              <span className="advanced-decision-list__what">
                <strong>{row.stageLabel}</strong> — {row.slot === 'ok' ? 'OK' : 'Accueil'}
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
