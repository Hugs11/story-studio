import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from '../icons/LucideLocal.jsx';
import {
  buildSections, extendBuffer, firstEnabled, initialActive, lastEnabled, moveActive, placeList, TYPEAHEAD_RESET_MS, typeaheadMatch,
} from './selectModel.js';
// Fond, bordure, rayon, ombre, survol et désactivation viennent des menus de l'app.
import '../layout/ProjectMenuPopover.css';
import './Select.css';

const PAGE_STEP = 10;

const Option = memo(function Option({ option, index, id, selected, active, onPick, onHover }) {
  const disabled = !!option.disabled;
  return (
    <div
      id={id}
      role="option"
      className="project-menu-item select-option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-active={active || undefined}
      onClick={disabled ? undefined : () => onPick(index)}
      onMouseMove={disabled ? undefined : () => onHover(index)}
    >
      <span className="select-check" aria-hidden="true">{selected ? <Check width={14} height={14} /> : null}</span>
      <span><strong>{option.label}</strong></span>
    </div>
  );
});

/**
 * Liste déroulante de l'app, en remplacement de `<select>` : bouton `role="combobox"` + liste `role="listbox"`
 * posée dans le `body` (jamais rognée par un `overflow`, au-dessus des modales). Le focus reste sur le bouton
 * (`aria-activedescendant`), donc aucun piège de focus de dialogue ne s'en mêle.
 *
 * options : [{ value, label, disabled?, group? }] — des options consécutives de même `group` forment un groupe.
 * onChange(value) reçoit la `value` de l'option telle qu'elle est donnée (texte ou nombre).
 * readOnly : reste focalisable mais ne s'ouvre pas (équivalent du `aria-disabled` d'un champ occupé).
 * variant="pill" : pastille compacte. Les attributs `aria-*` et `data-*` vont au bouton.
 * Clavier (déclencheur fermé) : ↓ ↑ Espace Alt+↓ ouvrent ; une lettre choisit par frappe ; Entrée n'est pas prise
 * et remonte (validation du formulaire ou de l'éditeur en place). Liste ouverte, Entrée choisit l'option active et
 * referme, sans valider le parent : un second Entrée valide.
 */
