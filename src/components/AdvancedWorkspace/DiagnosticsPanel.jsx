// Les diagnostics, et ce qu'on peut réellement en faire.
//
// Les trois familles restent **distinctes** : intégrité du graphe, décision
// d'auteur, import. Les fondre ferait
// passer un `UNTESTED` d'import pour un refus. Un diagnostic n'est pas non plus
// une erreur de génération : un projet diagnostiqué reste éditable et
// enregistrable.
//
// Cliquer révèle le nœud concerné. Une résolution n'est offerte que si elle
// mène à un geste ou à un formulaire réel — « pas de dialogue sans chemin de
// résolution réel ».

import { Button } from '../common/Button';
import {
  RESOLUTION_FORM,
  RESOLUTION_GESTURE,
  RESOLUTION_REVEAL,
  resolutionsForDiagnostic,
} from '../../store/advancedAuthoring/diagnosticResolutions.js';
import { ExportRefusalReport } from './ExportReport.jsx';
import { EXPORT_REFUSAL, PREPARATION_REFUSAL } from '../../store/advancedExport/exportOutcome.js';

export function DiagnosticsPanel({
  issues,
  view,
  index,
  disabled,
  onFocusPath,
  onGesture,
  onOpenForm,
}) {
  return (
    <section className="advanced-diagnostics advanced-diagnostics--popover" aria-label="Éléments à corriger">
      <ul className="advanced-diagnostics__list">
          {issues.map((issue) => {
            const diagnostic = issue.diagnostic;
            const resolutions = diagnostic
              ? resolutionsForDiagnostic({ diagnostic, view, index })
              : [];
            return (
              <li
                key={issue.id}
                className="advanced-diagnostics__item"
                data-severity="error"
              >
                <div className="advanced-diagnostics__head">
                  <strong>{issue.category}</strong>
                </div>
                {issue.nodeLabel && (
                  <p className="advanced-diagnostics__message"><strong>{issue.nodeLabel}</strong></p>
                )}
                <p className="advanced-diagnostics__message">{issue.message}</p>
                <div className="advanced-diagnostics__actions">
                  {issue.nodePath && (
                    <Button size="sm" onClick={() => onFocusPath(issue.nodePath)}>
                      Corriger
                    </Button>
                  )}
                  {resolutions.map((resolution) => (
                    <Button
                      key={resolution.id}
                      size="sm"
                      variant={resolution.destructive ? 'danger-outline' : 'secondary'}
                      disabled={disabled && resolution.nature === RESOLUTION_GESTURE}
                      onClick={() => {
                        if (resolution.nature === RESOLUTION_GESTURE) onGesture(resolution.gesture);
                        else if (resolution.nature === RESOLUTION_FORM) onOpenForm(resolution);
                        else if (resolution.nature === RESOLUTION_REVEAL) {
                          onFocusPath(resolution.paths?.[0] ?? issue.nodePath);
                        }
                      }}
                    >
                      {resolution.label}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
          {issues.length === 0 && (
            <li className="advanced-diagnostics__empty">Le pack peut être généré.</li>
          )}
      </ul>
    </section>
  );
}

// Ce popover commun réunit les diagnostics derrière « à corriger » et reste
// hors du triptyque Graphe / Inspecteur / liste des nœuds :
// filtres, qualification et refus restent une seule surface, sans recréer de
// bande basse.
export function AdvancedIssuesPanel({ context, onRequestClose }) {
  if (!context) return null;
  const focusAndClose = (path) => {
    context.onFocusPath?.(path);
    onRequestClose?.();
  };
  const openFormAndClose = (resolution) => {
    context.onOpenForm?.(resolution);
    onRequestClose?.();
  };
  const refusal = context.exportState?.refusal ?? null;
  const refusalAlreadyExplained = refusal?.kind === EXPORT_REFUSAL.PAYLOAD_DECODE
    || (refusal?.kind === EXPORT_REFUSAL.PREPARATION && [
      PREPARATION_REFUSAL.GRAPH_INTEGRITY,
      PREPARATION_REFUSAL.AUTHORING_ACTION_REQUIRED,
      PREPARATION_REFUSAL.READINESS_BLOCKED,
    ].includes(refusal?.preparationKind));

  return (
    <div className="advanced-issues-popover">
      <DiagnosticsPanel
        issues={context.blockingIssues ?? []}
        view={context.view}
        index={context.index}
        disabled={context.disabled}
        onFocusPath={focusAndClose}
        onGesture={context.onGesture}
        onOpenForm={openFormAndClose}
      />

      {context.working && (
        <p className="advanced-export__running" role="status">
          Fabrication en cours : l'édition est suspendue, la vue reste navigable.
        </p>
      )}

      {refusal && !refusalAlreadyExplained && (
        <ExportRefusalReport
          refusal={refusal}
          stagePaths={context.stagePaths}
          onFocusPath={focusAndClose}
          onDismiss={context.exportState.dismissRefusal}
        />
      )}
    </div>
  );
}
