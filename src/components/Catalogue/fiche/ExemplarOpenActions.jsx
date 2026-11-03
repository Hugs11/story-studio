import { useId, useRef } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { editButton, simulateCommand } from '../../../store/catalogue/cardActions.js';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { SquarePen, Play } from '../../icons/LucideLocal.jsx';
import './ExemplarActions.css';

/** A version shortcut uses the same command and guard as the fiche's main action. */
export function ExemplarOpenAction({ id, command, label, Icon, busy = false, beforeAction, onOpen }) {
  const { t } = useCatalogueTranslation();
  const reasonId = useId();
  const pending = useRef(false);
  const unavailable = busy || !command.enabled;
  const reason = busy ? t('catalogue:data.busy') : command.enabled ? null : t(command.reasonKey);
  return <>
    <Tooltip text={reason ?? label} asChild wrap><Button id={id} variant="icon" size="sm" aria-label={label}
      aria-disabled={unavailable || undefined} aria-describedby={reason ? reasonId : undefined}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
      onClick={async event => {
        event.stopPropagation();
        if (unavailable || pending.current || event.detail > 1) return;
        const trigger = event.currentTarget;
        pending.current = true;
        try {
          if (beforeAction && !(await beforeAction())) return;
          await onOpen(command, trigger);
        } finally { pending.current = false; }
      }}><Icon width={16} height={16} /></Button></Tooltip>
    {reason && <span id={reasonId} className="catalogue-visually-hidden">{reason}</span>}
  </>;
}

export function ExemplarOpenActions({ card, exemplar, busy, beforeAction, onEdit, onSimulate, idPrefix = 'catalogue-fiche' }) {
  const { t } = useCatalogueTranslation();
  return <>
    {onSimulate && <ExemplarOpenAction id={`${idPrefix}-copy-${exemplar.id}-simulate`} command={simulateCommand(card, [exemplar])}
      label={t('catalogue:fiche.copies.simulateVersion')} Icon={Play} busy={busy} beforeAction={beforeAction} onOpen={onSimulate} />}
    {onEdit && <ExemplarOpenAction id={`${idPrefix}-copy-${exemplar.id}-edit`} command={editButton(card, [exemplar])}
      label={t('catalogue:fiche.copies.openEditor')} Icon={SquarePen} busy={busy} beforeAction={beforeAction} onOpen={onEdit} />}
  </>;
}
