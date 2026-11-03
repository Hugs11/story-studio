import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { coverAddress } from '../../../store/catalogue/coverAddress.js';
import { useCatalogueCoverImage } from '../../../hooks/useCatalogueCoverImage.js';

function stateLabel(t, phase) {
  switch (phase) {
    case 'offline':
    case 'absent': return t('catalogue:cover.missing.label');
    case 'unreadable': return t('catalogue:cover.unreadable.label');
    case 'tooLarge': return t('catalogue:cover.tooLarge.label');
    case 'loading': return t('catalogue:cover.loading.label');
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
  return <span className={`catalogue-cover catalogue-cover--${size}${ready ? '' : ' catalogue-cover--missing'}`}>
    {fallbackSrc && <img key={fallbackSrc} src={fallbackSrc} alt="" decoding="async" />}
    {src && <img key={src} ref={image} src={src} alt="" decoding="async" onLoad={onLoad} onError={onError}
      className={state.phase === 'ready' ? state.fade ? 'catalogue-cover-arrival' : undefined : 'catalogue-cover-pending'} />}
    {label && <span>{label}</span>}
  </span>;
}
