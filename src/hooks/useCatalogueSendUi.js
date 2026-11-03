import { useMemo } from 'react';
import { useCatalogueTranslation } from '../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../store/catalogue/catalogueApi.js';
import { dropRefusal, openDevices, presenceOn, sendableCards, sendButtonState, sendRefusal } from '../store/catalogue/luniiSend.js';

/**
 * Everything the catalogue needs to send to a Lunii, as small pieces for the
 * cards, the selection actions, the context menu and the inspector.
 */
export function useCatalogueSendUi({ lunii, targets }) {
  const { t } = useCatalogueTranslation();
  const send = lunii?.send;
  const devices = useMemo(() => lunii?.luniiDevices ?? [], [lunii?.luniiDevices]);
  const open = openDevices(devices);
  const activeId = lunii?.activeLuniiId;
  const active = open.find(d => d.id === activeId) ?? open[0] ?? null;
  const name = device => device.name || t('catalogue:lunii.name');
  const idsFor = id => targets.length > 1 && targets.some(card => card.id === id) ? targets.map(card => card.id) : [id];
  const reasonText = code => presentCatalogueError({ code, params: {} }).message;
  // Nothing of the selection may leave: only official stories, or every copy damaged (the engine's own reason).
  const blockedText = blocked => blocked?.kind === 'damaged' ? presentCatalogueError(blocked.reason).message : t('catalogue:lunii.officialReason');
  const sendIds = (ids, deviceId) => send?.sendCards(deviceId, ids, null);

  // Selection bar and panel: always the Lunii that is open in the panel.
  const refusal = active ? sendRefusal(active) : null;
  // A mixed selection sends the other stories; official and damaged ones are listed in the bilan.
  const selectionBlocked = targets.length > 0 ? dropRefusal(targets, devices) : null;
  const action = active ? { id: 'luniiSend', labelKey: 'catalogue:lunii.sendSelection', enabled: !refusal && targets.length > 0 && !selectionBlocked,
    reasonText: refusal ? reasonText(refusal) : selectionBlocked ? blockedText(selectionBlocked) : null, reasonKey: 'catalogue:data.noTarget' } : null;

  return {
    available: open.length > 0,
    stateOf: card => sendButtonState(card, devices, activeId),
    action,
    runSelection: () => { if (active && action.enabled) void sendIds(targets.map(card => card.id), active.id); },
    onSend: (cardId, deviceId) => sendIds(idsFor(cardId), deviceId),
    onSee: (deviceId, key) => { lunii.store.selectDevice(deviceId); lunii.store.collapse(false); lunii.store.select('lunii', [key]); },
    /** Context-menu entries: one per open Lunii, with the reason when refused. */
    menuEntries(entries, menu, card) {
      if (!open.length || menu.kind !== 'card' || menu.step) return entries;
      const extra = open.map(device => {
        const code = sendRefusal(device);
        const present = presenceOn(device, card);
        // The menu acts on the selection the card belongs to: refused only when nothing in it may leave.
        const asked = idsFor(card.id).map(id => targets.find(c => c.id === id) ?? (id === card.id ? card : null)).filter(Boolean);
        const blocked = dropRefusal(asked, devices);
        const official = !sendableCards(asked, devices).length;
        const detail = present ? (present.position == null ? t('catalogue:lunii.alreadyHidden', { name: name(device) }) : t('catalogue:lunii.alreadyAt', { name: name(device), position: present.position })) : code ? reasonText(code) : blocked?.kind === 'damaged' ? blockedText(blocked) : null;
        return { key: `luniiSend:${device.id}`, exemplar: null, deviceId: device.id, label: open.length > 1 ? t('catalogue:lunii.sendTo', { name: name(device) }) : t('catalogue:lunii.sendSelection'), detail,
          action: { id: 'luniiSend', labelKey: 'catalogue:lunii.sendSelection', enabled: !code && !present && !official, reasonKey: 'catalogue:lunii.officialReason', hint: null, choice: false } };
      });
      return [...entries, ...extra];
    },
    /** Drag source data: the cards that leave together (the whole selection when the dragged one is in it). */
    drag: send && open.length > 0 ? {
      dragIds: send.drag ? new Set(send.drag.cardIds) : null,
      idsFor,
    } : null,
  };
}
