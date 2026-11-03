import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPill, createActivityDismissals, idsSignature, visibleActivity } from '../src/store/catalogue/activityModel.js';

test('activity pill colour follows the dominant content: amber only for something to fix', () => {
  assert.equal(activityPill([]), null);
  assert.deepEqual(activityPill([{ tone: 'info' }, { tone: 'issue' }, { tone: 'issue' }]), { state: 'issues', count: 3, label: 'catalogue:activity.pill.info' });
  assert.equal(activityPill([{ tone: 'info' }, { tone: 'progress' }]).state, 'progress');
  assert.deepEqual(activityPill([{ tone: 'success', kind: 'summary' }]), { state: 'ok', count: 1, label: 'catalogue:activity.pill.info' });
  assert.deepEqual(activityPill([{ tone: 'success', kind: 'summary' }, { tone: 'info', kind: 'suggestions' }]), { state: 'info', count: 2, label: 'catalogue:activity.pill.info' });
});

test('a dismissed entry stays hidden for the session until its situation changes', () => {
  const dismissals = createActivityDismissals();
  let notified = 0;
  dismissals.subscribe(() => notified++);
  const missing = (ids) => ({ key: 'missing', tone: 'issue', signature: idsSignature('missing', ids) });
  dismissals.dismiss(missing(['b', 'a']).signature);
  dismissals.dismiss(missing(['a', 'b']).signature);
  assert.equal(notified, 1);
  assert.deepEqual(visibleActivity([missing(['a', 'b'])], dismissals.snapshot()), []);
  assert.equal(visibleActivity([missing(['a', 'b', 'c'])], dismissals.snapshot()).length, 1);
  // Unsigned entries (running scans, summaries) are never hidden by the store.
  assert.equal(visibleActivity([{ key: 'running', tone: 'progress', signature: null }], dismissals.snapshot()).length, 1);
});

test('entries are grouped: issues, then work in progress, then information', () => {
  const items = [{ key: 'i', tone: 'info' }, { key: 's', tone: 'success' }, { key: 'p', tone: 'progress' }, { key: 'e', tone: 'issue' }];
  assert.deepEqual(visibleActivity(items, new Set()).map((item) => item.key), ['e', 'p', 'i', 's']);
});

test('one visible information entry uses the same generic label and counter', () => {
  const entry = { tone: 'info', kind: 'notice', label: 'Dossier ajouté · /Histoires' };
  const hidden = { tone: 'info', label: 'Autre information', signature: 'hidden' };
  assert.deepEqual(activityPill(visibleActivity([entry, hidden], new Set(['hidden']))), {
    state: 'info', count: 1, label: 'catalogue:activity.pill.info',
  });
});

test('several information entries keep the generic label and counter', () => {
  assert.deepEqual(activityPill([{ tone: 'info', label: 'A' }, { tone: 'info', label: 'B' }]), {
    state: 'info', count: 2, label: 'catalogue:activity.pill.info',
  });
});

test('a lone successful summary also keeps the generic label and counter', () => {
  assert.deepEqual(activityPill([{ tone: 'success', kind: 'summary', label: 'Bilan détaillé' }]), {
    state: 'ok', count: 1, label: 'catalogue:activity.pill.info',
  });
});

test('every notification state uses N to review, including one entry', () => {
  for (const tone of ['info', 'success', 'progress', 'issue']) {
    const pill = activityPill([{ tone, kind: 'summary', label: 'Long notification content' }]);
    assert.equal(pill.count, 1);
    assert.equal(pill.label, 'catalogue:activity.pill.info');
    assert.equal(pill.labelText, undefined);
  }
});
