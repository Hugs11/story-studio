import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { writeReason } from './LuniiStoryMenu.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { restorableOrphans } from '../../../store/catalogue/luniiDevices.js';
import { CircleAlert, History, Lock, TriangleAlert } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

export function LuniiBanner({ kind, device, gestures }) {
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
    if (reason === 'volume') {
      Icon = TriangleAlert; tone = 'warning'; title = t('catalogue:lunii.readOnlyVolumeTitle'); description = t('catalogue:lunii.readOnlyVolume');
    } else if (reason === 'unavailable') {
      Icon = TriangleAlert; tone = 'warning'; title = t('catalogue:lunii.readOnlyUnavailableTitle'); description = t('catalogue:lunii.readOnlyUnavailable');
    } else {
      Icon = Lock; tone = 'neutral'; title = t('catalogue:lunii.readOnlyTitle');
      description = reason === 'metadata' ? t('catalogue:lunii.readOnlyMetadata') : t('catalogue:lunii.readOnly');
    }
  } else if (kind === 'orphans') {
    // D42: an empty or shortened list that a D15 copy explains, or the general case.
    const restorable = restorableOrphans(device);
    // D45: duplicate copies are named on their rows, not counted as stories the child misses.
    const outside = device.orphans.filter(s => !s.duplicateOfListed);
    const lost = device.listLost === true;
    const size = cell(bytesCell(outside.some(s => s.sizeBytes == null) ? null : outside.reduce((sum, s) => sum + s.sizeBytes, 0)));
    const reason = writeReason(device, t, 'restoreOrphans') || (restorable.length ? null : t('catalogue:lunii.restoreAllNone'));
    return <section className="lunii-banner lunii-banner--warning" role="status">
      <h3><TriangleAlert width={15} height={15} />{lost ? t('catalogue:lunii.lostListTitle') : t('catalogue:lunii.outsideTitle', { count: outside.length })}</h3>
      <p>{lost ? t('catalogue:lunii.lostList', { count: restorable.length }) : t('catalogue:lunii.outside', { count: outside.length, size })}</p>
      <Tooltip text={reason} disabled={!reason} wrap><Button size="sm" variant="secondary" disabled={!!reason} onClick={() => gestures?.restoreOrphans(device)}>{lost ? t('catalogue:lunii.restoreLost') : t('catalogue:lunii.putBack')}</Button></Tooltip>
    </section>;
  } else return null;
  return <section className={`lunii-banner lunii-banner--${tone}`} role="status">
    <h3><Icon width={15} height={15} />{title}</h3><p>{description}</p>
    {action && <Tooltip text={writeReason(device, t, tone === 'danger' ? 'repair' : 'restore') || (device.repairPreviewError ? presentCatalogueError(device.repairPreviewError).message : undefined)} disabled={!(writeReason(device, t, tone === 'danger' ? 'repair' : 'restore') || device.repairPreviewError)} wrap><Button size="sm" variant={tone === 'danger' ? 'primary-violet' : 'secondary'} disabled={!!writeReason(device, t, tone === 'danger' ? 'repair' : 'restore') || (tone === 'danger' && !device.repairPreview)} onClick={() => tone === 'danger' ? gestures?.repair(device) : gestures?.restore(device)}>{action}</Button></Tooltip>}
  </section>;
}
