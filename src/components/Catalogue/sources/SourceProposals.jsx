import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
export function SourceProposals({ items = [], busy, onResolve }) {
  const { t } = useCatalogueTranslation();
  if (!items.length) return null;
  return <div>
    <p className="opts-row-label">{t('catalogue:proposals.title.label')}</p>
    {items.map(source => <div className="opts-row" key={source.id}>
      <Tooltip asChild text={source.path}><span className="opts-catalogue-path" tabIndex={0}>{source.path}</span></Tooltip>
      <Button size="sm" disabled={busy} onClick={() => onResolve(source.path, false)}>{t('catalogue:proposals.accept.label')}</Button>
      <Button size="sm" disabled={busy} onClick={() => onResolve(source.path, true)}>{t('catalogue:proposals.decline.label')}</Button>
    </div>)}
  </div>;
}
