import { Tooltip } from '../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';

const FORMAT_CLASSES = Object.freeze({
  project: 'catalogue-format-tag--project',
  zip: 'catalogue-format-tag--zip',
  sevenZip: 'catalogue-format-tag--seven-zip',
  folder: 'catalogue-format-tag--folder',
});

/** Ouvre le menu au clavier : touche menu ou Maj+F10 (Entrée/Espace = clic). */
export function isMenuKey(event) {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/** Badge de format : clic vers les exemplaires, contexte et double clic hérités de la carte. */
export function FormatTag({ tag, id, onActivate = null, onMenuKey, tabIndex, compact = false }) {
  const { t, line } = useCatalogueTranslation();
  const className = `catalogue-format-tag ${FORMAT_CLASSES[tag.format] ?? ''}${tag.allUnavailable ? ' catalogue-format-tag--unavailable' : ''}`;
  // « ! » : a copy of this format has a damaged picture (found at import). The sentences
  // name the copy and the screen: tooltip for the pointer, hidden text for the reader.
  const damage = (tag.damaged ?? []).map((item) => line(item.line));
  const content = <>
    {damage.length > 0 && <span className="catalogue-format-tag-damaged" aria-hidden="true">!</span>}
    {tag.regenerate && <span className="catalogue-generation-dot" aria-hidden="true">●</span>}
    <span className="catalogue-format-tag-label">{t(tag.labelKey)}</span>
    {tag.countLine && <span className="catalogue-format-tag-count">{line(tag.countLine)}</span>}
    {!compact && tag.mentions.map((mention) => <span key={mention.key} className="catalogue-format-tag-mention">{line(mention)}</span>)}
    {damage.length > 0 && <span className="catalogue-visually-hidden">{damage.join(' ')}</span>}
  </>;
  const hints = [...(compact ? tag.mentions.map((mention) => line(mention)) : []), ...damage];
  const hint = hints.length ? hints.join(' · ') : null;
  const withHint = (element) => (hint ? <Tooltip asChild wrap text={hint}>{element}</Tooltip> : element);
  if (!onActivate) return withHint(<span className={className} id={id}>{content}</span>);
  return withHint(<button
    type="button"
    id={id}
    className={className}
    tabIndex={tabIndex}
    onClick={(event) => { event.stopPropagation(); if (event.detail <= 1) onActivate(event); }}
    onKeyDown={(event) => {
      if (isMenuKey(event)) {
        event.preventDefault(); event.stopPropagation();
        onMenuKey?.(event);
      } else if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    }}
  >{content}<span className="catalogue-visually-hidden">{line(tag.accessibleLine)}</span></button>);
}

/** Rangée d'étiquettes d'une fiche, sous son titre. */
export function FormatTagRow({ tags, idPrefix, onActivate, onMenuKey, tabIndex, compact = false }) {
  const { t } = useCatalogueTranslation();
  return <div className="catalogue-format-tags" role="group" aria-label={t('catalogue:details.column.formats')}>
    {tags.map((tag) => <FormatTag
      key={tag.format}
      tag={tag}
      id={idPrefix ? `${idPrefix}-${tag.format}` : undefined}
      tabIndex={tabIndex}
      compact={compact}
      onMenuKey={onMenuKey}
      onActivate={onActivate ? (event) => onActivate(tag, event) : null}
    />)}
  </div>;
}
