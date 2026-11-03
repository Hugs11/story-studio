import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';

import { ChevronDown } from '../icons/LucideLocal';
import { ADVANCED_EXAMPLES, createAdvancedExample } from '../../store/advancedExamples/catalog.js';
import './Examples.css';

export function ExamplesMenu({ disabled, disabledReason, onChoose }) {
  const { t, i18n } = useTranslation('examples');
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (!container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    container.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  function navigate(event) {
    event.stopPropagation();
    const buttons = [...container.current.querySelectorAll('[role="menuitem"]')];
    const rank = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(rank + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  }

  return (
    <div className="advanced-examples-menu" ref={container}>
      <button
        ref={trigger} type="button" className="advanced-create-command advanced-examples-trigger"
        disabled={disabled} title={disabled ? disabledReason : t('examples:menu.trigger.title')}
        aria-haspopup="menu" aria-expanded={open && !disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); setOpen(true); }
        }}
      >
        {t('examples:menu.trigger.label')} <ChevronDown className="chrome-icon" aria-hidden="true" />
      </button>
      {open && !disabled && (
        <div className="advanced-examples-list" role="menu" aria-label={t('examples:menu.list.ariaLabel')} onKeyDown={navigate}>
          {ADVANCED_EXAMPLES.map((example) => (
            <button key={example.id} type="button" role="menuitem" className="advanced-examples-item" onClick={() => {
              setOpen(false);
              // La langue de l'exemple est celle de l'interface **au choix** :
              // son contenu ne change plus ensuite, même si la langue change.
              onChoose(createAdvancedExample(example.id, i18n.resolvedLanguage));
            }}>
              <strong>{t(example.titleKey)}</strong>
              <span>{t(example.descriptionKey)}</span>
              <small>{t('examples:menu.item.counts', {
                screens: t('examples:count.screens.label', { count: example.stageCount }),
                lists: t('examples:count.choiceLists.label', { count: example.actionCount }),
              })}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
