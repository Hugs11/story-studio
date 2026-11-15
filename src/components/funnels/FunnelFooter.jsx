import { useHomeTranslation } from '../../i18n/useHomeTranslation.js';
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
 * @param {Function} [props.onSecondary] Action secondaire optionnelle.
 * @param {string} [props.secondaryLabel]
 * @param {boolean} [props.secondaryDisabled=false]
 * @param {boolean}  [props.primaryDisabled=false]
 */
export function FunnelFooter({
  onBack,
  backDisabled = false,
  stepLabel,
  onPrimary,
  primaryLabel,
  primaryIcon,
  primaryDisabled = false,
  onSecondary,
  secondaryLabel,
  secondaryDisabled = false,
}) {
  const { t } = useHomeTranslation();
  return (
    <footer className="funnel-foot">
      <button
        type="button"
        className="funnel-btn funnel-btn-back"
        onClick={onBack}
        disabled={backDisabled}
      >
        <ChevronLeft strokeWidth={2.2} />{t('home:funnel.footer.back')}</button>

      <span className="funnel-foot-label">{stepLabel}</span>

      {onSecondary && (
        <button type="button" className="funnel-btn funnel-btn-back funnel-btn-secondary"
          onClick={onSecondary} disabled={secondaryDisabled}>
          {secondaryLabel}
        </button>
      )}

      <button
        type="button"
        className="funnel-btn funnel-btn-primary"
        onClick={onPrimary}
        disabled={primaryDisabled}
      >
        <span>{primaryLabel ?? t('home:funnel.footer.continue')}</span>
        {primaryIcon ?? <ChevronRight strokeWidth={2.2} />}
      </button>
    </footer>
  );
}
