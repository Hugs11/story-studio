// Composant de ligne de mesure (UI). Les helpers purs (formatteurs, lignes de
// mesure, predicats) vivent dans ./packCheckerFormat et sont re-exportes ici
// pour les consommateurs JSX.

import { CircleCheck, X } from '../icons/LucideLocal';

export * from './packCheckerFormat';

export function Measure({ label, value, status = 'ok' }) {
  const StatusIcon = status === 'bad' ? X : CircleCheck;
  return (
    <div className={`checker-measure checker-measure--${status}`}>
      <span>
        <StatusIcon className="checker-measure-icon" aria-hidden="true" />
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
