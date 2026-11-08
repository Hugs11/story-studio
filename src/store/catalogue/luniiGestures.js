import { bytesCell } from './detailsRow.js';
import { presentCatalogueCell } from '../../i18n/cataloguePresentation.js';
import { reorderedKeys, steppedKeys, luniiWriteRefusal, luniiRows, restorableOrphans } from './luniiDevices.js';
import { repatriableStory } from './luniiRepatriate.js';

/** `choose(dialog)`: the app's choice dialog, resolving to the value of the chosen action. */
/** Names the user sees for these keys, handed to the queue so it names what the list shows. */
const shown = (device, keys, stories = []) => Object.fromEntries([...luniiRows(device), ...stories].filter(row => keys.includes(row.key)).map(row => [row.key, row.title ?? '']));

export function createLuniiGestures(lunii, t, confirm, setAnnouncement, choose = async () => 'stay') {
  async function commitOrder(device, keys, order, intent) {
    if (order.every((key, i) => key === device.stories[i].key)) return;
    const story = device.stories.find(s => keys.includes(s.key));
    // Displayed numbers count visible stories only; a hidden story gets the rank it will show at.
    const visible = order.filter(key => !device.stories.find(s => s.key === key)?.hidden);
    const params = { title: story.title || t('catalogue:lunii.untitled'), position: order.slice(0, order.indexOf(story.key)).filter(key => visible.includes(key)).length + 1, total: visible.length };
    // Behind other operations the list already shows the new place: say so now, not when it lands.
    const waiting = device.queueActive === true;
    if (waiting) setAnnouncement(t('catalogue:lunii.movedQueued', params));
    const result = await lunii.store.mutate(device.id, 'reorder', [intent], keys, shown(device, keys));
    if (result && !waiting) setAnnouncement(t('catalogue:lunii.moved', params));
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
      // The whole gesture is queued at once, so that every story shows its waiting removal:
      // listed stories first, in one write, then each orphan. Like any queued entry, a failure
      // does not hold back the next ones; only a fault of the Lunii stops the queue.
      const writes = [];
      if (listed.length) writes.push(lunii.store.mutate(device.id, 'remove', [listed.map(s => s.key)], listed.map(s => s.key), shown(device, listed.map(s => s.key), listed)));
      for (const story of orphans) writes.push(lunii.store.mutate(device.id, 'orphan', [{ deviceId: device.id, key: story.key, restore: false }], [story.key], shown(device, [story.key], [story])));
      await Promise.all(writes);
    },
    /**
     * Eject: at once when nothing is written; otherwise the app asks. « Attendre la fin » (default)
     * ejects once the queue is empty; « Annuler le reste » drops what waits on this Lunii, lets the
     * running write end (never cut) and then ejects; « Ne pas éjecter » changes nothing.
     */
    async eject(device) {
      if (!device || ['disconnected', 'ejected'].includes(device.state) || device.state === 'opening' || device.ejectPending) return;
      if (!device.busy) return lunii.store.eject(device.id);
      const waiting = (lunii.store.getSnapshot?.().luniiQueue?.[device.id] ?? []).filter(entry => entry.state === 'queued').length;
      const choice = await choose({
        title: t('catalogue:lunii.ejectQueue.title'),
        // The running write counts: one left means only it, which always finishes.
        message: t('catalogue:lunii.ejectQueue.message', { count: waiting + 1 }),
        cancelValue: 'stay',
        actions: [
          { value: 'wait', label: t('catalogue:lunii.ejectQueue.wait'), kind: 'primary', autoFocus: true },
          ...(waiting ? [{ value: 'cancelRest', label: t('catalogue:lunii.ejectQueue.cancelRest'), kind: 'danger-outline' }] : []),
          { value: 'stay', label: t('catalogue:lunii.ejectQueue.stay') },
        ],
      });
      if (choice === 'cancelRest') lunii.store.cancelQueued(device.id);
      if (choice === 'wait' || choice === 'cancelRest') {
        lunii.store.ejectWhenIdle(device.id);
        setAnnouncement(t('catalogue:lunii.ejectQueue.pending'));
      }
    },
    async repair(device) {
      const preview = device.repairPreview;
      if (!preview || luniiWriteRefusal(device, 'repair')) return;
      const message = preview.empty ? t('catalogue:lunii.repairEmpty') : t('catalogue:lunii.repairHelp', { kept: preview.kept, removed: preview.removed.length + (preview.truncated ? 1 : 0) });
      if (await confirm(t('catalogue:lunii.repairTitle'), message, t('catalogue:lunii.repair'), 'primary-violet') === true) await lunii.store.mutate(device.id, 'repair');
    },
    hide: (device, story) => lunii.store.mutate(device.id, 'hide', [story.key, !story.hidden], [story.key], shown(device, [story.key], [story])),
    hideMany(device, stories) {
      const hidden = !stories.every(s => s.hidden);
      const keys = stories.filter(s => Boolean(s.hidden) !== hidden).map(s => s.key);
      return lunii.store.mutate(device.id, 'hideMany', [hidden], keys, shown(device, keys, stories));
    },
    restore: device => lunii.store.mutate(device.id, 'restore'),
    restoreOrphans(device) {
      const items = restorableOrphans(device).map(s => ({ key: s.key, knownUuid: s.knownUuid }));
      if (!items.length) return null;
      return lunii.store.mutate(device.id, 'restoreOrphans', [items], items.map(item => item.key), shown(device, items.map(item => item.key)));
    },
    orphan: (device, story) => lunii.store.mutate(device.id, 'orphan', [{ deviceId: device.id, key: story.key, restore: true, knownUuid: story.knownUuid ?? null }], [story.key], shown(device, [story.key], [story])),
    name: (device, story, title) => lunii.store.mutate(device.id, 'nameStory', [story.key, title], [story.key], shown(device, [story.key], [story])),
    rename: (device, name) => lunii.store.mutate(device.id, 'rename', [name]),
    repatriate(device, stories) {
      const keys = stories.filter(repatriableStory).map(s => s.key);
      return lunii.store.mutate(device.id, 'repatriateMany', [], keys, shown(device, keys, stories));
    },
    reorder: (device, keys, target) => commitOrder(device, keys, reorderedKeys(device.stories, keys, target), { rowKey: device.stories[target]?.key ?? null, index: target }),
    move: (device, keys, delta) => commitOrder(device, keys, steppedKeys(device.stories, keys, delta), { delta }),
  };
}

export function luniiConfirmation(t, title, message, label, kind = 'danger') {
  return { title, message, variant: 'lunii',
    actions: [{ value: false, label: t('catalogue:data.cancel'), autoFocus: true }, { value: true, label, kind }] };
}
