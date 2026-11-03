import { useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Copy } from '../../icons/LucideLocal.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

export function CopyUuid({ uuids, onCopy }) {
  const { t } = useCatalogueTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Tooltip text={t('catalogue:fiche.uuid.copyHint')} asChild wrap><span role="button" tabIndex={0} className="catalogue-fiche-uuid" onClick={async () => {
    if (!onCopy) return;
    if (await onCopy(uuids.join('\n')) === false) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1000);
  }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }}>
    <Copy width={14} height={14} /><span aria-live="polite">{copied ? t('catalogue:fiche.uuid.copied') : uuids.join(' · ')}</span>
  </span></Tooltip>;
}
