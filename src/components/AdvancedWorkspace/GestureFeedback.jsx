import { useTranslation, Trans } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
import { UserMessage } from '../common/UserMessage.jsx';
// Ce qu'un geste a fait, et ce qu'un refus a empêché.
//
// Deux messages distincts, jamais confondus :
//
// - un **refus** laisse le projet précédent intact. Rien n'a été écrit, rien
//   n'est à défaire, et l'inventaire des références qui le motivent vient de
//   `GestureError.references` — jamais d'un découpage de la phrase française.
// - un **rapport** distingue les liens conservés, retirés et redirigés.

import { Button } from '../common/Button';
import { describeReferences } from '../../store/advancedAuthoring/authoringPlans.js';

function ReferenceList({ index, references }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const rows = describeReferences(index, references);
  if (rows.length === 0) return null;
  return (
    <ul className="advanced-feedback__references">
      {rows.map((row) => (
        <li key={row.optionId ?? row.path}>
          {row.unresolved
            ? <code>{row.path}</code>
            : <>{t('graph:feedback.reference.label', { name: row.actionLabel, ordinal: row.ordinal })}</>}
        </li>
      ))}
    </ul>
  );
}

export function RefusalNotice({ refusal, index, onDismiss }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  if (!refusal) return null;
  const error = refusal.error ?? {};
  return (
    <div className="advanced-feedback advanced-feedback--refusal" role="alert">
      <p className="advanced-feedback__head">
        <Trans i18n={graphTranslationEngine()} t={t} i18nKey="graph:feedback.refusal.head" values={{ code: error.code ?? t('graph:feedback.error.fallback') }} components={{ strong: <strong />, code: <code /> }} />
      </p>
      <div className="advanced-feedback__message"><UserMessage value={error} /></div>
      {error.path && <p className="advanced-feedback__path"><code>{error.path}</code></p>}
      <ReferenceList index={index} references={error.references ?? []} />
      <Button size="sm" onClick={onDismiss}>{t('common:dialog.close.label')}</Button>
    </div>
  );
}

// Une création ne s'annonce pas ici : le nœud créé — ou tout le collage — est
// déjà sélectionné et montré sur le graphe. Le rapport ne dit que ce qui ne se
// voit pas : les raccords et les médias touchés par le geste.
export function ReportNotice({ entry, onDismiss }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const report = entry?.report;
  if (!report) return null;

  const selections = report.references?.selections ?? [];
  const maintained = selections.filter((selection) => selection.decided === false);
  const decided = selections.filter((selection) => selection.decided === true);
  const removedLinks = decided.filter((selection) => selection.after == null);
  const redirected = decided.filter((selection) => selection.after != null);
  const stale = report.positions?.staleDecisions ?? [];
  const missing = report.media?.missing ?? [];
  const released = report.media?.released ?? [];

  const nothingWorthSaying = selections.length === 0
    && stale.length === 0
    && missing.length === 0
    && released.length === 0;
  if (nothingWorthSaying) return null;

  return (
    <div className="advanced-feedback advanced-feedback--report" role="status">
      {maintained.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.maintained.count', { count: maintained.length })}
        </p>
      )}
      {removedLinks.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.removed.count', { count: removedLinks.length })}
        </p>
      )}
      {redirected.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.redirected.count', { count: redirected.length })}
        </p>
      )}
      {stale.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.stale.count', { count: stale.length })}
        </p>
      )}
      {released.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.released.count', { count: released.length })}
        </p>
      )}
      {missing.length > 0 && (
        <p className="advanced-feedback__message">
          {t('graph:feedback.missing.count', { count: missing.length })}
        </p>
      )}
      <div className="advanced-feedback__actions">
        <Button size="sm" onClick={onDismiss}>{t('common:dialog.close.label')}</Button>
      </div>
    </div>
  );
}
