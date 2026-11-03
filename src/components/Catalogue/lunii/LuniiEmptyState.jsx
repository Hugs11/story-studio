import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Loader2, CircleCheck, Unplug } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';

const states = t => ({
  detected: [t('catalogue:lunii.detectedTitle'), t('catalogue:lunii.detected'), LuniiIcon],
  opening: [t('catalogue:lunii.openingTitle'), t('catalogue:lunii.opening'), Loader2],
  unsupported: [t('catalogue:lunii.unsupportedTitle'), t('catalogue:lunii.unsupported'), LuniiIcon],
  ejected: [t('catalogue:lunii.ejectedTitle'), null, CircleCheck],
  disconnected: [t('catalogue:lunii.disconnectedTitle'), t('catalogue:lunii.disconnected'), Unplug],
});
export function LuniiEmptyState({ state, onOpen, busy }) {
  const { t } = useCatalogueTranslation();
  const [title, description, Icon] = states(t)[state] ?? [t('catalogue:lunii.empty'), null, LuniiIcon];
  return <div className="lunii-empty" role="status" aria-busy={state === 'opening'}>
    <span className={`lunii-empty-icon${state === 'ejected' ? ' lunii-empty-icon--success' : ''}`}><Icon width={22} height={22} className={state === 'opening' ? 'lunii-spinner' : undefined} /></span>
    <h3>{title}</h3>{description && <p>{description}</p>}
    {state === 'detected' && <Button variant="primary-violet" disabled={busy} onClick={onOpen}>{t('catalogue:lunii.open')}</Button>}
  </div>;
}
