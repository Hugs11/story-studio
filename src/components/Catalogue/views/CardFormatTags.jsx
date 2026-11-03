
import { observeResizeDeferred } from '../../../hooks/observeResizeDeferred.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { FormatTag, isMenuKey } from '../FormatTag.jsx';
import { fittingTagCount } from '../tags/CardTagIndicator.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';

/** Card-only overflow: the list and fiche retain their complete format rows. */
export function CardFormatTags({ tags, idPrefix, onActivate, onMenuKey, tabIndex }) {
  const { t } = useCatalogueTranslation();
  const root = useRef(null);
  const measure = useRef(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  useLayoutEffect(() => {
    if (!root.current || !measure.current) return;
    const meta = root.current.parentElement;
    const details = meta.querySelector('.catalogue-card-details');
    const actions = meta.querySelector('.catalogue-card-actions');
    const update = () => {
      const widths = [...measure.current.querySelectorAll('[data-format-width]')].map(node => node.getBoundingClientRect().width);
      const overflow = measure.current.querySelector('[data-overflow-width]').getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(root.current).columnGap) || 0;
      const metaGap = parseFloat(getComputedStyle(meta).columnGap) || 0;
      const allFormats = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
      // Restore natural metadata width before deciding whether the duration fits.
      meta.dataset.hideDuration = 'false';
      const hide = String(details.getBoundingClientRect().width + actions.getBoundingClientRect().width + allFormats + metaGap > meta.clientWidth);
      meta.dataset.hideDuration = hide;
      setVisibleCount(fittingTagCount(widths, root.current.clientWidth, overflow, gap));
    };
    update();
    return observeResizeDeferred([root.current, measure.current, meta, actions], update);
  }, [tags, t]);
  const labels = { project: t('catalogue:format.project.label'), zip: t('catalogue:format.zip.label'), sevenZip: t('catalogue:format.sevenZip.label'), folder: t('catalogue:format.folder.label') };
  const allFormats = tags.map(tag => labels[tag.format]).join(' · ');
  const hidden = tags.length - visibleCount;
  return <div ref={root} className="catalogue-format-tags" role="group" aria-label={t('catalogue:details.column.formats')}>
    <div className="catalogue-card-format-measure-clip" aria-hidden="true"><div ref={measure} className="catalogue-card-format-measure">
      {tags.map(tag => <span key={tag.format} data-format-width><FormatTag tag={tag} compact /></span>)}
      <span data-overflow-width className="catalogue-format-tag catalogue-card-format-overflow">+{tags.length}</span>
    </div></div>
    {tags.slice(0, visibleCount).map(tag => <FormatTag key={tag.format} tag={tag} id={`${idPrefix}-${tag.format}`} compact tabIndex={tabIndex} onActivate={event => onActivate(tag, event)} onMenuKey={onMenuKey} />)}
    {hidden > 0 && <Tooltip asChild wrap text={allFormats}><button type="button" className="catalogue-format-tag catalogue-card-format-overflow" tabIndex={tabIndex} aria-label={allFormats}
      onClick={event => { event.stopPropagation(); if (event.detail <= 1) onActivate({ format: undefined }, event); }}
      onKeyDown={event => {
        if (isMenuKey(event)) { event.preventDefault(); event.stopPropagation(); onMenuKey?.(event); }
        else if (['Enter', ' '].includes(event.key)) event.stopPropagation();
      }}>+{hidden}</button></Tooltip>}
  </div>;
}
