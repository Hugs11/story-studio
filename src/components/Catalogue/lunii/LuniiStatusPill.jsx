import { LuniiIcon } from '../../icons/LuniiIcon.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { luniiStatus } from '../../../store/catalogue/luniiStatus.js';
import './LuniiStatusPill.css';
import { Tooltip } from '../../common/Tooltip.jsx';

/** Lunii status in the catalogue bar; a click shows or hides the Lunii panel. */
export function LuniiStatusPill({ lunii }) {
  const { t } = useCatalogueTranslation();
  if (!lunii) return null;
  const status = luniiStatus(lunii.luniiDevices, lunii.activeLuniiId);
  const expanded = status.hasPanel && !lunii.luniiPanelCollapsed;
  const who = status.count > 1 ? t('catalogue:lunii.status.many', { number: status.count }) : status.name || t('catalogue:lunii.name');
  const label = status.kind === 'none' ? t('catalogue:lunii.status.none') : status.kind === 'check' ? t('catalogue:lunii.status.check', { name: who }) : who;
  const hint = status.kind === 'none' ? t('catalogue:lunii.status.hintNone') : status.kind === 'check' ? t('catalogue:lunii.status.hintCheck') : t('catalogue:lunii.status.hintReady');
  return <Tooltip text={hint} asChild wrap><button type="button" id="lunii-status-pill" className={`lunii-status-pill lunii-status-pill--${status.kind}`} aria-expanded={expanded} aria-controls={status.hasPanel ? 'lunii-tabpanel' : undefined} disabled={!status.hasPanel}
    aria-label={`${label}. ${hint}`} onClick={() => lunii.store.collapse(!lunii.luniiPanelCollapsed)}>
    <span className="lunii-status-dot" aria-hidden="true" /><LuniiIcon width={14} height={14} aria-hidden="true" /><span className="lunii-status-label">{label}</span>
  </button></Tooltip>;
}
