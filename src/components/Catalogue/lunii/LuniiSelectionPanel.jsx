import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { luniiStoryCover } from '../../../store/catalogue/luniiDeviceApi.js';
import { writeReason } from './LuniiStoryMenu.jsx';
import { repatriableStory } from '../../../store/catalogue/luniiRepatriate.js';
import { removalPending } from '../../../store/catalogue/luniiQueueView.js';
import { Button } from '../../common/Button.jsx';
import { X, Speaker } from '../../icons/LucideLocal.jsx';
import '../fiche/SelectionPanel.css';
import { Tooltip } from '../../common/Tooltip.jsx';

function SelectionCover({ address }) {
  const cover = useDisplayableCover(address);
  return cover ? <img src={cover} alt="" /> : <Speaker width={40} height={40} />;
}

export function LuniiSelectionPanel({ device, stories: selection, gestures, onClose, queued = new Map() }) {
  const { t, cell } = useCatalogueTranslation();
  // Stories whose removal already waits are left out of every gesture, and the panel says so.
  const leaving = selection.filter(s => removalPending(queued.get(s.key)));
  const stories = selection.filter(s => !leaving.includes(s));
  const reason = writeReason(device, t) || (stories.length ? null : t('catalogue:lunii.queue.removingReason'));
  const listed = stories.filter(s => !s.orphan);
  const eligible = listed.filter(repatriableStory);
  // Why some of the selection is left out: official stories, or stories the catalogue already holds.
  const leftOut = [listed.some(s => s.kind === 'official') && t('catalogue:lunii.officialReason'), listed.some(s => s.kind !== 'official' && s.catalogueFicheId) && t('catalogue:lunii.alreadyInCatalogue')].filter(Boolean).join(' ');
  const repatriateReason = !stories.length ? reason : eligible.length < stories.length && leftOut ? leftOut : writeReason(device, t, 'repatriateMany');
  return <div className="catalogue-fiche-content catalogue-selection-panel lunii-fiche" onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); if (stories.length) void gestures?.remove(device, stories, true); } }}>
    <header className="catalogue-selection-header"><h2 id="catalogue-fiche-title">{t('catalogue:fiche.panel.selected', { count: selection.length })}</h2><Button variant="icon" aria-label={t('catalogue:data.close')} onClick={onClose}><X width={16} height={16} /></Button></header>
    <div className="catalogue-selection-preview">{selection.slice(0, 4).map(story => <SelectionCover key={story.key} address={luniiStoryCover(story)} />)}</div>
    <p>{t('catalogue:lunii.selectionSize', { name: device.name || t('catalogue:lunii.name'), size: cell(bytesCell(selection.some(s => s.sizeBytes == null) ? null : selection.reduce((sum, s) => sum + s.sizeBytes, 0))) })}</p>
    {leaving.length > 0 && <p className="lunii-selection-queued">{t('catalogue:lunii.queue.selectionLeaving', { count: leaving.length })}</p>}
    <div className="catalogue-selection-panel-actions">
      <Tooltip text={reason} disabled={!reason} wrap><Button disabled={!!reason || listed.length !== stories.length} onClick={() => gestures?.hideMany(device, listed)}>{(listed.every(s => s.hidden) ? t('catalogue:lunii.showMany', { count: listed.length }) : t('catalogue:lunii.hideMany', { count: listed.length }))}</Button></Tooltip>
      <Tooltip text={repatriateReason} disabled={!repatriateReason} wrap><Button disabled={!eligible.length || !!writeReason(device, t, 'repatriateMany')} onClick={() => gestures?.repatriate(device, eligible)}>{eligible.length < stories.length ? t('catalogue:lunii.repatriateSome', { count: eligible.length, total: stories.length }) : t('catalogue:lunii.repatriate')}</Button></Tooltip>
      {/* Listed stories leave the list, orphans leave the Lunii: one confirmation names both. */}
      <Tooltip text={reason} disabled={!reason} wrap><Button className="lunii-remove" disabled={!!reason} onClick={() => gestures?.remove(device, stories, true)}>{listed.length ? t('catalogue:lunii.remove') : t('catalogue:lunii.delete')}</Button></Tooltip>
    </div>
  </div>;
}
