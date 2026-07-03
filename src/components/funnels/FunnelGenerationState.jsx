/**
 * Écran « Génération » du châssis (plan 03) pour les funnels génératifs/outils.
 * Spinner violet + liste de phases (à venir / en cours / faite) + barre de
 * progression. Stepper et pied sont masqués par le shell (`showChrome=false`).
 *
 * @param {Object}   props
 * @param {string}   [props.title='Génération…']
 * @param {string}   [props.hint='Ne ferme pas la fenêtre.']
 * @param {{label: string, status?: 'todo'|'active'|'done'}[]} [props.phases]
 * @param {number}   [props.progress]   0..1. Si fourni, affiche la barre + %.
 */
export function FunnelGenerationState({
  title = 'Génération…',
  hint = 'Ne ferme pas la fenêtre.',
  phases = [],
  progress = null,
}) {
  const pct = progress === null ? null : Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div className="funnel-process">
      <div className="funnel-spinner" aria-hidden="true" />
      <div className="funnel-process-title">{title}</div>
      <div className="funnel-process-hint">{hint}</div>

      {phases.length > 0 && (
        <div className="funnel-phases">
          {phases.map((phase, index) => {
            const status = phase.status ?? 'todo';
            return (
              <div className={`funnel-phase is-${status}`} key={phase.key ?? index}>
                <span className="funnel-phase-dot" aria-hidden="true">
                  {status === 'done' ? '✓' : status === 'active' ? '·' : ''}
                </span>
                <span className="funnel-phase-label">{phase.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {pct !== null && (
        <div className="funnel-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="funnel-progress-track">
            <div className="funnel-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="funnel-progress-pct">{pct}%</div>
        </div>
      )}
    </div>
  );
}
