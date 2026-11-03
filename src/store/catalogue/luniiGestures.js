import { bytesCell } from './detailsRow.js';
import { presentCatalogueCell } from '../../i18n/cataloguePresentation.js';
import { reorderedKeys, steppedKeys, luniiWriteRefusal, restorableOrphans } from './luniiDevices.js';
import { repatriableStory } from './luniiRepatriate.js';

export function createLuniiGestures(lunii, t, confirm, setAnnouncement) {
  async function commitOrder(device, keys, order) {
    if (order.every((key, i) => key === device.stories[i].key)) return;
    const result = await lunii.store.mutate(device.id, 'reorder', [order], keys);
    if (result) {
      const story = device.stories.find(s => keys.includes(s.key));
      // Displayed numbers count visible stories only; a hidden story gets the rank it will show at.
      const visible = order.filter(key => !device.stories.find(s => s.key === key)?.hidden);
      const position = order.slice(0, order.indexOf(story.key)).filter(key => visible.includes(key)).length + 1;
      setAnnouncement(t('catalogue:lunii.moved', { title: story.title || t('catalogue:lunii.untitled'), position, total: visible.length }));
    }
  }
  return {
    async remove(device, stories, force = false) {
      if (!stories.length || luniiWriteRefusal(device, 'remove')) return;
      const listed = stories.filter(s => !s.orphan);
      const orphans = stories.filter(s => s.orphan);
      if (force || stories.length > 1 || stories.some(s => s.kind === 'official' || s.orphan)) {
        const named = list => list.map(s => s.title || t('catalogue:lunii.untitled')).join(', ');
        const official = listed.filter(s => s.kind === 'official');
        const count = listed.filter(s => s.kind !== 'official' && !s.catalogueFicheId).length;
        const size = presentCatalogueCell(bytesCell(orphans.some(s => s.sizeBytes == null) ? null : orphans.reduce((sum, s) => sum + s.sizeBytes, 0)));
        const params = { titles: named(listed), count, officialTitles: named(official), orphanTitles: named(orphans), size };
        let title, message;
        if (!listed.length && orphans.length === 1) {
          title = t('catalogue:lunii.deleteTitle', { title: named(orphans) });
          message = t('catalogue:lunii.deleteHelp', { size });
        } else if (!listed.length) {
          title = t('catalogue:lunii.deleteManyTitle', { count: orphans.length });
          message = t('catalogue:lunii.deleteManyHelp', { titles: named(orphans), size });
        } else if (orphans.length) {
          // One confirmation for both effects: off the child's list, and off the Lunii.
          title = t('catalogue:lunii.removeDeleteTitle', { count: stories.length });
          message = official.length ? t('catalogue:lunii.removeDeleteMixedHelp', params) : t('catalogue:lunii.removeDeleteHelp', params);
        } else {
          title = t('catalogue:lunii.removeTitle', { count: stories.length });
          message = official.length ? t('catalogue:lunii.removeMixedHelp', params) : t('catalogue:lunii.removeHelp', params);
        }
        if (await confirm(title, message, listed.length ? t('catalogue:lunii.remove') : t('catalogue:lunii.delete')) !== true) return;
      }
      // Listed stories first, in one write; then each orphan. A failure stops the gesture.
      if (listed.length && !await lunii.store.mutate(device.id, 'remove', [listed.map(s => s.key)], listed.map(s => s.key))) return;
      for (const story of orphans) {
        if (!await lunii.store.mutate(device.id, 'orphan', [{ deviceId: device.id, key: story.key, restore: false }], [story.key])) return;
      }
    },
    async repair(device) {
      const preview = device.repairPreview;
      if (!preview || luniiWriteRefusal(device, 'repair')) return;
      const message = preview.empty ? t('catalogue:lunii.repairEmpty') : t('catalogue:lunii.repairHelp', { kept: preview.kept, removed: preview.removed.length + (preview.truncated ? 1 : 0) });
      if (await confirm(t('catalogue:lunii.repairTitle'), message, t('catalogue:lunii.repair'), 'primary-violet') === true) await lunii.store.mutate(device.id, 'repair');
    },
    hide: (device, story) => lunii.store.mutate(device.id, 'hide', [story.key, !story.hidden], [story.key]),
    hideMany(device, stories) {
      const hidden = !stories.every(s => s.hidden);
      return lunii.store.mutate(device.id, 'hideMany', [hidden], stories.filter(s => Boolean(s.hidden) !== hidden).map(s => s.key));
    },
    restore: device => lunii.store.mutate(device.id, 'restore'),
    restoreOrphans(device) {
      const items = restorableOrphans(device).map(s => ({ key: s.key, knownUuid: s.knownUuid }));
      if (!items.length) return null;
      return lunii.store.mutate(device.id, 'restoreOrphans', [items], items.map(item => item.key));
    },
    orphan: (device, story) => lunii.store.mutate(device.id, 'orphan', [{ deviceId: device.id, key: story.key, restore: true, knownUuid: story.knownUuid ?? null }], [story.key]),
    name: (device, story, title) => lunii.store.mutate(device.id, 'nameStory', [story.key, title], [story.key]),
    rename: (device, name) => lunii.store.mutate(device.id, 'rename', [name]),
    repatriate: (device, stories) => lunii.store.mutate(device.id, 'repatriateMany', [], stories.filter(repatriableStory).map(s => s.key)),
    reorder: (device, keys, target) => commitOrder(device, keys, reorderedKeys(device.stories, keys, target)),
    move: (device, keys, delta) => commitOrder(device, keys, steppedKeys(device.stories, keys, delta)),
  };
}

export function luniiConfirmation(t, title, message, label, kind = 'danger') {
  return { title, message, variant: 'lunii',
    actions: [{ value: false, label: t('catalogue:data.cancel'), autoFocus: true }, { value: true, label, kind }] };
}
