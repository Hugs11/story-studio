/**
 * Bouton-outil du châssis.
 *
 * Présentationnel : il ouvre, à la demande du funnel consommateur, un outil
 * existant de l'app (RecordModal, TextImageGenerator, AudioEditorModal,
 * ImageEditorModal…). Le châssis ne câble PAS ces modales — chaque funnel passe
 * le `onClick` adéquat. On factorise seulement l'apparence et l'accent.
 *
 * Accent (cf. convention funnel) :
 *  - `violet` (défaut) = outil annexe (découverte, secondaire).
 *  - `orange`          = l'outil EST l'action attendue de l'étape.
 *  - `neutral`         = bouton plein neutre (type « Réenregistrer »).
 *
 * @param {Object}   props
 * @param {React.ReactNode} props.icon
 * @param {'violet'|'orange'|'neutral'} [props.accent='violet']
 * @param {'solid'|'outline'} [props.variant='solid']  (ignoré pour `neutral`)
 * @param {boolean}  [props.block=false]   Pleine largeur (flex:1).
 * @param {Function} props.onClick
 * @param {boolean}  [props.disabled=false]
 */
export function FunnelToolButton({
  icon,
  accent = 'violet',
  variant = 'solid',
  block = false,
  onClick,
  disabled = false,
  children,
  ...rest
}) {
  const classes = [
    'funnel-tool-btn',
    `funnel-tool-btn--${accent}`,
    accent === 'neutral' ? '' : (variant === 'outline' ? 'is-outline' : 'is-solid'),
    block ? 'funnel-tool-btn--block' : '',
  ].filter(Boolean).join(' ');

  return (
    <button type="button" className={classes} onClick={onClick} disabled={disabled} {...rest}>
      {icon}
      {children}
    </button>
  );
}
