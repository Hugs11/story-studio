import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';

export function MediaDeleteDialog({
  items,
  deleteDisk,
  canDeleteFromDisk,
  onDeleteDiskChange,
  onCancel,
  onConfirm,
}) {
  useEscapeKey(!!items?.length, onCancel);

  if (!items?.length) return null;

  const usedItems = items.filter((item) => item.projectUsedCount > 0);
  const usedCount = usedItems.length;
  const actionLabel = deleteDisk ? 'Supprimer définitivement' : 'Retirer';

  return (
    // data-modal-surface : overlay à styles inline, reconnu par la garde des
    // raccourcis globaux (utils/modalSurfaces.js).
    <div data-modal-surface="" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="gen-modal" style={{ width: 380, maxWidth: '92vw' }}>
        <div className="gen-header">
          <span className="gen-title">
            {deleteDisk ? 'Supprimer définitivement' : 'Retirer de la médiathèque'}
          </span>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {usedCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning-text)', lineHeight: 1.5 }}>
              {usedCount === 1
                ? 'Ce fichier est encore utilisé dans le projet.'
                : `${usedCount} fichiers sont encore utilisés dans le projet.`}
              {' '}Retire d’abord leurs affectations depuis les réglages ou supprime les nœuds concernés.
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {usedItems.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    {item.name} — {[...new Set(item.usages.map((usage) => usage.label).filter(Boolean))].slice(0, 3).join(', ')
                      || `${item.projectUsedCount} usage${item.projectUsedCount > 1 ? 's' : ''}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {usedCount === 0 && (
            <>
              <label className="media-delete-option" onClick={() => onDeleteDiskChange(false)}>
                <input type="radio" readOnly checked={!deleteDisk} />
                <span>
                  <strong>Retirer de la médiathèque</strong><br />
                  <small>Le fichier reste sur le disque.</small>
                </span>
              </label>
              {canDeleteFromDisk ? (
                <label className="media-delete-option" onClick={() => onDeleteDiskChange(true)}>
                  <input type="radio" readOnly checked={deleteDisk} />
                  <span>
                    <strong>Supprimer définitivement du disque</strong><br />
                    <small>Cette action est irréversible.</small>
                  </span>
                </label>
              ) : (
                <div className="info-box">
                  La suppression disque est disponible uniquement pour les médias placés dans les dossiers gérés par Story Studio. Les fichiers externes peuvent seulement être retirés de la médiathèque.
                </div>
              )}
            </>
          )}
        </div>
        <div className="gen-footer">
          <Button type="button" onClick={onCancel}>Annuler</Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={usedCount > 0}>{actionLabel}</Button>
        </div>
      </div>
    </div>
  );
}
