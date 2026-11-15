import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { coverAddress } from '../../../store/catalogue/coverAddress.js';
import { useCatalogueCoverImage } from '../../../hooks/useCatalogueCoverImage.js';
import { Image } from '../../icons/LucideLocal.jsx';

function stateLabel(t, phase) {
  switch (phase) {
    case 'offline':
    case 'absent': return t('catalogue:cover.missing.label');
    case 'unreadable': return t('catalogue:cover.unreadable.label');
    case 'tooLarge': return t('catalogue:cover.tooLarge.label');
    case 'loading': return t('catalogue:cover.loading.label');
    case 'officialPending': return t('catalogue:cover.officialPending.label');
    default: return null;
  }
}

export function CoverImage({ ficheId = null, coverSignature = null, size = 'large' }) {
  const address = coverAddress(ficheId, coverSignature);
  return <CoverSurface key={ficheId} ficheId={ficheId} address={address} size={size} />;
}

function CoverSurface({ ficheId, address, size }) {
  const { t } = useCatalogueTranslation();
  const { image, state, src, fallbackSrc, onLoad, onError } = useCatalogueCoverImage(address, ficheId);
  const ready = state.phase === 'ready' || Boolean(fallbackSrc);
  const label = ready ? null : stateLabel(t, state.phase);
  const officialPending = !ready && state.phase === 'officialPending';
  return <span className={`catalogue-cover catalogue-cover--${size}${ready ? '' : ' catalogue-cover--missing'}${officialPending ? ' catalogue-cover--official-pending' : ''}`}
    role={officialPending ? 'img' : undefined} title={officialPending ? label : undefined} aria-label={officialPending ? label : undefined}>
    {fallbackSrc && <img key={fallbackSrc} src={fallbackSrc} alt="" decoding="async" />}
    {src && <img key={src} ref={image} src={src} alt="" decoding="async" onLoad={onLoad} onError={onError}
      className={state.phase === 'ready' ? state.fade ? 'catalogue-cover-arrival' : undefined : 'catalogue-cover-pending'} />}
    {officialPending ? <span className="catalogue-cover-official-pending" aria-hidden="true">
      <Image />
      <span>{label}</span>
    </span> : label && <span>{label}</span>}
  </span>;
}
