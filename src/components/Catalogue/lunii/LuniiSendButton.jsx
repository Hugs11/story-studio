import { useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { sendableExemplar } from '../../../store/catalogue/luniiSend.js';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { MenuPopover, MenuItem } from '../../layout/MenuPopover.jsx';
import { Send, Check } from '../../icons/LucideLocal.jsx';

export function useSendWording() {
  const { t, cell, line } = useCatalogueTranslation();
  const name = device => device.name || t('catalogue:lunii.name');
  const present = (device, presence) => presence.position == null
    ? t('catalogue:lunii.alreadyHidden', { name: name(device) })
    : t('catalogue:lunii.alreadyAt', { name: name(device), position: presence.position });
  const refusal = code => presentCatalogueError({ code, params: {} }).message;
  return { t, cell, line, name, present, refusal };
}

/**
 * The card's Send button in its states (none, ready, present, official, blocked,
 * several Lunii). `variant="card"` is the icon of the hover actions, `"fiche"` the
 * full-width button of the inspector.
 */
export function LuniiSendButton({ state, onSend, variant = 'card', tabIndex = 0, id }) {
  const { t, line, name, present, refusal } = useSendWording();
  const [menu, setMenu] = useState(false);
  if (!state || state.kind === 'none') return null;
  const fiche = variant === 'fiche';
  const stop = handler => event => { event.stopPropagation(); if (event.detail <= 1) handler?.(event); };
  const common = { id, size: fiche ? undefined : 'sm', variant: fiche ? 'secondary' : 'icon', tabIndex, className: `catalogue-send catalogue-send--${variant}`, onDoubleClick: event => event.stopPropagation(), onKeyDown: event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); } };
  const icon = (Icon) => <Icon width={13} height={13} />;
  const disabled = (text, Icon, label, extra = {}) => <Tooltip text={text} asChild wrap><Button {...common} {...extra} aria-disabled="true" aria-label={fiche ? undefined : text} onClick={event => event.stopPropagation()}>{icon(Icon)}{fiche && <span>{label}</span>}</Button></Tooltip>;
  switch (state.kind) {
    case 'official': return disabled(t('catalogue:lunii.officialReason'), Send, t('catalogue:lunii.sendSelection'), { 'data-state': 'official' });
    case 'present': {
      const { device, presence } = state.target;
      const text = present(device, presence);
      return disabled(text, Check, presence.position == null ? t('catalogue:lunii.presentButtonHidden') : t('catalogue:lunii.presentButton', { position: presence.position }), { 'data-state': 'present', className: `${common.className} catalogue-send--present` });
    }
    case 'blocked': return disabled(state.damaged ? presentCatalogueError(state.damaged).message : state.refusal ? refusal(state.refusal) : line({ key: state.reasonKey, params: {} }), Send, t('catalogue:lunii.sendSelection'), { 'data-state': 'blocked' });
    case 'choose': return <MenuPopover open={menu} onOpenChange={setMenu} activation="click" label={t('catalogue:lunii.sendToMenu')} title={t('catalogue:lunii.sendToMenu')}
      trigger={({ openPopover }) => <Tooltip text={t('catalogue:lunii.sendToMenu')} asChild wrap><Button {...common} data-state="choose" aria-haspopup="menu" aria-expanded={menu} aria-label={t('catalogue:lunii.sendToMenu')} onClick={stop(openPopover)}>{icon(Send)}{fiche && <span>{t('catalogue:lunii.sendToMenu')}</span>}</Button></Tooltip>}>
      {state.targets.map(({ device, presence, refusal: code }) => <MenuItem key={device.id} Icon={Send} label={name(device)}
        disabled={Boolean(presence || code)} detail={presence ? present(device, presence) : code ? refusal(code) : null}
        onClick={() => { setMenu(false); onSend(device.id); }} />)}
    </MenuPopover>;
    default: {
      const { device } = state.target;
      const label = t('catalogue:lunii.sendTo', { name: name(device) });
      return <Tooltip text={label} asChild wrap><Button {...common} data-state="ready" aria-label={fiche ? undefined : label} onClick={stop(() => onSend(device.id))}>{icon(Send)}{fiche && <span>{label}</span>}</Button></Tooltip>;
    }
  }
}

/** Help under the fiche button: where the story will land and about how heavy it is. */
export function sendHelp(t, cell, card) {
  const size = sendableExemplar(card)?.sizeBytes;
  return Number.isInteger(size) ? t('catalogue:lunii.sendHelp', { size: cell(bytesCell(size)) }) : t('catalogue:lunii.sendHelpUnknown');
}
