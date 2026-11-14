import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { writeReason } from './LuniiStoryMenu.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { restorableOrphans } from '../../../store/catalogue/luniiDevices.js';
import { removalPending } from '../../../store/catalogue/luniiQueueView.js';
import { CircleAlert, History, Lock, TriangleAlert } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

/** `repairWaiting`: a repair of this Lunii is already queued or running. */
export function LuniiBanner({ kind, device, gestures, repairWaiting = false, marks = new Map() }) {
  const { t, cell } = useCatalogueTranslation();
  let Icon = CircleAlert, title, description, action, tone = 'danger';
  if (kind === 'damagedTruncated' || kind === 'damagedMissingStories' || kind === 'damaged') {
    title = t('catalogue:lunii.damagedTitle');
    description = kind === 'damagedTruncated' ? t('catalogue:lunii.damagedTruncated') : t('catalogue:lunii.damagedMissing');
    action = t('catalogue:lunii.repair');
  } else if (kind === 'resume') {
    Icon = History; tone = 'info'; title = t('catalogue:lunii.resumeTitle'); description = t('catalogue:lunii.resume'); action = t('catalogue:lunii.restore');
  } else if (kind === 'readOnly') {
    // The engine names the cause; the firmware version is never one.
    const reason = device.readOnlyReason ?? (![6, 7].includes(device.metadataVersion) || !device.firmware ? 'metadata' : null);
    if (reason === 'flam') {
      Icon = Lock; tone = 'neutral'; title = t('catalogue:lunii.flamReadOnlyTitle');
      description = device.playlistUnavailable ? t('catalogue:lunii.flamPlaylistUnavailable') : t('catalogue:lunii.flamReadOnly');
    } else if (reason === 'volume') {
      Icon = TriangleAlert; tone = 'warning'; title = t('catalogue:lunii.readOnlyVolumeTitle'); description = t('catalogue:lunii.readOnlyVolume');
    } else if (reason === 'unavailable') {
      Icon = TriangleAlert; tone = 'warning'; title = t('catalogue:lunii.readOnlyUnavailableTitle'); description = t('catalogue:lunii.readOnlyUnavailable');
    } else {
      Icon = Lock; tone = 'neutral'; title = t('catalogue:lunii.readOnlyTitle');
      description = reason === 'metadata' ? t('catalogue:lunii.readOnlyMetadata') : t('catalogue:lunii.readOnly');
    }
  } else if (kind === 'orphans') {
    // D42: an empty or shortened list that a D15 copy explains, or the general case.
    const available = stories => stories.filter(s => !removalPending(marks.get(s.key)));
    const candidates = restorableOrphans(device);
    const restorable = available(candidates);
    // D45: duplicate copies are identified on their rows, not counted as missing stories.
    const outside = device.orphans.filter(s => !s.duplicateOfListed);
    const complete = outside.filter(s => s.complete);
    const incomplete = outside.filter(s => !s.complete);
    const removable = available(incomplete);
    // Pending removals still occupy space; keep their total when no action target remains.
    const lost = device.listLost === true;
    const sizeOf = stories => cell(bytesCell(stories.some(s => s.sizeBytes == null) ? null : stories.reduce((sum, s) => sum + s.sizeBytes, 0)));
    const removingReason = t('catalogue:lunii.queue.removingReason');
    const reason = writeReason(device, t, 'restoreOrphans') || (restorable.length ? null : candidates.length ? removingReason : t('catalogue:lunii.restoreAllNone'));
    const removeReason = writeReason(device, t) || (removable.length ? null : removingReason);
    return <section className="lunii-banner lunii-banner--warning" role="status">
      {complete.length > 0 && <>
        <h3><TriangleAlert width={15} height={15} />{lost ? t('catalogue:lunii.lostListTitle') : t('catalogue:lunii.outsideTitle', { count: complete.length })}</h3>
        <p>{lost ? t('catalogue:lunii.lostList', { count: complete.length }) : t('catalogue:lunii.outside', { count: complete.length, size: sizeOf(complete) })}</p>
        <Tooltip text={reason} disabled={!reason} wrap><Button size="sm" variant="secondary" disabled={!!reason} onClick={() => gestures?.restoreOrphans(restorable.length === candidates.length ? device : { ...device, orphans: available(device.orphans) })}>{lost ? t('catalogue:lunii.restoreLost') : t('catalogue:lunii.putBack')}</Button></Tooltip>
      </>}
      {incomplete.length > 0 && <>
        <h3><TriangleAlert width={15} height={15} />{t('catalogue:lunii.interruptedLeftovers', { size: sizeOf(removable.length ? removable : incomplete) })}</h3>
        <Tooltip text={removeReason} disabled={!removeReason} wrap><Button size="sm" variant="secondary" disabled={!!removeReason} onClick={() => gestures?.remove(device, removable.map(story => ({ ...story, orphan: true })))}>{t('catalogue:lunii.delete')}</Button></Tooltip>
      </>}
    </section>;
  } else return null;
  // One repair at a time: a second one queued behind the first would only repeat it.
  const refusal = writeReason(device, t, tone === 'danger' ? 'repair' : 'restore') || (tone === 'danger' && repairWaiting ? t('catalogue:lunii.queue.repairWaiting') : null);
  return <section className={`lunii-banner lunii-banner--${tone}`} role="status">
    <h3><Icon width={15} height={15} />{title}</h3><p>{description}</p>
    {action && <Tooltip text={refusal || (device.repairPreviewError ? presentCatalogueError(device.repairPreviewError).message : undefined)} disabled={!(refusal || device.repairPreviewError)} wrap><Button size="sm" variant={tone === 'danger' ? 'primary-violet' : 'secondary'} disabled={!!refusal || (tone === 'danger' && !device.repairPreview)} onClick={() => tone === 'danger' ? gestures?.repair(device) : gestures?.restore(device)}>{action}</Button></Tooltip>}
  </section>;
}
