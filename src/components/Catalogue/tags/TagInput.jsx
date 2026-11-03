import { useId, useRef, useState } from 'react';
import { focusButtonOnMouseDown } from '../../common/mouseFocus.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { tagInputKey } from '../../../store/catalogue/tagInputState.js';
import { tagCollision, tagSuggestions } from '../../../store/catalogue/tagSuggest.js';
export function TagInput({ tags, busy, onAdd }) {
  const { t } = useCatalogueTranslation(); const id = useId(); const [value, setValue] = useState(''); const [open, setOpen] = useState(false); const [active, setActive] = useState(-1);
  const editVersion = useRef(0);
  const suggestions = tagSuggestions(tags, value); const collision = tagCollision(tags, value);
  async function add(tag = null) {
    if (busy || (!tag && !value.trim())) return;
    const submittedVersion = editVersion.current;
    const result = await onAdd(tag ? { addTagIds: [tag.id], addLabels: [] } : { addTagIds: [], addLabels: [value] });
    if (result && editVersion.current === submittedVersion) { editVersion.current += 1; setValue(''); setOpen(false); setActive(-1); }
  }
  return <div onMouseDown={focusButtonOnMouseDown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label htmlFor={id}>{t('catalogue:tags.input.label')}</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open && active >= 0 && suggestions[active] ? `${id}-option-${active}` : undefined}
      value={value} onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.parentElement.contains(event.relatedTarget)) setOpen(false); }} onChange={event => { editVersion.current += 1; setValue(event.target.value); setActive(-1); setOpen(true); }} onKeyDown={event => {
        const next = tagInputKey({ open, active }, event.key, suggestions.length);
        if (!next) return;
        event.preventDefault();
        if (event.key === 'Escape') event.stopPropagation();
        setOpen(next.open); setActive(next.active);
        if (next.command) void add(next.command === 'suggestion' ? suggestions[next.active] : collision);
      }} />
    <button type="button" aria-disabled={busy || !value.trim() || undefined} aria-describedby={`${id}-help`} onClick={() => void add(collision)}>{t(collision ? 'catalogue:tags.input.reuse' : 'catalogue:tags.input.add')}</button>
    <p id={`${id}-help`}>{t(busy ? 'catalogue:data.busy' : collision ? 'catalogue:tags.input.collision' : 'catalogue:tags.input.help')}</p>
    <ul id={`${id}-list`} role="listbox" aria-label={t('catalogue:tags.input.suggestions')} hidden={!open}>
      {suggestions.map((tag, index) => <li key={tag.id} id={`${id}-option-${index}`} role="option" aria-selected={index === active}>
        <button type="button" onClick={() => void add(tag)}>{tag.label}</button>
      </li>)}
    </ul>
  </div>;
}
