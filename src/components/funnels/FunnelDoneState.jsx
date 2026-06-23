import { Check } from '../icons/LucideLocal';

/**
 * Écran « Terminé » du châssis (plan 03) pour les funnels génératifs/outils.
 * Pastille succès + titre + nom de fichier (optionnel) + méta + zone d'actions.
 *
 * Les actions sont fournies par le funnel (`children`) : typiquement un bouton
 * secondaire « Ouvrir le dossier » (neutre) et un bouton orange « Terminer »
 * qui ferme le funnel et revient à l'accueil. On laisse le consommateur composer
 * pour ne pas figer la sortie.
 *
 * @param {Object}   props
 * @param {React.ReactNode} [props.icon]   Défaut : coche succès.
 * @param {string}   [props.title='Terminé']
 * @param {string}   [props.fileName]
 * @param {string}   [props.meta]
 * @param {React.ReactNode} props.children  Boutons d'action.
 */
export function FunnelDoneState({ icon, title = 'Terminé', fileName, meta, children }) {
  return (
    <div className="funnel-done">
      <div className="funnel-done-badge" aria-hidden="true">
        {icon ?? <Check strokeWidth={2.6} />}
      </div>
      <div className="funnel-done-title">{title}</div>
      {fileName ? <div className="funnel-done-file" title={fileName}>{fileName}</div> : null}
      {meta ? <div className="funnel-done-meta">{meta}</div> : null}
      {children ? <div className="funnel-done-actions">{children}</div> : null}
    </div>
  );
}
