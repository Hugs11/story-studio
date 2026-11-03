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

import { ArrowRight } from '../icons/LucideLocal';
import { useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';
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
  const { t } = useCheckerTranslation();
  const groups = new Map();
  for (const issue of issues) {
    const key = issue.nodeLabel ? (issue.nodePath ?? issue.nodeLabel) : '__pack__';
    if (!groups.has(key)) {
      groups.set(key, { label: issue.nodeLabel ?? t('checker:issues.pack.group'), issues: [] });
    }
    groups.get(key).issues.push(issue);
  }

  return (
    <section aria-label={t('checker:issues.panel.aria')}>
      {[...groups].map(([key, group]) => (
        <div key={key} className="validation-pill-group">
          <div className="validation-pill-group-head">
            <span className="validation-pill-group-label">{group.label}</span>
            <span className="validation-pill-group-count">· {group.issues.length}</span>
          </div>
          {group.issues.map((issue) => {
            const resolutions = issue.diagnostic
              ? resolutionsForDiagnostic({ diagnostic: issue.diagnostic, view, index })
              : [];
            return (
              <details key={issue.id} className="validation-pill-details">
                <summary className="validation-pill-item">
                  <span className="validation-pill-item-dot" aria-hidden="true" />
                  <span className="validation-pill-item-label">{issue.message}</span>
                  <span className="validation-pill-item-go" aria-hidden="true">
                    <ArrowRight width={11} height={11} strokeWidth={2.6} />
                  </span>
                </summary>
                <div className="validation-pill-details-body">
                  <p className="validation-pill-details-category">{issue.category}</p>
                  <div className="validation-pill-details-actions">
                    {issue.nodePath && (
                      <Button size="sm" onClick={() => onFocusPath(issue.nodePath)}>
                        {t('checker:issues.fix.action')}
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
                </div>
              </details>
            );
          })}
        </div>
      ))}
      {issues.length === 0 && (
        <p className="validation-pill-empty">{t('checker:issues.empty')}</p>
      )}
    </section>
  );
}

// Ce popover commun réunit les diagnostics derrière « à corriger » et reste
// hors du triptyque Graphe / Inspecteur / liste des nœuds :
// diagnostics et refus restent une seule surface, sans recréer de
// bande basse.
export function AdvancedIssuesPanel({ context, onRequestClose }) {
  const { t } = useCheckerTranslation();
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
          {t('checker:issues.working.notice')}
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
