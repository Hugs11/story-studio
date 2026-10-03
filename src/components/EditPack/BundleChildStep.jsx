import { FunnelSectionHeader, FunnelToolButton } from '../funnels';
import { Layers, Undo2 } from '../icons/LucideLocal';
import {
  canContinueWithChild,
  describeChildVerdict,
  formatChildSize,
  isChildSelectable,
} from './bundleChildren';
import { ImportErrorNotice } from './ImportErrorNotice';

/**
 * L'écran de choix d'une archive enveloppe : la liste des packs qu'elle
 * contient, une sélection unique, puis la suite du parcours d'import normal.
 *
 * Aucune vignette, aucune métadonnée enrichie : les afficher imposerait
 * d'extraire les médias de chaque pack de l'enveloppe pour dresser une liste.
 *
 * @param {Object}   props
 * @param {string}   props.containerLabel  Nom de l'archive enveloppe.
 * @param {Array}    props.packs           Enfants inspectés, verdict compris.
 * @param {string?}  props.selectedChildId
 * @param {Function} props.onSelect
 * @param {Function} props.onContinue
 * @param {Function} props.onBack          Retour à la zone de dépôt.
 * @param {string}   [props.error]
 */
export function BundleChildStep({
  containerLabel,
  packs,
  selectedChildId,
  onSelect,
  onContinue,
  onBack,
  error = '',
}) {
  const count = packs?.length ?? 0;
  const canContinue = canContinueWithChild(packs, selectedChildId);

  return (
    <div className="funnel-step-content">
      <FunnelSectionHeader
        icon={<Layers />}
        title="Cette archive contient plusieurs packs"
        description={`${containerLabel} — ${count} pack${count > 1 ? 's' : ''}. Choisis celui à ouvrir ; la suite se passe comme pour n'importe quel pack.`}
      />

      <ul className="bundle-child-list" role="radiogroup" aria-label="Packs de l'archive">
        {(packs ?? []).map((child) => {
          const selectable = isChildSelectable(child);
          const verdict = describeChildVerdict(child);
          const selected = child.childId === selectedChildId;
          return (
            <li key={child.childId}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className={`bundle-child${selected ? ' is-selected' : ''}`}
                disabled={!selectable}
                onClick={() => onSelect(child.childId)}
              >
                <span className="bundle-child-name">{child.displayName}</span>
                <span className="bundle-child-size">{formatChildSize(child.sizeBytes)}</span>
                <span className={`bundle-child-verdict is-${verdict.status}`}>{verdict.label}</span>
                {verdict.reason && (
                  <span className="bundle-child-reason" title={verdict.technicalDetail}>{verdict.reason}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <ImportErrorNotice error={error} />

      <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
        <FunnelToolButton
          icon={<Layers />}
          accent="violet"
          variant="solid"
          disabled={!canContinue}
          onClick={onContinue}
        >
          Continuer
        </FunnelToolButton>
        <FunnelToolButton icon={<Undo2 />} accent="neutral" onClick={onBack}>
          Choisir une autre archive
        </FunnelToolButton>
      </div>
    </div>
  );
}
