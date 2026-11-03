import { useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { useEscapeKey } from '../../../hooks/useEscapeKey.js';
import { CompactExemplar } from './CompactExemplar.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { choiceKeyAction } from '../../../store/catalogue/exemplarChoice.js';
import { domId } from '../../../store/catalogue/viewModes.js';
import { AppModalPortal } from '../../common/AppModalPortal.jsx';
import './CatalogueOpen.css';

// Shared copy chooser: consultation and editor entry use the same short rows.
const TEXTS = Object.freeze({
  reveal: { title: 'catalogue:open.choice.reveal.title' },
  checkPack: { title: 'catalogue:open.choice.check.title' },
  copy: { title: 'catalogue:open.choice.copy.title' },
  edit: { title: 'catalogue:open.choice.edit.title' },
  editAndGenerate: { title: 'catalogue:open.choice.edit.title' },
  send: { title: 'catalogue:open.choice.send.title' },
  simulate: {
    title: 'catalogue:open.choice.simulate.title',
  },
});

/** Short copy identity; unavailable copies expose their reason on hover. */
function ChoiceOption({ item, index, active, latest, onChoose, onHover }) {
  const { t } = useCatalogueTranslation();
  const id = domId('catalogue-choice-option', item.id);
  const reasonId = `${id}-reason`;
  return <li
    role="option"
    id={id}
    className="catalogue-choice-option"
    aria-selected={active}
    aria-disabled={item.enabled ? undefined : 'true'}
    aria-describedby={item.enabled ? undefined : reasonId}
    onClick={() => onChoose(item)}
    onPointerMove={() => onHover(index)}
  >
    <span className="catalogue-choice-option-label"><CompactExemplar exemplar={item.exemplar} latest={latest} /></span>
    {!item.enabled && item.reasonKey && <Tooltip text={t(item.reasonKey, item.reasonParams)} asChild wrap><span id={reasonId} aria-label={t(item.reasonKey, item.reasonParams)}>ⓘ</span></Tooltip>}
  </li>;
}

/**
 * Contenu de la boîte de choix : fenêtre (`dialog`) contenant une liste
 * (`listbox`) des exemplaires de la fiche. Les exemplaires qui ne conviennent
 * pas restent présents, désactivés, avec leur raison liée.
 */
export function ExemplarChoicePanel({ choice, card, items, dispatch, onChoose, onCancel, listRef = null }) {
  const { t } = useCatalogueTranslation();
  const [navigated, setNavigated] = useState(false);
  const texts = TEXTS[choice.command] ?? TEXTS.simulate;
  const title = (card.displayTitle ?? card.title) ?? t('catalogue:card.untitled');
  const active = items[choice.activeIndex] ?? null;
  const latestId = items.reduce((newest, item) => (item.exemplar.modifiedAt ?? 0) > (newest?.modifiedAt ?? 0) ? item.exemplar : newest, null)?.id;
  return <div className="catalogue-choice" role="dialog" aria-modal="true" aria-labelledby="catalogue-choice-title" onKeyDown={event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const list = event.currentTarget.querySelector('[role="listbox"]');
      const cancel = event.currentTarget.querySelector('button');
      (document.activeElement === list ? cancel : list)?.focus();
    }
  }}>
      <h2 id="catalogue-choice-title">{t(texts.title)}</h2>
      <p className="catalogue-choice-subtitle">{title}</p>
      <ul
        role="listbox"
        ref={listRef}
        tabIndex={0}
        className="catalogue-choice-list"
        aria-labelledby="catalogue-choice-title"
        aria-activedescendant={active ? domId('catalogue-choice-option', active.id) : undefined}
        onKeyDown={(event) => {
          const action = choiceKeyAction(event.key);
          if (!action) return;
          event.preventDefault();
          if (action.type === 'activate') onChoose(active);
          else { setNavigated(true); dispatch(action); }
        }}
      >
        {items.map((item, index) => <ChoiceOption key={item.id} item={item} index={index} active={navigated && index === choice.activeIndex} latest={item.exemplar.id === latestId}
          onChoose={onChoose} onHover={(target) => dispatch({ type: 'focus', index: target })} />)}
      </ul>
      <div className="catalogue-choice-actions">
        <button type="button" onClick={onCancel}>{t('catalogue:open.choice.cancel')}</button>
      </div>
    </div>;
}

/**
 * Choix de l'exemplaire (D69), en fenêtre superposée. Échap ou Annuler
 * ferment et rendent le focus au déclencheur.
 */
export function ExemplarChoiceDialog({ choice, card, items, dispatch, onChoose, onCancel }) {
  const list = useRef(null);
  const returnFocus = useRef(null);
  useEscapeKey(choice.open, onCancel);
  useEffect(() => {
    if (!choice.open) return;
    returnFocus.current = document.activeElement;
    list.current?.focus();
    return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, [choice.open]);
  if (!choice.open || !card) return null;
  return <AppModalPortal className="modal-overlay catalogue-choice-overlay">
    <ExemplarChoicePanel choice={choice} card={card} items={items} dispatch={dispatch} onChoose={onChoose} onCancel={onCancel} listRef={list} />
  </AppModalPortal>;
}
