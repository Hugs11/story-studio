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
  const rows = describeReferences(index, references);
  if (rows.length === 0) return null;
  return (
    <ul className="advanced-feedback__references">
      {rows.map((row) => (
        <li key={row.optionId ?? row.path}>
          {row.unresolved
            ? <code>{row.path}</code>
            : <>{row.actionLabel} — choix {row.ordinal}</>}
        </li>
      ))}
    </ul>
  );
}

export function RefusalNotice({ refusal, index, onDismiss }) {
  if (!refusal) return null;
  const error = refusal.error ?? {};
  return (
    <div className="advanced-feedback advanced-feedback--refusal" role="alert">
      <p className="advanced-feedback__head">
        <strong>Geste refusé</strong>
        {' — '}
        <code>{error.code ?? 'ERREUR'}</code>
        {' '}
        Le projet est inchangé.
      </p>
      <p className="advanced-feedback__message">{error.message ?? String(refusal.error)}</p>
      {error.path && <p className="advanced-feedback__path"><code>{error.path}</code></p>}
      <ReferenceList index={index} references={error.references ?? []} />
      <Button size="sm" onClick={onDismiss}>Fermer</Button>
    </div>
  );
}

// Une création ne s'annonce pas ici : le nœud créé — ou tout le collage — est
// déjà sélectionné et montré sur le graphe. Le rapport ne dit que ce qui ne se
// voit pas : les raccords et les médias touchés par le geste.
export function ReportNotice({ entry, onDismiss }) {
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
          {maintained.length} transition(s) ont conservé leur destination.
        </p>
      )}
      {removedLinks.length > 0 && (
        <p className="advanced-feedback__message">
          {removedLinks.length} raccord(s) ont été retirés.
        </p>
      )}
      {redirected.length > 0 && (
        <p className="advanced-feedback__message">
          {redirected.length} raccord(s) ont changé de destination.
        </p>
      )}
      {stale.length > 0 && (
        <p className="advanced-feedback__message">
          {stale.length} décision(s) d'export deviennent périmées : elles restent enregistrées
          comme trace, elles ne s'appliquent plus à la valeur courante.
        </p>
      )}
      {released.length > 0 && (
        <p className="advanced-feedback__message">
          {released.length} référence(s) média ne sont plus utilisées par cet écran. Leur
          liaison reste enregistrée ; aucun fichier n'a été effacé.
        </p>
      )}
      {missing.length > 0 && (
        <p className="advanced-feedback__message">
          {missing.length} référence(s) média restent sans fichier résolu.
        </p>
      )}
      <div className="advanced-feedback__actions">
        <Button size="sm" onClick={onDismiss}>Fermer</Button>
      </div>
    </div>
  );
}