export function Select({
  value, onChange, options, disabled = false, readOnly = false, invalid = false, id, placeholder = '', variant, className = '', autoFocus = false, ...rest
}) {
  const listId = useId();
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const bufferRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState(null);
  const selectedIndex = options.findIndex(option => Object.is(option.value, value));
  const sections = useMemo(() => buildSections(options), [options]);
  const optionId = index => `${listId}-o${index}`;

  const close = useCallback(() => { setOpen(false); setPlacement(null); }, []);
  const show = () => {
    if (disabled || readOnly || options.length === 0) return;
    setActive(initialActive(options, value));
    setOpen(true);
  };
  const commit = index => {
    const option = options[index];
    close();
    triggerRef.current?.focus();
    if (option && !option.disabled && !Object.is(option.value, value)) onChange(option.value);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const pick = useCallback(index => commitRef.current(index), []);
  const hover = useCallback(index => setActive(index), []);

  // Placement : mesuré une fois la liste peinte (invisible), avant le premier affichage.
  useLayoutEffect(() => {
    if (!open || !listRef.current || !triggerRef.current) return;
    const list = listRef.current;
    setPlacement(placeList({
      rect: triggerRef.current.getBoundingClientRect(),
      listWidth: list.offsetWidth,
      contentHeight: list.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));
  }, [open, options]);

  // Ouverture centrée sur l'option courante ; ensuite, la plus petite course pour garder l'option active visible.
  useLayoutEffect(() => {
    if (!open || !placement || !listRef.current) return;
    const list = listRef.current;
    const element = list.querySelector('[data-active]') ?? document.getElementById(optionId(selectedIndex));
    if (!element) return;
    list.scrollTop = element.offsetTop - (list.clientHeight - element.offsetHeight) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement === null]);
  useEffect(() => {
    if (open && placement) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Fermeture hors de la liste : clic ailleurs, défilement d'un conteneur, redimensionnement, perte du focus de la fenêtre.
  useEffect(() => {
    if (!open) return undefined;
    const outside = target => !listRef.current?.contains(target);
    const onPointerDown = event => { if (outside(event.target) && !triggerRef.current?.contains(event.target)) close(); };
    const onScroll = event => { if (outside(event.target)) close(); };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  // Focus à l'arrivée : `autoFocus` de React, puis une seconde prise si, entre-temps, le focus est tombé sur
  // le document (le bouton qui a ouvert l'éditeur disparaît du DOM) — sans jamais voler un autre élément.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const claim = () => {
      const current = document.activeElement;
      if (!current || current === document.body) triggerRef.current?.focus({ preventScroll: true });
    };
    claim();
    const frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  function onKeyDown(event) {
    if (disabled || readOnly || event.ctrlKey || event.metaKey) return;
    const { key } = event;
    // Alt+↓ / Alt+↑ ouvrent la liste fermée (comme sous macOS et Windows) ; toute autre combinaison avec Alt est laissée.
    if (event.altKey) {
      if (!open && (key === 'ArrowDown' || key === 'ArrowUp')) { event.preventDefault(); event.stopPropagation(); show(); }
      return;
    }
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 'Tab') { if (open) close(); return; }
    if (key === 'Escape') {
      // Ouverte, la touche ne ferme que la liste ; fermée, elle remonte (ex. annulation de l'éditeur en place).
      if (open) { handled(); close(); triggerRef.current?.focus(); }
      return;
    }
    const typing = bufferRef.current && Date.now() - bufferRef.current.at <= TYPEAHEAD_RESET_MS;
    if (key.length === 1 && (key !== ' ' || typing)) {
      handled();
      bufferRef.current = extendBuffer(bufferRef.current, key, Date.now());
      const target = typeaheadMatch(options, bufferRef.current.text, open ? active : selectedIndex);
      if (target < 0) return;
      if (open) setActive(target);
      else if (!Object.is(options[target].value, value)) onChange(options[target].value);
      return;
    }
    if (!open) {
      // Fermée, Entrée ne s'ouvre pas : elle remonte au formulaire ou à l'éditeur en place (validation).
      if ([' ', 'ArrowDown', 'ArrowUp'].includes(key)) { handled(); show(); }
      return;
    }
    switch (key) {
      case 'ArrowDown': handled(); setActive(moveActive(options, active, 1)); break;
      case 'ArrowUp': handled(); setActive(moveActive(options, active, -1)); break;
      case 'PageDown': handled(); setActive(moveActive(options, active, PAGE_STEP)); break;
      case 'PageUp': handled(); setActive(moveActive(options, active, -PAGE_STEP)); break;
      case 'Home': handled(); setActive(firstEnabled(options)); break;
      case 'End': handled(); setActive(lastEnabled(options)); break;
      case 'Enter': case ' ': handled(); if (active >= 0) commit(active); else close(); break;
      default: break;
    }
  }

  const label = selectedIndex >= 0 ? options[selectedIndex].label : placeholder;
  const list = open ? createPortal(
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      className="project-submenu select-list"
      aria-label={rest['aria-label']}
      aria-labelledby={rest['aria-labelledby']}
      style={placement ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight, minWidth: placement.minWidth } : { left: 0, top: 0, visibility: 'hidden', minWidth: triggerRef.current?.offsetWidth }}
      onMouseDown={event => event.preventDefault()}
    >
      {sections.map((section, position) => {
        const rows = section.options.map(({ option, index }) => (
          <Option key={index} option={option} index={index} id={optionId(index)} selected={index === selectedIndex} active={index === active} onPick={pick} onHover={hover} />
        ));
        if (section.group === null) return rows;
        const headingId = `${listId}-g${position}`;
        return (
          <div key={position} role="group" aria-labelledby={headingId}>
            <div id={headingId} className="select-group" role="presentation">{section.group}</div>
            {rows}
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        {...rest}
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className={['select-trigger', variant === 'pill' ? 'select-trigger--pill' : '', className].filter(Boolean).join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-invalid={invalid || rest['aria-invalid'] || undefined}
        aria-readonly={readOnly || undefined}
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{label}</span>
        <ChevronDown className="select-chevron" width={12} height={12} aria-hidden="true" />
      </button>
      {list}
    </>
  );
}
