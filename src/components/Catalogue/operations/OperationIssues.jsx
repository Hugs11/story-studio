import { useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { catalogueApi } from '../../../store/catalogue/catalogueApi.js';
import { reasonLabelKey } from '../../../store/catalogue/labels.js';
import { presentUserMessage, rustMessageEnvelope } from '../../../i18n/userMessage.js';
import { CatalogueNotice } from '../CatalogueNotice.jsx';
import { Button } from '../../common/Button.jsx';
import { operationIssueItems } from '../../../store/catalogue/operationView.js';

function issueReason(item, t) {
  const message = rustMessageEnvelope(item.detail);
  const cause = message?.code === 'IMPORT_UNSUPPORTED_COMPRESSION' ? rustMessageEnvelope(message.detail) : null;
  if (message?.code) return presentUserMessage(cause?.code ? cause : message, { t }).message;
  // File operations may carry their structured error code as the reason.
  if (item.reason?.startsWith('CATALOG_') || item.reason?.startsWith('STORYTELLER_')) return presentUserMessage({ code: item.reason }, { t }).message;
  return t(reasonLabelKey(item.reason));
}

export function OperationIssuesContent({ items }) {
  const { t } = useCatalogueTranslation();
  return <ul className="catalogue-operation-issues">{items.map((item, index) => {
    const reason = issueReason(item, t);
    const detail = rustMessageEnvelope(item.detail)?.code ? presentUserMessage(item.detail, { t }).technicalDetail : '';
    return <li key={`${item.path}:${item.member}:${index}`}>
    {(item.path || item.untitledStory) && <p className="catalogue-path">{item.untitledStory ? t('catalogue:lunii.untitled') : item.path}</p>}
    {item.member && <p className="catalogue-path">{item.member}</p>}
    <p>{reason}</p>
    {detail && detail !== reason && <p className="catalogue-path">{detail}</p>}
  </li>;
  })}</ul>;
}

// Loaded only when requested, with pagination over failures rather than successes.
export function OperationIssues({ operationId, snapshot, api = catalogueApi() }) {
  const { t } = useCatalogueTranslation();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    setPage(null); setError(null); pending.current = false;
    if (open) {
      pending.current = true; setBusy(true);
      void api.getOperation(operationId, { issuesOnly: true }).then((result) => {
        if (epoch.current === generation) setPage(result);
      }).catch((error) => { if (epoch.current === generation) setError(error); })
        .finally(() => { if (epoch.current === generation) { pending.current = false; setBusy(false); } });
    } else setBusy(false);
    return () => { epoch.current += 1; };
  }, [api, operationId, open]);
  async function more() {
    if (pending.current || !page?.cursor) return;
    const generation = epoch.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      const next = await api.getOperation(operationId, { issuesOnly: true, cursor: page.cursor });
      if (epoch.current === generation) setPage((old) => ({ ...next, items: [...old.items, ...next.items] }));
    } catch (error) { if (epoch.current === generation) setError(error); }
    finally { if (epoch.current === generation) { pending.current = false; setBusy(false); } }
  }
  const items = operationIssueItems(page, snapshot, { summaryErrorVisible: Boolean(snapshot?.error) });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t('catalogue:operation.issues')}</summary>
    <CatalogueNotice error={error} />
    {busy && <p>{t('catalogue:loading.state.loading')}</p>}
    {page && items.length > 0 && <OperationIssuesContent items={items} />}
    {page && !items.length && !busy && !error && <p>{t('catalogue:diagnostics.none')}</p>}
    {page?.cursor && <Button size="sm" disabled={busy} onClick={more}>{t('catalogue:operation.moreIssues')}</Button>}
  </details>;
}
