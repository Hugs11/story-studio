import React from 'react';
import { createRoot } from 'react-dom/client';
import { CatalogueActivity } from '../src/components/Catalogue/activity/CatalogueActivity.jsx';
import { OperationIssues } from '../src/components/Catalogue/operations/OperationIssues.jsx';
import { initializeI18n } from '../src/i18n/index.js';
import '../src/styles/variables.css';
import '../src/styles/layout.css';
import '../src/components/Catalogue/CatalogueScreen.css';
initializeI18n('fr');
const assert = (value, message) => { if (!value) throw new Error(message); };
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out waiting for notification: ${document.getElementById('surface').innerHTML.slice(0, 3500)}`);
}
async function run() {
  const root = createRoot(document.getElementById('surface'));
  const snapshot = { operationId: 'trash', operationKind: 'trash', status: 'partial', outcomes: { updated: 8, error: 2 } };
  const calls = [];
  const api = { getOperation: async (id, options) => {
    calls.push({ id, options });
    return { items: [{ path: options.cursor ? '/second.mbah' : '/first.mbah', outcome: 'error', reason: 'accessDenied' }], totalMatching: 2, cursor: options.cursor ? null : '1' };
  } };
  root.render(<CatalogueActivity summaries={[snapshot]} api={api} onDismissSummary={() => {}} />);
  await frames();
  await until(() => document.querySelector('.validation-pill'));
  document.querySelector('.validation-pill').click();
  await until(() => document.querySelector('details'));
  const body = document.getElementById('surface');
  assert(body.textContent.includes('8 éléments mis à la corbeille'), 'notification states the actual successful deletions');
  assert(body.textContent.includes('2 échecs'), 'partial failures stay visible');
  assert(!body.textContent.includes('Rapport détaillé') && !body.textContent.includes('Bilan du scan'), 'no separate report or scan summary for deletion');
  assert(calls.length === 0, 'failure list is loaded lazily');
  document.querySelector('details summary').click();
  await until(() => body.textContent.includes('/first.mbah'));
  assert(calls[0].options.issuesOnly === true, 'requests only failures');
  const more = [...body.querySelectorAll('button')].find(button => button.textContent.includes('échecs suivants'));
  assert(more, 'can load additional failures'); more.click();
  await until(() => body.textContent.includes('/second.mbah'));
  assert(body.textContent.includes('/first.mbah'), 'pagination preserves previous failures');
  assert(!body.textContent.includes('explorateur') && !body.textContent.includes('Copier les détails') && !body.textContent.includes('Réessayer'), 'no misleading actions');

  // A response from a dismissed notification must not leak into another operation.
  let resolveOld;
  const delayedApi = { getOperation: () => new Promise(resolve => { resolveOld = resolve; }) };
  root.render(<OperationIssues operationId="old" api={delayedApi} />);
  await frames();
  await until(() => document.querySelector('details summary')); document.querySelector('details summary').click();
  await until(() => resolveOld);
  root.render(<OperationIssues operationId="new" api={api} />);
  await until(() => calls.some(call => call.id === 'new'));
  await until(() => body.textContent.includes('/first.mbah'));
  resolveOld({ items: [{ path: '/stale.mbah', reason: 'accessDenied' }], cursor: null });
  await frames();
  assert(!body.textContent.includes('/stale.mbah'), 'stale response is ignored');
  const transfer = { operationId: 'transfer', operationKind: 'luniiRepatriate', status: 'failed', outcomes: { refused: 1 }, error: { code: 'STORYTELLER_STORY_UNREADABLE', detail: 'repatriation: decrypt-index-li' } };
  root.render(<OperationIssues operationId="transfer" snapshot={transfer} api={{ getOperation: async () => ({ items: [], cursor: null }) }} />);
  await until(() => body.textContent.includes('repatriation: decrypt-index-li'));
  assert(!body.textContent.includes('[object Object]'), 'snapshot-only transfer errors retain their readable diagnostic');
  root.unmount();
  globalThis.dump('CATALOGUE_INTERACTION_OK\n');
}
run().catch(error => globalThis.dump(`CATALOGUE_INTERACTION_ERROR ${error.message} ${error.stack}\n`));
