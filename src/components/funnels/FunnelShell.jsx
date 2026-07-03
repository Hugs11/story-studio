import { AppModalPortal } from '../common/AppModalPortal';
import { X } from '../icons/LucideLocal';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './funnels.css';

/**
 * Coquille commune des funnels (plan 03) : overlay assombri/flouté
 * (`AppModalPortal`) + modale responsive avec en-tête (pastille violette, titre,
 * sous-titre, bouton fermer), un slot `stepper`, un corps scrollable et un slot
 * `footer`. Escape et × appellent `onClose`.
 *
 * Le shell n'impose aucune logique de navigation : il ne fait que poser la
 * structure. `stepper`/`footer` ne sont rendus que pendant la collecte
 * (les écrans Génération/Terminé les masquent — passer `showChrome={false}`).
 *
 * @param {Object}      props
 * @param {React.ReactNode} props.icon       Icône de l'en-tête (pastille violette).
 * @param {string}      props.title
 * @param {string}      [props.subtitle]
 * @param {Function}    props.onClose
 * @param {boolean}     [props.showChrome=true]  Affiche stepper + footer.
 * @param {boolean}     [props.fitContent=false] Modale a hauteur du contenu (pour
 *   un funnel mono-ecran) au lieu de la hauteur fixe du chassis.
 * @param {'default'|'wide'} [props.size='default'] Largeur/hauteur du chassis.
 * @param {React.ReactNode} [props.stepper]
 * @param {React.ReactNode} [props.footer]
 * @param {string}      [props.ariaLabel]
 */
export function FunnelShell({
  icon,
  title,
  subtitle,
  onClose,
  showChrome = true,
  fitContent = false,
  size = 'default',
  stepper,
  footer,
  ariaLabel,
  children,
}) {
  useEscapeKey(true, onClose);

  return (
    <AppModalPortal>
      <div
        className={`funnel-modal funnel-modal--${size}${fitContent ? ' funnel-modal--fit' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="funnel-head">
          {icon ? <span className="funnel-head-icon" aria-hidden="true">{icon}</span> : null}
          <span className="funnel-head-text">
            <span className="funnel-head-title">{title}</span>
            {subtitle ? <span className="funnel-head-subtitle">{subtitle}</span> : null}
          </span>
          <button type="button" className="funnel-icon-btn" aria-label="Fermer" onClick={onClose}>
            <X />
          </button>
        </header>

        {showChrome && stepper ? stepper : null}

        <div className="funnel-body">{children}</div>

        {showChrome && footer ? footer : null}
      </div>
    </AppModalPortal>
  );
}
