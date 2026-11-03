import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { luniiStoryCover } from '../../../store/catalogue/luniiDeviceApi.js';
import { writeReason } from './LuniiStoryMenu.jsx';
import { repatriableStory } from '../../../store/catalogue/luniiRepatriate.js';
import { Button } from '../../common/Button.jsx';
import { X, Speaker } from '../../icons/LucideLocal.jsx';
import '../fiche/SelectionPanel.css';
import { Tooltip } from '../../common/Tooltip.jsx';

function SelectionCover({ address }) {
  const cover = useDisplayableCover(address);
  return cover ? <img src={cover} alt="" /> : <Speaker width={40} height={40} />;
}

export function LuniiSelectionPanel({ device, stories, gestures, onClose }) {
  const { t, cell } = useCatalogueTranslation();
  const reason = writeReason(device, t);
  const listed = stories.filter(s => !s.orphan);
  const eligible = listed.filter(repatriableStory);
  // Why some of the selection is left out: official stories, or stories the catalogue already holds.
  const leftOut = [listed.some(s => s.kind === 'official') && t('catalogue:lunii.officialReason'), listed.some(s => s.kind !== 'official' && s.catalogueFicheId) && t('catalogue:lunii.alreadyInCatalogue')].filter(Boolean).join(' ');
  return <div className="catalogue-fiche-content catalogue-selection-panel lunii-fiche" onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); void gestures?.remove(device, stories, true); } }}>
    <header className="catalogue-selection-header"><h2 id="catalogue-fiche-title">{t('catalogue:fiche.panel.selected', { count: stories.length })}</h2><Button variant="icon" aria-label={t('catalogue:data.close')} onClick={onClose}><X width={16} height={16} /></Button></header>
    <div className="catalogue-selection-preview">{stories.slice(0, 4).map(story => <SelectionCover key={story.key} address={luniiStoryCover(story)} />)}</div>
    <p>{t('catalogue:lunii.selectionSize', { name: device.name || t('catalogue:lunii.name'), size: cell(bytesCell(stories.some(s => s.sizeBytes == null) ? null : stories.reduce((sum, s) => sum + s.sizeBytes, 0))) })}</p>
    <div className="catalogue-selection-panel-actions">
      <Tooltip text={reason} disabled={!reason} wrap><Button disabled={!!reason || listed.length !== stories.length} onClick={() => gestures?.hideMany(device, listed)}>{(listed.every(s => s.hidden) ? t('catalogue:lunii.showMany', { count: listed.length }) : t('catalogue:lunii.hideMany', { count: listed.length }))}</Button></Tooltip>
      <Tooltip text={eligible.length < stories.length && leftOut ? leftOut : writeReason(device, t, 'repatriateMany')} disabled={!(eligible.length < stories.length && leftOut ? leftOut : writeReason(device, t, 'repatriateMany'))} wrap><Button disabled={!eligible.length || !!writeReason(device, t, 'repatriateMany')} onClick={() => gestures?.repatriate(device, eligible)}>{eligible.length < stories.length ? t('catalogue:lunii.repatriateSome', { count: eligible.length, total: stories.length }) : t('catalogue:lunii.repatriate')}</Button></Tooltip>
      {/* Listed stories leave the list, orphans leave the Lunii: one confirmation names both. */}
      <Tooltip text={reason} disabled={!reason} wrap><Button className="lunii-remove" disabled={!!reason} onClick={() => gestures?.remove(device, stories, true)}>{listed.length ? t('catalogue:lunii.remove') : t('catalogue:lunii.delete')}</Button></Tooltip>
    </div>
  </div>;
}
