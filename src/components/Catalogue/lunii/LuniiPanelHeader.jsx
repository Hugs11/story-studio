import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { useState } from 'react';
import { writeReason } from './LuniiStoryMenu.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { Info, Eject, PanelLeftClose, Lock } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { fieldPencil } from '../FieldPencil.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { LuniiQueuedCancel, queuedActionLabel } from './LuniiQueuedMark.jsx';

/** `device.unresponsive`: a write has given no sign of life for a minute (said, nothing stops).
 *  `queue`: operations waiting on this Lunii, `{ count, marks, onCancel }` (marks: name, repair, restored list). */
export function LuniiPanelHeader({ device, gestures, gauge = null, onCollapse, onEject, onCancelEject, queue = null }) {
  const { t, cell } = useCatalogueTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name ?? '');
  const reason = writeReason(device, t);
  const edit = () => { if (!reason) { setName(device.name ?? ''); setEditing(true); } };
  // Back on the pencil once the name editor closes, like a fiche field.
  const close = () => { setEditing(false); globalThis.requestAnimationFrame?.(() => document.getElementById('lunii-panel-rename')?.focus()); };
  const hidden = device.stories.filter(s => s.hidden).length;
  return <header className="lunii-header" data-lunii-drop="header" data-device-id={device.id}>
    <div className="lunii-header-top"><LuniiIcon width={18} height={11} />{editing ? <form onSubmit={event => { event.preventDefault(); void gestures?.rename(device, name); close(); }}><input autoFocus aria-label={t('catalogue:lunii.rename')} value={name} maxLength={80} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }} /><Button size="sm" type="submit" disabled={!!reason}>{t('catalogue:data.confirm')}</Button><Button size="sm" onClick={close}>{t('catalogue:data.cancel')}</Button></form>
      : <span className="lunii-header-name catalogue-fiche-editable"><h2 onDoubleClick={edit}>{device.name || t('catalogue:lunii.name')}</h2>{fieldPencil({ id: 'lunii-panel-rename', label: t('catalogue:lunii.rename'), tooltip: reason || t('catalogue:lunii.rename'), disabled: !!reason, onClick: edit })}</span>}
      <Tooltip text={t('catalogue:lunii.info', { serial: device.serial || t('catalogue:lunii.unknownValue'), firmware: device.firmware || t('catalogue:lunii.unknownValue') })} asChild wrap>
        <Button variant="icon" size="sm" aria-label={t('catalogue:lunii.info', { serial: device.serial || t('catalogue:lunii.unknownValue'), firmware: device.firmware || t('catalogue:lunii.unknownValue') })}><Info width={16} height={16} /></Button>
      </Tooltip>
      {/* Never a silent refusal: while writes run, ejecting asks what to do with them. */}
      {!['ejected', 'disconnected'].includes(device.state) && <Tooltip text={device.ejectPending ? t('catalogue:lunii.ejectQueue.pending') : device.busy ? t('catalogue:lunii.ejectQueue.ejectLater') : t('catalogue:lunii.eject')} wrap><Button size="sm" variant="icon" disabled={device.state === 'opening' || !!device.ejectPending} onClick={onEject} aria-label={t('catalogue:lunii.eject')}><Eject width={16} height={16} /></Button></Tooltip>}
      <Tooltip text={t('catalogue:lunii.collapse')} asChild wrap><Button size="sm" variant="icon" id="lunii-panel-collapse" onClick={onCollapse} aria-label={t('catalogue:lunii.collapse')}><PanelLeftClose width={16} height={16} /></Button></Tooltip>
    </div>
    {(device.state === 'readOnly' || device.banner?.includes('readOnly')) && <span className="lunii-readonly"><Lock width={12} height={12} />{device.family === 'flam' ? t('catalogue:lunii.flamReadOnlyTitle') : t('catalogue:lunii.readOnlyTitle')}</span>}
    {gauge ? <div className="lunii-gauge" role="img" aria-label={t('catalogue:lunii.capacity')}><span className="lunii-gauge-used" style={{ width: `${gauge.gauge.usedFraction * 100}%` }} /><span className={`lunii-gauge-added ${gauge.gauge.overflow ? 'is-overflow' : ''}`} style={{ width: `${Math.min(gauge.gauge.addedFraction, 1 - gauge.gauge.usedFraction) * 100}%` }} /></div>
      : device.totalBytes > 0 && <progress aria-label={t('catalogue:lunii.capacity')} max={device.totalBytes} value={device.freeBytes == null ? undefined : Math.max(0, device.totalBytes - device.freeBytes)} />}
    {gauge ? <div className="lunii-counters lunii-counters--drop" aria-live="polite">
      <span>{gauge.gauge.added > 0 || !gauge.gauge.unknown ? t('catalogue:lunii.dropAdds', { count: gauge.count, size: cell(bytesCell(gauge.gauge.added)) }) : t('catalogue:lunii.dropAddsUnknown', { count: gauge.count })}</span>
      {gauge.gauge.remaining != null && <span>{gauge.gauge.overflow ? t('catalogue:lunii.dropOverflow') : t('catalogue:lunii.dropRemains', { size: cell(bytesCell(gauge.gauge.remaining)) })}</span>}
    </div> : <div className="lunii-counters"><span>{t('catalogue:lunii.free', { size: cell(bytesCell(device.freeBytes)) })}</span><span>{t('catalogue:lunii.counts', { visible: device.stories.length - hidden, hidden })}</span></div>}
    {/* Present even when empty, so that a screen reader hears each new waiting gesture. */}
    <div className="lunii-queue-summary" role="status">{device.unresponsive && <span className="lunii-unresponsive">{t('catalogue:lunii.queue.unresponsive')}</span>}{queue?.count > 0 && <span>{t('catalogue:lunii.queue.count', { count: queue.count })}</span>}{device.ejectPending && <span id={`lunii-eject-pending-${device.id}`}>{t('catalogue:lunii.ejectQueue.pending')}</span>}{queue?.report && <span>{t('catalogue:lunii.queueReport.announce')}</span>}</div>
    {device.ejectPending && <div className="lunii-queued-device"><LuniiQueuedCancel label={t('catalogue:lunii.ejectQueue.cancelPending')} describedBy={`lunii-eject-pending-${device.id}`} onCancel={onCancelEject} /></div>}
    {(queue?.marks ?? []).map(mark => <div key={mark.entryId} className="lunii-queued-device">
      <small id={`lunii-queued-${mark.entryId}`}>{queuedActionLabel(t, mark.action, mark.name)}</small>
      <LuniiQueuedCancel label={t('catalogue:lunii.queue.cancelDevice')} describedBy={`lunii-queued-${mark.entryId}`} onCancel={() => queue.onCancel?.(mark.entryId)} />
    </div>)}
  </header>;
}
