/**
 * En-tête de section répété en haut de chaque étape de collecte :
 * pastille violette (icône), titre, description, et un slot optionnel à droite
 * (`trailing`) pour un badge « Pré-rempli » ou tout autre indicateur.
 *
 * @param {Object}   props
 * @param {React.ReactNode} props.icon
 * @param {string}   props.title
 * @param {React.ReactNode} [props.description]
 * @param {React.ReactNode} [props.trailing]
 */
export function FunnelSectionHeader({ icon, title, description, trailing }) {
  return (
    <div className="funnel-section-head">
      {icon ? <span className="funnel-section-icon" aria-hidden="true">{icon}</span> : null}
      <span className="funnel-section-text">
        <span className="funnel-section-title">{title}</span>
        {description ? <span className="funnel-section-desc">{description}</span> : null}
      </span>
      {trailing}
    </div>
  );
}
