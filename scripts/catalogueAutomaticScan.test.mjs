import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { runner, useEffect, useRef } from './reactHookDriver.mjs';

// Execute the screen's actual initialization effect with the hook scheduler,
// without mounting unrelated Catalogue UI or copying its scan decision.
const source = readFileSync(new URL('../src/components/Catalogue/CatalogueScreen.jsx', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const screen = ast.program.body.find(node => node.declaration?.id?.name === 'CatalogueScreen').declaration;
const statements = screen.body.body;
const index = statements.findIndex(node => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'initialized');
assert.ok(index >= 0, 'screen initialization ref exists');
assert.equal(statements[index + 1].expression.callee.name, 'useEffect');
const initialize = new Function('useRef', 'useEffect', 'sources', 'operations', 'setActionError',
  source.slice(statements[index].start, statements[index + 1].end));

function harness(items, { loading = false, ready = true, operationItems = {}, reject = null } = {}) {
  const starts = [], errors = [];
  const sources = { items, sourcesRevision: 7, loading };
  const operations = { ready, state: { items: operationItems }, start: async (...args) => {
    starts.push(args);
    if (reject) throw reject;
  } };
  const app = runner(() => initialize(useRef, useEffect, sources, operations, error => errors.push(error)));
  return { app, sources, operations, starts, errors, render() { app.render(); app.flush(); } };
}
const active = (id, extra = {}) => ({ id, status: 'active', scanning: false, lastScanAt: null, lastScanStatus: null, ...extra });

test('already scanned sources with no session operations do not launch an automatic scan', () => {
  const h = harness([active('one', { lastScanAt: 42, lastScanStatus: 'success' }), active('two', { lastScanAt: 43, lastScanStatus: 'success' })]);
  try { h.render(); h.app.replayEffects(); h.render(); assert.deepEqual(h.starts, []); }
  finally { h.app.unmount(); }
});

test('first workspace waits for sources and operation recovery, then scans only once', () => {
  const h = harness([active('workspace')], { loading: true, ready: false });
  try {
    h.render(); assert.deepEqual(h.starts, []);
    h.sources.loading = false;
    h.render(); assert.deepEqual(h.starts, []);
    h.operations.ready = true;
    h.render(); h.app.replayEffects();
    h.sources.items = [...h.sources.items];
    h.render();
    assert.deepEqual(h.starts, [[7, { sourceIds: ['workspace'], automatic: true }]]);
  } finally { h.app.unmount(); }
});

test('failed, partial and cancelled scans are previous attempts, even without a successful scan date', () => {
  for (const lastScanStatus of ['failed', 'partial', 'cancelled']) {
    const h = harness([active('attempted', { lastScanStatus })]);
    try { h.render(); assert.deepEqual(h.starts, [], lastScanStatus); }
    finally { h.app.unmount(); }
  }
});

test('automatic scan targets only unattempted active idle sources regardless of unrelated session operations', () => {
  const h = harness([
    active('new'), active('new-too'), active('scanned', { lastScanAt: 42 }),
    active('running', { scanning: true }), active('removed', { status: 'removed' }),
    active('declined', { status: 'declined' }), active('failed', { lastScanStatus: 'failed' }),
  ], { operationItems: { previous: { status: 'success' } } });
  try {
    h.render();
    assert.deepEqual(h.starts, [[7, { sourceIds: ['new', 'new-too'], automatic: true }]]);
  } finally { h.app.unmount(); }
});

test('a rejected automatic start reports its error without retrying on rerender or effect replay', async () => {
  const error = new Error('scan rejected');
  const h = harness([active('workspace')], { reject: error });
  try {
    h.render(); await new Promise(resolve => setImmediate(resolve));
    h.app.replayEffects(); h.render();
    assert.equal(h.starts.length, 1);
    assert.deepEqual(h.errors, [error]);
  } finally { h.app.unmount(); }
});
