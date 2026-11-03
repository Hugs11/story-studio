import { useEffect, useRef } from 'react';
import { useCatalogueTrash } from '../../../hooks/useCatalogueTrash.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { baseName } from '../../../store/catalogue/formatTag.js';
import { TRASH_RESET_MS, trashAvailability } from '../../../store/catalogue/trashPlan.js';
import { Button } from '../../common/Button.jsx';
import { focusButtonOnMouseDown } from '../../common/mouseFocus.js';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Trash2, Check, Loader2 } from '../../icons/LucideLocal.jsx';

export function ExemplarTrashButton({ card, exemplar, expanded, onExpand, onDone, onFailed, onBusy, services, idPrefix = 'catalogue-fiche' }) {
  const { t } = useCatalogueTranslation();
  const availability = trashAvailability(exemplar);
  const archiveName = baseName(exemplar.path);
  const title = exemplar.member ? t('catalogue:trash.archiveTitle', { name: archiveName }) : t('catalogue:trash.title');
  const flow = useCatalogueTrash(card, exemplar, services);
  const { phase, plan, error } = flow.state;
  const wrap = useRef(null);
  const button = useRef(null);
  const done = useRef(onDone);
  done.current = onDone;
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const active = ['confirming', 'running', 'finished'].includes(phase);
  const activity = useRef(onBusy);
  activity.current = onBusy;
  const previousActivity = useRef(false);
  useEffect(() => {
    if (active || previousActivity.current) activity.current?.(active, phase === 'finished');
    previousActivity.current = active;
  }, [active, phase]);
  useEffect(() => {
    if (!expanded || active) return;
    // Le repli automatique ne court que lorsque la confirmation est affichée : ni pendant la
    // préparation du plan (long sur un gros ZIP), ni sur une erreur, qui reste jusqu'à une action.
    const timer = ['planning', 'failed'].includes(phase) ? null : setTimeout(() => onExpand(null), TRASH_RESET_MS);
    const outside = event => { if (!wrap.current?.contains(event.target)) onExpand(null); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); onExpand(null);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [expanded, active, phase, onExpand]);
  useEffect(() => {
    if (!expanded) flow.reset();
    // Reset belongs to the gesture, not to the changing request state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  useEffect(() => {
    if (phase === 'failed' && error) failed.current?.(error);
  }, [phase, error]);
  useEffect(() => {
    if (phase !== 'finished') return;
    const timer = setTimeout(() => done.current({
      key: plan.action === 'deletePermanently' ? 'catalogue:trash.deleted' : 'catalogue:trash.trashed',
      params: { name: exemplar.member ? baseName(exemplar.path) : Number.isInteger(exemplar.versionDeclared) ? `v${exemplar.versionDeclared}` : baseName(exemplar.path) ?? exemplar.format },
    }), 180);
    return () => clearTimeout(timer);
  }, [phase, plan, exemplar]);
  const working = ['planning', 'confirming', 'running'].includes(phase);
  const permanent = flow.state.permanentPending || plan?.action === 'deletePermanently';
  const progress = phase === 'planning' ? t('catalogue:trash.preparing') : permanent ? t('catalogue:trash.deleting') : t('catalogue:trash.working');
  const label = (flow.state.permanentPending || plan?.action === 'deletePermanently') ? (exemplar.member ? t('catalogue:trash.archiveDelete', { name: archiveName }) : t('catalogue:trash.delete')) : title;
  return <span ref={wrap} className={`catalogue-exemplar-trash ${expanded ? 'is-expanded' : ''}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget) && !active && phase !== 'failed') onExpand(null);
  }}>
    {expanded && phase === 'failed' ? <span role="alert" className="catalogue-exemplar-trash-error">{presentCatalogueError(error).message}</span>
      : <Tooltip text={availability.enabled ? title : t(availability.reasonKey, availability.reasonParams)} disabled={expanded} asChild wrap><Button ref={button}
        id={`${idPrefix}-copy-${exemplar.id}-trash`} size="sm" disabled={!availability.enabled} variant={expanded ? 'danger' : 'icon'}
        aria-label={expanded && working ? progress : label} aria-expanded={expanded} aria-disabled={expanded && phase !== 'review' || undefined}
        onMouseDown={event => {
          if (expanded) focusButtonOnMouseDown(event);
        }}
        onClick={event => {
          event.stopPropagation();
          if (expanded) { void flow.confirm(); return; }
          onExpand(exemplar.id); void flow.preview(); button.current?.focus();
        }}>
        {expanded && working ? <><Loader2 className="catalogue-exemplar-trash-spinner" width={16} height={16} aria-hidden="true" /><span role="status">{progress}</span></>
          : <><Trash2 width={16} height={16} />{expanded && <><span>{label}</span><Check width={16} height={16} /></>}</>}
      </Button></Tooltip>}
  </span>;
}
