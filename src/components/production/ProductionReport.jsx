// Le rapport de production, peint **une seule fois** pour les deux éditeurs.
//
// Ce composant ne connaît pas la file de rendu : il reçoit le rapport
// normalisé par `store/production/productionReport.js` et le rend. Ce qui est
// propre à une chaîne — notamment le refus typé du graphe avec ses médias
// manquants — reste rendu par les composants existants, passés en `details`.
//
// Le rapport est commun, les diagnostics gardent leur
// sens. Les fondre dans une liste unique aurait forcé à leur faire dire la même
// chose, et ils ne disent pas la même chose.

import { useEffect, useRef } from 'react';

import { Button } from '../common/Button';
import { PRODUCTION_STATUS } from '../../store/production/productionReport.js';
import './ProductionReport.css';

// Les trois contrôles d'archive, et ce qu'ils ont répondu.
//
// Une porte qui **refuse** et une porte qui **observe** ne sont pas peintes
// pareil, et la distinction est écrite en toutes lettres. Elle importe dans les
// deux sens : « Aurait refusé » sur un pack qui existe doit se lire « votre pack
// est là, c'est le contrôle qui s'évalue », et « Refusée » doit se lire « il n'y
// a pas de pack ».
function ProductionGates({ gates }) {
  if (gates.note) return <p className="production-report__note">{gates.note}</p>;
  if (gates.entries.length === 0) return null;

  return (
    <div className="production-report__gates">
      <p className="production-report__gates-title">
        Contrôles d'archive
        {gates.observing ? <span className="production-report__gates-mode"> — en observation</span> : null}
      </p>
      <ul className="production-report__gates-list">
        {gates.entries.map(gate => (
          <li key={gate.gate} className={`production-report__gate is-${gate.outcome}`}>
            <span className="production-report__gate-name">{gate.label}</span>
            <span className={`production-report__gate-verdict is-${gate.outcome}`}>
              {gate.outcomeLabel}
            </span>
            {gate.note ? <span className="production-report__gate-note">{gate.note}</span> : null}
            {gate.reasons.length > 0 ? (
              <ul className="production-report__gate-reasons">
                {gate.reasons.map((reason, index) => (
                  <li key={`${reason.code}-${reason.path}-${index}`}>
                    <code>{reason.code}</code> <span className="production-report__gate-path">{reason.path}</span>
                    {reason.message ? ` — ${reason.message}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {/* La production a eu lieu. Le dire sous la liste, et pas seulement dans
          un libellé de verdict, évite de faire lire un refus là où il n'y en a
          pas eu. */}
      {gates.notice ? <p className="production-report__note">{gates.notice}</p> : null}
    </div>
  );
}

function warningMessage(warning) {
  if (typeof warning === 'string') return warning;
  return String(warning?.message ?? warning ?? 'Avertissement');
}

function warningDetails(warning) {
  const measurements = [
    Number.isFinite(warning?.initialIntegratedLufs)
      ? `départ ${warning.initialIntegratedLufs.toFixed(1)} LUFS`
      : null,
    Number.isFinite(warning?.finalIntegratedLufs)
      ? `sortie ${warning.finalIntegratedLufs.toFixed(1)} LUFS`
      : null,
    Number.isFinite(warning?.gainDb)
      ? `gain ${warning.gainDb >= 0 ? '+' : ''}${warning.gainDb.toFixed(1)} dB`
      : null,
    Number.isFinite(warning?.expectedLimitingDb) && warning.expectedLimitingDb > 0
      ? `limitation ${warning.expectedLimitingDb.toFixed(1)} dB`
      : null,
  ].filter(Boolean);
  return measurements.join(' · ');
}

function ProductionWarnings({ warnings }) {
  if (warnings.length === 0) return null;
  return (
    <div className="production-report__warnings" role="status">
      <p className="production-report__warnings-title">
        Pack produit avec {warnings.length} avertissement{warnings.length > 1 ? 's' : ''}
      </p>
      {warnings.map((warning, index) => (
        <p className="production-report__warning" key={`${warning?.code ?? 'warning'}-${warning?.role ?? index}`}>
          <span>{warningMessage(warning)}</span>
          {warningDetails(warning) ? <small>{warningDetails(warning)}</small> : null}
        </p>
      ))}
      <p className="production-report__warning-advice">
        Le pack est utilisable ; ces points restent à vérifier.
      </p>
    </div>
  );
}

export function ProductionReport({
  report,
  onCancel = null,
  // Le détail propre à l'entrée : rendu **sous** le cadre commun, jamais à sa
  // place.
  details = null,
  // L'en-tête est parfois déjà porté par l'hôte (la carte d'un travail de la
  // file de rendu en a un). Le rapport ne le redouble pas.
  showHeading = true,
}) {
  // Le journal suit sa dernière ligne. Sans cela, l'auteur d'un gros pack voit
  // le début d'un travail qui avance : le suivi est la seule chose que la
  // progression apporte, et il est perdu dès la première page.
  const logRef = useRef(null);
  const lineCount = report?.progress.lines.length ?? 0;
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lineCount]);

  if (!report) return null;

  const { status, progress, cancel, result, problem, gates } = report;
  const hasProgress = progress.lines.length > 0;

  return (
    <section className={`production-report is-${status}`} aria-label="Rapport de production">
      {showHeading ? (
        <p className="production-report__status" role="status" aria-live="polite">
          <span className={`production-report__badge is-${status}`}>{report.statusLabel}</span>
          {cancel.requested ? <span className="production-report__hint">Annulation demandée…</span> : null}
        </p>
      ) : null}

      {hasProgress ? (
        <div className="production-report__progress">
          <p className="production-report__count">
            {progress.count} étape{progress.count > 1 ? 's' : ''} journalisée{progress.count > 1 ? 's' : ''}
          </p>
          <pre ref={logRef} className="production-report__log" aria-label="Journal de la production">
            {progress.lines.join('\n')}
          </pre>
          {progress.note ? <p className="production-report__note">{progress.note}</p> : null}
        </div>
      ) : null}

      {cancel.available && onCancel ? (
        <div className="production-report__actions">
          <Button size="sm" onClick={onCancel} disabled={cancel.requested}>
            Annuler la production
          </Button>
        </div>
      ) : null}

      {result ? (
        <div className="production-report__result">
          {result.zipPath ? (
            <p className="production-report__path" title={result.zipPath}>{result.zipPath}</p>
          ) : null}
          <ProductionWarnings warnings={result.warnings ?? []} />
          <ProductionGates gates={gates} />
        </div>
      ) : null}

      {problem ? (
        <div className="production-report__problem" role="alert">
          <p className="production-report__problem-title">{problem.title}</p>
          {problem.message ? <p className="production-report__problem-message">{problem.message}</p> : null}
        </div>
      ) : null}

      {status === PRODUCTION_STATUS.IDLE && !hasProgress ? (
        <p className="production-report__note">Aucune production lancée.</p>
      ) : null}

      {details}
    </section>
  );
}
