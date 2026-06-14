import { Button } from '../common/Button';

export function MediaDeleteDialog({
  items,
  deleteDisk,
  onDeleteDiskChange,
  onCancel,
  onConfirm,
}) {
  if (!items?.length) return null;

  const usedCount = items.filter((item) => item.projectUsedCount > 0).length;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="gen-modal" style={{ width: 380, maxWidth: '92vw' }}>
        <div className="gen-header">
          <span className="gen-title">Supprimer {items.length > 1 ? `${items.length} fichiers` : '1 fichier'}</span>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {usedCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning-text)', lineHeight: 1.5 }}>
              {usedCount === 1
                ? '1 fichier est utilisé dans le projet'
                : `${usedCount} fichiers sont utilisés dans le projet`}
              {' '}— les liens correspondants seront supprimés.
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={deleteDisk} onChange={(e) => onDeleteDiskChange(e.target.checked)} />
            Supprimer aussi du disque
          </label>
        </div>
        <div className="gen-footer">
          <Button type="button" onClick={onCancel}>Annuler</Button>
          <Button type="button" onClick={onConfirm} style={{ background: 'oklch(0.50 0.18 20)', color: '#fff', border: 'none' }}>Supprimer</Button>
        </div>
      </div>
    </div>
  );
}
