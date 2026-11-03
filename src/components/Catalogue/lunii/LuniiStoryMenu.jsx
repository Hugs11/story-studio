import { useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { luniiWriteRefusal } from '../../../store/catalogue/luniiDevices.js';
import { MenuPopover, MenuItem } from '../../layout/MenuPopover.jsx';
import { Button } from '../../common/Button.jsx';
import { Ellipsis, Pencil, Download, Eye, Trash2 } from '../../icons/LucideLocal.jsx';

export function writeReason(device, t, method) {
  const code = luniiWriteRefusal(device, method);
  return code ? presentCatalogueError({ code, params: {} }).message : null;
}

/**
 * The actions of one Lunii story, as listed by the "…" menu of the inspector:
 * `{ key, Icon, label, enabled, detail, title, separatorBefore, run }`.
 * Repatriation is offered only for a story the catalogue does not hold yet.
 */
export function storyMenuEntries({ device, story, gestures, onName, t }) {
  const reason = writeReason(device, t);
  const repatriateReason = story.kind === 'official' ? t('catalogue:lunii.officialReason') : writeReason(device, t, 'repatriateMany');
  const entries = [];
  if (!story.orphan && story.kind === 'unknown') entries.push({ key: 'name', Icon: Pencil, label: t('catalogue:lunii.nameStory'), enabled: !reason, title: reason, run: onName });
  if (!story.orphan && !story.catalogueFicheId) entries.push({ key: 'repatriate', Icon: Download, label: t('catalogue:lunii.repatriate'), enabled: !repatriateReason, detail: repatriateReason, run: () => gestures?.repatriate(device, [story]) });
  if (!story.orphan) entries.push({ key: 'hide', Icon: Eye, label: story.hidden ? t('catalogue:lunii.show') : t('catalogue:lunii.hide'), enabled: !reason, title: reason, run: () => gestures?.hide(device, story) });
  if (story.orphan && story.complete && !story.duplicateOfListed) entries.push({ key: 'putBack', Icon: Eye, label: t('catalogue:lunii.putBack'), enabled: !reason, title: reason, run: () => gestures?.orphan(device, story) });
  entries.push({ key: 'remove', Icon: Trash2, label: story.orphan ? t('catalogue:lunii.delete') : t('catalogue:lunii.remove'), enabled: !reason, title: reason, separatorBefore: true, run: () => gestures?.remove(device, [story]) });
  return entries;
}

export function LuniiStoryMenu({ device, story, gestures, onName }) {
  const { t } = useCatalogueTranslation();
  const [open, setOpen] = useState(false);
  const run = action => { setOpen(false); action?.(); };
  return <MenuPopover open={open} onOpenChange={setOpen} activation="click" title={story.title || t('catalogue:lunii.untitled')} label={t('catalogue:lunii.menu')}
    trigger={({ openPopover }) => <Button size="sm" variant="icon" aria-haspopup="menu" aria-expanded={open} aria-label={t('catalogue:lunii.menu')} onClick={openPopover}><Ellipsis width={14} height={14} /></Button>}>
    {storyMenuEntries({ device, story, gestures, onName, t }).flatMap(entry => [
      entry.separatorBefore && <div key={`${entry.key}-separator`} role="separator" />,
      <MenuItem key={entry.key} Icon={entry.Icon} label={entry.label} disabled={!entry.enabled} detail={entry.detail} title={entry.title} onClick={() => run(entry.run)} />,
    ])}
  </MenuPopover>;
}
