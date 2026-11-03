import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { CircleCheck, Info, TriangleAlert, Loader2, RotateCcw, Trash2 } from '../../icons/LucideLocal.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { getIntlLocale } from '../../../i18n/language.js';
import { CatalogueNotice } from '../CatalogueNotice.jsx';

const STATUS = { success: 'catalogue:summary.result.success', partial: 'catalogue:summary.result.partial', failed: 'catalogue:summary.result.failed', cancelled: 'catalogue:summary.result.cancelled' };
export function SourceRow({ source, sources = [], busy = false, onRemove, onRefresh }) {
  const { t } = useCatalogueTranslation();
  const parent = sources.find((s) => s.id === source.includedIn);
  const status = source.scanning ? t('catalogue:sources.state.scanning')
    : source.lastScanStatus ? t(STATUS[source.lastScanStatus] ?? 'catalogue:sources.state.unknown') : t('catalogue:sources.lastScan.never');
  const date = source.lastScanAt ? new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(source.lastScanAt)) : '';
  const Icon = source.scanning ? Loader2 : source.lastScanStatus === 'success' ? CircleCheck : source.lastScanStatus ? TriangleAlert : Info;
  return <li className="opts-row opts-catalogue-source">
    <Tooltip asChild text={parent ? t('catalogue:sources.included.message', { path: parent.path }) + '\n' + source.path : source.path}>
      <span className="opts-catalogue-path" tabIndex={0}>{source.path}</span>
    </Tooltip>
    <span className="opts-row-sub">{t('catalogue:preferences.sources.count', { count: source.exemplarCount ?? 0 })}</span>
    <Tooltip asChild text={status}><span className="opts-catalogue-scan opts-row-sub" tabIndex={0} aria-label={status}><Icon className={source.scanning ? 'opts-catalogue-scan-spinner' : undefined} size={14} aria-hidden="true" />{date}</span></Tooltip>
    <Tooltip text={busy ? t('catalogue:sources.busy.message') : t('catalogue:screen.refresh.label')}><Button size="sm" variant="icon" disabled={busy || source.scanning} aria-label={t('catalogue:screen.refresh.label')} onClick={() => onRefresh?.(source.id)}><RotateCcw size={14} /></Button></Tooltip>
    <Tooltip text={busy ? t('catalogue:sources.busy.message') : t('catalogue:sources.remove.label')}><Button size="sm" variant="icon" disabled={busy} aria-label={t('catalogue:sources.remove.label')} onClick={() => onRemove?.(source.id)}><Trash2 size={14} /></Button></Tooltip>
    {source.error && <CatalogueNotice compact error={source.error} />}
  </li>;
}
