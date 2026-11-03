import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { LuniiStoryMenu, writeReason } from './LuniiStoryMenu.jsx';
import { LuniiSelectionPanel } from './LuniiSelectionPanel.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell, durationCell, ageCell } from '../../../store/catalogue/detailsRow.js';
import { luniiStoryCover } from '../../../store/catalogue/luniiDeviceApi.js';
import { Speaker, ArrowUp, ArrowDown, X, Download, Eye, EyeOff, Info } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

export function LuniiFiche({ device, story, rows, onNavigate, onClose, gestures, selected = [story] }) {
  const { t, cell } = useCatalogueTranslation();
  const index = rows.findIndex(s => s.key === story.key);
  const cover = useDisplayableCover(luniiStoryCover(story));
  const reason = writeReason(device, t);
  if (selected.length > 1) return <LuniiSelectionPanel device={device} stories={selected} gestures={gestures} onClose={onClose} />;
  return <div className="catalogue-fiche-content lunii-fiche" onKeyDown={event => {
    if (event.target.closest('input, textarea, [role="menu"]')) return;
    if (event.key === 'Delete') { event.preventDefault(); void gestures?.remove(device, selected, true); return; }
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta && !event.altKey && !event.ctrlKey && !event.metaKey && rows[index + delta]) { event.preventDefault(); onNavigate(delta); }
  }}>
    <header className="lunii-fiche-bar"><LuniiIcon width={16} height={16} /><span>{t('catalogue:lunii.onDevice', { position: index + 1, total: rows.length })}</span>
      <Button variant="icon" size="sm" aria-label={t('catalogue:lunii.previous')} disabled={index <= 0} onClick={() => onNavigate(-1)}><ArrowUp width={15} height={15} /></Button>
      <Button variant="icon" size="sm" aria-label={t('catalogue:lunii.next')} disabled={index >= rows.length - 1} onClick={() => onNavigate(1)}><ArrowDown width={15} height={15} /></Button>
      <LuniiStoryMenu device={device} story={story} gestures={gestures} onName={() => document.getElementById('lunii-story-name')?.focus()} />
      <Button variant="icon" size="sm" aria-label={t('catalogue:data.close')} onClick={onClose}><X width={16} height={16} /></Button>
    </header>
    <div className="lunii-fiche-cover">{cover ? <img src={cover} alt="" /> : <Speaker width={48} height={48} />}</div>
    {story.kind === 'unknown' && !story.orphan ? <form aria-labelledby="catalogue-fiche-title" key={story.key} onSubmit={event => { event.preventDefault(); void gestures?.name(device, story, event.currentTarget.elements.title.value); }}><label id="catalogue-fiche-title" htmlFor="lunii-story-name">{t('catalogue:lunii.nameStory')}</label><Tooltip text={reason} disabled={!reason} wrap><input id="lunii-story-name" name="title" aria-label={t('catalogue:lunii.nameStory')} defaultValue={story.title ?? ''} placeholder={t('catalogue:lunii.nameStory')} maxLength={80} disabled={!!reason} /></Tooltip><Button type="submit" disabled={!!reason}>{t('catalogue:data.confirm')}</Button></form> : <h2 id="catalogue-fiche-title">{story.title || t('catalogue:lunii.untitled')}</h2>}
    {story.age && <p className="catalogue-card-age">{cell(ageCell(story.age))}</p>}
    <p className="lunii-fiche-meta">{(story.kind === 'official' ? t('catalogue:lunii.official') : t('catalogue:lunii.creation'))}{story.durationSec != null && <span>{cell(durationCell(story.durationSec))}</span>}</p>
    <div className="lunii-fiche-actions">{!story.orphan && !story.catalogueFicheId && <Tooltip text={story.kind === 'official' ? t('catalogue:lunii.officialReason') : writeReason(device, t, 'repatriateMany')} disabled={!(story.kind === 'official' || writeReason(device, t, 'repatriateMany'))} wrap><Button disabled={story.kind === 'official' || !!writeReason(device, t, 'repatriateMany')} onClick={() => gestures?.repatriate(device, [story])}><Download width={15} height={15} />{t('catalogue:lunii.repatriate')}</Button></Tooltip>}
      <Tooltip text={reason || (story.hidden ? t('catalogue:lunii.showHelp') : t('catalogue:lunii.hideHelp'))} wrap><Button disabled={!!reason || story.orphan} onClick={() => gestures?.hide(device, story)}>{story.hidden ? <Eye width={15} height={15} /> : <EyeOff width={15} height={15} />}{story.hidden ? t('catalogue:lunii.show') : t('catalogue:lunii.hide')}</Button></Tooltip></div>
    {story.kind !== 'official' && !story.catalogueFicheId && <p className="lunii-fiche-note"><Info width={15} height={15} />{t('catalogue:lunii.notInCatalogue')}</p>}
    <dl className="lunii-fiche-info"><dt>{t('catalogue:lunii.position')}</dt><dd>{story.position ?? (story.orphan ? (story.duplicateOfListed ? t('catalogue:lunii.duplicateCopyHelp') : t('catalogue:lunii.orphanHelp')) : t('catalogue:lunii.hidden'))}</dd>
      <dt>{t('catalogue:lunii.size')}</dt><dd>{cell(bytesCell(story.sizeBytes))}</dd>
      <dt>{t('catalogue:lunii.sentAt')}</dt><dd>{story.sentAt ? cell({ kind: 'date', value: story.sentAt * 1000 }) : t('catalogue:lunii.unknownValue')}</dd>
      <dt>{t('catalogue:lunii.author')}</dt><dd>{story.author || t('catalogue:lunii.unknownValue')}</dd></dl>
    <Tooltip text={reason} disabled={!reason} wrap><Button disabled={!!reason} className="lunii-remove" onClick={() => gestures?.remove(device, [story])}>{story.orphan ? t('catalogue:lunii.delete') : t('catalogue:lunii.remove')}</Button></Tooltip>
  </div>;
}
