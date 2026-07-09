import { ChevronLeft, ChevronRight } from '../icons/LucideLocal';

/**
 * Pied de modale du châssis : bouton « Précédent » (secondaire,
 * désactivé à la 1re étape), libellé centré « Étape N / M », et CTA principal
 * orange à droite (« Continuer », ou un libellé/icône custom à la dernière
 * étape — p. ex. « Générer le pack »).
 *
 * Orange = seule action déclenchante (cf. convention funnel). Le « Précédent »
 * reste neutre.
 *
 * @param {Object}   props
 * @param {Function} props.onBack
 * @param {boolean}  [props.backDisabled=false]
 * @param {string}   [props.stepLabel]
 * @param {Function} props.onPrimary
 * @param {string}   [props.primaryLabel='Continuer']
 * @param {React.ReactNode} [props.primaryIcon]   Icône custom (défaut : chevron »).
 * @param {boolean}  [props.primaryDisabled=false]
 */
export function FunnelFooter({
  onBack,
  backDisabled = false,
  stepLabel,
  onPrimary,
  primaryLabel = 'Continuer',
  primaryIcon,
  primaryDisabled = false,
}) {
  return (
    <footer className="funnel-foot">
      <button
        type="button"
        className="funnel-btn funnel-btn-back"
        onClick={onBack}
        disabled={backDisabled}
      >
        <ChevronLeft strokeWidth={2.2} />
        Précédent
      </button>

      <span className="funnel-foot-label">{stepLabel}</span>

      <button
        type="button"
        className="funnel-btn funnel-btn-primary"
        onClick={onPrimary}
        disabled={primaryDisabled}
      >
        <span>{primaryLabel}</span>
        {primaryIcon ?? <ChevronRight strokeWidth={2.2} />}
      </button>
    </footer>
  );
}
