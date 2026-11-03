import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONSULTATION_EXPIRED, IDLE_CONSULTATION, consultationReducer, consultationVisible, isLateResult, retryKind, tokenToClose,
} from '../src/store/catalogue/consultationLifecycle.js';

const target = { exemplar: { id: 'z' }, cardId: 'c', expectedRevision: 4 };
const run = (actions, state = IDLE_CONSULTATION) => actions.reduce(consultationReducer, state);

test('launch, preparation, listening and closing', () => {
  const preparing = run([{ type: 'launch', token: 'a', target, origin: { focusId: 'card' } }]);
  assert.equal(preparing.status, 'preparing');
  assert.equal(consultationVisible(preparing), true);
  assert.equal(tokenToClose(preparing), 'a');
  const ready = consultationReducer(preparing, { type: 'prepared', token: 'a', handle: { kind: 'pack' } });
  assert.equal(ready.status, 'ready');
  const closing = consultationReducer(ready, { type: 'close' });
  assert.equal(closing.status, 'closing');
  assert.equal(closing.handle, null);
  assert.equal(consultationVisible(closing), false);
  const closed = consultationReducer(closing, { type: 'closed', token: 'a' });
  assert.equal(closed.status, 'closed');
  assert.deepEqual(closed.origin, { focusId: 'card' });
});

test('closing is idempotent and a late result of a closed launch is ignored', () => {
  const closing = run([{ type: 'launch', token: 'a', target }, { type: 'close' }]);
  assert.equal(consultationReducer(closing, { type: 'close' }), closing);
  const closed = consultationReducer(closing, { type: 'closed', token: 'a' });
  assert.equal(consultationReducer(closed, { type: 'close' }), closed);
  assert.equal(consultationReducer(closed, { type: 'closed', token: 'a' }), closed);
  // The preparation finishes after the closing: ignored, the caller releases it.
  assert.equal(isLateResult(closing, 'a'), true);
  assert.equal(consultationReducer(closing, { type: 'prepared', token: 'a', handle: {} }), closing);
  assert.equal(consultationReducer(closed, { type: 'failed', token: 'a', error: {} }), closed);
});

test('two launches in reverse order: only the current one is published', () => {
  const second = run([{ type: 'launch', token: 'a', target, origin: { ficheId: 'c' } }, { type: 'launch', token: 'b', target }]);
  assert.equal(second.token, 'b');
  assert.deepEqual(second.origin, { ficheId: 'c' }, 'a relaunch keeps the first origin');
  assert.equal(isLateResult(second, 'a'), true);
  assert.equal(isLateResult(second, 'b'), false);
  assert.equal(consultationReducer(second, { type: 'prepared', token: 'a', handle: {} }), second);
  assert.equal(consultationReducer(second, { type: 'failed', token: 'a', error: {} }), second);
  assert.equal(consultationReducer(second, { type: 'prepared', token: 'b', handle: {} }).status, 'ready');
});

test('expiry offers a relaunch, a stale target a new choice, other failures nothing', () => {
  const ready = run([{ type: 'launch', token: 'a', target }, { type: 'prepared', token: 'a', handle: {} }]);
  const expired = consultationReducer(ready, { type: 'expired', token: 'a' });
  assert.equal(expired.status, 'failed');
  assert.equal(expired.error.code, CONSULTATION_EXPIRED);
  assert.equal(expired.retry, 'relaunch');
  assert.equal(consultationReducer(ready, { type: 'expired', token: 'other' }), ready);
  assert.equal(retryKind({ code: 'CATALOG_TARGET_REVISION_CHANGED' }), 'choose');
  assert.equal(retryKind({ code: 'CATALOG_TARGET_REVISION_STALE' }), 'choose');
  assert.equal(retryKind({ code: 'CATALOG_SIMULATION_UNSUPPORTED' }), null);
  const failed = run([{ type: 'launch', token: 'a', target }, { type: 'failed', token: 'a', error: { code: 'CATALOG_FILE_DISAPPEARED' } }]);
  assert.equal(failed.retry, null);
  assert.equal(tokenToClose(failed), 'a');
  // Relaunch: a new token, the same target, never another file.
  const relaunched = consultationReducer(expired, { type: 'launch', token: 'b', target: expired.target });
  assert.deepEqual(relaunched.target, target);
  assert.equal(relaunched.status, 'preparing');
});

test('the consultation never reaches a work session, a project store or a recovery', () => {
  const sources = [
    'src/hooks/useCatalogueConsultation.js',
    'src/hooks/useCatalogueOpenSimulation.js',
    'src/store/catalogue/consultationLifecycle.js',
    'src/store/catalogue/catalogueOpenApi.js',
    'src/components/Catalogue/open/CatalogueSimulator.jsx',
    'src/components/Catalogue/open/ExemplarChoiceDialog.jsx',
    'src/components/Catalogue/CatalogueBrowser.jsx',
  ].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  for (const source of sources) {
    for (const forbidden of ['useWorkSession', 'prepareNewWorkSession', 'addZip', 'runFunnelLanding', 'useProjectLifecycle', 'autoSave', 'session-recovery', 'useStore']) {
      assert.doesNotMatch(source, new RegExp(forbidden), forbidden);
    }
  }
  // The only project read is the read-only loader; nothing is saved.
  const hook = sources[0];
  assert.match(hook, /loadProjectFromPath/);
  assert.doesNotMatch(hook, /saveProject|writeProject|encodeProjectFile/);
});
