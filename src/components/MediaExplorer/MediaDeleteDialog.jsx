import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { isMediaHeldByProject } from '../../store/mediaLibrary';
import { translateMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

// Ce qu'on peut dire d'un média retenu par le projet, sans rien affirmer de
// plus que ce qui est su. Trois états : des écrans nommés, un inventaire non
// calculé, ou une liaison que le document ne cite plus.
function holdReason(item) {
  const labels = [...new Set((item.usages ?? []).map((usage) => usage.label).filter(Boolean))];
  if (labels.length > 0) return labels.slice(0, 3).join(', ');
  if (item.usageKnown === false) return translateMedia('media:delete.reason.unknown');
  if (item.projectUsedCount > 0) return translateMedia('media:delete.reason.count', { count: item.projectUsedCount });
  return translateMedia('media:delete.reason.bound');
}

export function MediaDeleteDialog({
  items,
  deleteDisk,
  canDeleteFromDisk,
  onDeleteDiskChange,
  onCancel,
  onConfirm,
}) {
  const { t } = useMediaTranslation();
  useEscapeKey(!!items?.length, onCancel);

  if (!items?.length) return null;

  const usedItems = items.filter(isMediaHeldByProject);
  const usedCount = usedItems.length;
  const actionLabel = deleteDisk ? t('media:delete.permanent.title') : t('media:delete.remove.action');

  return (
    // data-modal-surface : overlay à styles inline, reconnu par la garde des
    // raccourcis globaux (utils/modalSurfaces.js).
    <div data-modal-surface="" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="gen-modal" style={{ width: 380, maxWidth: '92vw' }}>
        <div className="gen-header">
          <span className="gen-title">
            {usedCount > 0
              ? (usedCount === 1 ? t('media:delete.used.single') : t('media:delete.used.count', { count: usedCount }))
              : (deleteDisk ? t('media:delete.permanent.title') : t('media:delete.library.title'))}
          </span>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {usedCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning-text)', lineHeight: 1.5 }}>
              {usedCount === 1
                ? t('media:delete.used.singleMessage')
                : t('media:delete.used.message', { count: usedCount })}
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {usedItems.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    {item.name} — {holdReason(item)}
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
                  <strong>{t('media:delete.library.title')}</strong><br />
                  <small>{t('media:delete.library.hint')}</small>
                </span>
              </label>
              {canDeleteFromDisk ? (
                <label className="media-delete-option" onClick={() => onDeleteDiskChange(true)}>
                  <input type="radio" readOnly checked={deleteDisk} />
                  <span>
                    <strong>{t('media:delete.disk.option')}</strong><br />
                    <small>{t('media:delete.disk.hint')}</small>
                  </span>
                </label>
              ) : (
                <div className="info-box">
                  {t('media:delete.disk.unavailable')}
                </div>
              )}
            </>
          )}
        </div>
        <div className="gen-footer">
          {usedCount > 0 ? (
            <Button type="button" onClick={onCancel}>{t('common:dialog.close.label')}</Button>
          ) : (
            <>
              <Button type="button" onClick={onCancel}>{t('common:dialog.cancel.label')}</Button>
              <Button type="button" variant="danger" onClick={onConfirm}>{actionLabel}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
