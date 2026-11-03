import { LuniiSendButton, sendHelp, useSendWording } from './LuniiSendButton.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Check } from '../../icons/LucideLocal.jsx';

/** Under Simulate / Editor in the catalogue inspector, while a Lunii is open. */
export function LuniiSendFiche({ card, state, onSend, onSee }) {
  const { t, cell, present } = useSendWording();
  if (!state || state.kind === 'none') return null;
  if (state.kind === 'present') {
    const { device, presence } = state.target;
    return <div className="catalogue-fiche-send"><Tooltip text={present(device, presence)} asChild wrap><Button className="catalogue-send--present-wide" onClick={() => onSee?.(device.id, presence.key)}>
      <Check width={14} height={14} />{presence.position == null ? t('catalogue:lunii.presentButtonHidden') : t('catalogue:lunii.presentButton', { position: presence.position })}</Button></Tooltip></div>;
  }
  return <div className="catalogue-fiche-send"><LuniiSendButton state={state} variant="fiche" id="catalogue-fiche-send" onSend={onSend} />
    {state.kind === 'ready' && <p>{sendHelp(t, cell, card)}</p>}</div>;
}
