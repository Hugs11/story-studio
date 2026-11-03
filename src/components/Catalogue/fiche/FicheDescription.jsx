import { observeResizeDeferred } from '../../../hooks/observeResizeDeferred.js';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { descriptionText } from '../../../store/catalogue/descriptionText.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Button } from '../../common/Button.jsx';
import { ChevronDown, ChevronUp } from '../../icons/LucideLocal.jsx';

/** `pencil` sits by the heading; `editor`, while the description is edited, replaces the text. */
export function FicheDescription({ text, full = false, pencil = null, editor = null }) {
  const { t } = useCatalogueTranslation();
  const content = descriptionText(text);
  const paragraph = useRef(null);
  const paragraphId = useId();
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  // The paragraph is mounted again when the inline editor closes.
  const shown = editor === null;
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setLong(element.scrollHeight > lineHeight * 4 + 1);
    };
    measure();
    return observeResizeDeferred([element], measure);
  }, [content, shown]);
  const label = expanded ? t('catalogue:fiche.description.less') : t('catalogue:fiche.description.more');
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return <section className={`catalogue-fiche-description-section${pencil ? ' catalogue-fiche-editable' : ''}`}>
    <div className="catalogue-fiche-section-heading">
      <h3 className="catalogue-section-title">{t('catalogue:fiche.edit.field.description')}</h3>
      {!editor && pencil}
    </div>
    {editor ?? <><p id={paragraphId} ref={paragraph} className={`catalogue-fiche-description${expanded || full ? '' : ' catalogue-fiche-description--short'}`}>{content || t('catalogue:fiche.description.empty')}</p>
    {long && !full && <Button variant="ghost" size="sm" className="catalogue-fiche-description-toggle" aria-label={label} aria-expanded={expanded} aria-controls={paragraphId} onClick={() => setExpanded(value => !value)}>{label}<Chevron width={16} height={16} /></Button>}</>}
  </section>;
}
