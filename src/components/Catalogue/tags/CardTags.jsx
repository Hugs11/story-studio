import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';

export function CardTags({ tags = [], onFilter }) {
  const { t } = useCatalogueTranslation();
  if (!tags.length) return null;
  return <div className="catalogue-card-tags" onDoubleClick={event => event.stopPropagation()}>
    {tags.slice(0, 2).map(tag => <Tooltip key={tag.id} text={tag.label} asChild whenTruncated><button type="button" className="catalogue-filter-badge catalogue-card-tag" onClick={event => { event.stopPropagation(); if (event.detail > 1) return; onFilter(tag.id); }}>{tag.label}</button></Tooltip>)}
    {tags.length > 2 && <Tooltip text={tags.map(tag => tag.label).join(' · ')} asChild wrap><span tabIndex={0} className="catalogue-filter-badge catalogue-card-tag">{t('catalogue:tags.moreCount', { count: tags.length - 2 })}</span></Tooltip>}
  </div>;
}
